import { test, expect } from "@playwright/test";
import { chromium } from "@playwright/test";
import { AUTH_BASE, EXTENSION_PATH, FIXTURE_ADMIN, pointExtensionTo, startAuthServer, stopServer } from "./fixtures";

// D81（D80 Tier1-B）：切鉴权 fixture 实例（有鉴权：admin/123456）——卡死场景需要 401 才能复现，
// 不再依赖 3000 真实 dev 实例
const BASE = AUTH_BASE;

test.beforeAll(async () => {
  await startAuthServer();
});
test.afterAll(() => stopServer());

test("收纳盒卡死自愈：登录建盒 → 掉登录丢书签（401 卡队列+可见告警）→ 再登录 → 再丢触发补投 → 服务端收到", async () => {
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

  // ① 登录（表单可见=未登录态）
  await page.getByPlaceholder("alice").fill("admin");
  await page.locator("#cloud-pw").fill("123456");
  await page.locator("#cloud-login").click();
  await page.waitForTimeout(1200);
  await expect(page.locator("#acct-in")).toBeVisible();

  // ② 建系统收纳盒（需登录：ensureInboxFolder 先调服务端）
  await page.getByRole("button", { name: "创建收纳盒" }).click();
  await page.waitForTimeout(800);
  const inboxId = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        chrome.bookmarks.search({ title: "📥 收纳盒" }, (nodes) => resolve(nodes[0]?.id ?? ""));
      }),
  );
  expect(inboxId).toBeTruthy();

  // ③ 切换账号（清本机令牌，模拟掉登录——真实场景：令牌失效/换了密码/另一台设备撤销）
  await page.getByRole("button", { name: "切换账号" }).click();
  await page.waitForTimeout(800);
  await expect(page.locator("#acct-out")).toBeVisible();

  // ④ 掉登录状态丢第一条 → /inbox/map 401 → 卡本机队列 + 失败可见
  await page.evaluate(
    (parentId) =>
      new Promise<void>((resolve) => {
        chrome.bookmarks.create(
          { parentId, title: "卡死测试 A · Mercor", url: "https://mercor.example.com/a" },
          () => resolve(),
        );
      }),
    inboxId,
  );
  await page.waitForTimeout(2500); // flush 1.2s + API 往返
  const stored = await page.evaluate(() =>
    browser.storage.local.get(["mfPendingOps", "mfInboxLastError"]),
  );
  const ops = (stored.mfPendingOps as Array<{ status: string }>) ?? [];
  expect(ops.filter((o) => o.status === "pending").length).toBeGreaterThanOrEqual(1);
  expect(String(stored.mfInboxLastError ?? "")).toMatch(/401|unauthorized/i);
  // options 状态行可见告警（D62 ③：失败不许静默）
  await expect(page.locator("#inbox-pending")).toContainText("待同步", { timeout: 20_000 });
  await expect(page.locator("#inbox-pending")).toContainText("未登录");

  // ⑤ 再登录 → 再丢一条 → 触发 flush → 队列两条一起补投
  await page.getByPlaceholder("alice").fill("admin");
  await page.locator("#cloud-pw").fill("123456");
  await page.locator("#cloud-login").click();
  await page.waitForTimeout(1200);
  await expect(page.locator("#acct-in")).toBeVisible();
  await page.evaluate(
    (parentId) =>
      new Promise<void>((resolve) => {
        chrome.bookmarks.create(
          { parentId, title: "卡死测试 B · POSE Atlas", url: "https://pose.example.com/b" },
          () => resolve(),
        );
      }),
    inboxId,
  );
  await page.waitForTimeout(4000); // flush 1.2s + map×N + process
  const stored2 = await page.evaluate(() => browser.storage.local.get(["mfPendingOps", "mfInboxLastError"]));
  const left = ((stored2.mfPendingOps as Array<{ status: string }>) ?? []).filter((o) => o.status === "pending");
  expect(left.length).toBe(0);
  await expect(page.locator("#inbox-pending")).toBeHidden();

  // ⑥ 服务端确实收到（管理台数据的真相源）
  const login = await page.request.post(`${BASE}/auth/login`, {
    data: { username: "admin", password: "123456" },
  });
  const { token } = (await login.json()) as { token: string };
  const list = (await (
    await page.request.get(`${BASE}/api/v1/bookmarks?limit=500`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ title: string }>;
  const titles = list.map((b) => b.title);
  expect(titles.some((t) => t.includes("卡死测试 A"))).toBe(true);
  expect(titles.some((t) => t.includes("卡死测试 B"))).toBe(true);

  await ctx.close();
}, 120_000);
