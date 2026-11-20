/** F3 整理（D27 act + undo）：一次调用直接生效 + rollback 完整还原；旧确认流端点已移除 */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

async function seedBookmarks(env: TestEnv) {
  await env.app.request("/api/v1/bookmarks/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "seed-org",
      items: [
        { url: "https://unknown-1.com/a", title: "页面 A", folderPath: ["杂项"] },
        { url: "https://unknown-2.com/b", title: "页面 B", folderPath: ["杂项"] },
        { url: "https://github.com/repo", title: "GitHub 仓库", folderPath: ["杂项"] },
        // 近重复组：同域同名、URL 不同（canonical UNIQUE 下库内真实的重复形态）
        { url: "https://dup.example.com/x/one", title: "重复页", folderPath: ["杂项"] },
        { url: "https://dup.example.com/x/two", title: "重复页", folderPath: ["杂项"] },
      ],
    }),
  });
}

interface RunResult {
  sessionId: string;
  status: string;
  answer: string;
  actions: Array<{ type: string; toFolder?: string }> | null;
  versionId?: string;
  applied?: number;
}

async function run(env: TestEnv, message: string): Promise<RunResult> {
  return (await (
    await env.app.request("/api/v1/organize/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    })
  ).json()) as RunResult;
}

describe("整理一次调用直接生效（F3 / D27）", () => {
  it("重新分类：规则命中 → 直接归位 + 返回只读明细与版本", async () => {
    env = makeEnv(null); // 无 LLM：只有规则信号
    await seedBookmarks(env);

    const result = await run(env, "重新分类");
    expect(result.status).toBe("applied");
    expect(result.versionId).toBeTruthy();
    expect(result.applied).toBeGreaterThan(0);
    // 只读明细（事后呈现，不再是确认卡）：含 GitHub → 开发
    const move = result.actions?.find((a) => a.type === "move");
    expect(move?.toFolder).toBe("开发");

    // 书签已实际挪动（无确认流）
    const bookmarks = (await (await env.app.request("/api/v1/bookmarks")).json()) as Array<{
      title: string;
      folder_id: string;
    }>;
    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{
      id: string;
      name: string;
    }>;
    const dev = folders.find((f) => f.name === "开发");
    const gh = bookmarks.find((b) => b.title === "GitHub 仓库");
    expect(gh?.folder_id).toBe(dev?.id);
  });

  it("合并重复直接生效（软归档）+ rollback 完整还原（含合并重插）", async () => {
    env = makeEnv(null);
    await seedBookmarks(env);

    // ① 分类直接生效
    const applied = await run(env, "整理");
    expect(applied.applied).toBeGreaterThan(0);
    const bookmarks = (await (await env.app.request("/api/v1/bookmarks")).json()) as Array<{
      title: string;
      folder_id: string;
    }>;
    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{
      id: string;
      name: string;
    }>;
    const dev = folders.find((f) => f.name === "开发");
    const gh = bookmarks.find((b) => b.title === "GitHub 仓库");
    expect(gh?.folder_id).toBe(dev?.id);

    // ② 合并重复（D28：直接移除重复副本，7 天版本恢复）
    const merge = await run(env, "合并重复");
    expect(merge.status).toBe("applied");
    expect(merge.actions?.some((a) => a.type === "merge")).toBe(true);
    const afterMerge = (await (await env.app.request("/api/v1/bookmarks")).json()) as unknown[];
    expect(afterMerge.length).toBe(4); // 5 - 1 dup

    // ③ 合并回滚：被删书签重插
    const rb = (await (
      await env.app.request(`/api/v1/organize/rollback/${merge.versionId}`, { method: "POST" })
    ).json()) as { reversed: number };
    expect(rb.reversed).toBeGreaterThan(0);
    const afterRollback = (await (await env.app.request("/api/v1/bookmarks")).json()) as unknown[];
    expect(afterRollback.length).toBe(5);
  });

  it("分类回滚：书签回到原目录", async () => {
    env = makeEnv(null);
    await seedBookmarks(env);
    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{
      id: string;
      name: string;
    }>;
    const misc = folders.find((f) => f.name === "杂项");

    // rollback 前记住每个书签的位置（整理之前的原始状态）
    const before = (await (await env.app.request("/api/v1/bookmarks")).json()) as Array<{
      id: string;
      folder_id: string;
      title: string;
    }>;
    const applied = await run(env, "整理");
    const rb = (await (
      await env.app.request(`/api/v1/organize/rollback/${applied.versionId}`, { method: "POST" })
    ).json()) as { reversed: number };
    expect(rb.reversed).toBeGreaterThan(0);
    const after = (await (await env.app.request("/api/v1/bookmarks")).json()) as Array<{
      id: string;
      folder_id: string;
      title: string;
    }>;
    for (const b of before) {
      const restored = after.find((x) => x.id === b.id);
      expect(restored?.folder_id).toBe(b.folder_id);
    }
    // GitHub 仓库回到 杂项
    const gh = after.find((b) => b.title === "GitHub 仓库");
    expect(gh?.folder_id).toBe(misc?.id);
  });

  it("自由对话返回指引（无动作、不生效）", async () => {
    env = makeEnv(null);
    const body = await run(env, "你好");
    expect(body.status).toBe("answered");
    expect(body.actions).toBeNull();
    expect(body.versionId).toBeUndefined();
  });

  it("旧确认流端点已移除：/organize/sessions/:id/apply → 404（切片 A 验收）", async () => {
    env = makeEnv(null);
    await seedBookmarks(env);
    const res = await env.app.request(`/api/v1/organize/sessions/whatever/apply`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
