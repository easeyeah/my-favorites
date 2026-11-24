/**
 * D82 管理台实时更新 E2E（《管理台书签实时更新》§9 验收口径）：
 * 运行于隔离鉴权 fixture（3008），保持管理台页面打开，通过浏览器 bookmarks API
 * 操作真实扩展书签树，断言 UI 自动收敛。
 * **不得用页面 reload / 点击「立即同步」/ 测试代码直接刷新列表来促成断言通过。**
 * 收敛全靠自然链路：浏览器事件 → 扩展防抖 tick → 服务端提交 → SSE 门铃 → 管理台校准。
 * 时效两段测量：浏览器操作→服务端提交（扩展等待）与服务端提交→UI 呈现（目标 P95 ≤2s）。
 */
import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { AUTH_BASE, EXTENSION_PATH, FIXTURE_ADMIN, pointExtensionTo, startAuthServer, stopServer } from "./fixtures";

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
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const apiFolders = () => api("/folders").then((r) => r.body as unknown as Array<{ id: string; name: string }>);
const apiBookmarks = (folderId?: string) =>
  api(`/bookmarks?limit=1000${folderId ? `&folderId=${folderId}` : ""}`).then(
    (r) => r.body as unknown as Array<{ id: string; title: string; url_raw: string }>,
  );
const folderIdByName = async (name: string) => (await apiFolders()).find((f) => f.name === name)?.id ?? "";

async function seed(items: Array<{ url: string; title: string; folderPath: string[] }>, key: string) {
  const r = await api("/bookmarks/ingest", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: key, items }),
  });
  if (r.status !== 200) throw new Error(`seed failed: ${JSON.stringify(r.body)}`);
}

// ---------- 扩展启动（同 folder-structure-sync 范式） ----------

async function launchSyncedExt(): Promise<{ ctx: BrowserContext; page: Page }> {
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
  // 等首轮对齐出结果（msg-sync：✅/⏸/🔄 同步完成；大批量对齐可达数十秒）。
  // 不得断言瞬态文案——options 消息流是「正在全量对齐…」→ 结果 → 6s 后清空。
  await expect
    .poll(async () => (await page.locator("#msg-sync").textContent()) ?? "", { timeout: 120_000, intervals: [500] })
    .toMatch(/同步完成|❌/);
  await expect(page.locator("#msg-sync")).not.toContainText("❌");
  await page.waitForTimeout(2500);
  return { ctx, page };
}

// ---------- 浏览器书签树操作 ----------

const bmCreate = (page: Page, parentId: string, title: string, url?: string) =>
  page.evaluate(
    (m) =>
      new Promise<string>((resolve) =>
        chrome.bookmarks.create({ parentId: m.parentId, title: m.title, ...(m.url ? { url: m.url } : {}) }, (n) => resolve(n.id)),
      ),
    { parentId, title, url },
  );
const bmRemove = (page: Page, id: string) =>
  page.evaluate((i) => new Promise<void>((resolve) => chrome.bookmarks.remove(i, () => resolve())), id);
const bmRemoveTree = (page: Page, id: string) =>
  page.evaluate((i) => new Promise<void>((resolve) => chrome.bookmarks.removeTree(i, () => resolve())), id);
const bmUpdate = (page: Page, id: string, changes: { title?: string; url?: string }) =>
  page.evaluate((m) => new Promise<void>((resolve) => chrome.bookmarks.update(m.id, m.changes, () => resolve())), { id, changes });
const bmMove = (page: Page, id: string, parentId: string) =>
  page.evaluate((m) => new Promise<void>((resolve) => chrome.bookmarks.move(m.id, { parentId: m.parentId }, () => resolve())), { id, parentId });
const bmFindByUrl = (page: Page, url: string) =>
  page.evaluate((u) => new Promise<string | null>((resolve) => chrome.bookmarks.search({ url: u }, (ns) => resolve(ns[0]?.id ?? null))), url);
const bmFindFolder = (page: Page, title: string) =>
  page.evaluate((t) => new Promise<string | null>((resolve) => chrome.bookmarks.search({ title: t }, (ns) => resolve(ns.find((n) => !n.url)?.id ?? null))), title);

// ---------- 管理台页面 ----------

