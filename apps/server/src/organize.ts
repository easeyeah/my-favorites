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
import { canonicalizeUrl, classifyByRules, isPrivacyDomain, isSensitiveHost, PRIVATE_FOLDER_NAME } from "@mf/shared";
import { isLlmContentModeration, type LlmClient } from "@mf/ai/llm-client";
import type { Store } from "./store";
import { now, newId } from "./db";

const MAX_SCOPE = 500;
/** D43 二分隔离的额外 LLM 调用预算上限（一颗毒丸 ≈ log2(批量) 次调用；防雪崩） */
const MAX_ISOLATE_CALLS = 12;

interface PendingItem {
  id: string;
  title: string;
  url: string;
  folderId: string;
}

export interface OrganizeActionView {
  type: "move" | "rename" | "merge" | "createFolder" | "markPrivate";
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

/**
 * D45 浏览器书签重排排队：为每个含身份映射书签的目录，按管理台列表口径
 * （pinned DESC, added_at DESC, id）生成浏览器节点顺序快照，入队 reorder 操作。
 * 重排以最新快照为准：同设备+目录的旧 pending reorder 先终结再入队（防过期顺序）。
 * 返回各设备入队的目录操作数；无映射设备自然零操作。
 */
export function enqueueBrowserReorder(
  store: Store,
  deviceId?: string,
): { queued: number; folders: number } {
  let queued = 0;
  let folders = 0;
  for (const folder of store.listFolders()) {
    const bms = store.listBookmarks({ folderId: folder.id, limit: 5000 });
    if (bms.length === 0) continue;
    // 浏览器节点 id 按管理台顺序排列（仅收录该目录下有身份映射的书签）
    const byDevice = new Map<string, string[]>();
    for (const bm of bms) {
      for (const ident of store.identitiesForApp(bm.id)) {
        if (deviceId && ident.device_id !== deviceId) continue;
        const arr = byDevice.get(ident.device_id) ?? [];
        arr.push(ident.browser_bookmark_id);
        byDevice.set(ident.device_id, arr);
      }
    }
    if (byDevice.size === 0) continue;
    folders++;
    const target = `mf-folder:${folder.name}`;
    for (const [dev, order] of byDevice) {
      store.cancelPendingReorderOps(dev, target);
      store.enqueueBrowserOp({
        deviceId: dev,
        op: "reorder",
        targetBrowserParentId: target,
        payload: { folderName: folder.name, order },
      });
      queued++;
    }
  }
  return { queued, folders };
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
    const pending: PendingItem[] = [];

    for (const bm of scope) {
      // D43 事前旁路：敏感宿主不进 LLM 批次（供应商审核整包拒收），保持原位不动
      if (isSensitiveHost(bm.url_canonical)) {
        continue;
      }
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
    let quarantined: PendingItem[] = [];
    if (pending.length > 0 && llm) {
      const folderNames = this.store
        .listFolders()
        .filter((f) => !f.is_system_inbox)
        .map((f) => f.name);
      try {
        const userRules = this.store.getOrganizeRules();
        const budget = { calls: 0 };
        const { classified, quarantined: isolated } = await this.classifyPending(
          llm,
          pending,
          folderNames,
          prefs,
          userRules,
          budget,
        );
        for (const { item, category } of classified) {
          const target = this.ensureFolder(category, proposal);
          const from = this.store.getFolder(item.folderId);
          if (from && from.name !== category) {
            proposal.push({
              type: "move",
              bookmarkId: item.id,
              bookmarkTitle: item.title,
              fromFolder: from.name,
              toFolder: category,
              plannedFolderId: target,
            });
          }
        }
        // D43 事后隔离：审核单点拒收定位到的肇因项 → 标私密并移入「私人收藏」，整次整理不再因它失败
        quarantined = isolated;
        for (const item of isolated) {
          proposal.push(this.markPrivateView(item, proposal));
        }
      } catch {
        // LLM 不可用：规则结果已入 proposal，其余保持原位
      }
    }

    const quarantineNote =
      quarantined.length > 0
        ? `其中 ${quarantined.length} 条被供应商内容审核拒收，已自动标私密并移入「${PRIVATE_FOLDER_NAME}」（版本历史可撤销）。`
        : "";
    const summary =
      proposal.length > 0
        ? `共扫描 ${scope.length} 条，已直接归位 ${proposal.length} 项变更；每一次挪动都记入版本历史，可整批撤销（D27）。${quarantineNote}`
        : `共扫描 ${scope.length} 条，分类结果与现有目录一致，无需挪动。${quarantineNote}`;
    return { proposal, summary, scope };
  }

  /**
   * D43 LLM 批量分类 + 审核失败二分隔离。
   * - 正常批次：一次调用返回全部结果（index 为本批内相对序号）。
   * - 审核类错误（isLlmContentModeration）：批量 >1 → 对半拆成两次串行重试（预算封顶
   *   MAX_ISOLATE_CALLS，防雪崩）；批量 =1 → 该条即肇因项，隔离返回。
   * - 预算耗尽：本块放弃（不隔离、不误伤），已收集的分块结果照常返回。
   * - 非审核错误（故障/限流）原样上抛，由调用方按旧语义整批保持原位。
   */
  private async classifyPending(
    llm: LlmClient,
    items: PendingItem[],
    folderNames: string[],
    prefs: unknown[],
    userRules: unknown[],
    budget: { calls: number },
  ): Promise<{ classified: Array<{ item: PendingItem; category: string }>; quarantined: PendingItem[] }> {
    if (items.length === 0) return { classified: [], quarantined: [] };
    try {
      budget.calls++;
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
            items.map((p, i) => ({
              index: i,
              title: p.title,
              url: p.url,
              summary: this.store.getCache(p.id)?.l1_summary ?? "",
            })),
          ),
        },
      ]);
      const classified: Array<{ item: PendingItem; category: string }> = [];
      for (const r of out.results ?? []) {
        const item = items[r.index];
        if (!item || (r.confidence ?? 0) < 0.5 || !r.category || r.category === "未分类") {
          continue;
        }
        classified.push({ item, category: r.category });
      }
      return { classified, quarantined: [] };
    } catch (err) {
      if (!isLlmContentModeration(err)) throw err;
      if (items.length === 1) {
        // 词表漏网的肇因项定位成功：隔离（上层负责标私密 + 移入私人收藏）
        return { classified: [], quarantined: items };
      }
      if (budget.calls >= MAX_ISOLATE_CALLS) {
        // 隔离预算耗尽：宁可不处理，也不误伤整块
        return { classified: [], quarantined: [] };
      }
      const mid = Math.ceil(items.length / 2);
      const left = await this.classifyPending(llm, items.slice(0, mid), folderNames, prefs, userRules, budget);
      const right = await this.classifyPending(llm, items.slice(mid), folderNames, prefs, userRules, budget);
      return {
        classified: [...left.classified, ...right.classified],
        quarantined: [...left.quarantined, ...right.quarantined],
      };
    }
  }

  /** D43 提议行：标私密 + 移入「私人收藏」（目录 find-or-create，撤销时空目录会被回收） */
  private markPrivateView(item: PendingItem, proposal: OrganizeActionView[]): OrganizeActionView {
    const plannedFolderId = this.ensureFolder(PRIVATE_FOLDER_NAME, proposal);
    return {
      type: "markPrivate",
      bookmarkId: item.id,
      bookmarkTitle: item.title,
      toFolder: PRIVATE_FOLDER_NAME,
      plannedFolderId,
    };
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
        } else if (action.type === "markPrivate" && action.bookmarkId) {
          // D43：标私密不走 commitCheck 的隐私门——本动作的目的就是把敏感项标成私密；
          // revision 冲突检测与"已删除"检查照常（用户等待期间改过的项不覆盖）。
          const before = this.store.getBookmark(action.bookmarkId);
          if (!before) {
            conflicts.push({ bookmarkId: action.bookmarkId, reason: "bookmark_deleted" });
            continue;
          }
          const baseRev = baseRevisions[action.bookmarkId];
          if (baseRev !== undefined && (before.content_revision ?? 1) !== baseRev) {
            conflicts.push({ bookmarkId: action.bookmarkId, reason: "modified_after_proposal" });
            continue;
          }
          const targetId =
            (action.plannedFolderId ? plannedToActual.get(action.plannedFolderId) : undefined) ??
            (action.toFolder ? this.store.findFolderByName(action.toFolder)?.id : undefined);
          const needMove = Boolean(targetId && before.folder_id !== targetId);
          if (before.is_private === 1 && !needMove) continue; // 幂等：已是目标态
          if (before.is_private !== 1) this.store.updateBookmark(action.bookmarkId, { is_private: 1 });
          if (needMove) {
            this.store.moveBookmark(action.bookmarkId, targetId!);
            enqueueMirrorMoves(this.store, action.bookmarkId, targetId!);
          }
          // is_private/folder_id 变更会 bump content_revision → revisionAfter 记最终值（rollback 守卫用）
          const after = this.store.getBookmark(action.bookmarkId);
          versionActions.push({
            type: "markPrivate",
            bookmarkId: action.bookmarkId,
            fromPrivate: before.is_private,
            fromFolderId: before.folder_id,
            toFolderId: needMove ? targetId! : null,
            revisionAfter: after?.content_revision ?? 1,
          });
          appliedActions.push({ type: "markPrivate", toFolderName: needMove ? PRIVATE_FOLDER_NAME : undefined });
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
        } else if (a.type === "markPrivate") {
          // D43 撤销：还原私密位 + 移回原目录 + 反向镜像入队（同事务）
          const bmId = String(a.bookmarkId);
          const current = this.store.getBookmark(bmId);
          if (!current) {
            skipped.push({ bookmarkId: bmId, reason: "bookmark_deleted" });
            continue;
          }
          const revAfter = a.revisionAfter as number | undefined;
          if (revAfter !== undefined && current.content_revision !== revAfter) {
            skipped.push({ bookmarkId: bmId, reason: "modified_after_apply" });
            continue;
          }
          const fromPrivate = Number(a.fromPrivate) === 1 ? 1 : 0;
          const fromFolderId = a.fromFolderId ? String(a.fromFolderId) : null;
          let changed = false;
          if (current.is_private !== fromPrivate) {
            this.store.updateBookmark(bmId, { is_private: fromPrivate });
            changed = true;
          }
          let movedBack = false;
          if (fromFolderId && current.folder_id !== fromFolderId) {
            const folder = this.store.getFolder(fromFolderId);
            if (!folder) {
              skipped.push({ bookmarkId: bmId, reason: "target_folder_missing" });
            } else {
              this.store.moveBookmark(bmId, fromFolderId);
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
              movedBack = true;
              changed = true;
            }
          }
          if (changed) {
            // 同形记录（markPrivate 语义），undo 版本自身可再回滚（重标私密 + 移回私人收藏）
            undoActions.push({
              type: "markPrivate",
              bookmarkId: bmId,
              fromPrivate: current.is_private,
              fromFolderId: current.folder_id,
              toFolderId: movedBack ? fromFolderId : null,
              revisionAfter: this.store.getBookmark(bmId)?.content_revision ?? 1,
            });
            reversed++;
          }
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

  /**
   * D43 敏感内容旁路 · 功能点内核（tidy）：全库扫描敏感宿主命中且未标私密的条目
   * → is_private=1 + 移入「私人收藏」（find-or-create）+ 浏览器镜像入队 + 写 organize_version，
   * 全部单事务——任意一步失败整体回滚，不留半提交。
   * 幂等：再跑一次只处理增量；永不删除（红线③）；撤销走通用 /organize/rollback（markPrivate 逆放）。
   */
  sweepSensitive(): {
    scanned: number;
    marked: number;
    versionId: string | null;
    folderName: string;
  } {
    const db = this.store.db;
    db.exec("BEGIN");
    try {
      const rows = this.store.listBookmarks({ limit: 10000 });
      const hits = rows.filter((b) => b.is_private !== 1 && isSensitiveHost(b.url_canonical));
      if (hits.length === 0) {
        db.exec("COMMIT");
        return { scanned: rows.length, marked: 0, versionId: null, folderName: PRIVATE_FOLDER_NAME };
      }
      const actions: unknown[] = [];
      let folder = this.store.findFolderByName(PRIVATE_FOLDER_NAME);
      if (!folder) {
        folder = this.store.createFolder(PRIVATE_FOLDER_NAME, null, "ai_created");
        actions.push({ type: "createFolder", folderId: folder.id, name: folder.name });
      }
      const target = folder;
      for (const before of hits) {
        const needMove = before.folder_id !== target.id;
        this.store.updateBookmark(before.id, { is_private: 1 });
        if (needMove) {
          this.store.moveBookmark(before.id, target.id);
          enqueueMirrorMoves(this.store, before.id, target.id);
        }
        actions.push({
          type: "markPrivate",
          bookmarkId: before.id,
          fromPrivate: before.is_private,
          fromFolderId: before.folder_id,
          toFolderId: needMove ? target.id : null,
          revisionAfter: this.store.getBookmark(before.id)?.content_revision ?? 1,
        });
      }
      const versionId = this.store.saveVersion(null, actions);
      db.exec("COMMIT");
      return { scanned: rows.length, marked: hits.length, versionId, folderName: PRIVATE_FOLDER_NAME };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

