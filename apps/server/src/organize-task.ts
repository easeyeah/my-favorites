/**
 * D92 目录整理任务 · 运行器（《书签目录自动整理重设计》§4–§8）
 *
 * 一次目录整理 = 一个持久任务：固定范围快照 → 规划（organize-task-plan.ts）→ 分批短事务提交 → 汇总。
 *  - 持久状态是真相，内存 Promise 只负责唤醒：收起/刷新/断线不打断任务，进程重启后从检查点接续；
 *  - 每批提交在同一事务内重查基线（实体/修订/归属/生命周期/隐私/目标）、核对停止标志与运行租约，
 *    并以真实写入回执计数——moveBookmark 未写入、转换未成立都不计成功；
 *  - 书签归位与转资料互斥（一条来源收藏只有一个主去向），资料 + 分类 + 软移出同事务；
 *  - 撤销复用组织版本内核：先停止并排空在途提交，再按批次逆序逆放，实际恢复与保留分开计数。
 *
 * 多租户：任务与明细落当前用户独立 SQLite（Store.db 按请求/任务上下文解析），后台执行固定在 runAsUser 内；
 * 跨 await 不持有数据库句柄（用户库会被闲置回收，下一次访问透明重开）。
 */
import { classifyMaterialKind, isPrivacyDomain, isSensitiveHost } from "@mf/shared";
import { isLlmContentModeration, type LlmClient } from "@mf/ai/llm-client";
import type { BookmarkRow, FolderRow, OrganizeTaskItemRow, OrganizeTaskRow, OrganizeTaskStatus, Store } from "./store";
import type { Pipeline } from "./pipeline";
import type { OrganizeService } from "./organize";
import { enqueueMirrorMoves } from "./organize";
import { newId, now } from "./db";
import { currentUserId, runAsUser } from "./tenancy";
import {
  PlanError,
  planRuleOnly,
  planWithAi,
  relPathOf,
  type ChatMessage,
  type FolderNode,
  type ItemPlan,
  type PlanHost,
  type PlanOutcome,
  type TaskPlan,
} from "./organize-task-plan";

/** 模型请求整体等待的租约心跳窗口：超过它没有心跳即视为 worker 已失联，可被接管 */
const LEASE_TTL_MS = 90_000;
/** 提交批量（单事务内的条目上限） */
const COMMIT_BATCH = 30;
/** 与导入/同步路径一致的总深度约束（新建目录不得越过） */
const MAX_DEPTH = 16;
/** 终态任务仍可「继续剩余 / 重试失败」的窗口（与明细保留期一致） */
const CONTINUE_DAYS = 30;

const ACTIVE_STATUSES: OrganizeTaskStatus[] = ["queued", "running", "stopping"];

export class OrganizeTaskError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 404 | 409 = 409,
  ) {
    super(message);
    this.name = "OrganizeTaskError";
  }
}

class StopSignal extends Error {}
class LeaseLost extends Error {}

export interface OrganizeTaskItemView {
  id: string;
  bookmark_id: string;
  title: string | null;
  decision: string;
  reason: string | null;
  retryable: boolean;
  from_path: string | null;
  to_path: string | null;
  category_path: string | null;
  batch: number | null;
  updated_at: string;
}

export interface OrganizeTaskFolderView {
  key: string;
  path: string;
  /** planned | created | reused | unapplied */
  state: string;
  folder_id: string | null;
  planned_count: number;
  actual_count: number;
  /** D94：落点在来源目录之外（复用了库内其他目录，或新建的顶级目录） */
  outside: boolean;
}

export interface OrganizeTaskCategoryView {
  path: string;
  /** planned | new | reused | unapplied */
  state: string;
  planned_count: number;
  actual_count: number;
}

export interface OrganizeTaskView {
  id: string;
  folder_id: string;
  folder_name: string;
  status: OrganizeTaskStatus;
  phase: string;
  phase_note: string | null;
  mode: string;
  total: number;
  checked: number;
  remaining: number;
  /** 规划阶段：已形成判断的条目数（阶段工作量，不等于已落库） */
  planned: number;
  moved: number;
  /** D94：已移动条目中落到来源目录之外的条数（跨根复用 / 新建顶级目录）；明细已裁剪的历史任务不带 */
  moved_outside?: number;
  converted: number;
  new_materials: number;
  reused_materials: number;
  unchanged: number;
  skipped: number;
  failed: number;
  protected_count: number;
  excluded_archived: number;
  planned_new_folders: number;
  created_folders: number;
  reused_folders: number;
  planned_categories: number;
  new_categories: number;
  reused_categories: number;
  topics: string[];
  error: string | null;
  revision: number;
  can_continue: boolean;
  continue_expires_at: string | null;
  undo_status: string;
  undo_restored: number;
  undo_kept: number;
  undo_categories: number;
  undo_folders: number;
  created_at: string;
  started_at: string | null;
  phase_at: string | null;
  finished_at: string | null;
  /** 终态说明（服务端生成，口径与计数一致）；进行中为 null */
  summary: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function summarize(t: OrganizeTaskRow & { remaining: number; checked: number; skipped: number; insufficient: number; tooFew: number }): string | null {
  if (t.status === "queued" || t.status === "running" || t.status === "stopping") return null;
  if (t.status === "failed") return t.error ?? "任务未能继续";
  if (t.status === "stopped") {
    return `已停止：已检查 ${t.checked} / ${t.total}，剩余 ${t.remaining}；已归位 ${t.moved} 条、转资料 ${t.converted} 条`;
  }
  if (t.failed > 0) return `检查完成，有 ${t.failed} 条处理失败`;
  if (t.mode === "rule_only") {
    return t.moved > 0
      ? `已按本地规则归位 ${t.moved} 条；其余 ${t.unchanged} 条规则未命中，保持原位（未配置模型，未做 AI 主题发现与资料分流）`
      : "未配置整理模型，本次仅检查本地规则；规则未命中，没有移动书签";
  }
  const few = t.tooFew > 0 ? `${t.tooFew} 条同类太少，未单独建目录` : "";
  if (t.moved + t.converted === 0) {
    const parts = [
      t.insufficient > 0 ? `${t.insufficient} 条证据不足` : "",
      t.insufficient > 0 && t.tooFew > 0 ? "，" : "",
      few,
    ].join("");
    const why = parts ? `有 ${parts}，保留原位` : "当前位置均合适";
    return `已检查 ${t.total} 条，${why}，本次未调整`;
  }
  const tail =
    (t.insufficient > 0 ? `；另有 ${t.insufficient} 条证据不足，保持原位` : "") +
    (t.tooFew > 0 ? `；${t.tooFew} 条同类太少，未单独建目录` : "");
  return `检查完成：书签归位 ${t.moved} 条${t.converted > 0 ? `，转入资料 ${t.converted} 条` : ""}${tail}`;
}

export class OrganizeTaskService {
  /** 任务状态变化门铃（app 层接到 SSE：organize.task_changed，只带 taskId 不带内容） */
  onChange: ((taskId: string) => void) | null = null;
  /** 任务完成且有实际变更（D33 出站 Hook 等聚合通知；不含单条内容） */
  onApplied: ((task: OrganizeTaskRow) => void) | null = null;

