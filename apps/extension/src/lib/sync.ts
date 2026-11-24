/**
 * D46 收藏夹双向直接同步引擎。
 *
 * 心智模型：开启后「管理台 = 书签的唯一管理面，浏览器收藏夹 = 库的实时视图」。
 *
 * 每 tick 三步收敛：
 *  1. 拉取（库 → 浏览器）：/sync/pull 变更日志逐条应用；本设备推上去的日志带 device 标记被排除（防回环）。
 *     单条失败持久化入重试队列——「应用成功或已入队」才推进游标。
 *  2. 推送（浏览器 → 库）：重新扫描浏览器树，对比**已确认基线**生成出站操作，先落盘再发送；
 *     成功回执才出队并推进基线，失败复用原 opId 重发（见 lib/sync-plan.ts 的操作契约）。
 *  3. 重存基线与游标；受影响目录按库顺序（置顶 → 新入库）就地重排。
 *
 * 对齐与过期恢复统一为 doRebuild：先把本地意图按同一套操作契约落库，再取一致性快照
 * （实体 + 水位）把浏览器收敛到库态——基线与游标在同一水位边界上建立。
 *
 * 触发：开关首次打开（重建）/ 1 分钟告警 / SSE 门铃 / 书签事件防抖 / options「立即同步」。
 *
 * 删除保险丝：单轮内任一侧删除量异常（浏览器资料被重置、库被误清等灾难形态）→ 挂起待确认；
 * 浏览器侧的叶子删除与目录树删是同一个确认单元，挂起期间持久保留操作与范围，确认后才执行。
 */
import { browser } from "wxt/browser";
import { INBOX_FOLDER_TITLE, isVirtualBookmarkRootTitle } from "@mf/shared";
import { api, getConfig, saveConfig } from "./api";
import { getDeviceId, pruneEmptyMirrorFolders } from "./device";
import { withBrowserExecutor } from "./executor";
import {
  AMBIGUOUS_FOLDER_COPIES,
  ambiguousBookmarkCopies,
  applyOpResult,
  bmKey,
  buildPushOps,
  composePayload,
  computeDeletedSets,
  emptyBrowserDeletePlan,
  evaluateDeleteGuard,
  fdKey,
  folderPathOf,
  folderIdentitySplits,
  insideDeletedFolder,
  isRootId,
  mergeBrowserDeletePlan,
  pendingProtection,
  readyOutboxOps,
  reverseMap,
  subtreeOf,
  validateBrowserDeletePlan,
  type ApplyResult,
  type BookmarkReceipt,
  type BrowserDeletePlan,
  type DrainState,
  type FolderIndex,
  type LibFolderRow,
  type Mutation,
  type OutOp,
  type RejectedRecord,
  type SnapFolder,
  type SnapLeaf,
  type Snapshot,
  type Walked,
} from "./sync-plan";

const SNAPSHOT_KEY = "mfSyncSnapshot";
const BOOKMARK_MAP_KEY = "mfSyncBookmarkMap";
const FOLDER_MAP_KEY = "mfSyncFolderMap";
const INFO_KEY = "mfSyncLastInfo";
/** pull 单条失败持久重试队列——事件「应用成功或已持久化入队」后才允许推进游标 */
const RETRY_QUEUE_KEY = "mfSyncRetryQueue";
/** 保险丝挂起的库侧删除事件持久队列——确认放行后重放，游标越过也不丢 */
const PENDING_DELETES_KEY = "mfSyncPendingDeletes";
/** 保险丝挂起的浏览器侧删除计划（叶子 + 目录树 = 一个确认单元） */
const PENDING_BROWSER_DELETES_KEY = "mfSyncPendingBrowserDeletes";
/** 旧版键（仅存 bookmark.delete 载荷）：读取时迁移到删除计划 */
const LEGACY_RECOVER_PENDING_KEY = "mfSyncRecoverPending";
/** 库侧修订缓存（appId → content_revision），操作生成时绑定 baseRevision 的依据 */
const REVISIONS_KEY = "mfSyncRevisions";
/** 库代际标识（与服务端 sync_meta.generation 比对，DB 替换判定） */
const GENERATION_KEY = "mfSyncGeneration";
/** 出站操作队列：发送前落盘，成功 / 终态回执才出队 */
const OUTBOX_KEY = "mfSyncOutbox";
/** 终态拒绝记录（同指纹操作不无限重试） */
const REJECTED_KEY = "mfSyncRejected";
/** 出站操作最长保留：服务端回执保留 7 天，超期丢弃并按当前状态重新推导 */
const OUTBOX_MAX_AGE_MS = 6 * 86400_000;

const PATH_SEP = "\u0000";
const MUT_BATCH = 400;
const UNTIDY = "未整理"; // 库根目录名（ensurePath 空路径落点）↔ 浏览器书签栏根

export interface SyncStats {
  pulledApplied: number;
  createdInBrowser: number;
  deletedBrowser: number;
  deletedLibrary: number;
  pushedOk: number;
  resortedFolders: number;
  /** 本轮按约定策略（库侧现值优先）处理的真实并发冲突数 */
  conflicts: number;
}
export interface SyncInfo {
  at: number;
  phase: "align" | "tick";
  ok: boolean;
  /** 同步状态机——正常 / 重试中 / 待确认删除 / 失败或存在被拒绝的操作（options 状态行呈现） */
  state?: "ok" | "retrying" | "pending_confirm" | "error";
  error?: string;
  /** 拉取重试队列中待重放的变更条数 */
  retryCount?: number;
  /** 出站队列中待发送 / 待重试的操作数 */
  outboxCount?: number;
  /** 被服务端终态拒绝的操作数（不会自愈，需关注原因） */
  rejectedCount?: number;
  /** 本轮按约定策略（库侧现值优先）处理的真实并发冲突数 */
  conflicts?: number;
  /** 两侧挂起、等待用户确认的删除条数 */
  pendingDeleteCount?: number;
  deleteGuard?: { side: "browser" | "library"; count: number };
  stats?: Partial<SyncStats>;
  /** 全量重建耗时（健康面：大库数十秒可见化） */
  alignMs?: number;
}

/** pull 变更事件原始形态（重试队列按原样持久化，重放走同一应用器） */
interface PullItem { id?: number; entity: string; entity_id: string; op: string; payload: unknown }
interface RetryEntry { item: PullItem; attempts: number; lastError: string; createdAt: number }
/** 库侧挂起删除（库 → 浏览器方向的删除事件） */
interface PendingDeletes { bookmarks: Array<{ id: string; url: string }>; folders: Array<{ id: string; name: string }>; at: number }

interface LibBookmark { id: string; folder_id: string; title: string; url_raw: string; content_revision?: number }
interface SyncSnapshot {
  folders: LibFolderRow[];
  bookmarks: LibBookmark[];
  watermark: number;
  generation: string;
  minAvailableId: number | null;
}

let running: Promise<SyncInfo> | null = null;
const zeroStats = (): SyncStats => ({ pulledApplied: 0, createdInBrowser: 0, deletedBrowser: 0, deletedLibrary: 0, pushedOk: 0, resortedFolders: 0, conflicts: 0 });
const newOpId = (): string => crypto.randomUUID();
const newOp = (kind: string, entity: string, mut: Mutation, extra: Partial<OutOp> = {}): OutOp => ({
  opId: newOpId(),
  kind,
  entity,
  mut,
  createdAt: Date.now(),
  attempts: 0,
  ...extra,
});

const key = (path: string[]): string => path.join(PATH_SEP);
/** 根映射键——other 根（其他书签）路径前缀隔离，不同根下同名目录不串号 */
const rootKey = (root: string, path: string[]): string => (root === "other" ? `other${PATH_SEP}` : "") + key(path);
const OTHER_ROOT_TITLES = new Set(["其他书签", "其他收藏夹", "Other bookmarks", "Other favorites", "链接", "Links"]);

const cloneSnapshot = (s: Snapshot): Snapshot => ({
  leaves: Object.fromEntries(Object.entries(s.leaves).map(([k, v]) => [k, { ...v }])),
  folders: Object.fromEntries(Object.entries(s.folders).map(([k, v]) => [k, { ...v }])),
});

/** 引擎外（用户中途）改动的探测：基线与实际树不一致 → 触发 catch-up 补一轮 */
function treesDiffer(base: Snapshot, actual: Snapshot): boolean {
  const bk = Object.keys(base.leaves);
  const ak = Object.keys(actual.leaves);
  if (bk.length !== ak.length) return true;
  for (const id of bk) {
    const a = base.leaves[id]!;
    const b = actual.leaves[id];
    if (!b || a.u !== b.u || a.t !== b.t || a.p !== b.p) return true;
  }
  const bf = Object.keys(base.folders);
  if (bf.length !== Object.keys(actual.folders).length) return true;
  for (const id of bf) {
    const a = base.folders[id]!;
    const b = actual.folders[id];
    if (!b || a.t !== b.t || a.p !== b.p) return true;
  }
  return false;
}

/** 存在性基线剪枝：移除某目录子树（目录 + 其内叶子）。只在树删成功 / 终态后调用 */
function pruneSubtree(base: Snapshot, rootFid: string): void {
  const sub = subtreeOf(rootFid, base.folders);
  for (const fid of sub) delete base.folders[fid];
  for (const [lid, leaf] of Object.entries(base.leaves)) if (sub.has(leaf.p)) delete base.leaves[lid];
}

// ---------- storage ----------
async function readObj<T>(k: string, fallback: T): Promise<T> {
  return ((await browser.storage.local.get(k))[k] as T | undefined) ?? fallback;
}
export async function getSyncInfo(): Promise<SyncInfo | undefined> {
  return (await browser.storage.local.get(INFO_KEY))[INFO_KEY] as SyncInfo | undefined;
}
async function setStorage(obj: Record<string, unknown>): Promise<void> {
  try {
    await browser.storage.local.set(obj);
  } catch {
    /* 存储写入失败不抛到引擎主路径（状态行另有 mfSyncLastError 记录） */
  }
}

/** 整轮失败可观测（D62③）——触发层兜底把错误写进 SyncInfo，options 不再停留陈旧 "ok" */
export async function markSyncError(err: unknown): Promise<void> {
  const info: SyncInfo = { at: Date.now(), phase: "tick", ok: false, state: "error", error: String(err).slice(0, 200) };
  await browser.storage.local.set({ [INFO_KEY]: info, mfSyncLastError: info.error ?? null }).catch(() => undefined);
}

