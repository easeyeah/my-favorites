/** F1.1/F1.3/F1.6：导入（幂等/去重/目录映射）、CRUD、导出 */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("POST /bookmarks/ingest（F1.1）", () => {
  it("目录树映射 + 添加时间保留", async () => {
    env = makeEnv();
    const res = await env.app.request("/api/v1/bookmarks/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "key-0001" },
      body: JSON.stringify({
        idempotencyKey: "key-0001",
        items: [
          { url: "https://github.com/x", title: "GH", folderPath: ["书签栏", "开发"], addedAt: "2023-01-01T00:00:00.000Z" },
          { url: "https://example.com/alone", title: "无目录", folderPath: [] },
        ],
      }),
    });
    const body = (await res.json()) as { imported: number; skipped_duplicate: number };
    expect(res.status).toBe(200);
    expect(body.imported).toBe(2);

    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{ name: string }>;
    expect(folders.map((f) => f.name)).toEqual(expect.arrayContaining(["书签栏", "开发", "未整理"]));
  });

  it("去重（DEV-13 保守键 v2）：tracking 差异仍合并；scheme/www/hash 差异不再误吞", async () => {
    env = makeEnv();
    const res = await env.app.request("/api/v1/bookmarks/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "key-0002",
        items: [
          { url: "https://github.com/a?utm_source=rss", title: "a", folderPath: [] },
          { url: "https://github.com/a/", title: "a 末斜杠同义", folderPath: [] },
          // DEV-13：https 与 http 指向可能不同（内网设备/策略），保守不再合并
          { url: "http://github.com/a", title: "a http 变体", folderPath: [] },
          // hash 路由是不同页面（SPA），不吞
          { url: "https://app.example.com/#/a", title: "hash a", folderPath: [] },
          { url: "https://app.example.com/#/b", title: "hash b", folderPath: [] },
        ],
      }),
    });
    const body = (await res.json()) as { imported: number; skipped_duplicate: number };
    expect(body.imported).toBe(4);
    expect(body.skipped_duplicate).toBe(1); // 仅 utm 变体被合并
  });

  it("幂等：同 key 重放不重复导入", async () => {
    env = makeEnv();
    const req = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "same-key",
        items: [{ url: "https://example.com/1", title: "1", folderPath: [] }],
      }),
    };
    const first = (await (await env.app.request("/api/v1/bookmarks/ingest", req)).json()) as {
      imported: number;
    };
    const second = (await (await env.app.request("/api/v1/bookmarks/ingest", req)).json()) as {
      imported: number;
      idempotent_replay: boolean;
    };
    expect(first.imported).toBe(1);
    expect(second.idempotent_replay).toBe(true);
    // 重放返回原始结果（扩展端 SW 重试不会重复导入，也不会拿到误导性的 0）
    expect(second.imported).toBe(1);
  });

  it("导入不进收件箱（红线 5）", async () => {
    env = makeEnv();
    await env.app.request("/api/v1/inbox/setup", { method: "POST" });
    await env.app.request("/api/v1/bookmarks/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "key-0003",
        items: [{ url: "https://github.com/y", title: "y", folderPath: [] }],
      }),
    });
    const bookmarks = (await (await env.app.request("/api/v1/bookmarks")).json()) as Array<{ folder_id: string }>;
    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{ id: string; is_system_inbox: number }>;
    const inbox = folders.find((f) => f.is_system_inbox === 1);
    expect(bookmarks.every((b) => b.folder_id !== inbox?.id)).toBe(true);
  });
});

describe("Netscape HTML 导入与导出（F1.1 通道2 / F1.6）", () => {
  it("HTML 导入保留目录与时间", async () => {
    env = makeEnv();
    const html = [
      "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
      "<DL><p>",
      "<DT><H3>开发</H3>",
      "<DL><p>",
      '<DT><A HREF="https://github.com/z" ADD_DATE="1690000001">GH</A>',
      "</DL><p>",
      "</DL><p>",
    ].join("\n");
    const res = await env.app.request("/api/v1/bookmarks/ingest/html", {
      method: "POST",
      headers: { "content-type": "text/html" },
      body: html,
    });
    const body = (await res.json()) as { imported: number };
    expect(body.imported).toBe(1);
  });

  it("JSON/HTML 导出可迁移", async () => {
    env = makeEnv();
    await env.app.request("/api/v1/bookmarks/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "key-0004",
        items: [{ url: "https://example.com/e", title: "E", folderPath: ["测试"] }],
      }),
    });
    const js = await env.app.request("/api/v1/export/json");
    const json = (await js.json()) as { bookmarks: unknown[] };
    expect(json.bookmarks).toHaveLength(1);

    const hs = await env.app.request("/api/v1/export/html");
    const html = await hs.text();
    expect(html).toContain("https://example.com/e");
    expect(html).toContain("NETSCAPE-Bookmark-file-1");
  });
});

describe("书签 CRUD（F1.3）", () => {
  it("创建走即时归位建议；重复 URL 返回已有书签", async () => {
    env = makeEnv();
    const first = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/aa", title: "aa" }),
      })
    ).json()) as { id: string; suggest: { category: string } };
    expect(first.suggest.category).toBe("开发");

    const dup = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/aa", title: "aa again" }),
      })
    ).json()) as { id: string; duplicate: boolean };
    expect(dup.duplicate).toBe(true);
    expect(dup.id).toBe(first.id);
  });

  it("PATCH 更新标题与状态；DELETE 用户显式删除", async () => {
    env = makeEnv();
    const created = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/p", title: "p" }),
      })
    ).json()) as { id: string };

    const patched = (await (
      await env.app.request(`/api/v1/bookmarks/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "改名", status: "archived" }),
      })
    ).json()) as { title: string; status: string };
    expect(patched.title).toBe("改名");
    expect(patched.status).toBe("archived");

    const del = await env.app.request(`/api/v1/bookmarks/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("非法 URL 拒绝", async () => {
    env = makeEnv();
    const res = await env.app.request("/api/v1/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "javascript:alert(1)", title: "x" }),
    });
    expect(res.status).toBe(400);
  });
});
