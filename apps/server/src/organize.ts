/**
 * 聊天整理（F3）：会话 → proposal（diff）→ apply → rollback
 *
 * M1 支持两类指令 + 自由对话：
 *  - 重新分类（"整理"/"重新分类"，可带范围文件夹名）→ 逐条分类产出 move/createFolder
 *  - 合并重复（"合并重复"/"去重"）→ canonical URL 撞车的合并动作
 *  - 其他消息 → 指引性回答（不产出 proposal）
 * 红线：删除类操作永不自动执行；apply 前必须 diff 确认；全部写 organize_version。
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
    private llm: LlmClient | null,
  ) {}

  async handleMessage(
    message: string,
  ): Promise<{ sessionId: string; status: string; answer: string; proposal: OrganizeActionView[] | null }> {
    const sessionId = newId();
    const lower = message.toLowerCase();

    let status = "answered";
    let answer = "";
    let proposal: OrganizeActionView[] | null = null;

    if (/重新分类|整理/.test(message)) {
      const scopeFolder = this.extractScopeFolder(message);
      const result = await this.planReclassify(scopeFolder);
      proposal = result.proposal;
      status = "proposed";
      answer = result.summary;
    } else if (/合并重复|去重|重复/.test(message)) {
      const result = this.planMergeDuplicates();
      proposal = result.proposal;
      status = proposal.length > 0 ? "proposed" : "answered";
      answer = result.summary;
    } else {
      answer =
        "当前支持：①「整理」/「重新分类」——按内容重排书签（可指定范围，如“整理 开发 文件夹”）；②「合并重复」——清理规范化后重复的 URL。请告诉我你想做什么。";
    }

    this.store.db
      .prepare(
        "INSERT INTO organize_session (id, message, status, answer, proposal, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(sessionId, message, status, answer, proposal ? JSON.stringify(proposal) : null, now());

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
  }> {
    let scope = this.store.listBookmarks({ limit: MAX_SCOPE });
    if (scopeFolder) {
      const folder = this.store.findFolderByName(scopeFolder);
      if (!folder) {
        return { proposal: [], summary: `未找到文件夹「${scopeFolder}」` };
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

    // LLM 批量分类（无 LLM 时保留原位并在 summary 说明）
    if (pending.length > 0 && this.llm) {
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
              "你是书签分类助手。现有目录：" +
              JSON.stringify(folderNames) +
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
    return { proposal, summary };
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
  } {
    const all = this.store.listBookmarks({ limit: MAX_SCOPE });
    // 相似检测（F5.2）：url_canonical 有 UNIQUE 约束（入库即查重），所以
    // 库内重复只可能是"同域同名"的近重复——按 registrableDomain+title 分组
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
      // 保留添加最早的（信息最全），其余并入
      const sorted = [...arr].sort((a, b) => a.added_at.localeCompare(b.added_at));
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
    };
  }

  /** 应用 proposal（乐观锁：apply 必须带 session 的原始 proposal） */
  apply(sessionId: string): { versionId: string; applied: number } {
    const session = this.store.db
      .prepare("SELECT * FROM organize_session WHERE id = ?")
      .get(sessionId) as
      | { id: string; status: string; proposal: string | null }
      | undefined;
    if (!session || session.status !== "proposed" || !session.proposal) {
      throw new Error("session_not_proposed");
    }
    const proposal = JSON.parse(session.proposal) as OrganizeActionView[];
    const versionActions: unknown[] = [];

    for (const action of proposal) {
      if (action.type === "createFolder" && action.folderName) {
        const existing = this.store.findFolderByName(action.folderName);
        if (!existing) {
          const created = this.store.createFolder(action.folderName, null, "ai_created");
          versionActions.push({
            type: "createFolder",
            folderId: created.id,
            name: created.name,
          });
        }
      }
    }
    for (const action of proposal) {
      if (action.type === "move" && action.bookmarkId) {
        const to = this.store.findFolderByName(action.toFolder ?? "");
        const before = to ? this.store.moveBookmark(action.bookmarkId, to.id) : undefined;
        if (before && to) {
          versionActions.push({
            type: "move",
            bookmarkId: action.bookmarkId,
            fromFolderId: before.folder_id,
            toFolderId: to.id,
          });
        }
      } else if (action.type === "merge" && action.bookmarkId) {
        const deletedRows: unknown[] = [];
        for (const dupId of action.mergeFrom ?? []) {
          const row = this.store.deleteBookmark(dupId);
          if (row) deletedRows.push(row);
        }
        if (deletedRows.length > 0) {
          versionActions.push({ type: "merge", keepId: action.bookmarkId, deletedRows });
        }
      }
    }

    const versionId = this.store.saveVersion(sessionId, versionActions);
    this.store.db
      .prepare("UPDATE organize_session SET status = 'applied' WHERE id = ?")
      .run(sessionId);
    return { versionId, applied: versionActions.length };
  }

  /** 回滚：逆放 diff（move 反向、merge 重插、createFolder 空则删） */
  rollback(versionId: string): { reversed: number } {
    const version = this.store.getVersion(versionId);
    if (!version || version.reverted) throw new Error("version_not_found_or_reverted");
    let reversed = 0;
    for (const raw of [...version.actions].reverse()) {
      const a = raw as Record<string, unknown>;
      if (a.type === "move") {
        this.store.moveBookmark(String(a.bookmarkId), String(a.fromFolderId));
        reversed++;
      } else if (a.type === "merge") {
        for (const row of (a.deletedRows ?? []) as Array<Record<string, unknown>>) {
          // 重插被合并的书签（保留原 id 与原始目录）
          const exists = this.store.getBookmark(String(row.id));
          if (!exists) {
            this.store.db
              .prepare(
                "INSERT INTO bookmarks (id, folder_id, url_raw, url_canonical, title, description, status, favicon_url, cover_url, added_at, last_checked_at, pinned, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                ...(
                  [
                    "id",
                    "folder_id",
                    "url_raw",
                    "url_canonical",
                    "title",
                    "description",
                    "status",
                    "favicon_url",
                    "cover_url",
                    "added_at",
                    "last_checked_at",
                    "pinned",
                    "created_at",
                  ] as const
                ).map((k) => row[k] as string | number | null),
              );
            reversed++;
          }
        }
      } else if (a.type === "createFolder") {
        this.store.deleteFolderIfEmpty(String(a.folderId));
        reversed++;
      }
    }
    this.store.markReverted(versionId);
    return { reversed };
  }
}