// ---------- 持久队列 ----------
async function readRetryQueue(): Promise<RetryEntry[]> {
  return await readObj<RetryEntry[]>(RETRY_QUEUE_KEY, []);
}
async function writeRetryQueue(q: RetryEntry[]): Promise<void> {
  await setStorage({ [RETRY_QUEUE_KEY]: q });
}
/** 失败事件入队（幂等：同 change id 不重复；无 id 的合成事件按 entity+entity_id+op 去重） */
async function enqueueRetry(item: PullItem, reason: string): Promise<void> {
  const q = await readRetryQueue();
  const dup = q.some((e) =>
    item.id !== undefined ? e.item.id === item.id : e.item.entity === item.entity && e.item.entity_id === item.entity_id && e.item.op === item.op,
  );
  if (!dup) q.push({ item, attempts: 1, lastError: reason.slice(0, 200), createdAt: Date.now() });
  await writeRetryQueue(q);
}
async function readPendingDeletes(): Promise<PendingDeletes> {
  return await readObj<PendingDeletes>(PENDING_DELETES_KEY, { bookmarks: [], folders: [], at: 0 });
}
async function writePendingDeletes(p: PendingDeletes): Promise<void> {
  await setStorage({ [PENDING_DELETES_KEY]: p });
}
async function readBrowserPlan(): Promise<BrowserDeletePlan> {
  const plan = await readObj<BrowserDeletePlan | null>(PENDING_BROWSER_DELETES_KEY, null);
  if (plan && Array.isArray(plan.leaves) && Array.isArray(plan.folders)) return plan;
  // 旧键迁移：D81 首版 recover 挂起队列只有 bookmark.delete 载荷
  const legacy = await readObj<Array<{ browserId?: string }>>(LEGACY_RECOVER_PENDING_KEY, []);
  if (Array.isArray(legacy) && legacy.length > 0) {
    const migrated: BrowserDeletePlan = {
      leaves: legacy.filter((m) => m.browserId).map((m) => ({ browserId: m.browserId!, appId: "", url: "" })),
      folders: [],
      at: Date.now(),
    };
    await setStorage({ [PENDING_BROWSER_DELETES_KEY]: migrated, [LEGACY_RECOVER_PENDING_KEY]: null });
    return migrated;
  }
  return emptyBrowserDeletePlan();
}
async function writeBrowserPlan(p: BrowserDeletePlan): Promise<void> {
  await setStorage({ [PENDING_BROWSER_DELETES_KEY]: p });
}
async function readOutbox(): Promise<OutOp[]> {
  const raw = await readObj<OutOp[]>(OUTBOX_KEY, []);
  if (!Array.isArray(raw)) return [];
  const cutoff = Date.now() - OUTBOX_MAX_AGE_MS;
  // 回执保留期之后的恢复方式：超期未决操作丢弃，按当前状态重新推导——其回执可能已被服务端裁剪，
  // 重放不再幂等；已确认基线未推进，下一轮 diff 会按现状重新生成（带新的 baseRevision）
  return raw.filter((o) => o && typeof o.opId === "string" && typeof o.createdAt === "number" && o.createdAt >= cutoff && o.mut);
}
async function writeOutbox(q: OutOp[]): Promise<void> {
  // 出站操作必须确认落盘后才可发送；配额/存储失败不能被当成 fire-and-forget。
  await browser.storage.local.set({ [OUTBOX_KEY]: q });
}
async function readRejected(): Promise<Record<string, RejectedRecord>> {
  return await readObj<Record<string, RejectedRecord>>(REJECTED_KEY, {});
}
async function writeRejected(r: Record<string, RejectedRecord>): Promise<void> {
  await setStorage({ [REJECTED_KEY]: r });
}

// ---------- 浏览器树 ----------
interface BmNode { id: string; title?: string; url?: string; parentId?: string; children?: BmNode[] }

async function walkBrowser(): Promise<Walked> {
  const { inboxExtId } = await getConfig();
  const tree = (await browser.bookmarks.getTree()) as unknown as BmNode[];
  const liveBrowserFolderIds: string[] = [];
  const collectAllFolders = (nodes: BmNode[]): void => {
    for (const n of nodes) {
      if (!n.url) liveBrowserFolderIds.push(n.id);
      if (n.children) collectAllFolders(n.children);
    }
  };
  collectAllFolders(tree); // 独立于下面的同步范围过滤，含收纳盒/豁免子树
  const leaves: Record<string, SnapLeaf> = {};
  const folders: Record<string, SnapFolder> = {};
  const leafList: Array<{ id: string; path: string[]; root: string }> = [];
  const folderOrder: string[] = [];
  const folderIdByPath = new Map<string, string>();
  const rootByFolderId = new Map<string, string>();
  const walk = (nodes: BmNode[], path: string[], depth: number, root: string): void => {
    for (const n of nodes) {
      if (n.url) {
        if (!/^https?:/.test(n.url)) continue; // 引擎只管 http(s)（与导入通道同口径）
        leaves[n.id] = { u: n.url, t: n.title ?? n.url, p: n.parentId ?? "" };
        leafList.push({ id: n.id, path, root });
        continue;
      }
      if (!n.id || n.id === "0") continue;
      // D55：第一层虚拟根无条件穿透；D81：穿透时分类根映射（书签栏 → bar，其他书签 → other）
      if (isVirtualBookmarkRootTitle(n.title, depth)) {
        const childRoot =
          n.id === "1" ? "bar" : n.id === "2" || n.id === "3" || OTHER_ROOT_TITLES.has((n.title ?? "").trim()) ? "other" : root;
        if (n.children) walk(n.children, path, depth + 1, childRoot);
        continue;
      }
      if (n.id === inboxExtId || n.title === INBOX_FOLDER_TITLE) continue; // 收纳盒投递口归收纳盒管线管
      folders[n.id] = { t: n.title ?? "", p: n.parentId ?? "" };
      folderOrder.push(n.id); // 前序：父先于子
      const next = [...path, (n.title ?? "").slice(0, 200)];
      folderIdByPath.set(rootKey(root, next), n.id);
      rootByFolderId.set(n.id, root);
      if (n.children) walk(n.children, next, depth + 1, root);
    }
  };
  for (const top of tree) if (top.children) walk(top.children, [], 0, "bar");
  return { snapshot: { leaves, folders }, leafList, folderOrder, folderIdByPath, rootByFolderId, liveBrowserFolderIds };
}

// ---------- 服务端读取 ----------
function indexFolders(rows: LibFolderRow[]): FolderIndex {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const pathById = new Map<string, string[]>();
  const idByPath = new Map<string, string>();
  const rootById = new Map<string, string>();
  const build = (id: string): string[] => {
    const hit = pathById.get(id);
    if (hit) return hit;
    const r = byId.get(id);
    const p = !r ? [] : r.parent_id ? [...build(r.parent_id), r.name] : [r.name];
    pathById.set(id, p);
    const root = r?.root === "other" ? "other" : "bar";
    rootById.set(id, root);
    idByPath.set(rootKey(root, p), id); // 路径键带根前缀：不同根下同名目录各自匹配
    return p;
  };
  for (const r of rows) build(r.id);
  const inbox = rows.find((r) => r.is_system_inbox === 1);
  return { pathById, idByPath, rootById, rows: byId, inboxFolderId: inbox?.id ?? null };
}

/** 库目录态（含 rev）——每轮从 /folders 派生，是出站目录操作的对比基线 */
async function fetchAppFolders(): Promise<FolderIndex> {
  return indexFolders(await api<LibFolderRow[]>("/folders", {}));
}

/** 合并服务端目录身份进 fMap（folder_identity 是权威，本地存储只是缓存——跨 SW 重启不丢） */
async function mergeServerFolderIdentities(deviceId: string, fMap: Record<string, string>): Promise<void> {
  const res = await api<{ identities: Array<{ browser_folder_id: string; app_folder_id: string; app_exists: boolean }> }>(
    `/browser/folder-identities?deviceId=${encodeURIComponent(deviceId)}`,
    {},
  ); // 核心身份读取失败必须中止整轮，不能把「未知」伪装成空身份后取消响应丢失的操作。
  for (const i of res.identities) {
    if (i.app_exists) fMap[i.browser_folder_id] = i.app_folder_id;
    else delete fMap[i.browser_folder_id]; // 库目录已删 → 本地映射同步清出
  }
}

/**
 * 库目录 → **仍存在于当前树**的浏览器目录（身份反查）。只认存活映射：
 * 已绑定的浏览器目录被删后返回 undefined，调用方退到按库路径重建——不得把失效 id 当作保障结果。
 */
function livingBrowserFolder(fMap: Record<string, string>, appFolderId: string, walk: Snapshot): string | undefined {
  for (const [bid, aid] of Object.entries(fMap)) if (aid === appFolderId && walk.folders[bid]) return bid;
  return undefined;
}

async function applyMutations(deviceId: string, muts: Mutation[]): Promise<ApplyResult[]> {
  const out: ApplyResult[] = [];
  for (let i = 0; i < muts.length; i += MUT_BATCH) {
    const r = await api<{ results: ApplyResult[]; cursor: number }>("/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId, mutations: muts.slice(i, i + MUT_BATCH) }),
    });
    out.push(...r.results);
  }
  return out;
}

// ---------- 浏览器侧目录保障（库 ID 优先，绝不以同名 path 代替身份） ----------
interface PlaceCtx {
  deviceId: string;
  folders: FolderIndex;
  fMap: Record<string, string>;
  walk: Walked;
  bmMap: Record<string, string>;
  stats: SyncStats;
  base?: Snapshot;
  protectedFolders?: Set<string>;
  protectedLeaves?: Set<string>;
  /** 本轮已核验的库→浏览器绑定，避免每条书签重复登记 */
  ensuredFolders?: Set<string>;
}

async function refreshFolderIndex(ctx: PlaceCtx): Promise<void> {
  // 保留索引对象引用（PullCtx/PlaceCtx 共用），刷新不能让后续分支继续消费旧 Map。
  Object.assign(ctx.folders, await fetchAppFolders());
}

