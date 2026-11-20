/** F7 搜索 / F4 导航站 / F2.4 快照 / 埋点 / stats */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

async function seed(env: TestEnv) {
  await env.app.request("/api/v1/bookmarks/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "seed-misc",
      items: [
        { url: "https://github.com/visual-studio", title: "VS Code 编辑器", folderPath: ["开发"] },
        { url: "https://bilibili.com/vlog", title: "旅行视频", folderPath: ["娱乐"] },
        { url: "https://news.example.com/rust", title: "Rust 新闻", folderPath: ["阅读"] },
      ],
    }),
  });
  // 注入正文缓存供全文搜索
  const all = (await (await env.app.request("/api/v1/bookmarks")).json()) as Array<{
    id: string;
    title: string;
  }>;
  const rust = all.find((b) => b.title === "Rust 新闻");
  if (rust) {
    await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: rust.id, l2Text: "Rust 1.80 发布了新特性" }),
    });
  }
}

describe("GET /search（F7.1 全文搜索）", () => {
  it("标题命中", async () => {
    env = makeEnv();
    await seed(env);
    const res = await env.app.request("/api/v1/search?q=VS%20Code");
    const body = (await res.json()) as { results: Array<{ title: string }> };
    expect(body.results.some((r) => r.title === "VS Code 编辑器")).toBe(true);
  });

  it("缓存正文命中（内容级搜索）", async () => {
    env = makeEnv();
    await seed(env);
    const res = await env.app.request("/api/v1/search?q=Rust%201.80");
    const body = (await res.json()) as { results: Array<{ title: string }> };
    expect(body.results.some((r) => r.title === "Rust 新闻")).toBe(true);
  });

  it("空查询返回空", async () => {
    env = makeEnv();
    await seed(env);
    const res = await env.app.request("/api/v1/search?q=");
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(0);
  });
});

describe("导航站（F4.1/F4.2 + DEV-01）", () => {
  it("发布生成加密随机 slug 且渲染宫格 HTML + 水印", async () => {
    env = makeEnv();
    await seed(env);
    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{
      id: string;
      is_system_inbox: number;
    }>;
    const pub = (await (
      await env.app.request("/api/v1/nav/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "我的导航",
          folderIds: folders.filter((f) => !f.is_system_inbox).map((f) => f.id),
        }),
      })
    ).json()) as { slug: string };
    expect(pub.slug).toHaveLength(12); // base64url(9 bytes) = 12 字符（加密随机源）

    const page = await env.app.request(`/s/${pub.slug}`);
    const html = await page.text();
    expect(html).toContain("我的导航");
    expect(html).toContain("VS Code 编辑器");
    expect(html).toContain("my-favorites"); // F4.2 页脚水印
    expect(html).toContain("grid-template-columns"); // 宫格布局
  });

  it("未知 slug 404", async () => {
    env = makeEnv();
    const res = await env.app.request("/s/nonexistent");
    expect(res.status).toBe(404);
  });

  it("DEV-01：存量/撤销发布站点显示未发布占位，不回退全库数据", async () => {
    env = makeEnv();
    await seed(env);
    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{
      id: string;
      is_system_inbox: number;
    }>;
    const pub = (await (
      await env.app.request("/api/v1/nav/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "撤下站",
          folderIds: folders.filter((f) => !f.is_system_inbox).map((f) => f.id),
        }),
      })
    ).json()) as { slug: string };
    const unpublish = await env.app.request(`/api/v1/nav/sites/${pub.slug}/unpublish`, { method: "POST" });
    expect(unpublish.status).toBe(200);
    const html = await (await env.app.request(`/s/${pub.slug}`)).text();
    expect(html).toContain("暂未发布");
    expect(html).not.toContain("VS Code 编辑器");
  });

  it("/nav/data 供 newtab 渲染（收纳盒不出现）", async () => {
    env = makeEnv();
    await seed(env);
    await env.app.request("/api/v1/inbox/setup", { method: "POST" });
    const data = (await (
      await env.app.request("/api/v1/nav/data")
    ).json()) as { groups: Array<{ name: string }> };
    expect(data.groups.every((g) => g.name !== "📥 收纳盒")).toBe(true);
  });
});

describe("快照（F2.4 + DEV-02 旧直读封堵）", () => {
  it("上传 MHTML → 落盘 → 受控下载读回一致；旧直读接口 410", async () => {
    env = makeEnv();
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/snap", title: "snap" }),
      })
    ).json()) as { id: string };

    const content = "MIME-Version: 1.0\r\nContent-Type: multipart/related\r\n\r\nfake-mhtml";
    const up = await env.app.request(`/api/v1/snapshots?bookmarkId=${bm.id}`, {
      method: "POST",
      headers: { "content-type": "message/rfc822" },
      body: content,
    });
    const body = (await up.json()) as { id: string; size: number };
    expect(body.size).toBe(content.length);

    // 受控下载（attachment + nosniff）读回一致
    const down = await env.app.request(`/api/v1/snapshots/${body.id}/download`);
    expect(down.status).toBe(200);
    expect(down.headers.get("content-disposition")).toContain("attachment");
    expect(await down.text()).toBe(content);

    // DEV-02：旧直读 /snapshots/:id 封堵为 410（message/rfc822 可内联执行）
    const legacy = await env.app.request(`/api/v1/snapshots/${body.id}`);
    expect(legacy.status).toBe(410);

    // 埋点计数（snapshot_created 属于扩展上报，此处仅验证接口可用）
    const summary = (await (
      await env.app.request("/api/v1/analytics/summary")
    ).json()) as Record<string, number>;
    expect(summary).toHaveProperty("snapshot_created", 0);
  });
});

describe("埋点与 stats", () => {
  it("批量上报与汇总", async () => {
    env = makeEnv();
    await env.app.request("/api/v1/analytics/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ name: "install" }, { name: "nav_generated", props: { template: "grid" } }],
      }),
    });
    const summary = (await (
      await env.app.request("/api/v1/analytics/summary")
    ).json()) as Record<string, number>;
    expect(summary["install"]).toBe(1);
    expect(summary["nav_generated"]).toBe(1);
  });

  it("stats 返回计数", async () => {
    env = makeEnv();
    await seed(env);
    const stats = (await (await env.app.request("/api/v1/stats")).json()) as {
      total: number;
      folders: number;
    };
    expect(stats.total).toBe(3);
    expect(stats.folders).toBe(3);
  });
});
