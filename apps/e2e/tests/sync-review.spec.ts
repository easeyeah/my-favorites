/**
 * D81 复核清单 E2E（docs/同步整改复核清单-D81.md §3 验收项）。
 *
 * 全部跑在鉴权 fixture（3008）+ 故障注入代理（3010）上，不触碰真实库。
 * 断言以可观测结果为主（库态 / 浏览器节点 / 同步状态），出站队列等内部状态只作补充断言。
 *
 *  SYNC-R02 目录 create / rename / move 首次失败后无需再次手动修改即收敛；失败期间不报正常
 *  SYNC-R04 嵌套子树跨根搬家：两端不残留、不新建重复目录
 *  SYNC-R05 连续两次改标题不回退；同一轮改标题 + 移目录都生效；真实冲突按约定策略（库侧优先）且可观测
 *  SYNC-R06 恢复完整保留本地意图（空目录 / 改名 / 搬家 / 书签移入新目录）；恢复期单条失败不丢不回退
 *  SYNC-R07 服务端已提交但响应丢失 → 复用原 opId，不覆盖后续修改；待处理期间重启 SW 操作仍在
 *  SYNC-R01 过期恢复不绕过目录删除保险丝；挂起重启 SW 仍待确认；确认后按范围删除，失败子操作保留
 */
import { test, expect, chromium } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTH_BASE,
  EXTENSION_PATH,
  FIXTURE_ADMIN,
  PROXY_BASE,
  authServerDataDir,
  fault,
  pointExtensionTo,
  startAuthServer,
  startFaultProxy,
  stopFaultProxy,
  stopServer,
} from "./fixtures";

