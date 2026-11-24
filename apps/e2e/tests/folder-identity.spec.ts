import { test, expect, chromium, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
  AUTH_BASE, EXTENSION_PATH, FIXTURE_ADMIN, PROXY_BASE, authServerDataDir,
  fault, startAuthServer, startFaultProxy, stopServer,
} from "./fixtures";

type Folder = { id: string; name: string; parent_id: string | null };
type Identity = { browser_folder_id: string; app_folder_id: string };
let token = "";

test.beforeAll(async () => {
  await startAuthServer();
  await startFaultProxy();
  const r = await fetch(`${AUTH_BASE}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(FIXTURE_ADMIN),
  });
  expect(r.ok).toBe(true);
  token = ((await r.json()) as { token: string }).token;
});
test.afterAll(() => stopServer());

async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${AUTH_BASE}/api/v1${pathname}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init?.headers } });
  expect(r.ok).toBe(true);
  return await r.json() as T;
}

async function launch(base = AUTH_BASE) {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "msedge", headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  try {
    const sw = ctx.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"))
      ?? await ctx.waitForEvent("serviceworker", { predicate: (w) => w.url().startsWith("chrome-extension://"), timeout: 60_000 });
    await sw.evaluate(({ base, token }) => chrome.storage.local.set({
      serverUrl: base, activeServer: base, token, serverTokens: { [base]: token },
      servers: [{ url: base, label: "目录身份测试" }], accountName: "admin",
    }), { base, token });
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
    await expect(page.locator("#acct-in")).toBeVisible();
    return { ctx, page };
  } catch (err) { await ctx.close(); throw err; }
}

async function makeTree(page: Page, title: string, nested: boolean) {
  return await page.evaluate(async ({ title, nested }) => {
    const parent = await chrome.bookmarks.create({ parentId: "1", title });
    const branches: Array<{ id: string; leafParent: string; bookmark: string; url: string }> = [];
    for (let i = 0; i < 6; i++) {
      const sibling = await chrome.bookmarks.create({ parentId: parent.id, title: i % 2 ? "同名 B" : "同名 A" });
      const leafParent = nested ? (await chrome.bookmarks.create({ parentId: sibling.id, title: "相同子目录" })).id : sibling.id;
      const url = `https://example.com/${encodeURIComponent(title)}/${i}`;
      const bookmark = await chrome.bookmarks.create({ parentId: leafParent, title: `分支 ${i}`, url });
      branches.push({ id: sibling.id, leafParent, bookmark: bookmark.id, url });
    }
    return { parent: parent.id, branches };
  }, { title, nested });
}

async function sync(page: Page) {
  return await page.evaluate(() => new Promise<{ error?: string; info?: { state?: string; outboxCount?: number } }>((resolve) => {
    chrome.runtime.sendMessage({ type: "sync-now" }, resolve);
  }));
}
async function enable(page: Page) {
  await page.locator("#sync-master").check();
  await expect(page.locator("#msg-sync")).toContainText("已开启", { timeout: 40_000 });
}
async function identities(page: Page) {
  const device = await page.evaluate(async () => (await chrome.storage.local.get("mfDeviceId")).mfDeviceId as string);
  return (await api<{ identities: Identity[] }>(`/browser/folder-identities?deviceId=${device}`)).identities;
}
async function verifyTree(page: Page, tree: Awaited<ReturnType<typeof makeTree>>) {
  const ids = await identities(page);
  const mapped = new Map(ids.map((i) => [i.browser_folder_id, i.app_folder_id]));
  const folders = await api<Folder[]>("/folders");
  const parent = mapped.get(tree.parent)!;
  expect(parent).toBeTruthy();
  expect(folders.filter((f) => f.parent_id === parent)).toHaveLength(6);
  expect(new Set(tree.branches.map((b) => mapped.get(b.id))).size).toBe(6);
  for (const branch of tree.branches) {
    const folderId = mapped.get(branch.leafParent)!;
    expect(folderId).toBeTruthy();
    const rows = await api<Array<{ url_raw: string }>>(`/bookmarks?folderId=${folderId}&limit=100`);
    expect(rows.map((r) => r.url_raw)).toContain(branch.url);
    const node = await page.evaluate(async (id) => (await chrome.bookmarks.get(id))[0], branch.bookmark);
    expect(node!.parentId).toBe(branch.leafParent); // 整理/重排不得把内容搬进另一个同名兄弟。
  }
}

test("同名兄弟和同路径孙目录保持六个独立分支，连续同步不折叠或错移", async () => {
  test.setTimeout(120_000);
  const { ctx, page } = await launch();
  try {
    const tree = await makeTree(page, "目录身份·新增", true);
    await enable(page);
    await verifyTree(page, tree);
    await sync(page);
    await sync(page);
    await page.reload();
    await sync(page);
    await verifyTree(page, tree);
  } finally { await ctx.close(); }
});

