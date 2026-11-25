/**
 * D92 目录整理任务：真实服务端 + 管理台（匿名 fixture 3007；未配置模型 → 规则模式）。
 * 覆盖：显式入口发起 → 真实结果与计数 → 整次撤销 → 收起 ≠ 停止 → 零变更解释 → 整理记录找回。
 * 断言以服务端真相（REST）为准，界面状态用可查询属性/文本等待收敛，不用固定等待促成通过。
 */
import { test, expect, chromium, type Page } from "@playwright/test";
import { BASE, startServer, stopServer } from "./fixtures";

test.beforeAll(async () => {
  await startServer();
});
test.afterAll(() => stopServer());

type FolderRow = { id: string; name: string; parent_id: string | null };
type BmRow = { id: string; title: string; folder_id: string };

async function ingest(items: Array<{ url: string; title: string; folderPath: string[] }>): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/bookmarks/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: `d92-e2e-${Math.random()}`, items }),
  });
  expect(res.status).toBe(200);
}
const folders = async (): Promise<FolderRow[]> => (await (await fetch(`${BASE}/api/v1/folders`)).json()) as FolderRow[];
const bookmarks = async (): Promise<BmRow[]> => (await (await fetch(`${BASE}/api/v1/bookmarks`)).json()) as BmRow[];
const tasks = async () =>
  (await (await fetch(`${BASE}/api/v1/organize/tasks`)).json()) as {
    tasks: Array<{ id: string; status: string; moved: number; undo_status: string }>;
    total: number;
    active: { id: string } | null;
  };

async function openFolder(page: Page, name: string): Promise<void> {
  await page.locator('button[title^="点击进入"]').filter({ hasText: name }).click();
  await expect(page.locator("header p").first()).toContainText(name);
}

test("规则模式：发起 → 真实结果与计数 → 整次撤销 → 书签回到原位", async () => {
  await ingest([
    { url: "https://github.com/acme/d92-a", title: "待归位甲", folderPath: ["整理验收"] },
    { url: "https://github.com/acme/d92-b", title: "待归位乙", folderPath: ["整理验收"] },
    { url: "https://unknown-d92.example.com/x", title: "规则未命中", folderPath: ["整理验收"] },
    { url: "https://github.com/acme/d92-seed", title: "已在开发", folderPath: ["整理验收", "开发"] },
  ]);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/#bookmarks`);
  await openFolder(page, "整理验收");

  // 显式入口：未选中单个真实目录时不出现；选中后出现且可用
  const start = page.locator("[data-organize-start]");
  await expect(start).toHaveAttribute("data-organize-start", "idle");
  await expect(start).toHaveText(/整理此目录/);
  await start.click();

  const dialog = page.locator("[data-organize-task]");
  await expect(dialog).toBeVisible();
  // 规则模式如实说明：不是「AI 整理完成」，也不是「结构已经很好」
  await expect(dialog.getByText(/已按本地规则归位 2 条/)).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText(/未配置模型/)).toBeVisible();
  await expect(dialog.getByRole("tab", { name: /书签移动 2/ })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: /保持 2/ })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: /失败 0/ })).toBeVisible();
  await expect(dialog.getByText("整理验收 → 整理验收 / 开发")).toHaveCount(2);

  // 服务端真相：两条落到既有「开发」目录，其余原地；计数等式成立
  let all = await bookmarks();
  const tree = await folders();
  const dev = tree.find((f) => f.name === "开发")!;
  expect(all.find((b) => b.title === "待归位甲")!.folder_id).toBe(dev.id);
  expect(all.find((b) => b.title === "待归位乙")!.folder_id).toBe(dev.id);
  const root = tree.find((f) => f.name === "整理验收")!;
  expect(all.find((b) => b.title === "规则未命中")!.folder_id).toBe(root.id);
  expect(tree.filter((f) => f.name === "开发")).toHaveLength(1); // 规则模式不建新目录
  let list = await tasks();
  expect(list.total).toBe(1);
  expect(list.tasks[0]).toMatchObject({ status: "completed_with_issues", moved: 2 });
  // 入口恢复为可再次发起
  await expect(start).toHaveAttribute("data-organize-start", "idle");

  // 整次撤销：书签回原位；界面如实给出恢复数量
  await dialog.getByRole("button", { name: "撤销本次整理" }).click();
  await expect(dialog.getByText(/已恢复 2 条/)).toBeVisible({ timeout: 15_000 });
  all = await bookmarks();
  expect(all.find((b) => b.title === "待归位甲")!.folder_id).toBe(root.id);
  expect(all.find((b) => b.title === "待归位乙")!.folder_id).toBe(root.id);
  expect((await tasks()).tasks[0]!.undo_status).toBe("completed");
  // 撤销后旧任务不能沿原方案继续：只剩「重新整理」
  await expect(dialog.getByRole("button", { name: "重新整理" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "继续剩余" })).toHaveCount(0);

  await browser.close();
});

