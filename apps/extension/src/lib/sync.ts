/**
 * D46 收藏夹双向直接同步引擎。
 *
 * 心智模型：开启后「管理台 = 书签的唯一管理面，浏览器收藏夹 = 库的实时视图」。
 * 一个开关取代旧的四个入口（一键导入 / 反向同步 / 重排 / 同步删除）。
 *
 * 每 tick 三步收敛：
 *  1. 拉取（库→浏览器）：/sync/pull 变更日志逐条应用（增/改/移/删）；
 *     本设备推上去的变更日志带 device 标记、被服务端排除（防回环）。
 *  2. 推送（浏览器→库）：当前书签树 diff 上次基线快照 → POST /sync/apply。
 *  3. 重存快照与游标；受影响目录按库顺序（置顶→新入库）就地重排。
 *
 * 触发：开关首次打开（全量对齐）/ 10 分钟告警 / 书签事件防抖 / options「立即同步」。
 * 幂等：任何一步中断，下个 tick 重放即可；引擎自身的浏览器写入会进下一轮快照基线，
 * 不会自我回声（快照即合并基线）。
 *
 * 大规模删除保险丝：单轮内任一侧删除数 > 30 且 > 已知条目 25%（浏览器资料被重置、
 * 库被误清等灾难形态）→ 本轮跳过删除并挂出确认；用户显式确认（confirmDeletes）放行一次。
 */
import { browser } from "wxt/browser";
import { INBOX_FOLDER_TITLE, isVirtualBookmarkRootTitle } from "@mf/shared";
import { api, getConfig, saveConfig } from "./api";
import { getDeviceId, pruneEmptyMirrorFolders } from "./device";

const SNAPSHOT_KEY = "mfSyncSnapshot";
const BOOKMARK_MAP_KEY = "mfSyncBookmarkMap";
const FOLDER_MAP_KEY = "mfSyncFolderMap";
const INFO_KEY = "mfSyncLastInfo";

const PATH_SEP = "\u0000";
const MUT_BATCH = 400;
const GUARD_ABS = 30;
const GUARD_RATIO = 0.25;
const UNTIDY = "未整理"; // 库根目录名（ensurePath 空路径落点）↔ 浏览器书签栏根

interface SnapLeaf { u: string; t: string; p: string }
interface SnapFolder { t: string; p: string }
interface Snapshot { leaves: Record<string, SnapLeaf>; folders: Record<string, SnapFolder> }

export interface SyncStats {
  pulledApplied: number;
  createdInBrowser: number;
  deletedBrowser: number;
  deletedLibrary: number;
  pushedOk: number;
  resortedFolders: number;
}
export interface SyncInfo {
  at: number;
  phase: "align" | "tick";
  ok: boolean;
  error?: string;
  deleteGuard?: { side: "browser" | "library"; count: number };
  stats?: Partial<SyncStats>;
}

interface LibBookmark { id: string; folder_id: string; title: string; url_raw: string }
interface AppFolderRow { id: string; parent_id: string | null; name: string; is_system_inbox?: number }
interface FolderIndex { pathById: Map<string, string[]>; idByPath: Map<string, string>; inboxFolderId: string | null }
interface Walked {
  snapshot: Snapshot;
  leafList: Array<{ id: string; path: string[] }>;
  folderIdByPath: Map<string, string>;
}

type Mutation = Record<string, unknown>;
interface ApplyRes { kind: string; browserId?: string; appBookmarkId?: string; appFolderId?: string; status: string }

let running: Promise<SyncInfo> | null = null;
const zeroStats = (): SyncStats => ({ pulledApplied: 0, createdInBrowser: 0, deletedBrowser: 0, deletedLibrary: 0, pushedOk: 0, resortedFolders: 0 });

const key = (path: string[]): string => path.join(PATH_SEP);

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

// ---------- storage ----------
async function readObj<T>(k: string, fallback: T): Promise<T> {
  return ((await browser.storage.local.get(k))[k] as T | undefined) ?? fallback;
}
export async function getSyncInfo(): Promise<SyncInfo | undefined> {
  return (await browser.storage.local.get(INFO_KEY))[INFO_KEY] as SyncInfo | undefined;
}

