/** D52 书签编辑：PATCH url/description（查重、缓存作废、变更日志、修订计数） */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

async function createBookmark(url: string, title = "T") {
  const r = (await (
    await env.app.request("/api/v1/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, title }),
    })
  ).json()) as { id: string };
  return r.id;
}

async function patch(id: string, body: unknown) {
  return env.app.request(`/api/v1/bookmarks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /bookmarks/:id（D52 编辑）", () => {
  it("改 URL：重算查重键、清正文缓存、进变更日志、修订 +1", async () => {
    env = makeEnv();
    const id = await createBookmark("https://d52.example/old");
    env.store.upsertCache({ bookmarkId: id, l2Text: "旧正文", fetchedVia: "extension_capture" });
    const revBefore = env.store.getBookmark(id)?.content_revision ?? 0;

    const res = await patch(id, { url: "https://d52.example/new?utm_source=x" });
    expect(res.status).toBe(200);
    const after = env.store.getBookmark(id)!;
    expect(after.url_raw).toBe("https://d52.example/new?utm_source=x");
    expect(after.url_canonical).toBe("https://d52.example/new"); // tracking 清理照旧
    expect(env.store.getCache(id)).toBeUndefined(); // 旧 URL 的正文作废
    expect(after.content_revision).toBe(revBefore + 1);

    // 变更日志：浏览器侧靠它跟随
    const pull = (await (await env.app.request(`/api/v1/sync/pull?cursor=0&device=dev-x`)).json()) as {
      items: Array<{ entity_id: string; op: string; payload: { url_raw?: string } }>;
    };
    const logs = pull.items.filter((i) => i.entity_id === id && i.op === "upsert");
    expect(logs.length).toBeGreaterThanOrEqual(2); // 创建一条 + 编辑一条
    expect(logs[logs.length - 1]?.payload?.url_raw).toBe("https://d52.example/new?utm_source=x");
  });

  it("改 URL 撞既有查重键 → 409；非法 URL → 400；同值 URL → 不清缓存", async () => {
    env = makeEnv();
    const a = await createBookmark("https://d52.example/a");
    const b = await createBookmark("https://d52.example/b");
    expect((await patch(a, { url: "https://d52.example/b/" })).status).toBe(409); // 末斜杠同义命中
    expect((await patch(a, { url: "not a url" })).status).toBe(400);
    env.store.upsertCache({ bookmarkId: a, l2Text: "正文", fetchedVia: "extension_capture" });
    expect((await patch(a, { url: "https://d52.example/a" })).status).toBe(200);
    expect(env.store.getCache(a)).not.toBeNull(); // 未变不清
  });

  it("改备注与标题：落库并进日志；备注超长截断 2000", async () => {
    env = makeEnv();
    const id = await createBookmark("https://d52.example/c");
    const res = await patch(id, { description: "为什么收藏它".repeat(1), title: "新标题" });
    expect(res.status).toBe(200);
    const row = env.store.getBookmark(id)!;
    expect(row.description).toBe("为什么收藏它");
    expect(row.title).toBe("新标题");
    const long = await patch(id, { description: "x".repeat(3000) });
    expect(long.status).toBe(200);
    expect((env.store.getBookmark(id)!.description ?? "").length).toBe(2000);
  });
});
