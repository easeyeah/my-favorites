/**
 * D92 目录整理任务集成测试（《书签目录自动整理重设计》§10）：
 *  - 创建幂等 / 单活动任务 / 账号级准入（旧同步入口不能绕过）；
 *  - AI 双路整理：内容驱动的新目录（两层）、旧目录按稳定 ID 复用、内容页转资料入独立分类；
 *  - 计数口径 total = moved + converted + unchanged + skipped + failed + remaining；
 *  - 隐私前置：私密/隐私域条目不进模型、不落明细；模型输入不含私密标题；
 *  - D95 粒度：新目录直接承接不足 3 条不建（两层各自成组）；小主题并入更宽主题；
 *    来源目录里自动整理建的小目录不作复用候选；模型明确回答「不复用」时不被同名兜底覆盖；
 *    与来源无关且同类太少的书签归入最接近的大类，不留在放错的目录里；
 *  - 失败不伪装成功：模型故障如实计失败；规划失败整任务失败且零变更，恢复后可继续；
 *  - 等待期间的用户修改/外部转换 → 跳过不覆盖；停止/继续/整次撤销/单批撤销/明细过期；
 *  - 重启恢复（过期租约被接管，旧 worker 无权再写）；多用户隔离；SSE 任务门铃。
 *
 * 全部使用临时库、脚本化模型替身与抓取替身；不访问网络与真实收藏。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@mf/ai/llm-client";
import { makeEnv, type TestEnv } from "./test-env";
import { OrganizeTaskService } from "./organize-task";
import type { ChatMessage } from "./organize-task-plan";

let env: TestEnv;
afterEach(() => {
  vi.restoreAllMocks();
  env?.cleanup();
  env = undefined as unknown as TestEnv;
});

// ---------- 脚本化模型替身 ----------

interface TopicItem {
  index: number;
  title: string;
  url: string;
}
interface JudgeItem {
  index: number;
  title: string;
  url: string;
  excerpt: string;
  knownMaterial: boolean;
}
type Kind = "topics" | "consolidate" | "map" | "judge";
interface Script {
  failTopics?: boolean;
  failMap?: boolean;
  map?: (
    nodes: Array<{ key: string; name: string; count: number; samples: string[] }>,
    folders: Array<{ id: string; path: string; samples: string[] }>,
  ) => Array<{ key: string; reuseId: string | null; place?: "inside" | "top"; fallbackId?: string | null }>;
  /** 合并阶段的脚本：把小主题并入更宽的主题（canonical）；不写 = 各主题保持原名 */
  consolidate?: (topics: Array<{ name: string }>) => {
    topics: Array<{ name: string; canonical: string; subtopics?: Array<{ name: string; canonical: string }> }>;
  };
  /** 每次模型调用前的钩子：注入并发修改 / 阻塞 */
  before?: (kind: Kind, messages: ChatMessage[]) => Promise<void> | void;
}
interface Call {
  kind: Kind;
  system: string;
  user: string;
}

/** 标题里写脚本：[site:远程控制] 标题 / [content:部署] 标题{cat:技术开发/容器部署}；[unsure:] 表示模型拿不准 */
const TITLE_RE = /^\[(site|content|unsure):([^/\]]*)(?:\/([^\]]+))?\]\s*(.*)$/;
const CAT_RE = /\{cat:([^}]+)\}/;
/** 脚本标签之后的书签名（测试用书签标题以 [use:主题] 开头、可带 {cat:…}；入库标题原样保留） */
const cleanTitle = (t: string): string => t.replace(TITLE_RE, "$4").replace(CAT_RE, "").trim();

function scriptedLlm(script: Script = {}): { client: LlmClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    chatJson: async (messages: ChatMessage[]): Promise<unknown> => {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      const kind: Kind = system.includes("书签整理助手")
        ? "topics"
        : system.includes("合并语义相同")
          ? "consolidate"
          : system.includes("书签目录规划助手")
            ? "map"
            : "judge";
      calls.push({ kind, system, user });
      await script.before?.(kind, messages);
      if (kind === "topics") {
        if (script.failTopics) throw new Error("HTTP 429 from test");
        const items = JSON.parse(user) as TopicItem[];
        return {
          results: items.map((it) => {
            const m = TITLE_RE.exec(it.title);
            if (!m || !m[2]) return { index: it.index, use: "unsure", topic: "", subtopic: "", confidence: 0.3 };
            return {
              index: it.index,
              use: m[1],
              topic: m[2]!,
              subtopic: m[3] ?? "",
              confidence: it.title.includes("低分") ? 0.5 : 0.9,
            };
          }),
        };
      }
      if (kind === "consolidate") {
        // 合并阶段的输入是主题数组本身（不是 { topics } 包裹）——此前这里解析错形状、一直抛错被「合并失败不致命」吞掉
        const topics = JSON.parse(user) as Array<{ name: string; subtopics?: Array<{ name: string }> }>;
        if (script.consolidate) return script.consolidate(topics);
        return {
          topics: topics.map((t) => ({
            name: t.name,
            canonical: t.name,
            subtopics: (t.subtopics ?? []).map((s) => ({ name: s.name, canonical: s.name })),
          })),
        };
      }
      if (kind === "map") {
        if (script.failMap) throw new Error("HTTP 503 from test");
        const { nodes, folders } = JSON.parse(user) as {
          nodes: Array<{ key: string; name: string; count: number; samples: string[] }>;
          folders: Array<{ id: string; path: string; samples: string[] }>;
        };
        if (script.map) return { nodes: script.map(nodes, folders) };
        // 默认映射：主题名与某个现有目录名完全一致（且唯一）才复用，否则建在来源目录之下（place=inside）
        return {
          nodes: nodes.map((n) => {
            const hits = folders.filter((f) => f.path.split(" / ").pop() === n.name);
            const reuseId = hits.length === 1 ? hits[0]!.id : null;
            return n.key.startsWith("t:") ? { key: n.key, reuseId, place: reuseId ? undefined : "inside" } : { key: n.key, reuseId };
          }),
        };
      }
      const { items } = JSON.parse(user) as { items: JudgeItem[] };
      return {
        results: items.map((it) => ({
          index: it.index,
          material: !it.title.includes("非资料"),
          confidence: it.title.includes("低置信") ? 0.5 : 0.9,
          category: (CAT_RE.exec(it.title)?.[1] ?? "默认分类").split("/"),
        })),
      };
    },
  } as unknown as LlmClient;
  return { client, calls };
}

// ---------- 测试辅助 ----------

type Bm = { id: string; title: string; folder_id: string };

async function ingest(
  items: Array<{ url: string; title: string; folderPath: string[] }>,
  headers?: Record<string, string>,
): Promise<void> {
  const res = await env.app.request("/api/v1/bookmarks/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify({ idempotencyKey: `d92-${Math.random()}`, items }),
  });
  expect(res.status).toBe(200);
}

type FolderRow = { id: string; name: string; parent_id: string | null };
const folders = async (headers?: Record<string, string>): Promise<FolderRow[]> =>
  (await (await env.app.request("/api/v1/folders", { headers })).json()) as FolderRow[];
const bookmarks = async (): Promise<Bm[]> => (await (await env.app.request("/api/v1/bookmarks")).json()) as Bm[];

async function post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
  return env.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body ?? {}),
  });
}
async function getJson<T>(path: string, headers?: Record<string, string>): Promise<T> {
  return (await (await env.app.request(`/api/v1${path}`, { headers })).json()) as T;
}

interface TaskView {
  id: string;
  status: string;
  mode: string;
  total: number;
  checked: number;
  remaining: number;
  moved: number;
  converted: number;
  new_materials: number;
  reused_materials: number;
  unchanged: number;
  skipped: number;
  failed: number;
  protected_count: number;
  planned_new_folders: number;
  created_folders: number;
  reused_folders: number;
  moved_outside?: number;
  planned_categories: number;
  new_categories: number;
  reused_categories: number;
  revision: number;
  error: string | null;
  summary: string | null;
  undo_status: string;
  undo_restored: number;
  undo_kept: number;
  undo_categories: number;
  undo_folders: number;
  can_continue: boolean;
  topics: string[];
}
type ItemView = {
  id: string;
  title: string | null;
  decision: string;
  reason: string | null;
  retryable: boolean;
  from_path: string | null;
  to_path: string | null;
  category_path: string | null;
};

const waitIdle = (): Promise<void> => env.organizeTasks.idle();
const view = (id: string, headers?: Record<string, string>): Promise<TaskView> =>
  getJson<{ task: TaskView }>(`/organize/tasks/${id}`, headers).then((r) => r.task);
const itemsOf = (id: string, result?: string, headers?: Record<string, string>) =>
  getJson<{ items: ItemView[]; total: number; protectedCount: number }>(
    `/organize/tasks/${id}/items${result ? `?result=${result}` : ""}`,
    headers,
  );

async function createTask(folderId: string, requestId = `req-${Math.random()}`, headers?: Record<string, string>) {
  const res = await post("/organize/tasks", { folderId, requestId }, headers);
  const body = (await res.json()) as { task: TaskView; created: boolean; existing: boolean; error?: string; hint?: string };
  return { ...body, status: res.status };
}

/** 运行一个任务并返回终态视图 */
async function runTask(folderId: string, headers?: Record<string, string>): Promise<TaskView> {
  const r = await createTask(folderId, `req-${Math.random()}`, headers);
  expect(r.status).toBe(202);
  await waitIdle();
  return view(r.task.id, headers);
}

const articleHtml = `<html><body><article>${"这是一段足够长的正文内容，用于验证资料识别与分类。".repeat(30)}</article></body></html>`;
const longText = "这是一段足够长的正文内容，用于验证资料识别与分类。".repeat(30);

/** 可控阻塞：第一次主题调用进入后停在闸口，直到测试放行（之后的调用正常返回；调用方须在 finally 里 release） */
function blockedTopics(): { script: Script; entered: Promise<void>; release: () => void } {
  let release: (() => void) | null = null;
  let signal: (() => void) | null = null;
  let armed = true;
  const entered = new Promise<void>((resolve) => (signal = resolve));
  const script: Script = {
    before: async (kind) => {
      if (kind !== "topics" || !armed) return;
      armed = false;
      signal!();
      await new Promise<void>((resolve) => (release = resolve));
    },
  };
  return { script, entered, release: () => release?.() };
}
const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};
const folderByName = (rows: FolderRow[], name: string, parent?: string): FolderRow => {
  const hit = rows.find((f) => f.name === name && (parent === undefined || f.parent_id === parent));
  if (!hit) throw new Error(`folder not found: ${name}`);
  return hit;
};
/** 目录内直接承接的书签数 */
const itemsIn = (folderId: string): number =>
  (env.store.db.prepare("SELECT COUNT(*) AS c FROM bookmarks WHERE folder_id = ?").get(folderId) as { c: number }).c;

const byTitle = (rows: Bm[], title: string): Bm => {
  const hit = rows.find((b) => cleanTitle(b.title) === title);
  if (!hit) throw new Error(`bookmark not found: ${title}`);
  return hit;
};

