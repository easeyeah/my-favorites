/**
 * 智能流水线：即时归位建议（F1.4）、收件箱归位（F1.5）、内容捕获与摘要（F2）
 *
 * 分类三级信号：domain_cache（命中过的域名缓存，<50ms 零成本）
 *             → 规则引擎（shared，确定性）
 *             → LLM（批量、内容级，兜底）
 * 隐私校验在任何抓取/AI 调用前强制执行（AGENTS.md 红线 2）。
 */
import {
  AUTO_MOVE_CONFIDENCE,
  canonicalizeUrl,
  checkPrivacy,
  classifyByRules,
  isPrivacyDomain,
  type PrivacyRules,
} from "@mf/shared";
import type { LlmClient } from "@mf/ai/llm-client";
import type { Store } from "./store";
import { enqueueMirrorMoves } from "./organize";

export interface SuggestResult {
  category: string;
  confidence: number;
  source: "domain_cache" | "domain_map" | "keyword" | "none";
  folderId: string | null;
  folderPath: string[];
  privacy: boolean;
}

export class Pipeline {
  constructor(
    private store: Store,
    private llmFor: (purpose: "organize" | "summarize" | "embedding") => LlmClient | null,
    private opts: { syncAi?: boolean } = {},
  ) {}

  privacyCheck(url: string): boolean {
    return isPrivacyDomain(url, { patterns: this.store.privacyPatterns() });
  }

  /** A1-1/A1-3：服务端侧统一策略判定（不信任客户端"已经检查"声明） */
  private serverRules(): PrivacyRules {
    const { patterns, revision } = this.store.privacyRules();
    return { patterns, revision };
  }

  serverDecide(
    action: "upload_content" | "call_model" | "server_fetch" | "snapshot",
    url: string,
    opts: { isPrivateBookmark?: boolean } = {},
  ) {
    return checkPrivacy(action, url, this.serverRules(), opts);
  }

  /** F1.4 即时归位：仅缓存+规则（<50ms 路径，不调 LLM） */
  suggest(url: string, title: string): SuggestResult {
    const privacy = this.privacyCheck(url);
    const parsed = canonicalizeUrl(url);
    if (!parsed) {
      return {
        category: "未分类",
        confidence: 0,
        source: "none",
        folderId: null,
        folderPath: [],
        privacy,
      };
    }
    if (privacy) {
      // 隐私域名：只存 URL，不做任何分类外推
      return {
        category: "隐私",
        confidence: 1,
        source: "none",
        folderId: null,
        folderPath: [],
        privacy,
      };
    }

    // ① domain_cache
    const cached = this.store.lookupDomain(parsed.registrableDomain);
    if (cached) {
      const folder = this.store.findFolderByName(cached);
      return {
        category: cached,
        confidence: 0.9,
        source: "domain_cache",
        folderId: folder?.id ?? null,
        folderPath: folder ? [folder.name] : [],
        privacy,
      };
    }

    // ② 规则引擎
    const rule = classifyByRules(parsed.registrableDomain, title);
    if (rule.source === "domain_map") {
      this.store.bumpDomain(parsed.registrableDomain, rule.category);
      const folder = this.store.findFolderByName(rule.category);
      return {
        category: rule.category,
        confidence: rule.confidence,
        source: "domain_map",
        folderId: folder?.id ?? null,
        folderPath: folder ? [folder.name] : [rule.category],
        privacy,
      };
    }
    return {
      category: rule.category,
      confidence: rule.confidence,
      source: rule.source,
      folderId: null,
      folderPath: [],
      privacy,
    };
  }

