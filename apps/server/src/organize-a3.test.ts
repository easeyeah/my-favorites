/** A3 事务/冲突/回滚/软归档验收：无部分提交 / 回滚不破坏用户后改 / 合并恢复关联可用 */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

async function seed(env: TestEnv) {
  await env.app.request("/api/v1/bookmarks/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "a3-seed-01",
      items: [
        { url: "https://unknown-a3-1.com/a", title: "页面 A", folderPath: ["杂项"] },
        { url: "https://github.com/a3/repo", title: "GitHub 仓库", folderPath: ["杂项"] },
        { url: "https://dup-a3.example.com/x/one", title: "重复页", folderPath: ["杂项"] },
        { url: "https://dup-a3.example.com/x/two", title: "重复页", folderPath: ["杂项"] },
      ],
    }),
  });
}

/** D27：整理 = 一次调用直接生效；返回完整结果（含版本） */
async function run(env: TestEnv, message: string): Promise<{
  sessionId: string;
  status: string;
  versionId?: string;
  applied?: number;
  conflicts?: Array<{ bookmarkId: string; reason: string }>;
}> {
  return (await (
    await env.app.request("/api/v1/organize/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    })
  ).json()) as { sessionId: string; status: string; versionId?: string; applied?: number };
}

describe("A3-3 事务化：中途异常无部分提交", () => {
  it("提交内核抛错 → 整体回滚，目录/书签保持原状，不写版本", async () => {
    env = makeEnv(null);
    await seed(env);

    // 注入故障：monkeypatch moveBookmark 在第 1 次 move 时抛错（D27：提交在调用内发生）
    const store = env.store;
    const original = store.moveBookmark.bind(store);
    let calls = 0;
    store.moveBookmark = ((id: string, to: string) => {
      calls++;
      if (calls >= 1) throw new Error("injected failure");
      return original(id, to);
    }) as typeof store.moveBookmark;

    const before = store.listBookmarks({ limit: 100 }).map((b) => [b.id, b.folder_id]);
    const res = await env.app.request("/api/v1/organize/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "整理" }),
    });
    expect(res.status).toBe(500);

    const after = store.listBookmarks({ limit: 100 }).map((b) => [b.id, b.folder_id]);
    expect(after).toEqual(before); // 无半套修改
    // 会话保留计划（proposed）但未写版本；下一次整理重新计划，无残留生效
    expect(store.db.prepare("SELECT COUNT(*) as c FROM organize_version").get()).toMatchObject({ c: 0 });
  });
});

describe("A3-4 撤销安全网：回滚不覆盖用户后改", () => {
  it("整理生效后用户手动移动过的书签 → 回滚跳过不破坏", async () => {
    env = makeEnv(null);
    await seed(env);
    // 整理一次（GitHub → 开发）
    const applied = await run(env, "整理");
    expect(applied.versionId).toBeTruthy();
    // 用户手动再改：GitHub 仓库 → 新目录
    const target = env.store.createFolder("用户后改", null, "user");
    const gh = env.store.listBookmarks({ limit: 100 }).find((b) => b.title === "GitHub 仓库")!;
    env.store.updateBookmark(gh.id, { folder_id: target.id });

    const rb = (await (
      await env.app.request(`/api/v1/organize/rollback/${applied.versionId}`, { method: "POST" })
    ).json()) as { reversed: number; skipped: Array<{ bookmarkId: string }> };

    // 回滚不把用户后改的书签拽回去
    expect(env.store.getBookmark(gh.id)?.folder_id).toBe(target.id);
    expect(rb.skipped.some((s) => s.bookmarkId === gh.id)).toBe(true);
  });
});