describe("D92 任务创建与账号级准入", () => {
  it("创建即受理；同幂等键回同一任务；已有活动任务回它而不并行；旧同步入口被拒", async () => {
    const block = blockedTopics();
    const { client } = scriptedLlm(block.script);
    env = makeEnv(client);
    try {
      await ingest([{ url: "https://a92.example.com/1", title: "[site:主题一] 甲", folderPath: ["整理测试"] }]);
      const root = folderByName(await folders(), "整理测试");

      const first = await createTask(root.id, "same-key");
      expect(first.status).toBe(202);
      expect(first.created).toBe(true);
      expect(["queued", "running"]).toContain(first.task.status);
      await block.entered; // worker 已进入模型闸口
      expect((await view(first.task.id)).status).toBe("running");

      const again = await createTask(root.id, "same-key");
      expect(again.status).toBe(200);
      expect(again.created).toBe(false);
      expect(again.task.id).toBe(first.task.id);

      const other = await createTask(root.id, "other-key");
      expect(other.created).toBe(false);
      expect(other.existing).toBe(true);
      expect(other.task.id).toBe(first.task.id);

      // 账号级准入：旧的同步整理入口不能绕过任务执行槽
      const busyFolder = await post("/organize/folder", { folderId: root.id });
      expect(busyFolder.status).toBe(409);
      expect(((await busyFolder.json()) as { error: string }).error).toBe("organize_task_active");
      const busySession = await post("/organize/sessions", { message: "整理整个库" });
      expect(busySession.status).toBe(409);
      // 只有一个任务：重复创建没有产生并行任务
      expect(env.store.countOrganizeTasks()).toBe(1);

      block.release();
      await waitIdle();
      expect((await view(first.task.id)).status).toBe("completed");
      // 结束后旧入口恢复可用
      expect((await post("/organize/folder", { folderId: root.id })).status).toBe(201);
    } finally {
      block.release();
    }
  });

  it("空目录 / 目录不存在 / 收纳盒 / 缺请求标识 被拒", async () => {
    env = makeEnv(null);
    await ingest([
      { url: "https://a92.example.com/1", title: "占位", folderPath: ["待清空"] },
      { url: "https://a92.example.com/2", title: "甲", folderPath: ["整理测试"] },
    ]);
    for (const b of await bookmarks()) if (b.title === "占位") await env.app.request(`/api/v1/bookmarks/${b.id}`, { method: "DELETE" });
    const tree = await folders();
    const empty = folderByName(tree, "待清空");

    const emptyRes = await post("/organize/tasks", { folderId: empty.id, requestId: "empty" });
    expect(emptyRes.status).toBe(400);
    expect(((await emptyRes.json()) as { error: string }).error).toBe("empty_scope");
    expect((await post("/organize/tasks", { folderId: "no-such", requestId: "x" })).status).toBe(404);
    expect((await post("/organize/tasks", { folderId: folderByName(tree, "整理测试").id, requestId: "" })).status).toBe(400);
    // 收纳盒不是普通目录：不能对它发起目录整理
    env.store.createFolder("📥 收纳盒", null, "user", true);
    const inbox = env.store.inboxFolder();
    expect(inbox).toBeTruthy();
    expect((await post("/organize/tasks", { folderId: inbox!.id, requestId: "inbox" })).status).toBe(404);
    expect(env.store.countOrganizeTasks()).toBe(0);
  });
});

