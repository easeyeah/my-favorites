import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMBIGUOUS_FOLDER_COPIES,
  ambiguousBookmarkCopies,
  applyOpResult,
  buildPushOps,
  claimFolderCandidates,
  emptyBrowserDeletePlan,
  folderIdentitySplits,
  folderPathOf,
  pendingProtection,
  readyOutboxOps,
  type DrainState,
  type FolderIndex,
  type LibFolderRow,
  type Mutation,
  type OutOp,
  type PushPlanInput,
  type Snapshot,
  type Walked,
} from "./sync-plan";

const mocks = vi.hoisted(() => ({ api: vi.fn(), getConfig: vi.fn(), browser: { storage: { local: { get: vi.fn(), set: vi.fn() } }, bookmarks: { getTree: vi.fn(), get: vi.fn(), getChildren: vi.fn(), search: vi.fn(), create: vi.fn(), update: vi.fn(), move: vi.fn(), remove: vi.fn(), removeTree: vi.fn() }, alarms: { create: vi.fn() } } }));
vi.mock("wxt/browser", () => ({ browser: mocks.browser }));
vi.mock("./api", () => ({ api: mocks.api, getConfig: mocks.getConfig, saveConfig: vi.fn() }));
vi.mock("./device", () => ({ getDeviceId: async () => "device", pruneEmptyMirrorFolders: async () => 0 }));
vi.mock("./executor", () => ({ withBrowserExecutor: async (fn: () => Promise<unknown>) => fn() }));
import { runSyncTick } from "./sync";

const index = (rows: LibFolderRow[]): FolderIndex => {
  const paths = new Map<string, string[]>();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path = (id: string): string[] => {
    const row = byId.get(id)!;
    const p = row.parent_id ? [...path(row.parent_id), row.name] : [row.name];
    paths.set(id, p);
    return p;
  };
  for (const row of rows) path(row.id);
  return { rows: byId, pathById: paths, idByPath: new Map(), rootById: new Map(rows.map((r) => [r.id, r.root ?? "bar"])), inboxFolderId: null };
};
const walkOf = (folders: Record<string, { t: string; p: string }>, leaves: Snapshot["leaves"] = {}, roots: Record<string, string> = {}): Walked => ({
  snapshot: { folders, leaves },
  folderOrder: Object.keys(folders),
  leafList: Object.entries(leaves).map(([id, l]) => ({ id, path: folderPathOf(l.p, folders), root: roots[l.p] ?? "bar" })),
  folderIdByPath: new Map(), // 空索引也必须正确：path 不是身份
  rootByFolderId: new Map(Object.keys(folders).map((id) => [id, roots[id] ?? "bar"])),
  liveBrowserFolderIds: ["0", "1", "2", ...Object.keys(folders), "inbox", "inbox-hidden-child"],
});
const input = (walk: Walked, extra: Partial<PushPlanInput> = {}): PushPlanInput => {
  let n = 0;
  return { walk, folders: index([]), fMap: {}, bmMap: {}, confirmedLeaves: {}, existence: { folders: {}, leaves: {} }, revisions: {}, outbox: [], retryEntities: new Set(), rejected: {}, deletePlan: emptyBrowserDeletePlan(), unbinds: [], now: 100, newOpId: () => `op-${++n}`, ...extra };
};
const drainState = (): DrainState => ({ base: { folders: {}, leaves: {} }, fMap: {}, bmMap: {}, revisions: {}, rejected: {}, stats: { pushedOk: 0, conflicts: 0, deletedLibrary: 0 } });
const folder = (id: string, name: string, parent_id: string | null = null, root = "bar"): LibFolderRow => ({ id, name, parent_id, root, rev: 1 });

const fixture = () => {
  const walk = walkOf({ P: { t: "L待整理", p: "1" }, A1: { t: "app", p: "P" }, C1: { t: "child", p: "A1" }, A2: { t: "app", p: "P" }, C2: { t: "child", p: "A2" } }, { b1: { u: "https://one.example/", t: "One", p: "C1" }, b2: { u: "https://two.example/", t: "Two", p: "C2" } });
  const rows = [folder("aP", "L待整理"), folder("aA", "app", "aP"), folder("aC", "child", "aA")];
  const fMap = { P: "aP", A1: "aA", A2: "aA", C1: "aC", C2: "aC" };
  return { walk, rows, fMap };
};