  /** 内容捕获（F2.1 通道A 上行）：隐私校验 → 截断 → 存储 → （可选）AI 摘要 */
  async capture(input: {
    bookmarkId: string;
    l2Text?: string;
    description?: string;
    faviconDataUrl?: string;
    urlForPrivacyCheck: string;
  }): Promise<{ summarized: boolean; skippedPrivacy?: boolean; skipReason?: string }> {
    // A1-3 服务端纵深校验：独立判定，不信任扩展端"已检查"（扩展端校验是第一道，这是第二道）
    const bm = this.store.getBookmark(input.bookmarkId);
    const decision = checkPrivacy(
      "upload_content",
      input.urlForPrivacyCheck,
      this.serverRules(),
      { isPrivateBookmark: bm?.is_private === 1 },
    );
    if (!decision.allowed) {
      this.store.upsertCache({
        bookmarkId: input.bookmarkId,
        fetchedVia: "extension_capture",
        failReason: `privacy_${decision.reason}`,
      });
      return { summarized: false, skippedPrivacy: true, skipReason: decision.reason };
    }
    // 红线：正文截断 20KB（技术方案 §7.2）
    const l2 = input.l2Text?.slice(0, 20_000) ?? null;
    this.store.upsertCache({
      bookmarkId: input.bookmarkId,
      l2Text: l2,
      fetchedVia: "extension_capture",
    });
    if (input.description) {
      const bm = this.store.getBookmark(input.bookmarkId);
      if (bm && !bm.description) {
        this.store.updateBookmark(input.bookmarkId, { description: input.description });
      }
    }
    if (input.faviconDataUrl) {
      this.store.updateBookmark(input.bookmarkId, { favicon_url: input.faviconDataUrl });
    }
    const summarized = await this.maybeSummarize(input.bookmarkId);
    return { summarized };
  }

  /** F2.3 AI 摘要：有 LLM 且有正文时生成 L1；syncAi 模式供测试确定性 */
  async maybeSummarize(bookmarkId: string): Promise<boolean> {
    const cache = this.store.getCache(bookmarkId);
    const l2 = (cache?.l2_text as string | null) ?? "";
    const llm = this.llmFor("summarize");
    if (!llm || !l2 || l2.length < 40) return false;
    const bm = this.store.getBookmark(bookmarkId);
    if (!bm) return false;
    // A1-3：调用模型前独立判定 call_model（隐私域/私密书签不外发内容）
    if (!this.serverDecide("call_model", bm.url_raw, { isPrivateBookmark: bm.is_private === 1 }).allowed) {
      return false;
    }
    // DEV-03：记录提交前的规则修订与实体修订（LLM 等待期间可能变化）
    const rulesRevBefore = this.store.privacyRevision();
    const contentRevBefore = bm.content_revision ?? 1;
    const privateBefore = bm.is_private;

    const run = async () => {
      try {
        const out = await llm.chatJson<{
          summary: string;
          tags: string[];
          keywords: string[];
        }>([
          {
            role: "system",
            content:
              "你是网页摘要助手。根据正文生成：summary（≤80字中文摘要）、tags（3-5个标签）、keywords（关键词数组）。只返回 JSON。",
          },
          { role: "user", content: `标题：${bm.title}\nURL：${bm.url_canonical}\n正文：${l2.slice(0, 4000)}` },
        ]);
        // DEV-03：响应完成后提交前重读策略与状态——过期结果丢弃并给原因码
        const after = this.store.getBookmark(bookmarkId);
        if (
          !after ||
          after.is_private !== privateBefore ||
          (after.content_revision ?? 1) !== contentRevBefore ||
          this.store.privacyRevision() !== rulesRevBefore ||
          !this.serverDecide("call_model", after.url_raw, { isPrivateBookmark: after.is_private === 1 }).allowed
        ) {
          this.store.upsertCache({
            bookmarkId,
            fetchedVia: "extension_capture",
            failReason: "stale_policy_discarded",
          });
          return false;
        }
        this.store.upsertCache({
          bookmarkId,
          l1Summary: String(out.summary ?? "").slice(0, 200),
          l1Tags: Array.isArray(out.tags) ? out.tags.slice(0, 5).map(String) : [],
          keywords: Array.isArray(out.keywords) ? out.keywords.slice(0, 10).map(String) : [],
          fetchedVia: "extension_capture",
        });
        return true;
      } catch {
        this.store.upsertCache({
          bookmarkId,
          fetchedVia: "extension_capture",
          failReason: "llm_unavailable",
        });
        return false;
      }
    };

    if (this.opts.syncAi) return await run();
    void run();
    return false;
  }

