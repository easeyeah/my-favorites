/**
 * D79 同步加固回归：
 *  - create 绑定既有 URL 尊重浏览器侧目录（旧：保留库内旧目录 → 两侧永久分叉）；
 *  - ifInbox 守卫取消（仅仍在盒内才允许删，已归位 409 保留——防归位竞态误删）；
 *  - identities 单节点反查（盒内删除取消用）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;

afterEach(() => {
  env?.cleanup();
  env = undefined as unknown as TestEnv;
});

const post = (p: string, body: unknown) =>
  env.app.request(p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("D79 同步加固", () => {
  it("create 绑定既有 URL → 跟随浏览器目录移动（不再保留库内旧目录）", async () => {
    env = makeEnv(null);
    const a = (await (await post("/api/v1/folders", { name: "A目录" })).json()) as { id: string };
    const bm = (await (
      await post("/api/v1/bookmarks", { url: "https://bind.example.com/x", title: "绑定测试", folderId: a.id })
    ).json()) as { id: string };
    const res = await post("/api/v1/sync/apply", {
      deviceId: "dev-bind",
      mutations: [{ kind: "bookmark.create", browserId: "n1", url: "https://bind.example.com/x", title: "绑定测试", folderPath: ["B目录"] }],
    });
    const out = (await res.json()) as { results: Array<{ status: string; appBookmarkId: string }> };
    expect(out.results[0]!.status).toBe("bound");
    const after = env.store.getBookmark(bm.id)!;
    expect(after.folder_id).not.toBe(a.id); // ★ 旧实现：留在 A目录 → 浏览器 B/库 A 永久分叉
    expect(env.store.getFolder(after.folder_id)?.name).toBe("B目录");
    expect(env.store.findAppBookmarkId("dev-bind", "n1")).toBe(bm.id);
  });

  it("ifInbox 取消：盒内条目可删；已归位条目 409 保留", async () => {
    env = makeEnv(null);
    const inbox = (await (await post("/api/v1/inbox/setup", {})).json()) as { id: string };
    const pending = (await (
      await post("/api/v1/bookmarks", { url: "https://cancel.example.com/x", title: "待取消", folderId: inbox.id })
    ).json()) as { id: string };
    const f = (await (await post("/api/v1/folders", { name: "已归位目录" })).json()) as { id: string };
    const placed = (await (
      await post("/api/v1/bookmarks", { url: "https://cancel.example.com/y", title: "已归位", folderId: f.id })
    ).json()) as { id: string };

    const r1 = await env.app.request(`/api/v1/bookmarks/${placed.id}?ifInbox=1`, { method: "DELETE" });
    expect(r1.status).toBe(409); // 竞态守卫：已归位不得按「盒内取消」删
    expect(env.store.getBookmark(placed.id)).toBeTruthy();

    const r2 = await env.app.request(`/api/v1/bookmarks/${pending.id}?ifInbox=1`, { method: "DELETE" });
    expect(r2.status).toBe(200);
    expect(env.store.getBookmark(pending.id)).toBeUndefined();
  });

  it("ensurePath 根级匹配悬空父目录（不重复建同名根目录）", async () => {
    env = makeEnv(null);
    // parentId:"1" 是浏览器根约定，库内无 id=1 → 悬空父；扩展路径构造视同根级
    const f = (await (await post("/api/v1/folders", { name: "悬空根", parentId: "1" })).json()) as { id: string };
    const out = env.store.ensurePath(["悬空根"]);
    expect(out.id).toBe(f.id); // ★ 旧实现：parent_id IS NULL 匹配落空 → 重复建目录
    expect(env.store.listFolders().filter((x) => x.name === "悬空根").length).toBe(1);
  });

  it("identities browserId 单节点反查", async () => {
    env = makeEnv(null);
    await post("/api/v1/sync/apply", {
      deviceId: "dev-idn",
      mutations: [{ kind: "bookmark.create", browserId: "n77", url: "https://idn.example.com/z", title: "t", folderPath: [] }],
    });
    const r = await env.app.request("/api/v1/browser/identities?deviceId=dev-idn&browserId=n77");
    const out = (await r.json()) as { identities: Array<{ browser_bookmark_id: string }> };
    expect(out.identities.length).toBe(1);
    expect(out.identities[0]!.browser_bookmark_id).toBe("n77");
  });
});