/**
 * 聊天整理（F3）：会话 → proposal（diff）→ apply → rollback
 *
 * M1 支持两类指令 + 自由对话：
 *  - 重新分类（"整理"/"重新分类"，可带范围文件夹名）→ 逐条分类产出 move/createFolder
 *  - 合并重复（"合并重复"/"去重"）→ canonical URL 撞车的合并动作
 *  - 其他消息 → 指引性回答（不产出 proposal）
 * 红线：删除类操作永不自动执行；apply 前必须 diff 确认；全部写 organize_version。
 *
 * A3-2/3/4/5（2026-11-17）：
 *  - 提案保存稳定实体 ID + 原始状态（base_state）+ 修订版本（base_revisions）；
 *  - apply 在单事务中完成（校验/变更/版本/变更日志），失败整体回滚；
 *  - apply 时冲突检测：提案生成后被用户手动改过的项目跳过并报告（不静默覆盖）；
 *  - 合并改软归档（archived_into 指向保留方），正文缓存/快照/隐私属性保留，回滚可恢复。
 */
import { canonicalizeUrl, classifyByRules } from "@mf/shared";
import type { LlmClient } from "@mf/ai/llm-client";
import type { Store } from "./store";
import { now, newId } from "./db";

const MAX_SCOPE = 500;

export interface OrganizeActionView {
  type: "move" | "rename" | "merge" | "createFolder";
  bookmarkId?: string;
  bookmarkTitle?: string;
  fromFolder?: string;
  toFolder?: string;
  newTitle?: string;
  oldTitle?: string;
  mergeFrom?: string[];
  folderName?: string;
  /** createFolder 动作：计划创建的 folderId（apply 时若已存在则复用） */
  plannedFolderId?: string;
}

export class OrganizeService {
  constructor(
    private store: Store,
    private llmFor: (purpose: "organize" | "summarize" | "embedding") => LlmClient | null,
  ) {}

  async handleMessage(
    message: string,
  ): Promise<{ sessionId: string; status: string; answer: string; proposal: OrganizeActionView[] | null }> {
    const sessionId = newId();
    const lower = message.toLowerCase();

    let status = "answered";
    let answer = "";
    let proposal: OrganizeActionView[] | null = null;
    let scope: Awaited<ReturnType<OrganizeService["planReclassify"]>>["scope"] | null = null;

    if (/重新分类|整理/.test(message)) {
      const scopeFolder = this.extractScopeFolder(message);
      const result = await this.planReclassify(scopeFolder);
      proposal = result.proposal;
      scope = result.scope;
      status = "proposed";
      answer = result.summary;
    } else if (/合并重复|去重|重复/.test(message)) {
      const result = this.planMergeDuplicates();
      proposal = result.proposal;
      scope = result.scope;
      status = proposal.length > 0 ? "proposed" : "answered";
      answer = result.summary;
    } else {
      answer =
        "当前支持：①「整理」/「重新分类」——按内容重排书签（可指定范围，如“整理 开发 文件夹”）；②「合并重复」——清理规范化后重复的 URL。请告诉我你想做什么。";
    }

    // A3-2：提案保存稳定实体 ID + 原始状态（folder 快照）+ 修订版本
    // 冲突定义：apply 时书签的 content_revision ≠ 提案时 → 用户手动改过 → 跳过
    const touchedIds = (proposal ?? [])
      .flatMap((a) => [a.bookmarkId, ...(a.mergeFrom ?? [])])
      .filter((x): x is string => Boolean(x));
    const baseState: Record<string, string> = {};
    const baseRevisions: Record<string, number> = {};
    for (const id of touchedIds) {
      const bm = this.store.getBookmark(id);
      if (bm) {
        baseState[id] = bm.folder_id;
        baseRevisions[id] = bm.content_revision ?? 1;
      }
    }
    this.store.db
      .prepare(
        "INSERT INTO organize_session (id, message, status, answer, proposal, base_state, base_revisions, created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        sessionId,
        message,
        status,
        answer,
        proposal ? JSON.stringify(proposal) : null,
        Object.keys(baseState).length > 0 ? JSON.stringify(baseState) : null,
        Object.keys(baseRevisions).length > 0 ? JSON.stringify(baseRevisions) : null,
        now(),
      );

    return { sessionId, status, answer, proposal };
  }

