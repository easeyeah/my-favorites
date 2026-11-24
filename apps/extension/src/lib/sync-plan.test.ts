/**
 * D81 复核整改：出站操作契约（sync-plan.ts）单测——逐态断言，不以接口单步通过替代状态机验收。
 *  R02 已确认基线只在成功回执后推进；同实体至多一条未决操作；终态/可重试分类
 *  R05 baseRevision 固定绑定操作生成时；修订单调（旧回执不回退）；合并提交
 *  R07 failed 保留同 opId；成功才出队；冲突库侧优先
 *  R01 删除计划与保险丝判定；树删覆盖的叶子不单独出操作；挂起计划合并与确认范围复核
 */
import { describe, expect, it } from "vitest";
import {
  applyOpResult,
  bmKey,
  buildPushOps,
  composePayload,
  computeDeletedSets,
  emptyBrowserDeletePlan,
  evaluateDeleteGuard,
  fdKey,
  fingerprint,
  folderPathOf,
  insideDeletedFolder,
  mergeBrowserDeletePlan,
  orderForSend,
  validateBrowserDeletePlan,
  type ApplyResult,
  type DrainState,
  type FolderIndex,
  type LibFolderRow,
  type OutOp,
  type PushPlanInput,
  type RejectedRecord,
  type SnapFolder,
  type SnapLeaf,
  type Snapshot,
  type Walked,
} from "./sync-plan";

const emptySnap = (): Snapshot => ({ leaves: {}, folders: {} });

const mkWalk = (folders: Array<[string, string, string]>, leaves: Array<[string, string, string, string]>, roots: Record<string, string> = {}): Walked => {
  const fs: Record<string, SnapFolder> = {};
  for (const [id, t, p] of folders) fs[id] = { t, p };
  const ls: Record<string, SnapLeaf> = {};
  const leafList: Walked["leafList"] = [];
  for (const [id, u, t, p] of leaves) {
    ls[id] = { u, t, p };
    leafList.push({ id, path: folderPathOf(p, fs), root: roots[p] ?? "bar" });
  }
  const depth = (id: string): number => {
    let d = 0;
    let cur = fs[id];
    while (cur && !(cur.p === "1" || cur.p === "2")) {
      d++;
      cur = fs[cur.p];
    }
    return d;
  };
  const folderOrder = folders.map(([id]) => id).sort((a, b) => depth(a) - depth(b));
  return { snapshot: { leaves: ls, folders: fs }, leafList, folderOrder, folderIdByPath: new Map(), rootByFolderId: new Map(folders.map(([id]) => [id, roots[id] ?? "bar"])) };
};

const mkFolders = (rows: LibFolderRow[]): FolderIndex => ({
  pathById: new Map(),
  idByPath: new Map(),
  rootById: new Map(rows.map((r) => [r.id, r.root ?? "bar"])),
  rows: new Map(rows.map((r) => [r.id, r])),
  inboxFolderId: null,
});

const op = (kind: string, entity: string, mut: Record<string, unknown>, extra: Partial<OutOp> = {}): OutOp => ({
  opId: `id-${kind}-${entity}`,
  kind,
  entity,
  mut,
  createdAt: 1,
  attempts: 0,
  ...extra,
});

const planInput = (over: Partial<PushPlanInput> & { walk: Walked }): PushPlanInput => ({
  confirmedLeaves: {},
  existence: emptySnap(),
  folders: mkFolders([]),
  fMap: {},
  bmMap: {},
  revisions: {},
  outbox: [],
  retryEntities: new Set<string>(),
  rejected: {},
  deletePlan: emptyBrowserDeletePlan(),
  unbinds: [],
  now: 1,
  newOpId: (() => {
    let n = 0;
    return () => `op-${++n}`;
  })(),
  ...over,
});

const drainState = (over: Partial<DrainState> = {}): DrainState => ({
  base: emptySnap(),
  bmMap: {},
  fMap: {},
  revisions: {},
  rejected: {},
  stats: { pushedOk: 0, conflicts: 0, deletedLibrary: 0 },
  ...over,
});