describe("D92 AI 双路整理", () => {
  async function seed(): Promise<{ root: FolderRow; deploy: FolderRow }> {
    await ingest([
      { url: "https://rustdesk92.example.com/", title: "[site:远程控制] RustDesk 官网", folderPath: ["常用收藏"] },
      { url: "https://sill92.example.com/", title: "[site:远程控制] Sill 远程控制", folderPath: ["常用收藏", "常用"] },
      { url: "https://todesk92.example.com/", title: "[site:远程控制] ToDesk 官网", folderPath: ["常用收藏", "其他"] },
      { url: "https://react92.example.com/", title: "[site:开发/前端开发] React 文档", folderPath: ["常用收藏", "工具"] },
      { url: "https://vue92.example.com/", title: "[site:开发/前端开发] Vue 指南", folderPath: ["常用收藏", "其他"] },
      { url: "https://angular92.example.com/", title: "[site:开发/前端开发] Angular 文档", folderPath: ["常用收藏", "常用"] },
      { url: "https://juejin92.example.com/", title: "[site:开发] 掘金", folderPath: ["常用收藏", "其他"] },
      { url: "https://oschina92.example.com/", title: "[site:开发] 开源中国", folderPath: ["常用收藏", "工具"] },
      { url: "https://csdn92.example.com/", title: "[site:开发] CSDN", folderPath: ["常用收藏", "常用"] },
      { url: "https://portainer92.example.com/", title: "[site:部署运维] Portainer", folderPath: ["常用收藏"] },
      { url: "https://docker92.example.com/post/1", title: "[content:部署] Docker 部署教程{cat:技术开发/容器部署}", folderPath: ["常用收藏", "工具"] },
      { url: "https://figma92.example.com/blog/x", title: "[content:设计] Figma 自动布局教程{cat:设计/界面设计}", folderPath: ["常用收藏", "其他"] },
      { url: "https://unknown92.example.com/x", title: "[unsure:] 某公司内网登录页", folderPath: ["常用收藏"] },
      { url: "https://portainer92.example.com/docs", title: "[site:部署运维] Portainer 文档中心", folderPath: ["常用收藏", "部署运维"] },
    ]);
    const tree = await folders();
    return { root: folderByName(tree, "常用收藏"), deploy: folderByName(tree, "部署运维") };
  }

  it("内容驱动建两层新目录、旧目录按 ID 复用、内容页转资料入独立分类，计数自洽", async () => {
    const { client, calls } = scriptedLlm();
    env = makeEnv(client, false, {
      crawlFetcher: async () => ({ ok: true, status: 200, readBody: async () => Buffer.from(articleHtml), dispose: () => undefined }),
    });
    const { root, deploy } = await seed();
    // Docker 教程已有扩展捕获的正文（≥200 字）：无需补抓
    env.store.upsertCache({ bookmarkId: byTitle(await bookmarks(), "Docker 部署教程").id, l2Text: longText, fetchedVia: "extension_capture" });

    const t = await runTask(root.id);
    expect(t.status).toBe("completed_with_issues"); // 有 1 条证据不足需要说明，不包装成「全都合适」
    expect(t.mode).toBe("ai");
    expect(t.total).toBe(14);
    expect(t.checked).toBe(14);
    expect(t.remaining).toBe(0);
    expect(t.moved).toBe(10);
    expect(t.converted).toBe(2);
    expect(t.unchanged).toBe(2);
    expect(t.skipped).toBe(0);
    expect(t.failed).toBe(0);
    expect(t.moved + t.converted + t.unchanged + t.skipped + t.failed + t.remaining).toBe(t.total);
    expect(t.created_folders).toBe(3);
    expect(t.reused_folders).toBe(1);
    expect(t.new_materials).toBe(2);
    expect(t.planned_categories).toBe(2);
    expect(t.new_categories).toBe(2);
    expect(t.summary).toContain("书签归位 10 条");
    expect(t.summary).toContain("转入资料 2 条");

    // 目录结构：新建「远程控制」「开发」「开发 / 前端开发」挂在被整理目录下；旧「部署运维」被复用、未重复建
    // （D95：三个新目录各自直接承接 3 条——「开发」一级自己就有 3 条，二级才值得存在）
    const tree = await folders();
    const remote = tree.filter((f) => f.name === "远程控制");
    expect(remote).toHaveLength(1);
    expect(remote[0]!.parent_id).toBe(root.id);
    const dev = tree.filter((f) => f.name === "开发");
    expect(dev).toHaveLength(1);
    expect(dev[0]!.parent_id).toBe(root.id);
    const fe = tree.filter((f) => f.name === "前端开发");
    expect(fe).toHaveLength(1);
    expect(fe[0]!.parent_id).toBe(dev[0]!.id);
    expect(tree.filter((f) => f.name === "部署运维")).toEqual([deploy]);

    const folderOf = (title: string): string | undefined => env.store.getBookmark(byTitle(bookmarksSync(), title).id)?.folder_id;
    expect(folderOf("RustDesk 官网")).toBe(remote[0]!.id);
    expect(folderOf("Sill 远程控制")).toBe(remote[0]!.id);
    expect(folderOf("React 文档")).toBe(fe[0]!.id);
    expect(folderOf("Vue 指南")).toBe(fe[0]!.id);
    expect(folderOf("Angular 文档")).toBe(fe[0]!.id);
    expect(folderOf("ToDesk 官网")).toBe(remote[0]!.id);
    for (const name of ["掘金", "开源中国", "CSDN"]) expect(folderOf(name)).toBe(dev[0]!.id);
    expect(folderOf("Portainer")).toBe(deploy.id);
    // 已在合适目录（同一目录 ID）→ 保持，不产生空移动
    expect(folderOf("Portainer 文档中心")).toBe(deploy.id);
    expect(folderOf("某公司内网登录页")).toBe(root.id);

    // 转资料：书签软移出、资料 active、分类落库且来源为显式任务、版本归属已回填
    const docker = env.store.getBookmark(byTitle(await bookmarksSync(), "Docker 部署教程").id)!;
    expect(docker.materialized_at).toBeTruthy();
    const dockerMat = env.store.getMaterialByBookmark(docker.id)!;
    expect(env.store.getMaterialCategoryState(dockerMat.id)).toMatchObject({ category: "技术开发/容器部署", category_source: "organize_task" });
    expect(docker.materialized_version_id).toBeTruthy();
    const figma = env.store.getBookmark(byTitle(await bookmarksSync(), "Figma 自动布局教程").id)!;
    expect(figma.materialized_at).toBeTruthy();
    expect(env.store.getMaterialCategoryState(env.store.getMaterialByBookmark(figma.id)!.id)?.category).toBe("设计/界面设计");
    // 书签面不再重复保留（资料页可见）
    expect((await bookmarks()).some((b) => b.id === docker.id)).toBe(false);
    expect((await getJson<{ total: number }>("/materials")).total).toBe(2);

    // 版本关联任务
    const versions = env.store.taskVersions(t.id);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect(env.store.getVersion(v.id)).toMatchObject({ task_id: t.id, label: "organize_task" });
    }

    // 明细与结构接口
    const moved = await itemsOf(t.id, "moved");
    expect(moved.total).toBe(10);
    expect(moved.items.find((i) => i.title?.includes("React 文档"))?.to_path).toBe("常用收藏 / 开发 / 前端开发");
    const converted = await itemsOf(t.id, "converted");
    expect(converted.total).toBe(2);
    expect(converted.items.find((i) => i.title?.includes("Figma"))?.category_path).toBe("设计/界面设计");
    expect((await itemsOf(t.id, "unchanged")).total).toBe(2);
    expect((await itemsOf(t.id, "failed")).total).toBe(0);
    const structure = await getJson<{ folders: Array<{ path: string; state: string; actual_count: number }> }>(`/organize/tasks/${t.id}/folders`);
    expect(structure.folders.find((f) => f.path === "常用收藏 / 开发 / 前端开发")).toMatchObject({ state: "created", actual_count: 3 });
    expect(structure.folders.find((f) => f.path === "常用收藏 / 开发")).toMatchObject({ state: "created", actual_count: 3 });
    expect(structure.folders.find((f) => f.path === "常用收藏 / 远程控制")).toMatchObject({ state: "created", actual_count: 3 });
    expect(structure.folders.find((f) => f.path === "常用收藏 / 部署运维")).toMatchObject({ state: "reused", actual_count: 1 });
    const cats = await getJson<{ categories: Array<{ path: string; state: string; actual_count: number }> }>(`/organize/tasks/${t.id}/material-categories`);
    expect(cats.categories.map((c) => c.path).sort()).toEqual(["技术开发/容器部署", "设计/界面设计"]);
    expect(cats.categories.every((c) => c.state === "new" && c.actual_count === 1)).toBe(true);

    // 主题发现首轮不以旧目录名为标签集；映射在主题确定之后才发生
    const kinds = calls.map((c) => c.kind);
    expect(kinds.indexOf("map")).toBeGreaterThan(kinds.lastIndexOf("topics"));
    expect(calls.find((c) => c.kind === "topics")!.system).not.toContain("现有目录");
    // 模型输入不外发网址查询参数
    expect(calls.every((c) => !/[?&][a-z_]+=/.test(c.user))).toBe(true);
  });

  it("既有 active 资料被复用并改分类；迟到的自动分类不覆盖；撤销后分类回旧值、资料保留", async () => {
    const { client } = scriptedLlm();
    env = makeEnv(client);
    await ingest([{ url: "https://old92.example.com/a", title: "[content:旧文] 旧资料文章{cat:技术开发/新分类}", folderPath: ["收藏"] }]);
    const bm = byTitle(await bookmarks(), "旧资料文章");
    env.store.upsertCache({ bookmarkId: bm.id, l2Text: longText, fetchedVia: "extension_capture" });
    // D70 时代的「书签 + 资料并存」：已有 active 资料且带旧分类（来源 auto）
    const mat = env.store.upsertMaterial({ bookmarkId: bm.id, type: "article", signals: [] });
    expect(env.store.setMaterialCategory(mat.id, ["旧分类"])).toBe(true);

    const t = await runTask(folderByName(await folders(), "收藏").id);
    expect(t.converted).toBe(1);
    expect(t.reused_materials).toBe(1);
    expect(t.new_materials).toBe(0);
    expect(t.reused_categories).toBe(0);
    expect(env.store.getMaterialCategoryState(mat.id)).toMatchObject({ category: "技术开发/新分类", category_source: "organize_task" });
    expect(env.store.getMaterialByBookmark(bm.id)?.id).toBe(mat.id); // 同一条资料，不重复新增

    // 迟到的摘要/回填（来源 auto）不得覆盖显式任务分类
    expect(env.store.setMaterialCategory(mat.id, ["迟到的摘要分类"])).toBe(false);
    expect(env.store.getMaterialCategoryState(mat.id)?.category).toBe("技术开发/新分类");

    const undo = await post(`/organize/tasks/${t.id}/undo`);
    expect(undo.status).toBe(200);
    await waitIdle();
    const after = await view(t.id);
    expect(after.undo_status).toBe("completed");
    expect(after.undo_restored).toBe(1);
    expect(after.undo_categories).toBe(1);
    expect(env.store.getBookmark(bm.id)?.materialized_at).toBeNull(); // 恢复为书签
    expect(env.store.getMaterialCategoryState(mat.id)?.category).toBe("旧分类"); // 既有资料分类回旧值
    expect(env.store.getMaterial(mat.id)).toBeTruthy(); // 资料本体保留
  });

  it("同名目录按稳定 ID 选择：映射指向哪个就落到哪个，不取第一个同名目录", async () => {
    let targetId = "";
    const { client } = scriptedLlm({
      map: (nodes) => nodes.map((n) => ({ key: n.key, reuseId: n.name === "开发" ? targetId : null })),
    });
    env = makeEnv(client);
    await ingest([
      { url: "https://same92.example.com/a", title: "[site:开发] 待归位", folderPath: ["同名测试"] },
      { url: "https://same92.example.com/b", title: "甲组书签", folderPath: ["同名测试", "甲", "开发"] },
      { url: "https://same92.example.com/c", title: "乙组书签", folderPath: ["同名测试", "乙", "开发"] },
    ]);
    const tree = await folders();
    targetId = folderByName(tree, "开发", folderByName(tree, "乙").id).id;
    const t = await runTask(folderByName(tree, "同名测试").id);
    expect(t.moved).toBe(1);
    expect(env.store.getBookmark(byTitle(await bookmarks(), "待归位").id)?.folder_id).toBe(targetId);
    // 未新建同义目录，同名目录仍是两个不同实体
    expect((await folders()).filter((f) => f.name === "开发")).toHaveLength(2);
  });

  it("隐私前置：私密/隐私域条目不进模型、不落明细，只计入受保护汇总", async () => {
    const { client, calls } = scriptedLlm();
    env = makeEnv(client);
    env.store.addPrivacyPattern("bank92.example.com");
    await ingest([
      { url: "https://normal92.example.com/1", title: "[site:普通主题] 普通页面一", folderPath: ["隐私测试"] },
      { url: "https://bank92.example.com/account", title: "[site:普通主题] 隐私域页面", folderPath: ["隐私测试"] },
      { url: "https://normal92.example.com/2", title: "[site:普通主题] 私密页面", folderPath: ["隐私测试"] },
    ]);
    const rows = await bookmarks();
    const secret = byTitle(rows, "私密页面");
    const bank = byTitle(rows, "隐私域页面");
    env.store.updateBookmark(secret.id, { is_private: 1 });
    const root = folderByName(await folders(), "隐私测试");

    const t = await runTask(root.id);
    expect(t.total).toBe(3); // 受保护条目计入总数（它们计入 skipped，等式才成立）
    expect(t.protected_count).toBe(2);
    expect(t.skipped).toBe(2);
    expect(t.moved + t.converted + t.unchanged + t.skipped + t.failed + t.remaining).toBe(t.total);
    // 受保护条目不落明细行
    const stored = env.store.db.prepare("SELECT title FROM organize_task_item WHERE task_id = ?").all(t.id) as Array<{ title: string }>;
    expect(stored).toHaveLength(1);
    // 模型输入中不出现受保护条目的标题或域名
    const joined = calls.map((c) => `${c.system}\n${c.user}`).join("\n");
    expect(joined).not.toContain("隐私域页面");
    expect(joined).not.toContain("私密页面");
    expect(joined).not.toContain("bank92.example.com");
    const skipped = await itemsOf(t.id, "skipped");
    expect(skipped.total).toBe(0);
    expect(skipped.protectedCount).toBe(2);
    // 受保护书签原地不动
    expect(env.store.getBookmark(secret.id)?.folder_id).toBe(root.id);
    expect(env.store.getBookmark(bank.id)?.folder_id).toBe(root.id);
  });

  it("目录样本不外发私密标题：现有目录里有私密书签时，映射输入不含其标题", async () => {
    const { client, calls } = scriptedLlm();
    env = makeEnv(client);
    await ingest([
      { url: "https://s92.example.com/1", title: "[site:开发] 普通样本", folderPath: ["样本测试", "开发"] },
      { url: "https://s92.example.com/2", title: "机密项目内部文档", folderPath: ["样本测试", "开发"] },
      { url: "https://s92.example.com/3", title: "[site:开发] 待归位", folderPath: ["样本测试"] },
    ]);
    env.store.updateBookmark(byTitle(await bookmarks(), "机密项目内部文档").id, { is_private: 1 });
    await runTask(folderByName(await folders(), "样本测试").id);
    const mapCall = calls.find((c) => c.kind === "map")!;
    expect(mapCall.user).toContain("普通样本");
    expect(mapCall.user).not.toContain("机密项目内部文档");
    // 代表书签入口（D76 同源）同样不再返回私密标题
    const dev = folderByName(await folders(), "开发");
    expect(env.store.folderSampleTitles(3).get(dev.id) ?? []).not.toContain("机密项目内部文档");
  });
});

/** 书签面直读（转资料后列表接口不再返回该行，用 store 读全量） */
function bookmarksSync(): Bm[] {
  return env.store.db.prepare("SELECT id, title, folder_id FROM bookmarks").all() as Bm[];
}

