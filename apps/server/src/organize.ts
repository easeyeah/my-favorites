/**
 * 整理服务（F3，D27 act + undo）：一次调用 = 计划 + 直接生效，事后可撤销
 *
 * M1 支持两类指令 + 自由对话：
 *  - 重新分类（"整理"/"重新分类"，可带范围文件夹名）→ 逐条分类产出 move/createFolder
 *  - 合并重复（"合并重复"/"去重"）→ canonical URL 撞车的合并动作
 *  - 其他消息 → 指引性回答（不产出动作）
 * D27：砍掉「diff 预览 → 确认 → 应用」确认流——指令即执行（乐观校验通过直接落库），
 * 完成后由客户端按通知偏好（D28）呈现摘要；安全网 = organize_version 全量版本 + 一键回滚。
 * 红线：删除类操作永不自动执行（动作类型仅 move/merge/createFolder；归档/删除只出建议清单）。
 *
 * A3-2/3/4/5（2026-11-17）：
 *  - 动作保存稳定实体 ID + 原始状态（base_state）+ 修订版本（base_revisions）；
 *  - 提交在单事务中完成（校验/变更/版本/变更日志），失败整体回滚；
 *  - 冲突检测：计划生成后被用户手动改过的项目跳过并报告（不静默覆盖）；
 *  - 合并改软归档（archived_into 指向保留方），正文缓存/快照/隐私属性保留，回滚可恢复。
 *
 * DEV-08（2026-11-18）统一提交内核：
 *  - 目标目录按稳定 ID（plannedFolderId）解析，同名目录可区分（不再按名称 find-by-name）；
 *  - 提交短事务内重查：隐私策略/私密状态/当前父目录/revision/目标存在性/收纳盒归属；
 *  - 提交幂等：崩溃后重试返回原版本（不产生第二份版本）；
 *  - 撤销 = 新增 undo 版本（reverts_version_id 指向原版本），原历史永不删除；
 *    撤销同时入队反向镜像操作（撤销与镜像同事务，崩溃无空窗）；
 *  - 隐私重查：LLM 等待期间用户新增隐私规则或设私密 → 结果丢弃（原因码 stale_policy）。
 */
import { canonicalizeUrl, classifyByRules, isPrivacyDomain } from "@mf/shared";
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
  /** createFolder 动作：计划创建的 folderId；move 动作引用它作为稳定目标（同名可区分） */
  plannedFolderId?: string;
}

/**
 * 一次整理调用的结果（D27 act + undo：无确认流，直接生效）。
 * actions = 只读明细（客户端按目录分组折叠展示；不再承担确认职责）。
 */
export interface OrganizeRunResult {
  sessionId: string;
  status: "applied" | "answered";
  answer: string;
  actions: OrganizeActionView[] | null;
  versionId?: string;
  applied?: number;
  conflicts?: Array<{ bookmarkId: string; reason: string }>;
  /** 实际生效动作（服务端偏好记忆用） */
  appliedActions?: Array<{ type: string; toFolderName?: string }>;
}

/** 提交时每项动作的上下文重查结果 */
interface CommitCheck {
  ok: boolean;
  reason?: "modified_after_proposal" | "bookmark_deleted" | "privacy_changed" | "target_missing" | "not_in_inbox";
}

/**
 * DEV-08 提交内核：单条动作在事务内的前置重查。
 * 统一供功能点整理与收纳盒流水线使用（D42 起聊天整理下线）；任何一项不过 → 该项跳过并给原因码。
 */
function commitCheck(
  store: Store,
  bookmarkId: string,
  opts: { baseRevision?: number; requireInFolderId?: string; targetFolderId?: string } = {},
): CommitCheck {
  const bm = store.getBookmark(bookmarkId);
  if (!bm) return { ok: false, reason: "bookmark_deleted" };
  if (opts.baseRevision !== undefined && (bm.content_revision ?? 1) !== opts.baseRevision) {
    return { ok: false, reason: "modified_after_proposal" };
  }
  if (opts.requireInFolderId && bm.folder_id !== opts.requireInFolderId) {
    return { ok: false, reason: "not_in_inbox" };
  }
  // 隐私重查（当前规则/当前私密状态——LLM 等待期间可能已变化）
  if (bm.is_private === 1 || isPrivacyDomain(bm.url_raw, { patterns: store.privacyPatterns() })) {
    return { ok: false, reason: "privacy_changed" };
  }
  if (opts.targetFolderId && !store.getFolder(opts.targetFolderId)) {
    return { ok: false, reason: "target_missing" };
  }
  return { ok: true };
}

