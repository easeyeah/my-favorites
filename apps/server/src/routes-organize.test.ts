/** F3 聊天整理：proposal → apply → rollback 全链路 + 红线（不静默改动） */
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

describe("整理会话（F3）", () => {
  it("重新分类：规则命中产生 move 提案，未确认前原目录不变（红线：不静默改动）", async () => {
    env = makeEnv(null); // 无 LLM：只有规则信号
    await seedBookmarks(env);

    const session = (await (
      await env.app.request("/api/v1/organize/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "重新分类" }),
      })
    ).json()) as { sessionId: string; status: string; proposal: Array<{ type: string; toFolder?: string }> };

    expect(session.status).toBe("proposed");
    const move = session.proposal.find((p) => p.type === "move");
    expect(move?.toFolder).toBe("开发");

    // apply 前书签仍在原目录
    const before = (await (await env.app.request("/api/v1/bookmarks")).json()) as Array<{
      title: string;
      folder_id: string;
    }>;
    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{
      id: string;
      name: string;
    }>;
    const misc = folders.find((f) => f.name === "杂项");
    expect(before.filter((b) => b.title === "GitHub 仓库").every((b) => b.folder_id === misc?.id)).toBe(true);
  });

  it("apply 落库 + rollback 完整还原（含合并重插）", async () => {
    env = makeEnv(null);
    await seedBookmarks(env);

    // ① 分类提案并应用
    const session = (await (
      await env.app.request("/api/v1/organize/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "整理" }),
      })
    ).json()) as { sessionId: string };
    const applied = (await (
      await env.app.request(`/api/v1/organize/sessions/${session.sessionId}/apply`, { method: "POST" })
    ).json()) as { versionId: string; applied: number };
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

    // ② 合并重复
    const mergeSession = (await (
      await env.app.request("/api/v1/organize/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "合并重复" }),
      })
    ).json()) as { sessionId: string; proposal: Array<{ type: string }> };
    expect(mergeSession.proposal.some((p) => p.type === "merge")).toBe(true);
    const mergeApplied = (await (
      await env.app.request(`/api/v1/organize/sessions/${mergeSession.sessionId}/apply`, { method: "POST" })
    ).json()) as { versionId: string };
    const afterMerge = (await (await env.app.request("/api/v1/bookmarks")).json()) as unknown[];
    expect(afterMerge.length).toBe(4); // 5 - 1 dup

    // ③ 合并回滚：被删书签重插
    const rb = (await (
      await env.app.request(`/api/v1/organize/rollback/${mergeApplied.versionId}`, { method: "POST" })
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

    const session = (await (
      await env.app.request("/api/v1/organize/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "整理" }),
      })
    ).json()) as { sessionId: string };
    // rollback 前记住每个书签的位置（apply 之前的原始状态）
    const before = (await (await env.app.request("/api/v1/bookmarks")).json()) as Array<{
      id: string;
      folder_id: string;
      title: string;
    }>;
    const applied = (await (
      await env.app.request(`/api/v1/organize/sessions/${session.sessionId}/apply`, { method: "POST" })
    ).json()) as { versionId: string };
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

  it("自由对话返回指引（无 proposal）", async () => {
    env = makeEnv(null);
    const res = await env.app.request("/api/v1/organize/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "你好" }),
    });
    const body = (await res.json()) as { status: string; proposal: null };
    expect(body.status).toBe("answered");
    expect(body.proposal).toBeNull();
  });

  it("重复 apply 拒绝（乐观锁：已应用会话不能再应用）", async () => {
    env = makeEnv(null);
    await seedBookmarks(env);
    const session = (await (
      await env.app.request("/api/v1/organize/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "整理" }),
      })
    ).json()) as { sessionId: string };
    await env.app.request(`/api/v1/organize/sessions/${session.sessionId}/apply`, { method: "POST" });
    const again = await env.app.request(`/api/v1/organize/sessions/${session.sessionId}/apply`, {
      method: "POST",
    });
    expect(again.status).toBe(400);
  });
});