let adminToken = "";
test.beforeAll(async () => {
  await startAuthServer();
  await startFaultProxy();
  const r = await fetch(`${AUTH_BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(FIXTURE_ADMIN),
  });
  adminToken = ((await r.json()) as { token: string }).token;
});
test.afterAll(() => {
  stopFaultProxy();
  stopServer();
});
// 每个用例从干净故障态开始（用例中途失败不得把故障模式漏给下一个）
test.beforeEach(() => {
  fault.apply = "pass";
  fault.failKind = null;
});

// ---------- 库侧（管理台 = 另一写入者）----------
const api = async (pathName: string, init?: RequestInit) => {
  const r = await fetch(`${AUTH_BASE}/api/v1${pathName}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}`, ...(init?.headers ?? {}) },
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
type LibFolder = { id: string; name: string; parent_id: string | null; root?: string };
type LibBookmark = { id: string; title: string; url_raw: string; folder_id: string };
const libFolders = async () => (await api("/folders")).body as unknown as LibFolder[];
const libBookmarks = async () => (await api("/bookmarks?limit=2000")).body as unknown as LibBookmark[];
const folderByName = async (name: string) => (await libFolders()).find((f) => f.name === name);
const bmByUrl = async (url: string) => (await libBookmarks()).find((b) => b.url_raw === url);
const wipeChanges = (): void => {
  const db = new DatabaseSync(path.join(authServerDataDir(), "my-favorites.db"));
  db.exec("DELETE FROM changes");
  db.close();
};

// ---------- 浏览器书签树 ----------
type BmNode = { id: string; title?: string; url?: string; parentId?: string };
const bm = {
  create: (page: import("@playwright/test").Page, parentId: string, title: string, url?: string) =>
    page.evaluate(
      (m) => new Promise<string>((resolve) => chrome.bookmarks.create({ parentId: m.parentId, title: m.title, ...(m.url ? { url: m.url } : {}) }, (n) => resolve(n.id))),
      { parentId, title, url },
    ),
  get: (page: import("@playwright/test").Page, id: string) =>
    page.evaluate((i) => new Promise<BmNode | null>((resolve) => chrome.bookmarks.get(i, (n) => resolve(n[0] ?? null))), id),
  move: (page: import("@playwright/test").Page, id: string, parentId: string) =>
    page.evaluate((m) => new Promise<void>((resolve) => chrome.bookmarks.move(m.id, { parentId: m.parentId }, () => resolve())), { id, parentId }),
  update: (page: import("@playwright/test").Page, id: string, changes: { title?: string; url?: string }) =>
    page.evaluate((m) => new Promise<void>((resolve) => chrome.bookmarks.update(m.id, m.changes, () => resolve())), { id, changes }),
  removeTree: (page: import("@playwright/test").Page, id: string) =>
    page.evaluate((i) => new Promise<void>((resolve) => chrome.bookmarks.removeTree(i, () => resolve())), id),
  foldersNamed: (page: import("@playwright/test").Page, title: string) =>
    page.evaluate(
      (t) => new Promise<BmNode[]>((resolve) => chrome.bookmarks.search({ title: t }, (ns) => resolve(ns.filter((n) => !n.url)))),
      title,
    ),
  byUrl: (page: import("@playwright/test").Page, url: string) =>
    page.evaluate((u) => new Promise<BmNode[]>((resolve) => chrome.bookmarks.search({ url: u }, (ns) => resolve(ns))), url),
};
const browserFolder = async (page: import("@playwright/test").Page, title: string) => (await bm.foldersNamed(page, title))[0] ?? null;

// ---------- 扩展 ----------
interface InfoView {
  phase?: string;
  ok?: boolean;
  state?: string;
  error?: string;
  retryCount?: number;
  outboxCount?: number;
  rejectedCount?: number;
  conflicts?: number;
  pendingDeleteCount?: number;
  stats?: Record<string, number | undefined>;
}
const syncNow = (page: import("@playwright/test").Page) =>
  page.evaluate(() => new Promise<{ info?: InfoView; error?: string }>((r) => chrome.runtime.sendMessage({ type: "sync-now" }, r)));
/** 连跑两次：若首次撞上正在进行的自动 tick（返回的是那一轮结果），第二次必是覆盖最新改动的新一轮 */
const settle = async (page: import("@playwright/test").Page) => {
  await syncNow(page);
  return syncNow(page);
};
const syncStatus = (page: import("@playwright/test").Page) =>
  page.evaluate(() => new Promise<{ on?: boolean; info?: InfoView }>((r) => chrome.runtime.sendMessage({ type: "sync-status" }, r)));
const storage = (page: import("@playwright/test").Page, keys: string[]) =>
  page.evaluate((ks) => browser.storage.local.get(ks), keys) as Promise<Record<string, unknown>>;
type OutOp = { opId: string; kind: string; entity: string; mut?: { kind?: string } };
const outbox = async (page: import("@playwright/test").Page): Promise<OutOp[]> =>
  ((await storage(page, ["mfSyncOutbox"])).mfSyncOutbox as OutOp[] | undefined) ?? [];

async function launchExt(profileDir: string) {
  const ctx = await chromium.launchPersistentContext(profileDir, {
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
  const attach = (w: import("@playwright/test").Worker) =>
    w.on("console", (m) => {
      const t = m.text();
      if (t.includes("[sync]") || t.includes("[pull]") || t.includes("[align]") || t.includes("[rebuild]")) console.log("[SW]", t.slice(0, 220));
    });
  attach(sw!);
  ctx.on("serviceworker", attach);
  const extId = new URL(sw!.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState();
  await pointExtensionTo(page, process.env.MF_DIRECT === "1" ? AUTH_BASE : PROXY_BASE);
  return { ctx, page };
}
async function loginExt(page: import("@playwright/test").Page): Promise<void> {
  if (!(await page.locator("#acct-out").isVisible())) return; // 重开 profile 时已登录
  await page.getByPlaceholder("alice").fill(FIXTURE_ADMIN.username);
  await page.locator("#cloud-pw").fill(FIXTURE_ADMIN.password);
  await page.locator("#cloud-login").click();
  await expect(page.locator("#acct-in")).toBeVisible({ timeout: 15_000 });
}
async function setSync(page: import("@playwright/test").Page, on: boolean): Promise<void> {
  const box = page.locator("#sync-master");
  if (on) await box.check();
  else await box.uncheck();
  // 可观测状态断言（不依赖提示文案）：开关已持久化 + **本轮操作已完成**（info.at 不早于操作时刻）。
  // 仅看 on/state 会接受重建完成前的旧状态——recover 重建耗时数秒，早于它的 ok 是上一轮的
  const t0 = Date.now();
  if (on) await box.check();
  else await box.uncheck();
  if (on) {
    await poll(
      () => syncStatus(page),
      (s) => s.on === true && s.info !== undefined && (s.info.at ?? 0) >= t0 && s.info.state !== "error",
      "开启同步并完成本轮收敛",
      120_000,
    );
  } else {
    await expect(page.locator("#msg-sync")).toContainText("已关闭", { timeout: 30_000 });
  }
}
async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`poll timeout: ${what} → ${JSON.stringify(v).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const newProfile = () => mkdtempSync(path.join(os.tmpdir(), "mf-r0x-"));

test("SYNC-R02：目录 create / rename / move 首次失败后无需再次手动修改即收敛；失败期间状态不报正常", async () => {
  test.setTimeout(240_000);
  const { ctx, page } = await launchExt(newProfile());
  await loginExt(page);
  await setSync(page, true);

  // ① 空目录创建首次失败
  const fid = await bm.create(page, "1", "R02新目录");
  fault.apply = "fail";
  let info = (await syncNow(page)).info!;
  expect(info.state).toBe("retrying"); // 失败期间界面不报正常
  expect(await folderByName("R02新目录")).toBeUndefined();
  fault.apply = "pass";
  await settle(page);
  expect(await folderByName("R02新目录")).toBeTruthy(); // 恢复后自动收敛，无需再动目录

  // ② 改名首次失败
  fault.apply = "fail";
  await bm.update(page, fid, { title: "R02改" });
  info = (await syncNow(page)).info!;
  expect(info.state).toBe("retrying");
  expect(await folderByName("R02改")).toBeUndefined();
  fault.apply = "pass";
  await settle(page);
  expect(await folderByName("R02改")).toBeTruthy();
  expect(await folderByName("R02新目录")).toBeUndefined();

  // ③ 搬家首次失败
  const parentId = await bm.create(page, "1", "R02父");
  await settle(page);
  expect(await folderByName("R02父")).toBeTruthy();
  fault.apply = "fail";
  await bm.move(page, fid, parentId);
  info = (await syncNow(page)).info!;
  expect(info.state).toBe("retrying");
  expect((await folderByName("R02改"))!.parent_id).toBeNull(); // 库内未动
  fault.apply = "pass";
  const last = await settle(page);
  const moved = await folderByName("R02改");
  const parent = await folderByName("R02父");
  expect(moved!.parent_id).toBe(parent!.id);
  expect(last.info!.state).toBe("ok"); // 收敛后回到正常
  expect((await outbox(page)).length).toBe(0);

  await setSync(page, false);
  await ctx.close();
});

test("SYNC-R04：带嵌套目录与书签的目录跨根搬家（bar→other→bar），两端不残留、不新建重复目录", async () => {
  test.setTimeout(240_000);
  const { ctx, page } = await launchExt(newProfile());
  await loginExt(page);
  await setSync(page, true);
  const url = `https://r04.example/${Date.now()}`;
  const top = await bm.create(page, "1", "R04目录");
  const sub = await bm.create(page, top, "R04子");
  await bm.create(page, sub, "R04书签", url);
  await settle(page);
  let libTop = await folderByName("R04目录");
  let libSub = await folderByName("R04子");
  expect(libTop).toBeTruthy();
  expect(libTop!.root ?? "bar").toBe("bar");
  expect(libSub!.parent_id).toBe(libTop!.id);
  expect((await bmByUrl(url))?.folder_id).toBe(libSub!.id);

  // → 其他书签（other 根）
  await bm.move(page, top, "2");
  await settle(page);
  libTop = await folderByName("R04目录");
  libSub = await folderByName("R04子");
  expect(libTop!.root).toBe("other");
  expect(libSub!.parent_id).toBe(libTop!.id); // 子树随迁，父子关系一致
  expect((await bmByUrl(url))?.folder_id).toBe(libSub!.id); // 书签归属不变
  expect((await libFolders()).filter((f) => f.name === "R04目录").length).toBe(1); // 库无重复
  const inBrowser = await bm.foldersNamed(page, "R04目录");
  expect(inBrowser.length).toBe(1); // 浏览器无残留/重复
  expect(inBrowser[0]!.parentId).toBe("2");
  expect((await bm.get(page, top))!.id).toBe(top); // 浏览器节点 ID 不变

  // → 回书签栏（bar 根）
  await bm.move(page, top, "1");
  await settle(page);
  libTop = await folderByName("R04目录");
  expect(libTop!.root ?? "bar").toBe("bar");
  expect((await bm.get(page, top))!.parentId).toBe("1");
  expect(await folderByName("R04目录")).toBeTruthy();

  await setSync(page, false);
  await ctx.close();
});

test("SYNC-R05：连续两次改标题均成功不回退；同一轮改标题并移目录两项都生效", async () => {
  test.setTimeout(240_000);
  const { ctx, page } = await launchExt(newProfile());
  await loginExt(page);
  await setSync(page, true);
  const stamp = Date.now();
  const url = `https://r05.example/${stamp}`;
  // 库侧（另一写入者）建两个目录与一条书签，并改过一次名（修订 ≥2）→ 经 pull 进浏览器，端侧持有修订缓存
  const F = ((await api("/folders", { method: "POST", body: JSON.stringify({ name: "R05F" }) })).body as LibFolder).id;
  const G = ((await api("/folders", { method: "POST", body: JSON.stringify({ name: "R05G" }) })).body as LibFolder).id;
  const created = (await api("/bookmarks", { method: "POST", body: JSON.stringify({ url, title: "T0", folderId: F }) })).body as LibBookmark;
  await api(`/bookmarks/${created.id}`, { method: "PATCH", body: JSON.stringify({ title: "T0b" }) });
  await settle(page);
  const nodes = await bm.byUrl(page, url);
  expect(nodes.length).toBe(1);
  const bid = nodes[0]!.id;
  expect(nodes[0]!.title).toBe("T0b");

  // 无其他写入者：连续两次修改标题
  await bm.update(page, bid, { title: "T1" });
  await settle(page);
  expect((await bmByUrl(url))?.title).toBe("T1");
  await bm.update(page, bid, { title: "T2" });
  await settle(page);
  expect((await bmByUrl(url))?.title).toBe("T2"); // 第二次不得因自冲突被回退
  expect((await bm.get(page, bid))!.title).toBe("T2"); // 浏览器节点同样不被回退

  // 同一轮：改标题 + 移目录（两项都要生效）
  const gBrowser = await browserFolder(page, "R05G");
  expect(gBrowser).toBeTruthy();
  await bm.update(page, bid, { title: "T3" });
  await bm.move(page, bid, gBrowser!.id);
  const st = await settle(page);
  const row = await bmByUrl(url);
  expect(row?.title).toBe("T3");
  expect(row?.folder_id).toBe(G);
  const node = await bm.get(page, bid);
  expect(node!.title).toBe("T3");
  expect(node!.parentId).toBe(gBrowser!.id);
  expect(st.info!.state).toBe("ok");

  await setSync(page, false);
  await ctx.close();
});

test("SYNC-R05：两端修改同一实体按约定策略（库侧现值优先）处理真实冲突，不被 pull 刷新修订掩盖", async () => {
  test.setTimeout(240_000);
  const { ctx, page } = await launchExt(newProfile());
  await loginExt(page);
  await setSync(page, true);
  const url = `https://r05c.example/${Date.now()}`;
  const F = ((await api("/folders", { method: "POST", body: JSON.stringify({ name: "R05冲突" }) })).body as LibFolder).id;
  const created = (await api("/bookmarks", { method: "POST", body: JSON.stringify({ url, title: "原始", folderId: F }) })).body as LibBookmark;
  await settle(page);
  const nodes = await bm.byUrl(page, url);
  expect(nodes.length).toBe(1);
  const bid = nodes[0]!.id;

  // 浏览器侧改标题，出站失败（意图留在本地，未落库）
  fault.apply = "fail";
  await bm.update(page, bid, { title: "本地改动" });
  await syncNow(page);
  expect((await bmByUrl(url))?.title).toBe("原始");
  fault.apply = "pass";
  // 另一端（管理台）改同一条目
  await api(`/bookmarks/${created.id}`, { method: "PATCH", body: JSON.stringify({ title: "库侧改动" }) });

  // 立即手动触发一轮（抢在 SSE 门铃的 3s 防抖之前）：本轮内拉取应用库侧修改 + 重放出站操作 → 冲突在本轮处理并留痕
  const st = await syncNow(page);
  expect((st.info!.stats?.conflicts ?? 0) + (st.info!.conflicts ?? 0)).toBeGreaterThanOrEqual(1); // 冲突可观测
  expect((await bmByUrl(url))?.title).toBe("库侧改动"); // 库侧后续修改不被过期本地意图覆盖
  await settle(page);
  expect((await bmByUrl(url))?.title).toBe("库侧改动");
  expect((await bm.get(page, bid))!.title).toBe("库侧改动"); // 浏览器节点回对齐到库侧现值
  const finalStatus = await syncStatus(page);
  expect(finalStatus.info!.state).toBe("ok");
  expect((await outbox(page)).length).toBe(0);

  await setSync(page, false);
  await ctx.close();
});

test("SYNC-R07：服务端已提交但响应丢失 → 复用原 opId 重放不覆盖后续修改；待处理期间重启 SW 操作仍在", async () => {
  test.setTimeout(240_000);
  const profile = newProfile();
  let { ctx, page } = await launchExt(profile);
  await loginExt(page);
  await setSync(page, true);
  const fid = await bm.create(page, "1", "R07目录");
  await settle(page);
  expect(await folderByName("R07目录")).toBeTruthy();

  // 改名：服务端已提交，但对客户端丢弃响应
  fault.apply = "drop";
  await bm.update(page, fid, { title: "R07-N1" });
  await syncNow(page);
  expect(await folderByName("R07-N1")).toBeTruthy(); // 服务端确已提交
  const opIdAfterDrop = (await outbox(page))[0]?.opId;

  // 重启 SW（关闭浏览器上下文后用同一 profile 重开）：待处理操作与 opId 仍在
  await ctx.close();
  ({ ctx, page } = await launchExt(profile));
  await page.waitForTimeout(800);
  const afterRestart = await outbox(page);
  expect(afterRestart.length).toBe(1);
  expect(afterRestart[0]!.opId).toBe(opIdAfterDrop);

  // 响应丢失后，另一端修改同一记录
  const libFolder = await folderByName("R07-N1");
  expect(libFolder).toBeTruthy();
  await api(`/folders/${libFolder!.id}`, { method: "PATCH", body: JSON.stringify({ name: "R07-N2" }) });
  fault.apply = "pass";
  await settle(page);

  // 重放原操作不得覆盖后续修改（重放命中原回执，不重复执行）
  expect(await folderByName("R07-N2")).toBeTruthy();
  expect(await folderByName("R07-N1")).toBeUndefined();
  expect((await outbox(page)).length).toBe(0); // 成功回执后出队
  await poll(() => bm.get(page, fid), (n) => n?.title === "R07-N2", "浏览器目录随库侧后续修改收敛");
  expect((await bm.foldersNamed(page, "R07目录")).length).toBe(0); // 无残留

  await setSync(page, false);
  await ctx.close();
});

test("SYNC-R06：恢复完整保留本地意图（空目录/改名/搬家/书签移入新目录）；恢复期单条失败不丢不回退", async () => {
  test.setTimeout(240_000);
  const { ctx, page } = await launchExt(newProfile());
  await loginExt(page);
  // 一条已入库书签（离线期把它移入新目录 = 「移入未绑定新目录」的意图）
  const urlExisting = `https://r06-existing.example/${Date.now()}`;
  const urlNew = `https://r06-new.example/${Date.now()}`;
  const F = ((await api("/folders", { method: "POST", body: JSON.stringify({ name: "R06原目录" }) })).body as LibFolder).id;
  const existing = (await api("/bookmarks", { method: "POST", body: JSON.stringify({ url: urlExisting, title: "R06已有", folderId: F }) })).body as LibBookmark;
  await setSync(page, true);
  await settle(page);
  const existingNodes = await bm.byUrl(page, urlExisting);
  expect(existingNodes.length).toBe(1);

  // 离线（关闭同步）期间的本地意图
  await setSync(page, false);
  const empty = await bm.create(page, "1", "R06新");
  const target = await bm.create(page, "1", "R06目标");
  const child = await bm.create(page, "1", "R06子");
  await bm.move(page, child, target); // 搬家
  await bm.update(page, empty, { title: "R06新改" }); // 改名
  const newBm = await bm.create(page, "1", "R06新书签", urlNew);
  await bm.move(page, newBm, empty); // 新书签移入新目录
  await bm.move(page, existingNodes[0]!.id, empty); // 已入库书签移入新目录
  wipeChanges(); // 日志过期

  // 恢复期注入单条失败（目录创建类操作返回 failed）
  fault.failKind = "folder.create";
  await setSync(page, true);
  let st = await syncStatus(page);
  expect(st.info!.state).toBe("retrying"); // 失败可见，不报正常
  // 待处理操作受保护：浏览器本地意图未被按库态回退
  expect((await bm.get(page, empty))!.title).toBe("R06新改");
  expect((await bm.get(page, child))!.parentId).toBe(target);
  expect((await bm.get(page, newBm))!.parentId).toBe(empty);
  expect((await bm.get(page, existingNodes[0]!.id))!.parentId).toBe(empty);

  // 解除故障 → 原操作重试成功，全部意图落库
  fault.failKind = null;
  await settle(page);
  const renamed = await folderByName("R06新改");
  const tgt = await folderByName("R06目标");
  const ch = await folderByName("R06子");
  expect(renamed).toBeTruthy(); // 空目录创建 + 改名
  expect(tgt).toBeTruthy();
  expect(ch!.parent_id).toBe(tgt!.id); // 搬家后的父子关系
  expect((await bmByUrl(urlNew))?.folder_id).toBe(renamed!.id); // 新书签移入新目录
  expect((await bmByUrl(urlExisting))?.folder_id).toBe(renamed!.id); // 已入库书签移入新目录
  expect((await libFolders()).filter((f) => f.name === "R06新改").length).toBe(1); // 无重复目录
  expect((await bm.foldersNamed(page, "R06新改")).length).toBe(1);
  st = await syncStatus(page);
  expect(st.info!.state).toBe("ok");
  void existing;
  void F;

  await setSync(page, false);
  await ctx.close();
});

test("SYNC-R01：过期恢复不绕过目录删除保险丝——挂起重启 SW 仍待确认；确认后按范围删除，失败子操作保留", async () => {
  test.setTimeout(300_000);
  const profile = newProfile();
  let { ctx, page } = await launchExt(profile);
  await loginExt(page);
  // 隔离基线：fixture 服务端为本文件共享，前序用例遗留目录会抬高基线规模，使「删 5 个超一半」的
  // 目录保险丝比例判定失真。清空遗留目录/书签（树删），让基线恰为本用例的 6 个目录。
  for (const f of await libFolders()) {
    if (f.name !== "📥 收纳盒") await api(`/folders/${f.id}`, { method: "DELETE" });
  }
  // 基线：库侧 6 个目录各含 1 条书签
  const stamp = Date.now();
  for (let i = 1; i <= 6; i++) {
    const f = ((await api("/folders", { method: "POST", body: JSON.stringify({ name: `R01目录${i}` }) })).body as LibFolder).id;
    await api("/bookmarks", { method: "POST", body: JSON.stringify({ url: `https://r01.example/${stamp}-${i}`, title: `R01书签${i}`, folderId: f }) });
  }
  await setSync(page, true);
  for (let i = 1; i <= 6; i++) await poll(() => browserFolder(page, `R01目录${i}`), (n) => Boolean(n), `浏览器出现 R01目录${i}`, 60_000);
  await settle(page);
  const libCount = async () => (await libFolders()).filter((f) => f.name.startsWith("R01目录")).length;
  const libBmCount = async () => (await libBookmarks()).filter((b) => b.url_raw.includes(`r01.example/${stamp}-`)).length;
  expect(await libCount()).toBe(6);

  // 离线（关闭同步）：浏览器删除 5 个目录（超过 3 个且超过一半）→ 日志过期
  await setSync(page, false);
  for (let i = 2; i <= 6; i++) {
    const n = await browserFolder(page, `R01目录${i}`);
    expect(n).toBeTruthy();
    await bm.removeTree(page, n!.id);
  }
  wipeChanges();

  // 重新开启 → 游标过期 → 快照恢复：库目录与书签保留、状态待确认、浏览器不复活已删目录
  await setSync(page, true);
  let st = await syncStatus(page);
  expect(st.info!.state).toBe("pending_confirm");
  expect(await libCount()).toBe(6);
  expect(await libBmCount()).toBe(6);
  expect(await browserFolder(page, "R01目录6")).toBeNull();

  // 重启 SW：仍保持待确认，无自动树删
  await ctx.close();
  ({ ctx, page } = await launchExt(profile));
  await settle(page);
  st = await syncStatus(page);
  expect(st.info!.state).toBe("pending_confirm");
  expect(await libCount()).toBe(6);
  expect(await browserFolder(page, "R01目录6")).toBeNull();

  // 确认时服务端对树删返回 failed → 操作保留在出站队列，不因失败回执被清除
  fault.failKind = "folder.deleteTree";
  await page.locator("#sync-confirm-delete").click();
  await poll(() => outbox(page), (ops) => ops.filter((o) => o.mut?.kind === "folder.deleteTree").length === 5, "树删操作保留在出站队列");
  expect(await libCount()).toBe(6); // 尚未执行
  st = await syncStatus(page);
  expect(st.info!.state).not.toBe("ok"); // 失败期间不报正常

  // 解除故障 → 按确认范围删除
  fault.failKind = null;
  await settle(page);
  expect(await libCount()).toBe(1);
  expect(await libBmCount()).toBe(1);
  expect(await folderByName("R01目录1")).toBeTruthy(); // 未删的那一个保留
  expect(await folderByName("R01目录2")).toBeUndefined();
  expect((await outbox(page)).length).toBe(0);
  await poll(() => syncStatus(page), (s) => s.info?.state === "ok", "状态回到正常");

  await setSync(page, false);
  await ctx.close();
});
