/**
 * D44 受控镜像删除：
 *  - ingest 带 deviceId+browserId → 建立 A2-1 身份映射（含重复 URL 回填）
 *  - 管理台删除书签 → 仅为有映射的书签入队 remove 待执行操作（无映射不动浏览器）
 *  - /browser/ops 下发 + 回执 cancelled（扩展端开关关闭时）后不再下发
 * D45 浏览器书签重排：
 *  - POST /browser/reorder 按管理台列表口径（pinned DESC, added_at DESC）为每个
 *    含映射书签的目录入队一条 reorder（order 只含该设备有映射的节点 id）
 *  - 重新排队以最新快照为准（旧 pending 终结）；deviceId 过滤生效
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

const DEVICE = "device-d44-0001";

async function ingest(items: Array<Record<string, unknown>>, key: string) {
  const res = await env.app.request("/api/v1/bookmarks/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ idempotencyKey: key, deviceId: DEVICE, items }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { imported: number; skipped_duplicate: number };
}

async function pendingOps(): Promise<
  Array<{ id: number; op: string; browser_bookmark_id: string | null; payload: { order?: string[]; folderName?: string } | null }>
> {
  const r = await env.app.request(`/api/v1/browser/ops?deviceId=${DEVICE}`);
  const body = (await r.json()) as {
    ops: Array<{ id: number; op: string; browser_bookmark_id: string | null; payload: { order?: string[]; folderName?: string } | null }>;
  };
  return body.ops;
}

describe("D44 删除镜像（ingest 身份映射 + remove 排队）", () => {
  it("带 deviceId+browserId 的导入建立映射；删除书签 → 入队 remove 操作", async () => {
    env = makeEnv();
    await ingest([{ url: "https://d44.example/a", title: "A", folderPath: [], browserId: "node-a-1" }], "d44-key-1");
    const bm = env.store.listBookmarks({ limit: 10 }).find((b) => b.url_raw.includes("d44.example/a"));
    expect(bm).toBeDefined();

    const del = await env.app.request(`/api/v1/bookmarks/${bm!.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const ops = await pendingOps();
    expect(ops.length).toBe(1);
    expect(ops[0]?.op).toBe("remove");
    expect(ops[0]?.browser_bookmark_id).toBe("node-a-1");
  });

  it("重复 URL 导入（不同 browserId）回填身份到既有书签；删除一次 → 两个浏览器节点各一条 remove", async () => {
    env = makeEnv();
    await ingest([{ url: "https://d44.example/b", title: "B1", folderPath: [], browserId: "node-b-1" }], "d44-key-2a");
    const dup = await ingest([{ url: "https://d44.example/b", title: "B1 副本", folderPath: [], browserId: "node-b-2" }], "d44-key-2b");
    expect(dup.imported).toBe(0);
    expect(dup.skipped_duplicate).toBe(1);

    const appIds = new Set(env.store.listBookmarks({ limit: 50 }).filter((b) => b.url_raw.includes("d44.example/b")).map((b) => b.id));
    expect(appIds.size).toBe(1);
    const id = [...appIds][0]!;
    expect(env.store.identitiesForApp(id).map((i) => i.browser_bookmark_id).sort()).toEqual(["node-b-1", "node-b-2"]);

    await env.app.request(`/api/v1/bookmarks/${id}`, { method: "DELETE" });
    const ops = await pendingOps();
    expect(ops.map((o) => o.browser_bookmark_id).sort()).toEqual(["node-b-1", "node-b-2"]);
    expect(ops.every((o) => o.op === "remove")).toBe(true);
  });

  it("无身份映射的书签（如手工新建/HTML 导入）→ 删除不产生任何浏览器操作", async () => {
    env = makeEnv();
    const created = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://d44.example/c", title: "C" }),
      })
    ).json()) as { id: string };
    await env.app.request(`/api/v1/bookmarks/${created.id}`, { method: "DELETE" });
    expect(await pendingOps()).toEqual([]);
  });

  it("扩展回执 cancelled（开关关闭场景）→ 操作终结不再下发；重复删除入队幂等", async () => {
    env = makeEnv();
    await ingest([{ url: "https://d44.example/d", title: "D", folderPath: [], browserId: "node-d-1" }], "d44-key-4");
    const id = env.store.listBookmarks({ limit: 10 }).find((b) => b.url_raw.includes("d44.example/d"))!.id;
    await env.app.request(`/api/v1/bookmarks/${id}`, { method: "DELETE" });

    const op = (await pendingOps())[0]!;
    const ack = await env.app.request(`/api/v1/browser/ops/${op.id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled", error: "sync_delete_disabled" }),
    });
    expect(ack.status).toBe(200);
    expect(await pendingOps()).toEqual([]);

    // 队列里同节点重复 remove 幂等（构造：直接对 store 双入队）
    env.store.enqueueBrowserOpIdempotent({ deviceId: DEVICE, op: "remove", browserBookmarkId: "node-x-9" });
    expect(env.store.enqueueBrowserOpIdempotent({ deviceId: DEVICE, op: "remove", browserBookmarkId: "node-x-9" })).toBeNull();
    expect((await pendingOps()).filter((o) => o.browser_bookmark_id === "node-x-9").length).toBe(1);
  });

  it("ingest 不带 deviceId（老版本扩展/HTML 通道）→ 行为不变，不建映射", async () => {
    env = makeEnv();
    const res = await env.app.request("/api/v1/bookmarks/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "d44-key-5", items: [{ url: "https://d44.example/e", title: "E", folderPath: [], browserId: "node-e-1" }] }),
    });
    expect(res.status).toBe(200);
    const id = env.store.listBookmarks({ limit: 10 }).find((b) => b.url_raw.includes("d44.example/e"))!.id;
    expect(env.store.identitiesForApp(id)).toEqual([]);
    await env.app.request(`/api/v1/bookmarks/${id}`, { method: "DELETE" });
    expect(await pendingOps()).toEqual([]);
  });
});

describe("D45 POST /browser/reorder（管理台顺序快照入队）", () => {
  async function reorder(deviceId?: string) {
    const res = await env.app.request("/api/v1/browser/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(deviceId ? { deviceId } : {}),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { queued: number; folders: number };
  }

  it("目录内按管理台口径排序：置顶在前、新入库在前；无映射书签不进 order", async () => {
    env = makeEnv();
    await ingest(
      [
        { url: "https://d45.example/old", title: "旧", folderPath: ["开发"], browserId: "n-old", addedAt: "2020-01-01T00:00:00.000Z" },
        { url: "https://d45.example/new", title: "新", folderPath: ["开发"], browserId: "n-new", addedAt: "2025-01-01T00:00:00.000Z" },
        { url: "https://d45.example/pin", title: "置顶", folderPath: ["开发"], browserId: "n-pin", addedAt: "2021-01-01T00:00:00.000Z" },
        // 无 browserId → 无映射，不参与浏览器重排
        { url: "https://d45.example/unmapped", title: "未映射", folderPath: ["开发"] },
      ],
      "d45-key-1",
    );
    const pinned = env.store
      .listBookmarks({ limit: 50 })
      .find((b) => b.url_raw.includes("d45.example/pin"));
    await env.app.request(`/api/v1/bookmarks/${pinned!.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: 1 }),
    });

    const r = await reorder(DEVICE);
    expect(r.folders).toBe(1);
    expect(r.queued).toBe(1);

    const op = (await pendingOps())[0]!;
    expect(op.op).toBe("reorder");
    // 管理台口径 = 置顶(n-pin) → 新入库(n-new) → 旧(n-old)；未映射不在列表
    expect(op.payload?.folderName).toBe("开发");
    expect(op.payload?.order).toEqual(["n-pin", "n-new", "n-old"]);
  });

  it("重新排队以最新快照为准：旧 pending reorder 终结，仅保留一条 pending", async () => {
    env = makeEnv();
    await ingest([{ url: "https://d45.example/a", title: "A", folderPath: ["工具"], browserId: "n-a" }], "d45-key-2a");
    expect((await reorder(DEVICE)).queued).toBe(1);
    // 目录新增映射书签后再排队 → 快照更新且不叠加第二条
    await ingest([{ url: "https://d45.example/b", title: "B", folderPath: ["工具"], browserId: "n-b" }], "d45-key-2b");
    expect((await reorder(DEVICE)).queued).toBe(1);
    const ops = await pendingOps();
    expect(ops.length).toBe(1);
    const r = await env.app.request(`/api/v1/browser/ops?deviceId=${DEVICE}`);
    const body = (await r.json()) as { ops: Array<{ payload: { order: string[] } }> };
    expect(body.ops[0]?.payload.order).toEqual(["n-b", "n-a"]); // added_at DESC
  });

  it("无任何映射 → queued 0；deviceId 过滤：只给指定设备排队", async () => {
    env = makeEnv();
    expect(await reorder(DEVICE)).toEqual({ queued: 0, folders: 0 });
    await ingest([{ url: "https://d45.example/c", title: "C", folderPath: [], browserId: "n-c" }], "d45-key-3");
    const other = await reorder("device-other-9999");
    expect(other.queued).toBe(0);
    expect((await reorder(DEVICE)).queued).toBe(1);
  });
});