describe("buildPushOps · 目录（R02：库态派生 + 仅成功回执后确认）", () => {
  it("未入库目录 → folder.create；子目录依赖父目录的未决创建操作", () => {
    const walk = mkWalk([["P", "新父", "1"], ["C", "子", "P"]], []);
    const r = buildPushOps(planInput({ walk }));
    expect(r.ops.map((o) => [o.kind, o.entity])).toEqual([
      ["folder.create", "fd:P"],
      ["folder.create", "fd:C"],
    ]);
    expect(r.ops[1]!.deps).toEqual([r.ops[0]!.opId]);
    expect(r.ops[0]!.mut).toMatchObject({ name: "新父", parentBrowserFolderId: "1", parentPath: [], root: "bar" });
    expect(r.ops[1]!.mut).toMatchObject({ name: "子", parentBrowserFolderId: "P", parentPath: ["新父"] });
  });

  it("已入库目录与库态一致 → 不生成操作并清除历史拒绝记录", () => {
    const walk = mkWalk([["P", "同名", "1"]], []);
    const rejected: Record<string, RejectedRecord> = { "fd:P": { fp: "x", kind: "folder.move", error: "invalid_move", at: 0 } };
    const r = buildPushOps(
      planInput({ walk, folders: mkFolders([{ id: "a1", parent_id: null, name: "同名", root: "bar", rev: 2 }]), fMap: { P: "a1" }, rejected }),
    );
    expect(r.ops).toEqual([]);
    expect(rejected["fd:P"]).toBeUndefined();
  });

  it("改名与搬家合并为一条 folder.move（带 name 与操作生成时的库侧 rev）；同实体已有未决操作时不再生成", () => {
    const walk = mkWalk([["P", "新名", "1"]], []);
    const input = planInput({ walk, folders: mkFolders([{ id: "a1", parent_id: null, name: "旧名", root: "bar", rev: 3 }]), fMap: { P: "a1" } });
    const r = buildPushOps(input);
    expect(r.ops.length).toBe(1);
    expect(r.ops[0]!.kind).toBe("folder.move");
    expect(r.ops[0]!.mut).toMatchObject({ appFolderId: "a1", browserFolderId: "P", name: "新名", toBrowserFolderId: "1", root: "bar" });
    expect(r.ops[0]!.baseRevision).toBe(3);
    // 同实体已有未决操作 → 抑制（串行承接，不互相冲突）
    const pending = op("folder.move", "fd:P", r.ops[0]!.mut, { opId: "pending-1" });
    const r2 = buildPushOps({ ...input, outbox: [pending] });
    expect(r2.ops).toEqual([]);
  });

  it("pull 未应用成功的实体（retryEntities）不得反向推送其旧浏览器状态", () => {
    const walk = mkWalk([["P", "浏览器旧名", "1"]], []);
    const r = buildPushOps(
      planInput({
        walk,
        folders: mkFolders([{ id: "a1", parent_id: null, name: "库里的新名", root: "bar", rev: 4 }]),
        fMap: { P: "a1" },
        retryEntities: new Set(["a1"]),
      }),
    );
    expect(r.ops).toEqual([]);
  });

  it("同指纹的终态拒绝操作不无限重试；实体状态变化后放行", () => {
    const walk = mkWalk([["P", "新名", "1"]], []);
    const input = planInput({ walk, folders: mkFolders([{ id: "a1", parent_id: null, name: "旧名", root: "bar", rev: 1 }]), fMap: { P: "a1" } });
    const first = buildPushOps(input);
    input.rejected["fd:P"] = { fp: fingerprint(first.ops[0]!.mut), kind: "folder.move", error: "invalid_move", at: 0 };
    expect(buildPushOps(input).ops).toEqual([]);
    // 用户再次改名（指纹变化）→ 放行
    const changed = buildPushOps({ ...input, walk: mkWalk([["P", "另一个名", "1"]], []) });
    expect(changed.ops.length).toBe(1);
    expect(changed.ops[0]!.mut.name).toBe("另一个名");
  });
});