describe("D94 落点范围：库内任意目录", () => {
  /**
   * 用户实机场景：整理「C 硬件」时，里面混着与硬件无关的购物导购站。
   * size = 每个主题的书签数（D95 之后新建目录至少 3 条同类，要建目录的用例得显式成组）
   */
  const hardwareTopics: Array<[topic: string, sub: string, names: string[]]> = [
    ["购物导购", "C03 外设", ["辣品导购平台", "什么值得买", "慢慢买"]],
    ["智能硬件", "C03 外设", ["安克创新官网", "绿联官网", "小米生态链"]],
    ["NAS 主机", "C01 NAS 主机", ["群晖官网", "威联通官网", "爱快"]],
  ];
  const hardwareItems = (size: number) =>
    hardwareTopics.flatMap(([topic, sub, names], i) =>
      names.slice(0, size).map((name, k) => ({ url: `https://h94.example.com/${i}-${k}`, title: `[site:${topic}] ${name}`, folderPath: ["C 硬件", sub] })),
    );
  async function seedHardware(size = 1): Promise<{ tree: FolderRow[]; ids: Record<string, string> }> {
    await ingest(hardwareItems(size));
    const rows = bookmarksSync();
    const ids: Record<string, string> = {};
    for (const r of rows) ids[cleanTitle(r.title)] = r.id;
    return { tree: await folders(), ids };
  }
  const structureOf = (id: string) =>
    getJson<{ folders: Array<{ path: string; state: string; outside: boolean }> }>(`/organize/tasks/${id}/folders`);

  it("与来源目录无关的内容归入库内其他现有目录（跨根），不在来源目录下硬建子目录", async () => {
    let shoppingId = "";
    const { client, calls } = scriptedLlm({
      map: (nodes) =>
        nodes.map((n) => ({ key: n.key, reuseId: n.name === "购物导购" ? shoppingId : null, place: "inside" as const })),
    });
    env = makeEnv(client);
    await ingest([
      { url: "https://shop94.example.com/1", title: "什么值得买", folderPath: ["购物"] },
      { url: "https://lapin94.example.com/", title: "[site:购物导购] 辣品导购平台", folderPath: ["C 硬件", "C03 外设"] },
      { url: "https://anker94.example.com/", title: "[site:智能硬件] 安克创新官网", folderPath: ["C 硬件", "C03 外设"] },
      { url: "https://ugreen94.example.com/", title: "[site:智能硬件] 绿联官网", folderPath: ["C 硬件"] },
      { url: "https://mi94.example.com/", title: "[site:智能硬件] 小米生态链", folderPath: ["C 硬件", "C03 外设"] },
    ]);
    shoppingId = folderByName(await folders(), "购物").id;
    const root = folderByName(await folders(), "C 硬件");
    const before = bookmarksSync();
    const t = await runTask(root.id);
    expect(t.moved).toBe(4); // 辣品 1 条 + 智能硬件 3 条（D95：3 条同类才值得在来源目录下建新目录）
    expect(t.moved_outside).toBe(1);
    // 购物导购站离开了硬件目录，归到已有的「购物」根目录；只有一条也照常复用——复用现有目录不受成组门槛限制
    expect(env.store.getBookmark(byTitle(before, "辣品导购平台").id)?.folder_id).toBe(shoppingId);
    const moved = await itemsOf(t.id, "moved");
    expect(moved.items.find((i) => i.title?.includes("辣品"))).toMatchObject({ from_path: "C 硬件 / C03 外设", to_path: "购物" });
    // 与硬件相关的主题仍建在来源目录之下
    const after = await folders();
    expect(after.filter((f) => f.name === "购物导购")).toHaveLength(0);
    const smart = after.find((f) => f.name === "智能硬件")!;
    expect(smart.parent_id).toBe(root.id);
    // 映射时模型看到的是全库目录（含其他根），并被明确告知落点不限于来源目录内部
    const mapCall = calls.find((c) => c.kind === "map")!;
    expect(mapCall.system).toContain("不限于「C 硬件」内部");
    expect(mapCall.user).toContain('"path":"购物"');
    expect(mapCall.user).toContain('"path":"C 硬件 / C03 外设"');
    // 目录变化：外部目录标记为来源之外
    const structure = await structureOf(t.id);
    expect(structure.folders.find((f) => f.path === "购物")).toMatchObject({ state: "reused", outside: true });
    expect(structure.folders.find((f) => f.path === "C 硬件 / 智能硬件")).toMatchObject({ state: "created", outside: false, actual_count: 3 });
  });

  it("库内没有合适目录、且与来源目录无关 → 新建顶级目录（同浏览器根），撤销时回收", async () => {
    const { client } = scriptedLlm({
      map: (nodes) => nodes.map((n) => ({ key: n.key, reuseId: null, place: n.name === "购物导购" ? ("top" as const) : ("inside" as const) })),
    });
    env = makeEnv(client);
    // 购物导购 3 条成组（建顶级目录）；另两个主题各 1 条，不足成组
    await ingest([
      ...hardwareItems(3).filter((it) => it.title.includes("[site:购物导购]")),
      { url: "https://anker94.example.com/", title: "[site:智能硬件] 安克创新官网", folderPath: ["C 硬件", "C03 外设"] },
      { url: "https://nas94.example.com/", title: "[site:NAS 主机] 群晖官网", folderPath: ["C 硬件", "C01 NAS 主机"] },
    ]);
    const tree = await folders();
    const ids: Record<string, string> = {};
    for (const r of bookmarksSync()) ids[cleanTitle(r.title)] = r.id;
    const root = folderByName(tree, "C 硬件");
    const peripheral = folderByName(tree, "C03 外设");
    const t = await runTask(root.id);
    expect(t.moved).toBe(3);
    expect(t.moved_outside).toBe(3); // 3 条购物导购全部归入新建的顶级目录
    const created = env.store.getFolder((await folders()).find((f) => f.name === "购物导购")!.id)!;
    expect(created).toBeTruthy();
    expect(created.parent_id).toBeNull(); // 顶级目录，不是「C 硬件 / 购物导购」
    expect(created.root).toBe(env.store.getFolder(root.id)!.root ?? "bar"); // 与被整理目录同处一个浏览器根
    expect(env.store.getBookmark(ids["辣品导购平台"]!)?.folder_id).toBe(created.id);
    expect((await itemsOf(t.id, "moved")).items.find((i) => i.title?.includes("辣品"))?.to_path).toBe("购物导购");
    // 整次撤销：书签回原位，新建的顶级目录因已空被回收
    expect((await post(`/organize/tasks/${t.id}/undo`)).status).toBe(200);
    await waitIdle();
    const undone = await view(t.id);
    expect(undone.undo_status).toBe("completed");
    expect(undone.undo_restored).toBe(3);
    expect(undone.undo_folders).toBeGreaterThanOrEqual(1);
    expect(env.store.getBookmark(ids["辣品导购平台"]!)?.folder_id).toBe(peripheral.id);
    expect((await folders()).some((f) => f.id === created.id)).toBe(false);
  });

  it("模型漏答落点时按名称兜底：与来源目录无关的主题建顶级目录，相关的建在其下", async () => {
    const { client } = scriptedLlm({ map: (nodes) => nodes.map((n) => ({ key: n.key, reuseId: null })) }); // 不带 place
    env = makeEnv(client);
    const { tree } = await seedHardware(3);
    await runTask(folderByName(tree, "C 硬件").id);
    const after = await folders();
    const root = folderByName(tree, "C 硬件");
    // 「购物导购」与「C 硬件 / C03 外设 / C01 NAS 主机」毫无共同词元 → 顶级
    expect(after.find((f) => f.name === "购物导购")?.parent_id).toBeNull();
    // 「智能硬件」与「C 硬件」共享「硬件」→ 来源目录之下
    expect(after.find((f) => f.name === "智能硬件")?.parent_id).toBe(root.id);
  });

  it("一次整理新建的顶级目录有上限：超出的主题保留原位并说明，不在根级铺一排目录", async () => {
    const topics = ["航空", "航天", "美食", "旅行", "摄影", "音乐", "电影", "体育", "理财", "育儿"];
    const { client } = scriptedLlm({ map: (nodes) => nodes.map((n) => ({ key: n.key, reuseId: null, place: "top" as const })) });
    env = makeEnv(client);
    // 每个主题 3 条：先成组，再轮到顶级数量闸筛选
    await ingest(
      topics.flatMap((name, i) =>
        Array.from({ length: 3 }, (_, k) => ({ url: `https://t94.example.com/${i}-${k}`, title: `[site:${name}] 条目${i}-${k}`, folderPath: ["C 硬件"] })),
      ),
    );
    const root = folderByName(await folders(), "C 硬件");
    const t = await runTask(root.id);
    expect(t.moved).toBe(24); // 8 个主题 × 3 条
    expect(t.moved_outside).toBe(24);
    expect(t.unchanged).toBe(6); // 2 个主题 × 3 条
    const kept = await itemsOf(t.id, "unchanged");
    expect(kept.total).toBe(6);
    expect(kept.items.map((i) => i.reason)).toEqual(Array(6).fill("new_roots_capped"));
    expect((await folders()).filter((f) => !f.parent_id && topics.includes(f.name))).toHaveLength(8);
  });

  it("「私人收藏」与收纳盒不可作为落点：模型指向它们时忽略，不让普通书签混进敏感目录", async () => {
    let privateId = "";
    const { client, calls } = scriptedLlm({
      map: (nodes) => nodes.map((n) => ({ key: n.key, reuseId: privateId || null, place: "inside" as const })),
    });
    env = makeEnv(client);
    env.store.createFolder("📥 收纳盒", null, "user", true);
    privateId = env.store.createFolder("私人收藏", null, "ai_created").id;
    await ingest(hardwareItems(3).filter((it) => it.title.includes("[site:购物导购]"))); // 3 条同类，本该成组移动
    const root = folderByName(await folders(), "C 硬件");
    const t = await runTask(root.id);
    expect(t.moved).toBe(3);
    expect(t.moved_outside).toBe(0); // 模型选的落点被忽略后，改在来源目录之下建目录
    for (const name of ["辣品导购平台", "什么值得买", "慢慢买"]) {
      expect(env.store.getBookmark(byTitle(bookmarksSync(), name).id)?.folder_id).not.toBe(privateId);
    }
    // 映射提示词的候选目录里根本不出现这两个目录，模型无从选中
    const mapCall = calls.find((c) => c.kind === "map")!;
    expect(mapCall.user).not.toContain("私人收藏");
    expect(mapCall.user).not.toContain("收纳盒");
  });
});