describe("目录身份计划：父身份 + root + name，一对一认领", () => {
  it("同父六个同名兄弟及同名孙目录不会 last-wins；唯一旧目录仍可认领", () => {
    const folders: Snapshot["folders"] = { P: { t: "L", p: "1" } };
    for (let i = 0; i < 6; i++) { folders[`A${i}`] = { t: "app", p: "P" }; folders[`C${i}`] = { t: "child", p: `A${i}` }; }
    const walk = walkOf(folders);
    const rows = [folder("aP", "L"), ...Array.from({ length: 6 }, (_, i) => folder(`a${i}`, "app", "aP")), ...Array.from({ length: 6 }, (_, i) => folder(`c${i}`, "child", `a${i}`))];
    const claims = claimFolderCandidates({}, walk, index(rows));
    expect(new Set(Object.values(claims)).size).toBe(13);
    for (let i = 0; i < 6; i++) expect(index(rows).rows.get(claims[`C${i}`]!)!.parent_id).toBe(claims[`A${i}`]);
    const plan = buildPushOps(input(walk, { folders: index([folder("aP", "L"), folder("old", "app", "aP")]) }));
    expect(plan.ops.filter((op) => op.mut.appFolderId === "old")).toHaveLength(1);
    expect(plan.ops.find((op) => op.mut.appFolderId === "old")!.kind).toBe("folder.ensure");
    expect(plan.ops.find((op) => op.mut.appFolderId === "aP")!.mut.liveBrowserFolderIds).toContain("inbox-hidden-child");
  });

  it("相同字符串路径按父身份区分，不同根同名目录不串号", () => {
    const walk = walkOf({ P1: { t: "same", p: "1" }, C1: { t: "child", p: "P1" }, P2: { t: "same", p: "1" }, C2: { t: "child", p: "P2" }, O: { t: "same", p: "2" } }, {}, { O: "other" });
    const claims = claimFolderCandidates({ P1: "p1", P2: "p2" }, walk, index([folder("p1", "same"), folder("p2", "same"), folder("c1", "child", "p1"), folder("c2", "child", "p2"), folder("other", "same", null, "other")]));
    expect(claims).toEqual({ C1: "c1", C2: "c2", O: "other" });
  });

  it("历史多个映射但仅一个活 ID 不触发分离；活冲突保留者确定且不依赖映射插入顺序", () => {
    const walk = walkOf({ A: { t: "app", p: "1" } });
    expect(folderIdentitySplits({ dead1: "a", A: "a", dead2: "a" }, walk).size).toBe(0);
    const both = walkOf({ B: { t: "app", p: "1" }, A: { t: "app", p: "1" } });
    expect(Array.from(folderIdentitySplits({ B: "a", dead: "a", A: "a" }, both))).toEqual([["B", "a"]]);
  });

  it("活多对一发 separateFrom，孙目录与 p 未变的书签都依赖分离；不发删除或重命名", () => {
    const { walk, rows, fMap } = fixture();
    const plan = buildPushOps(input(walk, { folders: index(rows), fMap, bmMap: { one: "b1", two: "b2" }, confirmedLeaves: structuredClone(walk.snapshot.leaves) }));
    const a = plan.ops.find((op) => op.entity === "fd:A2")!;
    const c = plan.ops.find((op) => op.entity === "fd:C2")!;
    const b = plan.ops.find((op) => op.entity === "bm:b2")!;
    expect(a.mut).toMatchObject({ kind: "folder.create", separateFromAppFolderId: "aA", parentBrowserFolderId: "P" });
    expect(c.mut.separateFromAppFolderId).toBe("aC");
    expect(c.deps).toEqual([a.opId]);
    expect(b.mut).toMatchObject({ kind: "bookmark.update", browserFolderId: "C2" });
    expect(b.deps).toEqual([c.opId]);
    expect(plan.ops.some((op) => /delete|rename/.test(op.kind))).toBe(false);
    expect(readyOutboxOps(plan.ops).map((op) => op.opId)).toEqual([a.opId]);
  });

  it("分离成功后即使 browser p 完全未变，已确认 f 仍触发目录归属重提", () => {
    const walk = walkOf({ B: { t: "app", p: "1" } }, { b: { u: "https://x.example/", t: "X", p: "B" } });
    const plan = buildPushOps(input(walk, { folders: index([folder("new", "app")]), fMap: { B: "new" }, bmMap: { app: "b" }, confirmedLeaves: { b: { ...walk.snapshot.leaves.b!, f: "old" } } }));
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]!.mut).toMatchObject({ kind: "bookmark.update", browserFolderId: "B" });
    expect(plan.ops[0]!.identityRepair).toBe(true);
  });

  it("ensure/separate 必须逐条成功且身份正确；HTTP200里的 failed、缺身份、旧 bound 都不能写 fMap", () => {
    const st = drainState();
    const op: OutOp = { opId: "stable", kind: "folder.ensure", entity: "fd:B", mut: { appFolderId: "exact", browserFolderId: "B" }, createdAt: 1, attempts: 0 };
    for (const result of [{ status: "failed", error: "occupied" }, { status: "ok" }, { status: "ok", appFolderId: "wrong" }]) {
      expect(applyOpResult(st, op, { kind: op.kind, ...result }, 2).remove).toBe(false);
      expect(st.fMap).toEqual({});
    }
    expect(applyOpResult(st, op, { kind: op.kind, status: "ok", appFolderId: "exact" }, 3).remove).toBe(true);
    expect(st.fMap.B).toBe("exact");
    const split = { ...op, kind: "folder.create", mut: { browserFolderId: "B", separateFromAppFolderId: "exact" } };
    expect(applyOpResult(st, split, { kind: split.kind, status: "bound", appFolderId: "exact" }, 4)).toMatchObject({ remove: false, error: "folder_identity_not_separated" });
    expect(op.opId).toBe("stable");
  });

  it("相等revision的noop推进f，严格更旧回执仍不回退已确认归属", () => {
    const st = drainState();
    st.base.leaves.b = { u: "https://x.example/", t: "X", p: "B", f: "old" };
    st.revisions.app = 5;
    const op: OutOp = { opId: "same-revision", kind: "bookmark.update", entity: "bm:b", mut: { browserId: "b", browserFolderId: "B" }, createdAt: 1, attempts: 0, identityRepair: true };
    const entity = { id: "app", url_raw: "https://x.example/", title: "X", folder_id: "new", content_revision: 5 };
    expect(applyOpResult(st, op, { kind: op.kind, status: "noop", appBookmarkId: "app", entity }, 2).remove).toBe(true);
    expect(st.base.leaves.b!.f).toBe("new");
    applyOpResult(st, op, { kind: op.kind, status: "ok", appBookmarkId: "app", entity: { ...entity, folder_id: "older", content_revision: 4 } }, 3);
    expect(st.base.leaves.b!.f).toBe("new");
  });

  it("未绑定待创建目录及其子书签消失时取消未决create，不发树删也不复活", () => {
    const folderOp: OutOp = { opId: "parent-create", kind: "folder.create", entity: "fd:G", mut: { browserFolderId: "G", name: "gone", parentBrowserFolderId: "1" }, createdAt: 1, attempts: 1 };
    const bookOp: OutOp = { opId: "book-create", kind: "bookmark.create", entity: "bm:gone-book", mut: { browserId: "gone-book", browserFolderId: "G", url: "https://gone.example/" }, deps: [folderOp.opId], createdAt: 1, attempts: 0 };
    const plan = buildPushOps(input(walkOf({}), { outbox: [folderOp, bookOp] }));
    expect(plan.superseded).toEqual([folderOp.opId, bookOp.opId]);
    expect(plan.ops).toEqual([]);
    expect(folderOp.opId).toBe("parent-create");
  });

  it("保护集扩张真实子树，不按同名路径误保护另一兄弟", () => {
    const { walk, fMap } = fixture();
    const op: OutOp = { opId: "repair", kind: "folder.create", entity: "fd:A2", mut: {}, createdAt: 1, attempts: 1 };
    const protection = pendingProtection(walk.snapshot, fMap, [op]);
    expect(Array.from(protection.folders)).toEqual(["A2", "C2"]);
    expect(Array.from(protection.leaves)).toEqual(["b2"]);
    expect(protection.folders.has("C1")).toBe(false);
  });

  it("跨分支 canonical URL 副本保守保留，持久标歧义而非推送/静默成功", () => {
    const { walk, rows, fMap } = fixture();
    walk.snapshot.leaves.b2!.u = "https://one.example/?utm_source=test";
    expect(Array.from(ambiguousBookmarkCopies(walk.snapshot))).toEqual(["b1", "b2"]);
    const inp = input(walk, { folders: index(rows), fMap, bmMap: { one: "b1", two: "b2" }, confirmedLeaves: { b1: { u: "https://one.example/", t: "One", p: "C1" }, b2: { u: "https://two.example/", t: "Two", p: "C2" } } });
    expect(buildPushOps(inp).ops.every((op) => op.kind.startsWith("folder."))).toBe(true);
    expect(inp.rejected["bm:b2"]!.error).toBe(AMBIGUOUS_FOLDER_COPIES);
    const next = buildPushOps({ ...inp, fMap: { P: "aP", A1: "aA", C1: "aC", A2: "newA", C2: "newC" } });
    expect(next.ops.every((op) => op.kind.startsWith("folder."))).toBe(true);
  });
});

