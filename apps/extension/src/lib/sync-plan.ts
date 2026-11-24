/**
 * D81 复核整改（docs/同步整改复核清单-D81.md）：同步出站操作契约——纯函数层。
 *
 * R02/R05/R06/R07 共用一套操作状态契约，先统一设计再实施：
 *
 *  1. 出站队列（outbox）：每个「浏览器 → 库」意图是一条持久化操作，opId 终身不变。
 *     发送前落盘；成功回执（ok/bound/noop）或终态结果（conflict / 终态 skipped）才出队；
 *     failed 与可重试 skipped 保留并复用原 opId 重发——服务端已提交但响应丢失时，
 *     重放命中原回执，不重复副作用、不覆盖后续修改（R07）。
 *  2. 已确认基线 vs 扫描观察值：基线 leaves 只在成功回执后推进（R02/R05）；目录的「库态」
 *     每轮从 /folders 派生（含 rev），不存在性基线仍按 D75 登记 walk 所见——延后提交不丢失
 *     删除检测能力。同一实体至多一条待处理操作：前一条未决时不再生成，决出后下一轮 diff
 *     承接更新后的意图（串行，不会互相自冲突）。
 *  3. 修订号单调：操作生成时绑定 baseRevision（不随 pull 刷新）；回执修订号不低于已知值
 *     才推进已确认基线——重放的旧回执不得回退已 pull 的更新状态（R05）。
 *  4. 删除计划与保险丝：tick 与 rebuild 共用同一计划与判定；挂起时持久保留操作与范围，
 *     树删及其覆盖的叶子是一个确认单元，不得经另一条路径执行（R01）。
 *
 * 本模块不依赖浏览器 API，全部是数据变换——状态机验收靠单测逐态断言，
 * 不以「接口单步测试通过」替代连续编辑、响应丢失与恢复的场景验证。
 */

import { canonicalizeUrl } from "@mf/shared";

export type Mutation = Record<string, unknown>;
export const AMBIGUOUS_FOLDER_COPIES = "duplicate_url_folder_identity_ambiguous";

export interface SnapLeaf {
  u: string;
  t: string;
  p: string;
  /** 已确认的库目录身份；浏览器 parent id 未变也可能发生目录身份分离 */
  f?: string;
}
export interface SnapFolder {
  t: string;
  p: string;
}
export interface Snapshot {
  leaves: Record<string, SnapLeaf>;
  folders: Record<string, SnapFolder>;
}

export interface LibFolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  root?: string;
  rev?: number;
  is_system_inbox?: number;
}
export interface FolderIndex {
  pathById: Map<string, string[]>;
  idByPath: Map<string, string>;
  rootById: Map<string, string>;
  rows: Map<string, LibFolderRow>;
  inboxFolderId: string | null;
}

/** 浏览器树扫描结果（观察值，不是已确认基线） */
export interface Walked {
  snapshot: Snapshot;
  leafList: Array<{ id: string; path: string[]; root: string }>;
  /** 目录前序（父先于子）——出站操作按此顺序生成，父目录操作总在子目录之前 */
  folderOrder: string[];
  folderIdByPath: Map<string, string>;
  rootByFolderId: Map<string, string>;
  /** 完整 getTree 的目录 ID 全集（含收纳盒/豁免子树），仅用于确证历史身份节点已消失 */
  liveBrowserFolderIds?: string[];
}

/** 成功 / 冲突回执携带的库侧实体（与服务端 sync-apply 的 BookmarkReceipt / FolderReceipt 对齐） */
export interface BookmarkReceipt {
  id: string;
  title: string;
  url_raw: string;
  folder_id: string;
  content_revision: number;
}
export interface FolderReceipt {
  id: string;
  name: string;
  parent_id: string | null;
  root: string;
  rev: number;
}
export interface ApplyResult {
  kind: string;
  browserId?: string;
  appBookmarkId?: string;
  appFolderId?: string;
  status: string;
  error?: string;
  current?: unknown;
  entity?: BookmarkReceipt | FolderReceipt;
}

/** 出站操作（storage.local 持久化；opId 自创建起不变） */
export interface OutOp {
  opId: string;
  kind: string;
  /** 逻辑实体键："bm:<browserId>" | "fd:<browserFolderId>"——同实体至多一条待处理操作 */
  entity: string;
  mut: Mutation;
  /** 操作生成时绑定的库侧修订（R05：固定绑定，不随 pull 刷新） */
  baseRevision?: number;
  /** 依赖的前序操作 opId（先目录、后书签；R06/R07：随操作一并持久化） */
  deps?: string[];
  /** 目录身份修复及其依赖操作：未决期间走 recover 保护本地子树 */
  identityRepair?: boolean;
  createdAt: number;
  attempts: number;
  lastError?: string;
}
/** 终态拒绝记录：同指纹的操作不再无限重试，直到该实体状态再次变化或已收敛 */
export interface RejectedRecord {
  fp: string;
  kind: string;
  error: string;
  at: number;
}

