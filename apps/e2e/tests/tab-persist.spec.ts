import { test, expect } from "@playwright/test";

test("管理台 tab 持久化：点击书签→URL hash→刷新后仍在书签页", async ({ page }) => {
  await page.goto("http://127.0.0.1:3007/");
  await page.waitForLoadState();
  await page.evaluate(() =>
    localStorage.setItem("mf-admin-config", JSON.stringify({ serverUrl: "http://127.0.0.1:3007", token: "" })),
  );
  await page.reload();
  await page.waitForLoadState();
  // 点书签 tab
  await page.getByRole("button", { name: "书签", exact: true }).click();
  await page.waitForTimeout(300);
  // URL 应带 #bookmarks
  await expect(page).toHaveURL(/#bookmarks/);
  // 刷新 → 仍在书签页
  await page.reload();
  await page.waitForLoadState();
  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: "书签", exact: true })).toHaveClass(/bg-indigo-600/);
  // 概览 tab 不应处于选中态
  await expect(page.getByRole("button", { name: "概览" })).not.toHaveClass(/bg-indigo-600/);
});
