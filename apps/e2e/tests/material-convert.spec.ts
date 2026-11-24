/** D91：真实浏览器收纳盒投递 → 自动转资料 → 浏览器节点消失 → 恢复后重建。
 * 使用独立鉴权 fixture，不修改真实开发库；视频识别不依赖 LLM 或外网抓取。
 */
import { test, expect, chromium, type Page } from "@playwright/test";
import { AUTH_BASE, EXTENSION_PATH, FIXTURE_ADMIN, pointExtensionTo, startAuthServer, stopServer } from "./fixtures";

let adminToken = "";
test.beforeAll(async () => {
  await startAuthServer();
  const res = await fetch(`${AUTH_BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(FIXTURE_ADMIN),
  });
  expect(res.ok).toBe(true);
  adminToken = ((await res.json()) as { token: string }).token;
});
test.afterAll(() => stopServer());

async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AUTH_BASE}/api/v1${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}`, ...init?.headers },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${pathname}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function browserNodes(page: Page, url: string) {
  return page.evaluate(async (target) => {
    const nodes = await chrome.bookmarks.search({ url: target });
    return nodes.map((n) => ({ id: n.id, parentId: n.parentId, title: n.title }));
  }, url);
}

for (const { kind, syncEnabled } of [
  { kind: "video", syncEnabled: true },
  { kind: "image", syncEnabled: true },
  { kind: "video", syncEnabled: false },
] as const) {
test(`D91 收纳盒${kind === "video" ? "视频" : "图片"}自动转资料：${syncEnabled ? "节点消失，资料页恢复后重建" : "默认关闭同步仍清理投递口，恢复不绕过开关"}`, async () => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString(36);
  const title = `验收D91${kind}·${suffix}`;
  const url = kind === "video"
    ? `https://www.bilibili.com/video/BV${suffix}`
    : `https://cdn.example.org/d91-${suffix}.png`;
  const ctx = await chromium.launchPersistentContext("", {
    channel: "msedge",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    viewport: { width: 1100, height: 900 },
  });
  try {
    const sw = ctx.serviceWorkers().find((worker) => worker.url().startsWith("chrome-extension://"))
      ?? await ctx.waitForEvent("serviceworker");
    const extId = new URL(sw.url()).host;
    const attachLog = (worker: import("@playwright/test").Worker) => worker.on("console", (message) => {
      if (message.type() === "error" || /\[(sync|inbox|mirror)\]/.test(message.text())) {
        console.log("[extension]", message.text());
      }
    });
    attachLog(sw);
    ctx.on("serviceworker", attachLog);
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await pointExtensionTo(page, AUTH_BASE);
    await page.getByPlaceholder("alice").fill(FIXTURE_ADMIN.username);
    await page.locator("#cloud-pw").fill(FIXTURE_ADMIN.password);
    await page.locator("#cloud-login").click();
    await expect(page.locator("#acct-in")).toBeVisible();

    await page.getByRole("button", { name: "创建收纳盒" }).click();
    await expect.poll(() => page.evaluate(async () => {
      const { inboxExtId } = await chrome.storage.local.get("inboxExtId");
      return String(inboxExtId ?? "");
    })).not.toBe("");
    const inboxId = await page.evaluate(async () => String((await chrome.storage.local.get("inboxExtId")).inboxExtId));
    if (syncEnabled) {
      await page.locator("#sync-master").check();
      await expect(page.locator("#msg-sync")).toContainText("已开启", { timeout: 15_000 });
    } else {
      await expect(page.locator("#sync-master")).not.toBeChecked();
    }

    // 原生书签创建成功就是投递完成；不等待它在盒内停留，自动分类可能立即完成。
    const created = await page.evaluate(async (item) => {
      return chrome.bookmarks.create(item);
    }, { parentId: inboxId, title, url });
    expect(created.id).toBeTruthy();
    expect(created.parentId).toBe(inboxId);

    type Material = { id: string; bookmark_id: string; materialized: number; title: string; type: string };
    let material: Material | undefined;
    await expect.poll(async () => {
      const result = await api<{ items: Material[] }>(`/materials?q=${encodeURIComponent(title)}`);
      material = result.items.find((item) => item.title === title);
      return material?.materialized ?? 0;
    }, { timeout: 45_000, intervals: [300, 500, 1000] }).toBe(1);

    expect(material?.type).toBe(kind);

    // 数据仍保存，书签面与同步快照不再暴露（不是仅把条目移出收纳盒）。
    const bookmarks = await api<{ results: Array<{ id: string }> }>(`/search?q=${encodeURIComponent(title)}`);
    expect(bookmarks.results.some((b) => b.id === material!.bookmark_id)).toBe(false);
    const snapshot = await api<{ bookmarks: Array<{ id: string }> }>("/sync/snapshot");
    expect(snapshot.bookmarks.some((b) => b.id === material!.bookmark_id)).toBe(false);
    if (!syncEnabled) {
      // 触发既有每分钟收纳盒 alarm，验证 count=0 时仍会收敛已转换的投递节点。
      await page.evaluate(() => chrome.alarms.create("mf-inbox-sweep", { when: Date.now() + 50 }));
    }
    await expect.poll(() => browserNodes(page, url), { timeout: 30_000 }).toHaveLength(0);

    // 管理台真实操作：资料仍可见，恢复按钮不与「移出资料库」混淆。
    const web = await ctx.newPage();
    await web.goto(`${AUTH_BASE}/#materials`);
    await web.getByPlaceholder("alice").fill(FIXTURE_ADMIN.username);
    await web.getByLabel("密码", { exact: true }).fill(FIXTURE_ADMIN.password);
    await web.getByRole("button", { name: "登录", exact: true }).click();
    await web.goto(`${AUTH_BASE}/#materials`);
    const row = web.locator("li").filter({ hasText: title });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("button", { name: /恢复为书签/ })).toBeVisible();
    await row.getByRole("button", { name: /恢复为书签/ }).click();
    await expect(row.getByTitle("移出资料库（书签保留）")).toBeVisible();
    if (syncEnabled) {
      await expect.poll(() => browserNodes(page, url), { timeout: 30_000 }).toHaveLength(1);
      await page.locator("#sync-master").uncheck();
    } else {
      expect(await browserNodes(page, url)).toHaveLength(0);
      await expect(page.locator("#sync-master")).not.toBeChecked();
    }
    const restoredMaterial = await api<{ materialized: number }>(`/materials/${material!.id}`);
    expect(restoredMaterial.materialized).toBe(0);
    const restoredBookmarks = await api<{ results: Array<{ id: string }> }>(`/search?q=${encodeURIComponent(title)}`);
    expect(restoredBookmarks.results.some((b) => b.id === material!.bookmark_id)).toBe(true);
  } finally {
    await ctx.close();
  }
});
}