async function openAdmin(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(
    ({ token, base }) => {
      localStorage.setItem("mf-admin-config", JSON.stringify({ serverUrl: base }));
      localStorage.setItem("mf-admin-token", token);
    },
    { token: adminToken, base: BASE },
  );
  await page.goto(`${BASE}/#bookmarks`);
  await expect(treeBtn(page, "全部书签")).toBeVisible({ timeout: 15_000 });
  return page;
}

const tree = (page: Page) => page.locator(".scroll-slim").first();
const treeBtn = (page: Page, name: string) => tree(page).locator("button").filter({ hasText: name }).first();
const rows = (page: Page) => page.locator("li[data-bid]");
const rowByTitle = (page: Page, title: string) => rows(page).filter({ hasText: title });
const subtitle = (page: Page) => page.locator("header p").first();

async function selectFolder(page: Page, name: string) {
  await treeBtn(page, name).click();
}

// ---------- 收敛与时效 ----------

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000, intervalMs = 300): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`poll timeout (${timeoutMs}ms): ${JSON.stringify(v).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 两段计时：浏览器操作 → 服务端提交 → UI 呈现；server→ui 是前端指标（目标 ≤2s） */
async function converge(label: string, serverOk: () => Promise<boolean>, uiOk: () => Promise<boolean>) {
  const t0 = Date.now();
  await poll(serverOk, (v) => v, 60_000, 150);
  const tServer = Date.now();
  await poll(uiOk, (v) => v, 20_000, 80);
  const tUi = Date.now();
  const serverToUiMs = tUi - tServer;
  const line = `${label}: e2e=${tUi - t0}ms server→ui=${serverToUiMs}ms`;
  console.log(`[live-timing] ${line}`);
  test.info().annotations.push({ type: "live-timing", description: line });
  return { e2eMs: tUi - t0, serverToUiMs };
}

/** 等浏览器侧出现某 URL（对齐/收敛完成） */
const waitBrowserUrl = (page: Page, url: string, timeoutMs = 60_000) =>
  poll(() => bmFindByUrl(page, url), (id) => id !== null, timeoutMs, 500);

// =====================================================================

test("D82 行级收敛：删除/新增/改名/移动 + 时效 + 无请求风暴", async () => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  await seed(
    [
      { url: `https://live-row.example/${stamp}-del`, title: "LIVE删我", folderPath: ["LIVE行"] },
      { url: `https://live-row.example/${stamp}-ren`, title: "LIVE改我", folderPath: ["LIVE行"] },
      { url: `https://live-row.example/${stamp}-mov`, title: "LIVE移我", folderPath: ["LIVE行"] },
      { url: `https://live-row.example/${stamp}-tgt`, title: "LIVE目标已有", folderPath: ["LIVE目标"] },
    ],
    `live-row-${stamp}`,
  );
  const { ctx, page } = await launchSyncedExt();
  await waitBrowserUrl(page, `https://live-row.example/${stamp}-del`);
  const admin = await openAdmin(ctx);
  await selectFolder(admin, "LIVE行");
  await poll(() => rows(admin).count(), (n) => n === 3, 15_000, 100);

  const rowFolderId = await folderIdByName("LIVE行");
  const serverHas = async (url: string) => (await apiBookmarks(rowFolderId)).some((b) => b.url_raw === url);

  // ① 删除可见书签：行与计数自动更新（不得 reload/手动刷新）
  const delNode = await bmFindByUrl(page, `https://live-row.example/${stamp}-del`);
  await bmRemove(page, delNode!);
  const t1 = await converge(
    "删除可见书签",
    async () => !(await serverHas(`https://live-row.example/${stamp}-del`)),
    async () => (await rowByTitle(admin, "LIVE删我").count()) === 0,
  );
  expect(t1.serverToUiMs).toBeLessThanOrEqual(2000);
  await expect(subtitle(admin)).toContainText("2 条");

  // ② 新增：按当前过滤与排序出现在对应位置
  const browserRowFolder = await bmFindFolder(page, "LIVE行");
  await bmCreate(page, browserRowFolder!, "LIVE新增", `https://live-row.example/${stamp}-new`);
  const t2 = await converge(
    "新增书签",
    () => serverHas(`https://live-row.example/${stamp}-new`),
    async () => (await rowByTitle(admin, "LIVE新增").count()) === 1,
  );
  expect(t2.serverToUiMs).toBeLessThanOrEqual(2000);
  await expect(subtitle(admin)).toContainText("3 条");

  // ③ 改名：行标题跟随
  const renNode = await bmFindByUrl(page, `https://live-row.example/${stamp}-ren`);
  await bmUpdate(page, renNode!, { title: "LIVE已改" });
  const t3 = await converge(
    "改名书签",
    async () => (await apiBookmarks(rowFolderId)).some((b) => b.title === "LIVE已改"),
    async () => (await rowByTitle(admin, "LIVE已改").count()) === 1 && (await rowByTitle(admin, "LIVE改我").count()) === 0,
  );
  expect(t3.serverToUiMs).toBeLessThanOrEqual(2000);

  // ④ 移动：源目录移除、目标目录加入
  const movNode = await bmFindByUrl(page, `https://live-row.example/${stamp}-mov`);
  const browserTgtFolder = await bmFindFolder(page, "LIVE目标");
  await bmMove(page, movNode!, browserTgtFolder!);
  const tgtFolderId = await folderIdByName("LIVE目标");
  await converge(
    "移动书签",
    async () => (await apiBookmarks(tgtFolderId)).some((b) => b.url_raw === `https://live-row.example/${stamp}-mov`),
    async () => (await rowByTitle(admin, "LIVE移我").count()) === 0,
  );
  await expect(subtitle(admin)).toContainText("2 条");
  await selectFolder(admin, "LIVE目标");
  await poll(() => rowByTitle(admin, "LIVE移我").count(), (n) => n === 1, 15_000, 100);

  // ⑤ 连续操作无请求风暴：4 连增，列表请求必须被合并（防抖 + 在途守卫）
  await selectFolder(admin, "LIVE行");
  await poll(() => rows(admin).count(), (n) => n === 2, 15_000, 100);
  let listRequests = 0;
  const counter = (req: { url: () => string }) => {
    if (req.url().includes("/api/v1/bookmarks?")) listRequests++;
  };
  admin.on("request", counter);
  for (let i = 0; i < 4; i++) {
    await bmCreate(page, browserRowFolder!, `LIVE连增${i}`, `https://live-row.example/${stamp}-burst${i}`);
  }
  await poll(
    async () => (await apiBookmarks(rowFolderId)).filter((b) => b.url_raw.includes(`${stamp}-burst`)).length,
    (n) => n === 4,
    60_000,
    300,
  );
  await poll(() => rowByTitle(admin, "LIVE连增3").count(), (n) => n === 1, 20_000, 100);
  admin.off("request", counter);
  console.log(`[live-timing] 4 连增期间列表请求数=${listRequests}`);
  expect(listRequests).toBeLessThanOrEqual(15); // 未合并时 SSE 叠加 + 多页窗口会远超此数
  await expect(subtitle(admin)).toContainText("6 条");

  await page.locator("#sync-master").uncheck();
  await page.waitForTimeout(600);
  await ctx.close();
});

