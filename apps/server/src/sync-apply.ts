/**
 * D46 双向同步 · 浏览器侧变更应用器（POST /sync/apply 内核）
 *
 * 扩展引擎把「浏览器书签树相对已确认基线的 diff」发上来，这里逐条落库：
 *  - 执行体以 runAsSyncDevice(deviceId) 包裹（D67 起 ALS 上下文）——产生的变更日志带发起设备标记，
 *    该设备 pullChanges 时被排除（不回声到自己浏览器），其他设备照常收到（多端传播）。
 *  - 幂等：create 按 URL 绑定、update/move 先比对现值、delete 缺失即成功；
 *    引擎任何一步失败下个 tick 重放即可。
 *  - 不排队镜像 move（浏览器→库方向的移动不该回写浏览器）；delete 跳过发起方设备。
 *
 * D81 同步协议整改（评审 §3-A/C/D）：
 *  - folder.create / folder.move：空目录创建与目录搬家（reparent）进同步协议；
 *    folder_identity 绑定后按 ID 同步，路径名仅作初次匹配（§3-A）。
 *  - opId 回执幂等 + baseRevision 冲突检测：每个 mutation 在 SAVEPOINT 内完成
 *    「数据修改 + 变更日志 + 操作回执」原子提交；冲突返回库侧现值（§3-D-2/3）。
 *  - apply 即标记设备 sync_enabled：已同步设备停发镜像 ops（§3-D-4）。
 *
 * D81 复核整改（docs/同步整改复核清单-D81.md）：
 *  - R03：绑定既有书签后，落点 / 回执 / 目录身份一律以**移动后的最终记录**为准；
 *    目标目录解析「稳定身份优先」——已绑定的目录身份不被路径回退改写。
 *  - R04：目录搬家把父目录与根归属纳入同一次移动（跨根移动更新 root 与子树）。
 *  - R05：成功回执返回最新实体与修订号（entity）；bookmark.update 可合并标题 / URL / 目录
 *    为一次提交；目录 rename/move 支持 baseRevision 冲突检测（folders.rev）。
 *  - skipped 带稳定错误码：调用方据此区分终态（不可重试）与可重试（parent_unknown）。
 */
import { canonicalizeUrl } from "@mf/shared";
import type { BookmarkRow, FolderRow, Store } from "./store";
import { runAsSyncDevice } from "./tenancy";

export type SyncMutation =
  | { kind: "bookmark.create"; browserId: string; url: string; title: string; folderPath: string[]; folderRoot?: string; browserFolderId?: string; opId?: string }
  | { kind: "bookmark.update"; browserId: string; title?: string; url?: string; folderId?: string; browserFolderId?: string; folderPath?: string[]; folderRoot?: string; opId?: string; baseRevision?: number }
  | { kind: "bookmark.move"; browserId: string; appFolderId: string; opId?: string; baseRevision?: number }
  | { kind: "bookmark.delete"; browserId: string; opId?: string }
  | { kind: "bookmark.unbind"; browserId: string }
  | { kind: "folder.ensure"; appFolderId?: string; path: string[]; root?: string; browserFolderId?: string; liveBrowserFolderIds?: string[] }
  | { kind: "folder.create"; name: string; browserFolderId?: string; parentBrowserFolderId?: string; parentPath?: string[]; root?: string; separateFromAppFolderId?: string }
  | { kind: "folder.rename"; appFolderId?: string; browserFolderId?: string; name: string; baseRevision?: number }
  | { kind: "folder.move"; appFolderId?: string; browserFolderId?: string; toAppFolderId?: string | null; toBrowserFolderId?: string; toPath?: string[]; root?: string; name?: string; baseRevision?: number }
  | { kind: "folder.delete"; appFolderId: string }
  | { kind: "folder.deleteTree"; appFolderId: string; browserFolderId?: string };

/** 成功回执携带的库侧最新实体（R05：端侧据此推进已确认基线与修订缓存） */
export interface BookmarkReceipt {
  id: string;
  title: string;
  url_raw: string;
  folder_id: string;
  content_revision: number;
  materialized_at?: string | null;
}
export interface FolderReceipt {
  id: string;
  name: string;
  parent_id: string | null;
  root: string;
  rev: number;
}

