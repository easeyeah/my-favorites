/**
 * D64 MCP 端点测试：JSON-RPC 分发、三工具语义（search/get/recent + tag 筛选）、
 * 工具级失败回 isError 而非协议错误、通知 202、未知方法 -32601。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeEnv, json, type TestEnv } from "./test-env";

let env: TestEnv;
const longText = "MCP 端到端验证正文。".repeat(30);

const rpc = async (body: Record<string, unknown>): Promise<Response> => {
  const res = await env.app.request("/api/v1/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
};

const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<{ result: Record<string, unknown>; isError?: boolean; text: string }> => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const out = (await json(res)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { result: out.result, isError: out.result.isError, text: out.result.content[0]?.text ?? "" };
};

beforeAll(async () => {
  env = makeEnv(null, true); // syncAi：物化/摘要链路请求内同步
  // 预置：一篇带标签的文章 + 一个视频
  const bm = (await (await env.app.request("/api/v1/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://mcp.example/blog/react-hooks", title: "React Hooks 深度指南" }),
  })).json()) as { id: string };
  await env.app.request("/api/v1/content/capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookmarkId: bm.id, l2Text: longText }),
  });
  env.store.upsertCache({
    bookmarkId: bm.id,
    l1Summary: "讲解 React Hooks 的使用模式与心智模型。",
    l1Tags: ["react", "前端"],
    keywords: [],
    fetchedVia: "extension_capture",
  });
  await env.app.request("/api/v1/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://www.bilibili.com/video/BV1mcpdemo1", title: "一个 MCP 测试视频" }),
  });
});

afterAll(() => env.cleanup());

describe("D64 MCP 端点（资料库 AI 消费面）", () => {
  it("initialize：回显受支持的协议版本 + tools 能力 + serverInfo", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    const out = (await json(res)) as { result: Record<string, unknown> };
    expect(out.result.protocolVersion).toBe("2025-03-26");
    expect(out.result.capabilities).toBeDefined();
    expect(out.result.serverInfo).toMatchObject({ name: "my-favorites-materials" });
    // 不受支持的版本回退到兜底版本（规范：协商失败用 server 最新）
    const res2 = await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    const out2 = (await json(res2)) as { result: { protocolVersion: string } };
    expect(out2.result.protocolVersion).toBe("2025-03-26");
  });

  it("通知（无 id）→ 202 空体；未知方法 → -32601", async () => {
    const notify = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notify.status).toBe(202);
    expect(await notify.text()).toBe("");
    const bad = await rpc({ jsonrpc: "2.0", id: 3, method: "resources/list" });
    expect(bad.status).toBe(405);
    const out = (await json(bad)) as { error: { code: number } };
    expect(out.error.code).toBe(-32601);
  });

  it("tools/list：三工具齐全且带 inputSchema", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const out = (await json(res)) as { result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> } };
    const names = out.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["materials_get", "materials_recent", "materials_search"]);
    for (const t of out.result.tools) expect(Object.keys(t.inputSchema)).toContain("properties");
  });

  it("materials_search：关键词命中 + type 过滤 + tag 精确筛选", async () => {
    const kw = await callTool("materials_search", { q: "React Hooks" });
    const kwData = JSON.parse(kw.text) as { count: number; materials: Array<Record<string, unknown>> };
    expect(kw.isError).toBeFalsy();
    expect(kwData.count).toBeGreaterThanOrEqual(1);
    const kwFirst = kwData.materials[0]!;
    expect(kwFirst.title).toContain("React Hooks");
    expect(kwFirst.tags).toContain("react");
    expect(kwFirst.has_full_text).toBe(true);

    const byType = await callTool("materials_search", { type: "video" });
    const byTypeData = JSON.parse(byType.text) as { materials: Array<Record<string, unknown>> };
    expect(byTypeData.materials.every((m) => m.type === "video")).toBe(true);

    const byTag = await callTool("materials_search", { tag: "react" });
    const byTagData = JSON.parse(byTag.text) as { materials: Array<Record<string, unknown>> };
    expect(byTagData.materials).toHaveLength(1);
    const miss = await callTool("materials_search", { tag: "不存在的标签" });
    expect((JSON.parse(miss.text) as { count: number }).count).toBe(0);
  });

  it("materials_get：返回已存全文；不存在的 id 回 isError 工具结果", async () => {
    const search = await callTool("materials_search", { q: "React Hooks" });
    const id = (JSON.parse(search.text) as { materials: Array<{ id: string }> }).materials[0]!.id;
    const got = await callTool("materials_get", { id });
    const data = JSON.parse(got.text) as { full_text: string | null; title: string };
    expect(got.isError).toBeFalsy();
    expect(data.title).toContain("React Hooks");
    expect(data.full_text).toBe(longText);

    const missing = await callTool("materials_get", { id: "no-such-id" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("not found");
  });

  it("materials_recent：counts 与列表齐备", async () => {
    const out = await callTool("materials_recent", { limit: 5 });
    const data = JSON.parse(out.text) as {
      counts: { total: number; article: number; video: number };
      materials: Array<Record<string, unknown>>;
    };
    expect(data.counts.total).toBeGreaterThanOrEqual(2);
    expect(data.materials.length).toBeLessThanOrEqual(5);
  });

  it("未知工具 → isError 工具结果（非协议错误）", async () => {
    const out = await callTool("no_such_tool", {});
    expect(out.isError).toBe(true);
    expect(out.text).toContain("unknown tool");
  });
});
