/** 收纳盒显示名回归锁：数据层名自带「📥 」（D36），渲染层必须经 inboxLabel 归一——任何手拼前缀都会造成双图标 */
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

test.beforeAll(async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-inboxlabel-"));
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
  // 真实系统收纳盒目录名 =「📥 收纳盒」（服务端自带前导图标，正是历史双图标来源）
  const inbox = await fetch(`${BASE}/api/v1/inbox/setup`, { method: "POST" });
  const folder = (await inbox.json()) as { name: string };
  expect(folder.name).toBe("📥 收纳盒");
  browser = await chromium.launch({ headless: true });
}, 60_000);

test.afterAll(async () => {
  await browser?.close();
  server?.kill();
});

test("管理台收纳盒节点：图标恰好一个，不出现「📥 📥 收纳盒」", async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/#bookmarks`);
  await page.waitForLoadState("domcontentloaded");
  const node = page.getByRole("button", { name: /收纳盒/ }).first();
  await expect(node).toBeVisible({ timeout: 15_000 });
  const text = (await node.textContent()) ?? "";
  const emojiCount = (text.match(/\u{1F4E5}/gu) ?? []).length;
  expect(emojiCount).toBe(1);
  expect(text.replace(/\s|\d/g, "")).toContain("收纳盒");
  await page.close();
});
