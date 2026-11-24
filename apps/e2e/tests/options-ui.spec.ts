import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  AUTH_BASE, BASE, EXTENSION_PATH, FIXTURE_ADMIN,
  startAuthServer, startServer, stopServer,
} from "./fixtures";

let token = "";
let expectedStats: { total: number; folders: number; navSites: number };

test.beforeAll(async () => {
  await startServer();
  await startAuthServer();
  const login = await fetch(`${AUTH_BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(FIXTURE_ADMIN),
  });
  expect(login.ok).toBe(true);
  token = ((await login.json()) as { token: string }).token;
  const stats = await fetch(`${AUTH_BASE}/api/v1/stats`, { headers: { authorization: `Bearer ${token}` } });
  expect(stats.ok).toBe(true);
  expectedStats = await stats.json();
});
test.afterAll(() => stopServer());

async function openOptions(logged = true): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "msedge",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    viewport: { width: 900, height: 1000 },
  });
  try {
    const sw = ctx.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"))
      ?? await ctx.waitForEvent("serviceworker", { predicate: (w) => w.url().startsWith("chrome-extension://"), timeout: 60_000 });
    // options 启动前一次性注入隔离实例，避免 boot 的 read-modify-write 覆写测试配置。
    await sw.evaluate(({ auth, anonymous, token }) => chrome.storage.local.set({
      serverUrl: auth, activeServer: auth, accountName: "admin", token,
      serverTokens: { [auth]: token },
      servers: [{ url: auth, label: "测试账号服务" }, { url: anonymous, label: "测试匿名服务" }],
    }), { auth: AUTH_BASE, anonymous: BASE, token: logged ? token : "" });
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#conn-url")).toHaveText(AUTH_BASE);
    return { ctx, page };
  } catch (err) {
    await ctx.close();
    throw err;
  }
}

async function expectStats(page: Page): Promise<void> {
  await expect(page.locator("#stats dd")).toHaveText([
    String(expectedStats.total), String(expectedStats.folders), String(expectedStats.navSites),
  ]);
}

test("options 五模块图标、自动概览与管理台深链；窄屏和深色不溢出", async ({}, testInfo) => {
  const { ctx, page } = await openOptions();
  try {
    // 无点击：进入页面即展示真实统计，五个模块标题都有同规格 SVG。
    await expectStats(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("插件设置");
    await expect(page.locator("h2")).toHaveText(["服务与账号", "收藏夹双向同步", "收纳盒", "管理台设置", "关于"]);
    await expect(page.locator('h2 svg[aria-hidden="true"]')).toHaveCount(5);
    await expect(page.locator("h2").first()).toHaveCSS("font-size", "18px");
    await expect(page.locator("h2").first()).toHaveCSS("font-weight", "700");
    await expect(page.locator("#notify-group, .notify-opt")).toHaveCount(0);
    await expect(page.getByText("本地模式（预留", { exact: false })).toHaveCount(0);
    await expect(page.getByLabel("当前服务")).toBeVisible();
    await expect(page.getByLabel("投递文件夹位置")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("options-desktop.png"), fullPage: true });

    for (const [id, hash] of [
      ["open-admin", "overview"],
      ["open-notification-settings", "settings/notify"],
      ["open-privacy-settings", "settings/privacy"],
    ]) {
      const nextPage = ctx.waitForEvent("page");
      await page.locator(`#${id}`).click();
      const opened = await nextPage;
      await expect(opened).toHaveURL(`${AUTH_BASE}/#${hash}`);
      expect(new URL(opened.url()).search).toBe(""); // 不在 URL 中传递插件令牌
      await opened.close();
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("options-narrow.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.getByRole("heading", { name: "服务与账号", exact: true })).toBeVisible();
    await page.getByLabel("当前服务").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#add-toggle")).toBeFocused();
    await expect(page.locator("#add-toggle")).toHaveCSS("outline-color", "rgb(129, 140, 248)");
    await expect(page.locator("#add-toggle")).toHaveCSS("outline-width", "2px");
    await page.screenshot({ path: testInfo.outputPath("options-dark.png"), fullPage: true });

    // 可选的页面内设计审计：使用真实扩展上下文，避免 file:// 误报模块脚本与品牌资源。
    if (process.env.MF_DESIGN_AUDIT_SCRIPT) {
      const script = readFileSync(process.env.MF_DESIGN_AUDIT_SCRIPT, "utf8");
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 900 });
          const report = await page.evaluate(script) as { mustFix: Record<string, unknown>; advisory: Record<string, unknown> };
          await testInfo.attach(`options-audit-${scheme}-${width}`, { body: JSON.stringify(report), contentType: "application/json" });
          // 扩展到其配置服务的 API 请求是项目必要资源，不是设计稿外链依赖。
          const { externalResource: _apiRequests, ...defects } = report.mustFix;
          expect(defects).toEqual({});
        }
      }
    }
  } finally { await ctx.close(); }
});