describe("buildPushOps · 书签（R05：合并提交 + 固定绑定修订 + 串行承接）", () => {
  it("新节点 → bookmark.create，依赖其目录的未决创建操作", () => {
    const walk = mkWalk([["P", "目录", "1"]], [["n1", "https://x.example/a", "A", "P"]]);
    const r = buildPushOps(planInput({ walk }));
    expect(r.ops.map((o) => o.kind)).toEqual(["folder.create", "bookmark.create"]);
    expect(r.ops[1]!.mut).toMatchObject({ browserId: "n1", url: "https://x.example/a", browserFolderId: "P", folderPath: ["目录"] });
    expect(r.ops[1]!.deps).toEqual([r.ops[0]!.opId]);
  });

  it("同一轮改标题 + 移目录 → 一条 update（baseRevision = 操作生成时的库侧修订），目标目录按身份由服务端解析", () => {
    const confirmed = { b1: { u: "https://x.example/a", t: "旧标题", p: "P" } } as Record<string, SnapLeaf>;
    const walk = mkWalk([["P", "目录", "1"], ["Q", "新目录", "1"]], [["b1", "https://x.example/a", "新标题", "Q"]]);
    const r = buildPushOps(
      planInput({
        walk,
        confirmedLeaves: confirmed,
        folders: mkFolders([
          { id: "aP", parent_id: null, name: "目录", root: "bar", rev: 1 },
          { id: "aQ", parent_id: null, name: "新目录", root: "bar", rev: 1 },
        ]),
        bmMap: { app1: "b1" },
        fMap: { P: "aP", Q: "aQ" },
        revisions: { app1: 7 },
      }),
    );
    expect(r.ops.length).toBe(1);
    const o = r.ops[0]!;
    expect(o.kind).toBe("bookmark.update");
    expect(o.baseRevision).toBe(7);
    expect(o.mut).toMatchObject({ browserId: "b1", title: "新标题", browserFolderId: "Q", folderPath: ["新目录"] });
    expect(o.mut.url).toBeUndefined();
  });

  it("同实体已有未决操作 → 不生成第二条（前一条决出后由下一轮 diff 承接）", () => {
    const confirmed = { b1: { u: "https://x.example/a", t: "旧", p: "1" } } as Record<string, SnapLeaf>;
    const walk = mkWalk([], [["b1", "https://x.example/a", "更新意图", "1"]]);
    const pending = op("bookmark.update", bmKey("b1"), { kind: "bookmark.update", browserId: "b1", title: "前一意图" }, { opId: "p1" });
    const r = buildPushOps(planInput({ walk, confirmedLeaves: confirmed, bmMap: { app1: "b1" }, revisions: { app1: 2 }, outbox: [pending] }));
    expect(r.ops).toEqual([]);
  });

  it("本地身份缺失 → 走 create 重新绑定（新代际身份策略），不发 update", () => {
    const confirmed = { b1: { u: "https://x.example/a", t: "旧", p: "1" } } as Record<string, SnapLeaf>;
    const walk = mkWalk([], [["b1", "https://x.example/a", "新", "1"]]);
    const r = buildPushOps(planInput({ walk, confirmedLeaves: confirmed }));
    expect(r.ops[0]!.kind).toBe("bookmark.create");
  });
});