export interface SyncApplyResult {
  kind: SyncMutation["kind"];
  browserId?: string;
  appBookmarkId?: string;
  appFolderId?: string;
  status: "ok" | "bound" | "noop" | "skipped" | "failed" | "conflict";
  /** 稳定错误码（skipped/failed）——端侧据此分类终态与可重试 */
  error?: string;
  /** 冲突时携带库侧现值——端侧按明确策略回对齐（不宣称后发生效） */
  current?: unknown;
  /** ok / bound / noop / conflict 均携带：操作后（或冲突时的）库侧实体与修订号 */
  entity?: BookmarkReceipt | FolderReceipt;
}

/** skipped 错误码分类：仅 parent_unknown 可由后续操作解除；其余重试不会成功（终态） */
export const RETRYABLE_SKIP_ERRORS: ReadonlySet<string> = new Set(["parent_unknown", "folder_unknown"]);

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rootOf = (v: unknown): string => (v === "other" ? "other" : "bar");
const rootOfRow = (f: FolderRow): string => (f.root === "other" ? "other" : "bar");
/** 浏览器根节点 id（0=总根 / 1=书签栏 / 2=其他书签）——不是用户目录，映射为库根级 */
export const isBrowserRootId = (id: string): boolean => id === "0" || id === "1" || id === "2";

const bookmarkReceipt = (store: Store, id: string): BookmarkReceipt | undefined => {
  const b = store.getBookmark(id);
  return b ? { id: b.id, title: b.title, url_raw: b.url_raw, folder_id: b.folder_id, content_revision: b.content_revision ?? 0, materialized_at: b.materialized_at ?? null } : undefined;
};
const folderReceipt = (store: Store, id: string): FolderReceipt | undefined => {
  const f = store.getFolder(id);
  return f ? { id: f.id, name: f.name, parent_id: f.parent_id, root: rootOfRow(f), rev: f.rev ?? 0 } : undefined;
};

interface FolderTargetInput {
  browserFolderId?: string;
  folderPath?: string[];
  folderRoot?: string;
}

/**
 * 目标目录解析（R03「身份优先」）：浏览器目录已有有效稳定身份 → 以身份为准，
 * 调用方的 folderPath 只是初次匹配的回退，不得改写正确映射；身份缺失/陈旧才按路径 find-or-create。
 */
function resolveTargetFolder(store: Store, deviceId: string, m: FolderTargetInput): FolderRow {
  if (m.browserFolderId && !isBrowserRootId(m.browserFolderId)) {
    const bound = store.resolveBoundFolderId(deviceId, m.browserFolderId);
    if (bound) return store.getFolder(bound)!;
  }
  return store.ensurePath(m.folderPath ?? [], rootOf(m.folderRoot));
}

export function applySyncMutations(
  store: Store,
  deviceId: string,
  mutations: unknown[],
): { results: SyncApplyResult[]; cursor: number } {
  // 只固化成功或终态；可重试 skipped（含旧版本已落库的回执）必须允许同 opId 再执行。
  const isFinalReceipt = (r: SyncApplyResult): boolean =>
    r.status === "ok" || r.status === "bound" || r.status === "noop" || r.status === "conflict" ||
    (r.status === "skipped" && !RETRYABLE_SKIP_ERRORS.has(r.error ?? ""));
  // D67：发起设备标记走 ALS 上下文（原 Store 单例可变字段在多用户下会跨用户污染防回环标记）
  return runAsSyncDevice(deviceId, () => {
    const results: SyncApplyResult[] = [];
    store.ensureDevice(deviceId);
    // D81 §3-D-4：apply 只可能来自开启同步的设备——标记后镜像 ops 停发（单一执行器）
    store.setDeviceSyncEnabled(deviceId, true);
    for (const raw of mutations) {
      const m = raw as SyncMutation & { opId?: string };
      // D81 §3-D-2：成功 / 终态回执原样重放；历史可重试回执重新执行，成功后在同一事务内覆盖。
      if (m?.opId) {
        const prior = store.opReceipt(m.opId) as SyncApplyResult | null;
        if (prior && isFinalReceipt(prior)) {
          results.push(prior);
          continue;
        }
      }
      // 每个 mutation 一个 SAVEPOINT：数据修改 + 变更日志 + 回执原子提交，单条失败隔离回滚
      store.db.exec("SAVEPOINT mf_sync_op");
      try {
        const r = applyOne(store, deviceId, m);
        if (m?.opId && isFinalReceipt(r)) store.saveOpReceipt(m.opId, deviceId, r);
        store.db.exec("RELEASE mf_sync_op");
        results.push(r);
      } catch (err) {
        store.db.exec("ROLLBACK TO mf_sync_op");
        store.db.exec("RELEASE mf_sync_op");
        results.push({ kind: m?.kind ?? ("unknown" as SyncMutation["kind"]), status: "failed", error: String(err).slice(0, 200) });
      }
    }
    return { results, cursor: store.maxChangeId() };
  });
}