  /**
   * 全局并发闸：本服务实例内所有账号的本功能模型请求 / 出站补抓各 ≤1 在途，批次间公平让出。
   * 生产装配为单实例（index.ts），即进程级全局闸；按实例而非模块静态持有——重启接管时新实例不被旧实例的悬挂调用卡住。
   */
  private llmQueue: Promise<unknown> = Promise.resolve();
  private crawlQueue: Promise<unknown> = Promise.resolve();
  /** 同一任务上的运行与撤销串行（撤销必然排在运行之后） */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly scheduled = new Set<string>();
  private inFlight = 0;
  private idleWaiters: Array<() => void> = [];
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: Store,
    private llmFor: (purpose: "organize" | "summarize" | "embedding") => LlmClient | null,
    private pipeline: Pipeline,
    private organize: OrganizeService,
    /** 后台恢复遍历口径：自建单用户 self；多用户逐库 */
    private listUserIds: () => string[] = () => ["self"],
  ) {}

  // ==================== 生命周期入口 ====================

  /**
   * 创建任务：同幂等键回同一任务；已有活动任务/撤销则回它（不并行）。
   * 范围在此刻固定——目录及全部后代中的有效书签；受保护条目只计数、不落明细。
   */
  create(folderId: string, requestId: string): { task: OrganizeTaskRow; created: boolean; existing: boolean } {
    const folder = this.store.getFolder(folderId);
    if (!folder || folder.is_system_inbox === 1) {
      throw new OrganizeTaskError("folder_not_found", "目录不存在或不能整理", 404);
    }
    const key = String(requestId ?? "").trim();
    if (!key) throw new OrganizeTaskError("request_id_required", "缺少请求标识", 400);
    const mine = this.store.findOrganizeTaskByRequest(key);
    if (mine) return { task: mine, created: false, existing: false };
    const active = this.store.activeOrganizeTask();
    if (active) return { task: active, created: false, existing: true };

    const patterns = this.store.privacyPatterns();
    const privacyRevision = this.store.privacyRevision();
    const ts = now();
    const taskId = newId();
    const items: OrganizeTaskItemRow[] = [];
    let protectedCount = 0;
    let excludedArchived = 0;
    // await 前基线：原目录/内容修订/隐私修订在此刻采集，规划与提交都不得改用之后的状态
    for (const bm of this.store.subtreeBookmarks(folderId)) {
      if (bm.status === "archived") {
        excludedArchived += 1;
        continue;
      }
      if (bm.is_private === 1 || isSensitiveHost(bm.url_canonical) || isPrivacyDomain(bm.url_raw, { patterns })) {
        protectedCount += 1;
        continue;
      }
      items.push({
        id: newId(), task_id: taskId, bookmark_id: bm.id, seq: items.length, title: bm.title.slice(0, 200),
        base_folder_id: bm.folder_id, base_revision: bm.content_revision ?? 1, privacy_revision: privacyRevision,
        kind: null, material_type: null, evidence_ref: null, decision: "remaining", reason: null,
        plan_decision: null, plan_target_key: null, plan_category: null, plan_material_type: null, plan_reason: null,
        from_path: null, to_path: null, category_before: null, material_before: null, attempts: 0, batch: null,
        version_id: null, retryable: 0, updated_at: ts,
      });
    }
    if (items.length === 0) {
      throw new OrganizeTaskError(
        "empty_scope",
        protectedCount > 0 ? "目录内没有可自动整理的书签（全部为受保护的私密/隐私条目）" : "目录内没有可整理的书签",
        400,
      );
    }
    // total 含受保护条目：它们计入 skipped，保证 total = moved + converted + unchanged + skipped + failed + remaining
    const task: OrganizeTaskRow = {
      id: taskId, request_id: key, folder_id: folderId, folder_name: folder.name, status: "queued", phase: "scope",
      phase_note: null, mode: "ai", total: items.length + protectedCount, moved: 0, converted: 0, new_materials: 0, reused_materials: 0,
      unchanged: 0, skipped: 0, failed: 0, protected_count: protectedCount, excluded_archived: excludedArchived,
      planned_new_folders: 0, created_folders: 0, reused_folders: 0, planned_categories: 0, new_categories: 0,
      reused_categories: 0, plan_json: null, error: null, lease: null, lease_at: null, revision: 0, can_continue: 1,
      continue_expires_at: null, undo_status: "none", undo_cursor: 0, undo_restored: 0, undo_kept: 0, undo_categories: 0,
      undo_folders: 0, created_at: ts, started_at: null, phase_at: ts, finished_at: null,
    };
    this.store.createOrganizeTask(task, items);
    this.kickRun(currentUserId(), taskId);
    return { task, created: true, existing: false };
  }

  get(taskId: string): OrganizeTaskRow {
    const task = this.store.getOrganizeTask(taskId);
    if (!task) throw new OrganizeTaskError("task_not_found", "整理任务不存在", 404);
    return task;
  }

  /** 收起 ≠ 停止：只有显式停止才持久记录停止请求，运行器在下一个检查点/提交屏障确认 */
  requestStop(taskId: string): OrganizeTaskRow {
    const task = this.get(taskId);
    if (task.status === "queued" || task.status === "running") {
      this.store.bumpOrganizeTask(taskId, { status: "stopping" });
      this.kickRun(currentUserId(), taskId);
      this.emit(taskId);
    }
    return this.store.getOrganizeTask(taskId)!;
  }