export interface DeleteLeaf {
  browserId: string;
  appId: string;
  url: string;
}
export interface DeleteFolder {
  browserFolderId: string;
  appFolderId: string;
  name: string;
}
/** 浏览器侧删除计划（保险丝挂起时持久保留的操作与范围） */
export interface BrowserDeletePlan {
  leaves: DeleteLeaf[];
  folders: DeleteFolder[];
  at: number;
}
export const emptyBrowserDeletePlan = (): BrowserDeletePlan => ({ leaves: [], folders: [], at: 0 });

// ---------- 基础键与判定 ----------
export const bmKey = (id: string): string => `bm:${id}`;
export const fdKey = (id: string): string => `fd:${id}`;
/** 浏览器根节点 id（0=总根 / 1=书签栏 / 2=其他书签）——不是用户目录 */
export const isRootId = (id: string | undefined): boolean => id === "0" || id === "1" || id === "2";
export const rootIdOf = (root: string | undefined): string => (root === "other" ? "2" : "1");
export const rootOf = (v: unknown): string => (v === "other" ? "other" : "bar");

/** skipped 错误码分类：仅父目录未知可由后续操作解除；其余重试不会成功（终态） */
export const RETRYABLE_SKIP_ERRORS: ReadonlySet<string> = new Set(["parent_unknown", "folder_unknown"]);
export const isTerminalSkip = (error: string | undefined): boolean => !RETRYABLE_SKIP_ERRORS.has(error ?? "");

const GUARD_ABS = 30;
const GUARD_RATIO = 0.25;
const FOLDER_GUARD_ABS = 3;
const FOLDER_GUARD_RATIO = 0.5;

/**
 * 删除保险丝（tick 与 rebuild 共用同一判定，R01）：
 *  - 书签级：叶子删除数 > 30 且 > 已知条目 25%；
 *  - 目录级：待树删的顶层目录数 > 3，且被删目录总数 > 已知目录 50%。
 * 任一侧触发 → 整个浏览器侧删除计划（叶子 + 目录树）作为一个确认单元挂起。
 */
export function evaluateDeleteGuard(
  plan: { leaves: unknown[]; folders: unknown[] },
  allDeletedFolderCount: number,
  knownLeaves: number,
  knownFolders: number,
): { bookmark: boolean; folder: boolean; any: boolean } {
  const bookmark = plan.leaves.length > GUARD_ABS && plan.leaves.length > Math.max(1, knownLeaves) * GUARD_RATIO;
  const folder = plan.folders.length > FOLDER_GUARD_ABS && allDeletedFolderCount > knownFolders * FOLDER_GUARD_RATIO;
  return { bookmark, folder, any: bookmark || folder };
}

// ---------- 通用工具 ----------
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : String(v));

/** 稳定指纹：键序无关，用于识别「同一实体上被终态拒绝过的同一操作」 */
export function fingerprint(mut: Mutation): string {
  const normalize = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, normalize(x)]))
        : v;
  const { opId: _o, baseRevision: _b, ...rest } = mut;
  void _o;
  void _b;
  return JSON.stringify(normalize(rest));
}

export function reverseMap(m: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(m)) if (!out.has(v)) out.set(v, k);
  return out;
}

/** 沿 parent 链求目录的标题路径（基线或扫描所得的 folders 均可） */
export function folderPathOf(folderId: string, folders: Record<string, SnapFolder>): string[] {
  const out: string[] = [];
  let cur = folders[folderId];
  let id = folderId;
  const seen = new Set<string>();
  while (cur && !seen.has(id)) {
    seen.add(id);
    out.unshift(cur.t);
    id = cur.p;
    cur = folders[id];
  }
  return out;
}

/** 从存在性基线看，节点是否位于「已消失目录」之内（其删除由目录树删除覆盖，不单独出操作） */
export function insideDeletedFolder(id: string, existence: Snapshot, deletedFolderIds: Set<string>): string | null {
  let p = existence.leaves[id]?.p;
  const seen = new Set<string>();
  while (p && !isRootId(p) && !seen.has(p)) {
    if (deletedFolderIds.has(p)) return p;
    seen.add(p);
    p = existence.folders[p]?.p;
  }
  return null;
}

/** 存在性基线中被删目录的子树（含根本身） */
export function subtreeOf(rootFid: string, folders: Record<string, SnapFolder>): Set<string> {
  const sub = new Set<string>([rootFid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [fid, f] of Object.entries(folders)) {
      if (!sub.has(fid) && f.p !== undefined && sub.has(f.p)) {
        sub.add(fid);
        grew = true;
      }
    }
  }
  return sub;
}

/**
 * 初次认领只比较「父身份 + root + name」，且每个存活库目录至多认领一次。
 * 返回候选而不写 fMap：调用方必须等 folder.ensure 的逐条成功回执才确认身份。
 * 历史上已消失的 browser id 不占用候选，也不参与多对一冲突判定。
 */
