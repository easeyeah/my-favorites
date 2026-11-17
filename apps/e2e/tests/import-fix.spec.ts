import { test, expect } from "@playwright/test";
import { chromium } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const here = path.dirname(new URL(import.meta.url).pathname);
const EXTENSION_PATH = path.resolve(here, "../../extension/.output/chrome-mv3");
const PORT = 3007;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | null = null;
const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-importfix-"));

test.beforeAll(async () => {
  // 自带 server（不依赖其他 spec 的启动顺序）；A4-1 后测试语义需显式 MF_ENV=test
  server = spawn("node", [path.resolve(here, "../../server/dist/index.js")], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), MF_ENV: "test" },
    stdio: "ignore",
  });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}, 60_000);

test.afterAll(async () => {
  server?.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

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

  // 打开 options 页 → 指向本 spec 的 server → 保存 → 点导入按钮 → 断言成功反馈出现
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState();
  await page.locator("#server").fill(BASE);
  await page.getByRole("button", { name: "保存" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "一键导入浏览器全部书签" }).click();
  // 关键断言：不再是"导入中…"卡住，而是出现 ✅ 成功反馈（含 3 条）
  await expect(page.locator("#msg-data")).toContainText("已导入", { timeout: 20_000 });
  const feedback = await page.locator("#msg-data").textContent();
  expect(feedback).toContain("3");

  // 服务端确实有数据
  const stats = (await (
    await fetch(`${BASE}/api/v1/stats`)
  ).json()) as { total: number };
  expect(stats.total).toBeGreaterThanOrEqual(3);
  await ctx.close();
}, 120_000);