// ---------- 浏览器树 ----------
interface BmNode { id: string; title?: string; url?: string; parentId?: string; children?: BmNode[] }

async function walkBrowser(): Promise<Walked> {
  const { inboxExtId } = await getConfig();
  const tree = (await browser.bookmarks.getTree()) as unknown as BmNode[];
  const leaves: Record<string, SnapLeaf> = {};
  const folders: Record<string, SnapFolder> = {};
  const leafList: Array<{ id: string; path: string[] }> = [];
  const folderIdByPath = new Map<string, string>();
  const walk = (nodes: BmNode[], path: string[], depth: number): void => {
    for (const n of nodes) {
      if (n.url) {
        if (!/^https?:/.test(n.url)) continue; // 引擎只管 http(s)（与导入通道同口径）
        leaves[n.id] = { u: n.url, t: n.title ?? n.url, p: n.parentId ?? "" };
        leafList.push({ id: n.id, path });
        continue;
      }
      if (!n.id || n.id === "0") continue;
      // D55：第一层（真根直接子级：书签栏/收藏夹栏/链接/其他收藏夹…）无条件穿透——
      // 它们不是用户文件夹；更深层不穿透（isVirtualBookmarkRootTitle 仅 depth===0 为真）
      if (isVirtualBookmarkRootTitle(n.title, depth)) {
        if (n.children) walk(n.children, path, depth + 1);
        continue;
      }
      if (n.id === inboxExtId || n.title === INBOX_FOLDER_TITLE) continue; // 收纳盒投递口归收纳盒管线管，不参与同步
      folders[n.id] = { t: n.title ?? "", p: n.parentId ?? "" };
      const next = [...path, (n.title ?? "").slice(0, 200)];
      folderIdByPath.set(key(next), n.id);
      if (n.children) walk(n.children, next, depth + 1);
    }
  };
  for (const top of tree) if (top.children) walk(top.children, [], 0);
  return { snapshot: { leaves, folders }, leafList, folderIdByPath };
}

function pathKeyOf(folderId: string, folders: Record<string, SnapFolder>): string[] {
  const out: string[] = [];
  let cur = folders[folderId];
  const seen = new Set<string>();
  while (cur && !seen.has(folderId)) {
    seen.add(folderId);
    out.unshift(cur.t);
    folderId = cur.p;
    cur = folders[folderId];
  }
  return out;
}

// ---------- 服务端读取 ----------
async function fetchAppFolders(): Promise<FolderIndex> {
  const rows = await api<AppFolderRow[]>("/folders", {});
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const pathById = new Map<string, string[]>();
  const idByPath = new Map<string, string>();
  const build = (id: string): string[] => {
    const hit = pathById.get(id);
    if (hit) return hit;
    const r = byId.get(id);
    const p = !r ? [] : r.parent_id ? [...build(r.parent_id), r.name] : [r.name];
    pathById.set(id, p);
    idByPath.set(key(p), id);
    return p;
  };
  for (const r of rows) build(r.id);
  // D51：系统收纳盒是投递口（归收纳盒管线管），同步引擎必须整体绕开——
  // 否则树扫描跳过收纳盒导致 ensureBrowserFolder 永远找不到它，每轮都新建一个重复文件夹
  const inbox = rows.find((r) => r.is_system_inbox === 1);
  return { pathById, idByPath, inboxFolderId: inbox?.id ?? null };
}

