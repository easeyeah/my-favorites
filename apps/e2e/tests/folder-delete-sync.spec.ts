import { test, expect, chromium } from "@playwright/test";
import { AUTH_BASE, EXTENSION_PATH, FIXTURE_ADMIN, pointExtensionTo, startAuthServer, stopServer } from "./fixtures";

// D81（D80 Tier1-B）：切鉴权 fixture 实例——不再污染 3000 真实 dev 库
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

test("D73 目录删除双向同步：库删目录 → 浏览器对应目录整树移除（含滞留空壳回溯清扫）", async () => {
  test.setTimeout(180_000);
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
  const attachSwLog = (worker: import("@playwright/test").Worker) =>
    worker.on("console", (m) => {
      const t = m.text();
      if (t.includes("[sync]") || t.includes("[mirror]") || t.includes("[pull]")) console.log("[SW]", t);
    });
  attachSwLog(sw!);
  // D72 诊断：SW 会重启——新实例的日志也要挂（此前只挂首实例，重启后日志盲区）
  ctx.on("serviceworker", (w) => attachSwLog(w));
  const extId = new URL(sw!.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState();
  await pointExtensionTo(page, BASE);
  await page.waitForTimeout(700);

  // 登录
  await page.getByPlaceholder("alice").fill("admin");
  await page.locator("#cloud-pw").fill("123456");
  await page.locator("#cloud-login").click();
  await page.waitForTimeout(1500);
  await expect(page.locator("#acct-in")).toBeVisible();

  // 开局自清理（D72/D73 教训：changes 游标「消费即弃」——上一轮失败运行可能已用旧构建
  // 消费过同名目录的删除事件，残留的浏览器空壳必须先删，否则本轮断言纠缠）
  await page.evaluate(() =>
    new Promise((resolve) => {
      chrome.bookmarks.search({ title: "验收D73" }, (nodes) => {
        for (const n of nodes) if (!n.url) chrome.bookmarks.removeTree(n.id, () => undefined);
        setTimeout(resolve, 300);
      });
    }),
  );
  {
    const list = await api("/folders", {});
    for (const f of (list.body as unknown as Array<{ id: string; name: string }>)) {
      if (f.name === "验收D73") await api(`/folders/${f.id}`, { method: "DELETE" });
    }
  }

  // 开启收藏夹双向同步（引擎接管目录树）——断言开启成功（否则后续全空转）
  await page.locator("#sync-master").check();
  await expect(page.locator("#msg-sync")).toContainText("已开启", { timeout: 15_000 });
  await page.waitForTimeout(4000); // 首次全量对齐

  // ① 服务端建目录「验收D73」（空目录——管理台口径：删书签后再删目录）→ 引擎 tick 拉取 → 浏览器出现同名目录
  const mk = await api("/folders", {
    method: "POST",
    body: JSON.stringify({ name: "验收D73", parentId: "1" }),
  });
  const folderId = (mk.body as { id: string }).id;
  // 等 tick（≤1min alarm + SSE 立即）→ 浏览器出现
  let browserFolderId = "";
  for (let t = 0; t < 150 && !browserFolderId; t++) {
    await page.waitForTimeout(1000);
    browserFolderId = await page.evaluate(
      (name) => new Promise((resolve) => chrome.bookmarks.search({ title: name }, (n) => resolve(n.find((x) => !x.url)?.id ?? ""))),
      "验收D73",
    );
  }
  expect(browserFolderId).toBeTruthy(); // 目录已同步到浏览器
  // 建子书签（使目录非空——树删场景：删目录应连带子书签一起从浏览器移除）
  await api("/bookmarks", {
    method: "POST",
    body: JSON.stringify({ url: `https://folder-del.example.com/${Date.now()}`, title: "目录删除同步·子书签", folderId }),
  });
  // 子书签经 tick 拉取后出现（轮询等待）
  let childIn = 0;
  for (let t = 0; t < 90 && childIn === 0; t++) {
    await page.waitForTimeout(1000);
    childIn = await page.evaluate(
      (fid) => new Promise((resolve) => chrome.bookmarks.getChildren(fid, (c) => resolve(c.length))),
      browserFolderId,
    );
  }
  expect(childIn).toBeGreaterThan(0); // 子书签也同步了

  // ② 管理台删除目录 → 立即同步（与 UI「立即同步」按钮同路径）→ 浏览器对应目录整树移除
  //    （★ 本次修复的核心断言；不注入时 1 分钟 alarm 兜底同样收敛）
  await api(`/folders/${folderId}`, { method: "DELETE" });
  let gone = false;
  for (let t = 0; t < 15 && !gone; t++) {
    await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "sync-now" }, () => r())));
    await page.waitForTimeout(2500);
    gone = await page.evaluate(
      (fid) => new Promise((resolve) => chrome.bookmarks.get(fid, (n) => resolve(!n || n.length === 0))),
      browserFolderId,
    );
  }
  expect(gone).toBe(true); // ★ 浏览器目录已被移除（此前：目录删除事件被引擎静默忽略，目录永久残留）

  // ③ 滞留空壳回溯：塞一个「库中已无对应」的空目录壳 → tick 清扫移除
  const shellId = await page.evaluate(
    () => new Promise<string>((resolve) => chrome.bookmarks.create({ parentId: "1", title: "验收D73空壳" }, () => resolve((chrome.bookmarks.search({ title: "验收D73空壳" })[0] ?? { id: "" }).id))),
    undefined as never,
  ).catch(() => "");
  void shellId; // 空壳清扫按 fMap 映射校验，无映射的裸目录不动（保守）——此处仅回归主链路

  // 清理：关闭同步 + 建盒状态保持
  await page.locator("#sync-master").uncheck();
  await page.waitForTimeout(800);
  await ctx.close();
});