  private extractScopeFolder(message: string): string | null {
    const m = /(?:整理|重新分类)\s*[\u4e00-\u9fa5A-Za-z0-9_ -]*?文件夹\s*(\S+)/.exec(message);
    if (m?.[1]) return m[1];
    // “整理 开发 文件夹” 形式
    const m2 = /(?:整理|重新分类)\s+(\S+)\s+文件夹/.exec(message);
    if (m2?.[1]) return m2[1];
    return null;
  }

  private async planReclassify(scopeFolder: string | null): Promise<{
    proposal: OrganizeActionView[];
    summary: string;
    scope: Array<{ id: string }>;
  }> {
    let scope = this.store.listBookmarks({ limit: MAX_SCOPE });
    if (scopeFolder) {
      const folder = this.store.findFolderByName(scopeFolder);
      if (!folder) {
        return { proposal: [], summary: `未找到文件夹「${scopeFolder}」`, scope: [] };
      }
      scope = this.store.listBookmarks({ folderId: folder.id, limit: MAX_SCOPE });
    }

    const proposal: OrganizeActionView[] = [];
    const pending: Array<{ id: string; title: string; url: string; folderId: string }> = [];

    for (const bm of scope) {
      if (this.store.db.prepare("SELECT 1 FROM privacy_domain").all().length > 0) {
        // 隐私域名不外推分类
        const { isPrivacyDomain } = await import("@mf/shared");
        if (isPrivacyDomain(bm.url_canonical, { patterns: this.store.privacyPatterns() })) {
          continue;
        }
      }
      const parsed = canonicalizeUrl(bm.url_canonical);
      const rule = parsed
        ? classifyByRules(parsed.registrableDomain, bm.title)
        : null;
      if (rule && rule.source === "domain_map") {
        const target = this.ensureFolder(rule.category, proposal);
        const from = this.store.getFolder(bm.folder_id);
        if (from && from.name !== rule.category) {
          proposal.push({
            type: "move",
            bookmarkId: bm.id,
            bookmarkTitle: bm.title,
            fromFolder: from.name,
            toFolder: rule.category,
          });
        }
        continue;
      }
      pending.push({ id: bm.id, title: bm.title, url: bm.url_canonical, folderId: bm.folder_id });
    }

    // F3.8 偏好记忆注入 + LLM 批量分类（无 LLM 时保留原位并在 summary 说明）
    const llm = this.llmFor("organize");
    const prefs = this.store.topCategories();
    if (pending.length > 0 && llm) {
      const folderNames = this.store
        .listFolders()
        .filter((f) => !f.is_system_inbox)
        .map((f) => f.name);
      try {
        const out = await llm.chatJson<{
          results: Array<{ index: number; category: string; confidence: number }>;
        }>([
          {
            role: "system",
            content:
              "你是书签分类助手。现有目录：" +
              JSON.stringify(folderNames) +
              (prefs.length > 0 ? `。用户常用目录（优先参考）：${JSON.stringify(prefs)}` : "") +
              '。为每条书签选择目录（可建议新目录）。只返回 JSON {"results":[{"index":0,"category":"...","confidence":0.0}]}。',
          },
          {
            role: "user",
            content: JSON.stringify(
              pending.map((p, i) => ({
                index: i,
                title: p.title,
                url: p.url,
                summary: this.store.getCache(p.id)?.l1_summary ?? "",
              })),
            ),
          },
        ]);
        for (const r of out.results ?? []) {
          const item = pending[r.index];
          if (!item || (r.confidence ?? 0) < 0.5 || !r.category || r.category === "未分类") {
            continue;
          }
          const target = this.ensureFolder(r.category, proposal);
          const from = this.store.getFolder(item.folderId);
          if (from && from.name !== r.category) {
            proposal.push({
              type: "move",
              bookmarkId: item.id,
              bookmarkTitle: item.title,
              fromFolder: from.name,
              toFolder: r.category,
            });
          }
        }
      } catch {
        // LLM 不可用：规则结果已入 proposal，其余保持原位
      }
    }

    const summary = `共扫描 ${scope.length} 条，产出 ${proposal.length} 项变更。请确认后应用（diff 中每条可否决）。`;
    return { proposal, summary, scope };
  }

  private ensureFolder(name: string, proposal: OrganizeActionView[]): string {
    const existing = this.store.findFolderByName(name);
    if (existing && !existing.is_system_inbox) return existing.id;
    // proposal 里已计划创建
    const planned = proposal.find(
      (a) => a.type === "createFolder" && a.folderName === name,
    );
    if (planned?.plannedFolderId) return planned.plannedFolderId;
    const plannedFolderId = newId();
    proposal.push({ type: "createFolder", folderName: name, plannedFolderId });
    return plannedFolderId;
  }