async function fetchLibraryAll(): Promise<LibBookmark[]> {
  const out: LibBookmark[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await api<LibBookmark[]>(`/bookmarks?limit=1000&offset=${offset}`, {
      headers: { "x-mf-private": "1" },
    });
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

async function applyMutations(deviceId: string, muts: Mutation[]): Promise<ApplyRes[]> {
  const out: ApplyRes[] = [];
  for (let i = 0; i < muts.length; i += MUT_BATCH) {
    const r = await api<{ results: ApplyRes[]; cursor: number }>("/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId, mutations: muts.slice(i, i + MUT_BATCH) }),
    });
    out.push(...r.results);
  }
  return out;
}

// ---------- 浏览器侧目录保障 ----------
async function ensureBrowserFolder(path: string[], idByPath: Map<string, string>, base?: Snapshot): Promise<string> {
  if (path.length === 0 || (path.length === 1 && path[0] === UNTIDY)) return "1";
  const hit = idByPath.get(key(path));
  if (hit) return hit;
  let parentId = "1";
  const acc: string[] = [];
  for (const name of path) {
    acc.push(name);
    const known = idByPath.get(key(acc));
    if (known) {
      parentId = known;
      continue;
    }
    const created = await browser.bookmarks.create({ parentId, title: name });
    idByPath.set(key(acc), created.id);
    if (base) base.folders[created.id] = { t: name, p: parentId }; // D53：引擎动作记入基线，不被 diff 误报为用户改动
    parentId = created.id;
  }
  return parentId;
}

/** 库→浏览器方向单条放置：无节点则绑/建；有则对齐标题与所在目录（顺序由 resort 收尾） */
async function placeBookmark(
  b: LibBookmark,
  ctx: { deviceId: string; folders: FolderIndex; idByPath: Map<string, string>; bmMap: Record<string, string>; stats: SyncStats; base?: Snapshot },
): Promise<void> {
  if (ctx.folders.inboxFolderId && b.folder_id === ctx.folders.inboxFolderId) return; // D51：收纳盒条目不放置
  const libPath = ctx.folders.pathById.get(b.folder_id) ?? [];
  let bid = ctx.bmMap[b.id];
  let node = bid ? (await browser.bookmarks.get(bid).catch(() => []))[0] : undefined;
  if (!node?.url) {
    const found = (await browser.bookmarks.search({ url: b.url_raw }).catch(() => []))[0];
    if (found?.url) {
      bid = found.id;
      node = found;
      ctx.bmMap[b.id] = bid;
    }
  }
  if (!bid || !node?.url) {
    const parentId = await ensureBrowserFolder(libPath, ctx.idByPath, ctx.base);
    const created = await browser.bookmarks.create({ parentId, title: (b.title || b.url_raw).slice(0, 500), url: b.url_raw });
    await applyMutations(ctx.deviceId, [{ kind: "bookmark.create", browserId: created.id, url: b.url_raw, title: b.title, folderPath: libPath }]);
    ctx.bmMap[b.id] = created.id;
    if (ctx.base) ctx.base.leaves[created.id] = { u: b.url_raw, t: b.title || b.url_raw, p: parentId };
    ctx.stats.createdInBrowser++;
    ctx.stats.pulledApplied++;
    return;
  }
  const patch: { title?: string; url?: string } = {};
  if ((node.title ?? "") !== b.title && b.title) patch.title = b.title.slice(0, 500);
  if ((node.url ?? "") !== b.url_raw && b.url_raw) patch.url = b.url_raw; // D52：库侧改 URL 浏览器跟随
  if (Object.keys(patch).length > 0) {
    await browser.bookmarks.update(bid, patch).catch(() => undefined);
    ctx.stats.pulledApplied++;
  }
  const target = await ensureBrowserFolder(libPath, ctx.idByPath, ctx.base);
  if (node.parentId !== target) {
    await browser.bookmarks.move(bid, { parentId: target }).catch(() => undefined);
    ctx.stats.pulledApplied++;
  }
  if (ctx.base) {
    const cur = ctx.base.leaves[bid];
    if (cur) {
      cur.u = node.url ?? cur.u;
      cur.t = node.title ?? cur.t;
      cur.p = target;
      if (patch.title) cur.t = patch.title;
      if (patch.url) cur.u = patch.url;
    } else {
      ctx.base.leaves[bid] = { u: patch.url ?? b.url_raw ?? node.url ?? "", t: patch.title ?? node.title ?? b.title, p: target };
    }
  }
}

/** 目录内按管理台顺序（GET /bookmarks?folderId= 服务端排序）就地重排 */
async function resortFolder(
  appFolderId: string,
  bmMap: Record<string, string>,
  ctx: { folders: FolderIndex; idByPath: Map<string, string> },
): Promise<void> {
  const rows = await api<LibBookmark[]>(`/bookmarks?folderId=${encodeURIComponent(appFolderId)}&limit=1000&offset=0`, {
    headers: { "x-mf-private": "1" },
  });
  const target = await ensureBrowserFolder(ctx.folders.pathById.get(appFolderId) ?? [], ctx.idByPath);
  let idx = 0;
  for (const row of rows) {
    const bid = bmMap[row.id];
    if (!bid) continue;
    const node = (await browser.bookmarks.get(bid).catch(() => []))[0];
    if (!node?.url) continue;
    await browser.bookmarks.move(bid, { parentId: target, index: idx }).catch(() => undefined);
    idx++;
  }
}

const guardHit = (count: number, known: number): boolean =>
  count > GUARD_ABS && count > Math.max(1, known) * GUARD_RATIO;

// ---------- 首次全量对齐 ----------
async function doAlign(): Promise<SyncInfo> {
  const deviceId = await getDeviceId();
  const stats = zeroStats();
  const walk = await walkBrowser();
  // D53：基线 = 初始树 + 引擎自身动作（增量维护），对齐中途的用户改动留给 catch-up 补轮，
  // 不再用「结尾重扫树」当基线（那会把中途的删除/新增静默吞掉）
  const base = cloneSnapshot(walk.snapshot);
  const bmMap: Record<string, string> = {};
  const fMap: Record<string, string> = {};

  // ① 浏览器 → 库全量（create 幂等：URL 已存在则绑定）
  const muts: Mutation[] = walk.leafList.map((l) => ({
    kind: "bookmark.create",
    browserId: l.id,
    url: walk.snapshot.leaves[l.id]?.u,
    title: (walk.snapshot.leaves[l.id]?.t || walk.snapshot.leaves[l.id]?.u || "").slice(0, 500),
    folderPath: l.path,
  }));
  const res1 = await applyMutations(deviceId, muts);
  for (const r of res1) {
    if (r.appBookmarkId && r.browserId && (r.status === "ok" || r.status === "bound")) {
      bmMap[r.appBookmarkId] = r.browserId;
      if (r.status === "ok") stats.pushedOk++;
    }
  }

  // ② 文件夹双向映射（同路径名即同一目录）
  const folders = await fetchAppFolders();
  for (const [pathStr, browserId] of walk.folderIdByPath) {
    const appFolderId = folders.idByPath.get(pathStr);
    if (appFolderId) fMap[browserId] = appFolderId;
  }

  // ③ 库 → 浏览器：缺位条目 URL 绑定或创建
  const lib = await fetchLibraryAll();
  const ctx = { deviceId, folders, idByPath: walk.folderIdByPath, bmMap, stats, base };
  for (const b of lib) if (!bmMap[b.id]) await placeBookmark(b, ctx);

  // ④ 孤儿映射清理：库已删除 → 浏览器侧删除
  const idn = await api<{ identities: Array<{ browser_bookmark_id: string; app_exists: boolean }> }>(
    `/browser/identities?deviceId=${encodeURIComponent(deviceId)}`,
    {},
  );
  for (const i of idn.identities) {
    if (i.app_exists) continue;
    const node = (await browser.bookmarks.get(i.browser_bookmark_id).catch(() => []))[0];
    if (node?.url) {
      await browser.bookmarks.remove(node.id).catch(() => undefined);
      delete base.leaves[i.browser_bookmark_id];
      stats.deletedBrowser++;
    }
  }

  // ⑤ 放置归位 + 全目录按库顺序重排
  const byFolder = new Map<string, LibBookmark[]>();
  for (const b of lib) {
    const arr = byFolder.get(b.folder_id) ?? [];
    arr.push(b);
    byFolder.set(b.folder_id, arr);
  }
  for (const [fid] of byFolder) {
    if (folders.inboxFolderId && fid === folders.inboxFolderId) continue; // D51：收纳盒目录不参与放置/重排
    for (const b of byFolder.get(fid)!) await placeBookmark(b, ctx); // 幂等：对齐目录与标题
    await resortFolder(fid, bmMap, { folders, idByPath: walk.folderIdByPath });
    stats.resortedFolders++;
  }
  // D51：清理引擎旧版误建的重复「📥 收纳盒」文件夹（存量自愈）
  await mergeDuplicateInboxFolders();

  // ⑥ 清理旧镜像机制的空壳（mf-整理 / my-favorites 同步）
  await pruneEmptyMirrorFolders().catch(() => 0);

  // ⑦ 固化基线：游标取服务端 head（apply 空批即返回 maxChangeId）
  const head = await api<{ results: ApplyRes[]; cursor: number }>("/sync/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, mutations: [] }),
  });
  await browser.storage.local.set({
    [SNAPSHOT_KEY]: base,
    [BOOKMARK_MAP_KEY]: bmMap,
    [FOLDER_MAP_KEY]: { ...fMap },
    syncCursor: head.cursor,
    favoritesSync: true,
  });
  // catch-up：若对齐期间用户又动了树（diff ≠ 空），补一轮 tick 接住（幂等，无变化则空转）
  const after = await walkBrowser();
  if (treesDiffer(base, after.snapshot)) scheduleSyncTick(5_000);
  return { at: Date.now(), phase: "align", ok: true, stats };
}