async function ensureBrowserFolder(appFolderId: string, ctx: PlaceCtx, ancestors = new Set<string>()): Promise<string> {
  if (!ctx.folders.rows.has(appFolderId)) await refreshFolderIndex(ctx);
  const row = ctx.folders.rows.get(appFolderId);
  if (!row) throw new Error(`folder_unknown: ${appFolderId}`);
  if (ancestors.has(appFolderId)) throw new Error(`folder_parent_cycle: ${appFolderId}`);
  const chain = new Set(ancestors).add(appFolderId);
  const root = ctx.folders.rootById.get(appFolderId) ?? "bar";
  const path = ctx.folders.pathById.get(appFolderId);
  if (!path?.length) throw new Error(`folder_path_unknown: ${appFolderId}`);
  if (row.parent_id === null && row.name === UNTIDY && root === "bar") return "1";
  const mapped = livingBrowserFolder(ctx.fMap, appFolderId, ctx.walk.snapshot);
  if (mapped && ctx.protectedFolders?.has(mapped)) throw new Error(`folder_pending_local_intent: ${mapped}`);
  const mappedNode = mapped ? (await browser.bookmarks.get(mapped))[0] : undefined;
  if (mappedNode && !mappedNode.url && ctx.ensuredFolders?.has(appFolderId)) return mappedNode.id;
  // 旧API曾把浏览器虚拟根ID作为库parent_id保存；仅这三个已知且库中不存在的ID可视作根。
  const parentApp = row.parent_id && !(isRootId(row.parent_id) && !ctx.folders.rows.has(row.parent_id)) ? row.parent_id : null;
  const parentId = parentApp ? await ensureBrowserFolder(parentApp, ctx, chain) : root === "other" ? "2" : "1";
  let bid = mappedNode && !mappedNode.url ? mappedNode.id : undefined;
  if (!bid) {
    // 按确切父 browser 身份寻找未被别的库目录认领的兄弟；同 path 的不同库目录各有独立落点。
    const siblings = await browser.bookmarks.getChildren(parentId);
    const candidate = siblings.find((n) => !n.url && n.title === row.name && !ctx.protectedFolders?.has(n.id) && !ctx.fMap[n.id]);
    if (candidate) bid = candidate.id;
    else bid = (await browser.bookmarks.create({ parentId, title: row.name })).id;
    ctx.walk.snapshot.folders[bid] = { t: row.name, p: parentId };
    if (ctx.walk.liveBrowserFolderIds && !ctx.walk.liveBrowserFolderIds.includes(bid)) ctx.walk.liveBrowserFolderIds.push(bid);
    ctx.walk.rootByFolderId.set(bid, root);
    if (!ctx.walk.folderOrder.includes(bid)) ctx.walk.folderOrder.push(bid);
    if (ctx.base) ctx.base.folders[bid] = { t: row.name, p: parentId };
  }
  const [receipt] = await applyMutations(ctx.deviceId, [{ kind: "folder.ensure", appFolderId, path, root, browserFolderId: bid, ...(ctx.walk.liveBrowserFolderIds ? { liveBrowserFolderIds: ctx.walk.liveBrowserFolderIds } : {}) }]);
  if (!receipt || !["ok", "bound", "noop"].includes(receipt.status) || receipt.appFolderId !== appFolderId) {
    throw new Error(`folder.ensure ${appFolderId}: ${receipt?.error ?? receipt?.status ?? "no_result"}`);
  }
  ctx.fMap[bid] = appFolderId; // 单条回执核验成功之后才登记
  ctx.ensuredFolders ??= new Set<string>();
  ctx.ensuredFolders.add(appFolderId);
  await browser.storage.local.set({ [FOLDER_MAP_KEY]: ctx.fMap });
  return bid;
}

/** 库 → 浏览器方向单条放置：无节点则绑 / 建；有则对齐标题、URL 与所在目录（顺序由 resort 收尾） */
async function placeBookmark(b: LibBookmark, ctx: PlaceCtx): Promise<void> {
  if (ctx.folders.inboxFolderId && b.folder_id === ctx.folders.inboxFolderId) return; // D51：收纳盒条目不放置
  if (!b.url_raw) return; // D79：无 URL 不放置——search({url:""}) 会绑错随机书签
  if (ctx.protectedLeaves?.has(ctx.bmMap[b.id] ?? "")) throw new Error(`bookmark_pending_local_intent: ${b.id}`);
  const target = await ensureBrowserFolder(b.folder_id, ctx);
  const libPath = ctx.folders.pathById.get(b.folder_id)!;
  const libRoot = ctx.folders.rootById.get(b.folder_id) ?? "bar";
  let bid = ctx.bmMap[b.id];
  let node = bid ? (await browser.bookmarks.get(bid).catch(() => []))[0] : undefined;
  if (!node?.url) {
    const found = (await browser.bookmarks.search({ url: b.url_raw }).catch(() => []))[0];
    if (found?.url) {
      if (ctx.protectedLeaves?.has(found.id)) throw new Error(`bookmark_pending_local_intent: ${found.id}`);
      bid = found.id;
      node = found;
      ctx.bmMap[b.id] = bid;
    }
  }
  if (!bid || !node?.url) {
    const parentId = target;
    const created = await browser.bookmarks.create({ parentId, title: (b.title || b.url_raw).slice(0, 500), url: b.url_raw });
    await applyMutations(ctx.deviceId, [{ kind: "bookmark.create", browserId: created.id, url: b.url_raw, title: b.title, folderPath: libPath, folderRoot: libRoot, browserFolderId: parentId }]);
    ctx.bmMap[b.id] = created.id;
    if (ctx.base) ctx.base.leaves[created.id] = { u: b.url_raw, t: b.title || b.url_raw, p: parentId, f: b.folder_id };
    ctx.stats.createdInBrowser++;
    ctx.stats.pulledApplied++;
    return;
  }
  const patch: { title?: string; url?: string } = {};
  if ((node.title ?? "") !== b.title && b.title) patch.title = b.title.slice(0, 500);
  if ((node.url ?? "") !== b.url_raw && b.url_raw) patch.url = b.url_raw; // D52：库侧改 URL 浏览器跟随
  // 浏览器写失败必须抛出（进持久重试队列），不得吞异常后乐观更新基线
  if (Object.keys(patch).length > 0) {
    await browser.bookmarks.update(bid, patch);
    ctx.stats.pulledApplied++;
  }
  if (node.parentId !== target) {
    await browser.bookmarks.move(bid, { parentId: target });
    ctx.stats.pulledApplied++;
  }
  if (ctx.base) {
    const cur = ctx.base.leaves[bid];
    if (cur) {
      cur.u = patch.url ?? b.url_raw ?? cur.u;
      cur.t = patch.title ?? b.title ?? cur.t;
      cur.p = target;
      cur.f = b.folder_id;
    } else {
      ctx.base.leaves[bid] = { u: b.url_raw, t: b.title, p: target, f: b.folder_id };
    }
  }
}

/** D78：保障浏览器收纳盒投递口存在（先认配置 → 再认同名存量防重复壳 → 最后新建） */
async function ensureInboxSlot(): Promise<string> {
  const { inboxExtId, inboxParent } = await getConfig();
  const parentId = inboxParent === "2" ? "2" : "1";
  if (inboxExtId) {
    const node = (await browser.bookmarks.get(inboxExtId).catch(() => []))[0];
    if (node && !node.url) return inboxExtId;
  }
  const found = (await browser.bookmarks.search({ title: INBOX_FOLDER_TITLE }).catch(() => [])).find((n) => !n.url);
  if (found) {
    await saveConfig({ inboxExtId: found.id });
    return found.id;
  }
  const created = await browser.bookmarks.create({ parentId, title: INBOX_FOLDER_TITLE });
  await saveConfig({ inboxExtId: created.id });
  return created.id;
}

/**
 * D78 收纳盒入口收敛：库内收纳盒条目的浏览器节点必须在投递口里。
 * 按库内收纳盒名单逐条收敛：节点在口外 → 移入；无节点 → 补建；移入后节点退出基线（豁免子树）。
 */
async function convergeInboxEntries(ctx: PlaceCtx): Promise<void> {
  if (!ctx.folders.inboxFolderId) return;
  // D79：全量分页——盒内 >100 条时尾部永远收敛不到（饥饿）
  const items: Array<{ id: string; title: string; url_raw: string }> = [];
  for (let offset = 0; ; offset += 500) {
    const page = await api<Array<{ id: string; title: string; url_raw: string }>>(
      `/bookmarks?folderId=${encodeURIComponent(ctx.folders.inboxFolderId)}&limit=500&offset=${offset}`,
      { headers: { "x-mf-private": "1" } },
    );
    items.push(...page);
    if (page.length < 500) break;
  }
  if (items.length === 0) return;
  const target = await ensureInboxSlot();
  for (const b of items) {
    let bid = ctx.bmMap[b.id];
    if (bid && ctx.protectedLeaves?.has(bid)) continue;
    let node = bid ? (await browser.bookmarks.get(bid).catch(() => []))[0] : undefined;
    if (!node?.url && b.url_raw) {
      const found = (await browser.bookmarks.search({ url: b.url_raw }).catch(() => []))[0];
      if (found?.url) {
        if (ctx.protectedLeaves?.has(found.id)) continue;
        bid = found.id;
        node = found;
        ctx.bmMap[b.id] = bid;
      }
    }
    if (!node?.url) {
      if (!b.url_raw) continue;
      const created = await browser.bookmarks.create({ parentId: target, title: (b.title || b.url_raw).slice(0, 500), url: b.url_raw });
      await applyMutations(ctx.deviceId, [{ kind: "bookmark.create", browserId: created.id, url: b.url_raw, title: b.title, folderPath: [INBOX_FOLDER_TITLE] }]);
      ctx.bmMap[b.id] = created.id;
      ctx.stats.createdInBrowser++;
      continue;
    }
    if (node.parentId === target) continue;
    try {
      await browser.bookmarks.move(node.id, { parentId: target });
    } catch (err) {
      await setStorage({ mfSyncLastError: `inbox converge move 失败: ${String(err).slice(0, 120)}` });
      continue; // 失败不更新基线、不静默——下轮继续收敛（幂等）
    }
    if (ctx.base) delete ctx.base.leaves[node.id]; // 进豁免子树 → 出基线
    ctx.stats.pulledApplied++;
  }
}

/** 目录内按管理台顺序就地重排（分页循环，旧 limit=1000 截断） */
async function resortFolder(appFolderId: string, bmMap: Record<string, string>, ctx: PlaceCtx): Promise<void> {
  const target = await ensureBrowserFolder(appFolderId, ctx);
  let idx = 0;
  for (let offset = 0; ; offset += 1000) {
    const rows = await api<LibBookmark[]>(`/bookmarks?folderId=${encodeURIComponent(appFolderId)}&limit=1000&offset=${offset}`, {
      headers: { "x-mf-private": "1" },
    });
    for (const row of rows) {
      const bid = bmMap[row.id];
      if (!bid || ctx.protectedLeaves?.has(bid)) continue;
      const node = (await browser.bookmarks.get(bid).catch(() => []))[0];
      if (!node?.url) continue;
      await browser.bookmarks.move(bid, { parentId: target, index: idx });
      idx++;
    }
    if (rows.length < 1000) break;
  }
}

// ---------- 库侧删除保险丝 ----------
const guardHit = (count: number, known: number): boolean => count > 30 && count > Math.max(1, known) * 0.25;

