/** F1.4 即时归位 / F1.5 收件箱流水线 / F2 捕获与摘要（隐私红线） */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";
import type { LlmClient } from "@mf/ai/llm-client";

let env: TestEnv;
afterEach(() => env?.cleanup());

async function setupInboxAndAdd(url: string, title: string): Promise<{ bmId: string; inboxId: string }> {
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
  return { bmId: bm.id, inboxId: inbox.id };
}

describe("POST /bookmarks/suggest（F1.4 即时归位）", () => {
  it("规则命中返回目录建议", async () => {
    env = makeEnv();
    const res = await env.app.request("/api/v1/bookmarks/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/aa/bb", title: "repo" }),
    });
    const body = (await res.json()) as { category: string; source: string; confidence: number };
    expect(body.category).toBe("开发");
    expect(body.source).toBe("domain_map");
    expect(body.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("domain_cache 二次命中（<50ms 路径）", async () => {
    env = makeEnv();
    await env.app.request("/api/v1/bookmarks/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://figma.com/file", title: "x" }),
    });
    const res = await env.app.request("/api/v1/bookmarks/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://figma.com/another", title: "y" }),
    });
    const body = (await res.json()) as { source: string };
    expect(body.source).toBe("domain_cache");
  });

  it("隐私域名：只存 URL 不外推分类（红线 2）", async () => {
    env = makeEnv();
    const res = await env.app.request("/api/v1/bookmarks/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://icbc.bank/login", title: "bank" }),
    });
    const body = (await res.json()) as { privacy: boolean; category: string };
    expect(body.privacy).toBe(true);
    expect(body.category).toBe("隐私");
  });
});

describe("POST /inbox/process（F1.5 收件箱流水线）", () => {
  it("规则高置信度自动归位并写版本", async () => {
    env = makeEnv();
    const { bmId } = await setupInboxAndAdd("https://gitlab.com/proj", "proj");
    const res = await env.app.request("/api/v1/inbox/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkIds: [bmId] }),
    });
    const body = (await res.json()) as {
      moved: Array<{ id: string; source: string }>;
      left: unknown[];
      versionId: string | null;
    };
    expect(body.moved).toHaveLength(1);
    expect(body.moved[0]?.source).toBe("rule");
    expect(body.versionId).not.toBeNull();
  });

  it("低置信度留在收件箱（永不丢书签）", async () => {
    env = makeEnv(null); // 无 LLM
    const { bmId } = await setupInboxAndAdd("https://unknown-xyz-123.com/page", "unknown");
    const res = await env.app.request("/api/v1/inbox/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkIds: [bmId] }),
    });
    const body = (await res.json()) as { moved: unknown[]; left: Array<{ id: string }> };
    expect(body.moved).toHaveLength(0);
    expect(body.left.some((l) => l.id === bmId)).toBe(true);
    // 书签仍在收件箱
    const bm = (await (
      await env.app.request(`/api/v1/bookmarks/${bmId}`)
    ).json()) as { folder_id: string };
    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{
      id: string;
      is_system_inbox: number;
    }>;
    const inbox = folders.find((f) => f.is_system_inbox === 1);
    expect(bm.folder_id).toBe(inbox?.id);
  });

  it("隐私域名书签留在收件箱不处理", async () => {
    env = makeEnv();
    const { bmId } = await setupInboxAndAdd("https://icbc.bank/portal", "bank");
    const res = await env.app.request("/api/v1/inbox/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkIds: [bmId] }),
    });
    const body = (await res.json()) as { left: Array<{ id: string; reason: string }> };
    expect(body.left[0]?.reason).toBe("privacy_domain");
  });

  it("LLM 兜底：规则未命中时批量精修（mock 返回确定性分类）", async () => {
    // mock LLM：返回与 llm-mock 契约一致的 MOCK:: JSON
    const mockLlm = {
      chatJson: async () => ({
        results: [{ index: 0, category: "视频", confidence: 0.9 }],
      }),
    } as unknown as LlmClient;
    env = makeEnv(mockLlm);
    const { bmId } = await setupInboxAndAdd("https://unknown-site-2.com/v", "video page");
    const res = await env.app.request("/api/v1/inbox/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkIds: [bmId] }),
    });
    const body = (await res.json()) as { moved: Array<{ id: string; to: string; source: string }> };
    expect(body.moved[0]?.to).toBe("视频");
    expect(body.moved[0]?.source).toBe("llm");
  });
});

describe("内容捕获与摘要（F2.1/F2.3）", () => {
  it("捕获正文 + AI 摘要（sync 模式，mock LLM）", async () => {
    const mockLlm = {
      chatJson: async () => ({
        summary: "这是一个测试页面摘要",
        tags: ["测试", "示例"],
        keywords: ["test"],
      }),
    } as unknown as LlmClient;
    env = makeEnv(mockLlm, true);
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/article", title: "article" }),
      })
    ).json()) as { id: string };

    const res = await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bookmarkId: bm.id,
        l2Text: "这是正文内容".repeat(20),
        description: "页面描述",
      }),
    });
    const body = (await res.json()) as { summarized: boolean };
    expect(body.summarized).toBe(true);

    const cache = (await (
      await env.app.request(`/api/v1/content/${bm.id}`)
    ).json()) as { l1_summary: string; l1_tags: string[]; l2_text: string };
    expect(cache.l1_summary).toBe("这是一个测试页面摘要");
    expect(cache.l1_tags).toEqual(["测试", "示例"]);
  });

  it("隐私域名正文拒绝入库（红线 2 的架构级执行）", async () => {
    env = makeEnv(null, true);
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://alipay.com/pay", title: "支付" }),
      })
    ).json()) as { id: string };
    const res = await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: bm.id, l2Text: "敏感内容".repeat(50) }),
    });
    const body = (await res.json()) as { skippedPrivacy: boolean };
    expect(body.skippedPrivacy).toBe(true);
    const cache = (await (
      await env.app.request(`/api/v1/content/${bm.id}`)
    ).json()) as { l2_text: string | null; fail_reason: string };
    expect(cache.l2_text).toBeNull();
    expect(cache.fail_reason).toBe("privacy_privacy_domain"); // A1-3 统一策略原因码
  });

  it("正文超长截断到 20KB（成本红线）", async () => {
    env = makeEnv(null);
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/long", title: "long" }),
      })
    ).json()) as { id: string };
    await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: bm.id, l2Text: "a".repeat(30_000) }),
    });
    const cache = (await (
      await env.app.request(`/api/v1/content/${bm.id}`)
    ).json()) as { l2_text: string };
    expect(cache.l2_text.length).toBe(20_000);
  });
});