describe("buildPushOps · 删除（R01：树删与覆盖叶子是一个确认单元）", () => {
  it("删除计划 → bookmark.delete / folder.deleteTree；被删实体的未决非删除操作作废（含被删目录内的书签）", () => {
    const existence: Snapshot = {
      leaves: { b1: { u: "https://x/1", t: "1", p: "F" }, b2: { u: "https://x/2", t: "2", p: "F" }, b3: { u: "https://x/3", t: "3", p: "1" } },
      folders: { F: { t: "被删目录", p: "1" } },
    };
    const walk = mkWalk([], []);
    const pendingUpdate = op("bookmark.update", bmKey("b1"), { kind: "bookmark.update", browserId: "b1", title: "x" }, { opId: "u1" });
    const pendingCreate = op("bookmark.create", bmKey("b2"), { kind: "bookmark.create", browserId: "b2" }, { opId: "c2" });
    const pendingUpdate3 = op("bookmark.update", bmKey("b3"), { kind: "bookmark.update", browserId: "b3", title: "x" }, { opId: "u3" });
    const r = buildPushOps(
      planInput({
        walk,
        existence,
        outbox: [pendingUpdate, pendingCreate, pendingUpdate3],
        deletePlan: {
          leaves: [{ browserId: "b3", appId: "app3", url: "https://x/3" }],
          folders: [{ browserFolderId: "F", appFolderId: "aF", name: "被删目录" }],
          at: 0,
        },
        unbinds: [],
      }),
    );
    expect(r.superseded.sort()).toEqual(["c2", "u1", "u3"]);
    expect(orderForSend(r.ops).map((o) => [o.kind, o.mut.browserId ?? o.mut.browserFolderId])).toEqual([
      ["folder.deleteTree", "F"],
      ["bookmark.delete", "b3"],
    ]);
  });

  it("被删目录内的叶子不单独出 bookmark.delete（由树删覆盖）", () => {
    const existence: Snapshot = { leaves: { b1: { u: "https://x/1", t: "1", p: "F" } }, folders: { F: { t: "F", p: "1" } } };
    const ds = computeDeletedSets(existence, emptySnap());
    expect(ds.leafCandidates).toEqual(["b1"]);
    expect(insideDeletedFolder("b1", existence, ds.deletedFolderIds)).toBe("F");
  });
});

