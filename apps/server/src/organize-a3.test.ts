/** A3 事务/冲突/回滚/软归档验收：无部分提交 / 冲突不覆盖 / 合并恢复关联可用 */
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

async function propose(env: TestEnv, message: string): Promise<string> {
  const s = (await (
    await env.app.request("/api/v1/organize/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    })
  ).json()) as { sessionId: string };
  return s.sessionId;
}

describe("A3-3 事务化：中途异常无部分提交", () => {
  it("apply 内部抛错 → 整体回滚，目录/书签保持原状", async () => {
    env = makeEnv(null);
    await seed(env);
    const sessionId = await propose(env, "整理");

    // 注入故障：monkeypatch moveBookmark 在第 1 次 move 时抛错
    const store = env.store;
    const original = store.moveBookmark.bind(store);
    let calls = 0;
    store.moveBookmark = ((id: string, to: string) => {
      calls++;
      if (calls >= 1) throw new Error("injected failure");
      return original(id, to);
    }) as typeof store.moveBookmark;

    const before = store.listBookmarks({ limit: 100 }).map((b) => [b.id, b.folder_id]);
    await expect(
      env.app.request(`/api/v1/organize/sessions/${sessionId}/apply`, { method: "POST" }),
    ).resolves.toMatchObject({ status: 400 });

    const after = store.listBookmarks({ limit: 100 }).map((b) => [b.id, b.folder_id]);
    expect(after).toEqual(before); // 无半套修改
    // 会话仍处于 proposed（可重试），未写版本
    const sess = store.db
      .prepare("SELECT status FROM organize_session WHERE id = ?")
      .get(sessionId) as { status: string };
    expect(sess.status).toBe("proposed");
    expect(store.db.prepare("SELECT COUNT(*) as c FROM organize_version").get()).toMatchObject({ c: 0 });
  });
});

describe("A3-4 冲突检测：旧提案不覆盖新修改", () => {
  it("提案后用户手动移动过的书签 → apply 跳过并报告冲突", async () => {
    env = makeEnv(null);
    await seed(env);
    const sessionId = await propose(env, "整理");

    // 用户手动把 GitHub 仓库移到「我的收藏夹」（提案生成之后）
    const folders = env.store.listFolders();
    const target = env.store.createFolder("我的收藏夹", null, "user");
    const gh = env.store.listBookmarks({ limit: 100 }).find((b) => b.title === "GitHub 仓库")!;
    env.store.updateBookmark(gh.id, { folder_id: target.id }); // content_revision +1
    void folders;

    const res = (await (
      await env.app.request(`/api/v1/organize/sessions/${sessionId}/apply`, { method: "POST" })
    ).json()) as { applied: number; conflicts: Array<{ bookmarkId: string; reason: string }> };

    expect(res.conflicts.some((c) => c.bookmarkId === gh.id && c.reason === "modified_after_proposal")).toBe(true);
    // 用户的新修改未被覆盖
    expect(env.store.getBookmark(gh.id)?.folder_id).toBe(target.id);
  });

  it("回滚时遇到用户后来又移动过的项目 → 跳过不破坏", async () => {
    env = makeEnv(null);
    await seed(env);
    // apply 一个整理（GitHub → 开发）
    const s1 = await propose(env, "整理");
    const applied = (await (
      await env.app.request(`/api/v1/organize/sessions/${s1}/apply`, { method: "POST" })
    ).json()) as { versionId: string };
    // 用户手动再改：GitHub 仓库 → 新目录
    const target = env.store.createFolder("用户后改", null, "user");
    const gh = env.store.listBookmarks({ limit: 100 }).find((b) => b.title === "GitHub 仓库")!;
    env.store.updateBookmark(gh.id, { folder_id: target.id });

    const rb = (await (
      await env.app.request(`/api/v1/organize/rollback/${applied.versionId}`, { method: "POST" })
    ).json()) as { reversed: number; skipped: Array<{ bookmarkId: string }> };

    // 回滚不把用户后改的书签拽回去
    expect(env.store.getBookmark(gh.id)?.folder_id).toBe(target.id);
    void rb;
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

    const s = await propose(env, "合并重复");
    const applied = (await (
      await env.app.request(`/api/v1/organize/sessions/${s}/apply`, { method: "POST" })
    ).json()) as { versionId: string; applied: number };
    expect(applied.applied).toBe(1);

    // 软归档状态：列表不可见但行存在，正文保留
    const listIds = env.store.listBookmarks({ limit: 100 }).map((b) => b.id);
    expect(listIds).not.toContain(dupB.id);
    const row = env.store.getBookmark(dupB.id);
    expect(row?.archived_into).toBe(dupA.id);
    expect(env.store.getCache(dupB.id)?.l2_text).toBe("被合并方的正文"); // 正文未丢
    // 快照索引仍在、文件仍可读
    const snapDuring = await env.app.request(`/api/v1/snapshots/${up.id}`);
    expect(snapDuring.status).toBe(200);

    // 回滚：书签恢复可见，正文/快照全部在
    const rb = (await (
      await env.app.request(`/api/v1/organize/rollback/${applied.versionId}`, { method: "POST" })
    ).json()) as { reversed: number };
    expect(rb.reversed).toBeGreaterThan(0);
    const restored = env.store.getBookmark(dupB.id);
    expect(restored?.archived_into).toBeNull();
    expect(env.store.getCache(dupB.id)?.l2_text).toBe("被合并方的正文");
    const snapGet = await env.app.request(`/api/v1/snapshots/${up.id}`);
    expect(snapGet.status).toBe(200); // 快照仍可打开
  });

  it("私密属性在软归档合并/回滚全程保留", async () => {
    env = makeEnv(null);
    await seed(env);
    const all = env.store.listBookmarks({ limit: 100 });
    const dupB = all.find((b) => b.url_canonical.includes("x/two"))!;
    const dupA = all.find((b) => b.url_canonical.includes("x/one"))!;
    // 私密标记直接写库（绕过 updateBookmark 的 revision bump，等效历史数据）
    env.store.db.prepare("UPDATE bookmarks SET is_private = 1 WHERE id = ?").run(dupB.id);

    const s = await propose(env, "合并重复");
    const applied = (await (
      await env.app.request(`/api/v1/organize/sessions/${s}/apply`, { method: "POST" })
    ).json()) as { versionId: string };
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

    const s = await propose(env, "合并重复");
    const applied = (await (
      await env.app.request(`/api/v1/organize/sessions/${s}/apply`, { method: "POST" })
    ).json()) as { applied: number };
    expect(applied.applied).toBe(1);
    // 保留方 = id 字典序较小者（确定性），另一方软归档
    const sorted = [dupA.id, dupB.id].sort() as [string, string];
    const [first, second] = sorted;
    expect(env.store.getBookmark(first!)?.archived_into).toBeNull();
    expect(env.store.getBookmark(second!)?.archived_into).toBe(first);
  });
});
