import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type BrowserContext } from "@playwright/test";

const PORT = 3007;
const BASE = `http://127.0.0.1:${PORT}`;
const here = path.dirname(new URL(import.meta.url).pathname);
const EXTENSION_PATH = path.resolve(here, "../../extension/.output/chrome-mv3");

let server: ChildProcess | null = null;
const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-popup-"));
let context: BrowserContext;

test.beforeAll(async () => {
  server = spawn("node", [path.resolve(here, "../../server/dist/index.js")], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT) },
    stdio: "ignore",
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  context = await chromium.launchPersistentContext("", {
    channel: "msedge",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
}, 90_000);

test.afterAll(async () => {
  await context?.close();
  server?.kill();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

test("导入入口：onboarding 引导页 + options 收藏夹双向同步总开关（原型 01；D46 起 options 数据迁移卡收敛为同步开关）", async () => {
  let sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  for (let i = 0; i < 120 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 500));
    sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  }
  const extId = new URL(sw!.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/welcome.html`);
  await page.waitForLoadState();
  await page.waitForTimeout(400);
  await expect(page.getByText("直接读取浏览器书签")).toBeVisible();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState();
  await page.waitForTimeout(400);
  await expect(page.getByText("收藏夹双向同步")).toBeVisible();
  await expect(page.locator("#sync-master")).toBeAttached();
  await expect(page.getByRole("button", { name: "立即同步" })).toBeVisible();
  // D46 退役入口不再出现
  await expect(page.getByText("一键导入浏览器全部书签")).toHaveCount(0);
  await expect(page.getByText("反向同步到浏览器")).toHaveCount(0);
  await expect(page.getByText("按管理台顺序重排浏览器书签")).toHaveCount(0);
}, 90_000);