/**
 * DEV-08 镜像补偿入队（必须在提交事务内调用）：
 * 为书签的全部身份（限定 deviceId 时过滤）排浏览器节点移动操作。
 * 使用 store 幂等入队——同一事务内落库，崩溃无「已提交但无镜像」空窗。
 */
export function enqueueMirrorMoves(
  store: Store,
  appBookmarkId: string,
  targetFolderId: string,
  deviceId?: string,
): void {
  const target = store.getFolder(targetFolderId);
  if (!target) return;
  for (const ident of store.identitiesForApp(appBookmarkId)) {
    if (deviceId && ident.device_id !== deviceId) continue;
    store.enqueueBrowserOpIdempotent({
      deviceId: ident.device_id,
      op: "move",
      browserBookmarkId: ident.browser_bookmark_id,
      targetBrowserParentId: `mf-folder:${target.name}`,
      payload: { folderName: target.name, appFolderId: target.id },
    });
  }
}

export class OrganizeService {
  constructor(
    private store: Store,
    private llmFor: (purpose: "organize" | "summarize" | "embedding") => LlmClient | null,
  ) {}

  /**
   * 整理入口（D27 act + undo）：计划 + 直接生效一次完成。
   * 产出动作 → 落库 session（proposed）→ 同步提交（apply 内核，事务 + 幂等）→
   * 返回 applied 结果与只读明细。无动作 → answered（仅指引/说明）。
   */
  async handleMessage(message: string): Promise<OrganizeRunResult> {
    const sessionId = newId();

    let answer = "";
    let proposal: OrganizeActionView[] | null = null;

    if (/重新分类|整理/.test(message)) {
      const scopeFolder = this.extractScopeFolder(message);
      const result = await this.planReclassify(scopeFolder);
      proposal = result.proposal;
      answer = result.summary;
    } else if (/合并重复|去重|重复/.test(message)) {
      const result = this.planMergeDuplicates();
      proposal = result.proposal;
      answer = result.summary;
    } else {
      answer =
        "当前支持：①「整理」/「重新分类」——按内容重排书签（可指定范围，如“整理 开发 文件夹”）；②「合并重复」——清理规范化后重复的 URL。请告诉我你想做什么。";
    }

    // A3-2：动作保存稳定实体 ID + 原始状态（folder 快照）+ 修订版本
    // 冲突定义：提交时书签的 content_revision ≠ 计划时 → 用户手动改过 → 跳过
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
    const status = proposal && proposal.length > 0 ? "proposed" : "answered";
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

    // D27：有动作 → 直接提交生效（旧确认流的 /apply 端点已移除）
    if (status === "proposed") {
      const result = this.apply(sessionId);
      return {
        sessionId,
        status: "applied",
        answer,
        actions: proposal,
        versionId: result.versionId,
        applied: result.applied,
        conflicts: result.conflicts,
        appliedActions: result.appliedActions,
      };
    }
    return { sessionId, status: "answered", answer, actions: proposal };
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
            plannedFolderId: target,
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
        const userRules = this.store.getOrganizeRules();
        const out = await llm.chatJson<{
          results: Array<{ index: number; category: string; confidence: number }>;
        }>([
          {
            role: "system",
            content:
              "你是书签分类助手。现有目录：" +
              JSON.stringify(folderNames) +
              (prefs.length > 0 ? `。用户常用目录（优先参考）：${JSON.stringify(prefs)}` : "") +
              (userRules.length > 0 ? `。用户整理偏好（必须遵守）：${JSON.stringify(userRules)}` : "") +
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
              plannedFolderId: target,
            });
          }
        }
      } catch {
        // LLM 不可用：规则结果已入 proposal，其余保持原位
      }
    }

    const summary =
      proposal.length > 0
        ? `共扫描 ${scope.length} 条，已直接归位 ${proposal.length} 项变更；每一次挪动都记入版本历史，可整批撤销（D27）。`
        : `共扫描 ${scope.length} 条，分类结果与现有目录一致，无需挪动。`;
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
          ? `发现 ${proposal.length} 组重复，已合并（保留最早收藏的一条，其余软归档）；7 天内可在版本历史一键恢复（D28）。`
          : "未发现重复书签。",
      scope: all,
    };
  }

  /**
   * 提交内核（A3-3 事务化 + A3-4 冲突检测 + A3-5 软归档 + DEV-08 统一提交内核）。
   * 仅由 handleMessage 在同请求内调用（D27：对外不再有独立 apply 步骤）。
   * - 幂等：会话已 applied → 返回既有版本（崩溃重试不产生第二份版本）。
   * - 整个提交在单事务：目录创建（按 plannedFolderId 映射）、每项重查（revision/隐私/
   *   目标存在性）、移动、软归档、版本记录；任意一步抛错 → ROLLBACK。
   * - 合并 = 软归档：被合并方 archived_into=保留方，正文缓存/快照/隐私属性全保留。
   */
  private apply(sessionId: string): {
    versionId: string;
    applied: number;
    conflicts: Array<{ bookmarkId: string; reason: string }>;
    appliedActions: Array<{ type: string; toFolderName?: string }>;
  } {
    const session = this.store.db
      .prepare("SELECT * FROM organize_session WHERE id = ?")
      .get(sessionId) as
      | { id: string; status: string; proposal: string | null; base_revisions: string | null }
      | undefined;
    if (!session || !session.proposal) {
      throw new Error("session_not_proposed");
    }
    // DEV-08 幂等：已提交（或崩溃后重试）→ 返回原版本结果
    if (session.status === "applied") {
      const existing = this.store.getVersionBySession(sessionId);
      if (existing) {
        return {
          versionId: existing.id,
          applied: existing.actions.length,
          conflicts: [],
          appliedActions: [],
        };
      }
    }
    if (session.status !== "proposed") {
      throw new Error("session_not_proposed");
    }
    const proposal = JSON.parse(session.proposal) as OrganizeActionView[];
    const baseRevisions = (session.base_revisions ? JSON.parse(session.base_revisions) : {}) as Record<
      string,
      number
    >;
    const conflicts: Array<{ bookmarkId: string; reason: string }> = [];
    const appliedActions: Array<{ type: string; toFolderName?: string }> = [];
    const versionActions: unknown[] = [];
    const db = this.store.db;

    db.exec("BEGIN");
    try {
      // ① createFolder：plannedFolderId → 实际目录 ID 映射（同名目录按 ID 区分；
      //    已存在同名目录即复用，不再重复创建——未勾选的目录创建不会执行，见下方按需解析）
      const plannedToActual = new Map<string, string>();
      for (const action of proposal) {
        if (action.type === "createFolder" && action.folderName && action.plannedFolderId) {
          const existing = this.store.findFolderByName(action.folderName);
          if (existing && !existing.is_system_inbox) {
            plannedToActual.set(action.plannedFolderId, existing.id);
          } else {
            const created = this.store.createFolder(action.folderName, null, "ai_created");
            plannedToActual.set(action.plannedFolderId, created.id);
            versionActions.push({ type: "createFolder", folderId: created.id, name: created.name });
          }
        }
      }
      // ② move / merge（软归档）——每项在事务内重查（DEV-08 commitCheck）
      for (const action of proposal) {
        if (action.type === "move" && action.bookmarkId) {
          const targetId =
            (action.plannedFolderId ? plannedToActual.get(action.plannedFolderId) : undefined) ??
            (action.toFolder ? this.store.findFolderByName(action.toFolder)?.id : undefined);
          if (!targetId) continue;
          const before = this.store.getBookmark(action.bookmarkId);
          const baseRev = baseRevisions[action.bookmarkId];
          const check = commitCheck(this.store, action.bookmarkId, {
            baseRevision: baseRev,
            targetFolderId: targetId,
          });
          if (!check.ok) {
            if (check.reason) conflicts.push({ bookmarkId: action.bookmarkId, reason: check.reason });
            continue;
          }
          if (!before || before.folder_id === targetId) continue; // 已在目标：no-op
          this.store.moveBookmark(action.bookmarkId, targetId);
          versionActions.push({
            type: "move",
            bookmarkId: action.bookmarkId,
            fromFolderId: before.folder_id,
            toFolderId: targetId,
            revisionAfter: this.store.getBookmark(action.bookmarkId)?.content_revision ?? 1,
          });
          appliedActions.push({
            type: "move",
            toFolderName: this.store.getFolder(targetId)?.name,
          });
        } else if (action.type === "merge" && action.bookmarkId) {
          const archivedRows: unknown[] = [];
          for (const dupId of action.mergeFrom ?? []) {
            const baseRev = baseRevisions[dupId];
            const check = commitCheck(this.store, dupId, { baseRevision: baseRev });
            if (!check.ok) {
              if (check.reason) conflicts.push({ bookmarkId: dupId, reason: check.reason });
              continue;
            }
            const row = this.store.getBookmark(dupId)!;
            // A3-5 软归档：不删除，标记 archived_into；正文缓存/快照/隐私属性保留
            db.prepare("UPDATE bookmarks SET archived_into = ? WHERE id = ?").run(action.bookmarkId, dupId);
            archivedRows.push({ id: row.id, folder_id: row.folder_id, archived_from: row.archived_into ?? null });
          }
          if (archivedRows.length > 0) {
            versionActions.push({ type: "merge", keepId: action.bookmarkId, archivedRows });
            appliedActions.push({ type: "merge" });
          }
        }
      }
      // ③ 版本记录 + 会话状态（同事务）
      const versionId = this.store.saveVersion(sessionId, versionActions);
      db.prepare("UPDATE organize_session SET status = 'applied' WHERE id = ?").run(sessionId);
      db.exec("COMMIT");
      return { versionId, applied: versionActions.length, conflicts, appliedActions };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 回滚（DEV-08）：逆放 diff，生成新 undo 版本（reverts_version_id 指向原版本），
   * 原历史不删除。撤销与反向镜像入队同事务（崩溃无空窗）。
   * apply 后用户又改过的项跳过并在 skipped 中报告，不破坏用户修改；
   * 待执行的旧镜像操作一并取消（避免旧移动晚到覆盖撤销）。
   */
  rollback(versionId: string): {
    reversed: number;
    skipped: Array<{ bookmarkId: string; reason: string }>;
    undoVersionId: string;
  } {
    const version = this.store.getVersion(versionId);
    if (!version || version.reverted) throw new Error("version_not_found_or_reverted");
    let reversed = 0;
    const skipped: Array<{ bookmarkId: string; reason: string }> = [];
    const undoActions: unknown[] = [];
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
          // A3-4/DEV-08：apply 之后用户又手动改过（revision 变化）→ 跳过，不破坏用户修改
          const revAfter = a.revisionAfter as number | undefined;
          if (revAfter !== undefined && current.content_revision !== revAfter) {
            skipped.push({ bookmarkId: bmId, reason: "modified_after_apply" });
            continue;
          }
          const fromFolderId = String(a.fromFolderId);
          if (!this.store.getFolder(fromFolderId)) {
            skipped.push({ bookmarkId: bmId, reason: "target_folder_missing" });
            continue;
          }
          this.store.moveBookmark(bmId, fromFolderId);
          // 反向镜像入队（同事务）+ 取消待执行的旧移动（先撤销先取消，避免晚到覆盖）
          const folder = this.store.getFolder(fromFolderId)!;
          for (const ident of this.store.identitiesForApp(bmId)) {
            this.store.enqueueBrowserOpIdempotent({
              deviceId: ident.device_id,
              op: "move",
              browserBookmarkId: ident.browser_bookmark_id,
              targetBrowserParentId: `mf-folder:${folder.name}`,
              payload: { folderName: folder.name, appFolderId: folder.id },
            });
            this.store.cancelPendingBrowserOps(ident.device_id, ident.browser_bookmark_id, folder.name);
          }
          undoActions.push({ type: "move", bookmarkId: bmId, fromFolderId: current.folder_id, toFolderId: fromFolderId });
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
            undoActions.push({ type: "unmerge", bookmarkId: id, folderId: row.folder_id });
            reversed++;
          }
        } else if (a.type === "createFolder") {
          this.store.deleteFolderIfEmpty(String(a.folderId));
          undoActions.push({ type: "deleteFolderIfEmpty", folderId: a.folderId });
          reversed++;
        }
      }
      // 撤销本身是一条可审计的新版本（原历史保留、标记 reverted）
      const undoVersionId = this.store.saveVersion(null, undoActions, {
        kind: "undo",
        revertsVersionId: versionId,
      });
      this.store.markReverted(versionId);
      db.exec("COMMIT");
      return { reversed, skipped, undoVersionId };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

