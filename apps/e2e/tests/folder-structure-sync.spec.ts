/**
 * D81 同步协议整改 E2E（评审 §8 验收口径：稳定身份/标题/URL/父子关系多维比较）：
 *  ① 浏览器建空目录 → 库收敛（folder.create 进推送 diff）
 *  ② 浏览器目录搬家（reparent）→ 库 parent_id 收敛
 *  ③ 库目录搬家（PATCH parentId）→ 浏览器节点搬运（pull folder.move）
 *  ④ 库目录改名 → 浏览器标题收敛
 *  ⑤ 不同根下同名目录不串号（根映射）
 *  ⑥ 浏览器改书签 URL → 库原行更新（无孤儿、无 align 复活重复）
 *  ⑦ 保险丝：库批量删除 → 待确认 → 确认后仍能执行（持久队列不丢事件）
 *  ⑧ 过期游标恢复：changes 被裁剪 → reset_required → 快照重建不丢不重
 * 全部跑在鉴权 fixture（3008），不污染真实 dev 库。
 */
import { test, expect, chromium } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { AUTH_BASE, EXTENSION_PATH, FIXTURE_ADMIN, authServerDataDir, pointExtensionTo, startAuthServer, stopServer } from "./fixtures";

const BASE = AUTH_BASE;
let adminToken = "";

test.beforeAll(async () => {
  await startAuthServer();
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(FIXTURE_ADMIN),
  });
  adminToken = ((await r.json()) as { token: string }).token;
});
test.afterAll(() => stopServer());

const api = async (pathName: string, init?: RequestInit) => {
  const r = await fetch(`${BASE}/api/v1${pathName}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}`, ...(init?.headers ?? {}) },
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

async function launchSyncedExt() {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "msedge",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    viewport: { width: 720, height: 900 },
  });
  let sw = ctx.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  for (let i = 0; i < 120 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 500));
    sw = ctx.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  }
  const attachSw = (w: import("@playwright/test").Worker) =>
    w.on("console", (m) => {
      const t = m.text();
      if (t.includes("[sync]") || t.includes("[pull]") || t.includes("[align]")) console.log("[SW]", t);
    });
  attachSw(sw!);
  ctx.on("serviceworker", attachSw);
  const extId = new URL(sw!.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState();
  await pointExtensionTo(page, BASE);
  await page.getByPlaceholder("alice").fill(FIXTURE_ADMIN.username);
  await page.locator("#cloud-pw").fill(FIXTURE_ADMIN.password);
  await page.locator("#cloud-login").click();
  await page.waitForTimeout(1200);
  await expect(page.locator("#acct-in")).toBeVisible();
  await page.locator("#sync-master").check();
  await expect(page.locator("#msg-sync")).toContainText("已开启", { timeout: 30_000 });
  await page.waitForTimeout(2500);
  return { ctx, page };
}

/** 浏览器书签树操作辅助（page.evaluate 内自包含） */
const bmCreate = (page: import("@playwright/test").Page, parentId: string, title: string, url?: string) =>
  page.evaluate(
    (m) =>
      new Promise<string>((resolve) =>
        chrome.bookmarks.create({ parentId: m.parentId, title: m.title, ...(m.url ? { url: m.url } : {}) }, (n) => resolve(n.id)),
      ),
    { parentId, title, url },
  );
const bmChildren = (page: import("@playwright/test").Page, parentId: string) =>
  page.evaluate(
    (pid) => new Promise<Array<{ id: string; title: string; url?: string; parentId?: string }>>((resolve) => chrome.bookmarks.getChildren(pid, resolve)),
    parentId,
  );
const bmMove = (page: import("@playwright/test").Page, id: string, parentId: string) =>
  page.evaluate((m) => new Promise<void>((resolve) => chrome.bookmarks.move(m.id, { parentId: m.parentId }, () => resolve())), { id, parentId });
const bmUpdate = (page: import("@playwright/test").Page, id: string, changes: { title?: string; url?: string }) =>
  page.evaluate((m) => new Promise<void>((resolve) => chrome.bookmarks.update(m.id, m.changes, () => resolve())), { id, changes });
