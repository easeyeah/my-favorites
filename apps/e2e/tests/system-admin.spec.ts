/** D73 真浏览器验收：统一登录 + 系统管理完整操作路径。D81：切鉴权 fixture，不再污染真实 dev 库。 */
import { test, expect, chromium } from "@playwright/test";
import { AUTH_BASE, FIXTURE_ADMIN, startAuthServer, stopServer } from "./fixtures";

const SERVER = AUTH_BASE;
const ADMIN = FIXTURE_ADMIN;

test.beforeAll(async () => {
  await startAuthServer();
});
test.afterAll(() => stopServer());

async function login(page: import("@playwright/test").Page, username: string, password: string) {
  await page.goto(`${SERVER}/`);
  await expect(page.locator("#login-username")).toBeVisible();
  await expect(page.locator("#login-server-url")).toBeVisible();
  await page.locator("#login-username").fill(username);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
}

test("系统管理：注册开关 / 添加用户 / 停用恢复 / 导出 / 普通用户权限", async () => {
  test.setTimeout(90_000);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const username = `sys-${Date.now().toString(36).slice(-7)}`;
  const password = "system-e2e-pass-1";
  const adminLogin = await fetch(`${SERVER}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const { token } = (await adminLogin.json()) as { token: string };
  const initialHealth = (await (await fetch(`${SERVER}/healthz`)).json()) as { registrationOpen: boolean };

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await login(page, ADMIN.username, ADMIN.password);
    await page.evaluate(() => { location.hash = "#settings/system"; });
    await expect(page.getByRole("button", { name: "系统管理", exact: true })).toBeVisible();
    await expect(page.getByText("用户与权限", { exact: true })).toBeVisible();

    const registration = page.getByRole("switch", { name: "允许新用户注册" });
    await expect(registration).toHaveAttribute("aria-checked", String(initialHealth.registrationOpen));
    await registration.click();
    await expect.poll(async () => {
      const health = (await (await fetch(`${SERVER}/healthz`)).json()) as { registrationOpen: boolean };
      return health.registrationOpen;
    }).toBe(!initialHealth.registrationOpen);
    await registration.click();
    await expect.poll(async () => {
      const health = (await (await fetch(`${SERVER}/healthz`)).json()) as { registrationOpen: boolean };
      return health.registrationOpen;
    }).toBe(initialHealth.registrationOpen);

    await page.getByRole("button", { name: "添加用户" }).click();
    await page.locator("#new-user-name").fill(username);
    await page.locator("#new-user-password").fill(password);
    await page.getByRole("button", { name: "创建用户" }).click();
    const row = page.locator("li").filter({ hasText: username });
    await expect(row).toBeVisible();
    await expect(row.getByText("普通用户", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: "管理", exact: true }).click();
    await page.getByRole("switch", { name: `停用 ${username}` }).click();
    await page.getByRole("button", { name: "保存更改" }).click();
    await expect(row.getByText("已停用", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: "管理", exact: true }).click();
    await page.getByRole("switch", { name: `停用 ${username}` }).click();
    await page.getByRole("button", { name: "保存更改" }).click();
    await expect(row.getByText("已停用", { exact: true })).toHaveCount(0);

    const downloadPromise = page.waitForEvent("download");
    await row.getByRole("button", { name: "导出", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain(username);

    const memberPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await login(memberPage, username, password);
    await memberPage.evaluate(() => { location.hash = "#settings/system"; });
    await expect(memberPage.getByRole("button", { name: "功能模块", exact: true })).toBeVisible();
    await expect(memberPage.getByRole("button", { name: "系统管理", exact: true })).toHaveCount(0);
  } finally {
    await fetch(`${SERVER}/api/v1/admin/system`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ registrationOpen: initialHealth.registrationOpen }),
    });
    await browser.close();
  }
});
