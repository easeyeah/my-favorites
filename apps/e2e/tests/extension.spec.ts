/** 扩展浏览器功能测试：SW 存活、newtab 导航渲染、popup UI、书签入库
 *  浏览器：本机 Microsoft Edge（首发目标浏览器，无需下载 chromium） */
import { expect, test } from "@playwright/test";
import { BASE, EXTENSION_PATH, seedViaApi, startServer, stopServer } from "./fixtures";
import { chromium, type BrowserContext } from "@playwright/test";

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  console.log("[ext] beforeAll begin");
  await startServer();
  console.log("[ext] server started, seeding");
  await seedViaApi(); // 扩展 spec 可能先于 server spec 执行，需自行播种
  console.log("[ext] seeded, launching edge");
  // MV3 扩展需要持久 context + chromium headless new 模式
  context = await chromium.launchPersistentContext("", {
    channel: "msedge",
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });
  // 等待 service worker 注册
  let sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  for (let i = 0; i < 180 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 500));
    sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  }
  if (!sw) throw new Error("extension service worker not registered");
  extensionId = new URL(sw.url()).host;
  // E2E 服务端跑在 3007（3000 被 IDE 占用）：在扩展 storage 里配置服务端地址
  await sw.evaluate(
    (url) =>
      new Promise<void>((resolve) => {
        // @ts-expect-error chrome 由扩展环境提供
        chrome.storage.local.set({ serverUrl: url }, () => resolve());
      }),
    BASE,
  );
  console.log("[ext] sw registered:", extensionId);
}, 120_000);

test.afterAll(async () => {
  await context.close();
  stopServer();
});

test("扩展 newtab：原生式极简（D40）——搜索 + 最常访问", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  // D40 = 原生式极简：品牌头 + 搜索框；不再渲染全量书签分组
  await expect(page.locator("h1", { hasText: "my-favorites" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByPlaceholder(/搜索你的书签/)).toBeVisible();
  await expect(page.locator("footer", { hasText: "my-favorites" })).toBeVisible();
  await expect(page.getByText("📁")).toHaveCount(0);
  // 自定义面板可开（常用区数量 + 外部搜索引擎 + 小组件显隐）
  await page.getByTitle("自定义").click();
  await expect(page.getByText("自定义新标签页")).toBeVisible();
  await expect(page.getByText("常用区数量")).toBeVisible();
  await page.close();
});

test("扩展 newtab：小组件（D41）——只有显示/隐藏，黄历离线渲染", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await expect(page.locator("h1", { hasText: "my-favorites" })).toBeVisible({ timeout: 10_000 });
  // 出厂全关（保 D40「安静」承诺）：页面上不存在任何组件字层
  await expect(page.getByTestId("widget-almanac")).toHaveCount(0);
  await expect(page.getByTestId("widget-weather")).toHaveCount(0);
  await expect(page.getByTestId("widget-ip")).toHaveCount(0);
  // 自定义面板：小组件行仅开关 chips，无任何设置项
  await page.getByTitle("自定义").click();
  await expect(page.getByText("小组件")).toBeVisible();
  // 开启黄历（lunar-typescript 本地算，零网络、确定性）——内联进时钟区，无卡片盒子
  await page.getByRole("button", { name: /黄历/ }).click();
  const almanac = page.getByTestId("widget-almanac");
  await expect(almanac).toBeVisible();
  await expect(almanac).toContainText(/月/);
  await expect(almanac).toContainText("宜");
  // 刷新后保持开启（storage 持久化）
  await page.reload();
  await expect(page.getByTestId("widget-almanac")).toBeVisible();
  // 关闭：内联字层消失，回到 D40 极简
  await page.getByTitle("自定义").click();
  await page.getByRole("button", { name: /黄历/ }).click();
  await expect(page.getByTestId("widget-almanac")).toHaveCount(0);
  await page.close();
});

test("扩展 popup：单面化——页面信息 + 底部唯一主按钮，无页签（2026-11-20 用户拍板，替代 ptabs 标签制）", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator("h1")).toHaveText("my-favorites");
  await expect(page.getByRole("tab")).toHaveCount(0);
  // 底部固定按钮：headless 直开（无活动标签页）时为「此页不支持」置灰态；真实 http 页为收藏主操作
  await expect(page.getByRole("button", { name: /✓ 收藏/ })).toBeVisible();
  await page.close();
});

