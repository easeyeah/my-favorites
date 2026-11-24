/**
 * D89 目录级能力集成测试：
 *  - 目录右键「AI 重新整理」：范围限定子树（不跨出）、新建子目录挂在该目录下、版本可撤销；
 *  - 目录右键「提取资料」：SSE 逐条进度、内容页判定、抓取失败进「建议丢弃」清单、
 *    隐私/私密跳过且永不抓取；扫描结果幂等（已入库不重复）。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { LlmClient } from "@mf/ai/llm-client";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => {
  env?.cleanup();
  env = undefined as unknown as TestEnv;
});

async function ingest(items: Array<{ url: string; title: string; folderPath: string[] }>): Promise<void> {
  const res = await env.app.request("/api/v1/bookmarks/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: `d89-${Math.random()}`, items }),
  });
  expect(res.status).toBe(200);
}

async function folders(): Promise<Array<{ id: string; name: string; parent_id: string | null }>> {
  return (await (await env.app.request("/api/v1/folders")).json()) as Array<{
    id: string;
    name: string;
    parent_id: string | null;
  }>;
}

async function bookmarks(): Promise<Array<{ id: string; title: string; folder_id: string }>> {
  return (await (await env.app.request("/api/v1/bookmarks")).json()) as Array<{
    id: string;
    title: string;
    folder_id: string;
  }>;
}

async function organizeFolder(folderId: string, includeSubfolders = true) {
  return (await (
    await env.app.request("/api/v1/organize/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderId, includeSubfolders }),
    })
  ).json()) as {
    status: "applied" | "answered";
    applied?: number;
    versionId?: string;
    answer: string;
  };
}

interface ScanItem {
  id: string;
  title: string;
  status: "created" | "not_content" | "failed";
  reason?: string;
}
interface ScanDone {
  created: number;
  notContent: number;
  skipped: number;
  failed: Array<{ id: string; title: string; reason: string }>;
  remaining: number;
  processed: number;
}

async function scanFolder(folderId: string, opts: { includeSubfolders?: boolean; limit?: number } = {}) {
  const q = new URLSearchParams({
    folderId,
    includeSubfolders: opts.includeSubfolders === false ? "0" : "1",
    limit: String(opts.limit ?? 30),
  });
  const res = await env.app.request(`/api/v1/materials/scan/stream?${q}`);
  expect(res.status).toBe(200);
  const text = await res.text();
  const items: ScanItem[] = [];
  let done: ScanDone | null = null;
  for (const frame of text.split("\n\n")) {
    const event = frame.match(/^event:\s*(\S+)/m)?.[1];
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!event || !data) continue;
    const payload = JSON.parse(data) as Record<string, unknown>;
    if (event === "item") items.push(payload as unknown as ScanItem);
    if (event === "done") done = payload as unknown as ScanDone;
    if (event === "error") throw new Error(String(payload.error));
  }
  expect(done).not.toBeNull();
  return { items, done: done! };
}

describe("D89 目录级 AI 重新整理", () => {
  it("规则命中只在本目录子树内移动；版本可撤销，子树外书签不动", async () => {
    env = makeEnv(null); // 无 LLM：只跑规则引擎
    await ingest([
      { url: "https://github.com/acme/one", title: "GH 一号", folderPath: ["工作"] },
      { url: "https://github.com/acme/two", title: "GH 二号", folderPath: ["工作", "开发"] },
      { url: "https://github.com/acme/three", title: "GH 三号（子树外）", folderPath: ["生活"] },
    ]);
    const tree = await folders();
    const work = tree.find((f) => f.name === "工作")!;
    const dev = tree.find((f) => f.name === "开发" && f.parent_id === work.id)!;
    const life = tree.find((f) => f.name === "生活")!;

    const r = await organizeFolder(work.id);
    expect(r.status).toBe("applied");
    expect(r.applied).toBe(1); // 只有「工作」下直挂的 GH 一号被移到子目录「开发」
    expect(r.versionId).toBeTruthy();

    let rows = await bookmarks();
    expect(rows.find((b) => b.title === "GH 一号")?.folder_id).toBe(dev.id);
    expect(rows.find((b) => b.title === "GH 二号")?.folder_id).toBe(dev.id);
    expect(rows.find((b) => b.title === "GH 三号（子树外）")?.folder_id).toBe(life.id); // 不跨出子树

    // 撤销：回到「工作」
    const undo = (await (
      await env.app.request(`/api/v1/organize/rollback/${r.versionId}`, { method: "POST" })
    ).json()) as { reversed: number };
    expect(undo.reversed).toBe(1);
    rows = await bookmarks();
    expect(rows.find((b) => b.title === "GH 一号")?.folder_id).toBe(work.id);
  });

  it("LLM 建议的新目录创建在被整理目录下（不是根级）", async () => {
    const llm = {
      chatJson: async (messages: Array<{ role: string; content: string }>) => {
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("书签分类助手")) {
          const user = messages.find((m) => m.role === "user")?.content ?? "[]";
          const items = JSON.parse(user) as Array<{ index: number }>;
          return {
            results: items.map((it) => ({ index: it.index, category: "深度阅读", confidence: 0.9 })),
          };
        }
        return {};
      },
    } as unknown as LlmClient;
    env = makeEnv(llm);
    await ingest([{ url: "https://unknown-d89.example.com/post", title: "长文", folderPath: ["资料"] }]);
    const tree = await folders();
    const root = tree.find((f) => f.name === "资料")!;

    const r = await organizeFolder(root.id);
    expect(r.status).toBe("applied");
    // applied 计版本动作（createFolder + move），至少包含一次移动
    expect(r.applied).toBeGreaterThanOrEqual(1);
    const after = await folders();
    const created = after.find((f) => f.name === "深度阅读")!;
    expect(created).toBeTruthy();
    expect(created.parent_id).toBe(root.id); // 挂在该目录下，不是根级
    const rows = await bookmarks();
    expect(rows.find((b) => b.title === "长文")?.folder_id).toBe(created.id);
  });

  it("目录不存在 → 404", async () => {
    env = makeEnv(null);
    const res = await env.app.request("/api/v1/organize/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderId: "no-such-folder" }),
    });
    expect(res.status).toBe(404);
  });

  it("回归：模型返回孙级已有目录名时复用，不在父级下建重复目录（P1）", async () => {
    const llm = {
      chatJson: async (messages: Array<{ role: string; content: string }>) => {
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("书签分类助手")) {
          const user = messages.find((m) => m.role === "user")?.content ?? "[]";
          const items = JSON.parse(user) as Array<{ index: number }>;
          return { results: items.map((it) => ({ index: it.index, category: "前端", confidence: 0.9 })) };
        }
        return {};
      },
    } as unknown as LlmClient;
    env = makeEnv(llm);
    await ingest([
      // 先建出深层目录 工作/开发/前端（放一条已在其中的书签）
      { url: "https://deep-d89.example.com/1", title: "深层书签", folderPath: ["工作", "开发", "前端"] },
      // 待整理书签直挂 工作，模型判它属于「前端」（深层，非工作直接子级）
      { url: "https://deep-d89.example.com/2", title: "待归位", folderPath: ["工作"] },
    ]);
    const tree = await folders();
    const work = tree.find((f) => f.name === "工作")!;

    const r = await organizeFolder(work.id);
    expect(r.status).toBe("applied");

    const after = await folders();
    const qian = after.filter((f) => f.name === "前端");
    expect(qian).toHaveLength(1); // 不重复建
    const deep = qian[0]!;
    expect(deep.parent_id).not.toBe(work.id); // 仍是深层那个（父级是「开发」）
    const rows = await bookmarks();
    expect(rows.find((b) => b.title === "待归位")?.folder_id).toBe(deep.id);
    expect(rows.find((b) => b.title === "深层书签")?.folder_id).toBe(deep.id);
  });

  it("回归：已归档书签不参与目录级整理", async () => {
    const llm = {
      chatJson: async (messages: Array<{ role: string; content: string }>) => {
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("书签分类助手")) {
          const user = messages.find((m) => m.role === "user")?.content ?? "[]";
          const items = JSON.parse(user) as Array<{ index: number }>;
          return { results: items.map((it) => ({ index: it.index, category: "新桶", confidence: 0.9 })) };
        }
        return {};
      },
    } as unknown as LlmClient;
    env = makeEnv(llm);
    await ingest([
      { url: "https://arch-d89.example.com/a", title: "活跃", folderPath: ["归档测试"] },
      { url: "https://arch-d89.example.com/b", title: "已归档", folderPath: ["归档测试"] },
    ]);
    const tree = await folders();
    const root = tree.find((f) => f.name === "归档测试")!;
    let rows = await bookmarks();
    const archived = rows.find((b) => b.title === "已归档")!;
    await env.app.request(`/api/v1/bookmarks/${archived.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });

    await organizeFolder(root.id);
    rows = await bookmarks(); // 列表默认排软归档，用 store 直读校验归档项
    const stillArchived = env.store.getBookmark(archived.id)!;
    expect(stillArchived.folder_id).toBe(root.id); // 归档项原地不动
    expect(rows.find((b) => b.title === "活跃")?.folder_id).not.toBe(root.id); // 活跃项被移走
  });
});

describe("D89 目录资料扫描（内容页转资料 + 失败建议丢弃）", () => {
  const articleHtml = `<html><body><article>${"这是一段足够长的正文内容，用于验证资料提取入库。".repeat(30)}</article></body></html>`;

  function scanLlm() {
    return {
      chatJson: async (messages: Array<{ role: string; content: string }>) => {
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("判断每个网页")) {
          const user = messages.find((m) => m.role === "user")?.content ?? "[]";
          const items = JSON.parse(user) as Array<{ index: number; title: string }>;
          return {
            results: items.map((it) => ({ index: it.index, material: !/工具/.test(it.title) })),
          };
        }
        if (sys.includes("摘要助手")) {
          return { summary: "测试摘要", tags: ["测试"], keywords: [], category: ["其他"] };
        }
        return { results: [] };
      },
    } as unknown as LlmClient;
  }

  it("内容页入库 / 非内容页跳过 / 抓取失败进建议丢弃 / 隐私跳过，且逐条推送", async () => {
    const crawled: string[] = [];
    env = makeEnv(scanLlm(), false, {
      crawlFetcher: async (url) => {
        crawled.push(url);
        if (url.includes("dead")) {
          return { ok: false, status: 404, readBody: async () => Buffer.from(""), dispose: () => undefined };
        }
        return {
          ok: true,
          status: 200,
          readBody: async () => Promise.resolve(Buffer.from(articleHtml)),
          dispose: () => undefined,
        };
      },
    });
    await ingest([
      { url: "https://blog-d89.example.com/post/1", title: "深度文章", folderPath: ["收藏"] },
      { url: "https://tool-d89.example.com/", title: "某工具首页", folderPath: ["收藏"] },
      { url: "https://dead-d89.example.com/x", title: "打不开的页面", folderPath: ["收藏"] },
    ]);
    const tree = await folders();
    const root = tree.find((f) => f.name === "收藏")!;
    // 私密书签（永不抓取、永不进丢弃清单）
    const rows = await bookmarks();
    const secret = rows.find((b) => b.title === "打不开的页面")!;
    env.store.updateBookmark(secret.id, { is_private: 1 });

    const { items, done } = await scanFolder(root.id);
    expect(done.created).toBe(1);
    expect(done.notContent).toBe(1);
    expect(done.skipped).toBe(1);
    expect(done.failed).toHaveLength(0);
    expect(items.find((i) => i.title === "深度文章")?.status).toBe("created");
    expect(items.find((i) => i.title === "某工具首页")?.status).toBe("not_content");
    // 私密书签未在任何事件中出现（既不抓取也不建议丢弃）
    expect(items.some((i) => i.id === secret.id)).toBe(false);
    expect(crawled.some((u) => u.includes("dead"))).toBe(false);

    // 已入库条目不重复扫描（幂等）：内容页不再进入候选，只剩上次判定的非内容页
    const again = await scanFolder(root.id);
    expect(again.items.some((i) => i.title === "深度文章")).toBe(false);
    expect(again.items.every((i) => i.status === "not_content")).toBe(true);
  });

  it("抓取失败（非私密）→ failed 清单含原因，且原因落 cache.fail_reason", async () => {
    env = makeEnv(scanLlm(), false, {
      crawlFetcher: async () => ({
        ok: false,
        status: 503,
        readBody: async () => Buffer.from(""),
        dispose: () => undefined,
      }),
    });
    await ingest([{ url: "https://broken-d89.example.com/post", title: "抓不到", folderPath: ["收藏夹"] }]);
    const tree = await folders();
    const root = tree.find((f) => f.name === "收藏夹")!;

    const { done } = await scanFolder(root.id);
    expect(done.failed).toHaveLength(1);
    expect(done.failed[0]?.reason).toContain("crawl_failed");
    expect(done.failed[0]?.reason).toContain("503");
    const rows = await bookmarks();
    const bm = rows.find((b) => b.title === "抓不到")!;
    expect(String(env.store.getCache(bm.id)?.fail_reason ?? "")).toContain("crawl_failed");
  });

  it("includeSubfolders=false 只扫直接子级；limit 生效并返回剩余条数", async () => {
    env = makeEnv(scanLlm(), false, {
      crawlFetcher: async () => ({
        ok: true,
        status: 200,
        readBody: async () => Promise.resolve(Buffer.from(articleHtml)),
        dispose: () => undefined,
      }),
    });
    await ingest([
      { url: "https://child-d89.example.com/1", title: "子目录文章", folderPath: ["合集", "子集"] },
      { url: "https://top-d89.example.com/1", title: "顶层文章一", folderPath: ["合集"] },
      { url: "https://top-d89.example.com/2", title: "顶层文章二", folderPath: ["合集"] },
    ]);
    const tree = await folders();
    const root = tree.find((f) => f.name === "合集")!;

    const limited = await scanFolder(root.id, { includeSubfolders: false, limit: 1 });
    expect(limited.done.processed).toBe(1);
    expect(limited.done.remaining).toBeGreaterThanOrEqual(1);

    // 再跑一次：已入库的那条不再重复，剩余那条继续（子目录书签始终不在范围）
    const firstDoneId = limited.items[0]?.id
    const onlySelf = await scanFolder(root.id, { includeSubfolders: false });
    expect(onlySelf.items.every((i) => i.title !== "子目录文章")).toBe(true);
    expect(onlySelf.items.some((i) => i.id === firstDoneId)).toBe(false);
    expect(onlySelf.items.every((i) => i.status === "created")).toBe(true);
  });
});