interface Node { id: string; title: string; parentId?: string; url?: string; children?: Node[] }
interface Book { id: string; title: string; url_raw: string; folder_id: string; content_revision: number }
function harness() {
  const { walk, rows, fMap } = fixture();
  const nodes = new Map<string, Node>([["0", { id: "0", title: "" }], ["1", { id: "1", title: "Bookmarks Bar", parentId: "0" }], ["2", { id: "2", title: "Other bookmarks", parentId: "0" }]]);
  for (const [id, f] of Object.entries(walk.snapshot.folders)) nodes.set(id, { id, title: f.t, parentId: f.p });
  for (const [id, b] of Object.entries(walk.snapshot.leaves)) nodes.set(id, { id, title: b.t, url: b.u, parentId: b.p });
  nodes.set("inbox", { id: "inbox", title: "📥 收纳盒", parentId: "1" });
  nodes.set("hidden", { id: "hidden", title: "hidden", parentId: "inbox" });
  const store: Record<string, unknown> = { mfSyncSnapshot: structuredClone(walk.snapshot), mfSyncFolderMap: { ...fMap }, mfSyncBookmarkMap: { one: "b1", two: "b2" }, mfSyncOutbox: [], favoritesSync: true };
  const books: Book[] = [{ id: "one", title: "One", url_raw: "https://one.example/", folder_id: "aC", content_revision: 1 }, { id: "two", title: "Two", url_raw: "https://two.example/", folder_id: "aC", content_revision: 1 }];
  const serverMap: Record<string, string> = { ...fMap };
  const batches: Mutation[][] = [];
  const controls = { failCreate: true, failEnsure: false, failRefresh: false, failIdentity: false, firstFolders: null as LibFolderRow[] | null, pull: [] as Array<{ id: number; entity: string; entity_id: string; op: string; payload: unknown }> };
  let nextId = 0;
  mocks.getConfig.mockImplementation(async () => ({ favoritesSync: true, syncCursor: 0, inboxExtId: "inbox" }));
  mocks.browser.storage.local.get.mockImplementation(async (key: string) => ({ [key]: structuredClone(store[key]) }));
  mocks.browser.storage.local.set.mockImplementation(async (data: Record<string, unknown>) => { Object.assign(store, structuredClone(data)); });
  const children = (id: string) => Array.from(nodes.values()).filter((n) => n.parentId === id);
  const tree = (id: string): Node => ({ ...nodes.get(id)!, ...(nodes.get(id)!.url ? {} : { children: children(id).map((n) => tree(n.id)) }) });
  mocks.browser.bookmarks.getTree.mockImplementation(async () => [tree("0")]);
  mocks.browser.bookmarks.get.mockImplementation(async (id: string) => nodes.has(id) ? [{ ...nodes.get(id)! }] : []);
  mocks.browser.bookmarks.getChildren.mockImplementation(async (id: string) => children(id).map((n) => ({ ...n })));
  mocks.browser.bookmarks.search.mockImplementation(async (query: { url?: string; title?: string }) => Array.from(nodes.values()).filter((n) => query.url ? n.url === query.url : n.title === query.title));
  mocks.browser.bookmarks.create.mockImplementation(async (data: Omit<Node, "id">) => { const node = { ...data, id: `created-${++nextId}` }; nodes.set(node.id, node); return node; });
  mocks.browser.bookmarks.update.mockImplementation(async (id: string, patch: Partial<Node>) => { Object.assign(nodes.get(id)!, patch); return nodes.get(id); });
  mocks.browser.bookmarks.move.mockImplementation(async (id: string, patch: { parentId: string }) => { Object.assign(nodes.get(id)!, { parentId: patch.parentId }); return nodes.get(id); });
  mocks.browser.bookmarks.remove.mockImplementation(async (id: string) => { nodes.delete(id); });
  mocks.api.mockImplementation(async (url: string, options?: { body?: string }) => {
    if (url === "/folders") {
      if (controls.firstFolders) { const first = controls.firstFolders; controls.firstFolders = null; return structuredClone(first); }
      if (controls.failRefresh) throw new Error("folder_index_offline");
      return structuredClone(rows);
    }
    if (url.startsWith("/browser/folder-identities")) {
      if (controls.failIdentity) throw new Error("folder_identity_offline");
      return { identities: Object.entries(serverMap).map(([browser_folder_id, app_folder_id]) => ({ browser_folder_id, app_folder_id, app_exists: rows.some((r) => r.id === app_folder_id) })) };
    }
    if (url.startsWith("/sync/pull")) { const items = controls.pull.splice(0); return { items, cursor: 10 }; }
    if (url === "/sync/snapshot") return { folders: structuredClone(rows), bookmarks: structuredClone(books), watermark: 10, generation: "g", minAvailableId: 1 };
    if (url.startsWith("/browser/identities")) return { identities: [{ browser_bookmark_id: "b1", app_bookmark_id: "one", app_exists: true }, { browser_bookmark_id: "b2", app_bookmark_id: "two", app_exists: true }] };
    if (url.startsWith("/bookmarks?")) { const app = new URL(`https://local${url}`).searchParams.get("folderId"); return structuredClone(books.filter((b) => b.folder_id === app)); }
    if (url === "/sync/apply") {
      const { mutations } = JSON.parse(options!.body!) as { mutations: Mutation[] };
      batches.push(structuredClone(mutations));
      return { results: mutations.map((mut) => {
        const bid = String(mut.browserFolderId ?? mut.browserId ?? "");
        if (mut.kind === "folder.create") {
          if (controls.failCreate) return { kind: mut.kind, status: "failed", error: "injected_parent_failure" };
          const id = `new-app-${bid}`;
          if (!rows.some((r) => r.id === id)) rows.push(folder(id, String(mut.name), serverMap[String(mut.parentBrowserFolderId)] ?? null));
          serverMap[bid] = id;
          return { kind: mut.kind, status: "ok", appFolderId: id, entity: rows.find((r) => r.id === id) };
        }
        if (mut.kind === "folder.ensure") {
          if (controls.failEnsure) return { kind: mut.kind, status: "failed", error: "folder_identity_occupied" };
          expect(mut.appFolderId).toBeTruthy();
          expect(mut.liveBrowserFolderIds).toContain("hidden");
          expect(mut.liveBrowserFolderIds).toContain(bid);
          serverMap[bid] = String(mut.appFolderId);
          return { kind: mut.kind, status: "ok", appFolderId: mut.appFolderId };
        }
        if (mut.kind === "bookmark.update") {
          const book = books.find((b) => b.id === (mut.browserId === "b1" ? "one" : "two"))!;
          if (mut.browserFolderId) book.folder_id = serverMap[String(mut.browserFolderId)]!;
          if (mut.url) book.url_raw = String(mut.url);
          book.content_revision++;
          return { kind: mut.kind, status: "ok", appBookmarkId: book.id, appFolderId: book.folder_id, entity: structuredClone(book) };
        }
        return { kind: mut.kind, status: "ok" };
      }), cursor: 10 };
    }
    throw new Error(`Unexpected API ${url}`);
  });
  return { store, nodes, rows, books, serverMap, batches, controls };
}