// ---------- 增量 tick ----------
async function doTick(confirmDeletes: boolean): Promise<SyncInfo> {
  const deviceId = await getDeviceId();
  const stats = zeroStats();
  const { syncCursor = 0 } = await getConfig();
  const snapshot = await readObj<Snapshot | null>(SNAPSHOT_KEY, null);
  if (!snapshot) return doAlign(); // 基线丢失 → 全量对齐自愈
  const bmMap = await readObj<Record<string, string>>(BOOKMARK_MAP_KEY, {});
  const fMap = await readObj<Record<string, string>>(FOLDER_MAP_KEY, {});
  const walk = await walkBrowser();
  const folders = await fetchAppFolders();
  const info: SyncInfo = { at: Date.now(), phase: "tick", ok: true, stats };
  const base = cloneSnapshot(snapshot); // D53：基线增量维护，见 doAlign 同款注释

  // ① 拉取：库 → 浏览器
  const ctx = { deviceId, folders, idByPath: walk.folderIdByPath, bmMap, stats, base };
  let cursor = syncCursor;
  const deleteEvents: Array<string> = [];
  const touched = new Set<string>();
  for (;;) {
    const pull = await api<{ items: Array<{ entity: string; entity_id: string; op: string; payload: unknown }>; cursor: number }>(
      `/sync/pull?cursor=${cursor}&device=${encodeURIComponent(deviceId)}`,
      {},
    );
    for (const it of pull.items) {
      if (it.entity === "bookmark" && it.op === "delete") deleteEvents.push(it.entity_id);
      else if (it.entity === "bookmark" && (it.op === "upsert" || it.op === "move")) {
        const row = it.payload as LibBookmark & { to?: string };
        const folderId = it.op === "move" ? String(row.to ?? "") : String(row.folder_id ?? "");
        if (!folderId) continue;
        if (folders.inboxFolderId && folderId === folders.inboxFolderId) continue; // D51：进出收纳盒归收纳盒管线
        const b: LibBookmark = { id: it.entity_id, folder_id: folderId, title: String(row.title ?? ""), url_raw: String(row.url_raw ?? "") };
        if (it.op === "upsert" && !b.url_raw) continue;
        touched.add(folderId);
        if (it.op === "upsert") await placeBookmark(b, ctx);
        else {
          const bid = bmMap[b.id];
          const node = bid ? (await browser.bookmarks.get(bid).catch(() => []))[0] : undefined;
          if (node?.url) {
            const target = await ensureBrowserFolder(folders.pathById.get(folderId) ?? [], walk.folderIdByPath, base);
            if (node.parentId !== target) {
              await browser.bookmarks.move(bid!, { parentId: target }).catch(() => undefined);
              const leaf = base.leaves[bid!];
              if (leaf) leaf.p = target;
              stats.pulledApplied++;
            }
          }
        }
      }
    }
    cursor = pull.cursor;
    if (pull.items.length < 500) break;
  }
  // 库侧批量删除走保险丝
  if (deleteEvents.length > 0) {
    if (!confirmDeletes && guardHit(deleteEvents.length, Object.keys(snapshot.leaves).length)) {
      info.deleteGuard = { side: "library", count: deleteEvents.length };
    } else {
      for (const appId of deleteEvents) {
        const bid = bmMap[appId];
        if (!bid) continue;
        const node = (await browser.bookmarks.get(bid).catch(() => []))[0];
        if (node?.url) await browser.bookmarks.remove(bid).catch(() => undefined);
        delete bmMap[appId];
        delete base.leaves[bid];
        stats.deletedBrowser++;
      }
    }
  }

  // ② 推送：浏览器 diff → 库
  const muts: Mutation[] = [];
  const meta: Array<{ browserId?: string }> = [];
  const pendingMoves: Array<{ browserId: string; path: string[] }> = [];
  const consumeResults = (results: ApplyRes[], metas: Array<{ browserId?: string }>): void => {
    results.forEach((r, i) => {
      const m = metas[i] ?? {};
      // D53.1：本轮成功推送的浏览器事实并入基线（下轮才能识别它们的删除）；
      // 失败/保险丝挂起的保留在旧基线里 → 下轮继续检出，删除不丢
      if (r.browserId && (r.status === "ok" || r.status === "bound")) {
        if (r.kind === "bookmark.delete") {
          delete base.leaves[r.browserId];
        } else {
          const leaf = walk.snapshot.leaves[r.browserId];
          if (leaf) base.leaves[r.browserId] = { ...leaf };
        }
      }
      if (r.kind === "bookmark.create" && r.appBookmarkId && r.browserId) {
        bmMap[r.appBookmarkId] = r.browserId;
        const parentId = walk.snapshot.leaves[r.browserId]?.p;
        if (parentId && r.appFolderId) fMap[parentId] = r.appFolderId;
      }
      if (r.kind === "bookmark.delete" && r.browserId) {
        for (const [appId, bid] of Object.entries(bmMap)) if (bid === r.browserId) delete bmMap[appId];
      }
      if (r.status === "ok" || r.status === "bound") stats.pushedOk++;
    });
  };
  // D56：被删的浏览器目录集合（基线有、当前树无）。目录内的书签交给 folder.deleteTree 一并删，
  // 不再走逐条 bookmark.delete（避免嵌套父目录残留 + 保险丝误伤目录级删除）。
  const deletedFolderIds = new Set(Object.keys(snapshot.folders).filter((fid) => !(fid in walk.snapshot.folders)));
  const browserDeletes = Object.keys(snapshot.leaves).filter((id) => {
    if (id in walk.snapshot.leaves) return false;
    const parent = snapshot.leaves[id]?.p;
    return !(parent !== undefined && deletedFolderIds.has(parent)); // 在被删目录内 → deleteTree 处理
  });
  if (browserDeletes.length > 0) {
    if (!confirmDeletes && guardHit(browserDeletes.length, Object.keys(snapshot.leaves).length)) {
      info.deleteGuard = { side: "browser", count: browserDeletes.length };
    } else {
      for (const id of browserDeletes) {
        muts.push({ kind: "bookmark.delete", browserId: id });
        meta.push({ browserId: id });
        stats.deletedLibrary++;
      }
    }
  }
  for (const l of walk.leafList) {
    const leaf = walk.snapshot.leaves[l.id]!;
    const prev = snapshot.leaves[l.id];
    if (!prev) {
      muts.push({ kind: "bookmark.create", browserId: l.id, url: leaf.u, title: (leaf.t || leaf.u).slice(0, 500), folderPath: l.path });
      meta.push({ browserId: l.id });
      continue;
    }
    if (prev.u !== leaf.u) {
      // URL 改动 = 重新绑定：create 命中既有 URL 则绑到新 app，否则新库条目
      muts.push({ kind: "bookmark.create", browserId: l.id, url: leaf.u, title: (leaf.t || leaf.u).slice(0, 500), folderPath: l.path });
      meta.push({ browserId: l.id });
    } else if (prev.t !== leaf.t) {
      muts.push({ kind: "bookmark.update", browserId: l.id, title: leaf.t.slice(0, 500) });
      meta.push({ browserId: l.id });
    }
    if (prev.p !== leaf.p) {
      const appFolderId = fMap[leaf.p];
      if (appFolderId) {
        muts.push({ kind: "bookmark.move", browserId: l.id, appFolderId });
        meta.push({ browserId: l.id });
      } else {
        pendingMoves.push({ browserId: l.id, path: pathKeyOf(leaf.p, walk.snapshot.folders) });
      }
    }
  }
  // D56：目录删除 → folder.deleteTree（子优先递归删目录+子书签）。只对「最顶层被删目录」发，
  // 其子孙由服务端树删一并处理。目录级保险丝：被删目录数 >3 且 >基线目录数 50% 视为灾难
  // （浏览器资料重置/扫描异常致整树消失）→ 挂起待确认；单个目录删除（含嵌套）放行。
  const folderCount = Object.keys(snapshot.folders).length;
  const folderGuard = !confirmDeletes && deletedFolderIds.size > 3 && deletedFolderIds.size > folderCount * 0.5;
  if (folderGuard) {
    info.deleteGuard = { side: "browser", count: deletedFolderIds.size };
  } else {
    // 基线剪枝助手：移除某被删目录子树的 folders + leaves（已删，下轮不再误报）
    const pruneBaseSubtree = (rootFid: string): void => {
      const sub = new Set<string>([rootFid]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const [fid, f] of Object.entries(snapshot.folders)) {
          if (!sub.has(fid) && f.p !== undefined && sub.has(f.p)) {
            sub.add(fid);
            grew = true;
          }
        }
      }
      for (const fid of sub) delete base.folders[fid];
      for (const [lid, leaf] of Object.entries(base.leaves)) {
        if (leaf.p !== undefined && sub.has(leaf.p)) delete base.leaves[lid];
      }
    };
    for (const fid of deletedFolderIds) {
      const parent = snapshot.folders[fid]?.p;
      if (parent !== undefined && deletedFolderIds.has(parent)) continue; // 子孙由顶层树删覆盖
      const appFolderId = fMap[fid];
      if (appFolderId) {
        muts.push({ kind: "folder.deleteTree", appFolderId });
        meta.push({});
        pruneBaseSubtree(fid);
      }
    }
  }
  // 目录改名（未被删的目录）
  for (const [fid, fs] of Object.entries(snapshot.folders)) {
    if (deletedFolderIds.has(fid)) continue;
    const cur = walk.snapshot.folders[fid];
    const appFolderId = fMap[fid];
    if (cur && appFolderId && cur.t !== fs.t) {
      muts.push({ kind: "folder.rename", appFolderId, name: cur.t.slice(0, 200) });
      meta.push({});
    }
  }
  if (muts.length > 0) consumeResults(await applyMutations(deviceId, muts), meta);
  // 二段：移入未知新文件夹的书签——先 folder.ensure 拿 app 目录 id，再补 move
  if (pendingMoves.length > 0) {
    const ensureRes = await applyMutations(
      deviceId,
      pendingMoves.map((pm) => ({ kind: "folder.ensure", path: pm.path })),
    );
    const follow: Mutation[] = [];
    const followMeta: Array<{ browserId?: string }> = [];
    ensureRes.forEach((r, i) => {
      const pm = pendingMoves[i]!;
      if (r.appFolderId) {
        const browserFolderId = walk.folderIdByPath.get(key(pm.path));
        if (browserFolderId) fMap[browserFolderId] = r.appFolderId;
        follow.push({ kind: "bookmark.move", browserId: pm.browserId, appFolderId: r.appFolderId });
        followMeta.push({ browserId: pm.browserId });
      }
    });
    if (follow.length > 0) consumeResults(await applyMutations(deviceId, follow), followMeta);
  }

  // ③ 受影响目录重排（库顺序权威）
  for (const fid of touched) {
    await resortFolder(fid, bmMap, { folders, idByPath: walk.folderIdByPath });
    stats.resortedFolders++;
  }

  // D51：存量自愈——合并引擎旧版误建的重复收纳盒
  await mergeDuplicateInboxFolders();

  // ④ 基线与游标固化：基线 = 增量维护后的 base（非结尾重扫——那会吞掉 tick 期间的用户改动，D53）
  await browser.storage.local.set({ [SNAPSHOT_KEY]: base, [BOOKMARK_MAP_KEY]: bmMap, [FOLDER_MAP_KEY]: fMap, syncCursor: cursor });
  const after = await walkBrowser();
  if (treesDiffer(base, after.snapshot)) scheduleSyncTick(5_000); // 中途有用户改动 → 补一轮
  return info;
}