export function claimFolderCandidates(fMap: Record<string, string>, walk: Walked, folders: FolderIndex): Record<string, string> {
  const claims: Record<string, string> = {};
  const claimed = new Set(walk.folderOrder.map((bid) => fMap[bid]).filter((id): id is string => Boolean(id)));
  const siblingKey = (parent: string | null, root: string, name: string): string => JSON.stringify([parent, rootOf(root), name]);
  const candidates = new Map<string, string[]>();
  // 库中同名兄弟也不能 last-wins；稳定按 id 取尚未认领的候选。
  for (const row of Array.from(folders.rows.values()).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (row.is_system_inbox === 1) continue;
    const parent = row.parent_id && !(isRootId(row.parent_id) && !folders.rows.has(row.parent_id)) ? row.parent_id : null;
    const k = siblingKey(parent, row.root ?? "bar", row.name);
    const bucket = candidates.get(k) ?? [];
    bucket.push(row.id);
    candidates.set(k, bucket);
  }
  for (const bid of walk.folderOrder) {
    if (fMap[bid]) continue;
    const cur = walk.snapshot.folders[bid];
    if (!cur) continue;
    const parent = isRootId(cur.p) ? null : fMap[cur.p] ?? claims[cur.p];
    if (parent === undefined) continue; // 未确认/未能认领的父，交给父 create 后的子 create
    const root = walk.rootByFolderId.get(bid) ?? "bar";
    const app = candidates.get(siblingKey(parent, root, cur.t))?.find((id) => !claimed.has(id));
    if (!app) continue;
    claims[bid] = app;
    claimed.add(app);
  }
  return claims;
}

/** 活多对一：按 browser id 确定保留者，其余显式分离；绝不按历史映射条数猜冲突。 */
export function folderIdentitySplits(fMap: Record<string, string>, walk: Walked): Map<string, string> {
  const keep = new Set<string>();
  const splits = new Map<string, string>();
  for (const bid of Object.keys(walk.snapshot.folders).sort()) {
    const app = fMap[bid];
    if (!app) continue;
    if (keep.has(app)) splits.set(bid, app);
    else keep.add(app);
  }
  return splits;
}

/** 待处理目录操作保护整个真实子树（不是同名 path 前缀），书签自身未决也受保护。 */
export function pendingProtection(walk: Snapshot, fMap: Record<string, string>, outbox: OutOp[]): { folders: Set<string>; leaves: Set<string>; apps: Set<string> } {
  const folders = new Set<string>();
  const leaves = new Set<string>();
  for (const op of outbox) {
    if (op.entity.startsWith("fd:")) for (const id of subtreeOf(op.entity.slice(3), walk.folders)) folders.add(id);
    if (op.entity.startsWith("bm:")) leaves.add(op.entity.slice(3));
  }
  for (const [bid, leaf] of Object.entries(walk.leaves)) if (folders.has(leaf.p)) leaves.add(bid);
  const apps = new Set<string>();
  for (const bid of folders) if (fMap[bid]) apps.add(fMap[bid]!);
  return { folders, leaves, apps };
}

/** 库按 canonical URL 唯一，跨分支浏览器副本不能自动证明一对一归属。 */
export function ambiguousBookmarkCopies(walk: Snapshot): Set<string> {
  const groups = new Map<string, string[]>();
  for (const [bid, leaf] of Object.entries(walk.leaves)) {
    const k = canonicalizeUrl(leaf.u)?.canonical ?? leaf.u;
    const group = groups.get(k) ?? [];
    group.push(bid);
    groups.set(k, group);
  }
  const copies = new Set<string>();
  for (const ids of groups.values()) {
    if (new Set(ids.map((id) => walk.leaves[id]!.p)).size > 1) for (const id of ids) copies.add(id);
  }
  return copies;
}

/** 实际依赖门控：同一批 HTTP 请求不能越过尚无成功回执的父操作。 */
export function readyOutboxOps(ops: OutOp[]): OutOp[] {
  const pending = new Set(ops.map((op) => op.opId));
  return orderForSend(ops).filter((op) => !(op.deps ?? []).some((dep) => pending.has(dep)));
}

// ---------- 删除计划 ----------
export function computeDeletedSets(existence: Snapshot, walk: Snapshot): { deletedFolderIds: Set<string>; topDeletedFolderIds: string[]; leafCandidates: string[] } {
  const deletedFolderIds = new Set<string>();
  for (const fid of Object.keys(existence.folders)) if (!(fid in walk.folders)) deletedFolderIds.add(fid);
  const topDeletedFolderIds: string[] = [];
  for (const fid of deletedFolderIds) {
    const parent = existence.folders[fid]?.p;
    if (parent !== undefined && deletedFolderIds.has(parent)) continue; // 子孙由顶层树删覆盖
    topDeletedFolderIds.push(fid);
  }
  const leafCandidates: string[] = [];
  for (const id of Object.keys(existence.leaves)) if (!(id in walk.leaves)) leafCandidates.push(id);
  return { deletedFolderIds, topDeletedFolderIds, leafCandidates };
}