describe("D95 粒度控制：新目录至少 3 条同类", () => {
  const shoppingOnly = () => [
    { url: "https://lapin95.example.com/", title: "[site:购物导购] 辣品导购平台", folderPath: ["C 硬件", "C03 外设"] },
    { url: "https://smzdm95.example.com/", title: "[site:购物导购] 什么值得买", folderPath: ["C 硬件", "C03 外设"] },
    { url: "https://mmb95.example.com/", title: "[site:购物导购] 慢慢买", folderPath: ["C 硬件"] },
  ];

  it("一条书签一个目录不再发生：不足 3 条的主题不建目录，书签保留原位并逐条说明", async () => {
    const { client } = scriptedLlm({
      map: (nodes) => nodes.map((n) => ({ key: n.key, reuseId: null, place: n.name === "购物导购" ? ("top" as const) : ("inside" as const) })),
    });
    env = makeEnv(client);
    // 用户实机第二次整理的输入：每个主题都只有一条书签，模型也给每个主题单独立了名
    await ingest([
      { url: "https://d95.example.com/1", title: "[site:购物导购] 辣品导购平台", folderPath: ["C 硬件", "C03 外设"] },
      { url: "https://d95.example.com/2", title: "[site:物联网传感] 传感器之家", folderPath: ["C 硬件"] },
      { url: "https://d95.example.com/3", title: "[site:无人机硬件] 大疆官网", folderPath: ["C 硬件"] },
      { url: "https://d95.example.com/4", title: "[site:柔性显示技术] 柔宇", folderPath: ["C 硬件"] },
    ]);
    const before = await folders();
    const rows = bookmarksSync();
    const t = await runTask(folderByName(before, "C 硬件").id);
    expect(t.status).toBe("completed");
    expect(t.moved).toBe(0);
    expect(t.created_folders).toBe(0);
    expect(t.unchanged).toBe(4);
    // 一个目录都没多出来——来源目录下没有，根级也没有
    expect((await folders()).map((f) => f.id).sort()).toEqual(before.map((f) => f.id).sort());
    const kept = await itemsOf(t.id, "unchanged");
    expect(kept.items.map((i) => i.reason)).toEqual(Array(4).fill("too_few_to_group"));
    // 终态说明如实交代：不是「位置都合适」，而是同类太少没建目录
    expect(t.summary).toBe("已检查 4 条，有 4 条同类太少，未单独建目录，保留原位，本次未调整");
    expect(env.store.taskVersions(t.id)).toHaveLength(0); // 零变更 = 没有版本
    for (const r of rows) expect(env.store.getBookmark(r.id)?.folder_id).toBe(r.folder_id);
  });

  it("来源目录里之前自动整理建的小目录（放错的结果）不再是复用候选：不交给模型、也不作同名兜底，里面的书签重新归位", async () => {
    let seen: Array<{ id: string; path: string; aiCreated?: boolean }> = [];
    let remoteId = "";
    const { client, calls } = scriptedLlm({
      map: (nodes, folders) => {
        seen = folders;
        // 模型明确选中成组的自动整理目录时照常复用；其余不复用
        return nodes.map((n) => ({ key: n.key, reuseId: n.name === "远程控制" ? remoteId : null, place: "top" as const }));
      },
    });
    env = makeEnv(client);
    await ingest([
      ...shoppingOnly(),
      { url: "https://d95.example.com/life", title: "生活服务", folderPath: ["J 生活", "购物"] },
      { url: "https://d95.example.com/r0", title: "[site:远程控制] ToDesk 官网", folderPath: ["C 硬件", "C03 外设"] },
      { url: "https://d95.example.com/r1", title: "[site:远程控制] RustDesk 官网", folderPath: ["C 硬件", "临时"] },
      { url: "https://d95.example.com/r2", title: "[site:远程控制] Sill 远程控制", folderPath: ["C 硬件", "临时"] },
      { url: "https://d95.example.com/r3", title: "[site:远程控制] 向日葵", folderPath: ["C 硬件", "临时"] },
    ]);
    const tree = await folders();
    const root = folderByName(tree, "C 硬件");
    const rows = bookmarksSync();
    // 上一次自动整理留在硬件目录里的错误落点（用户实机：第二次整理又把辣品原样放了回去）
    const misplaced = env.store.createFolder("购物导购", root.id, "ai_created");
    env.store.moveBookmark(byTitle(rows, "辣品导购平台").id, misplaced.id);
    // 来源目录里自动整理建的成组目录（≥3 条）仍是候选；来源之外的小目录不受影响
    remoteId = env.store.createFolder("远程控制", root.id, "ai_created").id;
    for (const name of ["RustDesk 官网", "Sill 远程控制", "向日葵"]) env.store.moveBookmark(byTitle(rows, name).id, remoteId);
    const outsideSmall = env.store.createFolder("3D建模平台", null, "ai_created");
    const t = await runTask(root.id);
    // 辣品离开了那个放错的目录；成组的自动整理目录被照常复用，第四条远控书签归入其中
    expect(t.moved).toBe(4);
    expect(t.moved_outside).toBe(3);
    const created = (await folders()).find((f) => f.name === "购物导购" && !f.parent_id)!;
    expect(created).toBeTruthy();
    expect(env.store.getBookmark(byTitle(rows, "辣品导购平台").id)?.folder_id).toBe(created.id);
    expect(env.store.getFolder(misplaced.id)).toBeTruthy(); // 旧目录不删（删除永不自动执行），只是不再往里放
    expect(env.store.getBookmark(byTitle(rows, "ToDesk 官网").id)?.folder_id).toBe(remoteId);
    expect((await itemsOf(t.id, "unchanged")).items.filter((i) => i.reason === "already_placed")).toHaveLength(3);
    // 映射输入：放错的小目录根本不出现；成组的自动整理目录带 aiCreated 标记；来源之外的小目录照常是候选
    expect(seen.some((f) => f.id === misplaced.id)).toBe(false);
    expect(seen.find((f) => f.id === remoteId)).toMatchObject({ path: "C 硬件 / 远程控制", aiCreated: true });
    expect(seen.find((f) => f.id === outsideSmall.id)).toMatchObject({ path: "3D建模平台", aiCreated: true });
    expect(seen.find((f) => f.path === "J 生活 / 购物")).not.toHaveProperty("aiCreated");
    expect(calls.find((c) => c.kind === "map")!.system).toContain("aiCreated:true");
  });

  it("模型明确回答「不复用」时不被同名兜底覆盖；漏答时才按全库唯一的同名目录兜底", async () => {
    const run = async (answer: "null" | "omit") => {
      const { client } = scriptedLlm({
        map: (nodes) =>
          nodes.filter((n) => answer === "null" || n.name !== "购物导购").map((n) => ({ key: n.key, reuseId: null, place: "top" as const })),
      });
      const prev = env;
      env = makeEnv(client);
      prev?.cleanup();
      await ingest([...shoppingOnly(), { url: "https://d95.example.com/life", title: "生活服务", folderPath: ["J 生活", "购物导购"] }]);
      const existingId = folderByName(await folders(), "购物导购").id;
      const t = await runTask(folderByName(await folders(), "C 硬件").id);
      return { t, to: env.store.getBookmark(byTitle(bookmarksSync(), "辣品导购平台").id)?.folder_id, existingId };
    };
    const explicit = await run("null");
    expect(explicit.to).not.toBe(explicit.existingId); // 听模型的：另建顶级目录
    expect(explicit.t.moved_outside).toBe(3);
    const omitted = await run("omit");
    expect(omitted.to).toBe(omitted.existingId); // 漏答才兜底
  });

  it("与来源目录无关、同类太少的书签不留在原地：归入模型指定的最接近大类（直接放在它下面，不新建目录）", async () => {
    let lifeId = "";
    const { client, calls } = scriptedLlm({
      map: (nodes) =>
        nodes.map((n) => ({ key: n.key, reuseId: null, place: "top" as const, fallbackId: n.name === "购物导购" ? lifeId : null })),
    });
    env = makeEnv(client);
    await ingest([
      ...shoppingOnly().slice(0, 1),
      { url: "https://d95.example.com/life", title: "[site:生活购物] 什么值得买", folderPath: ["J 生活", "购物"] }, // 不在整理范围内
    ]);
    lifeId = folderByName(await folders(), "J 生活").id;
    const rows = bookmarksSync();
    const t = await runTask(folderByName(await folders(), "C 硬件").id);
    expect(t.moved).toBe(1);
    expect(t.moved_outside).toBe(1);
    expect(t.created_folders).toBe(0); // 没有为一条书签建目录
    // 辣品离开了硬件目录，直接落在大类根下（没有被硬塞进大类的某个子目录）
    expect(env.store.getBookmark(byTitle(rows, "辣品导购平台").id)?.folder_id).toBe(lifeId);
    const moved = await itemsOf(t.id, "moved");
    expect(moved.items[0]).toMatchObject({ reason: "fallback_category", from_path: "C 硬件 / C03 外设", to_path: "J 生活" });
    expect(t.summary).toBe("检查完成：书签归位 1 条"); // 不再说「同类太少，保留原位」
    const structure = await getJson<{ folders: Array<{ path: string; state: string; outside: boolean }> }>(
      `/organize/tasks/${t.id}/folders`,
    );
    expect(structure.folders).toEqual([expect.objectContaining({ path: "J 生活", state: "reused", outside: true })]);
    // 提示词要求模型为「与来源无关」的主题给出退路，并禁止把它指回来源目录
    const system = calls.find((c) => c.kind === "map")!.system;
    expect(system).toContain("fallbackId");
    expect(system).toContain("明显放错地方的书签必须离开它现在的目录");
  });

  it("属于来源目录主题的子方向同类太少时不外流：即使模型给了大类，也保留原位并说明", async () => {
    let lifeId = "";
    const { client } = scriptedLlm({
      map: (nodes) => nodes.map((n) => ({ key: n.key, reuseId: null, place: "inside" as const, fallbackId: lifeId || undefined })),
    });
    env = makeEnv(client);
    await ingest([
      { url: "https://d95.example.com/h1", title: "[site:无人机硬件] 大疆官网", folderPath: ["C 硬件", "C03 外设"] },
      { url: "https://d95.example.com/life", title: "[site:生活购物] 什么值得买", folderPath: ["J 生活", "购物"] },
    ]);
    lifeId = folderByName(await folders(), "J 生活").id;
    const rows = bookmarksSync();
    const t = await runTask(folderByName(await folders(), "C 硬件").id);
    expect(t.moved).toBe(0);
    expect(t.moved_outside).toBe(0);
    expect(env.store.getBookmark(byTitle(rows, "大疆官网").id)?.folder_id).toBe(folderByName(await folders(), "C03 外设").id);
    expect((await itemsOf(t.id, "unchanged")).items.find((i) => i.title?.includes("大疆"))).toMatchObject({ reason: "too_few_to_group" });
  });

  it("大类指向来源目录自己、它的子目录或不存在的目录时忽略：宁可保留原位，也不做一次没有意义的移动", async () => {
    const run = async (pick: (sourceId: string, subId: string) => string) => {
      const { client } = scriptedLlm({
        map: (nodes) => nodes.map((n) => ({ key: n.key, reuseId: null, place: "top" as const, fallbackId: pick(sourceId, subId) })),
      });
      const prev = env;
      env = makeEnv(client);
      prev?.cleanup();
      await ingest([{ url: "https://lapin95.example.com/", title: "[site:购物导购] 辣品导购平台", folderPath: ["C 硬件", "C03 外设"] }]);
      const tree = await folders();
      const sourceId = folderByName(tree, "C 硬件").id;
      const subId = folderByName(tree, "C03 外设").id;
      const t = await runTask(sourceId);
      return { moved: t.moved, outside: t.moved_outside, reasons: (await itemsOf(t.id, "unchanged")).items.map((i) => i.reason) };
    };
    const toSource = await run((sourceId) => sourceId);
    expect(toSource).toEqual({ moved: 0, outside: 0, reasons: ["too_few_to_group"] });
    const toSub = await run((sourceId, subId) => subId);
    expect(toSub).toEqual({ moved: 0, outside: 0, reasons: ["too_few_to_group"] });
    const toMissing = await run(() => "no-such-folder");
    expect(toMissing).toEqual({ moved: 0, outside: 0, reasons: ["too_few_to_group"] });
  });

  it("小主题先并入更宽的主题：合并后满 3 条只建一个目录，两个阶段的提示词都带成组门槛", async () => {
    const { client, calls } = scriptedLlm({
      consolidate: (topics) => ({ topics: topics.map((t) => ({ name: t.name, canonical: "智能设备" })) }),
      map: (nodes) => nodes.map((n) => ({ key: n.key, reuseId: null, place: "inside" as const })),
    });
    env = makeEnv(client);
    await ingest([
      { url: "https://d95.example.com/u1", title: "[site:无人机硬件] 大疆官网", folderPath: ["C 硬件"] },
      { url: "https://d95.example.com/w1", title: "[site:智能穿戴] 童伴官网", folderPath: ["C 硬件"] },
      { url: "https://d95.example.com/p1", title: "[site:投影设备] 极米官网", folderPath: ["C 硬件"] },
    ]);
    const root = folderByName(await folders(), "C 硬件");
    const t = await runTask(root.id);
    expect(t.moved).toBe(3);
    expect(t.created_folders).toBe(1);
    const created = (await folders()).find((f) => f.name === "智能设备")!;
    expect(created.parent_id).toBe(root.id);
    expect(calls.find((c) => c.kind === "topics")!.system).toContain("至少要有 3 条同类");
    expect(calls.find((c) => c.kind === "consolidate")!.system).toContain("少于 3 条的小主题");
  });

  it("两层目录各自成组：一级主题自己不成组、只保住一个子主题时不套两层，由一级主题承接", async () => {
    env = makeEnv(scriptedLlm().client);
    await ingest([
      { url: "https://d95.example.com/f1", title: "[site:开发/前端开发] React 文档", folderPath: ["常用收藏"] },
      { url: "https://d95.example.com/f2", title: "[site:开发/前端开发] Vue 指南", folderPath: ["常用收藏"] },
      { url: "https://d95.example.com/f3", title: "[site:开发/前端开发] Angular 文档", folderPath: ["常用收藏"] },
    ]);
    const root = folderByName(await folders(), "常用收藏");
    const t = await runTask(root.id);
    expect(t.moved).toBe(3);
    expect(t.created_folders).toBe(1);
    const tree = await folders();
    expect(tree.filter((f) => f.name === "前端开发")).toHaveLength(0); // 三条书签不占两层
    const dev = tree.find((f) => f.name === "开发")!;
    expect(dev.parent_id).toBe(root.id);
    expect(itemsIn(dev.id)).toBe(3);
  });

  it("保住两个成组的子主题时保留归组的一级目录（顶级落点也只占一个根级位置）", async () => {
    const { client } = scriptedLlm({ map: (nodes) => nodes.map((n) => ({ key: n.key, reuseId: null, place: "top" as const })) });
    env = makeEnv(client);
    await ingest([
      { url: "https://d95.example.com/f1", title: "[site:开发/前端开发] React 文档", folderPath: ["常用收藏"] },
      { url: "https://d95.example.com/f2", title: "[site:开发/前端开发] Vue 指南", folderPath: ["常用收藏"] },
      { url: "https://d95.example.com/f3", title: "[site:开发/前端开发] Angular 文档", folderPath: ["常用收藏"] },
      { url: "https://d95.example.com/b1", title: "[site:开发/后端开发] Spring 指南", folderPath: ["常用收藏"] },
      { url: "https://d95.example.com/b2", title: "[site:开发/后端开发] Django 文档", folderPath: ["常用收藏"] },
      { url: "https://d95.example.com/b3", title: "[site:开发/后端开发] Express 文档", folderPath: ["常用收藏"] },
    ]);
    const t = await runTask(folderByName(await folders(), "常用收藏").id);
    expect(t.moved).toBe(6);
    expect(t.created_folders).toBe(3);
    expect(t.moved_outside).toBe(6);
    const tree = await folders();
    const dev = tree.find((f) => f.name === "开发")!;
    expect(dev.parent_id).toBeNull(); // 归组目录只占一个根级位置
    expect(itemsIn(dev.id)).toBe(0);
    for (const name of ["前端开发", "后端开发"]) {
      const sub = tree.find((f) => f.name === name)!;
      expect(sub.parent_id).toBe(dev.id);
      expect(itemsIn(sub.id)).toBe(3);
    }
  });
});