// ---------- pull 事件应用器（首拉与重试队列重放共用同一路径） ----------
interface PullCtx extends PlaceCtx {
  base: Snapshot;
  fMap: Record<string, string>;
  walk: Walked;
  deleteEvents: Array<{ id: string; url: string }>;
  folderDeletes: Array<{ id: string; name: string }>;
  touched: Set<string>;
  /** 库侧修订缓存（appId → content_revision），出站操作 baseRevision 的绑定依据 */
  revisions: Record<string, number>;
  /** 拉取前浏览器侧已有未提交修改的实体（app id）：本轮若库侧也改了它 = 真实并发冲突 */
  localEditApps: Set<string>;
}

/** 单条 pull 事件应用。失败抛出 → 调用方持久化入重试队列（游标推进的前提是「已应用或已入队」） */
async function applyPullEvent(it: PullItem, pc: PullCtx): Promise<void> {
  const { folders, fMap, base, walk, bmMap, stats, deleteEvents, folderDeletes, touched } = pc;
  if (it.entity === "bookmark" && it.op === "delete") {
    const url = String((it.payload as { url?: string } | null)?.url ?? "");
    if (pc.localEditApps.delete(it.entity_id)) stats.conflicts++;
    deleteEvents.push({ id: it.entity_id, url });
  } else if (it.entity === "folder" && it.op === "delete") {
    // D73：目录删除同步（库删目录 → 浏览器对应目录移除）
    const name = String((it.payload as { name?: string } | null)?.name ?? "");
    folderDeletes.push({ id: it.entity_id, name });
  } else if (it.entity === "folder" && (it.op === "move" || it.op === "upsert")) {
    const payload = (it.payload ?? {}) as { id?: string; to?: string | null; name?: string; root?: string };
    const appFolderId = it.op === "upsert" ? String(payload.id ?? it.entity_id) : it.entity_id;
    if (folders.inboxFolderId === appFolderId) return;
    // /folders 早于 pull 的新空目录不能因索引缺失直接吞掉：刷新失败将抛出并进入持久 retry。
    if (!folders.rows.has(appFolderId) || (payload.to && !folders.rows.has(payload.to))) await refreshFolderIndex(pc);
    const known = folders.rows.get(appFolderId);
    if (!known) return; // 已刷新当前库，目录确实已删除；无需复活过期事件
    const row = { ...known, ...(payload.name !== undefined ? { name: payload.name } : {}), ...(payload.root ? { root: payload.root } : {}) };
    if (it.op === "move" && payload.to !== undefined) row.parent_id = payload.to || null;
    folders.rows.set(appFolderId, row);
    Object.assign(folders, indexFolders(Array.from(folders.rows.values())));
    const parentApp = row.parent_id && !(isRootId(row.parent_id) && !folders.rows.has(row.parent_id)) ? row.parent_id : null;
    const targetParent = parentApp ? await ensureBrowserFolder(parentApp, pc) : row.root === "other" ? "2" : "1";
    const bid = await ensureBrowserFolder(appFolderId, pc);
    if (isRootId(bid)) return;
    const node = (await browser.bookmarks.get(bid))[0];
    if (!node || node.url) throw new Error(`folder_node_missing: ${bid}`);
    if (it.op === "move" && node.parentId !== targetParent) {
      await browser.bookmarks.move(bid, { parentId: targetParent });
      base.folders[bid] = { t: row.name, p: targetParent };
      walk.snapshot.folders[bid] = { ...base.folders[bid]! };
      stats.pulledApplied++;
    }
    if (node.title !== row.name) {
      await browser.bookmarks.update(bid, { title: row.name });
      base.folders[bid] = { t: row.name, p: targetParent };
      walk.snapshot.folders[bid] = { ...base.folders[bid]! };
    }
  } else if (it.entity === "bookmark" && (it.op === "upsert" || it.op === "move")) {
    const row = it.payload as LibBookmark & { to?: string; url?: string };
    const folderId = it.op === "move" ? String(row.to ?? "") : String(row.folder_id ?? "");
    if (!folderId) return;
    if (folders.inboxFolderId && folderId === folders.inboxFolderId) return; // D51：进出收纳盒归收纳盒管线
    const urlRaw = String(row.url_raw ?? "") || String(row.url ?? "");
    const b: LibBookmark = { id: it.entity_id, folder_id: folderId, title: String(row.title ?? ""), url_raw: urlRaw };
    if (it.op === "upsert" && !b.url_raw) return;
    // R05：修订缓存随库侧事件前进（upsert 与 move 载荷均带 content_revision）——
    // 库侧移动也会递增修订，不更新则端侧下一次编辑携带旧修订号发生假冲突
    if (typeof row.content_revision === "number") {
      const known = pc.revisions[it.entity_id];
      if (known === undefined || row.content_revision > known) pc.revisions[it.entity_id] = row.content_revision;
    }
    if (it.op === "move" && it.payload && typeof (it.payload as { title?: string }).title === "string") b.title = String((it.payload as { title?: string }).title);
    if (pc.localEditApps.delete(it.entity_id)) {
      // 真实并发冲突：浏览器侧有未提交修改，库侧也改了同一条目 → 按约定策略库侧现值优先
      stats.conflicts++;
      console.warn(`[sync] 并发冲突（库侧优先）：bookmark ${it.entity_id}`);
    }
    touched.add(folderId);
    if (it.op === "upsert") await placeBookmark(b, pc);
    else {
      const bid = bmMap[b.id];
      if (bid && pc.protectedLeaves?.has(bid)) throw new Error(`bookmark_pending_local_intent: ${bid}`);
      const node = bid ? (await browser.bookmarks.get(bid).catch(() => []))[0] : undefined;
      if (node?.url) {
        const target = await ensureBrowserFolder(folderId, pc);
        if (node.parentId !== target) {
          await browser.bookmarks.move(bid!, { parentId: target }); // 成功才更新基线
          const leaf = base.leaves[bid!];
          if (leaf) leaf.p = target;
          stats.pulledApplied++;
        }
      } else {
        await placeBookmark(b, pc); // D72：映射缺失 / 节点缺失 → 兜底（URL 搜索找节点并移入目标目录）
      }
    }
  }
}

/** 库侧书签删除执行（保险丝放行后）。单条失败 → 合成 delete 事件入重试队列，不丢 */
async function execBookmarkDeletes(dels: Array<{ id: string; url: string }>, pc: PullCtx): Promise<void> {
  const { bmMap, base, stats } = pc;
  for (const del of dels) {
    let bid = bmMap[del.id];
    let node = bid ? (await browser.bookmarks.get(bid).catch(() => []))[0] : undefined;
    if (!node?.url && del.url) {
      // D73 兜底：本地映射缺失 → 按 URL 搜索
      const found = (await browser.bookmarks.search({ url: del.url }).catch(() => []))[0];
      if (found?.url) {
        bid = found.id;
        node = found;
        bmMap[del.id] = found.id;
      }
    }
    if (!node?.url) continue;
    if (pc.protectedLeaves?.has(node.id)) {
      await enqueueRetry({ entity: "bookmark", entity_id: del.id, op: "delete", payload: { url: del.url } }, "bookmark_pending_local_intent");
      continue;
    }
    try {
      await browser.bookmarks.remove(node.id);
    } catch (err) {
      await enqueueRetry({ entity: "bookmark", entity_id: del.id, op: "delete", payload: { url: del.url } }, `remove 失败: ${String(err)}`);
      continue;
    }
    delete bmMap[del.id];
    delete base.leaves[node.id];
    stats.deletedBrowser++;
  }
}

/** 库侧目录删除只认稳定身份（名字不证明拥有权）；非空保守跳过，失败入重试队列。 */
async function execFolderDeletes(dels: Array<{ id: string; name: string }>, pc: PullCtx): Promise<void> {
  const { fMap, base, stats } = pc;
  for (const del of dels) {
    const mappedIds = Object.entries(fMap).filter(([, aid]) => aid === del.id).map(([bid]) => bid);
    if (mappedIds.length === 0) {
      console.log(`[sync] folder.delete ${del.id}: no stable browser identity; preserve unclaimed folders`);
      continue;
    }
    const candidates = (await Promise.all(mappedIds.map((bid) => browser.bookmarks.get(bid).catch(() => [])))).flat().filter((n) => n && !n.url);
    for (const c of candidates) {
      if (pc.protectedFolders?.has(c.id)) {
        await enqueueRetry({ entity: "folder", entity_id: del.id, op: "delete", payload: { name: del.name } }, "folder_pending_local_intent");
        continue;
      }
      const children = (await browser.bookmarks.getChildren(c.id).catch(() => [])) ?? [];
      if (children.length > 0) continue; // 非空保守跳过（子书签删除处理后下轮收敛）
      try {
        await browser.bookmarks.removeTree(c.id);
      } catch (err) {
        await enqueueRetry({ entity: "folder", entity_id: del.id, op: "delete", payload: { name: del.name } }, `removeTree 失败: ${String(err)}`);
        continue;
      }
      delete base.folders[c.id];
      delete fMap[c.id];
      stats.deletedBrowser++;
    }
  }
}

// ---------- 浏览器侧删除计划（tick 与 rebuild 共用；R01） ----------
interface VerifiedDeletes {
  /** 有库侧对应、节点确实消失的删除计划（叶子 + 顶层目录树） */
  plan: BrowserDeletePlan;
  /** URL 变非 http → 退出同步范围（解绑身份，不删库条目） */
  unbinds: string[];
  /** 出存在性基线但无需出操作的叶子：移交收纳盒管线 / 从未入库（库侧无对应） */
  dropLeaves: string[];
  /** 被删目录总数（含子孙，保险丝比例分母口径与历史一致） */
  deletedFolderCount: number;
}

/**
 * 把「存在性基线有、当前树无」核验成删除计划：
 *  - 顶层被删目录须同时满足「节点确实消失」与「有库侧对应身份」才入树删计划；
 *  - 位于树删目录内的叶子不单独出操作——树删及其覆盖的叶子是一个确认单元，不得经另一条路径执行；
 *  - 叶子节点仍在浏览器的：移交收纳盒（出基线）/ URL 变非 http（解绑）/ http 形态异常（保守保留）。
 */
