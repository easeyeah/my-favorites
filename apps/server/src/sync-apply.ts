/**
 * D46 双向同步 · 浏览器侧变更应用器（POST /sync/apply 内核）
 *
 * 扩展引擎把「浏览器书签树相对基线快照的 diff」发上来，这里逐条落库：
 *  - 全程 store.syncApplyDevice = deviceId —— 产生的变更日志带发起设备标记，
 *    该设备 pullChanges 时被排除（不回声到自己浏览器），其他设备照常收到（多端传播）。
 *  - 幂等：create 按 URL 绑定、update/move 先比对现值、delete 缺失即成功；
 *    引擎任何一步失败下个 tick 重放即可。
 *  - 不排队镜像 move（浏览器→库方向的移动不该回写浏览器）；delete 跳过发起方设备。
 */
import { canonicalizeUrl } from "@mf/shared";
import type { Store } from "./store";

export type SyncMutation =
  | { kind: "bookmark.create"; browserId: string; url: string; title: string; folderPath: string[] }
  | { kind: "bookmark.update"; browserId: string; title?: string; url?: string }
  | { kind: "bookmark.move"; browserId: string; appFolderId: string }
  | { kind: "bookmark.delete"; browserId: string }
  | { kind: "folder.ensure"; path: string[] }
  | { kind: "folder.rename"; appFolderId: string; name: string }
  | { kind: "folder.delete"; appFolderId: string }
  | { kind: "folder.deleteTree"; appFolderId: string };

export interface SyncApplyResult {
  kind: SyncMutation["kind"];
  browserId?: string;
  appBookmarkId?: string;
  appFolderId?: string;
  status: "ok" | "bound" | "noop" | "skipped" | "failed";
  error?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function applySyncMutations(
  store: Store,
  deviceId: string,
  mutations: unknown[],
): { results: SyncApplyResult[]; cursor: number } {
  const results: SyncApplyResult[] = [];
  const prevDevice = store.syncApplyDevice;
  store.syncApplyDevice = deviceId;
  store.ensureDevice(deviceId);
  try {
    for (const raw of mutations) {
      const m = raw as SyncMutation;
      try {
        results.push(applyOne(store, deviceId, m));
      } catch (err) {
        results.push({ kind: m?.kind ?? ("unknown" as SyncMutation["kind"]), status: "failed", error: String(err).slice(0, 200) });
      }
    }
  } finally {
    store.syncApplyDevice = prevDevice;
  }
  return { results, cursor: store.maxChangeId() };
}

function applyOne(store: Store, deviceId: string, m: SyncMutation): SyncApplyResult {
  switch (m.kind) {
    case "bookmark.create": {
      const canon = canonicalizeUrl(m.url);
      if (!canon) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "invalid_url" };
      const existing = store.findByCanonical(canon.canonical);
      const row =
        existing ??
        store.createBookmark({
          folderId: store.ensurePath(m.folderPath ?? []).id,
          urlRaw: m.url,
          urlCanonical: canon.canonical,
          urlKeyVersion: canon.rulesVersion,
          title: m.title || m.url,
        });
      store.upsertIdentity({ deviceId, browserBookmarkId: m.browserId, appBookmarkId: row.id });
      return {
        kind: m.kind,
        browserId: m.browserId,
        appBookmarkId: row.id,
        appFolderId: row.folder_id,
        status: existing ? "bound" : "ok",
      };
    }
    case "bookmark.update": {
      const app = store.findAppBookmarkId(deviceId, m.browserId);
      if (!app) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "no_identity" };
      const cur = store.getBookmark(app);
      if (!cur) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "bookmark_gone" };
      if (m.title !== undefined && m.title !== cur.title) store.updateBookmark(app, { title: m.title });
      else return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, status: "noop" };
      return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, status: "ok" };
    }
    case "bookmark.move": {
      const app = store.findAppBookmarkId(deviceId, m.browserId);
      if (!app) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "no_identity" };
      const cur = store.getBookmark(app);
      if (!cur) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "bookmark_gone" };
      if (!store.getFolder(m.appFolderId)) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "folder_gone" };
      if (cur.folder_id === m.appFolderId) return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, status: "noop" };
      store.moveBookmark(app, m.appFolderId);
      return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, appFolderId: m.appFolderId, status: "ok" };
    }
    case "bookmark.delete": {
      const app = store.findAppBookmarkId(deviceId, m.browserId);
      if (!app) return { kind: m.kind, browserId: m.browserId, status: "skipped", error: "no_identity" };
      if (!store.getBookmark(app)) return { kind: m.kind, browserId: m.browserId, status: "noop" };
      store.deleteBookmark(app, { skipMirrorRemoveForDevice: deviceId });
      return { kind: m.kind, browserId: m.browserId, appBookmarkId: app, status: "ok" };
    }
    case "folder.ensure": {
      const folder = store.ensurePath(m.path ?? []);
      return { kind: m.kind, appFolderId: folder.id, status: "ok" };
    }
    case "folder.rename": {
      const row = store.renameFolder(m.appFolderId, m.name);
      return { kind: m.kind, appFolderId: m.appFolderId, status: row ? "ok" : "skipped" };
    }
    case "folder.delete": {
      const ok = store.deleteFolderIfEmpty(m.appFolderId);
      return { kind: m.kind, appFolderId: m.appFolderId, status: ok ? "ok" : "noop" };
    }
    case "folder.deleteTree": {
      // D56：浏览器删目录 → 递归删库内目录树 + 子书签（子优先，不受"仅空目录"限制）
      const r = store.deleteFolderTree(m.appFolderId, { skipMirrorRemoveForDevice: deviceId });
      return { kind: m.kind, appFolderId: m.appFolderId, status: r.folders > 0 ? "ok" : "noop" };
    }
    default:
      return { kind: str((m as { kind?: unknown })?.kind) as SyncMutation["kind"], status: "skipped", error: "unknown_kind" };
  }
}
