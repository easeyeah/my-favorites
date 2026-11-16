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
  classifyByRules,
  isPrivacyDomain,
} from "@mf/shared";
import type { LlmClient } from "@mf/ai/llm-client";
import type { Store } from "./store";

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
    private llm: LlmClient | null,
    private opts: { syncAi?: boolean } = {},
  ) {}

  privacyCheck(url: string): boolean {
    return isPrivacyDomain(url, { patterns: this.store.privacyPatterns() });
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
  }): Promise<{ summarized: boolean; skippedPrivacy?: boolean }> {
    if (this.privacyCheck(input.urlForPrivacyCheck)) {
      this.store.upsertCache({
        bookmarkId: input.bookmarkId,
        fetchedVia: "extension_capture",
        failReason: "privacy_domain_skipped",
      });
      return { summarized: false, skippedPrivacy: true };
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
    if (!this.llm || !l2 || l2.length < 40) return false;
    const bm = this.store.getBookmark(bookmarkId);
    if (!bm) return false;

    const run = async () => {
      try {
        const out = await this.llm!.chatJson<{
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
   * F1.5 收件箱流水线：规则初判 → LLM 内容级精修 → 自动归位/留下。
   * 安全规则（§6.1）：置信度不足留在收件箱；用户手动移出的永不处理；
   * 全部移动写 organize_version 可回滚。
   */
  async processInbox(
    bookmarkIds: string[],
    inboxFolderId: string,
  ): Promise<{
    moved: Array<{ id: string; to: string; source: string }>;
    left: Array<{ id: string; reason: string }>;
    versionId: string | null;
  }> {
    const moved: Array<{ id: string; to: string; source: string }> = [];
    const left: Array<{ id: string; reason: string }> = [];
    const pending: Array<{ id: string; title: string; url: string }> = [];
    const versionActions: unknown[] = [];

    // 第一轮：缓存/规则（确定性）
    for (const id of bookmarkIds) {
      const bm = this.store.getBookmark(id);
      if (!bm || bm.folder_id !== inboxFolderId) {
        left.push({ id, reason: "not_in_inbox" });
        continue;
      }
      if (this.privacyCheck(bm.url_canonical)) {
        left.push({ id, reason: "privacy_domain" });
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
          versionActions.push({
            type: "move",
            bookmarkId: id,
            fromFolderId: before.folder_id,
            toFolderId: target.id,
            meta: "inbox_rule",
          });
        }
        moved.push({ id, to: target.name, source: "rule" });
        continue;
      }
      pending.push({ id, title: bm.title, url: bm.url_canonical });
    }

    // 无 LLM：pending 项明确标注原因留在收件箱（永不丢书签）
    if (!this.llm) {
      for (const p of pending) left.push({ id: p.id, reason: "no_llm" });
      const versionId =
        versionActions.length > 0 ? this.store.saveVersion(null, versionActions) : null;
      return { moved, left, versionId };
    }

    // 第二轮：LLM 批量精修（内容级信号）
    if (pending.length > 0) {
      const folderNames = this.store
        .listFolders()
        .filter((f) => !f.is_system_inbox)
        .map((f) => f.name);
      try {
        const out = await this.llm.chatJson<{
          results: Array<{ index: number; category: string; confidence: number }>;
        }>([
          {
            role: "system",
            content:
              '你是书签分类助手。现有目录：' +
              JSON.stringify(folderNames) +
              '。为每条书签选择最合适的目录（可建议新目录名）。只返回 JSON：{"results":[{"index":0,"category":"...","confidence":0.0}]}，confidence∈[0,1]。',
          },
          {
            role: "user",
            content: JSON.stringify(
              pending.map((p, i) => ({ index: i, title: p.title, url: p.url })),
            ),
          },
        ]);
        for (const r of out.results ?? []) {
          const item = pending[r.index];
          if (!item) continue;
          if ((r.confidence ?? 0) >= 0.6 && r.category && r.category !== "未分类") {
            const target = this.ensureCategoryFolder(r.category);
            const before = this.store.moveBookmark(item.id, target.id);
            if (before) {
              versionActions.push({
                type: "move",
                bookmarkId: item.id,
                fromFolderId: before.folder_id,
                toFolderId: target.id,
                meta: "inbox_llm",
              });
              moved.push({ id: item.id, to: target.name, source: "llm" });
            }
          } else {
            left.push({ id: item.id, reason: "low_confidence" });
          }
        }
      } catch {
        for (const p of pending) left.push({ id: p.id, reason: "llm_unavailable" });
      }
    }

    // 规则 + LLM 的全部移动合并为一个版本（一次回滚即全部还原）
    const versionId =
      versionActions.length > 0 ? this.store.saveVersion(null, versionActions) : null;
    return { moved, left, versionId };
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