test("D82 目录树收敛：子树删除/当前目录回退/祖先回退/非当前目录", async () => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const { ctx, page } = await launchSyncedExt();

  // 浏览器建 根/父/叶 三层 + 叶内书签
  const root = await bmCreate(page, "1", `LIVE根${stamp}`);
  const parent = await bmCreate(page, root, `LIVE父${stamp}`);
  const leaf = await bmCreate(page, parent, `LIVE叶${stamp}`);
  await bmCreate(page, leaf, "LIVE叶书签", `https://live-tree.example/${stamp}-leaf`);
  await poll(async () => (await apiFolders()).some((f) => f.name === `LIVE叶${stamp}`), (v) => v, 60_000, 300);

  const admin = await openAdmin(ctx);
  await selectFolder(admin, `LIVE叶${stamp}`);
  await poll(() => rowByTitle(admin, "LIVE叶书签").count(), (n) => n === 1, 15_000, 100);
  await expect(subtitle(admin)).toContainText(`LIVE叶${stamp}`);

  // ① 删除当前目录的父级（含当前目录）→ 回退到最近仍存在的祖先「根」
  await bmRemoveTree(page, parent);
  await converge(
    "删父级→回退最近祖先",
    async () => !(await apiFolders()).some((f) => f.name === `LIVE父${stamp}` || f.name === `LIVE叶${stamp}`),
    async () => (await subtitle(admin).textContent())?.includes(`LIVE根${stamp}`) ?? false,
  );
  await expect(treeBtn(admin, `LIVE父${stamp}`)).toHaveCount(0);
  await expect(treeBtn(admin, `LIVE叶${stamp}`)).toHaveCount(0);

  // ② 删除当前目录本身（根）→ 全部祖先不存在 → 回「全部书签」
  await bmRemoveTree(page, root);
  await converge(
    "删当前目录→回全部",
    async () => !(await apiFolders()).some((f) => f.name === `LIVE根${stamp}`),
    async () => (await subtitle(admin).textContent())?.includes("全部书签") ?? false,
  );

  // ③ 删除非当前目录的嵌套子树：树移除、当前浏览位置（全部）不变、计数下降
  const other = await bmCreate(page, "1", `LIVE旁支${stamp}`);
  const otherKid = await bmCreate(page, other, `LIVE旁支子${stamp}`);
  await bmCreate(page, otherKid, "LIVE旁支书签", `https://live-tree.example/${stamp}-other`);
  await poll(async () => (await apiFolders()).some((f) => f.name === `LIVE旁支子${stamp}`), (v) => v, 60_000, 300);
  await poll(() => treeBtn(admin, `LIVE旁支${stamp}`).count(), (n) => n === 1, 15_000, 200);
  const countBefore = await subtitle(admin).textContent();
  await bmRemoveTree(page, other);
  await converge(
    "删非当前子树",
    async () => !(await apiFolders()).some((f) => f.name === `LIVE旁支${stamp}`),
    async () => (await treeBtn(admin, `LIVE旁支${stamp}`).count()) === 0,
  );
  await expect(subtitle(admin)).toContainText("全部书签");
  const countAfter = await subtitle(admin).textContent();
  expect(countAfter).not.toBe(countBefore);

  await page.locator("#sync-master").uncheck();
  await page.waitForTimeout(600);
  await ctx.close();
});

