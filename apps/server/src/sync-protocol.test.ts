/**
 * D81 同步协议整改验收（评审 §3-A/C/D + §4 P2）：
 *  - folder_identity：目录稳定身份绑定 / 树删清理 / 跨设备隔离
 *  - folder.create / folder.move：空目录创建、reparent（成环/缺父拒绝）、根映射同名隔离
 *  - PATCH /folders/:id parentId：管理台目录搬家
 *  - bookmark.update url：canonical 重算 + 查重绑定（命中迁移身份删旧行、未命中原行更新）
 *  - opId 回执幂等 / baseRevision 冲突返回现值
 *  - /sync/pull reset_required：裁剪缺口 / 空日志 / 游标在未来 / 代际不符
 *  - /sync/snapshot：水位一致性（快照后写入经水位 pull 接住）
 *  - 已同步设备停发镜像 ops（D80 Tier2-D）
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

const DEV = "device-d81-0001";
const OTHER = "device-d81-0002";

async function apply(mutations: unknown[], deviceId = DEV) {
  const res = await env.app.request("/api/v1/sync/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, mutations }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    results: Array<{ kind: string; browserId?: string; appBookmarkId?: string; appFolderId?: string; status: string; current?: { id: string; title: string; content_revision?: number } }>;
    cursor: number;
  };
}

async function pull(cursor: number, device = DEV, gen?: string) {
  const q = gen !== undefined ? `&gen=${encodeURIComponent(gen)}` : "";
  const res = await env.app.request(`/api/v1/sync/pull?cursor=${cursor}&device=${device}${q}`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    items: Array<{ id: number; entity: string; entity_id: string; op: string; payload: unknown }>;
    cursor: number;
    reset_required?: boolean;
    minAvailableId: number | null;
    maxChangeId: number;
    generation: string;
  };
}

describe("D81 §3-A 目录身份与树结构同步", () => {
  it("folder.create 空目录入库 + 身份绑定；同父同名重放 bound 不重复建", async () => {
    env = makeEnv();
    const r1 = await apply([{ kind: "folder.create", name: "空目录", browserFolderId: "bf-1", parentBrowserFolderId: "1" }]);
    expect(r1.results[0]?.status).toBe("ok");
    const fid = r1.results[0]!.appFolderId!;
    expect(env.store.getFolder(fid)?.name).toBe("空目录");
    expect(env.store.findAppFolderId(DEV, "bf-1")).toBe(fid);
    const r2 = await apply([{ kind: "folder.create", name: "空目录", browserFolderId: "bf-1", parentBrowserFolderId: "1" }]);
    expect(r2.results[0]?.status).toBe("bound");
    expect(r2.results[0]?.appFolderId).toBe(fid);
    expect(env.store.listFolders().filter((f) => f.name === "空目录").length).toBe(1);
  });

  it("folder.move reparent：按浏览器身份解析被移目录与目标父；成环/缺父拒绝", async () => {
    env = makeEnv();
    const a = await apply([{ kind: "folder.create", name: "父A", browserFolderId: "bf-a", parentBrowserFolderId: "1" }]);
    const b = await apply([{ kind: "folder.create", name: "子B", browserFolderId: "bf-b", parentBrowserFolderId: "bf-a" }]);
    const c = await apply([{ kind: "folder.create", name: "父C", browserFolderId: "bf-c", parentBrowserFolderId: "1" }]);
    const fidA = a.results[0]!.appFolderId!;
    const fidB = b.results[0]!.appFolderId!;
    const fidC = c.results[0]!.appFolderId!;
    expect(env.store.getFolder(fidB)?.parent_id).toBe(fidA);
    // 成环：A 搬到 B（此时 B 是 A 的子）下 → 拒绝
    const cycle = await apply([{ kind: "folder.move", browserFolderId: "bf-a", toBrowserFolderId: "bf-b" }]);
    expect(cycle.results[0]?.status).toBe("skipped");
    expect(env.store.getFolder(fidA)?.parent_id).toBeNull();
    // B 搬到 C 下（浏览器身份解析）
    const mv = await apply([{ kind: "folder.move", browserFolderId: "bf-b", toBrowserFolderId: "bf-c" }]);
    expect(mv.results[0]?.status).toBe("ok");
    expect(env.store.getFolder(fidB)?.parent_id).toBe(fidC);
    // 变更日志 op=move（其他设备可 pull 到搬家事件）
    const p = await pull(0, OTHER);
    expect(p.items.some((i) => i.entity === "folder" && i.op === "move" && i.entity_id === fidB)).toBe(true);
    // 搬到浏览器根 → 库根级
    const toRoot = await apply([{ kind: "folder.move", browserFolderId: "bf-b", toBrowserFolderId: "1" }]);
    expect(toRoot.results[0]?.status).toBe("ok");
    expect(env.store.getFolder(fidB)?.parent_id).toBeNull();
  });

  it("根映射：bar/other 同名目录各自独立（不串号）", async () => {
    env = makeEnv();
    const bar = await apply([{ kind: "folder.create", name: "同名", browserFolderId: "bf-bar", parentBrowserFolderId: "1", root: "bar" }]);
    const other = await apply([{ kind: "folder.create", name: "同名", browserFolderId: "bf-other", parentBrowserFolderId: "2", root: "other" }]);
    expect(bar.results[0]!.appFolderId).not.toBe(other.results[0]!.appFolderId);
    expect(env.store.listFolders().filter((f) => f.name === "同名").length).toBe(2);
    // ensurePath 同根隔离
    const p1 = env.store.ensurePath(["开发"], "bar");
    const p2 = env.store.ensurePath(["开发"], "other");
    expect(p1.id).not.toBe(p2.id);
    expect(env.store.ensurePath(["开发"], "bar").id).toBe(p1.id);
  });

  it("PATCH /folders/:id parentId 搬家 + 成环 400；树删清理目录身份", async () => {
    env = makeEnv();
    const mk = async (name: string, parentId?: string) =>
      (await (
        await env.app.request("/api/v1/folders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, parentId }),
        })
      ).json()) as { id: string };
    const a = await mk("A");
    const b = await mk("B", a.id);
    // B 搬到根级
    const res = await env.app.request(`/api/v1/folders/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: null }),
    });
    expect(res.status).toBe(200);
    expect(env.store.getFolder(b.id)?.parent_id).toBeNull();
    // A 搬到 B 下（B 已在根级，不成环）
    const okMove = await env.app.request(`/api/v1/folders/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: b.id }),
    });
    expect(okMove.status).toBe(200);
    // B 再搬到 A 下 → 成环（A 已是 B 的子）→ 400
    const cyc2 = await env.app.request(`/api/v1/folders/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: a.id }),
    });
    expect(cyc2.status).toBe(400);
    // 身份绑定后树删 → folder_identity 清出
    env.store.upsertFolderIdentity({ deviceId: DEV, browserFolderId: "bf-x", appFolderId: a.id });
    expect(env.store.findAppFolderId(DEV, "bf-x")).toBe(a.id);
    await env.app.request(`/api/v1/folders/${a.id}`, { method: "DELETE" });
    expect(env.store.findAppFolderId(DEV, "bf-x")).toBeUndefined();
  });
});

describe("D81 §3-D-5 浏览器 URL 修改语义", () => {
  it("未命中查重：原行更新 canonical + 缓存作废，不产生孤儿", async () => {
    env = makeEnv();
    const r = await apply([{ kind: "bookmark.create", browserId: "b-u1", url: "https://u.example/old", title: "U", folderPath: [] }]);
    const appId = r.results[0]!.appBookmarkId!;
    env.store.upsertCache({ bookmarkId: appId, l1Summary: "旧正文", fetchedVia: "extension_capture" });
    const up = await apply([{ kind: "bookmark.update", browserId: "b-u1", url: "https://u.example/new?utm_source=feed", title: "U2" }]);
    expect(up.results[0]?.status).toBe("ok");
    expect(up.results[0]?.appBookmarkId).toBe(appId);
    const row = env.store.getBookmark(appId)!;
    expect(row.url_raw).toBe("https://u.example/new?utm_source=feed");
    expect(row.url_canonical).toBe("https://u.example/new"); // canonical 重算（utm 参数剥除）
    expect(row.title).toBe("U2");
    expect(env.store.getCache(appId)?.l1_summary ?? null).toBeNull(); // 缓存作废
    expect(env.store.listBookmarks({ limit: 50 }).length).toBe(1); // 无孤儿
  });

  it("命中既有 URL：身份迁移到既有行 + 旧行删除（消灭 align 复活）", async () => {
    env = makeEnv();
    const hit = env.store.createBookmark({ folderId: env.store.ensurePath([]).id, urlRaw: "https://u.example/hit", urlCanonical: "https://u.example/hit", title: "既有" });
    const r = await apply([{ kind: "bookmark.create", browserId: "b-u2", url: "https://u.example/from", title: "F", folderPath: [] }]);
    const oldId = r.results[0]!.appBookmarkId!;
    const up = await apply([{ kind: "bookmark.update", browserId: "b-u2", url: "https://u.example/hit" }]);
    expect(up.results[0]?.status).toBe("bound");
    expect(up.results[0]?.appBookmarkId).toBe(hit.id);
    expect(env.store.findAppBookmarkId(DEV, "b-u2")).toBe(hit.id);
    expect(env.store.getBookmark(oldId)).toBeUndefined();
  });

  it("bookmark.unbind：节点退出同步范围，库条目保留", async () => {
    env = makeEnv();
    const r = await apply([{ kind: "bookmark.create", browserId: "b-u3", url: "https://u.example/x", title: "X", folderPath: [] }]);
    const appId = r.results[0]!.appBookmarkId!;
    const un = await apply([{ kind: "bookmark.unbind", browserId: "b-u3" }]);
    expect(un.results[0]?.status).toBe("ok");
    expect(env.store.findAppBookmarkId(DEV, "b-u3")).toBeUndefined();
    expect(env.store.getBookmark(appId)).toBeTruthy();
  });
});

describe("D81 §3-D-2/3 opId 幂等与 baseRevision 冲突", () => {
  it("同 opId 重放返回首次回执，不重复执行", async () => {
    env = makeEnv();
    const opId = "op-d81-0001";
    const r1 = await apply([{ kind: "bookmark.create", browserId: "b-o1", url: "https://o.example/a", title: "A", folderPath: [], opId }]);
    expect(r1.results[0]?.status).toBe("ok");
    const appId = r1.results[0]!.appBookmarkId!;
    env.store.updateBookmark(appId, { title: "服务端后改" });
    const r2 = await apply([{ kind: "bookmark.create", browserId: "b-o1", url: "https://o.example/a", title: "A", folderPath: [], opId }]);
    expect(r2.results[0]?.status).toBe("ok"); // 回执原样（不是 bound）
    expect(r2.results[0]?.appBookmarkId).toBe(appId);
    expect(env.store.getBookmark(appId)?.title).toBe("服务端后改"); // 未被重放覆盖
  });

  it("baseRevision 过期 → conflict + 库侧现值；无冲突正常应用", async () => {
    env = makeEnv();
    const r = await apply([{ kind: "bookmark.create", browserId: "b-r1", url: "https://r.example/a", title: "R", folderPath: [] }]);
    const appId = r.results[0]!.appBookmarkId!;
    const rev0 = env.store.getBookmark(appId)!.content_revision ?? 0;
    // 库侧被其他写入者推进修订
    env.store.updateBookmark(appId, { title: "库侧新值" });
    const conflict = await apply([{ kind: "bookmark.update", browserId: "b-r1", title: "浏览器旧意图", baseRevision: rev0 }]);
    expect(conflict.results[0]?.status).toBe("conflict");
    expect(conflict.results[0]?.current?.title).toBe("库侧新值");
    expect(env.store.getBookmark(appId)?.title).toBe("库侧新值"); // 冲突不应用
    // 携带最新修订 → 正常应用
    const rev1 = env.store.getBookmark(appId)!.content_revision ?? 0;
    const ok = await apply([{ kind: "bookmark.update", browserId: "b-r1", title: "浏览器新意图", baseRevision: rev1 }]);
    expect(ok.results[0]?.status).toBe("ok");
    expect(env.store.getBookmark(appId)?.title).toBe("浏览器新意图");
  });
});

describe("D81 §3-C 快照水位与过期恢复", () => {
  it("snapshot 水位一致性：快照后的写入经水位 pull 接住", async () => {
    env = makeEnv();
    await apply([{ kind: "bookmark.create", browserId: "b-s1", url: "https://s.example/a", title: "A", folderPath: [] }]);
    const snap = (await (await env.app.request("/api/v1/sync/snapshot")).json()) as {
      folders: unknown[];
      bookmarks: Array<{ id: string }>;
      watermark: number;
      generation: string;
    };
    expect(snap.bookmarks.length).toBe(1);
    expect(snap.watermark).toBeGreaterThan(0);
    // 快照后库侧新增（模拟对齐期间其他设备写入）
    env.store.createBookmark({ folderId: env.store.ensurePath([]).id, urlRaw: "https://s.example/after", urlCanonical: "https://s.example/after", title: "After" });
    const p = await pull(snap.watermark, OTHER);
    expect(p.reset_required).toBeFalsy();
    expect(p.items.some((i) => i.entity === "bookmark" && (i.payload as { url_raw?: string }).url_raw === "https://s.example/after")).toBe(true);
  });

  it("reset_required：裁剪缺口 / 空日志有历史 / 游标在未来 / 代际不符", async () => {
    env = makeEnv();
    await apply([{ kind: "bookmark.create", browserId: "b-g1", url: "https://g.example/a", title: "A", folderPath: [] }]);
    const head = env.store.maxChangeId();
    const gen = env.store.syncGeneration();
    // ① 游标在未来（DB 恢复/回退）
    const future = await pull(head + 100);
    expect(future.reset_required).toBe(true);
    // ② 代际不符（DB 替换）
    const badGen = await pull(0, DEV, "not-the-generation");
    expect(badGen.reset_required).toBe(true);
    // ③ 裁剪缺口：删掉前段日志，cursor 落在被删区间
    env.store.db.prepare("DELETE FROM changes WHERE id <= ?").run(head - 1);
    const gap = await pull(0);
    expect(gap.reset_required).toBe(true);
    expect(gap.minAvailableId).toBe(head);
    // ④ 空日志但设备有历史
    env.store.db.prepare("DELETE FROM changes").run();
    const empty = await pull(5);
    expect(empty.reset_required).toBe(true);
    // 正常游标（边界内）不触发 reset
    env.store.createBookmark({ folderId: env.store.ensurePath([]).id, urlRaw: "https://g.example/b", urlCanonical: "https://g.example/b", title: "B" });
    const ok = await pull(env.store.maxChangeId(), DEV, gen);
    expect(ok.reset_required).toBeFalsy();
  });
});

describe("D81 §3-D-4 已同步设备停发镜像 ops", () => {
  it("sync_enabled 设备：deleteBookmark 不排 remove、enqueueBrowserOp 跳过；未同步设备照排", async () => {
    env = makeEnv();
    const r = await apply([{ kind: "bookmark.create", browserId: "b-m1", url: "https://m.example/a", title: "M", folderPath: [] }], DEV);
    const appId = r.results[0]!.appBookmarkId!;
    // apply 已标记 DEV 为已同步；OTHER 未同步
    expect(env.store.deviceSyncEnabled(DEV)).toBe(true);
    expect(env.store.deviceSyncEnabled(OTHER)).toBe(false);
    env.store.upsertIdentity({ deviceId: OTHER, browserBookmarkId: "b-m1-other", appBookmarkId: appId });
    env.store.deleteBookmark(appId);
    const opsOther = env.store.pendingBrowserOps(OTHER);
    const opsDev = env.store.pendingBrowserOps(DEV);
    expect(opsOther.some((o) => o.op === "remove")).toBe(true); // 未同步设备照排
    expect(opsDev.length).toBe(0); // 已同步设备停发
    // 显式入队同样跳过
    const id = env.store.enqueueBrowserOp({ deviceId: DEV, op: "move", browserBookmarkId: "b-m1", targetBrowserParentId: "mf-folder:X" });
    expect(id).toBe(0);
    // 关闭同步 → 恢复 legacy
    env.store.setDeviceSyncEnabled(DEV, false);
    expect(env.store.deviceSyncEnabled(DEV)).toBe(false);
  });

  it("POST /devices/sync-state 上报开关", async () => {
    env = makeEnv();
    const res = await env.app.request("/api/v1/devices/sync-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: DEV, enabled: true }),
    });
    expect(res.status).toBe(200);
    expect(env.store.deviceSyncEnabled(DEV)).toBe(true);
    await env.app.request("/api/v1/devices/sync-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: DEV, enabled: false }),
    });
    expect(env.store.deviceSyncEnabled(DEV)).toBe(false);
  });
});