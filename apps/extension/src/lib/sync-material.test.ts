import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(), getConfig: vi.fn(), saveConfig: vi.fn(),
  browser: {
    storage: { local: { get: vi.fn(), set: vi.fn() } },
    bookmarks: { getTree: vi.fn(), get: vi.fn(), getChildren: vi.fn(), search: vi.fn(), create: vi.fn(), update: vi.fn(), move: vi.fn(), remove: vi.fn(), removeTree: vi.fn() },
    alarms: { create: vi.fn() },
  },
}));
vi.mock("wxt/browser", () => ({ browser: mocks.browser }));
vi.mock("./api", () => ({ api: mocks.api, getConfig: mocks.getConfig, saveConfig: mocks.saveConfig }));
vi.mock("./device", () => ({ getDeviceId: async () => "device", pruneEmptyMirrorFolders: async () => 0 }));
vi.mock("./executor", () => ({ withBrowserExecutor: async (fn: () => Promise<unknown>) => fn() }));
import { runSyncTick } from "./sync";
import type { Mutation, Snapshot } from "./sync-plan";

interface Node { id: string; title: string; parentId?: string; url?: string; children?: Node[] }
interface Book { id: string; title: string; url_raw: string; folder_id: string; content_revision: number; materialized_at: string | null }
interface Change { id: number; entity: string; entity_id: string; op: string; payload: unknown }