function applyOne(store: Store, deviceId: string, m: SyncMutation): SyncApplyResult {
  switch (m.kind) {
    case "bookmark.create": {
      const canon = canonicalizeUrl(m.url);
      if (!canon) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "invalid_url" };
      const existing = store.findByCanonical(canon.canonical);
      if (existing?.materialized_at) {
        store.upsertIdentity({ deviceId, browserBookmarkId: m.browserId, appBookmarkId: existing.id });
        return { kind: m.kind, browserId: m.browserId, appBookmarkId: existing.id, status: "conflict", current: existing, entity: bookmarkReceipt(store, existing.id) };
      }
      const targetFolder = resolveTargetFolder(store, deviceId, m);
      const created = existing ? undefined : store.createBookmark({
        folderId: targetFolder.id,
        urlRaw: m.url,
        urlCanonical: canon.canonical,
        urlKeyVersion: canon.rulesVersion,
        title: m.title || m.url,
      });
      const before = existing ?? created!;
      // D79：绑定既有 URL 必须尊重浏览器侧目录（用户最新放置意图）——旧实现保留库内旧目录，
      // 浏览器在新目录、库在旧目录 → 永久分叉。手动移出收纳盒同理退出分类自检（D77 神圣）。
      if (existing && before.folder_id !== targetFolder.id) {
        store.moveBookmark(before.id, targetFolder.id);
        store.clearInboxState(before.id);
      }
      // R03：落点 / 回执 / 目录身份一律以移动后的**最终记录**为准（旧实现沿用移动前的 existing 对象，
      // 回执与 folder_identity 指向旧目录 A，而书签实际在 B）。
      const finalRow = store.getBookmark(before.id)!;
      store.upsertIdentity({ deviceId, browserBookmarkId: m.browserId, appBookmarkId: finalRow.id });
      if (m.browserFolderId && !isBrowserRootId(m.browserFolderId)) {
        store.upsertFolderIdentity({ deviceId, browserFolderId: m.browserFolderId, appFolderId: finalRow.folder_id });
      }
      return {
        kind: m.kind,
        browserId: m.browserId,
        appBookmarkId: finalRow.id,
        appFolderId: finalRow.folder_id,
        status: existing ? "bound" : "ok",
        entity: bookmarkReceipt(store, finalRow.id),
      };
    }
    case "bookmark.update": {
      // R05：标题 / URL / 目录合并为一次提交——同一轮「改标题并移目录」不再因两条操作各带
      // 同一旧修订号而自冲突（第二条被服务端拒绝并回退用户修改）。
      const app = store.findAppBookmarkId(deviceId, m.browserId);
      if (!app) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "no_identity" };
      const cur = store.getBookmark(app);
      if (!cur) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "bookmark_gone" };
      if (cur.materialized_at) return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, status: "conflict", current: cur, entity: bookmarkReceipt(store, app) };
      const conflict = (): SyncApplyResult => ({
        kind: m.kind,
        browserId: m.browserId,
        appBookmarkId: app,
        status: "conflict",
        current: cur,
        entity: bookmarkReceipt(store, app),
      });
      // baseRevision = 操作生成时的库侧修订；库侧已被其他写入者推进 → 冲突，不应用过期意图
      if (m.baseRevision !== undefined && (cur.content_revision ?? 0) > m.baseRevision) return conflict();
      const wantsFolder = m.folderId !== undefined || m.browserFolderId !== undefined || m.folderPath !== undefined;
      let targetFolder: FolderRow | undefined;
      if (wantsFolder) {
        targetFolder = m.folderId
          ? store.getFolder(m.folderId)
          : resolveTargetFolder(store, deviceId, m);
        if (!targetFolder) return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, status: "skipped", error: "folder_gone" };
        // 收纳盒条目归收纳盒管线（D51）：同步协议不直接把书签放进系统收纳盒
        if (targetFolder.is_system_inbox === 1) return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, status: "skipped", error: "system_folder" };
      }
      let row: BookmarkRow = cur;
      let changed = false;
      let boundHit = false;
      // D81 §3-D-5：URL 修改复用 D52 语义（canonical 重算 + 查重绑定）——
      // 命中既有 URL：身份迁移到既有行 + 删旧行（消灭孤儿与 align 复活）；未命中：原行更新 + 缓存作废
      if (m.url !== undefined && m.url !== cur.url_raw) {
        const canon = canonicalizeUrl(m.url);
        if (!canon) return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, status: "skipped", error: "invalid_url" };
        if (canon.canonical !== cur.url_canonical) {
          const hit = store.findByCanonical(canon.canonical);
          if (hit?.materialized_at) return { kind: m.kind, browserId: m.browserId, appBookmarkId: hit.id, status: "conflict", current: hit, entity: bookmarkReceipt(store, hit.id) };
          if (hit && hit.id !== app) {
            store.upsertIdentity({ deviceId, browserBookmarkId: m.browserId, appBookmarkId: hit.id });
            store.deleteBookmark(app, { skipMirrorRemoveForDevice: deviceId });
            row = hit;
            boundHit = true;
            changed = true;
          } else {
            store.updateBookmark(app, { url_raw: m.url, url_canonical: canon.canonical, url_key_version: canon.rulesVersion });
            store.clearCache(app); // D52：URL 编辑后正文缓存作废
            changed = true;
          }
        }
      }
      if (m.title !== undefined && m.title !== row.title) {
        store.updateBookmark(row.id, { title: m.title });
        changed = true;
      }
      if (targetFolder && row.folder_id !== targetFolder.id) {
        store.moveBookmark(row.id, targetFolder.id);
        store.clearInboxState(row.id); // 手动移动 = 用户意图神圣 → 退出分类自检（D77）
        changed = true;
      }
      const finalRow = store.getBookmark(row.id)!;
      return {
        kind: m.kind,
        browserId: m.browserId,
        appBookmarkId: finalRow.id,
        appFolderId: finalRow.folder_id,
        status: boundHit ? "bound" : changed ? "ok" : "noop",
        entity: bookmarkReceipt(store, finalRow.id),
      };
    }
    case "bookmark.move": {
      const app = store.findAppBookmarkId(deviceId, m.browserId);
      if (!app) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "no_identity" };
      const cur = store.getBookmark(app);
      if (!cur) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "bookmark_gone" };
      if (cur.materialized_at) return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, status: "conflict", current: cur, entity: bookmarkReceipt(store, app) };
      if (m.baseRevision !== undefined && (cur.content_revision ?? 0) > m.baseRevision) {
        return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, status: "conflict", current: cur, entity: bookmarkReceipt(store, app) };
      }
      const target = store.getFolder(m.appFolderId);
      if (!target) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "folder_gone" };
      if (target.is_system_inbox === 1) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "system_folder" };
      if (cur.folder_id === m.appFolderId) {
        return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, appFolderId: cur.folder_id, status: "noop", entity: bookmarkReceipt(store, app) };
      }
      store.moveBookmark(app, m.appFolderId);
      store.clearInboxState(app);
      return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, appFolderId: m.appFolderId, status: "ok", entity: bookmarkReceipt(store, app) };
    }
    case "bookmark.delete": {
      const app = store.findAppBookmarkId(deviceId, m.browserId);
      if (!app) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "no_identity" };
      const current = store.getBookmark(app);
      if (!current) return { kind: m.kind, browserId: m.browserId, status: "noop" };
      if (current.materialized_at) {
        // 系统移除收藏夹节点的回声，只解绑浏览器身份，绝不级联删除资料。
        store.unbindIdentity(deviceId, m.browserId);
        return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, status: "noop" };
      }
      store.deleteBookmark(app, { skipMirrorRemoveForDevice: deviceId });
      return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, status: "ok" };
    }
    case "bookmark.unbind": {
      // 节点退出同步范围（URL 变非 http）——解绑身份，库条目保留（不删用户数据）
      store.unbindIdentity(deviceId, m.browserId);
      return { kind: m.kind, browserId: m.browserId, status: "ok" };
    }
    case "folder.ensure": {
      // 库→浏览器已知确切实体，不得再用相同的字符串路径把独立目录合回去。
      const folder = m.appFolderId ? store.getFolder(m.appFolderId) : store.ensurePath(m.path ?? [], rootOf(m.root));
      if (!folder) return { kind: m.kind, browserId: m.browserFolderId, status: "skipped", error: "folder_unknown" };
      if (m.browserFolderId && !isBrowserRootId(m.browserFolderId)) {
        store.upsertFolderIdentity({ deviceId, browserFolderId: m.browserFolderId, appFolderId: folder.id, liveBrowserFolderIds: m.liveBrowserFolderIds });
      }
      return { kind: m.kind, appFolderId: folder.id, browserId: m.browserFolderId, status: "ok", entity: folderReceipt(store, folder.id) };
    }
    case "folder.create": {
      // 正常重放尊重稳定身份；只有带旧身份前置条件的显式分离才允许改绑。
      const bound = m.browserFolderId && !isBrowserRootId(m.browserFolderId)
        ? store.resolveBoundFolderId(deviceId, m.browserFolderId) : undefined;
      const separating = Boolean(bound && m.separateFromAppFolderId === bound);
      if (bound && !separating) return { kind: m.kind, appFolderId: bound, browserId: m.browserFolderId, status: "bound", entity: folderReceipt(store, bound) };
      if (m.separateFromAppFolderId && !bound) return { kind: m.kind, browserId: m.browserFolderId, status: "skipped", error: "folder_identity_changed" };
      const root = rootOf(m.root);
      let parentId: string | null = null;
      if (m.parentBrowserFolderId && !isBrowserRootId(m.parentBrowserFolderId)) {
        parentId = store.resolveBoundFolderId(deviceId, m.parentBrowserFolderId) ?? null;
        // 父操作尚未落库时保留重试，不得把子目录静默提升到根级；非空路径仍可兼容回退。
        if (!parentId && !m.parentPath?.length) {
          return { kind: m.kind, browserId: m.browserFolderId, status: "skipped", error: "parent_unknown" };
        }
      }
      if (!parentId && m.parentPath && m.parentPath.length > 0) {
        parentId = store.ensurePath(m.parentPath, root).id;
      }
      // 旧库可被本设备认领一次；同设备的另一个同名节点必须保留独立实体。
      const existing = separating ? undefined : store.findUnclaimedFolderUnder(m.name, parentId, root, deviceId);
      const folder = existing ?? store.createFolder(m.name, parentId, "sync", false, root);
      if (m.browserFolderId && !isBrowserRootId(m.browserFolderId)) {
        store.upsertFolderIdentity({ deviceId, browserFolderId: m.browserFolderId, appFolderId: folder.id,
          ...(separating ? { replaceFromAppFolderId: bound } : {}),
        });
      }
      return { kind: m.kind, appFolderId: folder.id, browserId: m.browserFolderId, status: existing ? "bound" : "ok", entity: folderReceipt(store, folder.id) };
    }
    case "folder.rename": {
      const appFolderId = m.appFolderId ?? (m.browserFolderId ? store.resolveBoundFolderId(deviceId, m.browserFolderId) : undefined);
      if (!appFolderId) return { kind: m.kind, status: "skipped", error: "no_identity" };
      const cur = store.getFolder(appFolderId);
      if (!cur) return { kind: m.kind, appFolderId, status: "skipped", error: "folder_not_found" };
      if (cur.is_system_inbox === 1) return { kind: m.kind, appFolderId, status: "skipped", error: "system_folder" };
      if (m.baseRevision !== undefined && (cur.rev ?? 0) > m.baseRevision) {
        return { kind: m.kind, appFolderId, status: "conflict", current: cur, entity: folderReceipt(store, appFolderId) };
      }
      if (m.browserFolderId && !isBrowserRootId(m.browserFolderId)) {
        store.upsertFolderIdentity({ deviceId, browserFolderId: m.browserFolderId, appFolderId });
      }
      if (m.name === cur.name) return { kind: m.kind, appFolderId, browserId: m.browserFolderId, status: "noop", entity: folderReceipt(store, appFolderId) };
      store.renameFolder(appFolderId, m.name);
      return { kind: m.kind, appFolderId, browserId: m.browserFolderId, status: "ok", entity: folderReceipt(store, appFolderId) };
    }
    case "folder.move": {
      const appFolderId = m.appFolderId ?? (m.browserFolderId ? store.resolveBoundFolderId(deviceId, m.browserFolderId) : undefined);
      if (!appFolderId) return { kind: m.kind, status: "skipped", error: "no_identity" };
      const cur = store.getFolder(appFolderId);
      if (!cur) return { kind: m.kind, appFolderId, status: "skipped", error: "folder_not_found" };
      if (cur.is_system_inbox === 1) return { kind: m.kind, appFolderId, status: "skipped", error: "system_folder" };
      if (m.baseRevision !== undefined && (cur.rev ?? 0) > m.baseRevision) {
        return { kind: m.kind, appFolderId, status: "conflict", current: cur, entity: folderReceipt(store, appFolderId) };
      }
      const curRoot = rootOfRow(cur);
      const root = rootOf(m.root);
      // 目标父：显式 app id → 浏览器身份 → 路径；库根级（浏览器根节点）→ null 并采用请求的根归属（R04）
      let toParent: string | null;
      let toRoot: string | undefined;
      if (m.toAppFolderId !== undefined) {
        toParent = m.toAppFolderId || null;
      } else if (m.toBrowserFolderId !== undefined) {
        if (isBrowserRootId(m.toBrowserFolderId)) {
          toParent = null;
          toRoot = root;
        } else {
          const mapped = store.resolveBoundFolderId(deviceId, m.toBrowserFolderId);
          if (mapped) toParent = mapped;
          else if (m.toPath && m.toPath.length > 0) toParent = store.ensurePath(m.toPath, root).id;
          // 可重试：父目录的出站操作尚未落库（端侧先目录后书签，下轮重发即可解除）
          else return { kind: m.kind, appFolderId, status: "skipped", error: "parent_unknown" };
        }
      } else if (m.toPath !== undefined) {
        toParent = m.toPath.length > 0 ? store.ensurePath(m.toPath, root).id : null;
        if (toParent === null) toRoot = root;
      } else {
        return { kind: m.kind, appFolderId, status: "skipped", error: "target_required" };
      }
      const toParentRow = toParent !== null ? store.getFolder(toParent) : undefined;
      if (toParent !== null && !toParentRow) return { kind: m.kind, appFolderId, status: "skipped", error: "folder_gone" };
      // 根继承（R04）：挂在某父下 → 继承父的 root；升到根级 → 采用请求的根归属
      const effRoot = toParentRow ? rootOfRow(toParentRow) : (toRoot ?? curRoot);
      const needMove = (cur.parent_id ?? null) !== toParent || effRoot !== curRoot;
      const needRename = m.name !== undefined && m.name !== cur.name;
      if (m.browserFolderId && !isBrowserRootId(m.browserFolderId)) {
        store.upsertFolderIdentity({ deviceId, browserFolderId: m.browserFolderId, appFolderId });
      }
      if (!needMove && !needRename) {
        return { kind: m.kind, appFolderId, browserId: m.browserFolderId, status: "noop", entity: folderReceipt(store, appFolderId) };
      }
      if (needMove) {
        const moved = store.moveFolder(appFolderId, toParent, toRoot); // 校验父存在 + 禁止成环 + 子树 root 同改
        if (!moved) return { kind: m.kind, appFolderId, status: "skipped", error: "invalid_move" };
      }
      if (needRename && !store.renameFolder(appFolderId, m.name!)) {
        return { kind: m.kind, appFolderId, status: "skipped", error: "system_folder" };
      }
      return { kind: m.kind, appFolderId, browserId: m.browserFolderId, status: "ok", entity: folderReceipt(store, appFolderId) };
    }
    case "folder.delete": {
      const ok = store.deleteFolderIfEmpty(m.appFolderId);
      return { kind: m.kind, appFolderId: m.appFolderId, status: ok ? "ok" : "noop", error: ok ? undefined : "folder_not_empty" };
    }
    case "folder.deleteTree": {
      // D56：浏览器删目录 → 递归删库内目录树 + 子书签（子优先，不受"仅空目录"限制）
      const r = store.deleteFolderTree(m.appFolderId, { skipMirrorRemoveForDevice: deviceId });
      return { kind: m.kind, appFolderId: m.appFolderId, browserId: m.browserFolderId, status: r.folders > 0 ? "ok" : "noop", error: r.folders > 0 ? undefined : "folder_not_found" };
    }
    default:
      return { kind: str((m as { kind?: unknown })?.kind) as SyncMutation["kind"], status: "skipped", error: "unknown_kind" };
  }
}
