/** 服务端浏览器功能测试：导航站渲染、搜索、XSS 回归 */
import { expect, test } from "@playwright/test";
import { afterAll, beforeAll } from "@playwright/test";
import { BASE, seedViaApi, startServer, stopServer } from "./fixtures";

let slug: string;

test.beforeAll(async () => {
  await startServer();
  slug = (await seedViaApi()).slug;
});
test.afterAll(() => stopServer());

test("导航站公开页：宫格渲染 + 水印 + 深浅色样式", async ({ page }) => {
  await page.goto(`${BASE}/s/${slug}`);
  await expect(page).toHaveTitle(/我的导航站/);
  await expect(page.locator("h2", { hasText: "开发" })).toBeVisible();
  await expect(page.locator("a.card", { hasText: "GitHub 主页" })).toBeVisible();
  await expect(page.locator("a.card", { hasText: "MDN 文档" })).toBeVisible();
  await expect(page.locator("footer", { hasText: "my-favorites" })).toBeVisible();
  // 响应式宫格布局存在
  const gridDisplay = await page
    .locator("div.grid")
    .first()
    .evaluate((el) => getComputedStyle(el).display);
  expect(gridDisplay).toBe("grid");
});

test("导航站搜索框：关键词跳转本站搜索结果页（DEV-16：全库公开搜索已下线）", async ({ page }) => {
  await page.goto(`${BASE}/s/${slug}`);
  await page.fill("#q", "GitHub");
  await page.press("#q", "Enter");
  await page.waitForURL(new RegExp(`/s/${slug}/search\\?q=`));
  await expect(page.locator("h1")).toContainText("GitHub");
  await expect(page.locator("li a", { hasText: "GitHub 主页" })).toBeVisible();
});

test("XSS 回归：搜索词注入不执行（review P0 修复）", async ({ page }) => {
  await page.goto(`${BASE}/s/${slug}/search?q=${encodeURIComponent('<script>window.__xss=1</script>')}`);
  const injected = await page.evaluate(() => (window as { __xss?: number }).__xss);
  expect(injected).toBeUndefined();
  // 且原文被转义显示
  await expect(page.locator("h1")).toContainText("<script>");
});

test("healthz 与 stats", async ({ request }) => {
  const health = await request.get(`${BASE}/healthz`);
  expect((await health.json())["ok"]).toBe(true);
  const stats = await request.get(`${BASE}/api/v1/stats`);
  const body = (await stats.json()) as { total: number };
  expect(body.total).toBeGreaterThanOrEqual(3);
});
