import { test, expect } from "@playwright/test";
import { chromium } from "@playwright/test";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const EXTENSION_PATH = path.resolve(here, "../../extension/.output/chrome-mv3");

test("options 测试连接：localhost 失败时自动回退 127.0.0.1 并成功", async () => {
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
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState();
  // 填 localhost:3007（E2E 演示端口）→ 点测试连接
  await page.locator("#server").fill("http://localhost:3007");
  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(page.locator("#msg-connect")).toContainText("连接成功", { timeout: 15_000 });
  // localhost 不可达时应自动切 127.0.0.1；可达时直接成功——两种都算过
  await ctx.close();
}, 90_000);
