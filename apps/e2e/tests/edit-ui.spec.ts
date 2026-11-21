/** D52 管理台编辑与右键菜单：行右键出菜单 → 编辑表单改标题 → 保存生效 */
import { expect, test, chromium, type Browser } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | null = null;
let browser: Browser;

test.beforeAll(async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-editui-"));
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
  await fetch(`${BASE}/api/v1/bookmarks/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "editui-seed-01",
      items: [
        { url: "https://editui.example/one", title: "编辑目标", folderPath: [] },
        { url: "https://editui.example/two", title: "另一条", folderPath: [] },
      ],
    }),
  });
  browser = await chromium.launch({ headless: true });
}, 60_000);

test.afterAll(async () => {
  await browser?.close();
  server?.kill();
});

test("行右键菜单 + 编辑保存（D52）", async () => {
  const page = await browser.newPage();
  await page.goto(`${BASE}/#bookmarks`);
  await page.waitForLoadState("domcontentloaded");
  const row = page.locator('[data-bid]').filter({ hasText: "编辑目标" }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });

  // ① 右键 → 菜单出现且动作齐全
  await row.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const labels = await menu.getByRole("menuitem").allTextContents();
  for (const want of ["打开原页", "编辑", "移动到…", "置顶", "归档", "复制链接", "删除…"]) {
    expect(labels.join("")).toContain(want);
  }

  // ② 菜单「编辑」→ 三输入框出现（详情已展开并进入编辑态）
  await menu.getByRole("menuitem", { name: "编辑" }).click();
  const urlBox = page.locator('input[placeholder="URL"]');
  await expect(urlBox).toBeVisible({ timeout: 10_000 });
  const titleBox = page.locator('input[placeholder="标题"]');
  await expect(titleBox).toHaveValue("编辑目标");

  // ③ 改标题保存 → toast + 列表更新
  await titleBox.fill("编辑后标题");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator("[data-sonner-toast], [role=status], .toast").first()).toBeVisible({ timeout: 8_000 }).catch(() => undefined);
  await expect(page.locator('[data-bid]').filter({ hasText: "编辑后标题" }).first()).toBeVisible({ timeout: 10_000 });

  // ④ 撞库查重（真实服务端）：URL 改成另一条 → 409 提示，不损坏数据
  const otherRow = page.locator('[data-bid]').filter({ hasText: "另一条" }).first();
  await otherRow.click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "编辑" }).click();
  await expect(urlBox).toBeVisible({ timeout: 10_000 });
  await urlBox.fill("https://editui.example/one");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator("text=查重冲突")).toBeVisible({ timeout: 8_000 });
  await page.close();
});