  /** 继续剩余 / 重试失败项：只重开原快照内的未完成项，不吸收新的用户改动 */
  continueTask(taskId: string, mode: "remaining" | "failed"): { task: OrganizeTaskRow; reopened: number } {
    const task = this.get(taskId);
    if (ACTIVE_STATUSES.includes(task.status)) throw new OrganizeTaskError("task_active", "任务仍在进行中", 409);
    if (task.undo_status !== "none") {
      throw new OrganizeTaskError("task_undo_started", "这次整理已开始撤销，不能再沿原方案继续；需要时请基于最新状态重新整理", 409);
    }
    if (task.can_continue !== 1) {
      throw new OrganizeTaskError("task_snapshot_expired", "原整理快照已过期，不能继续；请基于最新状态重新整理", 409);
    }
    const targets = this.store.organizeTaskItemsByDecision(
      taskId,
      mode === "failed" ? ["fail"] : ["remaining", "fail"],
    );
    if (targets.length === 0) {
      throw new OrganizeTaskError("nothing_to_continue", mode === "failed" ? "没有可重试的失败项" : "没有未完成的条目", 409);
    }
    const ts = now();
    this.store.db.exec("SAVEPOINT mf_organize_task_continue");
    try {
      for (const it of targets) {
        this.store.updateOrganizeTaskItem(it.id, {
          decision: "remaining", reason: null, retryable: 0, attempts: it.attempts + 1,
          plan_decision: null, plan_target_key: null, plan_category: null, plan_material_type: null, plan_reason: null,
          updated_at: ts,
        });
      }
      this.store.bumpOrganizeTask(taskId, {
        status: "queued", phase: "scope", phase_note: null, error: null, finished_at: null, lease: null, lease_at: null,
      }, false);
      this.refreshCounters(taskId);
      this.store.db.exec("RELEASE mf_organize_task_continue");
    } catch (err) {
      this.store.db.exec("ROLLBACK TO mf_organize_task_continue");
      this.store.db.exec("RELEASE mf_organize_task_continue");
      throw err;
    }
    this.kickRun(currentUserId(), taskId);
    this.emit(taskId);
    return { task: this.store.getOrganizeTask(taskId)!, reopened: targets.length };
  }

  /**
   * 撤销本次整理：先停止并排空在途提交，再按批次逆序逆放。幂等——重复请求返回当前撤销状态。
   * onlyVersionId：从版本历史单独撤销任务的某一批（其余批次保留，但整个任务此后不能再继续）。
   */
  requestUndo(taskId: string, onlyVersionId?: string): { task: OrganizeTaskRow; pending: boolean } {
    const task = this.get(taskId);
    if (["pending", "running", "completed"].includes(task.undo_status) && !onlyVersionId) {
      return { task, pending: ["pending", "running"].includes(task.undo_status) };
    }
    const versions = this.store.taskVersions(taskId);
    if (versions.length === 0) throw new OrganizeTaskError("nothing_to_undo", "这次整理没有已生效的调整", 409);
    if (onlyVersionId && !versions.some((v) => v.id === onlyVersionId)) {
      throw new OrganizeTaskError("version_not_in_task", "该版本不属于这次整理", 404);
    }
    if (onlyVersionId && this.store.getVersion(onlyVersionId)?.reverted) {
      throw new OrganizeTaskError("version_not_found_or_reverted", "该版本已撤销", 400);
    }
    const uid = currentUserId();
    const pendingRun = ACTIVE_STATUSES.includes(task.status);
    this.store.bumpOrganizeTask(taskId, {
      undo_status: "pending",
      ...(pendingRun ? { status: "stopping" } : {}),
    }, false);
    // 运行与撤销在同一任务链上串行：撤销必然在运行收尾（停止并排空提交）之后执行
    if (pendingRun) this.kickRun(uid, taskId);
    this.kickUndo(uid, taskId, onlyVersionId ?? null);
    this.emit(taskId);
    return { task: this.store.getOrganizeTask(taskId)!, pending: true };
  }

  /** 启动 + 定时恢复：进程重启或 worker 异常退出后仍挂在活动态的任务/撤销 */
  startResumer(): void {
    this.resumeInterrupted();
    this.sweeper = setInterval(() => this.resumeInterrupted(), 60_000);
    this.sweeper.unref?.();
  }