/**
 * D51 存量自愈：书签栏根下出现多个「📥 收纳盒」时（旧版引擎误建），
 * 保留正主（config.inboxExtId，缺省取第一个），其余文件夹内书签按 URL 去重后移回正主，
 * 移空后删除文件夹。子文件夹不递归（引擎只会建平级同名壳），非空则保留不硬删。
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
      if (!child.url) continue; // 子文件夹不动
      const sameUrl = await browser.bookmarks.search({ url: child.url }).catch(() => []);
      const alreadyInKeep = sameUrl.some((n) => n.parentId === keep.id);
      if (alreadyInKeep) {
        await browser.bookmarks.remove(child.id).catch(() => undefined); // URL 重复：留正主那份
      } else {
        await browser.bookmarks.move(child.id, { parentId: keep.id }).catch(() => undefined);
      }
      merged++;
    }
    const rest = await browser.bookmarks.getChildren(dup.id).catch(() => [{ id: "?" }]);
    if (rest.length === 0) await browser.bookmarks.removeTree(dup.id).catch(() => undefined);
  }
  return merged;
}

// ---------- D50 SSE 推送循环（库→浏览器秒级触发） ----------
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
          // 只关心 change 帧（hello/ping 仅保活）；数据真相走 /sync/pull，这里只是门铃
          if (frame.includes("event: change")) scheduleSyncTick(3000);
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

/** 幂等启动事件流循环（SW 重启/开关重开都可再调） */
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
  if (!on) {
    stopEventStream();
    await browser.alarms.clear("mf-sync-tick");
    return { at: Date.now(), phase: "tick", ok: true };
  }
  // D50：SSE 门铃秒级触发；1 分钟告警兜底（SW 休眠/断线场景）
  await browser.alarms.create("mf-sync-tick", { periodInMinutes: 1 });
  startEventStream();
  const info = await runExclusive(doAlign);
  await setInfoWrapped(info);
  return info;
}

export async function runSyncTick(opts: { confirmDeletes?: boolean } = {}): Promise<SyncInfo> {
  const { favoritesSync } = await getConfig();
  if (!favoritesSync) return { at: Date.now(), phase: "tick", ok: false, error: "sync_off" };
  const info = await runExclusive(() => doTick(opts.confirmDeletes === true));
  await setInfoWrapped(info);
  // 保险丝挂起时保持待确认状态：下轮正常收敛，删除等待确认
  return info;
}

let timer: ReturnType<typeof setTimeout> | null = null;
export function scheduleSyncTick(delayMs = 8_000): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runSyncTick().catch(() => undefined);
  }, delayMs);
}

async function runExclusive(fn: () => Promise<SyncInfo>): Promise<SyncInfo> {
  if (running) return running;
  running = fn().finally(() => {
    running = null;
  });
  return running;
}

async function setInfoWrapped(info: SyncInfo): Promise<void> {
  await browser.storage.local.set({ [INFO_KEY]: info });
}