describe("D92 冲突与失败：不漏不假成功", () => {
  it("等待期间用户修改 → 跳过不覆盖；其余条目照常处理", async () => {
    let mutated = false;
    const { client } = scriptedLlm({
      before: async (kind) => {
        if (kind !== "topics" || mutated) return;
        mutated = true;
        const target = byTitle(bookmarksSync(), "待修改");
        env.store.updateBookmark(target.id, { title: "待修改（用户已改名）" });
      },
    });
    env = makeEnv(client);
    await ingest([
      { url: "https://race92.example.com/a", title: "[site:竞争主题] 待修改", folderPath: ["并发测试"] },
      { url: "https://race92.example.com/b", title: "[site:竞争主题] 未被修改", folderPath: ["并发测试"] },
      { url: "https://race92.example.com/e", title: "[site:竞争主题] 第三条", folderPath: ["并发测试"] },
    ]);
    const root = folderByName(await folders(), "并发测试");
    const before = bookmarksSync();
    const t = await runTask(root.id);
    expect(t.moved).toBe(2);
    expect(t.skipped).toBe(1);
    const target = env.store.getBookmark(byTitle(before, "待修改").id)!;
    expect(target.title).toBe("待修改（用户已改名）"); // 用户的新标题未被覆盖
    expect(target.folder_id).toBe(root.id); // 旧计划没有搬走它
    const skipped = await itemsOf(t.id, "skipped");
    expect(skipped.items[0]).toMatchObject({ decision: "skip", reason: "modified_during_task" });
  });

  it("被其他流程先转资料 → 跳过 converted_elsewhere，不冒领为本次成果", async () => {
    let done = false;
    const { client } = scriptedLlm({
      before: async (kind) => {
        if (kind !== "topics" || done) return;
        done = true;
        const target = byTitle(bookmarksSync(), "被抢先转换");
        env.store.db.prepare("UPDATE bookmarks SET materialized_at = ? WHERE id = ?").run(new Date().toISOString(), target.id);
      },
    });
    env = makeEnv(client);
    await ingest([
      { url: "https://race92.example.com/c", title: "[site:竞争主题] 被抢先转换", folderPath: ["并发测试"] },
      { url: "https://race92.example.com/d", title: "[site:竞争主题] 正常条目", folderPath: ["并发测试"] },
      { url: "https://race92.example.com/f", title: "[site:竞争主题] 另一条", folderPath: ["并发测试"] },
    ]);
    const root = folderByName(await folders(), "并发测试");
    const t = await runTask(root.id);
    expect(t.moved).toBe(2);
    expect(t.converted).toBe(0);
    expect(t.skipped).toBe(1);
    const skipped = await itemsOf(t.id, "skipped");
    expect(skipped.items[0]).toMatchObject({ reason: "converted_elsewhere" });
    expect(env.store.getBookmark(byTitle(bookmarksSync(), "被抢先转换").id)?.folder_id).toBe(root.id);
  });

  it("正文抓取失败 / 正文过少 / 判为非资料 / 资料已被移出 / 低置信 → 各自有明确结果，不强行转换", async () => {
    const { client } = scriptedLlm();
    env = makeEnv(client, false, {
      crawlFetcher: async (url) => {
        if (url.includes("dead")) return { ok: false, status: 503, readBody: async () => Buffer.from(""), dispose: () => undefined };
        if (url.includes("thin")) {
          return { ok: true, status: 200, readBody: async () => Buffer.from("<html><body>太短</body></html>"), dispose: () => undefined };
        }
        return { ok: true, status: 200, readBody: async () => Buffer.from(articleHtml), dispose: () => undefined };
      },
    });
    await ingest([
      { url: "https://dead92.example.com/p", title: "[content:部署] 打不开的文章", folderPath: ["收藏"] },
      { url: "https://thin92.example.com/p", title: "[content:部署] 内容太少", folderPath: ["收藏"] },
      { url: "https://not92.example.com/p", title: "[content:部署] 判为非资料", folderPath: ["收藏"] },
      { url: "https://gone92.example.com/p", title: "[content:部署] 已移出资料", folderPath: ["收藏"] },
      { url: "https://low92.example.com/p", title: "[content:部署] 低置信文章", folderPath: ["收藏"] },
      { url: "https://deploy92.example.com/", title: "[site:部署] 部署工具站", folderPath: ["收藏"] },
    ]);
    const rows = bookmarksSync();
    env.store.upsertCache({ bookmarkId: byTitle(rows, "判为非资料").id, l2Text: longText, fetchedVia: "extension_capture" });
    env.store.upsertCache({ bookmarkId: byTitle(rows, "低置信文章").id, l2Text: longText, fetchedVia: "extension_capture" });
    const gone = byTitle(rows, "已移出资料");
    env.store.upsertMaterial({ bookmarkId: gone.id, type: "article", signals: [] });
    expect(env.store.dismissMaterial(env.store.getMaterialByBookmark(gone.id)!.id)).toBe(true);

    const root = folderByName(await folders(), "收藏");
    const t = await runTask(root.id);
    expect(t.status).toBe("completed_with_issues");
    expect(t.failed).toBe(1); // 抓取失败
    expect(t.converted).toBe(0); // 没有一条被强行转成资料
    expect(t.moved).toBe(3); // 正文过少 / 判为非资料 → 按书签参与主题归位（与另一条同类凑满 3 条才建目录）
    expect(t.skipped).toBe(1); // 资料已被用户移出
    expect(t.unchanged).toBe(1); // 低置信保留原位
    expect(t.moved + t.converted + t.unchanged + t.skipped + t.failed + t.remaining).toBe(t.total);
    expect(t.summary).toBe("检查完成，有 1 条处理失败");
    const failed = await itemsOf(t.id, "failed");
    expect(failed.items[0]).toMatchObject({ retryable: true });
    expect(failed.items[0]!.reason).toContain("crawl_failed");
    // 资料已被移出的那条：书签仍可见、资料未被复活
    expect(env.store.getBookmark(gone.id)?.materialized_at).toBeNull();
    expect(env.store.getActiveMaterialByBookmark(gone.id)).toBeUndefined();
    expect((await itemsOf(t.id, "skipped")).items[0]).toMatchObject({ reason: "material_dismissed" });
    expect((await itemsOf(t.id, "unchanged")).items[0]).toMatchObject({ reason: "insufficient_evidence" });
  });

  it("模型故障如实计失败（可重试）；重试失败项后完成", async () => {
    const script: Script = { failTopics: true };
    const { client } = scriptedLlm(script);
    env = makeEnv(client);
    await ingest([
      { url: "https://fail92.example.com/a", title: "[site:失败主题] 甲", folderPath: ["失败测试"] },
      { url: "https://fail92.example.com/b", title: "[site:失败主题] 乙", folderPath: ["失败测试"] },
      { url: "https://fail92.example.com/c", title: "[site:失败主题] 丙", folderPath: ["失败测试"] },
    ]);
    const root = folderByName(await folders(), "失败测试");
    const t = await runTask(root.id);
    expect(t.status).toBe("completed_with_issues");
    expect(t.failed).toBe(3);
    expect(t.moved).toBe(0);
    expect(t.remaining).toBe(0);
    expect(t.summary).toBe("检查完成，有 3 条处理失败"); // 不是「分类一致，无需挪动」
    expect((await folders()).filter((f) => f.name === "失败主题")).toHaveLength(0); // 没有目录被建出来
    expect(env.store.taskVersions(t.id)).toHaveLength(0); // 没有版本 = 没有任何变更

    script.failTopics = false;
    const cont = await post(`/organize/tasks/${t.id}/continue`, { mode: "failed" });
    expect(cont.status).toBe(200);
    expect(((await cont.json()) as { reopened: number }).reopened).toBe(3);
    await waitIdle();
    const after = await view(t.id);
    expect(after.status).toBe("completed");
    expect(after.moved).toBe(3);
    expect(after.failed).toBe(0);
    expect((await folders()).filter((f) => f.name === "失败主题")).toHaveLength(1);
  });

  it("规划失败 → 整任务失败、零变更、可继续；规划失败不静默退化成全建新目录", async () => {
    const script: Script = { failMap: true };
    const { client } = scriptedLlm(script);
    env = makeEnv(client);
    await ingest([
      { url: "https://plan92.example.com/a", title: "[site:规划主题] 甲", folderPath: ["规划测试"] },
      { url: "https://plan92.example.com/b", title: "[site:规划主题] 乙", folderPath: ["规划测试"] },
      { url: "https://plan92.example.com/c", title: "[site:规划主题] 丙", folderPath: ["规划测试"] },
    ]);
    const root = folderByName(await folders(), "规划测试");
    const t = await runTask(root.id);
    expect(t.status).toBe("failed");
    expect(t.error).toContain("目录方案规划失败");
    expect(t.remaining).toBe(3);
    expect(t.moved).toBe(0);
    expect((await folders()).filter((f) => f.name === "规划主题")).toHaveLength(0);
    expect(env.store.taskVersions(t.id)).toHaveLength(0);

    script.failMap = false;
    expect((await post(`/organize/tasks/${t.id}/continue`, { mode: "remaining" })).status).toBe(200);
    await waitIdle();
    const after = await view(t.id);
    expect(after.status).toBe("completed");
    expect(after.moved).toBe(3);
  });
});