test("旧版六对二身份折叠由当前活目录安全分离，保留原浏览器节点与内容", async () => {
  test.setTimeout(120_000);
  const { ctx, page } = await launch();
  try {
    const tree = await makeTree(page, "目录身份·旧折叠", false);
    await enable(page);
    await verifyTree(page, tree);
    // 暂停调度后仅在 fixture 临时库注入旧版 N→1 状态；真实数据卷永不参与。
    await page.locator("#sync-master").uncheck();
    await expect(page.locator("#msg-sync")).toContainText("已关闭");
    const ids = await identities(page);
    const mapped = new Map(ids.map((i) => [i.browser_folder_id, i.app_folder_id]));
    const keep = [mapped.get(tree.branches[0]!.id)!, mapped.get(tree.branches[1]!.id)!];
    const db = new DatabaseSync(path.join(authServerDataDir(), "my-favorites.db"));
    try {
      db.exec("BEGIN");
      for (let i = 2; i < tree.branches.length; i++) {
        const old = mapped.get(tree.branches[i]!.id)!;
        const target = keep[i % 2]!;
        db.prepare("UPDATE bookmarks SET folder_id=? WHERE folder_id=?").run(target, old);
        db.prepare("UPDATE folder_identity SET app_folder_id=? WHERE app_folder_id=?").run(target, old);
        db.prepare("DELETE FROM folders WHERE id=?").run(old);
      }
      db.exec("COMMIT");
    } finally { db.close(); }
    await enable(page); // 有基线时走普通 tick；检测活冲突必须进入 recover，不清 outbox。
    await sync(page);
    await verifyTree(page, tree);
  } finally { await ctx.close(); }
});

test("旧折叠修复遇跨分支重复 URL 时保留原节点与用户编辑，明确报告未决", async () => {
  test.setTimeout(120_000);
  const { ctx, page } = await launch();
  try {
    const tree = await makeTree(page, "目录身份·重复URL", false);
    await enable(page);
    await verifyTree(page, tree);
    await page.locator("#sync-master").uncheck();
    await expect(page.locator("#msg-sync")).toContainText("已关闭");
    const first = tree.branches[0]!;
    const second = tree.branches[2]!;
    await page.evaluate(async ({ id, url }) => { await chrome.bookmarks.update(id, { url }); }, { id: second.bookmark, url: first.url });
    const ids = new Map((await identities(page)).map((i) => [i.browser_folder_id, i.app_folder_id]));
    const from = ids.get(second.id)!;
    const to = ids.get(first.id)!;
    const db = new DatabaseSync(path.join(authServerDataDir(), "my-favorites.db"));
    try {
      db.exec("BEGIN");
      db.prepare("UPDATE bookmarks SET folder_id=? WHERE folder_id=?").run(to, from);
      db.prepare("UPDATE folder_identity SET app_folder_id=? WHERE app_folder_id=?").run(to, from);
      db.prepare("DELETE FROM folders WHERE id=?").run(from);
      db.exec("COMMIT");
    } finally { db.close(); }
    await enable(page);
    const result = await sync(page);
    expect(result.info?.state).toBe("error");
    for (const branch of [first, second]) {
      const node = await page.evaluate(async (id) => (await chrome.bookmarks.get(id))[0], branch.bookmark);
      expect(node!.url).toBe(first.url);
      expect(node!.parentId).toBe(branch.leafParent);
    }
  } finally { await ctx.close(); }
});

test("库侧旧删除事件不能按名称误删浏览器新建的未绑定同名空目录", async () => {
  test.setTimeout(120_000);
  const { ctx, page } = await launch();
  try {
    await enable(page);
    await page.locator("#sync-master").uncheck();
    await expect(page.locator("#msg-sync")).toContainText("已关闭");
    const name = "目录身份·无主同名删除";
    const old = await api<Folder>("/folders", { method: "POST", body: JSON.stringify({ name }) });
    await api(`/folders/${old.id}`, { method: "DELETE" });
    const created = await page.evaluate(async (title) => await chrome.bookmarks.create({ parentId: "1", title }), name);
    await enable(page);
    await sync(page);
    const node = await page.evaluate(async (id) => (await chrome.bookmarks.get(id))[0], created.id);
    expect(node!.title).toBe(name);
    const mapped = new Map((await identities(page)).map((i) => [i.browser_folder_id, i.app_folder_id]));
    expect(mapped.get(created.id)).toBeTruthy();
    expect(mapped.get(created.id)).not.toBe(old.id);
  } finally { await ctx.close(); }
});

test("父目录落库失败时子目录和书签保留待发，恢复后按真实父身份落位", async () => {
  test.setTimeout(120_000);
  const { ctx, page } = await launch(PROXY_BASE);
  try {
    await enable(page);
    fault.failKind = "folder.create";
    const tree = await makeTree(page, "目录身份·父失败", true);
    const first = await sync(page);
    expect(first.error).toBeUndefined();
    expect(first.info?.state).toBe("retrying");
    expect(first.info?.outboxCount).toBeGreaterThan(0);
    const folders = await api<Folder[]>("/folders");
    expect(folders.some((f) => f.name === "目录身份·父失败")).toBe(false);
    fault.failKind = null;
    await sync(page);
    await sync(page);
    await verifyTree(page, tree);
  } finally { fault.failKind = null; await ctx.close(); }
});
