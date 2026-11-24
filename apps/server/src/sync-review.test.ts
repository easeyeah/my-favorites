/**
 * D81 复核清单（docs/同步整改复核清单-D81.md）服务端回归：
 *  - SYNC-R03 绑定既有书签使用最终目录身份；身份优先于路径回退
 *  - SYNC-R04 跨根移动更新 root（含子树）；同父异根不是 noop
 *  - SYNC-R05 成功回执返回最新实体与修订号；合并 update；move 载荷带修订；目录 rev 冲突检测
 *  - skipped 错误码可分类（终态 / 可重试）
 *
 * 用例先于修复编写：在修复前的工作区上运行，逐条对应失败（证据见复核清单交付记录）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { INBOX_FOLDER_TITLE } from "@mf/shared";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

const DEV = "device-rev-0001";
const OTHER = "device-rev-0002";

interface Res {
  kind: string;
  browserId?: string;
  appBookmarkId?: string;
  appFolderId?: string;
  status: string;
  error?: string;
  entity?: Record<string, unknown>;
  current?: unknown;
}

async function apply(mutations: unknown[], deviceId = DEV) {
  const res = await env.app.request("/api/v1/sync/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, mutations }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { results: Res[]; cursor: number };
}

async function pull(cursor: number, device = OTHER) {
  const res = await env.app.request(`/api/v1/sync/pull?cursor=${cursor}&device=${device}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { items: Array<{ id: number; entity: string; entity_id: string; op: string; payload: unknown }> };
}

const mkFolder = (name: string, parentId: string | null = null, root = "bar") => env.store.createFolder(name, parentId, "user", false, root);
const mkBookmark = (url: string, folderId: string, title: string) =>
  env.store.createBookmark({ folderId, urlRaw: url, urlCanonical: url, title });
const revOf = (appId: string) => env.store.getBookmark(appId)?.content_revision ?? 0;
const fRev = (fid: string) => env.store.getFolder(fid)?.rev ?? 0;

describe("SYNC-R03 绑定既有书签使用最终目录身份", () => {
  it("库中 URL 在 A，浏览器在已绑定的 B 新增同 URL 节点 → 落点 / 回执 / 目录身份均为 B", async () => {
    env = makeEnv();
    const A = mkFolder("A");
    const B = mkFolder("B");
    const bm = mkBookmark("https://r03.example/x", A.id, "X");
    const fc = await apply([{ kind: "folder.create", name: "B", browserFolderId: "bf-B", parentBrowserFolderId: "1" }]);
    expect(fc.results[0]!.appFolderId).toBe(B.id);
    const r = await apply([
      { kind: "bookmark.create", browserId: "n-1", url: "https://r03.example/x", title: "X", folderPath: ["B"], folderRoot: "bar", browserFolderId: "bf-B" },
    ]);
    expect(r.results[0]!.status).toBe("bound");
    expect(env.store.getBookmark(bm.id)?.folder_id).toBe(B.id); // 实际落点
    expect(r.results[0]!.appFolderId).toBe(B.id); // 回执
    expect(r.results[0]!.entity?.folder_id).toBe(B.id); // 回执实体
    expect(env.store.findAppFolderId(DEV, "bf-B")).toBe(B.id); // 目录身份
    expect(env.store.findAppFolderId(DEV, "bf-B")).not.toBe(A.id);
    // 后续改名 B 不作用于 A
    await apply([{ kind: "folder.rename", appFolderId: B.id, name: "B2", browserFolderId: "bf-B" }]);
    expect(env.store.getFolder(A.id)?.name).toBe("A");
    expect(env.store.getFolder(B.id)?.name).toBe("B2");
    // 请求重放不改变已经正确的目录身份
    await apply([
      { kind: "bookmark.create", browserId: "n-1", url: "https://r03.example/x", title: "X", folderPath: ["B"], folderRoot: "bar", browserFolderId: "bf-B" },
    ]);
    expect(env.store.findAppFolderId(DEV, "bf-B")).toBe(B.id);
  });

  it("浏览器目录已绑定身份时，路径回退解析到的同名目录不得改绑（身份优先）", async () => {
    env = makeEnv();
    const P1 = mkFolder("P1");
    const P2 = mkFolder("P2");
    const B1 = mkFolder("工具", P1.id);
    const B2 = mkFolder("工具", P2.id);
    await apply([{ kind: "folder.create", name: "工具", browserFolderId: "bf-X", parentBrowserFolderId: "1", parentPath: ["P2"], root: "bar" }]);
    expect(env.store.findAppFolderId(DEV, "bf-X")).toBe(B2.id);
    // 路径解析指向 P1/工具（B1），身份指向 B2 → 以身份为准
    const r = await apply([
      { kind: "bookmark.create", browserId: "n-2", url: "https://r03b.example/x", title: "X", folderPath: ["P1", "工具"], folderRoot: "bar", browserFolderId: "bf-X" },
    ]);
    const appId = r.results[0]!.appBookmarkId!;
    expect(r.results[0]!.appFolderId).toBe(B2.id);
    expect(env.store.getBookmark(appId)?.folder_id).toBe(B2.id);
    expect(env.store.findAppFolderId(DEV, "bf-X")).toBe(B2.id);
    // folder.create 重放：已绑定身份 → bound，不改绑、不新建
    const fc = await apply([{ kind: "folder.create", name: "工具", browserFolderId: "bf-X", parentBrowserFolderId: "1", parentPath: ["P1"], root: "bar" }]);
    expect(fc.results[0]!.status).toBe("bound");
    expect(fc.results[0]!.appFolderId).toBe(B2.id);
    expect(env.store.findAppFolderId(DEV, "bf-X")).toBe(B2.id);
    expect(env.store.listFolders().filter((f) => f.name === "工具").length).toBe(2);
    void P1;
    void B1;
  });
});

describe("SYNC-R04 跨根移动更新 root", () => {
  it("bar → other → bar：目录 ID 不变，root 随之更新；同父异根不是 noop", async () => {
    env = makeEnv();
    const c = await apply([{ kind: "folder.create", name: "R4", browserFolderId: "bf-r4", parentBrowserFolderId: "1", root: "bar" }]);
    const fid = c.results[0]!.appFolderId!;
    expect(env.store.getFolder(fid)?.root).toBe("bar");
    const m1 = await apply([{ kind: "folder.move", appFolderId: fid, browserFolderId: "bf-r4", toBrowserFolderId: "2", root: "other" }]);
    expect(m1.results[0]!.status).toBe("ok");
    expect(env.store.getFolder(fid)?.root).toBe("other");
    expect(env.store.getFolder(fid)?.id).toBe(fid);
    expect(m1.results[0]!.entity?.root).toBe("other");
    // 变更事件带更新后的根归属
    const p = await pull(0);
    const ev = p.items.find((i) => i.entity === "folder" && i.op === "move");
    expect(ev).toBeTruthy();
    expect((ev!.payload as { root?: string }).root).toBe("other");
    expect(typeof (ev!.payload as { rev?: number }).rev).toBe("number");
    const m2 = await apply([{ kind: "folder.move", appFolderId: fid, browserFolderId: "bf-r4", toBrowserFolderId: "1", root: "bar" }]);
    expect(m2.results[0]!.status).toBe("ok");
    expect(env.store.getFolder(fid)?.root).toBe("bar");
    // 同父同根 → noop，不产生变更
    const maxBefore = env.store.maxChangeId();
    const m3 = await apply([{ kind: "folder.move", appFolderId: fid, browserFolderId: "bf-r4", toBrowserFolderId: "1", root: "bar" }]);
    expect(m3.results[0]!.status).toBe("noop");
    expect(env.store.maxChangeId()).toBe(maxBefore);
  });

  it("嵌套子树跨根移动 → 子孙 root 事务内一致更新，书签归属不变", async () => {
    env = makeEnv();
    const parent = await apply([{ kind: "folder.create", name: "父", browserFolderId: "bf-p", parentBrowserFolderId: "1" }]);
    const child = await apply([{ kind: "folder.create", name: "子", browserFolderId: "bf-c", parentBrowserFolderId: "bf-p" }]);
    const grand = await apply([{ kind: "folder.create", name: "孙", browserFolderId: "bf-g", parentBrowserFolderId: "bf-c" }]);
    const bm = await apply([
      { kind: "bookmark.create", browserId: "n-g", url: "https://r04.example/g", title: "G", folderPath: ["父", "子"], folderRoot: "bar", browserFolderId: "bf-c" },
    ]);
    await apply([{ kind: "folder.move", appFolderId: parent.results[0]!.appFolderId, browserFolderId: "bf-p", toBrowserFolderId: "2", root: "other" }]);
    for (const r of [parent, child, grand]) {
      expect(env.store.getFolder(r.results[0]!.appFolderId!)?.root).toBe("other");
    }
    expect(env.store.getBookmark(bm.results[0]!.appBookmarkId!)?.folder_id).toBe(child.results[0]!.appFolderId);
  });

  it("两根下已有同名目录时，移动按身份作用于正确目录", async () => {
    env = makeEnv();
    const barTwin = await apply([{ kind: "folder.create", name: "同名", browserFolderId: "bf-bar", parentBrowserFolderId: "1", root: "bar" }]);
    const otherTwin = await apply([{ kind: "folder.create", name: "同名", browserFolderId: "bf-other", parentBrowserFolderId: "2", root: "other" }]);
    const barId = barTwin.results[0]!.appFolderId!;
    const otherId = otherTwin.results[0]!.appFolderId!;
    expect(barId).not.toBe(otherId);
    const mv = await apply([{ kind: "folder.move", browserFolderId: "bf-other", toBrowserFolderId: "1", root: "bar" }]);
    expect(mv.results[0]!.status).toBe("ok");
    expect(env.store.getFolder(otherId)).toMatchObject({ id: otherId, root: "bar", parent_id: null });
    expect(env.store.getFolder(barId)?.root).toBe("bar");
    expect(env.store.findAppFolderId(DEV, "bf-other")).toBe(otherId);
    expect(env.store.findAppFolderId(DEV, "bf-bar")).toBe(barId);
  });
});

describe("SYNC-R05 修订号与成功回执闭环", () => {
  it("成功回执返回最新实体与修订号；改标题+移目录合并为一次提交；noop 亦带实体", async () => {
    env = makeEnv();
    const A = mkFolder("A");
    const B = mkFolder("B");
    const c = await apply([{ kind: "bookmark.create", browserId: "n-5", url: "https://r05.example/x", title: "T0", folderPath: ["A"] }]);
    const appId = c.results[0]!.appBookmarkId!;
    expect(c.results[0]!.entity).toMatchObject({ id: appId, title: "T0", folder_id: A.id, content_revision: revOf(appId) });
    const u = await apply([{ kind: "bookmark.update", browserId: "n-5", title: "T1", folderId: B.id, baseRevision: revOf(appId) }]);
    expect(u.results[0]!.status).toBe("ok");
    expect(env.store.getBookmark(appId)).toMatchObject({ title: "T1", folder_id: B.id });
    expect(u.results[0]!.entity).toMatchObject({ id: appId, title: "T1", folder_id: B.id, content_revision: revOf(appId) });
    expect(revOf(appId)).toBeGreaterThan(c.results[0]!.entity!.content_revision as number);
    // 旧修订再提交 → conflict，不覆盖
    const stale = await apply([{ kind: "bookmark.update", browserId: "n-5", title: "T-stale", folderId: A.id, baseRevision: revOf(appId) - 2 }]);
    expect(stale.results[0]!.status).toBe("conflict");
    expect(env.store.getBookmark(appId)).toMatchObject({ title: "T1", folder_id: B.id });
    const noop = await apply([{ kind: "bookmark.update", browserId: "n-5", title: "T1", baseRevision: revOf(appId) }]);
    expect(noop.results[0]!.status).toBe("noop");
    expect(noop.results[0]!.entity).toMatchObject({ id: appId, title: "T1", folder_id: B.id });
  });

  it("目标目录按身份优先解析（browserFolderId），身份缺失退路径", async () => {
    env = makeEnv();
    const A = mkFolder("A");
    const B = mkFolder("B");
    const bm = mkBookmark("https://r05b.example/x", A.id, "X");
    await apply([{ kind: "folder.create", name: "B", browserFolderId: "bf-B", parentBrowserFolderId: "1" }]);
    // 先绑定书签身份（库中已有该 URL → bound，留在 A）
    const bind = await apply([{ kind: "bookmark.create", browserId: "n-7", url: "https://r05b.example/x", title: "X", folderPath: ["A"] }]);
    expect(bind.results[0]!.status).toBe("bound");
    expect(env.store.getBookmark(bm.id)?.folder_id).toBe(A.id);
    // 目标目录：browserFolderId 身份（B）优先于 folderPath（A）
    const u = await apply([{ kind: "bookmark.update", browserId: "n-7", title: "X", browserFolderId: "bf-B", folderPath: ["A"], folderRoot: "bar" }]);
    expect(u.results[0]!.status).toBe("ok");
    expect(env.store.getBookmark(bm.id)?.folder_id).toBe(B.id); // 身份优先于 folderPath
    expect(u.results[0]!.appFolderId).toBe(B.id);
  });

  it("move 变更载荷带 content_revision——库侧移动后端侧提交不发生假冲突", async () => {
    env = makeEnv();
    const A = mkFolder("A");
    const B = mkFolder("B");
    const c = await apply([{ kind: "bookmark.create", browserId: "n-6", url: "https://r05c.example/x", title: "T", folderPath: ["A"] }]);
    const appId = c.results[0]!.appBookmarkId!;
    const rev0 = revOf(appId);
    env.store.moveBookmark(appId, B.id); // 库侧移动（如 AI 归位）
    expect(revOf(appId)).toBeGreaterThan(rev0);
    const p = await pull(0);
    const mv = p.items.find((i) => i.entity === "bookmark" && i.op === "move");
    expect(mv).toBeTruthy();
    expect((mv!.payload as { content_revision?: number }).content_revision).toBe(revOf(appId));
    expect((mv!.payload as { url_raw?: string }).url_raw).toBe("https://r05c.example/x");
    const ok = await apply([{ kind: "bookmark.update", browserId: "n-6", title: "T9", baseRevision: revOf(appId) }]);
    expect(ok.results[0]!.status).toBe("ok");
    expect(env.store.getBookmark(appId)?.title).toBe("T9");
  });

  it("目录改名/搬家递增 rev；baseRevision 过期 → conflict + 现值；合并改名+搬家；按浏览器身份解析", async () => {
    env = makeEnv();
    const c = await apply([{ kind: "folder.create", name: "F", browserFolderId: "bf-f", parentBrowserFolderId: "1" }]);
    const fid = c.results[0]!.appFolderId!;
    expect(c.results[0]!.entity).toMatchObject({ id: fid, name: "F", root: "bar", rev: fRev(fid) });
    const r1 = await apply([{ kind: "folder.rename", appFolderId: fid, name: "F1", browserFolderId: "bf-f", baseRevision: fRev(fid) }]);
    expect(r1.results[0]!.status).toBe("ok");
    const rev1 = fRev(fid);
    expect(rev1).toBeGreaterThan(c.results[0]!.entity!.rev as number);
    expect(r1.results[0]!.entity).toMatchObject({ id: fid, name: "F1", rev: rev1 });
    // 旧修订提交 → conflict
    const stale = await apply([{ kind: "folder.rename", appFolderId: fid, name: "F-stale", browserFolderId: "bf-f", baseRevision: rev1 - 1 }]);
    expect(stale.results[0]!.status).toBe("conflict");
    expect(env.store.getFolder(fid)?.name).toBe("F1");
    // 合并：改名 + 跨根搬家一次提交
    const mv = await apply([
      { kind: "folder.move", appFolderId: fid, browserFolderId: "bf-f", toBrowserFolderId: "2", root: "other", name: "F2", baseRevision: rev1 },
    ]);
    expect(mv.results[0]!.status).toBe("ok");
    expect(env.store.getFolder(fid)).toMatchObject({ name: "F2", root: "other" });
    // 仅由 browserFolderId 解析身份的 rename
    const rn = await apply([{ kind: "folder.rename", browserFolderId: "bf-f", name: "F3", baseRevision: fRev(fid) }]);
    expect(rn.results[0]!.status).toBe("ok");
    expect(env.store.getFolder(fid)?.name).toBe("F3");
    // 快照与目录列表均带 rev
    const snap = (await (await env.app.request("/api/v1/sync/snapshot")).json()) as { folders: Array<{ id: string; rev: number }> };
    expect(snap.folders.find((f) => f.id === fid)?.rev).toBe(fRev(fid));
    const list = (await (await env.app.request("/api/v1/folders")).json()) as Array<{ id: string; rev: number }>;
    expect(list.find((f) => f.id === fid)?.rev).toBe(fRev(fid));
  });
});

describe("skipped 错误码可分类（终态 / 可重试）", () => {
  it("终态：folder_not_found / system_folder / no_identity / target_required；可重试：parent_unknown", async () => {
    env = makeEnv();
    const rn = await apply([{ kind: "folder.rename", appFolderId: "no-such-folder", name: "X" }]);
    expect(rn.results[0]).toMatchObject({ status: "skipped", error: "folder_not_found" });
    const inbox = env.store.createFolder(INBOX_FOLDER_TITLE, null, "user", true);
    const sys = await apply([{ kind: "folder.rename", appFolderId: inbox.id, name: "X" }]);
    expect(sys.results[0]).toMatchObject({ status: "skipped", error: "system_folder" });
    const noId = await apply([{ kind: "folder.move", browserFolderId: "bf-unknown" }]);
    expect(noId.results[0]).toMatchObject({ status: "skipped", error: "no_identity" });
    const created = await apply([{ kind: "folder.create", name: "M", browserFolderId: "bf-m", parentBrowserFolderId: "1" }]);
    const noTarget = await apply([{ kind: "folder.move", appFolderId: created.results[0]!.appFolderId }]);
    expect(noTarget.results[0]).toMatchObject({ status: "skipped", error: "target_required" });
    const parentUnknown = await apply([
      { kind: "folder.move", appFolderId: created.results[0]!.appFolderId, toBrowserFolderId: "bf-parent-not-bound" },
    ]);
    expect(parentUnknown.results[0]).toMatchObject({ status: "skipped", error: "parent_unknown" });
  });
});
