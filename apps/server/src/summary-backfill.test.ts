/** D63：capture fire-and-forget 语义回归锁 + L1 摘要兜底补扫 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";
import type { LlmClient } from "@mf/ai/llm-client";

const LONG_TEXT = "这是一段足够长的正文内容，用于触发摘要生成链路的判定条件。".repeat(3); // ≥40 字

function makeLlm(): LlmClient {
  return {
    chat: async () => "",
    chatJson: async () => ({ summary: "补扫生成的摘要", tags: ["t1"], keywords: ["k1"] }),
  } as unknown as LlmClient;
}

let env: TestEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

async function seedWithL2(env2: TestEnv, url: string, failReason?: string): Promise<string> {
  const res = await env2.app.request("/api/v1/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, title: "补扫测试" }),
  });
  const bm = (await res.json()) as { id: string };
  env2.store.upsertCache({ bookmarkId: bm.id, l2Text: LONG_TEXT, fetchedVia: "extension_capture", failReason });
  return bm.id;
}

describe("capture fire-and-forget（D63 回归锁）", () => {
  it("capture 立即返回不等 LLM，摘要异步落库", async () => {
    env = makeEnv(makeLlm()); // syncAi=false = 生产语义
    const created = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/article", title: "文章" }),
      })
    ).json()) as { id: string };
    const t0 = Date.now();
    const res = await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: created.id, l2Text: LONG_TEXT }),
    });
    const json = (await res.json()) as { summarized: boolean };
    expect(json.summarized).toBe(false); // async 模式不等待 LLM，立即返回
    expect(Date.now() - t0).toBeLessThan(2000);
    await vi.waitUntil(() => env?.store.getCache(created.id)?.l1_summary, { timeout: 3000 });
    expect(env!.store.getCache(created.id)?.l1_summary).toBe("补扫生成的摘要");
  });
});

describe("L1 摘要兜底补扫（D63）", () => {
  it("llm_unavailable 的缺失摘要被找回，成功后失败原因清空", async () => {
    env = makeEnv(makeLlm());
    const id = await seedWithL2(env, "https://example.com/retry", "llm_unavailable");
    expect(env.pipeline.backfillSummaries(5)).toBe(1);
    await vi.waitUntil(() => env?.store.getCache(id)?.l1_summary, { timeout: 3000 });
    const cache = env.store.getCache(id);
    expect(cache?.l1_summary).toBe("补扫生成的摘要");
    expect(cache?.fail_reason ?? null).toBeNull();
  });

  it("无 LLM 配置时零开销返回 0", async () => {
    env = makeEnv(null);
    await seedWithL2(env, "https://example.com/nollm");
    expect(env.pipeline.backfillSummaries(5)).toBe(0);
    expect(env.store.bookmarksMissingSummary(10).length).toBeGreaterThan(0); // 候选仍在，只是不踢
  });

  it("privacy_* 拒绝不重试且 call_model 拒绝留痕", async () => {
    env = makeEnv(makeLlm());
    // 隐私域书签手动塞正文（模拟历史存量；capture 的 upload_content 会先拒，走不到这层）
    const created = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://pay.tenpay.com/secret", title: "支付" }),
      })
    ).json()) as { id: string };
    env.store.upsertCache({ bookmarkId: created.id, l2Text: LONG_TEXT, fetchedVia: "extension_capture" });
    expect(await env.pipeline.maybeSummarize(created.id)).toBe(false);
    expect(env.store.getCache(created.id)?.fail_reason).toBe("privacy_call_model_denied");
    const stale = await seedWithL2(env, "https://example.com/stale", "stale_policy_discarded");
    const candidates = env.store.bookmarksMissingSummary(10).map((b) => b.id);
    expect(candidates).toContain(stale); // stale 可重试（重跑时现行策略再判定）
    expect(candidates).not.toContain(created.id); // 隐私拒绝不重试
  });

  it("私密书签不进补扫候选", async () => {
    env = makeEnv(makeLlm());
    const id = await seedWithL2(env, "https://example.com/private");
    env.store.updateBookmark(id, { is_private: 1 });
    expect(env.store.bookmarksMissingSummary(10)).toHaveLength(0);
  });
});
