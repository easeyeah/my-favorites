/**
 * D76 整理 prompt 目录上下文回归：LLM 归类时必须拿到「目录完整路径 + 代表书签」，
 * 而非扁平目录名清单。旧实现只给名字，模型凭字面猜语义——原生远控客户端（需下载安装）
 * 被归进「在线工具」（名字像通用工具筐），而真正收录原生软件的系统类目录反被忽略。
 * 锁两件事：① prompt 含路径与代表书签；② 按样本语义归类能落到正确目录。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { LlmClient } from "@mf/ai/llm-client";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;

afterEach(() => {
  env?.cleanup();
  env = undefined as unknown as TestEnv;
});

const post = (path: string, body: unknown) =>
  env.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("D76 整理 prompt 目录上下文", () => {
  it("prompt 含目录完整路径与代表书签；远控客户端按样本语义归入系统目录而非在线工具", async () => {
    const seen: string[] = [];
    const llm = {
      chatJson: async (messages: Array<{ role: string; content: string }>) => {
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("摘要助手")) return { summary: "测试摘要", tags: [], keywords: [], category: ["其他"] };
        seen.push(sys);
        // 模拟模型按代表书签归纳语义后的正确判定：原生客户端 → 系统类目录
        return { results: [{ index: 0, category: "E07 系统", confidence: 0.9, material: false }] };
      },
    } as unknown as LlmClient;
    env = makeEnv(llm, true);

    // 两级目录体系 + 各自代表书签（在线工具=Web 应用；系统=原生软件）
    const e = (await (await post("/api/v1/folders", { name: "E 软件" })).json()) as { id: string };
    const tools = (await (await post("/api/v1/folders", { name: "E01 在线工具", parentId: e.id })).json()) as { id: string };
    const sys = (await (await post("/api/v1/folders", { name: "E07 系统", parentId: e.id })).json()) as { id: string };
    await post("/api/v1/bookmarks", { url: "https://webtool.example.com/a", title: "在线格式转换", folderId: tools.id });
    await post("/api/v1/bookmarks", { url: "https://native.example.com/b", title: "Ventoy 启动盘工具", folderId: sys.id });

    // 收纳盒条目：原生远程桌面客户端（无域名规则命中 → 走 LLM）
    const inbox = (await (await post("/api/v1/inbox/setup", {})).json()) as { id: string };
    const bm = (await (
      await post("/api/v1/bookmarks", { url: "https://remotego.example.com/app", title: "RemoteGo - 原生远程桌面客户端", folderId: inbox.id })
    ).json()) as { id: string };
    await post("/api/v1/inbox/process", { bookmarkIds: [bm.id] });

    expect(seen.length).toBeGreaterThan(0);
    const prompt = seen[0]!;
    // ★ 路径层级（旧实现只有扁平名 "E01 在线工具"，无父级语境）
    expect(prompt).toContain("E 软件/E01 在线工具");
    expect(prompt).toContain("E 软件/E07 系统");
    // ★ 代表书签（目录语义的内容证据）
    expect(prompt).toContain("在线格式转换");
    expect(prompt).toContain("Ventoy 启动盘工具");
    // ★ 归纳指引（不凭名字字面猜）
    expect(prompt).toContain("不要仅凭目录名字面猜测");
    // 收纳盒自身不出现在目录上下文（D51 豁免）
    expect(prompt).not.toContain("收纳盒");

    // 归类落地：进系统目录（代表书签含原生软件），而非在线工具
    const detail = (await (await env.app.request(`/api/v1/bookmarks/${bm.id}`)).json()) as { folder_id: string };
    expect(detail.folder_id).toBe(sys.id);
  });

  it("空目录标注（空目录）；代表书签排除已归档条目", async () => {
    const seen: string[] = [];
    const llm = {
      chatJson: async (messages: Array<{ role: string; content: string }>) => {
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("摘要助手")) return { summary: "测试摘要", tags: [], keywords: [], category: ["其他"] };
        seen.push(sys);
        return { results: [{ index: 0, category: "空筐", confidence: 0.9, material: false }] };
      },
    } as unknown as LlmClient;
    env = makeEnv(llm, true);

    const empty = (await (await post("/api/v1/folders", { name: "空筐" })).json()) as { id: string };
    const box = (await (await post("/api/v1/folders", { name: "归档筐" })).json()) as { id: string };
    const archived = (await (
      await post("/api/v1/bookmarks", { url: "https://gone.example.com/x", title: "已归档不应出现", folderId: box.id })
    ).json()) as { id: string };
    await env.app.request(`/api/v1/bookmarks/${archived.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });

    const inbox = (await (await post("/api/v1/inbox/setup", {})).json()) as { id: string };
    const bm = (await (
      await post("/api/v1/bookmarks", { url: "https://newitem.example.com/y", title: "待归位条目", folderId: inbox.id })
    ).json()) as { id: string };
    await post("/api/v1/inbox/process", { bookmarkIds: [bm.id] });

    const prompt = seen[0]!;
    expect(prompt).toContain("空筐：（空目录）");
    expect(prompt).not.toContain("已归档不应出现");
    expect(empty.id).toBeTruthy();
  });
});