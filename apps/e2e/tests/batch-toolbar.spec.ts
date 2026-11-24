/** 多选批量工具栏：顶替顶部状态 chips，列表位置保持不动（用户 2026-11-23 反馈）。D81：?mock 页改由 fixture 托管。 */
import { test, expect, chromium } from "@playwright/test";
import { BASE, startServer, stopServer } from "./fixtures";

test.beforeAll(async () => {
  await startServer();
});
test.afterAll(() => stopServer());

test("多选：批量条替换状态 chips、列表不位移、取消后恢复", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/?mock#bookmarks`);
  const firstRow = page.locator("li[data-bid]").first();
  await expect(firstRow).toBeVisible();

  const yBefore = (await firstRow.boundingBox())!.y;
  const chips = page.getByRole("button", { name: "失效", exact: true });
  await expect(chips).toBeVisible();

  // 勾选两行：hover 行让复选框显现后点击，并逐次确认选中态
  await firstRow.hover();
  await firstRow.getByRole("checkbox").click();
  await expect(firstRow.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
  const secondRow = page.locator("li[data-bid]").nth(1);
  await secondRow.hover();
  await secondRow.getByRole("checkbox").click();
  await expect(secondRow.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");

  const batch = page.getByText(/^已选 2 条$/);
  await expect(batch).toBeVisible();
  await expect(chips).toHaveCount(0); // 多选时状态筛选不再出现
  await expect(page.getByRole("button", { name: "移动到…", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "归档", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除", exact: true })).toBeVisible();

  // 核心断言：列表首行位置与多选前完全一致（工具条不再把列表往下推）
  const yAfter = (await firstRow.boundingBox())!.y;
  expect(Math.abs(yAfter - yBefore)).toBeLessThan(1);

  // 批量条与原 chips 同处顶行（y 接近原筛选区，而非列表上方新增一行）
  const batchBox = (await batch.boundingBox())!;
  expect(batchBox.y).toBeLessThan(yBefore);

  // 取消选择 → chips 恢复、列表仍不动
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(chips).toBeVisible();
  await expect(page.getByText(/^已选/)).toHaveCount(0);
  const yRestored = (await firstRow.boundingBox())!.y;
  expect(Math.abs(yRestored - yBefore)).toBeLessThan(1);

  await browser.close();
});