describe("applyOpResult · 回执状态迁移（R02/R05/R07）", () => {
  const upd = op("bookmark.update", bmKey("b1"), { kind: "bookmark.update", browserId: "b1", title: "新标题" }, { opId: "k", baseRevision: 5 });

  it("update 成功：出队；已确认基线与修订缓存按回执实体推进", () => {
    const st = drainState({ base: { leaves: { b1: { u: "https://x", t: "旧", p: "1" } }, folders: {} }, bmMap: { app1: "b1" }, revisions: { app1: 5 } });
    const out = applyOpResult(st, upd, { kind: "bookmark.update", status: "ok", appBookmarkId: "app1", entity: { id: "app1", title: "新标题", url_raw: "https://x", folder_id: "aF", content_revision: 6 } }, 10);
    expect(out).toEqual({ remove: true });
    expect(st.base.leaves.b1).toEqual({ u: "https://x", t: "新标题", p: "1", f: "aF" });
    expect(st.revisions.app1).toBe(6);
    expect(st.stats.pushedOk).toBe(1);
  });

  it("响应丢失后的旧回执重放（修订号低于已知）：出队但不回退已确认基线", () => {
    // 已 pull 到更新的库态（标题「库侧更新」rev 9）；重放回执仍是 rev 6 的旧结果
    const st = drainState({ base: { leaves: { b1: { u: "https://x", t: "库侧更新", p: "1" } }, folders: {} }, bmMap: { app1: "b1" }, revisions: { app1: 9 } });
    const out = applyOpResult(st, upd, { kind: "bookmark.update", status: "ok", appBookmarkId: "app1", entity: { id: "app1", title: "新标题", url_raw: "https://x", folder_id: "aF", content_revision: 6 } }, 10);
    expect(out.remove).toBe(true);
    expect(st.base.leaves.b1?.t).toBe("库侧更新");
    expect(st.revisions.app1).toBe(9);
  });

  it("conflict：出队、冲突计数、要求浏览器节点回对齐到库侧现值", () => {
    const st = drainState({ base: { leaves: { b1: { u: "https://x", t: "旧", p: "1" } }, folders: {} }, bmMap: { app1: "b1" }, revisions: { app1: 5 } });
    const out = applyOpResult(st, upd, { kind: "bookmark.update", status: "conflict", appBookmarkId: "app1", entity: { id: "app1", title: "库侧", url_raw: "https://x", folder_id: "aF", content_revision: 8 } }, 10);
    expect(out.remove).toBe(true);
    expect(out.realign?.title).toBe("库侧");
    expect(st.stats.conflicts).toBe(1);
    expect(st.revisions.app1).toBe(8);
    expect(st.base.leaves.b1?.t).toBe("旧"); // 浏览器回对齐由调用方执行后再更新基线
  });

  it("failed 与可重试 skipped（parent_unknown）：保留原操作并记录原因（同 opId 重发）", () => {
    const st = drainState();
    expect(applyOpResult(st, upd, { kind: "bookmark.update", status: "failed", error: "db locked" }, 10)).toEqual({ remove: false, error: "db locked" });
    expect(applyOpResult(st, upd, { kind: "bookmark.update", status: "skipped", error: "parent_unknown" }, 10)).toEqual({ remove: false, error: "skipped: parent_unknown" });
    expect(Object.keys(st.rejected)).toEqual([]);
  });

  it("终态 skipped：记录拒绝（同指纹不再重试）；no_identity 清本地映射；delete 类视为收敛出基线", () => {
    const st = drainState({ base: { leaves: { b1: { u: "https://x", t: "旧", p: "1" }, b9: { u: "https://x/9", t: "9", p: "1" } }, folders: {} }, bmMap: { app1: "b1" } });
    const out = applyOpResult(st, upd, { kind: "bookmark.update", status: "skipped", error: "no_identity" }, 10);
    expect(out.remove).toBe(true);
    expect(out.rejectedError).toBe("no_identity");
    expect(st.rejected[bmKey("b1")]).toMatchObject({ kind: "bookmark.update", error: "no_identity" });
    expect(st.bmMap.app1).toBeUndefined(); // 下一轮 diff 改走 create 重新绑定
    const del = op("bookmark.delete", bmKey("b9"), { kind: "bookmark.delete", browserId: "b9" }, { opId: "d9" });
    const out2 = applyOpResult(st, del, { kind: "bookmark.delete", status: "skipped", error: "no_identity" }, 10);
    expect(out2.remove).toBe(true);
    expect(st.base.leaves.b9).toBeUndefined();
  });

  it("folder.deleteTree 成功：子树（目录与叶子）出存在性基线，目录映射清理", () => {
    const base: Snapshot = {
      leaves: { b1: { u: "https://x", t: "1", p: "F" }, b2: { u: "https://x", t: "2", p: "G" }, b3: { u: "https://x", t: "3", p: "K" } },
      folders: { F: { t: "F", p: "1" }, G: { t: "G", p: "F" }, K: { t: "K", p: "1" } },
    };
    const st = drainState({ base, fMap: { F: "aF", K: "aK" } });
    const out = applyOpResult(st, op("folder.deleteTree", fdKey("F"), { kind: "folder.deleteTree", appFolderId: "aF", browserFolderId: "F" }, { opId: "t" }), { kind: "folder.deleteTree", status: "ok" }, 10);
    expect(out.remove).toBe(true);
    expect(Object.keys(st.base.folders)).toEqual(["K"]);
    expect(Object.keys(st.base.leaves)).toEqual(["b3"]); // F 与子目录 G 内的书签随子树出基线
    expect(st.fMap).toEqual({ K: "aK" });
  });

  it("bookmark.create 回执：身份与目录映射入册、基线按回执实体登记、修订缓存前进", () => {
    const st = drainState();
    const create = op("bookmark.create", bmKey("n1"), { kind: "bookmark.create", browserId: "n1", url: "https://x/a", title: "A", browserFolderId: "P" }, { opId: "c" });
    const out = applyOpResult(st, create, { kind: "bookmark.create", status: "ok", appBookmarkId: "app9", appFolderId: "aP", entity: { id: "app9", title: "A", url_raw: "https://x/a", folder_id: "aP", content_revision: 1 } }, 10);
    expect(out.remove).toBe(true);
    expect(st.bmMap).toEqual({ app9: "n1" });
    expect(st.fMap).toEqual({ P: "aP" });
    expect(st.base.leaves.n1).toEqual({ u: "https://x/a", t: "A", p: "P", f: "aP" });
    expect(st.revisions.app9).toBe(1);
  });
});