async function verifyBrowserDeletes(existence: Snapshot, walk: Walked, fMap: Record<string, string>, bmMap: Record<string, string>): Promise<VerifiedDeletes> {
  const { inboxExtId } = await getConfig();
  const ds = computeDeletedSets(existence, walk.snapshot);
  const plan = emptyBrowserDeletePlan();
  const treeFids = new Set<string>();
  for (const fid of ds.topDeletedFolderIds) {
    const node = (await browser.bookmarks.get(fid).catch(() => []))[0];
    if (node) continue; // 仍在浏览器（如改名为收纳盒 / 虚拟根名）→ 退出同步范围，不删库
    const appId = fMap[fid];
    if (!appId) continue; // 从未入库：库侧无对应
    plan.folders.push({ browserFolderId: fid, appFolderId: appId, name: existence.folders[fid]?.t ?? "" });
    treeFids.add(fid);
  }
  const appByBrowser = reverseMap(bmMap);
  const unbinds: string[] = [];
  const dropLeaves: string[] = [];
  for (const id of ds.leafCandidates) {
    // 最近被删祖先 → 顶层被删目录；顶层在树删计划内 = 由树删覆盖
    const cover = insideDeletedFolder(id, existence, ds.deletedFolderIds);
    if (cover) {
      let top = cover;
      for (let hops = 0; hops < 64; hops++) {
        const parent = existence.folders[top]?.p;
        if (parent !== undefined && ds.deletedFolderIds.has(parent)) top = parent;
        else break;
      }
      if (treeFids.has(top)) continue;
    }
    const node = (await browser.bookmarks.get(id).catch(() => []))[0];
    if (node?.url) {
      const parentNode = node.parentId ? (await browser.bookmarks.get(node.parentId).catch(() => []))[0] : undefined;
      if (node.parentId === inboxExtId || parentNode?.title === INBOX_FOLDER_TITLE) dropLeaves.push(id); // 移交收纳盒管线
      else if (!/^https?:/.test(node.url)) unbinds.push(id); // 退出同步范围
      // 仍为 http 形态（walk 漏收等异常）→ 保守不动，基线保留
      continue;
    }
    const appId = appByBrowser.get(id);
    if (appId) plan.leaves.push({ browserId: id, appId, url: existence.leaves[id]?.u ?? "" });
    else dropLeaves.push(id); // 从未入库：库侧无对应，出基线即可
  }
  return { plan, unbinds, dropLeaves, deletedFolderCount: ds.deletedFolderIds.size };
}

// ---------- 出站队列发送（R02/R05/R07：先落盘、成功才出队、失败复用原 opId） ----------
interface DrainCtx extends PlaceCtx {
  outbox: OutOp[];
  base: Snapshot;
  fMap: Record<string, string>;
  revisions: Record<string, number>;
  rejected: Record<string, RejectedRecord>;
  walk: Walked;
}

async function drainOutbox(dc: DrainCtx): Promise<void> {
  if (dc.outbox.length === 0) return;
  // 补齐旧队列里仍可从目标 browser 身份推导的依赖，不改变 mut/opId/baseRevision。
  const byEntity = new Map(dc.outbox.map((op) => [op.entity, op] as const));
  for (const op of dc.outbox) {
    const target = op.mut.parentBrowserFolderId ?? op.mut.toBrowserFolderId ?? op.mut.browserFolderId;
    const parent = typeof target === "string" ? byEntity.get(fdKey(target)) : undefined;
    if (parent && parent !== op) op.deps = Array.from(new Set([...(op.deps ?? []), parent.opId]));
  }
  await writeOutbox(dc.outbox);
  const attempted = new Set<string>();
  const state: DrainState = { base: dc.base, bmMap: dc.bmMap, fMap: dc.fMap, revisions: dc.revisions, rejected: dc.rejected, stats: dc.stats };
  const persist = async (): Promise<void> => {
    // 回执、映射、基线与剩余队列同次落盘，SW 重启不会看到「已出队但身份仍是旧值」。
    await browser.storage.local.set({ [OUTBOX_KEY]: dc.outbox, [FOLDER_MAP_KEY]: dc.fMap, [BOOKMARK_MAP_KEY]: dc.bmMap, [SNAPSHOT_KEY]: dc.base, [REVISIONS_KEY]: dc.revisions, [REJECTED_KEY]: dc.rejected });
  };
  for (;;) {
    const chunk = readyOutboxOps(dc.outbox).filter((op) => !attempted.has(op.opId) && dc.rejected[op.entity]?.error !== AMBIGUOUS_FOLDER_COPIES).slice(0, MUT_BATCH);
    if (chunk.length === 0) break;
    let results: ApplyResult[];
    try {
      results = await applyMutations(dc.deviceId, chunk.map((op) => ({ ...composePayload(op), ...(op.kind === "folder.ensure" && dc.walk.liveBrowserFolderIds ? { liveBrowserFolderIds: dc.walk.liveBrowserFolderIds } : {}) })));
    } catch (err) {
      for (const op of chunk) { op.attempts++; op.lastError = String(err).slice(0, 200); }
      await persist();
      break; // 可能已提交：下一轮复用同 opId；其依赖子树本轮绝不发送
    }
    const done = new Set<string>();
    for (let j = 0; j < chunk.length; j++) {
      const op = chunk[j]!;
      attempted.add(op.opId);
      const r: ApplyResult = results[j] ?? { kind: op.kind, status: "failed", error: "no_result" };
      const outcome = applyOpResult(state, op, r, Date.now());
      const succeeded = ["ok", "bound", "noop"].includes(r.status) && outcome.remove;
      const hasDependents = dc.outbox.some((child) => child.deps?.includes(op.opId));
      // 只有成功回执能解除依赖。即使父被终态拒绝，也保留它作为阻塞原因，不让子在下轮绕过。
      if (outcome.remove && (succeeded || !hasDependents)) done.add(op.opId);
      else { op.attempts++; op.lastError = outcome.error ?? outcome.rejectedError ?? `dependency_parent_${r.status}`; }
      if (outcome.rejectedError) console.warn(`[sync] 操作被拒绝 ${op.kind} ${op.entity}: ${outcome.rejectedError}`);
      if (outcome.realign) {
        const cur = outcome.realign;
        try { await placeBookmark({ id: cur.id, folder_id: cur.folder_id, title: cur.title, url_raw: cur.url_raw }, dc); }
        catch (err) { console.warn("[sync] conflict re-align failed:", String(err).slice(0, 120)); }
      }
    }
    const left = dc.outbox.filter((op) => !done.has(op.opId));
    dc.outbox.splice(0, dc.outbox.length, ...left);
    await persist(); // 父成功并落盘后，下一波才可发送子
  }
  const pendingIds = new Set(dc.outbox.map((op) => op.opId));
  for (const op of dc.outbox) {
    if (attempted.has(op.opId)) continue;
    if (dc.rejected[op.entity]?.error === AMBIGUOUS_FOLDER_COPIES) { op.lastError = AMBIGUOUS_FOLDER_COPIES; continue; }
    const dep = op.deps?.find((id) => pendingIds.has(id));
    if (dep) op.lastError = `dependency_pending: ${dep}`;
  }
  await persist();
}

// ---------- 重建（首次对齐 / 过期恢复共用；R01/R06） ----------
/**
 * doRebuild(mode)：
 *  - fresh（首次开启 / 基线丢失）：已确认基线为空 → 浏览器现有内容全部作为本地意图落库；
 *  - recover（pull reset_required）：先按已确认基线 diff 出本地未提交意图（目录新建 / 改名 / 搬家 /
 *    书签增改移删，含保险丝判定）持久化进 出站队列并发送；再取一致性快照把浏览器收敛到库态。
 * 快照在本地意图落库之后读取（已含成功的意图），基线与游标建立在同一水位上——快照后的并发变更
 * 由下一轮 pull（id > 水位）补齐。有待处理操作 / 挂起删除覆盖的实体在收敛时受保护，不被库态回退。
 */
