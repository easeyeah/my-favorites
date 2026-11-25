/**
 * D61/D64 资料库 E2E：行式列表/类型筛选/分类标签/行内导出/移出——真服务端全链路。
 * D64 起页面为行式列表（AI 一等消费面走 MCP，人是次要观众），行内展示分类标签与信号。
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

  // D91：此套验证既有资料消费/移出语义，样本显式放普通目录；收纳盒自动转换另有专用端到端用例。
  const folderRes = await fetch(`${BASE}/api/v1/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "资料消费样本" }),
  });
  expect(folderRes.ok).toBe(true);
  const { id: folderId } = await folderRes.json() as { id: string };
  // 预置三类样本：文章（捕获全文）、视频、图片
  const article = (await (
    await fetch(`${BASE}/api/v1/bookmarks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://materials.example/blog/deep-dive", title: "一篇深度文章", folderId }),
    })
  ).json()) as { id: string };
  await fetch(`${BASE}/api/v1/content/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookmarkId: article.id, l2Text: LONG }),
  });
  await fetch(`${BASE}/api/v1/bookmarks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://www.bilibili.com/video/BV1e2e3v4", title: "一个测试视频", folderId }),
  });
  await fetch(`${BASE}/api/v1/bookmarks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://cdn.example.com/pic/shot.png", title: "一张直链图片", folderId }),
  });
  browser = await chromium.launch({ headless: true });
}, 60_000);

test.afterAll(async () => {
  await browser?.close();
  server?.kill();
});

const row = (page: import("@playwright/test").Page, title: string) =>
  page.locator("li", { hasText: title }).first();

test("资料库行式列表 + 类型筛选（计数 chips）", async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/#materials`);
  await page.waitForLoadState("domcontentloaded");

  // 三行出现（物化异步，轮询等待）
  await expect(row(page, "一篇深度文章")).toBeVisible({ timeout: 15_000 });
  await expect(row(page, "一个测试视频")).toBeVisible({ timeout: 15_000 });
  await expect(row(page, "一张直链图片")).toBeVisible({ timeout: 15_000 });

  // 文章行带「已存全文」徽章；左侧分面面板（分类树）可见；MCP 提示已移入设置页（D66）
  await expect(row(page, "一篇深度文章").getByText("已存全文")).toBeVisible();
  await expect(page.locator("aside").getByText("全部资料")).toBeVisible();

  // 类型筛选：视频 chips 后文章行消失
  await page.locator("button", { hasText: "视频" }).first().click();
  await expect(row(page, "一篇深度文章")).toHaveCount(0, { timeout: 10_000 });
  await expect(row(page, "一个测试视频")).toBeVisible();
  await page.locator("button", { hasText: "全部" }).first().click();
  await page.close();
});

test("行内导出 Markdown（front-matter + 全文）", async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/#materials`);
  await page.waitForLoadState("domcontentloaded");
  const articleRow = row(page, "一篇深度文章");
  await expect(articleRow).toBeVisible({ timeout: 15_000 });

  const download = page.waitForEvent("download");
  await articleRow.getByTitle("导出 Markdown").click();
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

test("移出资料库：行消失且书签仍在库", async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/#materials`);
  await page.waitForLoadState("domcontentloaded");
  const imageRow = row(page, "一张直链图片");
  await expect(imageRow).toBeVisible({ timeout: 15_000 });
  await imageRow.getByTitle("移出资料库（书签保留）").click();
  await expect(row(page, "一张直链图片")).toHaveCount(0, { timeout: 10_000 });

  // 书签本体不动：书签库仍可搜到
  await page.goto(`${BASE}/#bookmarks`);
  await page.waitForLoadState("domcontentloaded");
  await expect(
    page.locator('[data-bid]').filter({ hasText: "一张直链图片" }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await page.close();
});