/** 挂起计划合并（按 id 去重：挂起期间每轮 diff 重新检出同一批删除，不得重复累积） */
export function mergeBrowserDeletePlan(a: BrowserDeletePlan, b: BrowserDeletePlan, now: number): BrowserDeletePlan {
  const leafIds = new Set(a.leaves.map((l) => l.browserId));
  const folderIds = new Set(a.folders.map((f) => f.browserFolderId));
  return {
    leaves: [...a.leaves, ...b.leaves.filter((l) => !leafIds.has(l.browserId))],
    folders: [...a.folders, ...b.folders.filter((f) => !folderIds.has(f.browserFolderId))],
    at: now,
  };
}

/**
 * 确认范围复核（确认放行时调用）：挂起期间用户若已恢复某条目 / 目录（同一条目重新出现在浏览器，
 * 经身份映射指向同一库侧实体），不再删除其库侧对应——「按确认范围删除」且不误删已恢复项。
 */
export function validateBrowserDeletePlan(
  plan: BrowserDeletePlan,
  walk: Snapshot,
  bmMap: Record<string, string>,
  fMap: Record<string, string>,
): { plan: BrowserDeletePlan; droppedLeaves: string[]; droppedFolders: string[] } {
  const liveApps = new Set<string>();
  for (const [appId, bid] of Object.entries(bmMap)) if (walk.leaves[bid]) liveApps.add(appId);
  const liveFolderApps = new Set<string>();
  for (const [fid, appId] of Object.entries(fMap)) if (walk.folders[fid]) liveFolderApps.add(appId);
  const droppedLeaves = plan.leaves.filter((l) => liveApps.has(l.appId)).map((l) => l.browserId);
  const droppedFolders = plan.folders.filter((f) => liveFolderApps.has(f.appFolderId)).map((f) => f.browserFolderId);
  return {
    plan: {
      leaves: plan.leaves.filter((l) => !liveApps.has(l.appId)),
      folders: plan.folders.filter((f) => !liveFolderApps.has(f.appFolderId)),
      at: plan.at,
    },
    droppedLeaves,
    droppedFolders,
  };
}

// ---------- 操作计划（浏览器 diff → 出站操作） ----------
export interface PushPlanInput {
  walk: Walked;
  /** 已确认基线（上次成功回执 / pull 应用后的库态映射）；fresh rebuild 时为空 */
  confirmedLeaves: Record<string, SnapLeaf>;
  /** 存在性基线（D75：含 walk 登记过的目录；删除检测依据） */
  existence: Snapshot;
  folders: FolderIndex;
  fMap: Record<string, string>;
  bmMap: Record<string, string>;
  revisions: Record<string, number>;
  outbox: OutOp[];
  /** 库 → 浏览器事件尚未应用成功的实体（app id）：其浏览器状态是旧的，不得反向推送 */
  retryEntities: Set<string>;
  rejected: Record<string, RejectedRecord>;
  /** 已核验（节点确实消失）且有库侧对应的删除计划 */
  deletePlan: BrowserDeletePlan;
  /** 退出同步范围的节点（URL 变非 http） */
  unbinds: string[];
  now: number;
  newOpId: () => string;
}
export interface PushPlanResult {
  ops: OutOp[];
  /** 因实体已被删除而作废的待处理操作 opId（调用方从 outbox 移除） */
  superseded: string[];
}

const isRejected = (rejected: Record<string, RejectedRecord>, entity: string, kind: string, mut: Mutation): boolean => {
  const r = rejected[entity];
  return Boolean(r && r.kind === kind && r.fp === fingerprint(mut));
};

