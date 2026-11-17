import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const PORT = 3007;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | null = null;
const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-tabpersist-"));

test.beforeAll(async () => {
  // 自带 server（管理台托管在同进程）；A4-1 后测试语义需显式 MF_ENV=test
  const here = path.dirname(new URL(import.meta.url).pathname);
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

test("管理台 tab 持久化：点击书签→URL hash→刷新后仍在书签页", async ({ page }) => {
  await page.goto(`${BASE}/`);
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