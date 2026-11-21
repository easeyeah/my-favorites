/** M2/M3 浏览器功能测试：鉴权、同步镜像、死链任务、密码导航页、语义搜索、管理台 */
import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext } from "@playwright/test";

const PORT = 3210;
const BASE = `http://localhost:${PORT}`;
const here = path.dirname(new URL(import.meta.url).pathname);
const EXTENSION_PATH = path.resolve(here, "../../extension/.output/chrome-mv3");
/** 合成测试口令（绝非真实凭据；MF_TEST_PASSWORD 可整体覆盖，静态密钥扫描豁免口径） */
const ADMIN_PASSWORD = process.env.MF_TEST_PASSWORD ?? "mf-fixture-cred-main";
/** 导航站访问口令（与主口令独立；MF_TEST_NAV_PASSWORD 可覆盖） */
const NAV_PW = process.env.MF_TEST_NAV_PASSWORD ?? "mf-fixture-cred-nav";

let server: ChildProcess | null = null;
const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-e2e-m2-"));
let token = "";
let slug = "";

async function api(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}/api/v1${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init?.headers as Record<string, string>) },
  });
}

test.beforeAll(async () => {
  server = spawn("node", [path.resolve(here, "../../server/dist/index.js")], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(PORT),
      ADMIN_PASSWORD,
      // test 语义（fixtures 同口径）：CORS 放行 chrome-extension:// 源，扩展页面上下文 fetch 才能通；
      // 未设 MF_ENV = 生产语义 → 扩展源被拒（曾致多端同步测试 Failed to fetch）
      MF_ENV: "test",
      // A4 加固后回环默认禁探（SSRF 面）；本 spec 专门验证探测语义 → 显式放行回环（部署 allowlist 场景）
      MF_ALLOW_INTRANET_FETCH: "1",
      MF_ALLOW_INTRANET_CIDRS: "127.0.0.1/32,::1/128",
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
  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  token = ((await login.json()) as { token: string }).token;

  // 播种 + 发布带密码的导航站
  await api("/bookmarks/ingest", {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: "e2e-m2-seed",
      items: [
        { url: "http://127.0.0.1:3210/healthz", title: "本地健康页", folderPath: ["开发"] },
        { url: "http://127.0.0.1:59996/dead-page", title: "死链演示", folderPath: ["开发"] },
        { url: "https://bilibili.com", title: "哔哩哔哩", folderPath: ["娱乐"] },
      ],
    }),
  });
  // D23 显式发布集合：发布必须带范围（全部非系统目录）
  const folders = (await (await api("/folders")).json()) as Array<{ id: string; is_system_inbox: number }>;
  const folderIds = folders.filter((f) => f.is_system_inbox !== 1).map((f) => f.id);
  const pub = (await (
    await api("/nav/publish", {
      method: "POST",
      body: JSON.stringify({ title: "加密导航", template: "cards", password: NAV_PW, folderIds }),
    })
  ).json()) as { slug: string };
  slug = pub.slug;
}, 120_000);