export function buildPushOps(inp: PushPlanInput): PushPlanResult {
  const ops: OutOp[] = [];
  const superseded: string[] = [];
  const byEntity = new Map<string, OutOp>();
  for (const o of inp.outbox) if (!byEntity.has(o.entity)) byEntity.set(o.entity, o);
  const { walk, folders } = inp;
  const appByBrowser = reverseMap(inp.bmMap);
  const splits = folderIdentitySplits(inp.fMap, walk);
  const claims = claimFolderCandidates(inp.fMap, walk, folders);
  const wasAmbiguous = Object.values(inp.rejected).some((r) => r.error === AMBIGUOUS_FOLDER_COPIES);
  const copies = splits.size > 0 || inp.outbox.some((op) => op.identityRepair) || wasAmbiguous ? ambiguousBookmarkCopies(walk.snapshot) : new Set<string>();
  for (const [entity, r] of Object.entries(inp.rejected)) if (r.error === AMBIGUOUS_FOLDER_COPIES && !copies.has(entity.slice(3))) delete inp.rejected[entity];
  for (const bid of copies) inp.rejected[bmKey(bid)] = { fp: fingerprint(walk.snapshot.leaves[bid]! as unknown as Mutation), kind: "bookmark.update", error: AMBIGUOUS_FOLDER_COPIES, at: inp.now };
  // 库目录 → 存活的确定保留者；不能把待分离者当成旧库目录的位置。
  const browserByAppFolder = new Map<string, string>();
  for (const bid of walk.folderOrder) if (inp.fMap[bid] && !splits.has(bid)) browserByAppFolder.set(inp.fMap[bid]!, bid);
  // 旧基线没有 f 时，在改绑前记录原库身份。该字段随出站队列一并持久化，失败/重启不吞归属变更。
  for (const [bid, prev] of Object.entries(inp.confirmedLeaves)) if (!prev.f && inp.fMap[prev.p]) prev.f = inp.fMap[prev.p];

  const folderOpFor = (browserFolderId: string | undefined): string[] => {
    if (!browserFolderId || isRootId(browserFolderId)) return [];
    const o = byEntity.get(fdKey(browserFolderId));
    return o ? [o.opId] : [];
  };
  const add = (kind: string, entity: string, mut: Mutation, extra: Partial<OutOp> = {}): void => {
    const op: OutOp = { opId: inp.newOpId(), kind, entity, mut, createdAt: inp.now, attempts: 0, ...extra };
    ops.push(op);
    if (!byEntity.has(entity)) byEntity.set(entity, op);
  };

  // ---- 删除：先判定哪些待处理操作因实体已删而作废 ----
  const { deletedFolderIds } = computeDeletedSets(inp.existence, walk.snapshot);
  const deletedEntities = new Set<string>([
    ...inp.deletePlan.leaves.map((l) => bmKey(l.browserId)),
    ...Array.from(deletedFolderIds, fdKey),
    ...inp.deletePlan.folders.map((f) => fdKey(f.browserFolderId)),
  ]);
  // 未确认创建没有 fMap，也可能尚未进入旧存在性基线；用户已删/移出范围时取消，不让重试复活。
  const gonePendingFolders = new Set(deletedFolderIds);
  for (const op of inp.outbox) {
    if ((op.kind === "folder.create" || op.kind === "folder.ensure") && op.entity.startsWith("fd:") && !walk.snapshot.folders[op.entity.slice(3)]) {
      deletedEntities.add(op.entity);
      gonePendingFolders.add(op.entity.slice(3));
    }
  }
  for (const op of inp.outbox) {
    if (op.entity.startsWith("bm:") && !walk.snapshot.leaves[op.entity.slice(3)] && gonePendingFolders.has(str(op.mut.browserFolderId))) deletedEntities.add(op.entity);
  }
  for (const bid of Object.keys(inp.existence.leaves)) {
    if (bid in walk.snapshot.leaves) continue;
    if (insideDeletedFolder(bid, inp.existence, deletedFolderIds)) deletedEntities.add(bmKey(bid)); // 由树删覆盖
  }
  const supersededSet = new Set<string>();
  for (const o of inp.outbox) {
    if (deletedEntities.has(o.entity) && o.kind !== "bookmark.delete" && o.kind !== "folder.deleteTree") {
      superseded.push(o.opId);
      supersededSet.add(o.opId);
    }
  }
  const pendingBlocks = (entity: string): boolean => {
    const o = byEntity.get(entity);
    return Boolean(o && !supersededSet.has(o.opId));
  };

  // ---- 目录：前序遍历（父先于子）。库态来自 /folders（含 rev），身份经 fMap ----
  for (const fid of walk.folderOrder) {
    const cur = walk.snapshot.folders[fid];
    if (!cur) continue;
    const entity = fdKey(fid);
    if (pendingBlocks(entity)) continue;
    const appId = inp.fMap[fid];
    if (appId && inp.retryEntities.has(appId)) continue;
    const separateFrom = splits.get(fid);
    const lib = appId && !separateFrom ? folders.rows.get(appId) : undefined;
    const root = walk.rootByFolderId.get(fid) ?? "bar";
    const parentOp = byEntity.get(fdKey(cur.p));
    const identityRepair = Boolean(separateFrom || parentOp?.identityRepair);
    if (!lib) {
      const fullPath = folderPathOf(fid, walk.snapshot.folders);
      const claim = !appId ? claims[fid] : undefined;
      if (claim) {
        add("folder.ensure", entity, { kind: "folder.ensure", appFolderId: claim, path: fullPath, root, browserFolderId: fid, ...(walk.liveBrowserFolderIds ? { liveBrowserFolderIds: walk.liveBrowserFolderIds } : {}) }, { deps: folderOpFor(cur.p) });
      } else {
        // 多对一只解除旧绑定匹配的那条身份：不能删/改名用户目录，也不能普通 create 后误收 bound。
        add("folder.create", entity, {
          kind: "folder.create",
          name: cur.t.slice(0, 200),
          browserFolderId: fid,
          parentBrowserFolderId: cur.p,
          parentPath: fullPath.slice(0, -1),
          root,
          ...(separateFrom ? { separateFromAppFolderId: separateFrom } : {}),
        }, { deps: folderOpFor(cur.p), ...(identityRepair ? { identityRepair: true } : {}) });
      }
      continue;
    }
    const libParentBrowser = lib.parent_id ? browserByAppFolder.get(lib.parent_id) : rootIdOf(lib.root);
    const needRename = cur.t !== lib.name;
    const needMove = (libParentBrowser !== undefined && cur.p !== libParentBrowser) || rootOf(lib.root) !== rootOf(root) || Boolean(parentOp?.identityRepair);
    if (!needRename && !needMove) {
      delete inp.rejected[entity]; // 已与库态一致 → 清除拒绝记录（实体状态已变化）
      continue;
    }
    // 改名与搬家合并为一条操作（一次提交、一个修订号）
    const mut: Mutation = { kind: "folder.move", appFolderId: appId, browserFolderId: fid, toBrowserFolderId: cur.p, toPath: folderPathOf(cur.p, walk.snapshot.folders), root };
    if (needRename) mut.name = cur.t.slice(0, 200);
    if (isRejected(inp.rejected, entity, "folder.move", mut)) continue;
    const rev = lib.rev;
    add("folder.move", entity, mut, { ...(rev !== undefined ? { baseRevision: rev } : {}), deps: folderOpFor(cur.p), ...(identityRepair ? { identityRepair: true } : {}) });
  }

  // ---- 书签 ----
  for (const l of walk.leafList) {
    if (copies.has(l.id)) continue;
    const leaf = walk.snapshot.leaves[l.id];
    if (!leaf) continue;
    const entity = bmKey(l.id);
    if (pendingBlocks(entity)) continue;
    const appId = appByBrowser.get(l.id);
    if (appId && inp.retryEntities.has(appId)) continue;
    const prev = inp.confirmedLeaves[l.id];
    const parentOp = byEntity.get(fdKey(leaf.p));
    const identityRepair = Boolean(parentOp?.identityRepair || (prev?.f && inp.fMap[leaf.p] && prev.f !== inp.fMap[leaf.p]));
    if (!prev || !appId) {
      // 新节点 / 身份丢失（新代际）→ create：按 canonical URL 绑定既有条目或新建
      add("bookmark.create", entity, {
        kind: "bookmark.create",
        browserId: l.id,
        url: leaf.u,
        title: (leaf.t || leaf.u).slice(0, 500),
        folderPath: l.path,
        folderRoot: l.root,
        browserFolderId: leaf.p,
      }, { deps: folderOpFor(leaf.p), ...(identityRepair ? { identityRepair: true } : {}) });
      continue;
    }
    const urlChanged = prev.u !== leaf.u;
    const titleChanged = prev.t !== leaf.t;
    const folderChanged = prev.p !== leaf.p || identityRepair || parentOp?.kind === "folder.create";
    if (!urlChanged && !titleChanged && !folderChanged) {
      delete inp.rejected[entity];
      continue;
    }
    // 标题 / URL / 目录合并为一次提交：同一轮「改标题并移目录」不会因两条操作各带同一旧修订号而自冲突
    const mut: Mutation = { kind: "bookmark.update", browserId: l.id };
    if (urlChanged) {
      mut.url = leaf.u;
      mut.title = (leaf.t || leaf.u).slice(0, 500);
    } else if (titleChanged) {
      mut.title = leaf.t.slice(0, 500);
    }
    if (folderChanged) {
      mut.browserFolderId = leaf.p; // 目标目录：服务端按稳定身份优先解析，身份缺失退路径
      mut.folderPath = l.path;
      mut.folderRoot = l.root;
    }
    if (isRejected(inp.rejected, entity, "bookmark.update", mut)) continue;
    const rev = inp.revisions[appId]; // 操作生成时的库侧修订（固定绑定）
    add("bookmark.update", entity, mut, { ...(rev !== undefined ? { baseRevision: rev } : {}), deps: folderOpFor(leaf.p), ...(identityRepair ? { identityRepair: true } : {}) });
  }

  // ---- 删除 / 退出同步范围 → 出站操作 ----
  for (const d of inp.deletePlan.leaves) {
    const entity = bmKey(d.browserId);
    if (pendingBlocks(entity)) continue;
    add("bookmark.delete", entity, { kind: "bookmark.delete", browserId: d.browserId });
  }
  for (const f of inp.deletePlan.folders) {
    const entity = fdKey(f.browserFolderId);
    if (pendingBlocks(entity)) continue;
    add("folder.deleteTree", entity, { kind: "folder.deleteTree", appFolderId: f.appFolderId, browserFolderId: f.browserFolderId });
  }
  for (const id of inp.unbinds) {
    const entity = bmKey(id);
    if (pendingBlocks(entity)) continue;
    add("bookmark.unbind", entity, { kind: "bookmark.unbind", browserId: id });
  }
  return { ops, superseded };
}