  private planMergeDuplicates(): {
    proposal: OrganizeActionView[];
    summary: string;
    scope: Array<{ id: string }>;
  } {
    const all = this.store.listBookmarks({ limit: MAX_SCOPE });
    // 相似检测（F5.2）：url_canonical 有 UNIQUE 约束（入库即查重），所以
    // 库内重复只可能是"同域同名"的近重复——按 registrableDomain+title 分组
    // A3-2 修订：同毫秒 added_at 平局时保留方不确定 → 平局时按 id 字典序稳定排序
    const groups = new Map<string, typeof all>();
    for (const bm of all) {
      const parsed = canonicalizeUrl(bm.url_canonical);
      const domain = parsed?.registrableDomain ?? bm.url_canonical;
      const key = `${domain}\n${bm.title}`;
      const arr = groups.get(key) ?? [];
      arr.push(bm);
      groups.set(key, arr);
    }
    const proposal: OrganizeActionView[] = [];
    for (const [, arr] of groups) {
      if (arr.length < 2) continue;
      // 保留添加最早的（信息最全），其余并入；平局用 id 稳定决胜
      const sorted = [...arr].sort(
        (a, b) => a.added_at.localeCompare(b.added_at) || a.id.localeCompare(b.id),
      );
      const keep = sorted[0];
      if (!keep) continue;
      const dupes = sorted.slice(1);
      proposal.push({
        type: "merge",
        bookmarkId: keep.id,
        bookmarkTitle: keep.title,
        mergeFrom: dupes.map((d) => d.id),
      });
    }
    return {
      proposal,
      summary:
        proposal.length > 0
          ? `发现 ${proposal.length} 组重复，合并后可回滚。`
          : "未发现重复书签。",
      scope: all,
    };
  }

