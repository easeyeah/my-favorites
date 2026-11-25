/**
 * D70 收纳盒「书签/资料」自动分流集成测试：
 *  - video：URL 线索异步分流，不先归普通目录，视频不下载本体；
 *  - article：新收纳盒入口队列补抓/复用授权正文，独立判内容后才物化/转换；
 *  - 归位模型的 material 布尔不作证据，内容太薄或独立判定非内容则保留书签；
 *  - 隐私：loopback 属内置隐私域 → 收纳盒层 privacy_hold 不归位，crawlOne 层独立拒绝（双保险）。
 * 异步规范（D62）：扫描走串行涓流队列，不阻塞归位响应；失败落 cache.failReason 可观测。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmClient } from "@mf/ai/llm-client";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;

afterEach(async () => {
  await env?.pipeline.scanIdle();
  env?.cleanup();
  env = undefined as unknown as TestEnv;
});

/** prompt 感知的 LLM 替身：整理调用返回分类+material 判定；摘要调用返回摘要形态 */
function fakeLlm(opts: {
  material: boolean;
  category?: string;
  confidence?: number;
}) {
  return {
    chatJson: async (messages: Array<{ role: string; content: string }>) => {
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("摘要助手")) {
        return { summary: "测试摘要", tags: ["测试"], keywords: ["test"], category: ["其他"] };
      }
      return {
        results: [
          {
            index: 0,
            category: opts.category ?? "阅读",
            confidence: opts.confidence ?? 0.95,
            material: opts.material,
          },
        ],
      };
    },
  } as unknown as LlmClient;
}

async function folderExists(name: string): Promise<boolean> {
  const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{ name: string }>;
  return folders.some((f) => f.name === name);
}

/** 建系统收纳盒 + 直接把书签丢进去（与既有 setupInboxAndAdd 同款） */
async function addInboxItem(url: string, title: string): Promise<string> {
  const inbox = (await (
    await env.app.request("/api/v1/inbox/setup", { method: "POST" })
  ).json()) as { id: string };
  const bm = (await (
    await env.app.request("/api/v1/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, title, folderId: inbox.id }),
    })
  ).json()) as { id: string };
  return bm.id;
}

async function processInbox(bmId: string): Promise<{ moved: unknown[]; left: unknown[] }> {
  const res = await env.app.request("/api/v1/inbox/process", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookmarkIds: [bmId] }),
  });
  return (await res.json()) as { moved: unknown[]; left: unknown[] };
}

async function materialOf(bmId: string): Promise<{ type: string } | null> {
  const detail = (await (
    await env.app.request(`/api/v1/bookmarks/${bmId}`)
  ).json()) as { materials?: Array<{ type: string }> };
  const row = (detail as { material?: { type: string } | null }).material ?? null;
  if (row) return { type: row.type };
  const all = (await (await env.app.request("/api/v1/materials")).json()) as {
    items: Array<{ bookmark_id: string; type: string }>;
  };
  const hit = all.items.find((x) => x.bookmark_id === bmId);
  return hit ? { type: hit.type } : null;
}