// ---------- 出站顺序：先目录（含删除），后书签；同级保持生成顺序（父先于子） ----------
const SEND_RANK: Record<string, number> = {
  "folder.create": 0,
  "folder.move": 0,
  "folder.rename": 0,
  "folder.ensure": 0,
  "folder.deleteTree": 1,
  "folder.delete": 1,
  "bookmark.create": 2,
  "bookmark.update": 2,
  "bookmark.move": 2,
  "bookmark.delete": 3,
  "bookmark.unbind": 4,
};
export function orderForSend(ops: OutOp[]): OutOp[] {
  return ops.map((op, i) => ({ op, i })).sort((a, b) => (SEND_RANK[a.op.kind] ?? 9) - (SEND_RANK[b.op.kind] ?? 9) || a.i - b.i).map((x) => x.op);
}

/** 发送载荷：合成 opId 与生成时绑定的 baseRevision */
export function composePayload(op: OutOp): Mutation {
  return { ...op.mut, opId: op.opId, ...(op.baseRevision !== undefined ? { baseRevision: op.baseRevision } : {}) };
}

// ---------- 回执 → 状态迁移（纯数据变换） ----------
export interface DrainState {
  /** leaves = 已确认基线；folders = 存在性基线（D75） */
  base: Snapshot;
  bmMap: Record<string, string>;
  fMap: Record<string, string>;
  revisions: Record<string, number>;
  rejected: Record<string, RejectedRecord>;
  stats: { pushedOk: number; conflicts: number; deletedLibrary: number };
}
export interface OpOutcome {
  /** true = 出队（成功 / 终态）；false = 保留并复用原 opId 重发 */
  remove: boolean;
  error?: string;
  /** 冲突：库侧现值——调用方把浏览器节点回对齐到它 */
  realign?: BookmarkReceipt;
  rejectedError?: string;
}