function harness(inInbox = false) {
  const book: Book = { id: "app", title: "Video", url_raw: "https://www.bilibili.com/video/BVtest", folder_id: "folder", content_revision: 3, materialized_at: null };
  const nodes = new Map<string, Node>([
    ["0", { id: "0", title: "" }],
    ["1", { id: "1", title: "Bookmarks Bar", parentId: "0" }],
    ["2", { id: "2", title: "Other bookmarks", parentId: "0" }],
    ["F", { id: "F", title: "Reading", parentId: "1" }],
    ["box", { id: "box", title: "📥 收纳盒", parentId: "1" }],
    ["node", { id: "node", title: book.title, url: book.url_raw, parentId: inInbox ? "box" : "F" }],
  ]);
  const snapshot: Snapshot = {
    folders: { F: { t: "Reading", p: "1" } },
    leaves: inInbox ? {} : { node: { u: book.url_raw, t: book.title, p: "F", f: "folder" } },
  };
  const state: Record<string, unknown> = {
    favoritesSync: true, syncCursor: 0, inboxExtId: "box", mfSyncGeneration: "g",
    mfSyncSnapshot: snapshot, mfSyncFolderMap: { F: "folder" },
    mfSyncBookmarkMap: inInbox ? {} : { app: "node" }, mfSyncRevisions: { app: 3 }, mfSyncOutbox: [],
  };
  const rows = [
    { id: "folder", name: "Reading", parent_id: null, root: "bar", rev: 1 },
    { id: "inbox", name: "📥 收纳盒", parent_id: null, root: "bar", is_system_inbox: 1, rev: 1 },
  ];
  const identities = [{ app_bookmark_id: "app", browser_bookmark_id: "node" }];
  const changes: Change[] = [];
  const mutations: Mutation[] = [];
  const controls = { removeFails: false, identitiesFail: false, bookMissing: false, bookReadFails: false };
  const children = (id: string) => Array.from(nodes.values()).filter((n) => n.parentId === id);
  const tree = (id: string): Node => ({ ...nodes.get(id)!, ...(nodes.get(id)!.url ? {} : { children: children(id).map((n) => tree(n.id)) }) });
  let nextId = 0;
  mocks.getConfig.mockImplementation(async () => ({ ...state, favoritesSync: true, inboxExtId: "box" }));
  mocks.saveConfig.mockImplementation(async (patch: Record<string, unknown>) => Object.assign(state, patch));
  mocks.browser.storage.local.get.mockImplementation(async (key: string) => ({ [key]: structuredClone(state[key]) }));
  mocks.browser.storage.local.set.mockImplementation(async (patch: Record<string, unknown>) => Object.assign(state, structuredClone(patch)));
  mocks.browser.bookmarks.getTree.mockImplementation(async () => [tree("0")]);
  mocks.browser.bookmarks.get.mockImplementation(async (id: string) => nodes.has(id) ? [{ ...nodes.get(id)! }] : []);
  mocks.browser.bookmarks.getChildren.mockImplementation(async (id: string) => children(id).map((n) => ({ ...n })));
  mocks.browser.bookmarks.search.mockImplementation(async (query: { url?: string; title?: string }) => Array.from(nodes.values()).filter((n) => query.url ? n.url === query.url : n.title === query.title));
  mocks.browser.bookmarks.create.mockImplementation(async (input: Omit<Node, "id">) => {
    const node = { ...input, id: `new-${++nextId}` };
    nodes.set(node.id, node);
    return node;
  });
  mocks.browser.bookmarks.update.mockImplementation(async (id: string, patch: Partial<Node>) => Object.assign(nodes.get(id)!, patch));
  mocks.browser.bookmarks.move.mockImplementation(async (id: string, patch: Partial<Node>) => Object.assign(nodes.get(id)!, patch));
  mocks.browser.bookmarks.remove.mockImplementation(async (id: string) => {
    if (controls.removeFails) throw new Error("injected remove failure");
    nodes.delete(id);
  });
  mocks.api.mockImplementation(async (url: string, options?: { body?: string }) => {
    if (url === "/folders") return structuredClone(rows);
    if (url.startsWith("/browser/folder-identities")) return { identities: [{ browser_folder_id: "F", app_folder_id: "folder", app_exists: true }] };
    if (url.startsWith("/browser/identities")) {
      if (controls.identitiesFail) throw new Error("identity endpoint offline");
      return { identities: identities.map((i) => ({ ...i, app_exists: !book.materialized_at })) };
    }
    if (url.startsWith("/sync/pull")) return { items: changes.splice(0), cursor: Number(state.syncCursor) + 10, generation: "g" };
    if (url === "/sync/snapshot") return { folders: structuredClone(rows), bookmarks: book.materialized_at ? [] : [structuredClone(book)], watermark: 10, generation: "g", minAvailableId: 1 };
    if (url.startsWith("/bookmarks?")) {
      const folder = new URL(`https://fixture${url}`).searchParams.get("folderId");
      return !controls.bookMissing && !book.materialized_at && folder === book.folder_id ? [structuredClone(book)] : [];
    }
    if (url === "/bookmarks/app") {
      if (controls.bookReadFails) throw new Error("api /bookmarks/app failed: HTTP 503");
      if (controls.bookMissing) throw new Error("api /bookmarks/app failed: HTTP 404");
      return structuredClone(book);
    }
    if (url === "/sync/apply") {
      const batch = JSON.parse(options!.body!) as { mutations: Mutation[] };
      mutations.push(...batch.mutations);
      return { results: batch.mutations.map((mut) => {
        if (mut.kind === "bookmark.create") {
          identities.push({ app_bookmark_id: book.id, browser_bookmark_id: String(mut.browserId) });
          return { kind: mut.kind, status: "bound", appBookmarkId: book.id, appFolderId: book.folder_id, entity: structuredClone(book) };
        }
        return { kind: mut.kind, status: "noop", appFolderId: mut.appFolderId };
      }), cursor: 10 };
    }
    throw new Error(`Unexpected API ${url}`);
  });
  const change = (op: string, row: Book) => changes.push({ id: changes.length + 1, entity: "bookmark", entity_id: row.id, op, payload: structuredClone(row) });
  const convert = () => {
    Object.assign(book, { materialized_at: "2026-11-24T00:00:00Z", content_revision: 4, folder_id: "inbox" });
    change("materialize", book);
  };
  const restore = () => {
    Object.assign(book, { materialized_at: null, content_revision: 5, folder_id: "folder" });
    change("upsert", book);
  };
  const visible = () => Array.from(nodes.values()).filter((n) => n.url === book.url_raw);
  return { book, nodes, state, changes, controls, mutations, change, convert, restore, visible };
}

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("D91 资料转换的浏览器生命周期", () => {
  it.each([false, true])("撤下普通目录/收纳盒节点（inInbox=%s），不反向发送库删除", async (inInbox) => {
    const h = harness(inInbox);
    h.convert();
    const result = await runSyncTick();
    expect(result.state).toBe("ok");
    expect(h.visible()).toHaveLength(0);
    expect(h.mutations.some((m) => m.kind === "bookmark.delete")).toBe(false);
    expect((h.state.mfSyncSnapshot as Snapshot).leaves.node).toBeUndefined();
    expect(h.state.mfSyncRevisions).toMatchObject({ app: 4 });
  });

  it("同批转换→恢复按顺序收敛：恢复节点不被批尾旧删除再次移除", async () => {
    const h = harness();
    h.convert();
    h.restore();
    await runSyncTick();
    expect(h.visible()).toHaveLength(1);
    expect(h.visible()[0]!.parentId).toBe("F");
    expect(h.mutations.some((m) => m.kind === "bookmark.delete")).toBe(false);
    expect(h.state.mfSyncRevisions).toMatchObject({ app: 5 });
  });

  it("恢复后重放旧转换重试按修订丢弃，不撤下已恢复节点", async () => {
    const h = harness();
    const old = { ...h.book, materialized_at: "2026-11-24T00:00:00Z", content_revision: 4 };
    h.state.mfSyncRevisions = { app: 5 };
    h.book.content_revision = 5;
    h.state.mfSyncRetryQueue = [{ item: { id: 4, entity: "bookmark", entity_id: "app", op: "materialize", payload: old }, attempts: 1, lastError: "offline", createdAt: Date.now() }];
    await runSyncTick();
    expect(h.visible()).toHaveLength(1);
    expect(h.state.mfSyncRetryQueue).toEqual([]);
    expect(mocks.browser.bookmarks.remove).not.toHaveBeenCalled();
  });

  it("撤节点失败持久重试，失败期间恢复后旧重试不会覆盖新状态", async () => {
    const h = harness();
    h.convert();
    h.controls.removeFails = true;
    expect((await runSyncTick()).state).toBe("retrying");
    expect(h.state.mfSyncRetryQueue).toEqual([expect.objectContaining({ item: expect.objectContaining({ op: "materialize" }) })]);
    h.restore();
    await runSyncTick();
    h.controls.removeFails = false;
    await runSyncTick();
    expect(h.visible()).toHaveLength(1);
    expect(h.state.mfSyncRetryQueue).toEqual([]);
  });

  it("迟到旧upsert不能复活转资料节点，带隐藏标记的更新也只撤节点", async () => {
    const h = harness();
    const old = structuredClone(h.book);
    h.convert();
    h.change("upsert", old);
    h.change("upsert", h.book);
    await runSyncTick();
    expect(h.visible()).toHaveLength(0);
    expect(mocks.browser.bookmarks.create).not.toHaveBeenCalled();
    expect(h.mutations.some((m) => m.kind === "bookmark.delete")).toBe(false);
  });

  it("确认积压旧删除时重查现值，已恢复的收藏不再次删除", async () => {
    const h = harness();
    h.book.content_revision = 5;
    h.state.mfSyncRevisions = { app: 5 };
    h.state.mfSyncPendingDeletes = { bookmarks: [{ id: "app", url: h.book.url_raw }], folders: [], at: Date.now() };
    await runSyncTick({ confirmDeletes: true });
    expect(h.visible()).toHaveLength(1);
    expect(mocks.browser.bookmarks.remove).not.toHaveBeenCalled();
    expect(h.state.mfSyncPendingDeletes).toMatchObject({ bookmarks: [] });
  });

  it("物理删除须读到404才撤节点，503持久重试且不误判不存在", async () => {
    const h = harness();
    h.controls.bookReadFails = true;
    h.changes.push({ id: 1, entity: "bookmark", entity_id: "app", op: "delete", payload: { url: h.book.url_raw } });
    expect((await runSyncTick()).state).toBe("retrying");
    expect(h.visible()).toHaveLength(1);
    h.controls.bookReadFails = false;
    h.controls.bookMissing = true;
    await runSyncTick();
    expect(h.visible()).toHaveLength(0);
    expect(h.state.mfSyncRetryQueue).toEqual([]);
    expect(h.mutations.some((m) => m.kind === "bookmark.delete")).toBe(false);
  });

  it("缺少本地映射时按服务端身份撤节点，身份读取失败不假成功", async () => {
    const h = harness(true);
    h.convert();
    h.controls.identitiesFail = true;
    const failed = await runSyncTick();
    expect(failed.state).toBe("error");
    expect(failed.error).toContain("identity endpoint offline");
    expect(h.state.mfSyncRetryQueue).toEqual([expect.objectContaining({ item: expect.objectContaining({ op: "materialize" }) })]);
    expect(h.visible()).toHaveLength(1);
    h.controls.identitiesFail = false;
    await runSyncTick();
    expect(h.visible()).toHaveLength(0);
    expect(h.state.mfSyncRetryQueue).toEqual([]);
  });
});