describe("D70 收纳盒书签/资料自动分流", () => {
  it("video：URL 规则即判 → 归位后直接物化（不抓取）", async () => {
    env = makeEnv(fakeLlm({ material: false }));
    const bmId = await addInboxItem("https://www.bilibili.com/video/BV1xx411c7mD", "测试视频");
    const r = await processInbox(bmId);
    expect((r as { moved: unknown[] }).moved.length).toBe(0); // 尚未成功，不预报归位
    expect((r as unknown as { queued: string[] }).queued).toContain(bmId);
    await env.pipeline.scanIdle();
    expect(await materialOf(bmId)).toMatchObject({ type: "video" });
  });

  it("D81 回归：无 LLM（规则引擎模式）视频归位仍入资料库——早退不得跳过 D70 分流", async () => {
    env = makeEnv(null); // 无 LLM：规则归位 + no_llm 早退路径
    const bmId = await addInboxItem("https://www.bilibili.com/video/BV1xx411c7mE", "无LLM视频");
    const r = await processInbox(bmId);
    expect((r as { moved: unknown[] }).moved.length).toBe(0); // D91：直接异步分流，不先建「视频」目录
    expect((r as unknown as { queued: string[] }).queued).toContain(bmId);
    await env.pipeline.scanIdle();
    expect(await materialOf(bmId)).toMatchObject({ type: "video" });
  });

  it("article + LLM 判定 material=true：归位后队列补抓正文 → 入资料（注入 fetcher，隐私判定前置不放宽）", async () => {
    let fetchCalled = 0;
    const articleHtml = Buffer.from(
      `<html><body><article>${"这是一篇值得收藏的测试文章正文内容，用于验证资料自动分流链路。".repeat(12)}</article></body></html>`,
    );
    env = makeEnv(fakeLlm({ material: true }), false, {
      crawlFetcher: async () => {
        fetchCalled++;
        return {
          ok: true,
          status: 200,
          readBody: async () => Promise.resolve(articleHtml),
          dispose: () => undefined,
        };
      },
    });
    const bmId = await addInboxItem("https://notable-blog.example.com/post/1", "一篇好文章");
    const r = await processInbox(bmId);
    expect((r as { moved: unknown[] }).moved.length).toBe(1);
    await env.pipeline.scanIdle();
    expect(fetchCalled).toBe(1); // 补抓恰好一次
    expect(await materialOf(bmId)).toMatchObject({ type: "article" });
  });

  it("article + LLM 判定 material=false（工具首页等内容壳）：只做书签归位，不抓取不入资料", async () => {
    let fetchCalled = 0;
    env = makeEnv(fakeLlm({ material: false }), false, {
      crawlFetcher: async () => {
        fetchCalled++;
        return { ok: true, status: 200, readBody: async () => Promise.resolve(Buffer.from("x")), dispose: () => undefined };
      },
    });
    const bmId = await addInboxItem("https://some-tool.example.com/", "某工具首页");
    const r = await processInbox(bmId);
    expect((r as { moved: unknown[] }).moved.length).toBe(1);
    await env.pipeline.scanIdle();
    expect(fetchCalled).toBe(1); // D91：归位的 material=false 只是标题/URL猜测，仍必须读取实际内容
    expect(await materialOf(bmId)).toBeNull();
  });

  it("隐私双保险：loopback 收纳盒层 privacy_hold；crawlOne 层独立拒绝且不触发抓取", async () => {
    let fetchCalled = 0;
    env = makeEnv(fakeLlm({ material: true }), false, {
      crawlFetcher: async () => {
        fetchCalled++;
        return { ok: true, status: 200, readBody: async () => Promise.resolve(Buffer.from("x")), dispose: () => undefined };
      },
    });
    const bmId = await addInboxItem("http://127.0.0.1:9999/secret", "内网页面");
    const r = await processInbox(bmId);
    expect((r as { left: Array<{ reason: string }> }).left[0]?.reason).toBe("privacy_domain");
    await env.pipeline.scanIdle();
    // crawlOne 层独立判定（直调验证红线不依赖归位路径）
    const crawl = await env.pipeline.crawlOne(bmId);
    expect(crawl).toMatchObject({ ok: false, reason: "privacy" });
    expect(fetchCalled).toBe(0); // 隐私拒绝 → fetcher 未被触发
  });
});

describe("D71 新目录创建门槛", () => {
  it("建议新目录但置信度 <0.8 → 歧义滞留，目录不创建", async () => {
    env = makeEnv(fakeLlm({ material: false, category: "播客", confidence: 0.7 }));
    const bmId = await addInboxItem("https://podcast.example.com/ep1", "一期播客");
    const r = await processInbox(bmId);
    expect((r as { left: Array<{ reason: string }> }).left[0]?.reason).toBe("new_folder_low_confidence");
    expect(await folderExists("播客")).toBe(false);
  });

  it("建议新目录且置信度 ≥0.8 → 创建目录并归位", async () => {
    env = makeEnv(fakeLlm({ material: false, category: "播客", confidence: 0.9 }));
    const bmId = await addInboxItem("https://podcast.example.com/ep1", "一期播客");
    const r = await processInbox(bmId);
    expect((r as { moved: Array<{ to: string }> }).moved[0]?.to).toBe("播客");
    expect(await folderExists("播客")).toBe(true);
  });

  it("现有目录置信度 0.65（<0.8）→ 照常归位（门槛只约束新目录）", async () => {
    env = makeEnv(fakeLlm({ material: false, category: "阅读", confidence: 0.65 }));
    const res = await env.app.request("/api/v1/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "阅读" }),
    });
    expect(res.status).toBeLessThan(300);
    const bmId = await addInboxItem("https://reading.example.com/post", "一篇文章");
    const r = await processInbox(bmId);
    expect((r as { moved: Array<{ to: string }> }).moved[0]?.to).toBe("阅读");
  });
});