async function doRebuild(mode: "fresh" | "recover"): Promise<SyncInfo> {
  const startedAt = Date.now();
  const deviceId = await getDeviceId();
  const stats = zeroStats();
  const recover = mode === "recover";
  const walk = await walkBrowser();
  const persisted = recover ? await readObj<Snapshot | null>(SNAPSHOT_KEY, null) : null;
  // base.leaves = 已确认基线（书签）；base.folders = 存在性基线（删除检测）
  const base: Snapshot = recover && persisted ? cloneSnapshot(persisted) : { leaves: {}, folders: {} };
  const existence: Snapshot = recover && persisted ? cloneSnapshot(persisted) : { leaves: {}, folders: {} };
  const bmMap = await readObj<Record<string, string>>(BOOKMARK_MAP_KEY, {});
  const fMap = await readObj<Record<string, string>>(FOLDER_MAP_KEY, {});
  const revisions = await readObj<Record<string, number>>(REVISIONS_KEY, {});
  // 即使基线丢失也不能清未决出站操作：同 opId 的响应丢失重放仍是安全边界。
  let outbox = await readOutbox();
  const rejected = await readRejected();
  let browserPlan = await readBrowserPlan();
  // 旧日志的重试队列已被快照取代（库态已含那些事件的结果）
  await writeRetryQueue([]);
  const folders = await fetchAppFolders();
  await mergeServerFolderIdentities(deviceId, fMap);
  console.log(`[rebuild] mode=${mode} leaves=${walk.leafList.length} folders=${walk.folderOrder.length} pendingOps=${outbox.length}`);

  // ① 本地意图 → 出站操作（与 tick 共用删除计划与保险丝判定），先落盘再发送
  const del = await verifyBrowserDeletes(existence, walk, fMap, bmMap);
  for (const id of del.dropLeaves) delete base.leaves[id];
  const droppedEntities = new Set(del.dropLeaves.map(bmKey));
  outbox = outbox.filter((o) => o.kind === "bookmark.delete" || !droppedEntities.has(o.entity));
  const guard = evaluateDeleteGuard(del.plan, del.deletedFolderCount, Object.keys(existence.leaves).length, Object.keys(existence.folders).length);
  if (guard.any) {
    browserPlan = mergeBrowserDeletePlan(browserPlan, del.plan, Date.now());
    await writeBrowserPlan(browserPlan);
  }
  const push = buildPushOps({
    walk,
    confirmedLeaves: base.leaves,
    existence,
    folders,
    fMap,
    bmMap,
    revisions,
    outbox,
    retryEntities: new Set<string>(),
    rejected,
    deletePlan: guard.any ? emptyBrowserDeletePlan() : del.plan,
    unbinds: del.unbinds,
    now: Date.now(),
    newOpId,
  });
  const superseded = new Set(push.superseded);
  outbox = [...outbox.filter((o) => !superseded.has(o.opId)), ...push.ops];
  await browser.storage.local.set({ [OUTBOX_KEY]: outbox, [SNAPSHOT_KEY]: base, [FOLDER_MAP_KEY]: fMap, [REJECTED_KEY]: rejected });
  await drainOutbox({ deviceId, outbox, base, bmMap, fMap, revisions, rejected, stats, folders, walk });

  // ② 一致性快照（已含本地已成功落库的意图）→ 同边界重建
  const S = await api<SyncSnapshot>("/sync/snapshot", {});
  const libFolders = indexFolders(S.folders);
  const libById = new Map(S.bookmarks.map((b) => [b.id, b] as const));
  await setStorage({ [GENERATION_KEY]: S.generation });
  const pendingBm = (): Set<string> => new Set(outbox.filter((o) => o.entity.startsWith("bm:")).map((o) => o.entity.slice(3)));
  const pendingFd = (): Set<string> => new Set(outbox.filter((o) => o.entity.startsWith("fd:")).map((o) => o.entity.slice(3)));
  // 保护集：挂起删除覆盖的条目 / 目录子树（不得在浏览器复活），有待处理操作的实体（不得被库态回退）
  const planApps = new Set(browserPlan.leaves.map((l) => l.appId));
  const planFolderApps = new Set(browserPlan.folders.map((f) => f.appFolderId));
  const protectedLocal = pendingProtection(walk.snapshot, fMap, outbox);
  // 无法一对一证明归属的 canonical 副本保守不动，标记跨轮保留直到用户消除歧义。
  if (Object.values(rejected).some((r) => r.error === AMBIGUOUS_FOLDER_COPIES)) {
    for (const bid of ambiguousBookmarkCopies(walk.snapshot)) protectedLocal.leaves.add(bid);
  }
  const protectedFolderApps = new Set<string>([...planFolderApps, ...protectedLocal.apps]);
  // 库子树按 parent_id 扩张，不按同名路径前缀误保护/误放另一分支。
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of libFolders.rows.values()) {
      if (row.parent_id && protectedFolderApps.has(row.parent_id) && !protectedFolderApps.has(row.id)) {
        protectedFolderApps.add(row.id);
        grew = true;
      }
    }
  }
  const ctx: PlaceCtx = { deviceId, folders: libFolders, fMap, walk, bmMap, stats, base, protectedFolders: protectedLocal.folders, protectedLeaves: protectedLocal.leaves };
  // ③ 每个库目录用精确 app ID 保障，逐条核验后才登记映射；不再批量 path.ensure 猜身份。
  for (const appFolderId of libFolders.pathById.keys()) {
    if (libFolders.inboxFolderId === appFolderId || protectedFolderApps.has(appFolderId)) continue;
    await ensureBrowserFolder(appFolderId, ctx);
  }
  console.log(`[rebuild] 库目录树保障完成：${ctx.ensuredFolders?.size ?? 0} 目录`);

  // ④ 库 → 浏览器：按快照放置 / 对齐（保护集内的条目跳过）
  const pendingBmNow = pendingBm();
  const placeIsolated = async (b: LibBookmark): Promise<void> => {
    try {
      await placeBookmark(b, ctx);
    } catch (err) {
      await setStorage({ mfSyncLastError: `rebuild place 失败: ${String(err).slice(0, 120)}` });
    }
  };
  for (const b of S.bookmarks) {
    if (libFolders.inboxFolderId && b.folder_id === libFolders.inboxFolderId) continue;
    if (protectedFolderApps.has(b.folder_id) || planApps.has(b.id)) continue;
    const bid = bmMap[b.id];
    if (bid && (pendingBmNow.has(bid) || protectedLocal.leaves.has(bid))) continue;
    await placeIsolated(b);
  }
  await convergeInboxEntries(ctx);

  // ⑤ 孤儿清理：库已删 → 浏览器侧删除（有待处理操作的节点不动）
  const idn = await api<{ identities: Array<{ browser_bookmark_id: string; app_exists: boolean }> }>(
    `/browser/identities?deviceId=${encodeURIComponent(deviceId)}`,
    {},
  );
  const serverBmIds = new Set(idn.identities.map((i) => i.browser_bookmark_id));
  for (const i of idn.identities) {
    if (i.app_exists) continue;
    if (pendingBm().has(i.browser_bookmark_id) || protectedLocal.leaves.has(i.browser_bookmark_id)) continue;
    const node = (await browser.bookmarks.get(i.browser_bookmark_id).catch(() => []))[0];
    if (node?.url) {
      await browser.bookmarks.remove(node.id).catch(() => undefined);
      delete base.leaves[i.browser_bookmark_id];
      stats.deletedBrowser++;
    }
  }

  // ⑥ 新代际身份重建：本地有映射、服务端无身份的节点 → 以 create 按 URL 重新绑定（不新建、不复活）
  const curWalk = await walkBrowser();
  const localByBrowser = reverseMap(bmMap);
  const rebind: OutOp[] = [];
  for (const l of curWalk.leafList) {
    if (serverBmIds.has(l.id) || pendingBm().has(l.id) || protectedLocal.leaves.has(l.id) || !localByBrowser.has(l.id)) continue;
    const leaf = curWalk.snapshot.leaves[l.id]!;
    rebind.push(newOp("bookmark.create", bmKey(l.id), {
      kind: "bookmark.create",
      browserId: l.id,
      url: leaf.u,
      title: (leaf.t || leaf.u).slice(0, 500),
      folderPath: l.path,
      folderRoot: l.root,
      browserFolderId: leaf.p,
    }));
  }
  if (rebind.length > 0) {
    outbox.push(...rebind);
    await writeOutbox(outbox);
    await drainOutbox({ deviceId, outbox, base, bmMap, fMap, revisions, rejected, stats, folders: libFolders, walk: curWalk });
  }

  // ⑦ 全目录按库顺序重排（受保护 / 待处理目录不重排，避免按库路径重建重复目录）
  ctx.walk = curWalk;
  for (const appFolderId of libFolders.pathById.keys()) {
    if (libFolders.inboxFolderId === appFolderId || protectedFolderApps.has(appFolderId)) continue;
    const byIdentity = livingBrowserFolder(fMap, appFolderId, curWalk.snapshot);
    if (byIdentity && pendingFd().has(byIdentity)) continue;
    await resortFolder(appFolderId, bmMap, ctx);
    stats.resortedFolders++;
  }
  await mergeDuplicateInboxFolders();
  await pruneEmptyMirrorFolders().catch(() => 0);

  // ⑧ 基线重建 = 库态经身份映射到浏览器节点；游标 = 快照水位（同一边界）
  const finalWalk = await walkBrowser();
  const newBase: Snapshot = { leaves: {}, folders: { ...finalWalk.snapshot.folders } };
  const pendingBmFinal = pendingBm();
  for (const [appId, bid] of Object.entries(bmMap)) {
    const lib = libById.get(appId);
    const node = finalWalk.snapshot.leaves[bid];
    if (!lib || !node) continue;
    if (pendingBmFinal.has(bid) || protectedLocal.leaves.has(bid)) {
      // 待分离子树的书签也保留库侧已确认身份：p 未变时仍可由 f 检出归属待重提。
      newBase.leaves[bid] = { u: lib.url_raw, t: lib.title, p: livingBrowserFolder(fMap, lib.folder_id, finalWalk.snapshot) ?? node.p, f: lib.folder_id };
    } else {
      newBase.leaves[bid] = { ...node, f: lib.folder_id };
    }
  }
  // 修订缓存从实际快照初始化（含本轮已落库的操作）
  const newRevisions: Record<string, number> = {};
  for (const b of S.bookmarks) if (typeof b.content_revision === "number") newRevisions[b.id] = b.content_revision;

  const libPending = await readPendingDeletes();
  const libPendingCount = libPending.bookmarks.length + libPending.folders.length;
  const planCount = browserPlan.leaves.length + browserPlan.folders.length;
  const info: SyncInfo = {
    at: Date.now(),
    phase: "align",
    ok: true,
    state: planCount + libPendingCount > 0 ? "pending_confirm" : outbox.length > 0 ? "retrying" : "ok",
    stats,
    alignMs: Date.now() - startedAt,
    outboxCount: outbox.length,
    rejectedCount: Object.keys(rejected).length,
    pendingDeleteCount: planCount + libPendingCount,
  };
  if (planCount > 0) info.deleteGuard = { side: "browser", count: planCount };
  else if (libPendingCount > 0 && info.deleteGuard === undefined) info.deleteGuard = { side: "library", count: libPendingCount };
  if (outbox.length > 0) info.error = outbox[outbox.length - 1]!.lastError;
  else if (Object.keys(rejected).length > 0) {
    const last = Object.values(rejected).sort((a, b) => b.at - a.at)[0]!;
    info.error = `${Object.keys(rejected).length} 条操作被服务端拒绝：${last.error}`;
    info.state = "error";
  }

  await setStorage({
    [SNAPSHOT_KEY]: newBase,
    [BOOKMARK_MAP_KEY]: bmMap,
    [FOLDER_MAP_KEY]: fMap,
    [REVISIONS_KEY]: newRevisions,
    [OUTBOX_KEY]: outbox,
    [REJECTED_KEY]: rejected,
    syncCursor: S.watermark,
    favoritesSync: true,
    mfSyncLastError: info.state === "error" ? info.error : outbox.length > 0 ? info.error ?? null : null,
  });
  console.log(`[rebuild] 完成 mode=${mode} watermark=${S.watermark} outbox=${outbox.length} plan=${planCount} state=${info.state} ${info.alignMs}ms`);
  // catch-up：重建期间用户又动了树 → 补一轮 tick（幂等）；有待处理 / 被拒操作时不空转
  if (outbox.length === 0 && Object.keys(rejected).length === 0 && treesDiffer(newBase, (await walkBrowser()).snapshot)) scheduleSyncTick(5_000);
  return info;
}