const isNewer = (known: number | undefined, rev: number | undefined): boolean =>
  rev !== undefined && (known === undefined || rev > known);
const bumpRevision = (revisions: Record<string, number>, appId: string, rev: number | undefined): void => {
  if (isNewer(revisions[appId], rev)) revisions[appId] = rev!;
};
const rebindBm = (bmMap: Record<string, string>, browserId: string, appId: string): void => {
  for (const [a, b] of Object.entries(bmMap)) if (b === browserId && a !== appId) delete bmMap[a];
  bmMap[appId] = browserId;
};
const unbindBm = (bmMap: Record<string, string>, browserId: string): void => {
  for (const [a, b] of Object.entries(bmMap)) if (b === browserId) delete bmMap[a];
};
const pruneSubtree = (base: Snapshot, rootFid: string): void => {
  const sub = subtreeOf(rootFid, base.folders);
  for (const fid of sub) delete base.folders[fid];
  for (const [lid, leaf] of Object.entries(base.leaves)) if (sub.has(leaf.p)) delete base.leaves[lid];
};
const dropFolderMap = (fMap: Record<string, string>, appFolderId: unknown): void => {
  for (const [b, a] of Object.entries(fMap)) if (a === appFolderId) delete fMap[b];
};

/**
 * 单条回执的状态迁移（R02/R05/R07 的核心不变量）：
 *  - 成功：出队；已确认基线、修订缓存、身份映射按**回执实体**推进（非按当前扫描值）；
 *  - 修订单调：回执修订号低于已知值 = 响应丢失后的旧回执重放 → 出队但不回退基线；
 *  - conflict：库侧现值优先，出队并要求浏览器节点回对齐；
 *  - failed / 可重试 skipped：保留（同 opId 重发）；终态 skipped：出队 + 记录拒绝（不无限静默重试）。
 */