describe("删除保险丝与挂起计划（R01）", () => {
  it("书签级：>30 且 >25%；目录级：顶层树删 >3 且被删目录总数 >50%；任一触发即挂起整个计划", () => {
    expect(evaluateDeleteGuard({ leaves: new Array(31), folders: [] }, 0, 100, 10)).toEqual({ bookmark: true, folder: false, any: true });
    expect(evaluateDeleteGuard({ leaves: new Array(30), folders: [] }, 0, 100, 10).any).toBe(false);
    expect(evaluateDeleteGuard({ leaves: new Array(31), folders: [] }, 0, 200, 10).any).toBe(false); // 31 不超过 200 的 25%
    expect(evaluateDeleteGuard({ leaves: [], folders: new Array(4) }, 6, 0, 10)).toEqual({ bookmark: false, folder: true, any: true });
    expect(evaluateDeleteGuard({ leaves: [], folders: new Array(4) }, 5, 0, 10).any).toBe(false); // 5 不超过 10 的 50%
    expect(evaluateDeleteGuard({ leaves: [], folders: new Array(3) }, 9, 0, 10).any).toBe(false); // 顶层仅 3 个
  });

  it("挂起计划按 id 去重合并；确认范围复核剔除挂起期间已恢复的条目", () => {
    const a = { leaves: [{ browserId: "b1", appId: "app1", url: "u1" }], folders: [{ browserFolderId: "F", appFolderId: "aF", name: "F" }], at: 1 };
    const b = {
      leaves: [
        { browserId: "b1", appId: "app1", url: "u1" },
        { browserId: "b2", appId: "app2", url: "u2" },
      ],
      folders: [{ browserFolderId: "F", appFolderId: "aF", name: "F" }],
      at: 2,
    };
    const merged = mergeBrowserDeletePlan(a, b, 99);
    expect(merged.leaves.map((l) => l.browserId)).toEqual(["b1", "b2"]);
    expect(merged.folders.length).toBe(1);
    expect(merged.at).toBe(99);
    // b1 的同一条目已被用户重新添加（新节点 n9 经身份指向 app1）；F 的库目录也重新出现在浏览器
    const walk: Snapshot = { leaves: { n9: { u: "u1", t: "t", p: "1" } }, folders: { F9: { t: "F", p: "1" } } };
    const v = validateBrowserDeletePlan(merged, walk, { app1: "n9", app2: "b2" }, { F9: "aF" });
    expect(v.plan.leaves.map((l) => l.browserId)).toEqual(["b2"]);
    expect(v.plan.folders).toEqual([]);
    expect(v.droppedLeaves).toEqual(["b1"]);
    expect(v.droppedFolders).toEqual(["F"]);
  });
});

describe("出站顺序与载荷（R06/R07：先目录后书签；opId 与 baseRevision 终身不变）", () => {
  it("目录操作（含树删）先于书签操作；同级保持生成顺序", () => {
    const ops = [
      op("bookmark.create", "bm:1", {}),
      op("folder.move", "fd:P", {}),
      op("bookmark.delete", "bm:2", {}),
      op("folder.deleteTree", "fd:Q", {}),
      op("folder.create", "fd:R", {}),
    ];
    expect(orderForSend(ops).map((o) => o.kind)).toEqual(["folder.move", "folder.create", "folder.deleteTree", "bookmark.create", "bookmark.delete"]);
  });

  it("composePayload 合成 opId 与生成时绑定的 baseRevision", () => {
    const o = op("bookmark.update", "bm:1", { kind: "bookmark.update", browserId: "1", title: "T" }, { opId: "k-1", baseRevision: 4 });
    expect(composePayload(o)).toEqual({ kind: "bookmark.update", browserId: "1", title: "T", opId: "k-1", baseRevision: 4 });
    expect(composePayload(op("folder.create", "fd:1", { kind: "folder.create" }, { opId: "k-2" }))).toEqual({ kind: "folder.create", opId: "k-2" });
  });

  it("fingerprint 与键序无关，且不含 opId / baseRevision", () => {
    expect(fingerprint({ kind: "folder.move", name: "A", appFolderId: "x" })).toBe(fingerprint({ appFolderId: "x", name: "A", kind: "folder.move" }));
    expect(fingerprint({ kind: "folder.move", name: "A", opId: "o1", baseRevision: 1 })).toBe(fingerprint({ kind: "folder.move", name: "A" }));
    expect(fingerprint({ kind: "folder.move", name: "A" })).not.toBe(fingerprint({ kind: "folder.move", name: "B" }));
  });
});
