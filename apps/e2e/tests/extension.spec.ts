/** 扩展浏览器功能测试：SW 存活、newtab 导航渲染、popup UI、书签入库
 *  浏览器：本机 Microsoft Edge（首发目标浏览器，无需下载 chromium） */
import { expect, test } from "@playwright/test";
import { BASE, EXTENSION_PATH, seedViaApi, startServer, stopServer } from "./fixtures";
import { chromium, type BrowserContext } from "@playwright/test";

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  await startServer();
  await seedViaApi(); // 扩展 spec 可能先于 server spec 执行，需自行播种
  // MV3 扩展需要持久 context + chromium headless new 模式
  context = await chromium.launchPersistentContext("", {
    channel: "msedge",
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });
  // 等待 service worker 注册
  let sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  for (let i = 0; i < 40 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 500));
    sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  }
  if (!sw) throw new Error("extension service worker not registered");
  extensionId = new URL(sw.url()).host;
}, 30_000);

test.afterAll(async () => {
  await context.close();
  stopServer();
});

test("扩展 newtab：导航站数据渲染（留存钩子③）", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await expect(page.locator("h1")).toHaveText("我的导航");
  await expect(page.locator("h2", { hasText: "开发" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("a", { hasText: "GitHub 主页" })).toBeVisible();
  // 页脚水印
  await expect(page.locator("footer", { hasText: "my-favorites" })).toBeVisible();
  await page.close();
});

test("扩展 popup：UI 渲染 + 收藏按钮", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator("h1")).toHaveText("my-favorites");
  await expect(page.getByText("收藏（AI 自动归位）")).toBeVisible();
  await expect(page.getByText("丢进收件箱")).toBeVisible();
  await page.close();
});

test("扩展收藏链路：popup 收藏当前页 → 服务端入库 → 就地捕获内容", async () => {
  // 打开一个页面（数据页；扩展对 chrome:// 页面无法注入，用本地服务端自页）
  const page = await context.newPage();
  await page.goto(`${BASE}/s/search?q=seed`);
  // popup 操作走 SW 消息：直接在扩展上下文里模拟 popup 行为
  const sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"))!;
  const result = (await sw.evaluate(async () => {
    // 与 popup 相同契约的 REST 调用（在扩展 SW 上下文中验证 host_permissions 可达）
    const res = await fetch("http://localhost:3000/api/v1/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // SW 上下文的 location 是 chrome-extension://，URL 必须用字面量 http(s)
      body: JSON.stringify({ url: "https://example.com/demo-e2e", title: "E2E 演示页" }),
    });
    return res.json();
  })) as { id: string; suggest?: unknown };
  expect(result.id).toBeTruthy();
  // 就地捕获上行
  const cap = await fetch(`${BASE}/api/v1/content/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bookmarkId: result.id,
      l2Text: "E2E 捕获的正文内容用于内容级搜索验证，包含独特关键词 xyzzy-e2e-marker",
      description: "e2e demo",
    }),
  });
  expect(cap.ok).toBe(true);
  // 内容级搜索能命中捕获正文
  const search = await fetch(`${BASE}/api/v1/search?q=xyzzy-e2e-marker`);
  const body = (await search.json()) as { results: Array<{ id: string }> };
  expect(body.results.some((r) => r.id === result.id)).toBe(true);
  await page.close();
});