test("D82 交互保护：弹窗关闭补刷 + 编辑草稿冲突（外部修改/删除）", async () => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  await seed(
    [
      { url: `https://live-dlg.example/${stamp}-1`, title: "LIVE弹窗行", folderPath: ["LIVE弹窗"] },
      { url: `https://live-dlg.example/${stamp}-2`, title: "LIVE编辑我", folderPath: ["LIVE弹窗"] },
    ],
    `live-dlg-${stamp}`,
  );
  const { ctx, page } = await launchSyncedExt();
  await waitBrowserUrl(page, `https://live-dlg.example/${stamp}-1`);
  await waitBrowserUrl(page, `https://live-dlg.example/${stamp}-2`);
  const admin = await openAdmin(ctx);
  await selectFolder(admin, "LIVE弹窗");
  await poll(() => rows(admin).count(), (n) => n === 2, 15_000, 100);
  const folderId = await folderIdByName("LIVE弹窗");

  // ① 弹窗打开期间删除：通知记 dirty 但不替换数据；关闭后无新通知也补刷
  await admin.getByRole("button", { name: "添加书签" }).click();
  await expect(admin.getByRole("dialog")).toBeVisible();
  const node1 = await bmFindByUrl(page, `https://live-dlg.example/${stamp}-1`);
  await bmRemove(page, node1!);
  await poll(async () => !(await apiBookmarks(folderId)).some((b) => b.url_raw === `https://live-dlg.example/${stamp}-1`), (v) => v, 60_000, 200);
  await admin.waitForTimeout(3000); // 门铃早已到达（服务端 1s 合并）——阻塞期间必须按兵不动
  await expect(rowByTitle(admin, "LIVE弹窗行")).toHaveCount(1);
  await admin.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  // 关闭即补刷（不依赖新的 SSE 通知）
  await poll(() => rowByTitle(admin, "LIVE弹窗行").count(), (n) => n === 0, 3000, 80);

  // ② 编辑中被外部修改：草稿不被覆盖，冲突显式标记
  await rowByTitle(admin, "LIVE编辑我").click();
  await admin.getByRole("button", { name: "编辑", exact: true }).click();
  await admin.getByPlaceholder("标题", { exact: true }).fill("LIVE草稿标题");
  const node2 = await bmFindByUrl(page, `https://live-dlg.example/${stamp}-2`);
  await bmUpdate(page, node2!, { title: "LIVE外部标题" });
  await poll(async () => (await apiBookmarks(folderId)).some((b) => b.title === "LIVE外部标题"), (v) => v, 60_000, 200);
  await expect(admin.locator('[data-conflict="modified"]')).toBeVisible({ timeout: 10_000 });
  await expect(admin.getByPlaceholder("标题", { exact: true })).toHaveValue("LIVE草稿标题");

  // ③ 编辑中被外部删除：草稿保留、保存禁用、可复制草稿，不得自动重建
  await bmRemove(page, node2!);
  await poll(async () => !(await apiBookmarks(folderId)).some((b) => b.url_raw === `https://live-dlg.example/${stamp}-2`), (v) => v, 60_000, 200);
  await expect(admin.locator('[data-conflict="deleted"]')).toBeVisible({ timeout: 10_000 });
  await expect(admin.getByPlaceholder("标题", { exact: true })).toHaveValue("LIVE草稿标题");
  await expect(admin.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await expect(admin.getByRole("button", { name: "复制草稿" })).toBeVisible();
  // 库侧没有复活条目
  expect((await apiBookmarks(folderId)).some((b) => b.url_raw === `https://live-dlg.example/${stamp}-2`)).toBe(false);

  await page.locator("#sync-master").uncheck();
  await page.waitForTimeout(600);
  await ctx.close();
});