describe("A3-5 软归档合并：正文/快照/隐私属性保留，回滚后可用", () => {
  it("合并 → 回滚：content_cache 与 snapshot 关联全程可用", async () => {
    env = makeEnv(null);
    await seed(env);
    const all = env.store.listBookmarks({ limit: 100 });
    const dupB = all.find((b) => b.url_canonical.includes("x/two"))!;
    const dupA = all.find((b) => b.url_canonical.includes("x/one"))!;
    // added_at 确定化：dupA 更早 → 保留方必为 dupA，被合并方必为 dupB
    // （直接 UPDATE 不经 updateBookmark，避免 content_revision bump 影响冲突检测）
    env.store.db
      .prepare("UPDATE bookmarks SET added_at = ? WHERE id = ?")
      .run("2026-11-16T00:00:00.000Z", dupA.id);
    env.store.db
      .prepare("UPDATE bookmarks SET added_at = ? WHERE id = ?")
      .run("2026-11-17T00:00:00.000Z", dupB.id);

    // 被合并方有正文 + 快照（非私密书签：私密书签快照被 A1-3 正确拒绝，单独路径验证）
    env.store.upsertCache({ bookmarkId: dupB.id, l2Text: "被合并方的正文", fetchedVia: "extension_capture" });
    const up = (await (
      await env.app.request(`/api/v1/snapshots?bookmarkId=${dupB.id}`, {
        method: "POST",
        headers: { "content-type": "message/rfc822" },
        body: 'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="x"\r\n\r\n<body>',
      })
    ).json()) as { id: string };
    expect(up.id).toBeTruthy();

    // D28：合并重复直接生效（直接移除重复副本，软归档保留 7 天恢复窗口）
    const applied = await run(env, "合并重复");
    expect(applied.status).toBe("applied");
    expect(applied.applied).toBe(1);

    // 软归档状态：列表不可见但行存在，正文保留
    const listIds = env.store.listBookmarks({ limit: 100 }).map((b) => b.id);
    expect(listIds).not.toContain(dupB.id);
    const row = env.store.getBookmark(dupB.id);
    expect(row?.archived_into).toBe(dupA.id);
    expect(env.store.getCache(dupB.id)?.l2_text).toBe("被合并方的正文"); // 正文未丢
    // 快照索引仍在、文件仍可读
    const snapDuring = await env.app.request(`/api/v1/snapshots/${up.id}/download`);
    expect(snapDuring.status).toBe(200); // DEV-02：受控下载读回（旧直读已封堵）

    // 回滚：书签恢复可见，正文/快照全部在
    const rb = (await (
      await env.app.request(`/api/v1/organize/rollback/${applied.versionId}`, { method: "POST" })
    ).json()) as { reversed: number };
    expect(rb.reversed).toBeGreaterThan(0);
    const restored = env.store.getBookmark(dupB.id);
    expect(restored?.archived_into).toBeNull();
    expect(env.store.getCache(dupB.id)?.l2_text).toBe("被合并方的正文");
    const snapGet = await env.app.request(`/api/v1/snapshots/${up.id}/download`);
    expect(snapGet.status).toBe(200); // 快照仍可打开（受控下载）
  });

  it("私密属性在软归档合并/回滚全程保留", async () => {
    env = makeEnv(null);
    await seed(env);
    const all = env.store.listBookmarks({ limit: 100 });
    const dupB = all.find((b) => b.url_canonical.includes("x/two"))!;
    const dupA = all.find((b) => b.url_canonical.includes("x/one"))!;
    // 私密标记直接写库（绕过 updateBookmark 的 revision bump，等效历史数据）
    env.store.db.prepare("UPDATE bookmarks SET is_private = 1 WHERE id = ?").run(dupB.id);

    const applied = await run(env, "合并重复");
    expect(env.store.getBookmark(dupB.id)?.is_private).toBe(1); // 软归档未丢私密属性

    await env.app.request(`/api/v1/organize/rollback/${applied.versionId}`, { method: "POST" });
    expect(env.store.getBookmark(dupB.id)?.is_private).toBe(1); // 回滚后仍在
    void dupA;
  });

  it("同毫秒创建的重复组：合并保留方确定（id 稳定决胜）", async () => {
    env = makeEnv(null);
    await seed(env);
    const all = env.store.listBookmarks({ limit: 100 });
    const dupA = all.find((b) => b.url_canonical.includes("x/one"))!;
    const dupB = all.find((b) => b.url_canonical.includes("x/two"))!;
    // 强制同毫秒 added_at
    env.store.db
      .prepare("UPDATE bookmarks SET added_at = '2026-11-17T00:00:00.000Z' WHERE id IN (?, ?)")
      .run(dupA.id, dupB.id);

    const applied = await run(env, "合并重复");
    expect(applied.applied).toBe(1);
    // 保留方 = id 字典序较小者（确定性），另一方软归档
    const sorted = [dupA.id, dupB.id].sort() as [string, string];
    const [first, second] = sorted;
    expect(env.store.getBookmark(first!)?.archived_into).toBeNull();
    expect(env.store.getBookmark(second!)?.archived_into).toBe(first);
  });
});
