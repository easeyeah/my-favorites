/** 可重试同步回执不能固化；未知父目录不能被当作根级。全部使用 makeEnv 临时库。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncApplyResult } from "./sync-apply";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
const DEV = "device-retry-receipts";

beforeEach(() => { env = makeEnv(); });
afterEach(() => {
  vi.restoreAllMocks();
  env?.cleanup();
});

async function apply(mutations: unknown[]) {
  const res = await env.app.request("/api/v1/sync/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: DEV, mutations }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { results: SyncApplyResult[]; cursor: number };
}

describe("同步可重试回执", () => {
  it.each(["parent_unknown", "folder_unknown"])("历史 skipped %s 回执重新执行，成功后覆盖并可幂等回放", async (error) => {
    const source = env.store.createFolder("待移动", null);
    const parent = env.store.createFolder("父目录", null);
    env.store.upsertFolderIdentity({ deviceId: DEV, browserFolderId: "bf-parent", appFolderId: parent.id });
    const opId = `historical-${error}`;
    const mutation = { kind: "folder.move", appFolderId: source.id, toBrowserFolderId: "bf-parent", opId };
    env.store.saveOpReceipt(opId, DEV, { kind: mutation.kind, appFolderId: source.id, status: "skipped", error });

    const retried = await apply([mutation]);
    expect(retried.results[0]).toMatchObject({ status: "ok", appFolderId: source.id });
    expect(env.store.getFolder(source.id)?.parent_id).toBe(parent.id);
    expect(env.store.opReceipt(opId)).toEqual(retried.results[0]);

    const replayed = await apply([mutation]);
    expect(replayed.results).toEqual(retried.results);
    expect(replayed.cursor).toBe(retried.cursor);
  });

  it("新的 parent_unknown 不写回执，父目录补齐后同 opId 可重试成功", async () => {
    const source = env.store.createFolder("待移动", null);
    const mutation = { kind: "folder.move", appFolderId: source.id, toBrowserFolderId: "bf-parent", opId: "move-after-parent" };
    const skipped = await apply([mutation]);
    expect(skipped.results[0]).toMatchObject({ status: "skipped", error: "parent_unknown" });
    expect(env.store.opReceipt(mutation.opId)).toBeNull();
    expect(env.store.getFolder(source.id)?.parent_id).toBeNull();

    const parent = await apply([{ kind: "folder.create", name: "父目录", browserFolderId: "bf-parent", parentBrowserFolderId: "1" }]);
    const retried = await apply([mutation]);
    expect(retried.results[0]).toMatchObject({ status: "ok", appFolderId: source.id });
    expect(env.store.getFolder(source.id)?.parent_id).toBe(parent.results[0]!.appFolderId);
    expect(env.store.opReceipt(mutation.opId)).toEqual(retried.results[0]);
  });

  it("终态 skipped 保留回执，后续条件变化仍只回放原结果", async () => {
    const mutation = { kind: "folder.rename", browserFolderId: "bf-later", name: "不应重命名", opId: "terminal-no-identity" };
    const first = await apply([mutation]);
    expect(first.results[0]).toMatchObject({ status: "skipped", error: "no_identity" });
    expect(env.store.opReceipt(mutation.opId)).toEqual(first.results[0]);
    const folder = env.store.createFolder("原名", null);
    env.store.upsertFolderIdentity({ deviceId: DEV, browserFolderId: "bf-later", appFolderId: folder.id });
    const beforeReplay = env.store.maxChangeId();

    const replayed = await apply([mutation]);
    expect(replayed.results).toEqual(first.results);
    expect(env.store.getFolder(folder.id)?.name).toBe("原名");
    expect(replayed.cursor).toBe(beforeReplay);
  });

  it("回执写入失败通过 SAVEPOINT 回滚目录、身份和日志，同 opId 随后可成功", async () => {
    const mutation = { kind: "folder.create", name: "原子创建", browserFolderId: "bf-atomic", parentBrowserFolderId: "1", opId: "atomic-create" };
    const before = env.store.maxChangeId();
    vi.spyOn(env.store, "saveOpReceipt").mockImplementationOnce(() => { throw new Error("receipt write failed"); });

    const failed = await apply([mutation]);
    expect(failed.results[0]).toMatchObject({ status: "failed", error: "Error: receipt write failed" });
    expect(env.store.listFolders().filter((f) => f.name === mutation.name)).toHaveLength(0);
    expect(env.store.findAppFolderId(DEV, mutation.browserFolderId)).toBeUndefined();
    expect(env.store.opReceipt(mutation.opId)).toBeNull();
    expect(env.store.maxChangeId()).toBe(before);

    const retried = await apply([mutation]);
    expect(retried.results[0]?.status).toBe("ok");
    expect(env.store.opReceipt(mutation.opId)).toEqual(retried.results[0]);
    const replayed = await apply([mutation]);
    expect(replayed.results).toEqual(retried.results);
    expect(replayed.cursor).toBe(retried.cursor);
    expect(env.store.listFolders().filter((f) => f.name === mutation.name)).toHaveLength(1);
  });
});

describe("folder.create 父目录解析", () => {
  it.each([
    { label: "没有父路径", parentPath: undefined, stale: false },
    { label: "空父路径", parentPath: [], stale: false },
    { label: "陈旧父身份", parentPath: undefined, stale: true },
  ])("$label：非根父未绑定时不落到根级，补齐父后同 opId 成功", async ({ parentPath, stale }) => {
    if (stale) env.store.upsertFolderIdentity({ deviceId: DEV, browserFolderId: "bf-pending-parent", appFolderId: "gone-parent" });
    const mutation = {
      kind: "folder.create", name: "待整理子目录", browserFolderId: "bf-child",
      parentBrowserFolderId: "bf-pending-parent", parentPath, opId: "create-after-parent",
    };
    const before = env.store.maxChangeId();
    for (let attempt = 0; attempt < 2; attempt++) {
      const skipped = await apply([mutation]);
      expect(skipped.results[0]).toMatchObject({ kind: "folder.create", status: "skipped", error: "parent_unknown" });
      expect(env.store.opReceipt(mutation.opId)).toBeNull();
      expect(env.store.listFolders().filter((f) => f.name === mutation.name)).toHaveLength(0);
      expect(env.store.findAppFolderId(DEV, mutation.browserFolderId)).toBeUndefined();
      expect(skipped.cursor).toBe(before);
    }

    const parent = await apply([{ kind: "folder.create", name: "待整理", browserFolderId: "bf-pending-parent", parentBrowserFolderId: "1" }]);
    const retried = await apply([mutation]);
    const childId = retried.results[0]!.appFolderId!;
    expect(retried.results[0]).toMatchObject({ status: "ok", entity: { parent_id: parent.results[0]!.appFolderId } });
    expect(env.store.getFolder(childId)?.parent_id).toBe(parent.results[0]!.appFolderId);
    expect(env.store.opReceipt(mutation.opId)).toEqual(retried.results[0]);

    const replayed = await apply([mutation]);
    expect(replayed.results).toEqual(retried.results);
    expect(replayed.cursor).toBe(retried.cursor);
    expect(env.store.listFolders().filter((f) => f.name === mutation.name)).toHaveLength(1);
  });

  it("明确父 ID 未绑定但有非空父路径时保留兼容解析", async () => {
    const parent = env.store.ensurePath(["兼容父", "内层"], "other");
    const result = await apply([{
      kind: "folder.create", name: "兼容子", browserFolderId: "bf-path-child",
      parentBrowserFolderId: "bf-unbound-parent", parentPath: ["兼容父", "内层"], root: "other", opId: "path-fallback",
    }]);
    expect(result.results[0]).toMatchObject({ status: "ok", entity: { parent_id: parent.id, root: "other" } });
    expect(env.store.getFolder(result.results[0]!.appFolderId!)?.parent_id).toBe(parent.id);
  });

  it.each([
    { parentBrowserFolderId: "0", root: "bar" },
    { parentBrowserFolderId: "1", root: "bar" },
    { parentBrowserFolderId: "2", root: "other" },
    { parentBrowserFolderId: undefined, root: "bar" },
  ])("真正根级 $parentBrowserFolderId / $root 仍可创建，成功响应丢失后回放不重复", async ({ parentBrowserFolderId, root }) => {
    const mutation = { kind: "folder.create", name: "根级目录", browserFolderId: "bf-root-child", parentBrowserFolderId, root, opId: "root-create" };
    const first = await apply([mutation]);
    const folderId = first.results[0]!.appFolderId!;
    expect(first.results[0]).toMatchObject({ status: "ok", entity: { id: folderId, parent_id: null, root } });
    expect(env.store.opReceipt(mutation.opId)).toEqual(first.results[0]);
    env.store.renameFolder(folderId, "创建后的新名称");
    const beforeReplay = env.store.maxChangeId();

    const replayed = await apply([mutation]);
    expect(replayed.results).toEqual(first.results);
    expect(replayed.cursor).toBe(beforeReplay);
    expect(env.store.getFolder(folderId)).toMatchObject({ name: "创建后的新名称", parent_id: null, root });
    expect(env.store.listFolders()).toHaveLength(1);
  });
});
