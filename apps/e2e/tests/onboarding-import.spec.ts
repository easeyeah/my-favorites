/**
 * 安装引导导入 E2E（2026-11-23 自主评审 R1 回归锁）。
 *
 * welcome 页「直接读取浏览器书签」真实跑完一遍导入（真服务端 + 未打包扩展），断言库侧目录层级成立：
 * 旧实现按「path 是否为空」判虚拟根，逐层命中同一条件——所有书签 folderPath 恒为 []，
 * 父 / 子目录根本不会建出来，本用例会红。同时锁定「一条超长标题不会让整批 400」。
 *
 * 隔离：鉴权 fixture（3008）+ 全新数据目录，不触碰真实库（D81 §5 批量一的口径）。
 */
import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { AUTH_BASE, EXTENSION_PATH, FIXTURE_ADMIN, startAuthServer, stopServer } from "./fixtures";

let adminToken = "";
let context: BrowserContext;

test.beforeAll(async () => {
  await startAuthServer();
  const r = await fetch(`${AUTH_BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(FIXTURE_ADMIN),
  });
  adminToken = ((await r.json()) as { token: string }).token;
});

test.afterAll(async () => {
  await context?.close();
  stopServer();
});

const api = async (pathName: string): Promise<unknown> => {
  const r = await fetch(`${AUTH_BASE}/api/v1${pathName}`, { headers: { authorization: `Bearer ${adminToken}` } });
  if (!r.ok) throw new Error(`api ${pathName} failed: HTTP ${r.status}`);
  return await r.json();
};
type LibFolder = { id: string; name: string; parent_id: string | null };
type LibBookmark = { id: string; title: string; url_raw: string; folder_id: string };

/** 在扩展页里操作真实浏览器书签树（扩展页具备 bookmarks 权限） */
const createBookmark = (page: import("@playwright/test").Page, parentId: string, title: string, url?: string) =>
  page.evaluate(
    (m) =>
      new Promise<string>((resolve) =>
        chrome.bookmarks.create({ parentId: m.parentId, title: m.title, ...(m.url ? { url: m.url } : {}) }, (n) =>
          resolve(n.id),
        ),
      ),
    { parentId, title, url },
  );

test("welcome「直接读取浏览器书签」：多级目录入库 + 超长标题不炸批次", async () => {
  context = await chromium.launchPersistentContext("", {
    channel: "msedge",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    viewport: { width: 1024, height: 900 },
  });
  let sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  for (let i = 0; i < 120 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 500));
    sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  }
  const extId = new URL(sw!.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/welcome.html`);
  await page.waitForLoadState();

  // 连接配置写进扩展 storage（welcome 页自己的 api() 也读它），再 reload 让页面读到
  await page.evaluate(
    (cfg) => new Promise<void>((resolve) => chrome.storage.local.set(cfg, () => resolve())),
    {
      serverUrl: AUTH_BASE,
      activeServer: AUTH_BASE,
      token: adminToken,
      servers: [{ url: AUTH_BASE, label: "e2e", mode: "self" }],
    },
  );
  await page.reload();
  await page.waitForLoadState();

  const stamp = Date.now();
  const parentTitle = `验收目录${stamp}`;
  const childTitle = `子目录${stamp}`;
  const deepUrl = `https://welcome-${stamp}.test/deep`;
  const rootUrl = `https://welcome-${stamp}.test/root`;
  const longUrl = `https://welcome-${stamp}.test/long`;
  const longTitle = "超长标题".repeat(200); // 800 字符，远超 schema 512

  const parentId = await createBookmark(page, "1", parentTitle);
  const childId = await createBookmark(page, parentId, childTitle);
  await createBookmark(page, childId, "深链书签", deepUrl);
  await createBookmark(page, "1", "根书签", rootUrl);
  await createBookmark(page, "1", longTitle, longUrl);

  await expect(page.getByText("直接读取浏览器书签")).toBeVisible();
  await page.getByRole("button", { name: /直接读取浏览器书签/ }).click();
  // 走完导入 + 规则整理进入 Aha 页（无 LLM 时规则引擎仍能跑；整理失败也应显示导入完成）
  await expect(page.getByRole("heading", { name: /已经帮你整理好了|书签已经导入完成/ })).toBeVisible({
    timeout: 120_000,
  });

  const folders = (await api("/folders")) as LibFolder[];
  const parent = folders.find((f) => f.name === parentTitle);
  const child = folders.find((f) => f.name === childTitle);
  // R1：目录层级成立（旧实现的 folderPath 恒为 []，两个目录都不会存在）
  expect(parent, "父目录应由导入创建在库根").toBeTruthy();
  expect(parent!.parent_id).toBeNull();
  expect(child?.parent_id).toBe(parent!.id);

  const bookmarks = (await api("/bookmarks?limit=2000")) as LibBookmark[];
  expect(bookmarks.some((b) => b.url_raw === deepUrl)).toBe(true);
  expect(bookmarks.some((b) => b.url_raw === rootUrl)).toBe(true);
  // R4：超长标题被截断后仍然入库（未被截断时 schema 校验会让整批 400，导入停在失败页）
  const long = bookmarks.find((b) => b.url_raw === longUrl);
  expect(long, "超长标题不应导致整批 400").toBeTruthy();
  expect(long!.title.length).toBeLessThanOrEqual(200);
}, 180_000);