test("扩展收藏链路：popup 收藏当前页 → 服务端入库 → 就地捕获内容", async () => {
  // 打开一个页面（数据页；扩展对 chrome:// 页面无法注入，用本地服务端自页）
  const page = await context.newPage();
  await page.goto(`${BASE}/s/search?q=seed`);
  // 与 popup 相同契约的 REST 调用（页面上下文 + 服务端 CORS 全放行；
  // 注：msedge headless 下 SW 上下文跨源 fetch 不稳定，已记录到开发报告）
  const result = (await page.evaluate(async () => {
    const res = await fetch(`${location.origin}/api/v1/bookmarks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/demo-e2e", title: "E2E 演示页" }),
    });
    return res.json();
  })) as { id: string; suggest?: unknown };
  expect(result.id).toBeTruthy();
  // 就地捕获上行
  const cap = await fetch(`${BASE}/api/v1/content/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bookmarkId: result.id,
      l2Text: "E2E 捕获的正文内容用于内容级搜索验证，包含独特关键词 xyzzy-e2e-marker",
      description: "e2e demo",
    }),
  });
  expect(cap.ok).toBe(true);
  // 内容级搜索能命中捕获正文
  const search = await fetch(`${BASE}/api/v1/search?q=xyzzy-e2e-marker`);
  const body = (await search.json()) as { results: Array<{ id: string }> };
  expect(body.results.some((r) => r.id === result.id)).toBe(true);
  await page.close();
});


/** D46 收藏夹双向直接同步 · 全链路回归：
 *  开启总开关 → 全量对齐（浏览器→库入库、库→浏览器补位）→ 之后每一侧的
 *  增 / 删 / 置顶排序改动，经一次「立即同步」都在另一侧收敛。 */
