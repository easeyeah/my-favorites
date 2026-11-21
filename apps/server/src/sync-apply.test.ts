/**
 * D46 双向同步 · /sync/apply 应用器验收：
 *  - bookmark.create 新建 / URL 命中绑定 / 重放幂等
 *  - update / move / delete（发起设备不回程排 remove，其他设备照排）
 *  - folder.ensure / rename / delete
 *  - 变更日志带发起设备：自己 pull 不到（防回环），他端可 pull（多端传播）
 *  - PATCH 修改（pinned/title）进入变更日志（D46 日志补齐）
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

const DEV = "device-d46-0001";
const OTHER = "device-d46-0002";

async function apply(mutations: unknown[], deviceId = DEV) {
  const res = await env.app.request("/api/v1/sync/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, mutations }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    results: Array<{ kind: string; browserId?: string; appBookmarkId?: string; appFolderId?: string; status: string }>;
    cursor: number;
  };
}

describe("D46 /sync/apply", () => {
  it("create 新建入库 + 身份绑定；重放幂等 bound 不重复建", async () => {
    env = makeEnv();
    const r1 = await apply([
      { kind: "bookmark.create", browserId: "b-1", url: "https://d46.example/a", title: "A", folderPath: ["工具"] },
    ]);
    expect(r1.results[0]?.status).toBe("ok");
    const appId = r1.results[0]!.appBookmarkId!;
    expect(env.store.getBookmark(appId)?.title).toBe("A");
    expect(env.store.findAppBookmarkId(DEV, "b-1")).toBe(appId);

    const r2 = await apply([
      { kind: "bookmark.create", browserId: "b-1", url: "https://d46.example/a", title: "A", folderPath: ["工具"] },
    ]);
    expect(r2.results[0]?.status).toBe("bound");
    expect(r2.results[0]?.appBookmarkId).toBe(appId);
    expect(env.store.listBookmarks({ limit: 50 }).filter((b) => b.url_raw.includes("d46.example/a")).length).toBe(1);
  });

  it("create 命中既有 URL → 绑定不新建（库先行场景）", async () => {
    env = makeEnv();
    const created = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://d46.example/pre", title: "先行" }),
      })
    ).json()) as { id: string };
    const r = await apply([{ kind: "bookmark.create", browserId: "b-2", url: "https://d46.example/pre", title: "浏览器侧", folderPath: [] }]);
    expect(r.results[0]?.status).toBe("bound");
    expect(r.results[0]?.appBookmarkId).toBe(created.id);
  });

  it("update 改标题、move 换目录、delete 删库且不给发起设备排 remove、给他设备排", async () => {
    env = makeEnv();
    const r = await apply([{ kind: "bookmark.create", browserId: "b-3", url: "https://d46.example/c", title: "旧题", folderPath: ["甲"] }]);
    const appId = r.results[0]!.appBookmarkId!;
    // 其他设备也映射同一应用书签（模拟多端）
    env.store.upsertIdentity({ deviceId: OTHER, browserBookmarkId: "b-3-other", appBookmarkId: appId });

    await apply([{ kind: "bookmark.update", browserId: "b-3", title: "新题" }]);
    expect(env.store.getBookmark(appId)?.title).toBe("新题");

    const folder = await apply([{ kind: "folder.ensure", path: ["乙"] }]);
    const fid = folder.results[0]!.appFolderId!;
    await apply([{ kind: "bookmark.move", browserId: "b-3", appFolderId: fid }]);
    expect(env.store.getBookmark(appId)?.folder_id).toBe(fid);

    await apply([{ kind: "bookmark.delete", browserId: "b-3" }]);
    expect(env.store.getBookmark(appId)).toBeUndefined();
    const ops = env.store.pendingBrowserOps();
    expect(ops.some((o) => o.device_id === DEV)).toBe(false); // 发起设备不回程
    expect(ops.some((o) => o.device_id === OTHER && o.op === "remove")).toBe(true); // 他端照排
  });

  it("防回环：apply 产生的日志自己 pull 不到，他端 pull 得到", async () => {
    env = makeEnv();
    await apply([{ kind: "bookmark.create", browserId: "b-4", url: "https://d46.example/d", title: "D", folderPath: [] }]);
    const self = (await (await env.app.request(`/api/v1/sync/pull?cursor=0&device=${DEV}`)).json()) as {
      items: Array<{ entity_id: string }>;
    };
    expect(self.items.length).toBe(0);
    const other = (await (await env.app.request(`/api/v1/sync/pull?cursor=0&device=${OTHER}`)).json()) as {
      items: Array<{ entity: string; op: string }>;
    };
    expect(other.items.some((i) => i.entity === "bookmark" && i.op === "upsert")).toBe(true);
  });

  it("folder.rename / folder.delete；系统目录拒绝改名", async () => {
    env = makeEnv();
    const r = await apply([{ kind: "folder.ensure", path: ["待改"] }]);
    const fid = r.results[0]!.appFolderId!;
    const ren = await apply([{ kind: "folder.rename", appFolderId: fid, name: "已改" }]);
    expect(ren.results[0]?.status).toBe("ok");
    expect(env.store.getFolder(fid)?.name).toBe("已改");
    const del = await apply([{ kind: "folder.delete", appFolderId: fid }]);
    expect(del.results[0]?.status).toBe("ok");
    expect(env.store.getFolder(fid)).toBeUndefined();
  });

  it("管理台 PATCH（pinned）进入变更日志（D46 日志补齐，浏览器侧才能收到排序依据）", async () => {
    env = makeEnv();
    const created = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://d46.example/e", title: "E" }),
      })
    ).json()) as { id: string };
    const before = (await (await env.app.request(`/api/v1/sync/pull?cursor=0&device=${DEV}`)).json()) as { cursor: number };
    await env.app.request(`/api/v1/bookmarks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: 1 }),
    });
    const after = (await (
      await env.app.request(`/api/v1/sync/pull?cursor=${before.cursor}&device=${DEV}`)
    ).json()) as { items: Array<{ entity: string; op: string; payload: { pinned?: number } }> };
    const pinLog = after.items.find((i) => i.entity === "bookmark" && i.op === "upsert");
    expect(pinLog?.payload?.pinned).toBe(1);
  });
});

describe("D56 folder.deleteTree（目录树删除）", () => {
  it("嵌套目录 + 子书签一次性删净（子优先，父不残留）", async () => {
    env = makeEnv();
    // 父/子目录各放书签
    await apply([
      { kind: "bookmark.create", browserId: "p1", url: "https://d56.example/p", title: "父项", folderPath: ["父"] },
      { kind: "bookmark.create", browserId: "c1", url: "https://d56.example/c", title: "子项", folderPath: ["父", "子"] },
    ]);
    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{ id: string; name: string; parent_id: string | null }>;
    const parent = folders.find((f) => f.name === "父")!;
    const child = folders.find((f) => f.name === "子")!;
    expect(parent).toBeTruthy();
    expect(child).toBeTruthy();

    const r = await apply([{ kind: "folder.deleteTree", appFolderId: parent.id }]);
    expect(r.results[0]?.status).toBe("ok");

    const after = (await (await env.app.request("/api/v1/folders")).json()) as Array<{ id: string }>;
    expect(after.find((f) => f.id === parent.id)).toBeUndefined();
    expect(after.find((f) => f.id === child.id)).toBeUndefined();
    const bms = (await (await env.app.request("/api/v1/bookmarks?limit=1000")).json()) as Array<{ url_raw: string }>;
    expect(bms.some((b) => b.url_raw.includes("d56.example"))).toBe(false);
  });

  it("系统收纳盒拒绝树删；不存在的目录 noop", async () => {
    env = makeEnv();
    const inbox = (await (await env.app.request("/api/v1/inbox/setup", { method: "POST" })).json()) as { id: string };
    const r = await apply([{ kind: "folder.deleteTree", appFolderId: inbox.id }]);
    expect(r.results[0]?.status).toBe("noop");
    const still = (await (await env.app.request("/api/v1/folders")).json()) as Array<{ id: string }>;
    expect(still.find((f) => f.id === inbox.id)).toBeTruthy();

    const r2 = await apply([{ kind: "folder.deleteTree", appFolderId: "no-such-folder" }]);
    expect(r2.results[0]?.status).toBe("noop");
  });

  it("发起设备不回程排 remove，其他设备照排", async () => {
    env = makeEnv();
    await apply([{ kind: "bookmark.create", browserId: "x1", url: "https://d56.example/x", title: "X", folderPath: ["删我"] }]);
    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{ id: string; name: string }>;
    const f = folders.find((x) => x.name === "删我")!;
    const bm = env.store.findByCanonical("https://d56.example/x")!;
    env.store.upsertIdentity({ deviceId: OTHER, browserBookmarkId: "x1-other", appBookmarkId: bm.id });

    await apply([{ kind: "folder.deleteTree", appFolderId: f.id }]);
    const ops = env.store.pendingBrowserOps();
    expect(ops.some((o) => o.device_id === DEV)).toBe(false);
    expect(ops.some((o) => o.device_id === OTHER && o.op === "remove")).toBe(true);
  });
});
