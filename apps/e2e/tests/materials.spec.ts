/**
 * D61 资料库 E2E：卡片流/类型筛选/详情阅读/Markdown 导出/移出——真服务端全链路。
 * 视频与图片样本凭 URL 形态即时入库（物化为 fire-and-forget，断言轮询等待）；
 * 封面下载依赖外网，E2E 不断言封面（服务端集成测试已覆盖真实下载与魔数嗅探）。
 */
import { expect, test, chromium, type Browser } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const PORT = 3212;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | null = null;
let browser: Browser;
let articleId = "";

const LONG = "资料库端到端验证正文。".repeat(40); // > 200 字，满足「已存全文」阈值

test.beforeAll(async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-materials-"));
  server = spawn("node", [path.resolve(here, "../../server/dist/index.js")], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(PORT),
      MF_ENV: "test",
      WEB_DIST_DIR: path.resolve(here, "../../web/dist"),
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // 预置三类样本：文章（捕获全文）、视频、图片
  const article = (await (
    await fetch(`${BASE}/api/v1/bookmarks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://materials.example/blog/deep-dive", title: "一篇深度文章" }),
    })
  ).json()) as { id: string };
  articleId = article.id;
  await fetch(`${BASE}/api/v1/content/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookmarkId: articleId, l2Text: LONG }),
  });
  await fetch(`${BASE}/api/v1/bookmarks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://www.bilibili.com/video/BV1e2e3v4", title: "一个测试视频" }),
  });
  await fetch(`${BASE}/api/v1/bookmarks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://cdn.example.com/pic/shot.png", title: "一张直链图片" }),
  });
  browser = await chromium.launch({ headless: true });
}, 60_000);

test.afterAll(async () => {
  await browser?.close();
  server?.kill();
});

test("资料库卡片流 + 类型筛选", async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/#materials`);
  await page.waitForLoadState("domcontentloaded");

  // 三张卡出现（文章已存全文 + 视频 + 图片；物化异步，轮询等待）
  await expect(page.locator("button", { hasText: "已存全文" }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("button", { hasText: "一个测试视频" }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("button", { hasText: "一张直链图片" }).first()).toBeVisible({ timeout: 15_000 });

  // 类型筛选：视频 chips 后只剩视频卡，文章卡消失
  await page.locator("button", { hasText: "视频" }).first().click();
  await expect(page.locator("button", { hasText: "一篇深度文章" })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator("button", { hasText: "一个测试视频" }).first()).toBeVisible();
  // 回到全部
  await page.locator("button", { hasText: "全部" }).first().click();
  await page.close();
});

test("详情阅读 + Markdown 导出", async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/#materials`);
  await page.waitForLoadState("domcontentloaded");
  const card = page.locator("button", { hasText: "一篇深度文章" }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();

  // 详情浮层：已存全文徽章 + 正文可见 + 动作齐全
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText("已存全文")).toBeVisible();
  await expect(dialog.getByText(LONG.slice(0, 12)).first()).toBeVisible();
  for (const label of ["打开原页", "导出 Markdown", "移出资料库"]) {
    await expect(dialog.getByRole("button", { name: label })).toBeVisible();
  }

  // 导出 Markdown：下载文件含 front-matter 与正文
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出 Markdown" }).click();
  const dl = await download;
  const stream = await dl.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const md = Buffer.concat(chunks).toString("utf8");
  expect(md.startsWith("---")).toBe(true);
  expect(md).toContain("一篇深度文章");
  expect(md).toContain("https://materials.example/blog/deep-dive");
  expect(md).toContain("资料库端到端验证正文。");
  await page.close();
});

test("移出资料库：卡片消失且书签仍在库", async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/#materials`);
  await page.waitForLoadState("domcontentloaded");
  const card = page.locator("button", { hasText: "一张直链图片" }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "移出资料库" }).click();
  await expect(page.locator("button", { hasText: "一张直链图片" })).toHaveCount(0, { timeout: 10_000 });

  // 书签本体不动：书签库仍可搜到
  await page.goto(`${BASE}/#bookmarks`);
  await page.waitForLoadState("domcontentloaded");
  await expect(
    page.locator('[data-bid]').filter({ hasText: "一张直链图片" }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await page.close();
});
