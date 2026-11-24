import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());
const DEVICE = "folder-collision-device";

async function apply(mutations: unknown[], deviceId = DEVICE) {
  const res = await env.app.request("/api/v1/sync/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, mutations }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: Array<{ status: string; appFolderId?: string; error?: string }> }).results;
}

const create = (browserFolderId: string, name: string, parentBrowserFolderId = "1") =>
  ({ kind: "folder.create", browserFolderId, name, parentBrowserFolderId, root: "bar" });

// 故障注入只针对 makeEnv 临时库：模拟旧版同一设备六个真实目录被折叠为两个库目录。
function legacyBind(browserFolderId: string, appFolderId: string) {
  env.store.db.prepare("INSERT INTO folder_identity(device_id,browser_folder_id,app_folder_id,mapped_at) VALUES(?,?,?,?)")
    .run(DEVICE, browserFolderId, appFolderId, new Date().toISOString());
}

describe("目录身份保持一对一", () => {
  it("同设备同父同名的六个目录不能折成两个，重放自身仍幂等", async () => {
    env = makeEnv();
    const [parent] = await apply([create("parent", "L 待整理")]);
    const muts = Array.from({ length: 6 }, (_, i) => create(`child-${i}`, i % 2 ? "同名 B" : "同名 A", "parent"));
    const results = await apply(muts);
    expect(new Set(results.map((r) => r.appFolderId)).size).toBe(6);
    expect(env.store.listFolders().filter((f) => f.parent_id === parent!.appFolderId)).toHaveLength(6);
    const replay = await apply(muts);
    expect(replay.map((r) => r.appFolderId)).toEqual(results.map((r) => r.appFolderId));
  });

  it("首次对齐只认领未被本设备占用的旧目录，其他设备仍可绑定同一目录", async () => {
    env = makeEnv();
    const old = env.store.createFolder("已有目录", null);
    const [first] = await apply([create("first", old.name)]);
    expect(first!.appFolderId).toBe(old.id);
    const [second] = await apply([create("second", old.name)]);
    expect(second!.appFolderId).not.toBe(old.id);
    const [other] = await apply([create("other-first", old.name)], "another-folder-device");
    expect(other!.appFolderId).toBe(old.id);
  });

  it("显式分离旧别名只改请求节点的身份，不删除旧目录、内容或其他映射", async () => {
    env = makeEnv();
    const old = env.store.createFolder("同名", null);
    legacyBind("keep", old.id);
    legacyBind("split", old.id);
    const b = env.store.createBookmark({ urlRaw: "https://example.com/keep", urlCanonical: "https://example.com/keep", title: "保留内容", folderId: old.id });
    const m = { ...create("split", "同名"), separateFromAppFolderId: old.id, opId: "split-operation-1" };
    const [result] = await apply([m]);
    expect(result!.status).toBe("ok");
    expect(result!.appFolderId).not.toBe(old.id);
    expect(env.store.findAppFolderId(DEVICE, "keep")).toBe(old.id);
    expect(env.store.findAppFolderId(DEVICE, "split")).toBe(result!.appFolderId);
    expect(env.store.getBookmark(b.id)?.folder_id).toBe(old.id);
    expect(env.store.getFolder(old.id)).toBeDefined();
    expect((await apply([m]))[0]!.appFolderId).toBe(result!.appFolderId);
    expect(env.store.listFolders().filter((f) => f.name === "同名")).toHaveLength(2);
  });

  it("旧分离请求不能覆盖已经更新的稳定身份", async () => {
    env = makeEnv();
    const [current] = await apply([create("browser", "现有")]);
    const [result] = await apply([{ ...create("browser", "现有"), separateFromAppFolderId: "obsolete-app-id" }]);
    expect(result!.appFolderId).toBe(current!.appFolderId);
    expect(env.store.listFolders().filter((f) => f.name === "现有")).toHaveLength(1);
  });

  it("folder.ensure 用明确 appFolderId 绑定独立同名目录，不能再按路径合回去", async () => {
    env = makeEnv();
    const a = env.store.createFolder("同名", null);
    const b = env.store.createFolder("同名", null);
    const results = await apply([
      { kind: "folder.ensure", appFolderId: a.id, path: ["同名"], browserFolderId: "a" },
      { kind: "folder.ensure", appFolderId: b.id, path: ["同名"], browserFolderId: "b" },
    ]);
    expect(results.map((r) => r.appFolderId)).toEqual([a.id, b.id]);
    expect(env.store.findAppFolderId(DEVICE, "a")).toBe(a.id);
    expect(env.store.findAppFolderId(DEVICE, "b")).toBe(b.id);
  });

  it("完整活目录快照允许回收已死亡旧身份，但不删除库目录或内容", async () => {
    env = makeEnv();
    const old = env.store.createFolder("保留目录", null);
    legacyBind("dead-browser", old.id);
    const [result] = await apply([{ kind: "folder.ensure", appFolderId: old.id, path: [old.name], browserFolderId: "new-browser", liveBrowserFolderIds: ["1", "2", "new-browser"] }]);
    expect(result!.status).toBe("ok");
    expect(env.store.findAppFolderId(DEVICE, "dead-browser")).toBeUndefined();
    expect(env.store.findAppFolderId(DEVICE, "new-browser")).toBe(old.id);
    expect(env.store.getFolder(old.id)).toBeDefined();
  });

  it.each([
    ["现存目录仍在完整快照", ["1", "old-browser", "new-browser"]],
    ["快照未包含待绑定新目录", ["1"]],
  ])("%s 时不能回收占用身份或假报成功", async (_name, liveBrowserFolderIds) => {
    env = makeEnv();
    const old = env.store.createFolder("保守认领", null);
    legacyBind("old-browser", old.id);
    const [result] = await apply([{ kind: "folder.ensure", appFolderId: old.id, path: [old.name], browserFolderId: "new-browser", liveBrowserFolderIds }]);
    expect(result!.status).toBe("failed");
    expect(env.store.findAppFolderId(DEVICE, "old-browser")).toBe(old.id);
    expect(env.store.findAppFolderId(DEVICE, "new-browser")).toBeUndefined();
  });

  it("中央身份写入拒绝同设备二次占用与意外改绑，不影响其他设备", () => {
    env = makeEnv();
    const a = env.store.createFolder("A", null);
    const b = env.store.createFolder("B", null);
    env.store.upsertFolderIdentity({ deviceId: DEVICE, browserFolderId: "first", appFolderId: a.id });
    expect(() => env.store.upsertFolderIdentity({ deviceId: DEVICE, browserFolderId: "second", appFolderId: a.id })).toThrow(/folder_identity/);
    expect(() => env.store.upsertFolderIdentity({ deviceId: DEVICE, browserFolderId: "first", appFolderId: b.id })).toThrow(/folder_identity/);
    expect(() => env.store.upsertFolderIdentity({ deviceId: "another-device", browserFolderId: "second", appFolderId: a.id })).not.toThrow();
  });
});
