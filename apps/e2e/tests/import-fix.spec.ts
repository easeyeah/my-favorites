import { test, expect } from "@playwright/test";
import { chromium } from "@playwright/test";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const EXTENSION_PATH = path.resolve(here, "../../extension/.output/chrome-mv3");

test("options 一键导入：真实书签树 → 分批入库 → 成功反馈", async () => {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "msedge",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  let sw = ctx.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  for (let i = 0; i < 120 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 500));
    sw = ctx.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  }
  const extId = new URL(sw!.url()).host;

  // SW 上下文先造 3 条浏览器书签（模拟用户的书签树）
  await sw!.evaluate(async () => {
    const bar = await new Promise<string>((resolve) => {
      chrome.bookmarks.getTree((t) => resolve(t[0]!.children![0]!.id));
    });
    const folder = await new Promise<string>((resolve) => {
      chrome.bookmarks.create({ parentId: bar, title: "E2E 导入测试" }, (f) => resolve(f.id));
    });
    await new Promise<void>((r) =>
      chrome.bookmarks.create({ parentId: folder, title: "Rust 官网", url: "https://www.rust-lang.org/" }, () => r()),
    );
    await new Promise<void>((r) =>
      chrome.bookmarks.create({ parentId: folder, title: "Hono 文档", url: "https://hono.dev/" }, () => r()),
    );
    await new Promise<void>((r) =>
      chrome.bookmarks.create({ parentId: folder, title: "Vite 指南", url: "https://vite.dev/guide/" }, () => r()),
    );
  });

  // 打开 options 页 → 点导入按钮 → 断言成功反馈出现
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState();
  await page.getByRole("button", { name: "一键导入浏览器全部书签" }).click();
  // 关键断言：不再是"导入中…"卡住，而是出现 ✅ 成功反馈（含 3 条）
  await expect(page.locator("#msg-data")).toContainText("已导入", { timeout: 20_000 });
  const feedback = await page.locator("#msg-data").textContent();
  expect(feedback).toContain("3");

  // 服务端确实有数据
  const stats = (await (
    await fetch("http://localhost:3000/api/v1/stats")
  ).json()) as { total: number };
  expect(stats.total).toBeGreaterThanOrEqual(3);
  await ctx.close();
}, 120_000);