describe("D92/D94 无模型规则降级", () => {
  it("规则命中且库内有唯一同名目录才移动（来源目录内优先）；不建新目录、不做资料分流", async () => {
    env = makeEnv(null);
    await ingest([
      { url: "https://github.com/acme/one", title: "甲", folderPath: ["工作"] },
      { url: "https://unknown92.example.com/x", title: "乙", folderPath: ["工作"] },
      { url: "https://github.com/acme/two", title: "丙", folderPath: ["工作", "开发"] },
      { url: "https://github.com/acme/three", title: "丁", folderPath: ["生活"] },
      { url: "https://figma.com/acme/design", title: "戊", folderPath: ["生活"] },
    ]);
    const tree = await folders();
    const work = folderByName(tree, "工作");
    const dev = folderByName(tree, "开发", work.id);
    const t = await runTask(work.id);
    expect(t.mode).toBe("rule_only");
    expect(t.status).toBe("completed_with_issues"); // 规则检查结束 ≠ AI 整理成功
    expect(t.moved).toBe(1); // 甲 → 工作/开发
    expect(t.unchanged).toBe(2); // 乙规则未命中；丙已在合适位置
    expect(t.summary).toContain("未配置模型");
    const rows = bookmarksSync();
    expect(env.store.getBookmark(byTitle(rows, "甲").id)?.folder_id).toBe(dev.id);
    expect((await folders()).length).toBe(tree.length); // 没有新建目录
    expect((await itemsOf(t.id, "unchanged")).items.map((i) => i.reason).sort()).toEqual(["already_placed", "rule_unmatched"]);

    // D94：规则指向的目录是库内任意目录——来源目录里没有「开发」，就归到别处的「开发」（跨根）
    const life = await runTask(folderByName(tree, "生活").id);
    expect(life.moved).toBe(1);
    expect(life.moved_outside).toBe(1);
    expect(env.store.getBookmark(byTitle(bookmarksSync(), "丁").id)?.folder_id).toBe(dev.id);
    expect((await itemsOf(life.id, "moved")).items[0]?.to_path).toBe("工作 / 开发");
    // 库内没有任何「设计」目录：规则模式不凭映射建目录，如实说明找不到目标
    expect((await itemsOf(life.id, "unchanged")).items[0]).toMatchObject({ reason: "rule_target_not_found" });
    expect((await folders()).length).toBe(tree.length);
  });

  it("规则模式同名目录歧义：来源目录内恰有一个时取它，来源内没有且全库不唯一时保留", async () => {
    env = makeEnv(null);
    await ingest([
      { url: "https://github.com/acme/one", title: "待归位", folderPath: ["整理目标", "开发"] },
      { url: "https://github.com/acme/two", title: "另一处一", folderPath: ["甲", "开发"] },
      { url: "https://github.com/acme/three", title: "另一处二", folderPath: ["乙", "开发"] },
    ]);
    const tree = await folders();
    // 来源「整理目标」内恰有一个「开发」→ 归到它，不被库外两个同名目录干扰
    const own = await runTask(folderByName(tree, "整理目标").id);
    expect(own.moved).toBe(0); // 唯一的书签本来就在「整理目标 / 开发」里
    expect((await itemsOf(own.id, "unchanged")).items[0]).toMatchObject({ reason: "already_placed" });

    // 再放一条到「整理目标」根下：来源内「开发」唯一 → 归位
    await ingest([{ url: "https://github.com/acme/four", title: "根下待归位", folderPath: ["整理目标"] }]);
    const second = await runTask(folderByName(tree, "整理目标").id);
    expect(second.moved).toBe(1);
    expect(env.store.getBookmark(byTitle(bookmarksSync(), "根下待归位").id)?.folder_id).toBe(
      folderByName(tree, "开发", folderByName(tree, "整理目标").id).id,
    );

    // 来源「甲」内没有同名目标，但「开发」在全库不唯一 → 保留并说明歧义
    await ingest([{ url: "https://github.com/acme/five", title: "歧义用例", folderPath: ["丙"] }]);
    const amb = await runTask(folderByName(await folders(), "丙").id);
    expect(amb.moved).toBe(0);
    expect((await itemsOf(amb.id, "unchanged")).items[0]).toMatchObject({ reason: "ambiguous_target" });
  });

  it("超过 500 条也全范围覆盖：后半段条目同样被处理，计数等式成立", async () => {
    env = makeEnv(null);
    await ingest([
      { url: "https://github.com/acme/seed", title: "种子", folderPath: ["大批量", "开发"] },
      ...Array.from({ length: 520 }, (_, i) => ({ url: `https://github.com/acme/bulk-${i}`, title: `批量 ${i}`, folderPath: ["大批量"] })),
    ]);
    const tree = await folders();
    const root = folderByName(tree, "大批量");
    const dev = folderByName(tree, "开发", root.id);
    const t = await runTask(root.id);
    expect(t.total).toBe(521);
    expect(t.checked).toBe(521);
    expect(t.remaining).toBe(0);
    expect(t.moved).toBe(520);
    expect(t.unchanged).toBe(1);
    expect(t.moved + t.converted + t.unchanged + t.skipped + t.failed + t.remaining).toBe(t.total);
    expect(env.store.taskVersions(t.id).length).toBeGreaterThanOrEqual(18); // 分批提交（每批 ≤30）
    const inDev = (env.store.db.prepare("SELECT COUNT(*) AS c FROM bookmarks WHERE folder_id = ?").get(dev.id) as { c: number }).c;
    expect(inDev).toBe(521);
  });
});