test("登录与切换账号后概览自动刷新，不显示上个账号的数据", async () => {
  const { ctx, page } = await openOptions(false);
  try {
    await expect(page.locator("#stats")).toContainText("请先登录或重新登录");
    await page.getByLabel("用户名", { exact: true }).fill(FIXTURE_ADMIN.username);
    await page.getByLabel("密码", { exact: true }).fill(FIXTURE_ADMIN.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.locator("#acct-in")).toBeVisible();
    await expectStats(page);
    await page.getByRole("button", { name: "切换账号", exact: true }).click();
    await expect(page.locator("#acct-out")).toBeVisible();
    await expect(page.locator("#stats dd")).toHaveCount(0);
    await expect(page.locator("#stats")).toContainText("请先登录或重新登录");
  } finally { await ctx.close(); }
});

test("切服务作废旧概览与模型请求，新服务不能被旧响应覆写", async () => {
  const { ctx, page } = await openOptions();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    await expectStats(page);
    let started = 0;
    await page.route(`${AUTH_BASE}/api/v1/{stats,settings/providers}`, async (route) => {
      started++;
      await held;
      await route.fulfill({ json: route.request().url().endsWith("/stats")
        ? { total: 99999, folders: 99999, navSites: 99999 }
        : [{ enabled: 1, purpose_models: { organize: "旧服务模型" } }],
      }).catch(() => {}); // 切服主动中止请求，浏览器可已销毁 route。
    });
    await page.getByRole("button", { name: "刷新服务端概览" }).click();
    await expect.poll(() => started).toBe(2);
    await page.getByLabel("当前服务").selectOption(BASE);
    await expect(page.locator("#conn-url")).toHaveText(BASE);
    await expect(page.locator("#stats dd")).toHaveCount(3);
    await expect(page.locator("#about-model")).toHaveText("未配置，使用规则引擎");
    release();
    await expect(page.locator("#stats")).not.toContainText("99999");
    await expect(page.locator("#about-model")).not.toContainText("旧服务模型");
  } finally { release(); await ctx.close(); }
});

test("概览失败可见且刷新重试；慢模型不阻塞统计或本机配置", async () => {
  const { ctx, page } = await openOptions();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    await expectStats(page);
    await page.route(`${AUTH_BASE}/api/v1/stats`, (route) => route.fulfill({ status: 503, json: { error: "test_unavailable" } }));
    await page.getByRole("button", { name: "刷新服务端概览" }).click();
    await expect(page.locator("#stats")).toContainText("HTTP 503");
    await expect(page.locator("#refresh")).toBeEnabled();
    await page.unroute(`${AUTH_BASE}/api/v1/stats`);
    await page.route(`${AUTH_BASE}/api/v1/settings/providers`, async (route) => {
      await held;
      await route.fulfill({ json: [] }).catch(() => {});
    });
    await page.getByRole("button", { name: "刷新服务端概览" }).click();
    await expectStats(page);
    await expect(page.locator("#stats")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#refresh")).toBeDisabled();
    await expect(page.locator("#sync-master")).toBeEnabled();
    await expect(page.locator("#inbox-parent")).toBeEnabled();
    release();
    await expect(page.locator("#refresh")).toBeEnabled();
    await expect(page.locator("#about-model")).toHaveText("未配置，使用规则引擎");
  } finally { release(); await ctx.close(); }
});