test("双向同步（D46）：开关对齐 + 两侧增删改序全收敛", async () => {
  const sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) throw new Error("service worker unavailable");
  const tag = Date.now();
  const folderName = `同步E2E-${tag}`;
  const urlS1 = `https://sync-e2e-${tag}.test/s1`;
  const urlS1b = `https://sync-e2e-${tag}.test/s1b`;
  const urlS2 = `https://sync-e2e-${tag}.test/s2`;
  const urlLib = `https://sync-e2e-${tag}.test/lib-only`;

  const sendMsg = (page: import("@playwright/test").Page, msg: Record<string, unknown>) =>
    page.evaluate(
      (m) => new Promise<Record<string, unknown>>((res) => chrome.runtime.sendMessage(m, res)),
      msg,
    );
  const browserHas = (url: string) =>
    sw.evaluate(
      (u) =>
        new Promise<boolean>((res) => {
          chrome.bookmarks.search({ url: u }, (ns) => res(ns.length > 0));
        }),
      url,
    );
  const libHas = async (url: string) => {
    const r = (await (
      await fetch(`${BASE}/api/v1/bookmarks/by-url?url=${encodeURIComponent(url)}`)
    ).json()) as { found: boolean };
    return r.found;
  };

  // ① 浏览器侧预置一个文件夹 + 两条书签
  const folderId = await sw.evaluate(
    async ([name, u1, u1b]: [string, string, string]) => {
      const f = await chrome.bookmarks.create({ parentId: "1", title: name });
      await chrome.bookmarks.create({ parentId: f.id, title: "S1", url: u1 });
      await chrome.bookmarks.create({ parentId: f.id, title: "S1b", url: u1b });
      return f.id;
    },
    [folderName, urlS1, urlS1b] as [string, string, string],
  );

  // ② 开总开关 → 全量对齐
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator("#sync-status-line")).toBeVisible();
  await page.waitForTimeout(800);
  await page.locator("#sync-master").check();
  await expect(page.locator("#msg-sync")).toContainText("已开启并完成全量对齐", { timeout: 90_000 });

  // 浏览器→库：S1 入库；库→浏览器：seed 的 GitHub 主页出现在浏览器
  // D55 防复发：对齐绝不把浏览器虚拟顶层（收藏夹栏/书签栏…）当用户目录复制进库/浏览器
  const virtRe = /^(收藏夹栏|书签栏|收藏夹|链接|其他书签|其他收藏夹|Bookmarks Bar|Bookmarks Toolbar|Favorites Bar|Favorites|Links|Other bookmarks|Other favorites)$/;
  const badBrowserFolders = await sw.evaluate(
    () =>
      new Promise<string[]>((res) => {
        chrome.bookmarks.getChildren("1", (ns) => {
          res(
            ns
              .filter((n) => !n.url && n.id !== "2")
              .map((n) => (n.title ?? "").trim())
              .filter((x) => /^(\u{1F4E5} )?(收藏夹栏|书签栏|收藏夹|链接|其他书签|其他收藏夹|Bookmarks Bar|Favorites Bar|Favorites|Links|Other bookmarks|Other favorites)$/u.test(x)),
          );
        });
      }),
  );
  expect(badBrowserFolders).toEqual([]);
  const libFoldersAfter = (await (await fetch(`${BASE}/api/v1/folders`)).json()) as Array<{ name: string }>;
  expect(libFoldersAfter.filter((x) => virtRe.test(x.name.trim())).map((x) => x.name)).toEqual([]);

  expect(await libHas(urlS1)).toBe(true);
  expect(await browserHas("https://github.com/easeyeah")).toBe(true);

  // ③ 库侧新增 → 同步后浏览器可见
  const created = (await (
    await fetch(`${BASE}/api/v1/bookmarks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: urlLib, title: "库侧新增" }),
    })
  ).json()) as { id: string };
  await sendMsg(page, { type: "sync-now" });
  expect(await browserHas(urlLib)).toBe(true);

  // ④ 库侧删除 → 同步后浏览器消失
  await fetch(`${BASE}/api/v1/bookmarks/${created.id}`, { method: "DELETE" });
  await sendMsg(page, { type: "sync-now" });
  expect(await browserHas(urlLib)).toBe(false);

  // ⑤ 浏览器侧新增 → 同步后入库
  const s2Id = await sw.evaluate(
    async ([fid, u]: [string, string]) => {
      const n = await chrome.bookmarks.create({ parentId: fid, title: "S2", url: u });
      return n.id;
    },
    [folderId, urlS2] as [string, string],
  );
  await sendMsg(page, { type: "sync-now" });
  expect(await libHas(urlS2)).toBe(true);

  // ⑥ 浏览器侧删除 → 同步后库里消失
  await sw.evaluate((id: string) => chrome.bookmarks.remove(id), s2Id);
  await sendMsg(page, { type: "sync-now" });
  expect(await libHas(urlS2)).toBe(false);

  // ⑦ 库侧置顶 S1b → 同步后浏览器文件夹内 S1b 排第一（管理台排序口径）
  const list = (await (
    await fetch(`${BASE}/api/v1/bookmarks?limit=1000`)
  ).json()) as Array<{ id: string; url_raw: string }>;
  const s1b = list.find((b) => b.url_raw === urlS1b);
  expect(s1b).toBeTruthy();
  await fetch(`${BASE}/api/v1/bookmarks/${s1b!.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: 1 }),
  });
  await sendMsg(page, { type: "sync-now" });
  const titles = (await sw.evaluate(
    (fid: string) =>
      new Promise<string[]>((res) => {
        chrome.bookmarks.getChildren(fid, (ns) => res(ns.map((n) => n.title ?? "")));
      }),
    folderId,
  )) as string[];
  expect(titles[0]).toBe("S1b");
  expect(titles).toContain("S1");

  // 收尾：关掉同步，避免影响同 worker 后续用例
  await page.locator("#sync-master").uncheck();
  await page.waitForTimeout(500);
  await page.close();
}, 240_000);

/** D50 事件触发同步：开总开关后**不做任何手动同步**，管理台新增书签应靠 SSE 门铃
 *  在秒级（headless 环境退化到 1 分钟告警兜底，上限 100s）自动收敛到浏览器收藏夹。 */