const syncNow = (page: import("@playwright/test").Page) =>
  page.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: "sync-now" }, (r) => resolve(r))));

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`poll timeout: ${JSON.stringify(v).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

test("D81 目录结构双向同步：空目录/reparent/改名/根隔离/URL 编辑", async () => {
  test.setTimeout(240_000);
  const { ctx, page } = await launchSyncedExt();

  // ① 浏览器建空目录 → 库出现（旧实现空目录永不入库）
  const emptyId = await bmCreate(page, "1", "D81空目录");
  const libFolders = () => api("/folders").then((r) => r.body as unknown as Array<{ id: string; name: string; parent_id: string | null; root?: string }>);
  const emptyLib = await poll(libFolders, (fs) => fs.some((f) => f.name === "D81空目录"));
  const emptyLibId = emptyLib.find((f) => f.name === "D81空目录")!.id;

  // ② 浏览器建父子目录并搬家：D81子 从 D81父 下移到根级 → 库 parent_id 收敛
  const parentId = await bmCreate(page, "1", "D81父");
  const childId = await bmCreate(page, parentId, "D81子");
  await poll(libFolders, (fs) => fs.some((f) => f.name === "D81子"));
  await bmMove(page, childId, "1");
  await syncNow(page);
  const childLib = await poll(libFolders, (fs) => {
    const c = fs.find((f) => f.name === "D81子");
    return Boolean(c && c.parent_id === null);
  });
  const childLibId = childLib.find((f) => f.name === "D81子")!.id;
  const parentLibId = (await libFolders()).find((f) => f.name === "D81父")!.id;

  // ③ 库目录搬家（PATCH parentId）→ 浏览器节点搬运到 D81父 下
  const mv = await api(`/folders/${emptyLibId}`, { method: "PATCH", body: JSON.stringify({ parentId: parentLibId }) });
  expect(mv.status).toBe(200);
  await syncNow(page);
  await poll(
    () => bmChildren(page, parentId),
    (kids) => kids.some((k) => k.id === emptyId),
  );

  // ④ 库目录改名 → 浏览器标题收敛
  const rn = await api(`/folders/${parentLibId}`, { method: "PATCH", body: JSON.stringify({ name: "D81父改" }) });
  expect(rn.status).toBe(200);
  await syncNow(page);
  await poll(
    () => page.evaluate((id) => new Promise<string>((resolve) => chrome.bookmarks.get(id, (n) => resolve(n[0]?.title ?? ""))), parentId),
    (t) => t === "D81父改",
  );

  // ⑤ 不同根下同名目录不串号：书签栏与其他书签各建「D81同名」→ 库两条独立目录
  await bmCreate(page, "1", "D81同名");
  await bmCreate(page, "2", "D81同名");
  await syncNow(page);
  const twins = await poll(libFolders, (fs) => fs.filter((f) => f.name === "D81同名").length >= 2);
  const twinRows = twins.filter((f) => f.name === "D81同名");
  expect(twinRows.length).toBe(2);
  expect(twinRows[0]!.id).not.toBe(twinRows[1]!.id);
  expect(new Set(twinRows.map((f) => f.root ?? "bar")).size).toBe(2); // bar / other 各一

  // ⑥ 浏览器改书签 URL → 库原行更新（无孤儿）：建书签 → 改 URL → 库 url_raw 跟随且仅一条
  const urlA = `https://d81-url.example/a-${Date.now()}`;
  const urlB = `https://d81-url.example/b-${Date.now()}`;
  const bmId = await bmCreate(page, emptyId, "D81链接", urlA);
  await poll(
    () => api(`/bookmarks?folderId=${emptyLibId}&limit=50`).then((r) => r.body as unknown as Array<{ id: string; url_raw: string }>),
    (bs) => bs.some((b) => b.url_raw === urlA),
  );
  const before = (await api("/bookmarks?limit=2000").then((r) => r.body as unknown as Array<{ id: string }>)).length;
  await bmUpdate(page, bmId, { url: urlB });
  await syncNow(page);
  const afterRows = await poll(
    () => api("/bookmarks?limit=2000").then((r) => r.body as unknown as Array<{ id: string; url_raw: string }>),
    (bs) => bs.some((b) => b.url_raw === urlB),
  );
  expect(afterRows.some((b) => b.url_raw === urlA)).toBe(false); // 旧 URL 行已更新，非孤儿
  expect(afterRows.length).toBe(before); // 无新增重复
  // 再触发一轮对齐幂等验证：不复活旧 URL 条目
  await syncNow(page);
  await page.waitForTimeout(1500);
  const finalRows = (await api("/bookmarks?limit=2000").then((r) => r.body as unknown as Array<{ url_raw: string }>));
  expect(finalRows.filter((b) => b.url_raw === urlA).length).toBe(0);
  expect(finalRows.filter((b) => b.url_raw === urlB).length).toBe(1);
  void childLibId;

  await page.locator("#sync-master").uncheck();
  await page.waitForTimeout(600);
  await ctx.close();
});