function uniqueHarness() {
  const h = harness();
  h.store.mfSyncFolderMap = { P: "aP", A1: "aA", A2: "aA2", C1: "aC", C2: "aC2" };
  Object.assign(h.serverMap, h.store.mfSyncFolderMap);
  h.rows.push(folder("aA2", "app", "aP"), folder("aC2", "child", "aA2"));
  h.books.find((b) => b.id === "two")!.folder_id = "aC2";
  return h;
}

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("同步执行器 · 身份恢复与故障可观测（无构建/无真浏览器）", () => {
  it("父分离失败时子/书签不发送、子树不回退；重试保持 opId，恢复后归属正确", async () => {
    const h = harness();
    const first = await runSyncTick();
    expect(first.state).toBe("retrying");
    const pending = h.store.mfSyncOutbox as OutOp[];
    const parent = pending.find((op) => op.entity === "fd:A2")!;
    expect(parent.lastError).toBe("injected_parent_failure");
    expect(h.batches.flat().filter((mut) => mut.kind === "folder.create").map((mut) => mut.browserFolderId)).toEqual(["A2"]);
    expect(h.batches.flat().some((mut) => mut.kind === "bookmark.update")).toBe(false);
    expect(h.nodes.get("b2")!.parentId).toBe("C2");
    expect(mocks.browser.bookmarks.removeTree).not.toHaveBeenCalled();
    expect(mocks.browser.bookmarks.update).not.toHaveBeenCalled();
    await runSyncTick();
    const retries = h.batches.flat().filter((mut) => mut.kind === "folder.create" && mut.browserFolderId === "A2");
    expect(new Set(retries.map((mut) => mut.opId))).toEqual(new Set([parent.opId]));
    h.controls.failCreate = false;
    const fixed = await runSyncTick();
    expect(fixed.state).toBe("ok");
    expect(h.serverMap.A2).not.toBe(h.serverMap.A1);
    expect(h.serverMap.C2).not.toBe(h.serverMap.C1);
    expect(h.books.find((b) => b.id === "two")!.folder_id).toBe(h.serverMap.C2);
    expect(h.nodes.get("b1")!.parentId).toBe("C1");
    expect(h.nodes.get("b2")!.parentId).toBe("C2");
    expect(h.store.mfSyncOutbox).toEqual([]);
  });

  it("重复canonical副本保护browser ID及其库实体：旧库URL也不能覆盖用户新URL/父目录", async () => {
    const h = harness();
    h.controls.failCreate = false;
    h.nodes.get("b2")!.url = "https://one.example/";
    const info = await runSyncTick();
    expect(info.state).toBe("error");
    expect(info.error).toContain(AMBIGUOUS_FOLDER_COPIES);
    expect(h.nodes.get("b1")).toMatchObject({ parentId: "C1", url: "https://one.example/" });
    expect(h.nodes.get("b2")).toMatchObject({ parentId: "C2", url: "https://one.example/" });
    expect(h.batches.flat().some((mut) => String(mut.kind).startsWith("bookmark."))).toBe(false);
    expect(mocks.browser.bookmarks.update).not.toHaveBeenCalled();
  });

  it("/folders与pull竞态的新空目录刷新后创建；全集含新建ID与被豁免子树", async () => {
    const h = harness();
    h.store.mfSyncFolderMap = { P: "aP", A1: "aA", A2: "aA2", C1: "aC", C2: "aC2" };
    Object.assign(h.serverMap, h.store.mfSyncFolderMap);
    h.rows.push(folder("aA2", "app", "aP"), folder("aC2", "child", "aA2"));
    h.controls.firstFolders = structuredClone(h.rows);
    h.rows.push(folder("late", "Late empty", "aP"));
    h.controls.pull.push({ id: 1, entity: "folder", entity_id: "late", op: "upsert", payload: { id: "late", name: "Late empty" } });
    const info = await runSyncTick();
    expect(info.retryCount).toBe(0);
    const created = Array.from(h.nodes.values()).find((n) => n.title === "Late empty")!;
    expect(created.parentId).toBe("P");
    expect((h.store.mfSyncFolderMap as Record<string, string>)[created.id]).toBe("late");
    expect(h.batches.flat().find((mut) => mut.appFolderId === "late")!.liveBrowserFolderIds).toContain(created.id);
  });

  it("旧upsert刷新证明已删后noop不残留retry，后续delete也不按同名删除用户新建空目录", async () => {
    const h = harness();
    h.controls.failCreate = false;
    h.store.mfSyncFolderMap = { P: "aP", A1: "aA", A2: "aA2", C1: "aC", C2: "aC2" };
    Object.assign(h.serverMap, h.store.mfSyncFolderMap);
    h.rows.push(folder("aA2", "app", "aP"), folder("aC2", "child", "aA2"));
    h.nodes.set("user-empty", { id: "user-empty", title: "same-empty", parentId: "P" });
    h.controls.pull.push(
      { id: 1, entity: "folder", entity_id: "old-deleted-app", op: "upsert", payload: { id: "old-deleted-app", name: "same-empty" } },
      { id: 2, entity: "folder", entity_id: "old-deleted-app", op: "delete", payload: { name: "same-empty" } },
    );
    const info = await runSyncTick();
    expect(info.state).toBe("ok");
    expect(info.retryCount).toBe(0);
    expect(h.store.mfSyncRetryQueue).toEqual([]);
    expect(mocks.api.mock.calls.filter(([url]) => url === "/folders")).toHaveLength(2);
    expect(mocks.browser.bookmarks.removeTree).not.toHaveBeenCalled();
    expect(h.nodes.get("user-empty")).toMatchObject({ parentId: "P", title: "same-empty" });
    expect(h.serverMap["user-empty"]).toBe("new-app-user-empty");
    expect(h.batches.flat().some((mut) => mut.kind === "folder.deleteTree")).toBe(false);
  });

  it.each(["0", "1", "2"])("历史parentId=%s且库中无该行时只落虚拟根，不递归未知库ID", async (parentId) => {
    const h = uniqueHarness();
    const root = parentId === "2" ? "other" : "bar";
    h.rows.push(folder("legacy", "Legacy empty", parentId, root));
    h.controls.pull.push({ id: 1, entity: "folder", entity_id: "legacy", op: "upsert", payload: { id: "legacy", name: "Legacy empty", root } });
    const info = await runSyncTick();
    expect(info.state).toBe("ok");
    const node = Array.from(h.nodes.values()).find((n) => n.title === "Legacy empty")!;
    expect(node.parentId).toBe(root === "other" ? "2" : "1");
    expect(h.store.mfSyncRetryQueue).toEqual([]);
    expect(h.batches.flat().some((mut) => mut.appFolderId === parentId)).toBe(false);
  });

  it("未知真实父刷新仍缺失必须持久retry，不能猜根或按字符串造目录", async () => {
    const h = uniqueHarness();
    h.rows.push(folder("orphan", "Unresolved empty", "missing-app-parent"));
    h.controls.pull.push({ id: 1, entity: "folder", entity_id: "orphan", op: "upsert", payload: { id: "orphan", name: "Unresolved empty" } });
    const info = await runSyncTick();
    expect(info.state).toBe("retrying");
    expect(h.store.mfSyncRetryQueue).toEqual([expect.objectContaining({ lastError: expect.stringContaining("folder_unknown: missing-app-parent") })]);
    expect(Array.from(h.nodes.values()).some((n) => n.title === "Unresolved empty")).toBe(false);
  });

  it("目录身份权威读取失败中止整轮，不能当空映射取消响应丢失后的未决操作", async () => {
    const h = uniqueHarness();
    const pending: OutOp = { opId: "response-lost", kind: "folder.create", entity: "fd:G", mut: { kind: "folder.create", browserFolderId: "G", name: "Gone", parentBrowserFolderId: "1" }, createdAt: Date.now(), attempts: 1 };
    h.store.mfSyncOutbox = [pending];
    h.controls.failIdentity = true;
    const info = await runSyncTick();
    expect(info.state).toBe("error");
    expect(info.error).toContain("folder_identity_offline");
    expect(h.store.mfSyncOutbox).toEqual([pending]);
    expect(h.batches).toEqual([]);
  });

  it("普通tick也保护待处理目录整棵子树，pull及resort不覆盖其未决书签", async () => {
    const h = uniqueHarness();
    const pending: OutOp = { opId: "ordinary-create", kind: "folder.create", entity: "fd:A2", mut: { kind: "folder.create", browserFolderId: "A2", name: "app", parentBrowserFolderId: "P" }, createdAt: Date.now(), attempts: 1 };
    h.store.mfSyncOutbox = [pending];
    h.controls.pull.push({ id: 1, entity: "bookmark", entity_id: "two", op: "upsert", payload: { folder_id: "aC", title: "Library changed", url_raw: "https://library.example/changed", content_revision: 2 } });
    const info = await runSyncTick();
    expect(info.phase).toBe("tick");
    expect(info.state).toBe("retrying");
    expect(h.nodes.get("b2")).toMatchObject({ parentId: "C2", url: "https://two.example/", title: "Two" });
    expect(mocks.browser.bookmarks.move.mock.calls.some(([id]) => id === "b2")).toBe(false);
    expect(h.store.mfSyncRetryQueue).toEqual([expect.objectContaining({ lastError: expect.stringContaining("bookmark_pending_local_intent") })]);
    expect((h.store.mfSyncOutbox as OutOp[]).find((op) => op.entity === "fd:A2")!.opId).toBe(pending.opId);
  });

  it("刷新/ensure逐条失败进持久retry，不吞新空目录事件也不乐观写fMap", async () => {
    const h = harness();
    h.store.mfSyncFolderMap = { P: "aP", A1: "aA", A2: "aA2", C1: "aC", C2: "aC2" };
    Object.assign(h.serverMap, h.store.mfSyncFolderMap);
    h.rows.push(folder("aA2", "app", "aP"), folder("aC2", "child", "aA2"));
    h.controls.firstFolders = structuredClone(h.rows);
    h.rows.push(folder("late", "Late empty", "aP"));
    h.controls.failRefresh = true;
    h.controls.pull.push({ id: 1, entity: "folder", entity_id: "late", op: "upsert", payload: { id: "late", name: "Late empty" } });
    const failed = await runSyncTick();
    expect(failed.state).toBe("retrying");
    expect(h.store.mfSyncRetryQueue).toEqual([expect.objectContaining({ item: expect.objectContaining({ entity_id: "late" }), lastError: expect.stringContaining("folder_index_offline") })]);
    expect(Object.values(h.store.mfSyncFolderMap as Record<string, string>)).not.toContain("late");
    h.controls.failRefresh = false;
    h.controls.failEnsure = true;
    const again = await runSyncTick();
    expect(again.state).toBe("retrying");
    expect(Object.values(h.store.mfSyncFolderMap as Record<string, string>)).not.toContain("late");
    expect(h.store.mfSyncRetryQueue).toEqual([expect.objectContaining({ lastError: expect.stringContaining("folder_identity_occupied") })]);
  });
});