  stopResumer(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  resumeInterrupted(): void {
    for (const uid of this.listUserIds()) {
      runAsUser(uid, () => {
        for (const task of this.store.interruptibleOrganizeTasks()) {
          const leaseFresh =
            task.status === "running" && task.lease && !Number.isNaN(Date.parse(task.lease_at ?? "")) &&
            Date.now() - Date.parse(task.lease_at!) < LEASE_TTL_MS;
          if (ACTIVE_STATUSES.includes(task.status) && !leaseFresh) this.kickRun(uid, task.id);
          if (task.undo_status === "pending" || task.undo_status === "running") this.kickUndo(uid, task.id, null);
        }
      });
    }
  }

  /** 测试等待：所有已排队的运行/撤销收尾 */
  idle(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // ==================== 查询面 ====================

  view(task: OrganizeTaskRow): OrganizeTaskView {
    // 终态且明细已裁剪时，逐条结果已不可重算：沿用任务行上保留的历史计数，不把「查不到明细」显示成 0
    const pruned = !ACTIVE_STATUSES.includes(task.status) && task.can_continue !== 1;
    const live = this.store.organizeTaskCounters(task.id);
    const c = pruned
      ? {
          moved: task.moved, converted: task.converted, newMaterials: task.new_materials,
          reusedMaterials: task.reused_materials, unchanged: task.unchanged, skipped: task.skipped, failed: task.failed,
          insufficient: 0,
          tooFew: 0,
        }
      : live;
    const skipped = c.skipped + task.protected_count;
    const remaining = Math.max(0, task.total - (c.moved + c.converted + c.unchanged + skipped + c.failed));
    const checked = task.total - remaining;
    const plan = pruned ? null : this.readPlan(task);
    const counts = this.store.organizeTaskTargetCounts(task.id);
    const structure = {
      planned_new_folders: (plan?.folderNodes ?? []).filter((n) => !n.reuseId).length,
      created_folders: (plan?.folderNodes ?? []).filter((n) => n.id && !n.reuseId).length,
      reused_folders: (plan?.folderNodes ?? []).filter((n) => n.reuseId && (counts.folders.get(n.key) ?? 0) > 0).length,
      planned_categories: plan?.categories.length ?? 0,
      new_categories: (plan?.categories ?? []).filter((x) => !x.existedBefore && counts.categories.has(x.path)).length,
      reused_categories: (plan?.categories ?? []).filter((x) => x.existedBefore && counts.categories.has(x.path)).length,
    };
    const history = {
      planned_new_folders: task.planned_new_folders, created_folders: task.created_folders,
      reused_folders: task.reused_folders, planned_categories: task.planned_categories,
      new_categories: task.new_categories, reused_categories: task.reused_categories,
    };
    return {
      id: task.id, folder_id: task.folder_id, folder_name: task.folder_name, status: task.status, phase: task.phase,
      phase_note: task.phase_note, mode: task.mode, total: task.total, checked, remaining,
      planned: pruned ? 0 : this.store.countOrganizeTaskPlanned(task.id),
      ...(pruned ? {} : { moved_outside: this.countMovedOutside(task, plan ?? undefined) }),
      moved: c.moved, converted: c.converted, new_materials: c.newMaterials, reused_materials: c.reusedMaterials,
      unchanged: c.unchanged, skipped, failed: c.failed, protected_count: task.protected_count,
      excluded_archived: task.excluded_archived, ...(pruned ? history : structure),
      topics: plan?.topics ?? [], error: task.error, revision: task.revision,
      can_continue: task.can_continue === 1, continue_expires_at: task.continue_expires_at, undo_status: task.undo_status,
      undo_restored: task.undo_restored, undo_kept: task.undo_kept, undo_categories: task.undo_categories,
      undo_folders: task.undo_folders, created_at: task.created_at, started_at: task.started_at, phase_at: task.phase_at,
      finished_at: task.finished_at,
      summary: summarize({ ...task, ...c, skipped, checked, remaining }),
    };
  }

  /** D94：已移动条目里落到来源目录之外的数量——按规划节点判定，不依赖条目当前是否又被用户移动 */
  private countMovedOutside(task: OrganizeTaskRow, plan: TaskPlan | undefined): number {
    if (!plan) return 0;
    const subtree = new Set(this.store.folderSubtreeIds(plan.rootFolderId));
    const byKey = new Map(plan.folderNodes.map((n) => [n.key, n]));
    let count = 0;
    for (const key of this.store.organizeTaskMovedTargetKeys(task.id)) {
      const node = byKey.get(key);
      if (node?.id && !subtree.has(node.id)) count += 1;
    }
    return count;
  }

  itemView(it: OrganizeTaskItemRow): OrganizeTaskItemView {
    return {
      id: it.id, bookmark_id: it.bookmark_id, title: it.title, decision: it.decision, reason: it.reason,
      retryable: it.retryable === 1, from_path: it.from_path, to_path: it.to_path,
      category_path: it.decision === "converted" ? it.plan_category : null, batch: it.batch, updated_at: it.updated_at,
    };
  }

  /** 受保护条目不返回明细，只给数量——分页按可展示数计算 */
  protectedCount(task: OrganizeTaskRow, decisions: string[]): number {
    return decisions.includes("skip") ? task.protected_count : 0;
  }
  folderChanges(task: OrganizeTaskRow): OrganizeTaskFolderView[] {
    const plan = this.readPlan(task);
    if (!plan) return [];
    const items = this.store.organizeTaskItemsByDecision(task.id, []);
    const root = this.store.getFolder(plan.rootFolderId);
    const planned = new Map<string, number>();
    const actual = new Map<string, number>();
    for (const it of items) {
      if (!it.plan_target_key) continue;
      if (it.decision === "remaining" || it.decision === "moved") {
        planned.set(it.plan_target_key, (planned.get(it.plan_target_key) ?? 0) + 1);
      }
      if (it.decision === "moved") actual.set(it.plan_target_key, (actual.get(it.plan_target_key) ?? 0) + 1);
    }
    const terminal = !ACTIVE_STATUSES.includes(task.status);
    const rootName = root?.name ?? task.folder_name;
    // D94：落点可能在来源目录之外（复用其他目录 / 新建顶级目录）——未创建的节点按规划推算完整路径
    const plannedPath = (n: FolderNode): string => {
      if (!n.parentKey) return n.placement === "top" ? n.name : [rootName, n.name].join(" / ");
      const parent = plan.folderNodes.find((x) => x.key === n.parentKey);
      return parent ? `${plannedPath(parent)} / ${n.name}` : n.name;
    };
    const subtree = new Set(this.store.folderSubtreeIds(plan.rootFolderId));
    const outsideOf = (n: FolderNode): boolean =>
      n.id ? !subtree.has(n.id) : n.placement === "top" || (n.parentKey ? outsideOf(plan.folderNodes.find((x) => x.key === n.parentKey)!) : false);
    return plan.folderNodes.map((n) => ({
      key: n.key,
      path: n.id && root ? relPathOf(this.store, n.id, root.id) : plannedPath(n),
      state: n.reuseId ? "reused" : n.id ? "created" : terminal ? "unapplied" : "planned",
      folder_id: n.id,
      planned_count: planned.get(n.key) ?? 0,
      actual_count: actual.get(n.key) ?? 0,
      outside: outsideOf(n),
    }));
  }

  categoryChanges(task: OrganizeTaskRow): OrganizeTaskCategoryView[] {
    const plan = this.readPlan(task);
    if (!plan) return [];
    const items = this.store.organizeTaskItemsByDecision(task.id, []);
    const planned = new Map<string, number>();
    const actual = new Map<string, number>();
    for (const it of items) {
      if (!it.plan_category) continue;
      if (it.decision === "remaining" || it.decision === "converted") {
        planned.set(it.plan_category, (planned.get(it.plan_category) ?? 0) + 1);
      }
      if (it.decision === "converted") actual.set(it.plan_category, (actual.get(it.plan_category) ?? 0) + 1);
    }
    const terminal = !ACTIVE_STATUSES.includes(task.status);
    return plan.categories.map((c) => ({
      path: c.path,
      state: (actual.get(c.path) ?? 0) > 0 ? (c.existedBefore ? "reused" : "new") : terminal ? "unapplied" : "planned",
      planned_count: planned.get(c.path) ?? 0,
      actual_count: actual.get(c.path) ?? 0,
    }));
  }

  // ==================== 调度 ====================

  private emit(taskId: string): void {
    this.onChange?.(taskId);
  }

  private kickRun(uid: string, taskId: string): void {
    this.enqueue(uid, taskId, "run", () => this.runTask(taskId));
  }

  private kickUndo(uid: string, taskId: string, onlyVersionId: string | null): void {
    this.enqueue(uid, taskId, onlyVersionId ? `undo:${onlyVersionId}` : "undo", () => this.runUndo(taskId, onlyVersionId));
  }

  private enqueue(uid: string, taskId: string, kind: string, job: () => Promise<void>): void {
    const slot = `${uid}:${taskId}:${kind}`;
    // 同类任务不重复排队：运行中的 worker 会在下一个检查点看到停止/撤销请求
    if (this.scheduled.has(slot)) return;
    this.scheduled.add(slot);
    const chainKey = `${uid}:${taskId}`;
    const prev = this.chains.get(chainKey) ?? Promise.resolve();
    this.inFlight += 1;
    const next = prev.then(() =>
      runAsUser(uid, async () => {
        try {
          await job();
        } catch (err) {
          console.error(`[organize-task] ${kind} failed:`, String(err).slice(0, 200));
        } finally {
          this.scheduled.delete(slot);
          this.inFlight -= 1;
          if (this.inFlight === 0) for (const wake of this.idleWaiters.splice(0)) wake();
        }
      }),
    );
    const tracked = next
      .catch(() => undefined)
      .then(() => {
        if (this.chains.get(chainKey) === tracked) this.chains.delete(chainKey);
      });
    this.chains.set(chainKey, tracked);
  }

  // ==================== 运行 ====================

  private async runTask(taskId: string): Promise<void> {
    let task = this.store.getOrganizeTask(taskId);
    if (!task || !ACTIVE_STATUSES.includes(task.status)) return;
    // 租约：进行中且心跳新鲜的任务属于别的 worker，不抢占
    if (
      task.status === "running" && task.lease && !Number.isNaN(Date.parse(task.lease_at ?? "")) &&
      Date.now() - Date.parse(task.lease_at!) < LEASE_TTL_MS
    ) {
      return;
    }
    const lease = newId();
    this.store.bumpOrganizeTask(taskId, {
      lease, lease_at: now(), started_at: task.started_at ?? now(), phase: "plan", phase_note: null, error: null,
      status: task.status === "stopping" ? "stopping" : "running",
    });
    this.emit(taskId);
    try {
      task = this.store.getOrganizeTask(taskId)!;
      if (task.status === "stopping") {
        this.finishStopped(taskId);
        return;
      }
      await this.planPhase(task, lease);
      this.checkpoint(taskId, lease);
      task = this.store.getOrganizeTask(taskId)!;
      if (task.status === "stopping") {
        this.finishStopped(taskId);
        return;
      }
      await this.commitPhase(taskId, lease);
      this.finish(taskId);
    } catch (err) {
      const current = this.store.getOrganizeTask(taskId);
      // 已被更新的 worker 接管：旧 worker 无权再写状态
      if (!current || current.lease !== lease) return;
      if (err instanceof LeaseLost) return;
      if (err instanceof StopSignal) {
        this.finishStopped(taskId);
        return;
      }
      console.error("[organize-task] task failed:", String(err).slice(0, 200));
      this.store.bumpOrganizeTask(taskId, {
        status: "failed", phase: "done", phase_note: null,
        error: err instanceof PlanError ? err.message : `task_failed:${String(err).slice(0, 160)}`,
        finished_at: now(), lease: null, lease_at: null,
      });
      this.refreshCounters(taskId);
      this.emit(taskId);
    }
  }

  /** 规划阶段：只规划尚无判断的条目（继续剩余时沿用已持久化的判断） */
  private async planPhase(task: OrganizeTaskRow, lease: string): Promise<void> {
    const taskId = task.id;
    const pending = this.store.organizeTaskItemsByDecision(taskId, ["remaining"]);
    const unplanned = pending.filter((it) => !it.plan_decision);
    if (unplanned.length === 0) return;
    const llm = this.llmFor("organize") ?? this.llmFor("summarize");
    const host: PlanHost = {
      store: this.store,
      callJson: <T>(messages: ChatMessage[]) => this.callJson<T>(llm!, messages),
      checkpoint: async () => {
        await sleep(0);
        this.checkpoint(taskId, lease);
      },
      note: (text) => {
        this.store.updateOrganizeTask(taskId, { phase_note: text });
        this.emit(taskId);
      },
      privacyAllowed: (bm, action) => this.pipeline.serverDecide(action, bm.url_raw, { isPrivateBookmark: bm.is_private === 1 }).allowed,
      crawl: (bookmarkId) => this.crawl(bookmarkId),
    };
    let outcome: PlanOutcome;
    let mode: "ai" | "rule_only";
    if (llm) {
      mode = "ai";
      outcome = await planWithAi(host, task, unplanned);
    } else {
      mode = "rule_only";
      outcome = planRuleOnly(host, task, unplanned);
    }
    this.checkpoint(taskId, lease);
    this.persistPlan(task, outcome, mode);
  }

  private persistPlan(task: OrganizeTaskRow, outcome: PlanOutcome, mode: "ai" | "rule_only"): void {
    const taskId = task.id;
    const byBookmark = new Map(outcome.items.map((p) => [p.bookmarkId, p]));
    // 规划落库前重验：等待期间被修改/删除/转为受保护的条目不沿用旧判断，按跳过收尾
    const fresh: ItemPlan[] = [];
    for (const it of this.store.organizeTaskItemsByDecision(taskId, ["remaining"])) {
      const p = byBookmark.get(it.bookmark_id);
      if (!p) continue;
      const bm = this.store.getBookmark(it.bookmark_id);
      const stale = bm ? this.recheck(bm, it) : "deleted_during_task";
      fresh.push(
        stale && p.decision !== "skip"
          ? { ...p, decision: "skip", reason: stale, retryable: 0, kind: null, targetKey: null, category: null, materialType: null }
          : p,
      );
    }
    const db = this.store.db;
    db.exec("SAVEPOINT mf_organize_task_plan");
    try {
      const ts = now();
      for (const p of fresh) {
        this.store.updateOrganizeTaskItem(p.itemId, {
          plan_decision: p.decision, plan_target_key: p.targetKey, plan_category: p.category,
          plan_material_type: p.materialType, plan_reason: p.reason.slice(0, 160), retryable: p.retryable,
          kind: p.kind, material_type: p.materialType, evidence_ref: p.decision === "convert" ? p.evidenceRef : null, updated_at: ts,
        });
      }
      const prior = this.readPlan(task);
      const plan: TaskPlan = {
        ...outcome.plan,
        // 继续剩余：保留此前运行已创建/复用的目录节点（key→真实 ID 映射与创建回执）
        folderNodes: [
          ...(outcome.plan.folderNodes ?? []),
          ...(prior?.folderNodes ?? []).filter((n) => !outcome.plan.folderNodes.some((x) => x.key === n.key)),
        ],
        categories: [
          ...outcome.plan.categories,
          ...(prior?.categories ?? []).filter((c) => !outcome.plan.categories.some((x) => x.path === c.path)),
        ],
      };
      this.store.bumpOrganizeTask(taskId, {
        mode, plan_json: JSON.stringify(plan), planned_new_folders: plan.folderNodes.filter((n) => !n.reuseId).length,
        planned_categories: plan.categories.length, phase_note: null,
      }, false);
      db.exec("RELEASE mf_organize_task_plan");
    } catch (err) {
      db.exec("ROLLBACK TO mf_organize_task_plan");
      db.exec("RELEASE mf_organize_task_plan");
      throw err;
    }
    this.emit(taskId);
  }

  /** 提交阶段：按批短事务落库，批次之间让出事件循环（停止/撤销请求可落地） */
  private async commitPhase(taskId: string, lease: string): Promise<void> {
    let batchNo = this.store.taskVersions(taskId).length;
    for (;;) {
      await sleep(0);
      this.checkpoint(taskId, lease);
      const pending = this.store.organizeTaskItemsByDecision(taskId, ["remaining"]);
      if (pending.length === 0) return;
      batchNo += 1;
      if (this.commitBatch(taskId, lease, pending.slice(0, COMMIT_BATCH), batchNo)) throw new StopSignal("stop_requested");
      this.emit(taskId);
    }
  }

  /**
   * 一批 = 一个短事务。事务内核对停止标志/撤销/租约；逐条重查 await 前基线；
   * 以真实写入回执计数；目录按需创建（父先子后）；版本、任务项与计数器同事务。
   * 返回 true = 停止/撤销屏障生效（本批未提交，调用方按停止收尾）。
   */
  private commitBatch(taskId: string, lease: string, batch: OrganizeTaskItemRow[], batchNo: number): boolean {
    const db = this.store.db;
    db.exec("BEGIN");
    try {
      const guard = db.prepare("SELECT status, lease, undo_status FROM organize_task WHERE id = ?").get(taskId) as
        | { status: string; lease: string | null; undo_status: string }
        | undefined;
      if (!guard || guard.lease !== lease) throw new LeaseLost("lease_lost");
      if (guard.undo_status !== "none" || guard.status === "stopping") {
        db.exec("ROLLBACK");
        return true;
      }
      const task = this.store.getOrganizeTask(taskId)!;
      const plan = this.readPlan(task) ?? { version: 1, rootFolderId: task.folder_id, folderNodes: [], categories: [], topics: [] };
      const root = this.store.getFolder(plan.rootFolderId);
      if (!root) {
        // 根目录已被删除：范围失效，停止剩余（未处理项保留 remaining，不按同名复建）
        db.exec("ROLLBACK");
        this.store.bumpOrganizeTask(taskId, { status: "stopping" }, false);
        return true;
      }
      const versionActions: unknown[] = [];
      const converted: string[] = [];
      const appliedIds: string[] = [];
      const adoptionNames = new Set<string>();
      const ts = now();
      const finalize = (
        it: OrganizeTaskItemRow,
        decision: string,
        reason: string | null,
        extra: Record<string, unknown> = {},
      ): void => {
        this.store.updateOrganizeTaskItem(it.id, {
          decision, reason, batch: batchNo, updated_at: ts,
          kind: decision === "converted" ? "material" : decision === "moved" || decision === "keep" ? "bookmark" : null,
          from_path:
            decision === "moved" || decision === "converted" ? relPathOf(this.store, it.base_folder_id, root.id) : null,
          ...extra,
        });
        if (decision === "moved" || decision === "converted") appliedIds.push(it.id);
      };
      for (const it of batch) {
        const planned = it.plan_decision;
        if (!planned || planned === "fail") {
          finalize(it, "fail", it.plan_reason ?? "not_planned", { retryable: it.retryable });
          continue;
        }
        if (planned === "keep" || planned === "skip") {
          finalize(it, planned, it.plan_reason);
          continue;
        }
        const bm = this.store.getBookmark(it.bookmark_id);
        const stale = bm ? this.recheck(bm, it) : "deleted_during_task";
        if (stale || !bm) {
          finalize(it, "skip", stale ?? "deleted_during_task");
          continue;
        }
        if (planned === "move") {
          const target = this.ensureNode(plan, it.plan_target_key, versionActions);
          if (!target) {
            finalize(it, "skip", "target_unavailable");
            continue;
          }
          if (bm.folder_id === target.id) {
            finalize(it, "keep", "already_placed");
            continue;
          }
          const before = this.store.moveBookmark(it.bookmark_id, target.id);
          if (!before) {
            // 仓储层拒绝写入（生命周期不符/影响行数为 0）：不计移动成功
            finalize(it, "skip", "not_moved");
            continue;
          }
          // 显式整理即用户意图：退出旧收纳盒自动归位/自检/转换候选资格
          this.store.clearInboxState(it.bookmark_id);
          enqueueMirrorMoves(this.store, it.bookmark_id, target.id);
          versionActions.push({
            type: "move", bookmarkId: it.bookmark_id, fromFolderId: before.folder_id, toFolderId: target.id,
            revisionAfter: this.store.getBookmark(it.bookmark_id)?.content_revision ?? 1,
          });
          adoptionNames.add(target.name);
          finalize(it, "moved", it.plan_reason, { to_path: relPathOf(this.store, target.id, root.id) });
          continue;
        }
        if (planned === "convert") {
          const cls = classifyMaterialKind(bm.url_canonical);
          const l2 = this.store.getCache(it.bookmark_id)?.l2_text;
          const r = this.store.convertToMaterialFromTask(it.bookmark_id, {
            type: it.plan_material_type ?? "article",
            signals: cls?.signals ?? [],
            meta: { textLen: typeof l2 === "string" ? l2.length : 0 },
            category: (it.plan_category ?? "").split("/"),
          });
          if ("error" in r) {
            if (r.error === "material_dismissed") finalize(it, "skip", "material_dismissed");
            else if (r.error === "category_invalid") finalize(it, "fail", "category_invalid", { retryable: 1 });
            else finalize(it, "skip", "converted_elsewhere");
            continue;
          }
          versionActions.push({
            type: "convertToMaterial", bookmarkId: it.bookmark_id, fromFolderId: r.fromFolderId,
            revisionAfter: this.store.getBookmark(it.bookmark_id)?.content_revision,
            materializedGeneration: this.store.getBookmark(it.bookmark_id)?.materialized_generation,
            materialId: r.materialId, materialCreated: r.materialCreated, categoryBefore: r.categoryBefore,
            categorySourceBefore: r.categorySourceBefore, categoryRevisionAfter: r.categoryRevisionAfter,
          });
          converted.push(it.bookmark_id);
          finalize(it, "converted", it.plan_reason, {
            to_path: `资料 / ${(it.plan_category ?? "").split("/").join(" / ")}`,
            category_before: r.categoryBefore, material_before: r.materialCreated ? "absent" : "active",
          });
        }
      }
      if (versionActions.length > 0) {
        const versionId = this.store.saveVersion(null, versionActions, { label: "organize_task", taskId, taskBatch: batchNo });
        for (const id of converted) this.store.setMaterialVersion(id, versionId);
        for (const id of appliedIds) {
          this.store.db.prepare("UPDATE organize_task_item SET version_id = ? WHERE id = ?").run(versionId, id);
        }
        for (const name of adoptionNames) this.store.recordCategoryAdoption(name);
      }
      this.store.updateOrganizeTask(taskId, { plan_json: JSON.stringify(plan), lease_at: now() });
      this.refreshCounters(taskId);
      db.exec("COMMIT");
      return false;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 新建目录按需创建（父先子后，同事务）；已删除的本任务目录不按同名复建。
   * D94：一级新建节点按 placement 落点——inside 挂被整理目录之下；top 建为顶级目录并继承被整理目录所在的浏览器根。
   */
  private ensureNode(plan: TaskPlan, key: string | null, versionActions: unknown[]): FolderRow | undefined {
    if (!key) return undefined;
    const node = plan.folderNodes.find((n) => n.key === key);
    if (!node) return undefined;
    if (node.id) return this.store.getFolder(node.id);
    const source = this.store.getFolder(plan.rootFolderId);
    if (!source) return undefined;
    const browserRootOf = (f: FolderRow): "bar" | "other" => (f.root === "other" ? "other" : "bar");
    const top = !node.parentKey && node.placement === "top";
    const parent = node.parentKey ? this.ensureNode(plan, node.parentKey, versionActions) : top ? undefined : source;
    if (!top && !parent) return undefined;
    const parentId = top || !parent ? null : parent.id;
    const browserRoot = top || !parent ? browserRootOf(source) : browserRootOf(parent);
    if (parentId && this.store.folderDepth(parentId) + 1 > MAX_DEPTH) return undefined;
    // 等待期间用户已建出同父同名目录（顶级目录则限同一浏览器根内）：复用它，不建重复副本
    const existing = parentId
      ? this.store.findFolderUnder(node.name, parentId, browserRoot)
      : this.store.findFolderUnder(node.name, null, browserRoot);
    if (existing) {
      node.id = existing.id;
      node.reuseId = existing.id;
      return existing;
    }
    const created = this.store.createFolder(node.name, parentId, "ai_created", false, browserRoot);
    node.id = created.id;
    versionActions.push({
      type: "createFolder", folderId: created.id, name: created.name,
      createdParentId: created.parent_id ?? null, createdRoot: created.root === "other" ? "other" : "bar",
    });
    return created;
  }

  /** 提交前重查：实体/生命周期/隐私/修订/归属任一不符即跳过（用户优先，旧计划不覆盖新状态） */
  private recheck(bm: BookmarkRow, it: OrganizeTaskItemRow): string | null {
    if (bm.status === "archived" || bm.archived_into) return "archived_during_task";
    if (bm.materialized_at) return "converted_elsewhere";
    if (
      bm.is_private === 1 || isSensitiveHost(bm.url_canonical) ||
      isPrivacyDomain(bm.url_raw, { patterns: this.store.privacyPatterns() }) ||
      this.store.privacyRevision() !== it.privacy_revision
    ) {
      return "privacy_changed";
    }
    if ((bm.content_revision ?? 1) !== it.base_revision) return "modified_during_task";
    if (bm.folder_id !== it.base_folder_id) return "moved_during_task";
    return null;
  }

  private finish(taskId: string): void {
    const task = this.store.getOrganizeTask(taskId)!;
    const c = this.store.organizeTaskCounters(taskId);
    const status: OrganizeTaskStatus =
      c.failed > 0 || task.mode === "rule_only" || c.insufficient > 0 ? "completed_with_issues" : "completed";
    this.store.bumpOrganizeTask(taskId, {
      status, phase: "done", phase_note: null, finished_at: now(), lease: null, lease_at: null,
      continue_expires_at: new Date(Date.now() + CONTINUE_DAYS * 86400_000).toISOString(),
    });
    this.refreshCounters(taskId);
    this.emit(taskId);
    const done = this.store.getOrganizeTask(taskId)!;
    if (done.moved + done.converted > 0) this.onApplied?.(done);
  }

  private finishStopped(taskId: string): void {
    const task = this.store.getOrganizeTask(taskId);
    if (!task) return;
    // 撤销已请求时保持 stopping 语义由撤销接管；状态落 stopped 供界面呈现
    this.store.bumpOrganizeTask(taskId, {
      status: "stopped", phase: "done", phase_note: null, finished_at: now(), lease: null, lease_at: null,
      continue_expires_at: new Date(Date.now() + CONTINUE_DAYS * 86400_000).toISOString(),
    });
    this.refreshCounters(taskId);
    this.emit(taskId);
  }

  /** 计数器一律由明细行重算后写回任务行（展示与导出口径的唯一来源） */
  private refreshCounters(taskId: string): void {
    const task = this.store.getOrganizeTask(taskId);
    if (!task) return;
    const c = this.store.organizeTaskCounters(taskId);
    const plan = this.readPlan(task);
    const counts = this.store.organizeTaskTargetCounts(taskId);
    this.store.updateOrganizeTask(taskId, {
      moved: c.moved, converted: c.converted, new_materials: c.newMaterials, reused_materials: c.reusedMaterials,
      unchanged: c.unchanged, skipped: c.skipped, failed: c.failed,
      planned_new_folders: (plan?.folderNodes ?? []).filter((n) => !n.reuseId).length,
      created_folders: (plan?.folderNodes ?? []).filter((n) => n.id && !n.reuseId).length,
      reused_folders: (plan?.folderNodes ?? []).filter((n) => n.reuseId && (counts.folders.get(n.key) ?? 0) > 0).length,
      planned_categories: plan?.categories.length ?? 0,
      new_categories: (plan?.categories ?? []).filter((x) => !x.existedBefore && counts.categories.has(x.path)).length,
      reused_categories: (plan?.categories ?? []).filter((x) => x.existedBefore && counts.categories.has(x.path)).length,
    });
  }

  // ==================== 撤销 ====================

  /** 撤销执行（与运行同链串行）：到此处运行必已收尾；按批次逆序复用 rollback，真实恢复与保留分开累计 */
  private async runUndo(taskId: string, onlyVersionId: string | null): Promise<void> {
    const initial = this.store.getOrganizeTask(taskId);
    if (!initial || (initial.undo_status !== "pending" && initial.undo_status !== "running")) return;
    this.store.bumpOrganizeTask(taskId, { undo_status: "running" }, false);
    this.emit(taskId);
    // 累计口径：中断续跑 / 单批追加撤销都在既有回执上累加，不清零历史
    let restored = initial.undo_restored;
    let kept = initial.undo_kept;
    let categories = initial.undo_categories;
    let folders = initial.undo_folders;
    try {
      const versions = this.store.taskVersions(taskId).filter((v) => !onlyVersionId || v.id === onlyVersionId);
      for (let i = versions.length - 1; i >= 0; i--) {
        await sleep(0);
        const v = versions[i]!;
        if (v.reverted) continue; // 已被撤销的批次不重复逆放
        const r = this.organize.rollback(v.id);
        restored += r.restoredBookmarks;
        kept += r.skipped.filter((s) => s.bookmarkId).length;
        categories += r.categoriesRestored;
        folders += r.removedFolders;
        this.store.bumpOrganizeTask(taskId, {
          undo_restored: restored, undo_kept: kept, undo_categories: categories, undo_folders: folders,
          undo_cursor: this.store.taskVersions(taskId).filter((x) => x.reverted).length,
        }, false);
        this.emit(taskId);
      }
      // 仍有未撤销批次（单批撤销）或存在因后续改动而保留的条目 → partial；
      // 无论哪种，旧任务此后都不能再沿原方案继续
      const remainingVersions = this.store.taskVersions(taskId).filter((v) => !v.reverted).length;
      this.store.bumpOrganizeTask(taskId, {
        undo_status: kept > 0 || remainingVersions > 0 ? "partial" : "completed",
      }, false);
    } catch (err) {
      console.error("[organize-task] undo failed:", String(err).slice(0, 200));
      this.store.bumpOrganizeTask(taskId, { undo_status: "failed" }, false);
    }
    this.refreshCounters(taskId);
    this.emit(taskId);
  }

  // ==================== 模型 / 取证 / 守卫 ====================

  private checkpoint(taskId: string, lease: string): void {
    const task = this.store.getOrganizeTask(taskId);
    if (!task || task.lease !== lease) throw new LeaseLost("lease_lost");
    if (task.undo_status !== "none") throw new StopSignal("undo_requested");
    if (task.status === "stopping") throw new StopSignal("stop_requested");
    this.store.updateOrganizeTask(taskId, { lease_at: now() });
  }

  /** 一次受限重试（暂时故障/限流）；供应商审核拒收不重试——由规划层按批记为失败 */
  private async callJson<T>(llm: LlmClient, messages: ChatMessage[]): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.withSlot(this.llmQueue, "llm", () => llm.chatJson<T>(messages));
      } catch (err) {
        lastErr = err;
        if (isLlmContentModeration(err)) throw err;
        if (attempt === 0) await sleep(600);
      }
    }
    throw lastErr;
  }

  private crawl(bookmarkId: string): Promise<{ ok: boolean; reason?: string; detail?: string; text?: string }> {
    return this.withSlot(this.crawlQueue, "crawl", async () => {
      // 取证只补正文：不物化、不生成摘要、不补写描述（描述会递增修订，破坏 await 前基线）
      const r = await this.pipeline.crawlOne(bookmarkId, { skipMaterialize: true, skipSummary: true, skipMeta: true });
      return r;
    });
  }

  /** 并发闸（≤1 在途）：回调在调用方的用户上下文内执行，跨账号公平排队 */
  private withSlot<T>(queue: Promise<unknown>, kind: "llm" | "crawl", fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    const settled = run.catch(() => undefined);
    if (kind === "llm") this.llmQueue = settled;
    else this.crawlQueue = settled;
    return run;
  }

  private readPlan(task: OrganizeTaskRow): TaskPlan | null {
    if (!task.plan_json) return null;
    try {
      const plan = JSON.parse(task.plan_json) as TaskPlan;
      return Array.isArray(plan.folderNodes) ? plan : null;
    } catch {
      return null;
    }
  }
}