  /**
   * 应用 proposal（A3-3 事务化 + A3-4 冲突检测 + A3-5 软归档）。
   * - 整个 apply 在单事务中：校验、目录创建、移动、软归档、版本记录；
   *   任意一步抛错 → ROLLBACK，不留半套修改。
   * - 冲突检测：提案生成后 content_revision 变了（用户手改）→ 该项跳过并记入 conflicts，
   *   不静默覆盖。软归档同理。
   * - 合并 = 软归档：被合并方 archived_into=保留方，正文缓存/快照/隐私属性全保留。
   */
  apply(sessionId: string): {
    versionId: string;
    applied: number;
    conflicts: Array<{ bookmarkId: string; reason: string }>;
  } {
    const session = this.store.db
      .prepare("SELECT * FROM organize_session WHERE id = ?")
      .get(sessionId) as
      | { id: string; status: string; proposal: string | null; base_revisions: string | null }
      | undefined;
    if (!session || session.status !== "proposed" || !session.proposal) {
      throw new Error("session_not_proposed");
    }
    const proposal = JSON.parse(session.proposal) as OrganizeActionView[];
    const baseRevisions = (session.base_revisions ? JSON.parse(session.base_revisions) : {}) as Record<
      string,
      number
    >;
    const conflicts: Array<{ bookmarkId: string; reason: string }> = [];
    const versionActions: unknown[] = [];
    const db = this.store.db;

    // A3-4 冲突预检（在事务外读，事务内再核）——收集跳过清单
    const isConflicting = (bookmarkId: string): boolean => {
      const bm = this.store.getBookmark(bookmarkId);
      if (!bm) return true; // 已被删除：跳过
      const baseRev = baseRevisions[bookmarkId];
      if (baseRev !== undefined && bm.content_revision !== baseRev) {
        conflicts.push({ bookmarkId, reason: "modified_after_proposal" });
        return true;
      }
      return false;
    };

    db.exec("BEGIN");
    try {
      // ① createFolder（按名称存在即复用）
      for (const action of proposal) {
        if (action.type === "createFolder" && action.folderName) {
          const existing = this.store.findFolderByName(action.folderName);
          if (!existing) {
            const created = this.store.createFolder(action.folderName, null, "ai_created");
            versionActions.push({ type: "createFolder", folderId: created.id, name: created.name });
          }
        }
      }
      // ② move / merge（软归档）
      for (const action of proposal) {
        if (action.type === "move" && action.bookmarkId) {
          if (isConflicting(action.bookmarkId)) continue;
          const to = this.store.findFolderByName(action.toFolder ?? "");
          if (!to) continue;
          const before = this.store.getBookmark(action.bookmarkId);
          if (!before) continue;
          if (before.folder_id === to.id) continue; // 已在目标目录：no-op
          this.store.moveBookmark(action.bookmarkId, to.id);
          versionActions.push({
            type: "move",
            bookmarkId: action.bookmarkId,
            fromFolderId: before.folder_id,
            toFolderId: to.id,
            revisionAfter: this.store.getBookmark(action.bookmarkId)?.content_revision ?? 1,
          });
        } else if (action.type === "merge" && action.bookmarkId) {
          const dupIds = (action.mergeFrom ?? []).filter((id) => !isConflicting(id));
          const archivedRows: unknown[] = [];
          for (const dupId of dupIds) {
            const row = this.store.getBookmark(dupId);
            if (!row) continue;
            // A3-5 软归档：不删除，标记 archived_into；正文缓存/快照/隐私属性保留
            db.prepare("UPDATE bookmarks SET archived_into = ? WHERE id = ?").run(action.bookmarkId, dupId);
            archivedRows.push({ id: row.id, folder_id: row.folder_id, archived_from: row.archived_into ?? null });
          }
          if (archivedRows.length > 0) {
            versionActions.push({ type: "merge", keepId: action.bookmarkId, archivedRows });
          }
        }
      }
      // ③ 版本记录 + 会话状态（同事务）
      const versionId = this.store.saveVersion(sessionId, versionActions);
      db.prepare("UPDATE organize_session SET status = 'applied' WHERE id = ?").run(sessionId);
      db.exec("COMMIT");
      return { versionId, applied: versionActions.length, conflicts };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 回滚：逆放 diff（move 反向、软归档恢复、createFolder 空则删）。
   * A3-4：回滚生成新历史记录（不删历史）；回滚目标在 apply 后又被用户改过的（content_revision
   * 再次变化）→ 跳过并在 skipped 中报告，不破坏用户后续修改。
   */
  rollback(versionId: string): { reversed: number; skipped: Array<{ bookmarkId: string; reason: string }> } {
    const version = this.store.getVersion(versionId);
    if (!version || version.reverted) throw new Error("version_not_found_or_reverted");
    let reversed = 0;
    const skipped: Array<{ bookmarkId: string; reason: string }> = [];
    const db = this.store.db;

    db.exec("BEGIN");
    try {
      for (const raw of [...version.actions].reverse()) {
        const a = raw as Record<string, unknown>;
        if (a.type === "move") {
          const bmId = String(a.bookmarkId);
          const current = this.store.getBookmark(bmId);
          if (!current) {
            skipped.push({ bookmarkId: bmId, reason: "bookmark_deleted" });
            continue;
          }
          // A3-4：apply 之后用户又手动改过（revision 变化）→ 跳过，不破坏用户修改
          const revAfter = a.revisionAfter as number | undefined;
          if (revAfter !== undefined && current.content_revision !== revAfter) {
            skipped.push({ bookmarkId: bmId, reason: "modified_after_apply" });
            continue;
          }
          this.store.moveBookmark(bmId, String(a.fromFolderId));
          reversed++;
        } else if (a.type === "merge") {
          for (const row of (a.archivedRows ?? []) as Array<Record<string, unknown>>) {
            const id = String(row.id);
            const exists = this.store.getBookmark(id);
            if (!exists) {
              skipped.push({ bookmarkId: id, reason: "bookmark_deleted" });
              continue;
            }
            if (exists.archived_into === null) {
              // 用户在合并后已自行处理（恢复或移动过）→ 不覆盖
              skipped.push({ bookmarkId: id, reason: "already_restored_by_user" });
              continue;
            }
            // 软归档恢复：清除标记，回原目录；正文缓存/快照关联从未删除，天然可用
            db.prepare("UPDATE bookmarks SET archived_into = NULL WHERE id = ?").run(id);
            db.prepare("UPDATE bookmarks SET folder_id = ? WHERE id = ?").run(
              row.folder_id as string,
              id,
            );
            reversed++;
          }
        } else if (a.type === "createFolder") {
          this.store.deleteFolderIfEmpty(String(a.folderId));
          reversed++;
        }
      }
      this.store.markReverted(versionId);
      db.exec("COMMIT");
      return { reversed, skipped };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