test("D82 视图校准：多页窗口+滚动锚点 / 搜索 / 联合视图 / 切换竞态", async () => {
  test.setTimeout(420_000);
  const stamp = Date.now();
  const pageItems = Array.from({ length: 150 }, (_, i) => ({
    url: `https://live-page.example/${stamp}-${i}`,
    title: `LIVE页${i}`,
    folderPath: ["LIVE页"],
  }));
  await seed(
    [
      ...pageItems,
      { url: `https://live-ua.example/${stamp}-1`, title: "LIVE联A1", folderPath: ["LIVE联A"] },
      { url: `https://live-ua.example/${stamp}-2`, title: "LIVE联A2", folderPath: ["LIVE联A"] },
      { url: `https://live-ub.example/${stamp}-1`, title: "LIVE联B1", folderPath: ["LIVE联B"] },
      { url: `https://live-ub.example/${stamp}-2`, title: "LIVE联B2", folderPath: ["LIVE联B"] },
      { url: `https://live-search.example/${stamp}-a`, title: "LIVE搜索甲", folderPath: ["LIVE搜"] },
      { url: `https://live-search.example/${stamp}-b`, title: "LIVE搜索乙", folderPath: ["LIVE搜"] },
    ],
    `live-views-${stamp}`,
  );
  const { ctx, page } = await launchSyncedExt();
  // 等 150 条对齐进浏览器（大批量，给足时间）
  await poll(
    () => page.evaluate((s) => new Promise<number>((resolve) => chrome.bookmarks.search({}, (ns) => resolve(ns.filter((n) => n.url?.includes(`live-page.example/${s}-`)).length))), stamp),
    (n) => n >= 150,
    120_000,
    1000,
  );
  const admin = await openAdmin(ctx);
  await selectFolder(admin, "LIVE页");
  await poll(() => rows(admin).count(), (n) => n === 100, 20_000, 150);

  // ① 已加载多页：加载更多 → 150；删除一条 → 不退回第一页、无骨架闪烁、锚点稳定
  await admin.getByRole("button", { name: "加载更多" }).click();
  await poll(() => rows(admin).count(), (n) => n === 150, 20_000, 150);
  await admin.evaluate(() => window.scrollTo(0, 1500));
  await admin.waitForTimeout(300);
  const anchor = await admin.evaluate(() => {
    const els = [...document.querySelectorAll<HTMLElement>("li[data-bid]")];
    const first = els.find((el) => el.getBoundingClientRect().bottom > 130);
    return first ? { id: first.dataset.bid!, top: first.getBoundingClientRect().top, url: first.querySelector("a")?.href ?? "" } : null;
  });
  expect(anchor).not.toBeNull();
  const anchorNode = await bmFindByUrl(page, anchor!.url);
  expect(anchorNode).not.toBeNull();
  // 删锚点上方的一条（列表首行 URL 对应节点），让窗口整体上移——锚点行应保持视口位置
  const firstRowUrl = await admin.evaluate(() => document.querySelector<HTMLElement>("li[data-bid] a")?.href ?? "");
  const firstNode = await bmFindByUrl(page, firstRowUrl);
  let minRows = Infinity;
  await bmRemove(page, firstNode!);
  const folderId = await folderIdByName("LIVE页");
  await converge(
    "多页窗口删除",
    async () => (await apiBookmarks(folderId)).length === 149,
    async () => {
      const n = await rows(admin).count();
      minRows = Math.min(minRows, n);
      return n === 149;
    },
  );
  expect(minRows).toBeGreaterThanOrEqual(100); // 背景刷新不得闪骨架（0 行）或退回第一页（100 行以下）
  const anchorAfter = await admin.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`li[data-bid="${CSS.escape(id)}"]`);
    return el ? el.getBoundingClientRect().top : null;
  }, anchor!.id);
  expect(anchorAfter).not.toBeNull();
  expect(Math.abs(anchorAfter! - anchor!.top)).toBeLessThanOrEqual(80);

  // ② 搜索视图：关键词保留，结果随外部改名重新查询
  await admin.getByPlaceholder("搜索书签…").fill("LIVE搜索");
  await admin.getByPlaceholder("搜索书签…").press("Enter");
  await poll(() => rows(admin).count(), (n) => n === 2, 15_000, 150);
  const searchNode = await bmFindByUrl(page, `https://live-search.example/${stamp}-a`);
  await bmUpdate(page, searchNode!, { title: "LIVE搜索甲改" });
  await converge(
    "搜索视图改名",
    async () => (await apiBookmarks()).some((b) => b.title === "LIVE搜索甲改"),
    async () => (await rowByTitle(admin, "LIVE搜索甲改").count()) === 1,
  );
  await expect(admin.getByPlaceholder("搜索书签…")).toHaveValue("LIVE搜索");

  // ③ 多目录联合视图：Ctrl 多选两目录，其一被删书签 → 并集校准
  await treeBtn(admin, "全部书签").click();
  await treeBtn(admin, "LIVE联A").click({ modifiers: ["ControlOrMeta"] });
  await treeBtn(admin, "LIVE联B").click({ modifiers: ["ControlOrMeta"] });
  await poll(() => rows(admin).count(), (n) => n === 4, 15_000, 150);
  const uaNode = await bmFindByUrl(page, `https://live-ua.example/${stamp}-1`);
  await bmRemove(page, uaNode!);
  await converge(
    "联合视图删除",
    async () => !(await apiBookmarks(await folderIdByName("LIVE联A"))).some((b) => b.url_raw === `https://live-ua.example/${stamp}-1`),
    async () => (await rows(admin).count()) === 3,
  );

  // ④ 切换目录后旧请求延迟返回：不得覆盖新目录内容（epoch 作废）
  const uaFolderId = await folderIdByName("LIVE联A");
  const delayRe = new RegExp(`/api/v1/bookmarks\\?folderId=${uaFolderId}&`);
  await admin.route(delayRe, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue().catch(() => {}); // 视图切换后旧请求可能被取消
  });
  await treeBtn(admin, "LIVE联A").click(); // 触发被延迟的请求
  await admin.waitForTimeout(200);
  await treeBtn(admin, "LIVE页").click(); // 立刻切走
  // 切目录 = 新视图：重置回第一页（100 行，149 条总量带 + 号）——旧目录的延迟响应不得覆盖
  await poll(() => rows(admin).count(), (n) => n === 100, 20_000, 150);
  await admin.waitForTimeout(3000); // 延迟响应此刻才返回——必须被丢弃
  await expect(subtitle(admin)).toContainText("LIVE页");
  await expect(subtitle(admin)).toContainText("100+ 条");
  expect(await rows(admin).count()).toBe(100);
  await expect(rowByTitle(admin, "LIVE联A2")).toHaveCount(0);
  await admin.unroute(delayRe);

  await page.locator("#sync-master").uncheck();
  await page.waitForTimeout(600);
  await ctx.close();
});