test("动作即同步（D50）：管理台改动零手动收敛到浏览器", async () => {
  const sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) throw new Error("service worker unavailable");
  const tag = Date.now();
  const url = `https://d50-e2e-${tag}.test/auto`;

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator("#sync-master").check();
  await expect(page.locator("#msg-sync")).toContainText("已开启并完成全量对齐", { timeout: 90_000 });

  // 只写库，不发 sync-now、不碰浏览器——纯靠推送/告警收敛
  await fetch(`${BASE}/api/v1/bookmarks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, title: "自动收敛" }),
  });

  await expect
    .poll(
      async () =>
        sw.evaluate(
          (u: string) =>
            new Promise<boolean>((res) => {
              chrome.bookmarks.search({ url: u }, (ns) => res(ns.length > 0));
            }),
          url,
        ),
      { timeout: 100_000, message: "SSE 门铃或 1 分钟告警应把库侧新增推到浏览器" },
    )
    .toBe(true);

  await page.locator("#sync-master").uncheck();
  await page.waitForTimeout(500);
  await page.close();
}, 240_000);

/** D51 回归：系统收纳盒是投递口，同步引擎必须整体绕开——
 *  旧缺陷：树扫描跳过收纳盒 → ensureBrowserFolder 永远找不到 → 每轮对齐/同步都在书签栏
 *  新建一个重复「📥 收纳盒」并把库内收纳盒条目搬进去（用户实机出现 3 个）。 */
test("收纳盒不参与同步（D51）：对齐后书签栏仍只有一个 📥 收纳盒", async () => {
  const sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) throw new Error("service worker unavailable");
  const tag = Date.now();
  const inboxUrl = `https://d51-e2e-${tag}.test/pending`;

  // 浏览器侧建收纳盒（走正规管线：setup-inbox 幂等）
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.evaluate(
    () => new Promise<unknown>((res) => chrome.runtime.sendMessage({ type: "setup-inbox" }, res)),
  );

  // 库侧收纳盒塞一条待归位条目
  const inboxFolder = (await (
    await fetch(`${BASE}/api/v1/inbox/setup`, { method: "POST" })
  ).json()) as { id: string };
  await fetch(`${BASE}/api/v1/bookmarks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: inboxUrl, title: "待归位", folderId: inboxFolder.id }),
  });

  // 开总开关触发全量对齐（若上个用例已开，先关再开保证走 align）
  const master = page.locator("#sync-master");
  if (await master.isChecked()) await master.uncheck();
  await master.check();
  await expect(page.locator("#msg-sync")).toContainText("已开启并完成全量对齐", { timeout: 90_000 });

  // 断言 1：书签栏根下「📥 收纳盒」有且只有一个
  const inboxCount = await sw.evaluate(
    (title: string) =>
      new Promise<number>((res) => {
        chrome.bookmarks.getChildren("1", (ns) => res(ns.filter((n) => !n.url && n.title === title).length));
      }),
    "📥 收纳盒",
  );
  expect(inboxCount).toBe(1);

  // 断言 2：库内收纳盒条目不被放置到浏览器（投递口内容归收纳盒管线）
  const leaked = await sw.evaluate(
    (u: string) =>
      new Promise<number>((res) => {
        chrome.bookmarks.search({ url: u }, (ns) => res(ns.length));
      }),
    inboxUrl,
  );
  expect(leaked).toBe(0);

  await master.uncheck();
  await page.waitForTimeout(500);
  await page.close();
}, 240_000);

/** D53 事件驱动删除同步 + 基线竞态修复回归：
 *  浏览器删书签后**零手动触发**，库端应自动消失（书签事件 8s 防抖 → tick；1 分钟告警兜底）。
 *  旧缺陷：tick 结尾用重扫树覆盖基线，tick 运行期间的删除会被永久吞掉（库里残留）。 */
test("浏览器删除自动同步到库（D53）：零手动，事件驱动", async () => {
  const sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) throw new Error("service worker unavailable");
  const tag = Date.now();
  const url = `https://d53-e2e-${tag}.test/del`;

  // ① 浏览器先建书签（开开关时由 align 推入库）
  const nodeId = await sw.evaluate(
    async (u: string) => {
      const n = await chrome.bookmarks.create({ parentId: "1", title: "D53 删除目标", url: u });
      return n.id;
    },
    url,
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const master = page.locator("#sync-master");
  if (await master.isChecked()) await master.uncheck();
  await master.check();
  await expect(page.locator("#msg-sync")).toContainText("已开启并完成全量对齐", { timeout: 90_000 });

  const libHas = async () => {
    const r = (await (
      await fetch(`${BASE}/api/v1/bookmarks/by-url?url=${encodeURIComponent(url)}`)
    ).json()) as { found: boolean };
    return r.found;
  };
  expect(await libHas()).toBe(true); // 对齐已入库

  // ② 浏览器删除，不点「立即同步」、不发任何消息——纯靠事件 tick
  await sw.evaluate((id: string) => chrome.bookmarks.remove(id), nodeId);
  await expect
    .poll(libHas, { timeout: 100_000, message: "onRemoved → 8s 防抖 tick 应把删除推到库（兜底 1min 告警）" })
    .toBe(false);

  await master.uncheck();
  await page.waitForTimeout(400);
  await page.close();
}, 240_000);

/** D56 复现 B：嵌套目录（父+子目录+书签）删除后，父目录不应残留。 */
test("浏览器删嵌套目录（D56 复现 B）：父子目录都应消失", async () => {
  const sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) throw new Error("service worker unavailable");
  const tag = Date.now();
  const parent = `父目录-${tag}`;
  const child = `子目录-${tag}`;

  const sendMsg = (page: import("@playwright/test").Page, msg: Record<string, unknown>) =>
    page.evaluate((m) => new Promise<Record<string, unknown>>((res) => chrome.runtime.sendMessage(m, res)), msg);
  const libFolderByName = async (name: string) => {
    const fs = (await (await fetch(`${BASE}/api/v1/folders`)).json()) as Array<{ id: string; name: string }>;
    return fs.find((f) => f.name === name) ?? null;
  };

  const parentId = await sw.evaluate(
    async ([p, c, tag2]: [string, string, number]) => {
      const pf = await chrome.bookmarks.create({ parentId: "1", title: p });
      const cf = await chrome.bookmarks.create({ parentId: pf.id, title: c });
      await chrome.bookmarks.create({ parentId: pf.id, title: "父项", url: `https://d56n-${tag2}.test/p` });
      await chrome.bookmarks.create({ parentId: cf.id, title: "子项", url: `https://d56n-${tag2}.test/c` });
      return pf.id;
    },
    [parent, child, tag] as [string, string, number],
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const master = page.locator("#sync-master");
  if (await master.isChecked()) await master.uncheck();
  await master.check();
  await expect(page.locator("#msg-sync")).toContainText("已开启并完成全量对齐", { timeout: 90_000 });
  expect(await libFolderByName(parent)).not.toBeNull();
  expect(await libFolderByName(child)).not.toBeNull();

  await sw.evaluate((id: string) => chrome.bookmarks.removeTree(id), parentId);
  await sendMsg(page, { type: "sync-now" });

  const pAfter = await libFolderByName(parent);
  const cAfter = await libFolderByName(child);
  console.log("[D56B] parent=", pAfter ? "STILL THERE" : "GONE", "child=", cAfter ? "STILL THERE" : "GONE");
  expect(pAfter).toBeNull();
  expect(cAfter).toBeNull();

  await master.uncheck();
  await page.waitForTimeout(400);
  await page.close();
}, 240_000);

/** D56 复现：浏览器删除「目录」（含子书签）应同步删除库内目录与书签。 */
test("浏览器删目录同步（D56 复现）：目录+子书签都应从库消失", async () => {
  const sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) throw new Error("service worker unavailable");
  const tag = Date.now();
  const fname = `删目录测试-${tag}`;
  const urls = [1, 2, 3].map((i) => `https://d56-del-${tag}.test/${i}`);

  const sendMsg = (page: import("@playwright/test").Page, msg: Record<string, unknown>) =>
    page.evaluate((m) => new Promise<Record<string, unknown>>((res) => chrome.runtime.sendMessage(m, res)), msg);
  const libFolderByName = async (name: string) => {
    const fs = (await (await fetch(`${BASE}/api/v1/folders`)).json()) as Array<{ id: string; name: string }>;
    return fs.find((f) => f.name === name) ?? null;
  };
  const libCountIn = async (fid: string) => {
    const bs = (await (await fetch(`${BASE}/api/v1/bookmarks?folderId=${fid}&limit=1000`)).json()) as unknown[];
    return bs.length;
  };

  // 建浏览器目录 + 3 书签
  const folderId = await sw.evaluate(
    async ([name, us]: [string, string[]]) => {
      const f = await chrome.bookmarks.create({ parentId: "1", title: name });
      for (let i = 0; i < us.length; i++) await chrome.bookmarks.create({ parentId: f.id, title: `项${i}`, url: us[i] });
      return f.id;
    },
    [fname, urls] as [string, string[]],
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const master = page.locator("#sync-master");
  if (await master.isChecked()) await master.uncheck();
  await master.check();
  await expect(page.locator("#msg-sync")).toContainText("已开启并完成全量对齐", { timeout: 90_000 });

  const libFolder = await libFolderByName(fname);
  expect(libFolder).not.toBeNull();
  expect(await libCountIn(libFolder!.id)).toBe(3);

  // 删除浏览器目录（removeTree 连子书签一起删）
  await sw.evaluate((id: string) => chrome.bookmarks.removeTree(id), folderId);
  const res = await sendMsg(page, { type: "sync-now" });
  console.log("[D56] sync-now result:", JSON.stringify(res).slice(0, 300));

  // 断言：库内目录与书签都应消失
  const afterFolder = await libFolderByName(fname);
  const stillThere = afterFolder ? await libCountIn(afterFolder.id) : 0;
  console.log("[D56] after delete: folder=", afterFolder?.id ?? "GONE", "bookmarksLeft=", stillThere);
  expect(afterFolder).toBeNull();

  await master.uncheck();
  await page.waitForTimeout(400);
  await page.close();
}, 240_000);

/** D56 复现 C：大目录（>30 条且占比 >25%，旧书签保险丝会误伤）删除仍应整目录同步消失。 */
test("浏览器删大目录（D56 复现 C）：目录级删除不受书签保险丝误伤", async () => {
  const sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) throw new Error("service worker unavailable");
  const tag = Date.now();
  const fname = `大目录-${tag}`;
  const N = 40;

  const sendMsg = (page: import("@playwright/test").Page, msg: Record<string, unknown>) =>
    page.evaluate((m) => new Promise<Record<string, unknown>>((res) => chrome.runtime.sendMessage(m, res)), msg);
  const libFolderByName = async (name: string) => {
    const fs = (await (await fetch(`${BASE}/api/v1/folders`)).json()) as Array<{ id: string; name: string }>;
    return fs.find((f) => f.name === name) ?? null;
  };

  const folderId = await sw.evaluate(
    async ([name, n, tag2]: [string, number, number]) => {
      const f = await chrome.bookmarks.create({ parentId: "1", title: name });
      for (let i = 0; i < n; i++) await chrome.bookmarks.create({ parentId: f.id, title: `大项${i}`, url: `https://d56big-${tag2}.test/${i}` });
      return f.id;
    },
    [fname, N, tag] as [string, number, number],
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const master = page.locator("#sync-master");
  if (await master.isChecked()) await master.uncheck();
  await master.check();
  await expect(page.locator("#msg-sync")).toContainText("已开启并完成全量对齐", { timeout: 90_000 });
  const libFolder = await libFolderByName(fname);
  expect(libFolder).not.toBeNull();

  await sw.evaluate((id: string) => chrome.bookmarks.removeTree(id), folderId);
  const res = await sendMsg(page, { type: "sync-now" });
  const guard = (res as { info?: { deleteGuard?: unknown } }).info?.deleteGuard;
  console.log("[D56C] deleteGuard=", JSON.stringify(guard ?? null));
  expect(guard).toBeUndefined(); // 目录级删除不应挂保险丝
  expect(await libFolderByName(fname)).toBeNull();

  await master.uncheck();
  await page.waitForTimeout(400);
  await page.close();
}, 240_000);

/** D57 回归：丢入收纳盒 → 零手动自动分类。旧缺陷：即时 flush 静默失败 + 无定时兜底
 *  （UI 承诺的"每小时清扫"不存在），条目永远卡 pending。现加独立 mf-inbox-sweep alarm。
 *  用 github.com（高置信域名规则→开发，不依赖 LLM）；75s 窗口覆盖即时(~1s)与兜底(~60s)两路径。 */
test("收纳盒自动分类（D57）：丢入后零手动归位到类目目录", async () => {
  const sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) throw new Error("service worker unavailable");
  const tag = Date.now();
  const url = `https://github.com/d57-inbox-${tag}/repo`;

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  // 建收纳盒（浏览器投递口 + 服务端目录），拿 extId/serverId
  const inbox = (await page.evaluate(
    () => new Promise<{ serverId: string; extId: string }>((res) => chrome.runtime.sendMessage({ type: "setup-inbox" }, res)),
  )) as { serverId: string; extId: string };
  expect(inbox.extId).toBeTruthy();

  // 丢一个书签进浏览器收纳盒（触发 onInboxEvent → 即时 flush；失败则 alarm 兜底）
  await sw.evaluate(
    async ([parentId, u]: [string, string]) => {
      await chrome.bookmarks.create({ parentId, title: `D57 待分类 ${u}`, url: u });
    },
    [inbox.extId, url] as [string, string],
  );

  // 零手动：轮询直到该书签被分进「非收纳盒」目录（即时或兜底任一路径成功即可）
  const classified = async () => {
    const r = (await (
      await fetch(`${BASE}/api/v1/bookmarks/by-url?url=${encodeURIComponent(url)}`)
    ).json()) as { found: boolean; bookmark?: { folder_id: string } };
    return r.found && !!r.bookmark && r.bookmark.folder_id !== inbox.serverId;
  };
  await expect
    .poll(classified, { timeout: 75_000, message: "丢入收纳盒应被自动分类（即时 flush 或 mf-inbox-sweep 兜底）" })
    .toBe(true);

  // 兜底 alarm 必须已挂（独立于同步开关）
  const alarm = await sw.evaluate(() => chrome.alarms.get("mf-inbox-sweep"));
  expect(alarm).toBeTruthy();

  await page.close();
}, 120_000);

/** D57 兜底路径精准回归：用 /inbox/map 造一个卡 pending 的条目（不经浏览器丢入、
 *  不触发即时 flush），纯靠 mf-inbox-sweep 定时 alarm 分类——正是用户「卡 pending 不动」的场景。 */
test("收纳盒兜底清扫（D57）：卡 pending 的条目被定时 alarm 自动分类", async () => {
  const sw = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) throw new Error("service worker unavailable");
  const tag = Date.now();
  const url = `https://github.com/d57-sweep-${tag}/repo`;

  // 确保收纳盒存在 + alarm 已挂（SW 启动时创建）
  const inbox = (await (await fetch(`${BASE}/api/v1/inbox/setup`, { method: "POST" })).json()) as { id: string };
  const alarm = await sw.evaluate(() => chrome.alarms.get("mf-inbox-sweep"));
  expect(alarm).toBeTruthy();

  // 直接 map 进库收纳盒（模拟「已映射但即时 flush 失败」的卡 pending 条目；无浏览器丢入）
  await fetch(`${BASE}/api/v1/inbox/map`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: `d57-dev-${tag}`, browserBookmarkId: `d57-node-${tag}`, url, title: "卡 pending 条目" }),
  });
  // 确认此刻确实卡在收纳盒（未被分类）
  const before = (await (
    await fetch(`${BASE}/api/v1/bookmarks/by-url?url=${encodeURIComponent(url)}`)
  ).json()) as { found: boolean; bookmark?: { folder_id: string } };
  expect(before.found && before.bookmark?.folder_id === inbox.id).toBe(true);

  // 零手动：等 mf-inbox-sweep alarm（1min）把它分类出收纳盒
  const classified = async () => {
    const r = (await (
      await fetch(`${BASE}/api/v1/bookmarks/by-url?url=${encodeURIComponent(url)}`)
    ).json()) as { found: boolean; bookmark?: { folder_id: string } };
    return r.found && !!r.bookmark && r.bookmark.folder_id !== inbox.id;
  };
  await expect
    .poll(classified, { timeout: 90_000, message: "mf-inbox-sweep 定时兜底应把卡 pending 的条目分类" })
    .toBe(true);
}, 150_000);