export function applyOpResult(st: DrainState, op: OutOp, r: ApplyResult, now: number): OpOutcome {
  const mut = op.mut;
  const ok = r.status === "ok" || r.status === "bound" || r.status === "noop";
  if (ok) {
    switch (op.kind) {
      case "bookmark.create": {
        const bid = str(mut.browserId);
        const ent = r.entity as BookmarkReceipt | undefined;
        const appId = r.appBookmarkId ?? ent?.id ?? "";
        if (bid && appId) rebindBm(st.bmMap, bid, appId);
        const folderBid = str(mut.browserFolderId);
        if (folderBid && !isRootId(folderBid) && r.appFolderId && (!st.fMap[folderBid] || st.fMap[folderBid] === r.appFolderId)) st.fMap[folderBid] = r.appFolderId;
        const p = folderBid || st.base.leaves[bid]?.p || "";
        if (bid) st.base.leaves[bid] = { u: ent?.url_raw ?? str(mut.url), t: ent?.title ?? str(mut.title), p, ...(ent?.folder_id ? { f: ent.folder_id } : {}) };
        if (appId) bumpRevision(st.revisions, appId, ent?.content_revision);
        st.stats.pushedOk++;
        return { remove: true };
      }
      case "bookmark.update": {
        const bid = str(mut.browserId);
        const ent = r.entity as BookmarkReceipt | undefined;
        const appId = r.appBookmarkId ?? ent?.id;
        // 修订单调：旧回执重放不回退已确认基线（后续库侧变更已由 pull 推进过基线）
        if (appId && ent && (st.revisions[appId] ?? -1) > ent.content_revision) return { remove: true };
        if (appId) {
          if (r.status === "bound") rebindBm(st.bmMap, bid, appId); // URL 命中既有条目 → 身份迁移
          if (ent) bumpRevision(st.revisions, appId, ent.content_revision);
        }
        if (ent) {
          const p = mut.browserFolderId !== undefined ? str(mut.browserFolderId) : st.base.leaves[bid]?.p ?? "";
          st.base.leaves[bid] = { u: ent.url_raw, t: ent.title, p, f: ent.folder_id };
        } else {
          // noop 且无实体：库侧已是该状态 → 以操作意图为准清 diff
          const leaf = st.base.leaves[bid];
          if (leaf) {
            if (mut.url !== undefined) leaf.u = str(mut.url);
            if (mut.title !== undefined) leaf.t = str(mut.title);
            if (mut.browserFolderId !== undefined) leaf.p = str(mut.browserFolderId);
          }
        }
        st.stats.pushedOk++;
        return { remove: true };
      }
      case "bookmark.delete":
      case "bookmark.unbind": {
        const bid = str(mut.browserId);
        delete st.base.leaves[bid];
        unbindBm(st.bmMap, bid);
        if (op.kind === "bookmark.delete") st.stats.deletedLibrary++;
        st.stats.pushedOk++;
        return { remove: true };
      }
      case "folder.create":
      case "folder.move":
      case "folder.rename":
      case "folder.ensure": {
        const fid = str(mut.browserFolderId) || str(r.browserId);
        // HTTP 200 不是单条成功；缺少/错配身份或旧服务端仍回 bound，均保留操作并显式报错。
        if (!r.appFolderId) return { remove: false, error: "folder_receipt_missing_identity" };
        if (mut.appFolderId && r.appFolderId !== mut.appFolderId) return { remove: false, error: "folder_receipt_identity_mismatch" };
        if (mut.separateFromAppFolderId && r.appFolderId === mut.separateFromAppFolderId) return { remove: false, error: "folder_identity_not_separated" };
        if (fid && !isRootId(fid)) st.fMap[fid] = r.appFolderId;
        delete st.rejected[op.entity];
        st.stats.pushedOk++;
        return { remove: true };
      }
      case "folder.deleteTree": {
        const fid = str(mut.browserFolderId);
        if (fid) pruneSubtree(st.base, fid);
        dropFolderMap(st.fMap, mut.appFolderId);
        st.stats.deletedLibrary++;
        st.stats.pushedOk++;
        return { remove: true };
      }
      default:
        st.stats.pushedOk++;
        return { remove: true };
    }
  }
  if (r.status === "conflict") {
    st.stats.conflicts++;
    if (op.kind.startsWith("bookmark")) {
      const ent = r.entity as BookmarkReceipt | undefined;
      const appId = r.appBookmarkId ?? ent?.id;
      if (appId && ent) {
        bumpRevision(st.revisions, appId, ent.content_revision);
        rebindBm(st.bmMap, str(mut.browserId), appId);
      }
      return { remove: true, realign: ent };
    }
    // 目录冲突：库侧现值优先——目录库态每轮从 /folders 派生，pull 已把库态应用到浏览器节点
    return { remove: true };
  }
  if (r.status === "skipped") {
    if (isTerminalSkip(r.error)) {
      st.rejected[op.entity] = { fp: fingerprint(mut), kind: op.kind, error: r.error ?? "skipped", at: now };
      if (r.error === "no_identity" && op.kind.startsWith("bookmark")) {
        // 本地身份已失效（如库代际更换）→ 清掉本地映射，下一轮 diff 改走 create 重新绑定
        unbindBm(st.bmMap, str(mut.browserId));
      }
      // 删除类操作的终态 = 库侧无对应 / 已不存在 → 视为收敛，出基线防每轮空转
      if (op.kind === "bookmark.delete" || op.kind === "bookmark.unbind") delete st.base.leaves[str(mut.browserId)];
      if (op.kind === "folder.deleteTree") {
        const fid = str(mut.browserFolderId);
        if (fid) pruneSubtree(st.base, fid);
        dropFolderMap(st.fMap, mut.appFolderId);
      }
      return { remove: true, rejectedError: r.error };
    }
    return { remove: false, error: `skipped: ${r.error ?? ""}` };
  }
  return { remove: false, error: r.error ?? r.status };
}