test("收起 ≠ 停止：Esc 关闭对话框后任务继续到完成，可从「整理记录」找回", async () => {
  await ingest([
    { url: "https://github.com/acme/d92-c1", title: "收起用例一", folderPath: ["收起验收", "开发"] },
    { url: "https://github.com/acme/d92-c2", title: "收起用例二", folderPath: ["收起验收"] },
    { url: "https://github.com/acme/d92-c3", title: "收起用例三", folderPath: ["收起验收"] },
  ]);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/#bookmarks`);
  await openFolder(page, "收起验收");
  await page.locator("[data-organize-start]").click();
  const dialog = page.locator("[data-organize-task]");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // 任务未被停止：等待服务端落定为完成态（不是 stopped）
  await expect
    .poll(async () => (await tasks()).tasks[0], { timeout: 15_000 })
    .toMatchObject({ status: "completed_with_issues", moved: 2 });
  const tree = await folders();
  const dev = tree.find((f) => f.name === "开发" && f.parent_id === tree.find((x) => x.name === "收起验收")!.id)!;
  const all = await bookmarks();
  expect(all.find((b) => b.title === "收起用例二")!.folder_id).toBe(dev.id);

  // 常驻「整理记录」入口：关闭后仍能找回（只查看，不重新执行）
  const records = page.locator("[data-organize-records]");
  await expect(records).toBeVisible();
  await records.click();
  await expect(dialog.getByRole("heading", { name: /整理记录/ })).toBeVisible();
  // 同一夹具里可能还有其它用例留下的记录：条数与服务端总数一致，首行是最近这次
  const before = (await tasks()).total;
  await expect(dialog.locator("li")).toHaveCount(Math.min(before, 10));
  await expect(dialog.locator("li").first()).toContainText("收起验收");
  await dialog.locator("li button").first().click();
  await expect(dialog.getByRole("button", { name: "返回整理记录" })).toBeVisible();
  await expect(dialog.getByText(/已按本地规则归位 2 条/)).toBeVisible();
  expect((await tasks()).total).toBe(before); // 查看记录没有创建新任务

  await browser.close();
});

test("零变更：规则未命中时先解释原因并给出模型配置入口，不显示空白成功页", async () => {
  await ingest([{ url: "https://plain-d92.example.com/a", title: "无规则命中", folderPath: ["零变更验收"] }]);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/#bookmarks`);
  await openFolder(page, "零变更验收");
  await page.locator("[data-organize-start]").click();
  const dialog = page.locator("[data-organize-task]");
  await expect(dialog).toBeVisible();
  const zero = dialog.locator("[data-zero-change]");
  await expect(zero).toBeVisible({ timeout: 15_000 });
  await expect(zero.getByText("未配置整理模型", { exact: false })).toBeVisible();
  await expect(zero.getByRole("button", { name: "配置 AI 模型" })).toBeVisible();
  await expect(zero.getByText("规则未命中")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "撤销本次整理" })).toHaveCount(0); // 无变更不可撤销
  const all = await bookmarks();
  const root = (await folders()).find((f) => f.name === "零变更验收")!;
  expect(all.find((b) => b.title === "无规则命中")!.folder_id).toBe(root.id);

  await browser.close();
});

test("全库重分类（仍是旧同步流程）：结果与撤销按真实回执提示，未产生调整时显示服务端说明", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/#bookmarks`);
  // 入口有两个（移动端 chips 隐藏 + 桌面端目录树底部），取可见的那个
  await page.locator('button[title^="AI 重排整库目录"]:visible').click();

  // 第一轮：同一夹具里留有命中域名规则、尚未在「开发」目录的书签 → 产生调整，结果面板出现
  await page.getByRole("button", { name: "开始重分类" }).click();
  await expect(page.getByText("这一批的分类结果如下")).toBeVisible({ timeout: 15_000 });

  // 再跑一次：已无书签可挪 → 未产生调整。显示服务端按真实结果生成的说明，不报错、也不说「结构很好」
  await page.getByRole("button", { name: "再跑一次" }).click();
  await expect(page.getByText(/未配置模型：仅应用规则分类/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("库结构已经很好，无需调整")).toHaveCount(0);

  // 撤销第一批：按真实回执数提示，不再一律说「书签全部回到原目录」
  await page.getByRole("button", { name: "撤销这批" }).click();
  await expect(page.getByText(/已撤销 \d+ 项（整理后被你改过的条目保留）|条目已有其他改动/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/重分类失败|撤销失败/)).toHaveCount(0);

  await browser.close();
});

test("落点不限于来源目录（D94）：来源里没有对应目录时归到库内其他目录，并标明移到了目录之外", async () => {
  // 「设计」目录只在别处存在——来源目录「跨根来源」里没有
  await ingest([
    { url: "https://figma.com/acme/d94-seed", title: "设计种子", folderPath: ["跨根目标", "设计"] },
    { url: "https://figma.com/acme/d94-design", title: "跨根待归位", folderPath: ["跨根来源"] },
  ]);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/#bookmarks`);
  await openFolder(page, "跨根来源");
  await page.locator("[data-organize-start]").click();
  const dialog = page.locator("[data-organize-task]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/已按本地规则归位 1 条/)).toBeVisible({ timeout: 15_000 });
  // 明细写出完整去向；状态块单独说明有条目移到了这个目录之外
  await expect(dialog.getByText("跨根来源 → 跨根目标 / 设计")).toBeVisible();
  await expect(dialog.locator("[data-task-moved-outside]")).toHaveText(/其中 1 条归入了这个目录之外/);
  // 目录变化里，外部目录带完整路径与「目录外」标记（限定在目录变化行内，避免与结果明细里的去向文字重复匹配）
  await dialog.getByRole("button", { name: /目录变化/ }).click();
  const outsideRow = dialog.locator("li").filter({ hasText: "目录外" });
  await expect(outsideRow).toHaveCount(1);
  await expect(outsideRow).toContainText("跨根目标 / 设计");
  // 服务端真相：书签确实落在别处的「设计」目录，来源目录下没有新建
  const target = (await folders()).find((f) => f.name === "设计")!;
  expect((await bookmarks()).find((b) => b.title === "跨根待归位")!.folder_id).toBe(target.id);
  expect((await folders()).some((f) => f.name === "设计" && f.parent_id !== target.parent_id)).toBe(false);

  await browser.close();
});