test("D82 连接恢复：SSE 断线重连补齐 / HTTP 失败保留旧列表 / 首查间隙补刷", async () => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  await seed(
    [
      { url: `https://live-conn.example/${stamp}-1`, title: "LIVE连1", folderPath: ["LIVE连"] },
      { url: `https://live-conn.example/${stamp}-2`, title: "LIVE连2", folderPath: ["LIVE连"] },
    ],
    `live-conn-${stamp}`,
  );
  const { ctx, page } = await launchSyncedExt();
  await waitBrowserUrl(page, `https://live-conn.example/${stamp}-1`);
  await waitBrowserUrl(page, `https://live-conn.example/${stamp}-2`);

  // ① SSE 断线期间变更 → 重连后自动补齐
  const admin = await ctx.newPage();
  await admin.setViewportSize({ width: 1280, height: 900 });
  await admin.addInitScript(
    ({ token, base }) => {
      localStorage.setItem("mf-admin-config", JSON.stringify({ serverUrl: base }));
      localStorage.setItem("mf-admin-token", token);
    },
    { token: adminToken, base: BASE },
  );
  const streamRe = /\/api\/v1\/events\/stream/;
  await admin.route(streamRe, (route) => route.abort());
  await admin.goto(`${BASE}/#bookmarks`);
  await expect(treeBtn(admin, "全部书签")).toBeVisible({ timeout: 15_000 });
  await selectFolder(admin, "LIVE连");
  await poll(() => rows(admin).count(), (n) => n === 2, 15_000, 100);
  const folderId = await folderIdByName("LIVE连");
  const node1 = await bmFindByUrl(page, `https://live-conn.example/${stamp}-1`);
  await bmRemove(page, node1!);
  await poll(async () => !(await apiBookmarks(folderId)).some((b) => b.url_raw === `https://live-conn.example/${stamp}-1`), (v) => v, 60_000, 200);
  await admin.waitForTimeout(2500);
  await expect(rowByTitle(admin, "LIVE连1")).toHaveCount(1); // 断线期间不假装更新
  await admin.unroute(streamRe); // 重连成功 → 首连/重连校准
  await poll(() => rowByTitle(admin, "LIVE连1").count(), (n) => n === 0, 25_000, 200);

  // ② HTTP 刷新失败：保留旧列表 + 安静失败提示，恢复后自动重试成功
  const listRe = new RegExp(`/api/v1/bookmarks\\?folderId=${folderId}&`);
  await admin.route(listRe, (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"injected"}' }));
  const node2 = await bmFindByUrl(page, `https://live-conn.example/${stamp}-2`);
  await bmRemove(page, node2!);
  await poll(async () => (await apiBookmarks(folderId)).length === 0, (v) => v, 60_000, 200);
  await expect(admin.getByText("更新失败，正在重试")).toBeVisible({ timeout: 15_000 });
  await expect(rowByTitle(admin, "LIVE连2")).toHaveCount(1); // 失败不得清空旧列表
  await admin.unroute(listRe);
  await poll(() => rows(admin).count(), (n) => n === 0, 25_000, 200); // 退避重试后收敛到空态

  // ③ 首次查询与 SSE 建连之间发生变更：建连后补刷新可见（首查延迟模拟间隙）
  const admin2 = await ctx.newPage();
  await admin2.setViewportSize({ width: 1280, height: 900 });
  await admin2.addInitScript(
    ({ token, base }) => {
      localStorage.setItem("mf-admin-config", JSON.stringify({ serverUrl: base }));
      localStorage.setItem("mf-admin-token", token);
    },
    { token: adminToken, base: BASE },
  );
  // 只延迟首个列表请求（命中即撤路由，后续请求正常）；continue 容错——
  // 延迟期间页面可能已有并行刷新请求落地，被取消的旧请求 continue 会抛 already handled
  const firstListRe = /\/api\/v1\/bookmarks\?/;
  await admin2.route(firstListRe, async (route) => {
    await admin2.unroute(firstListRe);
    await new Promise((r) => setTimeout(r, 1800));
    await route.continue().catch(() => {});
  });
  const gotoPromise = admin2.goto(`${BASE}/#bookmarks`);
  await admin2.waitForTimeout(600); // 首查在途、SSE 已建连的窗口内提交变更
  const created = await api("/bookmarks", {
    method: "POST",
    body: JSON.stringify({ url: `https://live-conn.example/${stamp}-gap`, title: "LIVE间隙", folderId }),
  });
  expect([200, 201]).toContain(created.status);
  await gotoPromise;
  // 不做任何手动刷新：首连校准必须把间隙里的变更补出来
  await poll(() => rowByTitle(admin2, "LIVE间隙").count(), (n) => n === 1, 15_000, 150);
  await admin2.unroute(/\/api\/v1\/bookmarks\?/);

  await page.locator("#sync-master").uncheck();
  await page.waitForTimeout(600);
  await ctx.close();
});