test("D81 保险丝确认闭环：库批量删除挂起 → 确认后仍能执行（持久队列不丢事件）", async () => {
  test.setTimeout(240_000);
  // 预置 40 条书签（独立目录）
  const stamp = Date.now();
  const items = Array.from({ length: 40 }, (_, i) => ({
    url: `https://d81-fuse.example/${stamp}-${i}`,
    title: `D81批量${i}`,
    folderPath: ["D81批量"],
  }));
  const ingest = await api("/bookmarks/ingest", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: `d81-fuse-${stamp}`, items }),
  });
  expect(ingest.status).toBe(200);

  const { ctx, page } = await launchSyncedExt();
  // 等对齐把 40 条放进浏览器
  await poll(
    () => page.evaluate((s) => new Promise<number>((resolve) => chrome.bookmarks.search({ url: `https://d81-fuse.example/${s}-0` }, (n) => resolve(n.length))), stamp),
    (n) => n > 0,
    60_000,
  );
  await page.waitForTimeout(3000);

  // 库侧删 35 条（>30 且 >25% → 保险丝）。并行删除让事件单批到达——
  // 逐条删时 SSE 门铃会在窗口内触发小批量 tick（每批 <30 直接放行），保险丝永不触发
  const all = (await api("/bookmarks?limit=2000").then((r) => r.body as unknown as Array<{ id: string; url_raw: string }>));
  const targets = all.filter((b) => b.url_raw.includes(`d81-fuse.example/${stamp}-`)).slice(0, 35);
  expect(targets.length).toBe(35);
  await Promise.all(targets.map((b) => api(`/bookmarks/${b.id}`, { method: "DELETE" })));

  // 走 UI「立即同步」按钮（options 仅在 UI 动作后刷新状态行；程序化消息不重绘）
  await page.locator("#sync-now").click();
  // 挂起可见：options 保险丝确认行出现（待确认状态）
  await expect(page.locator("#sync-guard-row")).toBeVisible({ timeout: 15_000 });
  const browserCount = () =>
    page.evaluate(
      (s) => new Promise<number>((resolve) => chrome.bookmarks.search({}, (ns) => resolve(ns.filter((n) => n.url?.includes(`d81-fuse.example/${s}-`)).length))),
      stamp,
    );
  expect(await browserCount()).toBeGreaterThanOrEqual(35); // 挂起期间未执行

  // 确认放行 → 持久队列重放，删除仍能执行（旧实现游标越过事件后确认无事件可放）
  await page.locator("#sync-confirm-delete").click();
  await poll(browserCount, (n) => n <= 5, 60_000);
  const libLeft = (await api("/bookmarks?limit=2000").then((r) => r.body as unknown as Array<{ url_raw: string }>))
    .filter((b) => b.url_raw.includes(`d81-fuse.example/${stamp}-`));
  expect(libLeft.length).toBe(5);

  await page.locator("#sync-master").uncheck();
  await page.waitForTimeout(600);
  await ctx.close();
});

test("D81 过期游标恢复：changes 清空 → reset_required → 快照重建不丢不重", async () => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  await api("/bookmarks/ingest", {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: `d81-reset-${stamp}`,
      items: [
        { url: `https://d81-reset.example/${stamp}-1`, title: "D81恢复1", folderPath: ["D81恢复"] },
        { url: `https://d81-reset.example/${stamp}-2`, title: "D81恢复2", folderPath: ["D81恢复"] },
      ],
    }),
  });
  const { ctx, page } = await launchSyncedExt();
  // 浏览器侧再加一条（本地数据），等收敛
  const localUrl = `https://d81-reset.example/${stamp}-local`;
  await bmCreate(page, "1", "D81本地", localUrl);
  await poll(
    () => api("/bookmarks?limit=2000").then((r) => r.body as unknown as Array<{ url_raw: string }>),
    (bs) => bs.some((b) => b.url_raw === localUrl),
    60_000,
  );
  const libBefore = (await api("/bookmarks?limit=2000").then((r) => r.body as unknown as Array<{ id: string; url_raw: string }>));
  const browserBefore = await page.evaluate(
    (s) => new Promise<number>((resolve) => chrome.bookmarks.search({}, (ns) => resolve(ns.filter((n) => n.url?.includes(`d81-reset.example/${s}-`)).length))),
    stamp,
  );
  expect(browserBefore).toBe(3);

  // 故障注入：外部清空 changes（模拟 >14d 裁剪后日志为空 / 库恢复）——设备游标 >0 → reset_required
  const db = new DatabaseSync(path.join(authServerDataDir(), "my-favorites.db"));
  db.exec("DELETE FROM changes");
  db.close();

  await syncNow(page); // 触发 pull → reset_required → doAlign(recover)
  await page.waitForTimeout(4000);
  // 恢复后：库与浏览器数据不丢不重（快照重建 + 本地意图保留）
  const libAfter = (await api("/bookmarks?limit=2000").then((r) => r.body as unknown as Array<{ id: string; url_raw: string }>));
  expect(libAfter.length).toBe(libBefore.length);
  for (const u of [`${localUrl}`, `https://d81-reset.example/${stamp}-1`, `https://d81-reset.example/${stamp}-2`]) {
    expect(libAfter.filter((b) => b.url_raw === u).length).toBe(1);
  }
  const browserAfter = await page.evaluate(
    (s) => new Promise<number>((resolve) => chrome.bookmarks.search({}, (ns) => resolve(ns.filter((n) => n.url?.includes(`d81-reset.example/${s}-`)).length))),
    stamp,
  );
  expect(browserAfter).toBe(3);
  // 恢复后同步状态回到 ok（无残留错误），且后续增量仍工作
  await api("/bookmarks", { method: "POST", body: JSON.stringify({ url: `https://d81-reset.example/${stamp}-post`, title: "D81恢复后新增", folderId: undefined }) });
  await syncNow(page);
  await poll(
    () => page.evaluate((u) => new Promise<number>((resolve) => chrome.bookmarks.search({ url: u }, (n) => resolve(n.length))), `https://d81-reset.example/${stamp}-post`),
    (n) => n === 1,
    60_000,
  );

  await page.locator("#sync-master").uncheck();
  await page.waitForTimeout(600);
  await ctx.close();
});