describe("D92 停止、继续与撤销", () => {
  it("规划中停止：零提交、剩余保留；继续剩余只处理未完成项", async () => {
    const block = blockedTopics();
    env = makeEnv(scriptedLlm(block.script).client);
    try {
      await ingest([
        { url: "https://stop92.example.com/a", title: "[site:停止主题] 甲", folderPath: ["停止测试"] },
        { url: "https://stop92.example.com/b", title: "[site:停止主题] 乙", folderPath: ["停止测试"] },
        { url: "https://stop92.example.com/c", title: "[site:停止主题] 丙", folderPath: ["停止测试"] },
      ]);
      const root = folderByName(await folders(), "停止测试");
      const { task } = await createTask(root.id);
      await block.entered;
      const stopped = await post(`/organize/tasks/${task.id}/stop`);
      expect(((await stopped.json()) as { task: TaskView }).task.status).toBe("stopping");
      block.release();
      await waitIdle();
      const t = await view(task.id);
      expect(t.status).toBe("stopped");
      expect(t.remaining).toBe(3);
      expect(t.moved).toBe(0);
      expect(t.summary).toContain("已停止");
      expect((await folders()).filter((f) => f.name === "停止主题")).toHaveLength(0);
      // 已终态：再停止是幂等的
      expect((await view(task.id)).status).toBe("stopped");

      expect((await post(`/organize/tasks/${task.id}/continue`, { mode: "remaining" })).status).toBe(200);
      await waitIdle();
      const after = await view(task.id);
      expect(after.status).toBe("completed");
      expect(after.moved).toBe(3);
      expect(after.remaining).toBe(0);
    } finally {
      block.release();
    }
  });

  it("提交屏障：已进入原子提交的批次可完成，之后的批次不再提交", async () => {
    env = makeEnv(null);
    await ingest([
      { url: "https://github.com/acme/seed", title: "种子", folderPath: ["屏障", "开发"] },
      ...Array.from({ length: 40 }, (_, i) => ({ url: `https://github.com/acme/barrier-${i}`, title: `批量 ${i}`, folderPath: ["屏障"] })),
    ]);
    const root = folderByName(await folders(), "屏障");
    const { task } = await createTask(root.id);
    // 第一批提交过程中停止请求落地（模拟用户恰好在批次之间/之中点了停止）
    const original = env.store.moveBookmark.bind(env.store);
    let tripped = false;
    vi.spyOn(env.store, "moveBookmark").mockImplementation((id: string, to: string) => {
      const r = original(id, to);
      if (!tripped) {
        tripped = true;
        env.store.db.prepare("UPDATE organize_task SET status = 'stopping' WHERE id = ?").run(task.id);
      }
      return r;
    });
    await waitIdle();
    vi.restoreAllMocks();
    const t = await view(task.id);
    expect(t.status).toBe("stopped");
    expect(t.moved).toBe(30); // 首批（≤30）完整提交
    expect(t.remaining).toBe(11); // 其余 11 条（40 条待移动 + 1 条保持）未提交，保留为未完成
    expect(t.checked).toBe(30);
    expect(t.summary).toContain("剩余 11");

    expect((await post(`/organize/tasks/${task.id}/continue`, { mode: "remaining" })).status).toBe(200);
    await waitIdle();
    const after = await view(task.id);
    expect(after.status).toBe("completed_with_issues"); // 规则模式恒为「需说明」：规则检查结束 ≠ AI 整理成功
    expect(after.moved).toBe(40);
    expect(after.remaining).toBe(0);
  });

  async function seedForUndo(): Promise<{ root: FolderRow; t: TaskView; ids: Record<string, string> }> {
    const { client } = scriptedLlm();
    env = makeEnv(client);
    await ingest([
      { url: "https://u92.example.com/1", title: "[site:远程控制] 远控一", folderPath: ["撤销测试"] },
      { url: "https://u92.example.com/2", title: "[site:远程控制] 远控二", folderPath: ["撤销测试", "旧目录"] },
      { url: "https://u92.example.com/6", title: "[site:远程控制] 远控三", folderPath: ["撤销测试"] },
      { url: "https://u92.example.com/3", title: "[site:运维] 运维一", folderPath: ["撤销测试"] },
      { url: "https://u92.example.com/4", title: "[content:文章] 一篇文章{cat:技术开发/随笔}", folderPath: ["撤销测试"] },
      { url: "https://u92.example.com/5", title: "[site:运维] 保持原位", folderPath: ["撤销测试", "运维"] },
    ]);
    const rows = bookmarksSync();
    env.store.upsertCache({ bookmarkId: byTitle(rows, "一篇文章").id, l2Text: longText, fetchedVia: "extension_capture" });
    const tree = await folders();
    const root = folderByName(tree, "撤销测试");
    const t = await runTask(root.id);
    const ids: Record<string, string> = {};
    for (const r of rows) ids[cleanTitle(r.title)] = r.id;
    return { root, t, ids };
  }

  it("整次撤销：书签回原位、资料保留、AI 目录回收、被用户改过的目录保留；撤销后不能再继续", async () => {
    const { root, t, ids } = await seedForUndo();
    expect(t.moved).toBe(4); // 远控一 / 远控二 / 远控三 → 新建「远程控制」；运维一 → 既有「运维」
    expect(t.converted).toBe(1);
    expect(t.unchanged).toBe(1); // 「保持原位」已在合适目录
    expect(t.created_folders).toBe(1);
    const treeBefore = await folders();
    const remote = folderByName(treeBefore, "远程控制");
    // 用户在整理后改动了其中一个 AI 目录：撤销时必须保留
    env.store.renameFolder(remote.id, "远程控制（用户改名）");

    expect((await post(`/organize/tasks/${t.id}/undo`)).status).toBe(200);
    await waitIdle();
    const after = await view(t.id);
    expect(after.undo_status).toBe("completed");
    expect(after.undo_restored).toBe(5); // 4 条归位 + 1 条转资料
    expect(after.undo_kept).toBe(0);
    expect(after.undo_folders).toBe(0); // 被用户改名的目录未回收
    // 撤销后旧任务永久不能沿原方案继续
    const cont = await post(`/organize/tasks/${t.id}/continue`, { mode: "remaining" });
    expect(cont.status).toBe(409);
    expect(((await cont.json()) as { error: string }).error).toBe("task_undo_started");
    // 幂等：重复撤销请求返回当前状态，不重复逆放
    const again = await post(`/organize/tasks/${t.id}/undo`);
    expect(((await (await again.json()) as { task: TaskView }).task).undo_restored).toBe(5);

    const rows = bookmarksSync();
    const folderOf = (title: string): string | undefined => env.store.getBookmark(byTitle(rows, title).id)?.folder_id;
    expect(folderOf("远控一")).toBe(root.id);
    expect(folderOf("远控二")).toBe(folderByName(treeBefore, "旧目录").id);
    expect(folderOf("远控三")).toBe(root.id);
    expect(folderOf("运维一")).toBe(root.id);
    // 转资料的条目恢复为普通书签，回到原目录；资料与分类保留
    const article = env.store.getBookmark(ids["一篇文章"]!)!;
    expect(article.materialized_at).toBeNull();
    expect(article.folder_id).toBe(root.id);
    expect(env.store.getMaterialCategoryState(env.store.getMaterialByBookmark(article.id)!.id)?.category).toBe("技术开发/随笔");
    expect((await bookmarks()).some((b) => b.id === article.id)).toBe(true);
    const treeAfter = await folders();
    expect(treeAfter.some((f) => f.id === remote.id && f.name === "远程控制（用户改名）")).toBe(true); // 用户改过的目录保留
    expect(folderByName(treeBefore, "运维").id).toBe(folderByName(treeAfter, "运维").id); // 用户原有目录从未被动
    // 版本历史：任务批次均已标记撤销
    expect(env.store.taskVersions(t.id).every((v) => v.reverted === 1)).toBe(true);
    expect(after.moved).toBe(4); // 原始整理的计数是历史事实，不被撤销抹掉
  });

  it("撤销不覆盖整理后的用户修改：被改过的条目保留并计数", async () => {
    const { t, ids } = await seedForUndo();
    // 用户在整理后手动移动了其中一条
    const other = folderByName(await folders(), "运维");
    env.store.moveBookmark(ids["远控一"]!, other.id);
    expect((await post(`/organize/tasks/${t.id}/undo`)).status).toBe(200);
    await waitIdle();
    const after = await view(t.id);
    expect(after.undo_status).toBe("partial");
    expect(after.undo_restored).toBe(4); // 3 条归位 + 1 条转资料
    expect(after.undo_kept).toBe(1);
    expect(env.store.getBookmark(ids["远控一"]!)?.folder_id).toBe(other.id); // 用户的手动移动未被覆盖
  });

  it("单批撤销（版本历史入口）只逆放该批；其余批次保留，任务进入 partial", async () => {
    env = makeEnv(null);
    await ingest([
      { url: "https://github.com/acme/seed", title: "种子", folderPath: ["分批", "开发"] },
      ...Array.from({ length: 35 }, (_, i) => ({ url: `https://github.com/acme/part-${i}`, title: `批量 ${i}`, folderPath: ["分批"] })),
    ]);
    const root = folderByName(await folders(), "分批");
    const t = await runTask(root.id);
    expect(t.moved).toBe(35);
    const versions = env.store.taskVersions(t.id);
    expect(versions).toHaveLength(2); // 30 + 5
    const first = env.store.getVersion(versions[0]!.id)!;
    const firstIds = (first.actions as Array<{ bookmarkId?: string }>).map((a) => a.bookmarkId!);
    const res = await post(`/organize/rollback/${versions[0]!.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reversed: number; taskId: string; undoStatus: string };
    expect(body.reversed).toBe(30);
    expect(body.taskId).toBe(t.id);
    expect(body.undoStatus).toBe("partial");
    await waitIdle();
    // 该批书签回到原目录；另一批未被触碰
    const back = env.store.db.prepare(`SELECT COUNT(*) AS c FROM bookmarks WHERE id IN (${firstIds.map(() => "?").join(",")}) AND folder_id = ?`).get(...firstIds, root.id) as { c: number };
    expect(back.c).toBe(30);
    expect(env.store.taskVersions(t.id).map((v) => v.reverted).sort()).toEqual([0, 1]);
    expect((await post(`/organize/tasks/${t.id}/continue`, { mode: "remaining" })).status).toBe(409);
    // 重复撤销同一批：已撤销 → 400
    expect((await post(`/organize/rollback/${versions[0]!.id}`)).status).toBe(400);
  });

  it("没有已生效调整的任务不能撤销", async () => {
    env = makeEnv(null);
    await ingest([{ url: "https://none92.example.com/x", title: "甲", folderPath: ["空调整"] }]);
    const t = await runTask(folderByName(await folders(), "空调整").id);
    expect(t.moved + t.converted).toBe(0);
    const res = await post(`/organize/tasks/${t.id}/undo`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("nothing_to_undo");
  });

  it("明细过期：禁用继续但保留历史计数；撤销依赖版本事实，不因过期失效", async () => {
    const { t, ids } = await seedForUndo();
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    env.store.db.prepare("UPDATE organize_task SET created_at = ? WHERE id = ?").run(old, t.id);
    expect(env.store.pruneOrganizeTasks()).toBeGreaterThan(0);
    // 活动任务不裁剪：数量口径下新的任务不受影响
    const after = await view(t.id);
    expect(after.can_continue).toBe(false);
    expect(after.moved).toBe(4); // 历史计数保留
    expect((await itemsOf(t.id)).total).toBe(0); // 逐条明细已裁剪
    const cont = await post(`/organize/tasks/${t.id}/continue`, { mode: "remaining" });
    expect(cont.status).toBe(409);
    expect(((await cont.json()) as { error: string }).error).toBe("task_snapshot_expired");
    expect((await post(`/organize/tasks/${t.id}/undo`)).status).toBe(200);
    await waitIdle();
    expect(env.store.getBookmark(ids["远控一"]!)?.folder_id).toBe(folderByName(await folders(), "撤销测试").id);
  });
});

describe("D92 恢复与隔离", () => {
  it("重启恢复：失联 worker 的租约被接管，新 worker 接续完成；旧 worker 晚到的结果无权再写", async () => {
    const block = blockedTopics();
    env = makeEnv(scriptedLlm(block.script).client);
    const fresh = scriptedLlm();
    const serviceB = new OrganizeTaskService(env.store, () => fresh.client, env.pipeline, env.organize);
    try {
      await ingest([
        { url: "https://restart92.example.com/a", title: "[site:恢复主题] 甲", folderPath: ["恢复测试"] },
        { url: "https://restart92.example.com/b", title: "[site:恢复主题] 乙", folderPath: ["恢复测试"] },
        { url: "https://restart92.example.com/c", title: "[site:恢复主题] 丙", folderPath: ["恢复测试"] },
      ]);
      const root = folderByName(await folders(), "恢复测试");
      const { task } = await createTask(root.id);
      await block.entered;
      expect((await view(task.id)).status).toBe("running");

      // 模拟进程重启：旧 worker 的租约已过期 → 新 worker 接管；旧 worker 的模型调用此刻才返回
      env.store.updateOrganizeTask(task.id, { lease_at: new Date(Date.now() - 120_000).toISOString() });
      serviceB.resumeInterrupted();
      block.release();
      await serviceB.idle();
      const done = await view(task.id);
      expect(done.status).toBe("completed");
      expect(done.moved).toBe(3);
      const revision = done.revision;

      // 旧 worker 拿到晚到的模型结果：租约已易主，不得写入任何状态或重复移动
      await waitIdle();
      const settled = await view(task.id);
      expect(settled.revision).toBe(revision);
      expect(settled.moved).toBe(3);
      expect(env.store.taskVersions(task.id)).toHaveLength(1);
    } finally {
      block.release();
      serviceB.stopResumer();
    }
  });

  it("多用户隔离：任务只对所属用户可见；换账号后查询按不存在处理", async () => {
    const cred = "d92-fixture-pass-1";
    const register = async (username: string): Promise<string> => {
      const res = await env.app.request("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: cred, label: `device-${username}` }),
      });
      return ((await res.json()) as { token: string }).token;
    };
    env = makeEnv(null);
    const alice = await register("alice-d92");
    const bob = await register("bob-d92");
    const asAlice = { authorization: `Bearer ${alice}` };
    const asBob = { authorization: `Bearer ${bob}` };
    await ingest([{ url: "https://github.com/acme/one", title: "甲", folderPath: ["工作", "开发"] }, { url: "https://github.com/acme/two", title: "乙", folderPath: ["工作"] }], asAlice);
    const root = folderByName(await folders(asAlice), "工作");
    const t = await runTask(root.id, asAlice);
    expect(t.moved).toBe(1);

    expect((await env.app.request(`/api/v1/organize/tasks/${t.id}`, { headers: asBob })).status).toBe(404);
    expect((await env.app.request(`/api/v1/organize/tasks/${t.id}/items`, { headers: asBob })).status).toBe(404);
    const bobList = await getJson<{ total: number }>("/organize/tasks", asBob);
    expect(bobList.total).toBe(0);
    const aliceList = await getJson<{ total: number; tasks: Array<{ id: string }> }>("/organize/tasks", asAlice);
    expect(aliceList.total).toBe(1);
    expect(aliceList.tasks[0]!.id).toBe(t.id);
    // 另一个用户在自己的库里发起整理互不影响（各账号一个执行槽，数据按库隔离）
    await ingest([{ url: "https://github.com/acme/one", title: "乙的甲", folderPath: ["工作", "开发"] }, { url: "https://github.com/acme/two", title: "乙的乙", folderPath: ["工作"] }], asBob);
    const bobTask = await runTask(folderByName(await folders(asBob), "工作").id, asBob);
    expect(bobTask.moved).toBe(1);
    expect((await view(t.id, asAlice)).moved).toBe(1); // 甲的任务未被乙的操作触碰
  });

  it("SSE 任务门铃：任务状态变化推 event:task（只带 taskId），书签变更门铃照旧", async () => {
    env = makeEnv(null);
    const ac = new AbortController();
    const res = await env.app.request("/api/v1/events/stream", { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    let closed = false;
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        text += dec.decode(value, { stream: true });
      }
    })();
    void pump.catch(() => undefined);
    try {
      await ingest([{ url: "https://github.com/acme/one", title: "甲", folderPath: ["门铃测试"] }, { url: "https://github.com/acme/seed", title: "种子", folderPath: ["门铃测试", "开发"] }]);
      const root = folderByName(await folders(), "门铃测试");
      const { task } = await createTask(root.id);
      await waitIdle();
      const deadline = Date.now() + 6000;
      while (!text.includes("event: task") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(text).toContain("event: task");
      expect(text).toContain(task.id);
      expect(text).toContain("event: change"); // 提交产生的书签变更门铃仍在
    } finally {
      closed = true;
      ac.abort();
    }
  });
});
