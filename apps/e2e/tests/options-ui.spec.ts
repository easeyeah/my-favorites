import { test, expect } from "@playwright/test";
import { chromium } from "@playwright/test";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const EXTENSION_PATH = path.resolve(here, "../../extension/.output/chrome-mv3");

test("options 页现代 UI 截图", async () => {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "msedge",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    viewport: { width: 720, height: 900 },
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
  await page.waitForTimeout(400);
  // 关键元素验证
  await expect(page.getByRole("heading", { name: "my-favorites" })).toBeVisible();
  await expect(page.getByText("一键导入浏览器全部书签")).toBeVisible();
  await page.screenshot({ path: "/tmp/options-redesign.png", fullPage: true });
  await ctx.close();
}, 90_000);