// ---------- 增量 tick ----------
async function doTick(confirmDeletes: boolean): Promise<SyncInfo> {
  const deviceId = await getDeviceId();
  const stats = zeroStats();
  const { syncCursor = 0 } = await getConfig();
  const snapshot = await readObj<Snapshot | null>(SNAPSHOT_KEY, null);
  if (!snapshot) { console.warn("[sync] tick 基线丢失 → fresh 重建（保留未决出站操作）"); return doRebuild("fresh"); } // 基线丢失 → 全量重建自愈
  const bmMap = await readObj<Record<string, string>>(BOOKMARK_MAP_KEY, {});
  const fMap = await readObj<Record<string, string>>(FOLDER_MAP_KEY, {});
  const revisions = await readObj<Record<string, number>>(REVISIONS_KEY, {});
  let outbox = await readOutbox();
  const rejected = await readRejected();
  let browserPlan = await readBrowserPlan();
  const info: SyncInfo = { at: Date.now(), phase: "tick", ok: true, stats };
  // base.leaves = 已确认基线（只在成功回执 / pull 应用后推进）；base.folders = 存在性基线
  const base = cloneSnapshot(snapshot);

  // ⓪ 确认放行：挂起的浏览器侧删除计划 → 出站操作（逐条回执，失败保留重试）。
  // 先复核确认范围：挂起期间已恢复的条目不再删除。确认只释放已挂起的范围——
  // 之后新出现的删除仍走保险丝（不以「已确认」为名越范围执行）。
  if (confirmDeletes) {
    const walkNow = await walkBrowser();
    const v = validateBrowserDeletePlan(browserPlan, walkNow.snapshot, bmMap, fMap);
    for (const id of v.droppedLeaves) delete base.leaves[id];
    for (const fid of v.droppedFolders) pruneSubtree(base, fid);
    for (const d of v.plan.leaves) {
      if (!outbox.some((o) => o.entity === bmKey(d.browserId))) outbox.push(newOp("bookmark.delete", bmKey(d.browserId), { kind: "bookmark.delete", browserId: d.browserId }));
    }
    for (const f of v.plan.folders) {
      if (!outbox.some((o) => o.entity === fdKey(f.browserFolderId))) {
        outbox.push(newOp("folder.deleteTree", fdKey(f.browserFolderId), { kind: "folder.deleteTree", appFolderId: f.appFolderId, browserFolderId: f.browserFolderId }));
      }
    }
    browserPlan = emptyBrowserDeletePlan();
    await writeBrowserPlan(browserPlan);
    await writeOutbox(outbox);
  }

  let walk = await walkBrowser();
  // D75：存在性基线 = 旧基线 ∪ 开局 walk 所见——对齐后新建的目录即刻登记，删除检测不漏；
  // 保留旧基线项使保险丝 / 失败挂起的删除下轮继续检出（成功树删后才剪枝）。
  // 注意：这里登记的是「存在性」，目录的改名 / 搬家 / 新建以 /folders 派生的库态为确认依据（R02）。
  base.folders = { ...snapshot.folders, ...walk.snapshot.folders };
  const folders = await fetchAppFolders();
  await mergeServerFolderIdentities(deviceId, fMap);

  // ① 拉取：库 → 浏览器（先重放失败积压，再拉新增量；共用 applyPullEvent）
  // 在 pull 改写浏览器之前修复活别名；否则旧库态会先把待分离子树的书签搬走。
  if (folderIdentitySplits(fMap, walk).size > 0 || outbox.some((op) => op.identityRepair) || Object.values(rejected).some((r) => r.error === AMBIGUOUS_FOLDER_COPIES)) {
    console.warn("[sync] 活目录身份冲突/修复未决 → recover（先持久化本地意图，保护子树）");
    return doRebuild("recover");
  }
  const pendingLocal = pendingProtection(walk.snapshot, fMap, outbox);
  const ctx: PlaceCtx = { deviceId, folders, fMap, walk, bmMap, stats, base, protectedFolders: pendingLocal.folders, protectedLeaves: pendingLocal.leaves };
  // 拉取前浏览器侧已有未提交修改的实体：本轮库侧若也改它 = 真实并发冲突（按约定策略库侧优先并留痕）
  const localEditApps = new Set<string>();
  {
    const appByBrowser = reverseMap(bmMap);
    for (const l of walk.leafList) {
      const leaf = walk.snapshot.leaves[l.id]!;
      const prev = snapshot.leaves[l.id];
      if (!prev || prev.u !== leaf.u || prev.t !== leaf.t || prev.p !== leaf.p) {
        const appId = appByBrowser.get(l.id);
        if (appId) localEditApps.add(appId);
      }
    }
  }
  const pc: PullCtx = { ...ctx, base, fMap, walk, deleteEvents: [], folderDeletes: [], touched: new Set<string>(), revisions, localEditApps };
  const { deleteEvents, folderDeletes, touched } = pc;
  let cursor = syncCursor;
  {
    const retryQ = await readRetryQueue();
    const left: RetryEntry[] = [];
    for (const entry of retryQ) {
      try {
        await applyPullEvent(entry.item, pc);
        stats.pulledApplied++;
      } catch (err) {
        left.push({ ...entry, attempts: entry.attempts + 1, lastError: String(err).slice(0, 200) });
      }
    }
    await writeRetryQueue(left);
  }
  // pull 携带库代际；服务端判定游标过期 → reset_required → 快照重建（不静默跳事件）
  const storedGen = await readObj<string | null>(GENERATION_KEY, null);
  let resetRequired = false;
  for (;;) {
    const pull = await api<{ items: PullItem[]; cursor: number; reset_required?: boolean; generation?: string }>(
      `/sync/pull?cursor=${cursor}&device=${encodeURIComponent(deviceId)}${storedGen ? `&gen=${encodeURIComponent(storedGen)}` : ""}`,
      {},
    );
    if (pull.generation) await setStorage({ [GENERATION_KEY]: pull.generation });
    if (pull.reset_required) {
      console.warn("[sync] pull reset_required——游标越过保留边界 / 库代际不符，走快照重建");
      resetRequired = true;
      break;
    }
    for (const it of pull.items) {
      console.log(`[pull] ${it.id ?? "?"} ${it.entity}.${it.op}`);
      try {
        await applyPullEvent(it, pc);
      } catch (err) {
        const reason = `pull ${it.entity}.${it.op} 失败: ${String(err).slice(0, 120)}`;
        console.warn(`[sync] ${reason}`);
        await enqueueRetry(it, reason); // 失败事件持久化入队——游标可安全越过，下轮开头重放
      }
    }
    cursor = pull.cursor;
    if (pull.items.length < 500) break;
  }
  if (resetRequired) return doRebuild("recover");

  // 库侧删除：挂起的（确认时并入本轮）；保险丝触发则持久化挂起
  if (confirmDeletes) {
    const persisted = await readPendingDeletes();
    deleteEvents.unshift(...persisted.bookmarks);
    folderDeletes.unshift(...persisted.folders);
    await writePendingDeletes({ bookmarks: [], folders: [], at: 0 });
  }
  const { deletedFolderIds } = computeDeletedSets(snapshot, walk.snapshot);
  const folderGuard = !confirmDeletes && deletedFolderIds.size > 3 && deletedFolderIds.size > Object.keys(snapshot.folders).length * 0.5;
  if (deleteEvents.length > 0 || folderDeletes.length > 0) {
    const bookmarkGuard = !confirmDeletes && guardHit(deleteEvents.length, Object.keys(snapshot.leaves).length);
    if (bookmarkGuard || folderGuard) {
      info.deleteGuard = bookmarkGuard
        ? { side: "library", count: deleteEvents.length + folderDeletes.length }
        : { side: "browser", count: deletedFolderIds.size };
      // 任一侧保险丝触发，库侧删除事件都必须持久化（游标已越过，不持久化即丢失）
      const persisted = await readPendingDeletes();
      const seenB = new Set(persisted.bookmarks.map((d) => d.id));
      const seenF = new Set(persisted.folders.map((d) => d.id));
      for (const d of deleteEvents) if (!seenB.has(d.id)) persisted.bookmarks.push(d);
      for (const d of folderDeletes) if (!seenF.has(d.id)) persisted.folders.push(d);
      persisted.at = Date.now();
      await writePendingDeletes(persisted);
    } else {
      await execBookmarkDeletes(deleteEvents, pc);
    }
  }
  // 拉取处理后重建目录映射——本批新建的浏览器目录必须入册，否则同批「目录删除」事件反查落空
  walk = await walkBrowser();
  // 目录删除：保险丝挂起时已随上面持久化，未挂起才执行
  if (!info.deleteGuard) await execFolderDeletes(folderDeletes, pc);
  // 孤儿目录清扫：fMap 中映射的库目录已不存在且浏览器目录为空 → 移除（非空保守保留）
  for (const [browserId, appFolderId] of Object.entries(fMap)) {
    if (ctx.protectedFolders?.has(browserId)) continue;
    if (!folders.pathById.has(appFolderId)) {
      const node = (await browser.bookmarks.get(browserId).catch(() => []))[0];
      if (!node || node.url) continue;
      const children = (await browser.bookmarks.getChildren(browserId).catch(() => [])) ?? [];
      if (children.length > 0) continue;
      await browser.bookmarks.remove(browserId).catch(() => undefined);
      delete base.folders[browserId];
      delete fMap[browserId];
      stats.deletedBrowser++;
    }
  }

  // ②' D72 收纳盒残留收敛：节点仍在投递口而库内条目已归位 → placeBookmark 移入目标目录
  {
    const { inboxExtId } = await getConfig();
    if (inboxExtId) {
      const children = (await browser.bookmarks.getChildren(inboxExtId).catch(() => [])) ?? [];
      const idn =
        children.length > 0
          ? await api<{ identities: Array<{ browser_bookmark_id: string; app_bookmark_id: string; app_exists: boolean }> }>(
              `/browser/identities?deviceId=${encodeURIComponent(deviceId)}`,
              {},
            )
          : { identities: [] };
      const byBrowser = new Map(idn.identities.map((i) => [i.browser_bookmark_id, i] as const));
      for (const child of children) {
        if (!child.url) continue;
        const i = byBrowser.get(child.id);
        if (!i || !i.app_exists) continue;
        const b = (await api<LibBookmark>(`/bookmarks/${i.app_bookmark_id}`, {}).catch(() => null)) as LibBookmark | null;
        if (!b || (folders.inboxFolderId && b.folder_id === folders.inboxFolderId)) continue;
        try {
          await placeBookmark({ id: b.id, folder_id: b.folder_id, title: b.title, url_raw: b.url_raw }, ctx);
          stats.pulledApplied++;
        } catch (err) {
          await setStorage({ mfSyncLastError: `inbox residual place 失败: ${String(err).slice(0, 120)}` });
        }
      }
    }
  }
  // ②'' D78 收纳盒入口收敛：库内盒中条目 → 浏览器节点必须在投递口
  await convergeInboxEntries(ctx);

  // ② 推送：pull / 收纳盒收敛已改写浏览器树 → 重新扫描，按已确认基线 diff → 出站队列
  walk = await walkBrowser();
  pc.walk = walk;
  ctx.walk = walk;
  const retryEntities = new Set((await readRetryQueue()).map((e) => e.item.entity_id));
  const del = await verifyBrowserDeletes(snapshot, walk, fMap, bmMap);
  for (const id of del.dropLeaves) delete base.leaves[id];
  const droppedEntities = new Set(del.dropLeaves.map(bmKey));
  outbox = outbox.filter((o) => o.kind === "bookmark.delete" || !droppedEntities.has(o.entity));
  // 已在出站队列（确认放行 / 上轮未决）的删除不再计入新计划——它们不算「新出现的删除」，
  // 剩余的新删除照常走保险丝
  const pendingEntities = new Set(outbox.map((o) => o.entity));
  const freshPlan: BrowserDeletePlan = {
    leaves: del.plan.leaves.filter((l) => !pendingEntities.has(bmKey(l.browserId))),
    folders: del.plan.folders.filter((f) => !pendingEntities.has(fdKey(f.browserFolderId))),
    at: Date.now(),
  };
  const browserGuard = evaluateDeleteGuard(freshPlan, del.deletedFolderCount, Object.keys(snapshot.leaves).length, Object.keys(snapshot.folders).length);
  if (browserGuard.any) {
    browserPlan = mergeBrowserDeletePlan(browserPlan, freshPlan, Date.now());
    await writeBrowserPlan(browserPlan);
    if (!info.deleteGuard || browserGuard.bookmark) info.deleteGuard = { side: "browser", count: browserPlan.leaves.length + browserPlan.folders.length };
  }
  const push = buildPushOps({
    walk,
    confirmedLeaves: base.leaves,
    existence: snapshot,
    folders,
    fMap,
    bmMap,
    revisions,
    outbox,
    retryEntities,
    rejected,
    deletePlan: browserGuard.any ? emptyBrowserDeletePlan() : freshPlan,
    unbinds: del.unbinds,
    now: Date.now(),
    newOpId,
  });
  const superseded = new Set(push.superseded);
  outbox = [...outbox.filter((o) => !superseded.has(o.opId)), ...push.ops];
  if (push.ops.length > 0 || superseded.size > 0) await browser.storage.local.set({ [OUTBOX_KEY]: outbox, [SNAPSHOT_KEY]: base, [FOLDER_MAP_KEY]: fMap, [REJECTED_KEY]: rejected });
  await drainOutbox({ deviceId, outbox, base, bmMap, fMap, revisions, rejected, stats, folders, walk });

  // ③ 受影响目录重排（库顺序权威）
  for (const fid of touched) {
    await resortFolder(fid, bmMap, ctx);
    stats.resortedFolders++;
  }
  await mergeDuplicateInboxFolders();

  // ④ 固化：游标与状态机。存在性基线已在开局按 D75 合并（旧基线 ∪ 开局 walk），
  // 本轮内成功树删 / 孤儿清扫的剪枝直接作用其上——此处不得再用旧基线整体覆盖，否则已删目录被写回，
  // 每轮重复检出并重发树删（noop 空转），甚至反复触发目录保险丝。
  const retryLeft = await readRetryQueue();
  const libPending = await readPendingDeletes();
  const libPendingCount = libPending.bookmarks.length + libPending.folders.length;
  const planCount = browserPlan.leaves.length + browserPlan.folders.length;
  const rejectedCount = Object.keys(rejected).length;
  info.outboxCount = outbox.length;
  info.rejectedCount = rejectedCount;
  info.conflicts = stats.conflicts;
  info.retryCount = retryLeft.length;
  info.pendingDeleteCount = planCount + libPendingCount;
  info.state =
    planCount + libPendingCount > 0 ? "pending_confirm" : retryLeft.length > 0 || outbox.length > 0 ? "retrying" : rejectedCount > 0 ? "error" : "ok";
  if (retryLeft.length > 0) info.error = retryLeft[retryLeft.length - 1]!.lastError;
  else if (outbox.length > 0) info.error = outbox[outbox.length - 1]!.lastError;
  else if (rejectedCount > 0) {
    const last = Object.values(rejected).sort((a, b) => b.at - a.at)[0]!;
    info.error = `${rejectedCount} 条操作被服务端拒绝：${last.error}`;
  }
  if (planCount > 0) info.deleteGuard = info.deleteGuard?.side === "library" ? info.deleteGuard : { side: "browser", count: planCount };
  await setStorage({
    [SNAPSHOT_KEY]: base,
    [BOOKMARK_MAP_KEY]: bmMap,
    [FOLDER_MAP_KEY]: fMap,
    [REVISIONS_KEY]: revisions,
    [OUTBOX_KEY]: outbox,
    [REJECTED_KEY]: rejected,
    syncCursor: cursor,
    mfSyncLastError: info.state === "error" || info.state === "retrying" ? info.error ?? null : null,
  });
  console.log(`[sync] tick: del=${deleteEvents.length} folderDel=${folderDeletes.length} outbox=${outbox.length} plan=${planCount} libPending=${libPendingCount} state=${info.state}`);
  const after = await walkBrowser();
  // 中途有用户改动 → 补一轮；有待处理 / 被拒操作 / 挂起删除时不空转（它们由常规触发重试）
  if (outbox.length === 0 && rejectedCount === 0 && planCount === 0 && treesDiffer(base, after.snapshot)) scheduleSyncTick(5_000);
  return info;
}