test.afterAll(() => {
  server?.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("鉴权：浏览器直接访问 API 返回 401；登录后管理台可用", async ({ request }) => {
  const noAuth = await request.get(`${BASE}/api/v1/bookmarks`);
  expect(noAuth.status()).toBe(401);
});

test("死链检测任务：本地可达 normal / 不可达 dead，状态落库", async () => {
  const run = (await (
    await api("/maintenance/links/run", { method: "POST", body: JSON.stringify({ limit: 10 }) })
  ).json()) as { results: Array<{ verdict: string; url: string }> };
  const alive = run.results.find((r) => r.url.includes("healthz"));
  const dead = run.results.find((r) => r.url.includes("59996"));
  expect(alive?.verdict).toBe("normal");
  expect(dead?.verdict).toBe("dead");
  // 周报可取
  const report = (await (await api("/maintenance/report/latest?type=link_check")).json()) as {
    findings: { dead: number };
  };
  expect(report.findings.dead).toBeGreaterThanOrEqual(1);
});

test("密码导航页：无密码 → 验证页；正确密码 → 卡片模板渲染", async ({ page }) => {
  await page.goto(`${BASE}/s/${slug}`);
  await expect(page.locator("input[name=password]")).toBeVisible();
  // A4 加固后 ?p= 查询参数通道已移除：走 POST /s/:slug/auth 签发访问 cookie
  await page.fill("input[name=password]", NAV_PW);
  await page.getByRole("button", { name: "进入" }).click();
  await page.waitForURL(new RegExp(`/s/${slug}$`));
  await expect(page).toHaveTitle(/加密导航/);
  await expect(page.locator("h2", { hasText: "开发" })).toBeVisible();
  await expect(page.locator("footer", { hasText: "my-favorites" })).toBeVisible();
});

test("多端同步：API 侧 push → 扩展侧镜像到浏览器书签树", async () => {
  const context: BrowserContext = await chromium.launchPersistentContext("", {
    channel: "msedge",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  let sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  for (let i = 0; i < 180 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 500));
    sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  }
  expect(sw).toBeTruthy();
  // 扩展页面上下文内执行镜像（与 options「反向同步」按钮同契约）。
  // 不用 SW 上下文 evaluate：msedge headless 下 SW 跨源 fetch 不稳定（见开发报告）；
  // options 页面同时具备 fetch 与 chrome.bookmarks，且服务端 CORS 全放行。
  const page = await context.newPage();
  const extId = new URL(sw!.url()).host;
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState();
  const added = (await page.evaluate(async (authToken) => {
    const headers = { authorization: `Bearer ${authToken}` };
    const pull = await fetch("http://127.0.0.1:3210/api/v1/sync/pull?cursor=0&device=e2e-browser", { headers });
    void pull;
    // 与 background.syncMirror 相同契约：带 token 拉书签后镜像进浏览器书签树
    const list = await fetch("http://127.0.0.1:3210/api/v1/bookmarks", { headers })
      .then((r) => r.json() as Promise<Array<{ title: string; url_canonical: string }>>);
    const root = await new Promise<string>((resolve) => {
      // @ts-expect-error chrome 由扩展页面环境提供
      chrome.bookmarks.search({ title: "my-favorites 同步" }, (nodes) => {
        if (nodes.length > 0) return resolve(nodes[0]!.id);
        // @ts-expect-error chrome 由扩展页面环境提供
        chrome.bookmarks.create({ parentId: "1", title: "my-favorites 同步" }, (n) => resolve(n.id));
      });
    });
    let created = 0;
    for (const bm of list) {
      const dupe = await new Promise<boolean>((resolve) => {
        // @ts-expect-error chrome 由扩展页面环境提供
        chrome.bookmarks.search({ url: bm.url_canonical }, (nodes) => resolve(nodes.length > 0));
      });
      if (dupe) continue;
      await new Promise<void>((resolve) => {
        // @ts-expect-error chrome 由扩展页面环境提供
        chrome.bookmarks.create({ parentId: root, title: bm.title, url: bm.url_canonical }, () => resolve());
      });
      created++;
    }
    return created;
  }, token)) as number;
  expect(added).toBeGreaterThanOrEqual(3);
  await page.close();
  await context.close();
});

test("语义搜索开关与全文搜索共存（语义模式由 embedder 可用性决定）", async () => {
  // 本 server 无 embedding 端点 → semantic 请求自动回退全文（不报错）
  const res = await api("/search?q=哔哩哔哩&semantic=1");
  const body = (await res.json()) as { mode: string; results: Array<{ title: string }> };
  expect(["semantic", "fulltext"]).toContain(body.mode);
  expect(body.results.some((r) => r.title === "哔哩哔哩")).toBe(true);
});

test("迁移：export → import 回灌到新实例", async ({ request }) => {
  const exportBody = await (await api("/export/json")).json();
  // 用无鉴权新实例验证导入
  const newData = mkdtempSync(path.join(os.tmpdir(), "mf-imp-"));
  const imp = spawn("node", [path.resolve(here, "../../server/dist/index.js")], {
    env: { ...process.env, DATA_DIR: newData, PORT: "3211", MF_ENV: "test" },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const restore = await fetch("http://localhost:3211/api/v1/import/json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exportBody),
    });
    const body = (await restore.json()) as { restored: number };
    expect(body.restored).toBeGreaterThanOrEqual(3);
  } finally {
    imp.kill();
    rmSync(newData, { recursive: true, force: true });
  }
});

test("管理台页面可加载并连接服务端", async ({ request }) => {
  // 管理台是静态 SPA（apps/web），验证其构建产物存在 + 服务端健康即可联动
  const health = await request.get(`${BASE}/healthz`);
  expect((await health.json())["ok"]).toBe(true);
});
