/** 操作日志：演示模式中文动作；浏览器分页/错误恢复，不写入真实业务数据。 */
import { test, expect } from "@playwright/test";
import { BASE, startServer, stopServer } from "./fixtures";

test.beforeAll(() => startServer());
test.afterAll(() => stopServer());

test("操作日志：中文说明、分页、失败重试与刷新回首页", async ({ page }) => {
  await page.goto(`${BASE}/?mock#settings/audit`);
  await expect(page.getByText("关闭公开注册", { exact: true })).toBeVisible();
  await expect(page.getByText("注册设置", { exact: true })).toBeVisible();
  await expect(page.getByText("system.registration_changed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "上一页", exact: true })).toBeDisabled();
  const firstRow = page.getByRole("list", { name: "操作日志列表" }).locator("li > div.flex").first();
  await firstRow.hover();
  await expect.poll(() => firstRow.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({ path: "test-results/audit-mock.png", fullPage: true });

  // 保留 mock 的其他 API，仅将 audit 替换为可分页的 53 条测试响应。
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    let fail = false;
    (window as unknown as { auditFail: () => void }).auditFail = () => { fail = true; };
    window.fetch = async (input, init) => {
      const url = String(input);
      if (!url.includes("/api/v1/audit")) return original(input, init);
      if (fail) { fail = false; return new Response("{}", { status: 500 }); }
      const parsed = new URL(url, location.origin);
      const current = Number(parsed.searchParams.get("page") || 1);
      const events = Array.from({ length: 53 }, (_, i) => ({
        id: i, eventId: `test:${i}`, kind: i === 0 ? "future.event" : "system.registration_changed",
        detail: `测试操作 ${i + 1}`, source: "本机", created_at: new Date().toISOString(),
      })).slice((current - 1) * 25, current * 25);
      return Response.json({ events, total: 53, page: current, pageSize: 25, totalPages: 3 });
    };
  });
  // API mock 在 apiCall 内拦截，切到真实配置但复用上面的 fetch 替身。
  await page.evaluate(() => { history.replaceState(null, "", "/?nomock#settings/audit"); });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByText("共 53 条 · 第 1 / 3 页 · 每页 25 条")).toBeVisible();
  await expect(page.getByText("其他操作", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "操作日志列表" }).locator("li")).toHaveCount(25);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("测试操作 26", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("list", { name: "操作日志列表" }).locator("li")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { auditFail: () => void }).auditFail());
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("操作日志加载失败");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("共 53 条 · 第 1 / 3 页 · 每页 25 条")).toBeVisible();
  await page.screenshot({ path: "test-results/audit-pagination.png", fullPage: true });
});