  /**
   * F1.5 收件箱流水线（DEV-08 统一提交内核版）：
   *  - 阶段一（规则，短事务）：每项事务内重查（inbox 归属/隐私/私密），移动 + 镜像入队 +
   *    版本记录同事务提交；任意异常整批回滚（无半提交）；
   *  - 阶段二（LLM，事务外计算）：等待期间用户可能已改动/加隐私规则——提交短事务逐项重查，
   *    过期项丢弃并给原因码，再写第二个版本；
   *  - deviceId 提供时，镜像操作在各事务内直接入队（崩溃无「已提交但无镜像」空窗）。
   */
  async processInbox(
    bookmarkIds: string[],
    inboxFolderId: string,
    opts: { deviceId?: string } = {},
  ): Promise<{
    moved: Array<{ id: string; to: string; source: string }>;
    left: Array<{ id: string; reason: string }>;
    versionId: string | null;
  }> {
    const moved: Array<{ id: string; to: string; source: string }> = [];
    const left: Array<{ id: string; reason: string }> = [];
    const pending: Array<{ id: string; title: string; url: string }> = [];
    const db = this.store.db;

    // ---------- 阶段一：规则移动（单短事务，含镜像 + 版本） ----------
    const versionActionsA: unknown[] = [];
    let firstVersionId: string | null = null;
    db.exec("BEGIN");
    try {
      for (const id of bookmarkIds) {
        const bm = this.store.getBookmark(id);
        if (!bm || bm.folder_id !== inboxFolderId) {
          left.push({ id, reason: "not_in_inbox" });
          continue;
        }
        if (bm.is_private === 1 || this.privacyCheck(bm.url_raw)) {
          left.push({ id, reason: "privacy_domain" });
          // 原型 06：隐私条目仅存 URL，手动选目录（支持按域名记忆本地规则）
          this.store.upsertInboxState(id, "privacy_hold", null, "privacy_domain", 0);
          continue;
        }
        const parsed = canonicalizeUrl(bm.url_canonical);
        const rule = parsed
          ? classifyByRules(parsed.registrableDomain, bm.title)
          : { category: "未分类", confidence: 0.3, source: "none" as const };

        if (rule.source === "domain_map" && rule.confidence >= AUTO_MOVE_CONFIDENCE) {
          const target = this.ensureCategoryFolder(rule.category);
          const before = this.store.moveBookmark(id, target.id);
          this.store.bumpDomain(parsed!.registrableDomain, rule.category);
          if (before) {
            versionActionsA.push({
              type: "move",
              bookmarkId: id,
              fromFolderId: before.folder_id,
              toFolderId: target.id,
              revisionAfter: this.store.getBookmark(id)?.content_revision ?? 1,
              meta: "inbox_rule",
            });
            enqueueMirrorMoves(this.store, id, target.id, opts.deviceId);
            moved.push({ id, to: target.name, source: "rule" });
          }
          continue;
        }
        pending.push({ id, title: bm.title, url: bm.url_canonical });
      }
      const versionIdA =
        versionActionsA.length > 0 ? this.store.saveVersion(null, versionActionsA) : null;
      firstVersionId = versionIdA;
      db.exec("COMMIT");
      // 收纳盒条目状态机（原型 06）：规则归位 → placed（带版本，撤销/改目录入口用）
      for (const m of moved.filter((x) => x.source === "rule")) {
        this.store.upsertInboxState(m.id, "placed", null, m.to, 0);
        if (versionIdA) this.store.setInboxStateVersion(m.id, versionIdA);
      }
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    const llm = this.llmFor("organize");
    // 无 LLM：pending 项明确标注原因留在收件箱（永不丢书签）；重试计数 +1，超限转人工（ambiguous）
    if (!llm) {
      for (const p of pending) {
        left.push({ id: p.id, reason: "no_llm" });
        this.bumpRetryState(p.id, "no_llm");
      }
      return { moved, left, versionId: firstVersionId };
    }

    // ---------- 阶段二：LLM 批量精修（事务外计算；仅尚未被移走/改动的项） ----------
    let secondVersionId: string | null = null;
    if (pending.length > 0) {
      const rulesRevBefore = this.store.privacyRevision();
      const baseRevisions = new Map(pending.map((p) => [p.id, this.store.getBookmark(p.id)?.content_revision ?? 1]));
      const folderNames = this.store
        .listFolders()
        .filter((f) => !f.is_system_inbox)
        .map((f) => f.name);
      try {
        const prefs = this.store.topCategories();
        const out = await llm.chatJson<{
          results: Array<{ index: number; category: string; confidence: number }>;
        }>([
          {
            role: "system",
            content:
              '你是书签分类助手。现有目录：' +
              JSON.stringify(folderNames) +
              (prefs.length > 0 ? `。用户常用目录（优先参考）：${JSON.stringify(prefs)}` : "") +
              '。为每条书签选择最合适的目录（可建议新目录名）。只返回 JSON：{"results":[{"index":0,"category":"...","confidence":0.0}]}，confidence∈[0,1]。',
          },
          {
            role: "user",
            content: JSON.stringify(
              pending.map((p, i) => ({ index: i, title: p.title, url: p.url })),
            ),
          },
        ]);
        // 提交短事务：逐项重查（仍在 inbox / revision 未变 / 隐私规则未变 / 非私密）
        const versionActionsB: unknown[] = [];
        const movedB: Array<{ id: string; to: string; source: string }> = [];
        db.exec("BEGIN");
        try {
          for (const r of out.results ?? []) {
            const item = pending[r.index];
            if (!item) continue;
            if (!((r.confidence ?? 0) >= 0.6 && r.category && r.category !== "未分类")) {
              left.push({ id: item.id, reason: "low_confidence" });
              // D37：歧义阈值 80% 起步（AUTO_MOVE_CONFIDENCE）——低于 0.6 直接歧义滞留，0.6–0.8 之间
              // 由 /inbox/process 调用方决定（本流水线保守：不足 0.8 不强移，标歧义）
              this.store.upsertInboxState(item.id, "ambiguous", r.confidence ?? null, "low_confidence", 0);
              continue;
            }
            const bm = this.store.getBookmark(item.id);
            if (!bm || bm.folder_id !== inboxFolderId) {
              left.push({ id: item.id, reason: "stale_moved_by_user" });
              continue;
            }
            if ((bm.content_revision ?? 1) !== (baseRevisions.get(item.id) ?? 1)) {
              left.push({ id: item.id, reason: "stale_modified_by_user" });
              continue;
            }
            if (bm.is_private === 1 || this.store.privacyRevision() !== rulesRevBefore || this.privacyCheck(bm.url_raw)) {
              left.push({ id: item.id, reason: "stale_policy" });
              continue;
            }
            const target = this.ensureCategoryFolder(r.category);
            const before = this.store.moveBookmark(item.id, target.id);
            if (before) {
              versionActionsB.push({
                type: "move",
                bookmarkId: item.id,
                fromFolderId: before.folder_id,
                toFolderId: target.id,
                revisionAfter: this.store.getBookmark(item.id)?.content_revision ?? 1,
                meta: "inbox_llm",
              });
              enqueueMirrorMoves(this.store, item.id, target.id, opts.deviceId);
              movedB.push({ id: item.id, to: target.name, source: "llm" });
            }
          }
          secondVersionId =
            versionActionsB.length > 0 ? this.store.saveVersion(null, versionActionsB) : null;
          db.exec("COMMIT");
          moved.push(...movedB); // 提交成功才对外报告移动（回滚不虚报）
          for (const m of movedB) {
            this.store.upsertInboxState(m.id, "placed", null, m.to, 0);
            if (secondVersionId) this.store.setInboxStateVersion(m.id, secondVersionId);
          }
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      } catch (err) {
        // LLM 不可用或提交异常：pending 项留在收件箱（原因码可解释；不丢书签）
        if (String(err).includes("llm_unavailable") || String(err).includes("LlmUnavailableError")) {
          for (const p of pending) left.push({ id: p.id, reason: "llm_unavailable" });
        } else {
          for (const p of pending) left.push({ id: p.id, reason: "commit_failed" });
        }
        for (const p of pending) this.bumpRetryState(p.id, "llm_unavailable");
      }
    }

    // 返回阶段一的版本（一次回滚 = 还原规则移动；LLM 版本独立可回滚）
    return { moved, left, versionId: firstVersionId ?? secondVersionId };
  }

  /** 重试状态：attempts+1；达到 5 次（原型 06「第 n/5 次」）转人工 = ambiguous 滞留 */
  private bumpRetryState(bookmarkId: string, reason: string): void {
    const prev = this.store.getInboxState(bookmarkId);
    const attempts = (prev?.attempts ?? 0) + 1;
    if (attempts >= 5) {
      this.store.upsertInboxState(bookmarkId, "ambiguous", null, `retry_exhausted:${reason}`, attempts);
    } else {
      this.store.upsertInboxState(bookmarkId, "retry", null, reason, attempts);
    }
  }

  ensureCategoryFolder(name: string): { id: string; name: string } {
    const existing = this.store.findFolderByName(name);
    if (existing && !existing.is_system_inbox) {
      return { id: existing.id, name: existing.name };
    }
    const created = this.store.createFolder(name, null, "ai_created");
    return { id: created.id, name: created.name };
  }
}