/**
 * D51 存量自愈：书签栏根下出现多个「📥 收纳盒」时（旧版引擎误建），
 * 保留正主（config.inboxExtId，缺省取第一个），其余文件夹内书签按 URL 去重后移回正主，移空后删除文件夹。
 */
export async function mergeDuplicateInboxFolders(): Promise<number> {
  const { inboxExtId } = await getConfig();
  const barChildren = await browser.bookmarks.getChildren("1").catch(() => []);
  const inboxes = barChildren.filter((n) => !n.url && n.title === INBOX_FOLDER_TITLE);
  if (inboxes.length <= 1) return 0;
  const keep = inboxes.find((n) => n.id === inboxExtId) ?? inboxes[0]!;
  let merged = 0;
  for (const dup of inboxes) {
    if (dup.id === keep.id) continue;
    const children = await browser.bookmarks.getChildren(dup.id).catch(() => []);
    for (const child of children) {
      if (!child.url) continue;
      const sameUrl = await browser.bookmarks.search({ url: child.url }).catch(() => []);
      const alreadyInKeep = sameUrl.some((n) => n.parentId === keep.id);
      if (alreadyInKeep) await browser.bookmarks.remove(child.id).catch(() => undefined);
      else await browser.bookmarks.move(child.id, { parentId: keep.id }).catch(() => undefined);
      merged++;
    }
    const rest = await browser.bookmarks.getChildren(dup.id).catch(() => [{ id: "?" }]);
    if (rest.length === 0) await browser.bookmarks.removeTree(dup.id).catch(() => undefined);
  }
  return merged;
}

// ---------- D50 SSE 推送循环（库 → 浏览器秒级触发） ----------
let eventAbort: AbortController | null = null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function eventLoop(signal: AbortSignal): Promise<void> {
  let backoff = 5000;
  while (!signal.aborted) {
    try {
      const { serverUrl, token } = await getConfig();
      const res = await fetch(`${serverUrl}/api/v1/events/stream`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`sse http ${res.status}`);
      backoff = 5000;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut = buf.indexOf("\n\n");
        while (cut >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          if (frame.includes("event: change")) scheduleSyncTick(3000); // 门铃：数据真相走 /sync/pull
          cut = buf.indexOf("\n\n");
        }
      }
    } catch {
      /* 断线走退避重连；SW 死亡由告警兜底 */
    }
    if (signal.aborted) return;
    await sleep(backoff);
    backoff = Math.min(60_000, backoff * 2);
  }
}

/** 幂等启动事件流循环（SW 重启 / 开关重开都可再调） */
export function startEventStream(): void {
  if (eventAbort) return;
  const ac = new AbortController();
  eventAbort = ac;
  void eventLoop(ac.signal).finally(() => {
    if (eventAbort === ac) eventAbort = null;
  });
}

export function stopEventStream(): void {
  eventAbort?.abort();
  eventAbort = null;
}

// ---------- 对外 API ----------
export async function setFavoritesSync(on: boolean): Promise<SyncInfo> {
  await saveConfig({ favoritesSync: on });
  // 同步状态上报服务端——开启停发镜像 ops，关闭恢复 legacy 镜像语义
  const deviceId = await getDeviceId();
  void api("/devices/sync-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, enabled: on }),
  }).catch(() => undefined);
  if (!on) {
    stopEventStream();
    await browser.alarms.clear("mf-sync-tick");
    return { at: Date.now(), phase: "tick", ok: true };
  }
  await browser.alarms.create("mf-sync-tick", { periodInMinutes: 1 });
  startEventStream();
  // 有基线 → 增量 tick 即足够：pull（库→浏览器）+ push diff（浏览器→库，收敛关闭期删除）已完整闭环，
  // 游标过期时 tick 内部自动走 recover。**不得在其后再做 fresh 重建**——fresh 会清空出站队列，
  // 把 tick/recover 留下的待重试操作（含失败保留的目录创建）抹掉（复核 R06 根因）。
  // 无基线（首次开启）才全量重建。保险丝挂起（pending_confirm）由 tick 返回，天然不再重建。
  const hasBaseline = Boolean(await readObj<Snapshot | null>(SNAPSHOT_KEY, null));
  try {
    const info = await runExclusive(async () => {
      if (hasBaseline) return doTick(false);
      return doRebuild("fresh");
    }, "align");
    await setInfoWrapped(info);
    return info;
  } catch (err) {
    await markSyncError(err);
    return { at: Date.now(), phase: "align", ok: false, state: "error", error: String(err).slice(0, 200) };
  }
}

export async function runSyncTick(opts: { confirmDeletes?: boolean } = {}): Promise<SyncInfo> {
  try {
    const { favoritesSync } = await getConfig();
    if (!favoritesSync) return { at: Date.now(), phase: "tick", ok: false, error: "sync_off" };
    const info = await runExclusive(() => doTick(opts.confirmDeletes === true), "tick");
    await setInfoWrapped(info);
    return info;
  } catch (err) {
    await markSyncError(err);
    return { at: Date.now(), phase: "tick", ok: false, state: "error", error: String(err).slice(0, 200) };
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
export function scheduleSyncTick(delayMs = 8_000): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runSyncTick().catch((err) => void markSyncError(err));
  }, delayMs);
  // D74：setTimeout 在 MV3 SW 休眠时静默丢失——一次性 alarm 兜底（alarm 可唤醒 SW）
  void browser.alarms.create("mf-sync-kick", { delayInMinutes: Math.max(delayMs / 60_000, 0.5) });
}

async function runExclusive(fn: () => Promise<SyncInfo>, phase: "align" | "tick"): Promise<SyncInfo> {
  if (running) return running;
  // 统一执行器：引擎与镜像 ops 串行，杜绝双写者并发搬节点
  running = withBrowserExecutor(async (): Promise<SyncInfo> => {
    try {
      return await fn();
    } catch (err) {
      // 整轮失败可观测：失败写状态 + 原因，下轮触发重试
      const info: SyncInfo = { at: Date.now(), phase, ok: false, state: "error", error: String(err).slice(0, 200) };
      await setStorage({ mfSyncLastError: info.error ?? null });
      return info;
    }
  }).finally(() => {
    running = null;
  });
  return running;
}

async function setInfoWrapped(info: SyncInfo): Promise<void> {
  await browser.storage.local.set({ [INFO_KEY]: info });
}
