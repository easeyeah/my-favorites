/**
 * D92 目录整理任务 · ?mock 演示桩
 *
 * 与服务端同契约（创建受理 / 快照 / 明细分页 / 目录与资料分类变化 / 停止 / 继续 / 撤销 / 门铃），
 * 用定时器模拟「规划 → 分批提交 → 汇总」的真实推进：每个批次真正移动书签、建目录、转资料，
 * 不是只播一段永远成功的动画。停止只在批次边界生效（已提交的保留）；撤销恢复书签、资料保留。
 *
 * 不反向依赖 mock.ts（避免循环引用）——数据与 ID 生成经 env 注入。
 */
import type {
  OrganizeTask,
  OrganizeTaskCategory,
  OrganizeTaskFolder,
  OrganizeTaskItem,
  VersionRow,
} from "./api";

type MockBm = {
  id: string;
  title: string;
  url_canonical: string;
  folder_id: string;
  status: string;
  is_private: number;
  materialized?: boolean;
};
type MockFolder = { id: string; name: string; parent_id: string | null; is_system_inbox?: number };
interface MockMat {
  id: string;
  bookmark_id: string;
  type: "article" | "video" | "image";
  category: string | null;
  created_at: string;
  signals: string[];
  textLen: number;
  cover: boolean;
  materialized?: 0 | 1;
}
interface MockVer extends VersionRow {
  moves?: Array<{ id: string; from: string }>;
  createdFolders?: string[];
  convertIds?: string[];
}
export interface MockTaskDb {
  folders: MockFolder[];
  bookmarks: MockBm[];
  materials: MockMat[];
  versions: MockVer[];
}
export interface MockTaskEnv {
  /** 每次取最新引用（mock 库的数组会被整体替换，不能缓存） */
  db: () => MockTaskDb;
  nid: (prefix: string) => string;
  now: () => string;
}

/** 规划结论（规划阶段确定，提交阶段只执行——与服务端「计划 ≠ 成果」同口径） */
interface Plan {
  decision: "move" | "convert";
  /** 书签落点节点 key；convert 为 null */
  key: string | null;
  category: string | null;
  reason: string;
  /** D94：复用库内已有的其他目录（可在来源目录之外） */
  reuseId: string | null;
  /** D94：与来源目录主题无关、库内又没有对应目录 → 新建顶级目录 */
  top: boolean;
}
type MockItem = OrganizeTaskItem & { plan: Plan | null; fromFolder: string };
interface Node {
  key: string;
  name: string;
  parentKey: string | null;
  reuseId: string | null;
  id: string | null;
  /** 与服务端同口径：一级新建节点建在来源目录之下还是顶级 */
  placement?: "inside" | "top";
}
interface MockTask extends OrganizeTask {
  requestId: string;
  items: MockItem[];
  nodes: Node[];
  cats: Array<{ path: string; existedBefore: boolean }>;
  versionId: string | null;
  /** 来源目录子树的目录 ID 快照：落点不在其中 = 「目录外」 */
  sourceIds: string[];
}

const PAGE = 10;
const BATCH = 4;
/** D95 成组门槛（与服务端同口径）：新目录直接承接不足这么多条同类就不建；复用现有目录不受限 */
const MIN_NEW_FOLDER_ITEMS = 3;
const tasks = new Map<string, MockTask>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const emitTask = (taskId: string): void => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("mf:mock-task", { detail: { taskId } }));
  }
};
const emitChange = (): void => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("mf:mock-change"));
};
const ACTIVE = (t: MockTask): boolean =>
  ["queued", "running", "stopping"].includes(t.status) || ["pending", "running"].includes(t.undo_status);

// ---------- 演示用「模型」：按标题/网址归纳主题；教程/文章类内容页转资料 ----------

const TOPICS: Array<[RegExp, string, string]> = [
  [/rustdesk|向日葵|todesk|远程控制/i, "远程控制", ""],
  [/docker|nginx|k8s|kubernetes|部署|linux|服务器|portainer|compose/i, "部署运维", ""],
  [/figma|配色|\bui\b|icon|字体|设计/i, "设计资源", ""],
  [/\bai\b|llm|agent|智能|模型|prompt/i, "AI 与工具", ""],
  [/rust\b|typescript|react|vue|node|前端|css|javascript/i, "开发", "前端开发"],
];
const CONTENT_RE = /教程|指南|tutorial|guide|博客|文章|笔记|文档|blog|weekly|\/docs?\//i;
/** 演示用「库内其他目录」对照：主题在库里有对应目录就跨根复用，而不是在来源目录下硬建 */
const REUSE_BY_TOPIC: Record<string, string> = {
  "设计资源": "设计灵感",
  "阅读与参考": "阅读清单",
  "远程控制": "远程控制",
};

/** 名称的粗粒度词元（与服务端兜底判断同口径）：中文取相邻两字，英文/数字取长度 ≥2 的词 */
function nameTokens(s: string): Set<string> {
  const out = new Set<string>();
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, "");
  if (cjk.length === 1) out.add(cjk);
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2));
  for (const word of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) if (word.length >= 2) out.add(word);
  return out;
}

/**
 * 按标题/网址归纳主题；教程/文章类内容页转资料。
 * 落点（D94）：库内已有对应目录 → 跨根复用；没有且与来源目录名称无关 → 新建顶级目录；否则建在来源目录之下。
 */
function planOf(b: MockBm, ctx: { db: MockTaskDb; rootName: string }): Plan {
  const hit = TOPICS.find(([re]) => re.test(b.title) || re.test(b.url_canonical));
  const topic = hit?.[1] ?? "阅读与参考";
  if (CONTENT_RE.test(b.title) || CONTENT_RE.test(b.url_canonical)) {
    return { decision: "convert", key: null, category: `${topic}/教程与文章`, reason: "content_page", reuseId: null, top: false };
  }
  const sub = hit?.[2] && /rust\b|typescript|react|vue|css|前端|javascript/i.test(b.title) ? hit[2] : "";
  const reuseName = REUSE_BY_TOPIC[topic];
  const reuse = sub || !reuseName ? undefined : ctx.db.folders.find((f) => f.name === reuseName && !f.is_system_inbox);
  const sourceTokens = nameTokens(ctx.rootName);
  const related = [...nameTokens(topic)].some((t) => sourceTokens.has(t));
  return {
    decision: "move", key: sub ? `s:${topic}/${sub}` : `t:${topic}`, category: null, reason: "topic_match",
    reuseId: reuse?.id ?? null, top: !reuse && !related,
  };
}

/** 落点是否在来源目录之外（已创建/复用看目录 ID；未创建的看规划与父节点） */
function outsideOf(t: MockTask, n: Node): boolean {
  if (n.id) return !t.sourceIds.includes(n.id);
  if (n.parentKey) {
    const parent = t.nodes.find((x) => x.key === n.parentKey);
    return parent ? outsideOf(t, parent) : false;
  }
  return n.placement === "top";
}

// ---------- 视图 ----------

function counts(t: MockTask) {
  const c = { moved: 0, converted: 0, unchanged: 0, skipped: 0, failed: 0, remaining: 0 };
  for (const it of t.items) {
    if (it.decision === "moved") c.moved++;
    else if (it.decision === "converted") c.converted++;
    else if (it.decision === "keep") c.unchanged++;
    else if (it.decision === "skip") c.skipped++;
    else if (it.decision === "fail") c.failed++;
    else c.remaining++;
  }
  return c;
}

function summary(t: MockTask, c: ReturnType<typeof counts>, remaining: number): string | null {
  if (ACTIVE(t)) return null;
  if (t.status === "stopped") {
    return `已停止：已检查 ${t.total - remaining} / ${t.total}，剩余 ${remaining}；已归位 ${c.moved} 条、转资料 ${c.converted} 条`;
  }
  // 「同类太少没建目录」不是「位置本来就好」，单独说
  const few = t.items.filter((it) => it.decision === "keep" && it.reason === "too_few_to_group").length;
  const placed = c.unchanged - few;
  const tail =
    (placed > 0 ? `；另有 ${placed} 条已在合适位置` : "") + (few > 0 ? `；${few} 条同类太少，未单独建目录` : "");
  if (c.moved + c.converted === 0) {
    if (few > 0 && few === c.unchanged) return `已检查 ${t.total} 条，有 ${few} 条同类太少，未单独建目录，保留原位，本次未调整`;
    return `已检查 ${t.total} 条，当前位置均合适，本次未调整`;
  }
  return `检查完成：书签归位 ${c.moved} 条${c.converted > 0 ? `，转入资料 ${c.converted} 条` : ""}${tail}`;
}

function view(t: MockTask): OrganizeTask {
  const c = counts(t);
  const skipped = c.skipped + t.protected_count;
  const remaining = Math.max(0, t.total - (c.moved + c.converted + c.unchanged + skipped + c.failed));
  const movedKeys = new Set(t.items.filter((it) => it.decision === "moved").map((it) => it.plan?.key));
  const usedCats = new Set(t.items.filter((it) => it.decision === "converted").map((it) => it.plan?.category));
  const movedOutside = t.items.filter((it) => {
    if (it.decision !== "moved" || !it.plan?.key) return false;
    const node = t.nodes.find((n) => n.key === it.plan?.key);
    return node ? outsideOf(t, node) : false;
  }).length;
  return {
    id: t.id, folder_id: t.folder_id, folder_name: t.folder_name, status: t.status, phase: t.phase,
    phase_note: t.phase_note, mode: t.mode, total: t.total, checked: t.total - remaining, remaining,
    planned: t.items.filter((it) => it.decision === "remaining" && it.plan).length,
    moved: c.moved, moved_outside: movedOutside, converted: c.converted, new_materials: c.converted, reused_materials: 0,
    unchanged: c.unchanged, skipped, failed: c.failed, protected_count: t.protected_count,
    excluded_archived: t.excluded_archived,
    planned_new_folders: t.nodes.filter((n) => !n.reuseId).length,
    created_folders: t.nodes.filter((n) => n.id && !n.reuseId).length,
    reused_folders: t.nodes.filter((n) => n.reuseId && movedKeys.has(n.key)).length,
    planned_categories: t.cats.length,
    new_categories: t.cats.filter((x) => !x.existedBefore && usedCats.has(x.path)).length,
    reused_categories: t.cats.filter((x) => x.existedBefore && usedCats.has(x.path)).length,
    topics: [...new Set(t.nodes.filter((n) => n.parentKey === null).map((n) => n.name))].slice(0, 8),
    error: null, revision: t.revision, can_continue: t.can_continue, continue_expires_at: t.continue_expires_at,
    undo_status: t.undo_status, undo_restored: t.undo_restored, undo_kept: t.undo_kept, undo_categories: t.undo_categories,
    undo_folders: t.undo_folders, created_at: t.created_at, started_at: t.started_at, phase_at: t.phase_at,
    finished_at: t.finished_at, summary: summary(t, c, remaining),
  };
}

function pathOf(db: MockTaskDb, folderId: string, rootId: string): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur = db.folders.find((f) => f.id === folderId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.unshift(cur.name);
    if (cur.id === rootId) break;
    const pid = cur.parent_id;
    cur = pid ? db.folders.find((f) => f.id === pid) : undefined;
  }
  return names.join(" / ");
}

const publicItem = (it: MockItem): OrganizeTaskItem => {
  const { plan: _plan, fromFolder: _from, ...rest } = it;
  void _plan;
  void _from;
  return rest;
};

// ---------- 推进引擎 ----------

function touch(t: MockTask): void {
  t.revision += 1;
  t.phase_at = new Date().toISOString();
  emitTask(t.id);
}

function clearTimer(t: MockTask): void {
  const timer = timers.get(t.id);
  if (timer) clearTimeout(timer);
  timers.delete(t.id);
}

function schedule(t: MockTask, fn: (t: MockTask) => void, ms: number): void {
  clearTimer(t);
  timers.set(
    t.id,
    setTimeout(() => {
      timers.delete(t.id);
      if (tasks.has(t.id)) fn(t);
    }, ms),
  );
}

/**
 * 找到或新建落点目录（D94 与服务端同口径）：与来源无关的一级主题建为顶级目录，其余一级主题挂被整理目录下，
 * 子主题挂主题目录下；同级同名即复用。
 */
function ensureTarget(t: MockTask, env: MockTaskEnv, key: string | null): string | null {
  const node = t.nodes.find((n) => n.key === key);
  if (!node) return null;
  if (node.id) return env.db().folders.some((f) => f.id === node.id) ? node.id : null;
  const top = !node.parentKey && node.placement === "top";
  const parentId = node.parentKey ? ensureTarget(t, env, node.parentKey) : top ? null : t.folder_id;
  if (!top && !parentId) return null;
  const db = env.db();
  const existing = parentId
    ? db.folders.find((f) => f.parent_id === parentId && f.name === node.name)
    : db.folders.find((f) => !f.parent_id && f.name === node.name && !f.is_system_inbox);
  if (existing) {
    node.id = existing.id;
    node.reuseId = existing.id;
    return existing.id;
  }
  const id = env.nid("f");
  db.folders.push({ id, name: node.name, parent_id: parentId, is_system_inbox: 0 });
  node.id = id;
  return id;
}

function finish(t: MockTask, env: MockTaskEnv): void {
  const stopped = t.status === "stopping";
  t.status = stopped ? "stopped" : "completed";
  t.phase = "done";
  t.phase_note = null;
  t.finished_at = env.now();
  const moved = t.items.filter((x) => x.decision === "moved");
  const converted = t.items.filter((x) => x.decision === "converted");
  if (moved.length + converted.length > 0) {
    const v: MockVer = {
      id: env.nid("ver"), session_id: null, kind: "目录整理", label: "organize_task", reverted: 0,
      created_at: t.finished_at, actionCount: moved.length + converted.length,
      moves: moved.map((x) => ({ id: x.bookmark_id, from: x.fromFolder })),
      createdFolders: t.nodes.filter((n) => n.id && !n.reuseId).map((n) => n.id!),
      convertIds: converted.map((x) => x.bookmark_id), task_id: t.id, task_batch: 1,
    };
    env.db().versions.unshift(v);
    t.versionId = v.id;
  }
  touch(t);
  emitChange();
  // 撤销请求先于运行到达：运行收尾（停止并排空）之后再逆放
  if (t.undo_status === "pending") schedule(t, (x) => runUndo(x, env), 300);
}

/** 一个提交批次：按已落定的规划执行；停止只在批次边界生效 */
function commitBatch(t: MockTask, env: MockTaskEnv): void {
  if (t.status === "stopping") {
    finish(t, env);
    return;
  }
  const pending = t.items.filter((it) => it.decision === "remaining");
  const ts = env.now();
  for (const it of pending.slice(0, BATCH)) {
    const db = env.db();
    const b = db.bookmarks.find((x) => x.id === it.bookmark_id);
    const plan = it.plan;
    // 提交前重查：条目在等待期间被转资料/归档/删除 → 跳过，不冒领
    if (!b || b.materialized || b.status === "archived") {
      it.decision = "skip";
      it.reason = b ? "converted_elsewhere" : "deleted_during_task";
    } else if (!plan) {
      // 规划阶段就定了保留原位（同类太少，不值得单独建目录）：原因已在规划时写好
      it.decision = "keep";
    } else if (plan.decision === "convert" && plan.category) {
      b.materialized = true;
      let m = db.materials.find((x) => x.bookmark_id === b.id);
      if (!m) {
        m = {
          id: env.nid("mat"), bookmark_id: b.id, type: "article", category: plan.category, created_at: ts,
          signals: ["整理任务"], textLen: 1800, cover: false, materialized: 1,
        };
        db.materials.push(m);
      } else {
        m.materialized = 1;
        m.category = plan.category;
      }
      it.decision = "converted";
      it.reason = plan.reason;
      it.category_path = plan.category;
      it.to_path = `资料 / ${plan.category.split("/").join(" / ")}`;
    } else {
      const target = ensureTarget(t, env, plan.key);
      if (!target) {
        it.decision = "keep";
        it.reason = "insufficient_evidence";
      } else if (target === b.folder_id) {
        it.decision = "keep";
        it.reason = "already_placed";
      } else {
        it.from_path = pathOf(db, b.folder_id, t.folder_id);
        b.folder_id = target;
        it.decision = "moved";
        it.reason = plan.reason;
        it.to_path = pathOf(env.db(), target, t.folder_id);
      }
    }
    it.batch = 1;
    it.updated_at = ts;
  }
  const left = t.items.filter((x) => x.decision === "remaining").length;
  t.phase_note = `正在归位与转换 · 已检查 ${t.total - t.protected_count - left} / ${t.total - t.protected_count}`;
  touch(t);
  emitChange();
  if (left > 0) schedule(t, (x) => commitBatch(x, env), 520);
  else finish(t, env);
}

function runUndo(t: MockTask, env: MockTaskEnv): void {
  t.undo_status = "running";
  touch(t);
  const db = env.db();
  const version = db.versions.find((v) => v.id === t.versionId);
  let restored = 0;
  // 先恢复转资料（资料保留），再把书签移回原目录，最后回收仍为空的本次新建目录
  for (const id of version?.convertIds ?? []) {
    const b = db.bookmarks.find((x) => x.id === id);
    if (b?.materialized) {
      b.materialized = false;
      const m = db.materials.find((x) => x.bookmark_id === id);
      if (m) m.materialized = 0;
      restored++;
    }
  }
  for (const mv of version?.moves ?? []) {
    const b = db.bookmarks.find((x) => x.id === mv.id);
    if (b && db.folders.some((f) => f.id === mv.from)) {
      b.folder_id = mv.from;
      restored++;
    }
  }
  let folders = 0;
  for (const fid of version?.createdFolders ?? []) {
    if (!db.bookmarks.some((b) => b.folder_id === fid) && !db.folders.some((f) => f.parent_id === fid)) {
      db.folders = db.folders.filter((f) => f.id !== fid);
      folders++;
    }
  }
  if (version) version.reverted = restored;
  const total = (version?.moves?.length ?? 0) + (version?.convertIds?.length ?? 0);
  t.undo_restored = restored;
  t.undo_kept = Math.max(0, total - restored);
  t.undo_folders = folders;
  t.undo_status = t.undo_kept > 0 ? "partial" : "completed";
  touch(t);
  emitChange();
}

// ---------- 路由 ----------

/** 返回 null = 不是本模块处理的路径；undefined = 路径匹配但方法不支持 */
export function mockOrganizeTask(
  method: string,
  path: string,
  ctx: { query: URLSearchParams; body?: unknown },
  env: MockTaskEnv,
): unknown | null | undefined {
  const seg = path.split("/").filter(Boolean);
  // 版本历史里撤销任务批次 → 走任务撤销（任务关联版本不绕过任务协调器）
  if (method === "POST" && seg[0] === "organize" && seg[1] === "rollback" && seg.length === 3) {
    const v = env.db().versions.find((x) => x.id === seg[2]);
    const t = v?.task_id ? tasks.get(v.task_id) : undefined;
    if (!t) return null;
    if (v?.reverted) return { error: "version_not_found_or_reverted" };
    mockOrganizeTask("POST", `/organize/tasks/${t.id}/undo`, ctx, env);
    return { reversed: t.undo_restored, skipped: [], undoVersionId: null, taskId: t.id, undoStatus: t.undo_status };
  }
  if (seg[0] !== "organize" || seg[1] !== "tasks") return null;

  const offset = Math.max(0, Number(ctx.query.get("offset")) || 0);
  const limit = Math.min(50, Math.max(1, Number(ctx.query.get("limit")) || PAGE));
  const id = seg[2];
  const t = id ? tasks.get(id) : undefined;
  if (id && !t) return { error: "task_not_found" };

  // 创建即受理；同幂等键回同一任务；已有活动任务回它而不并行
  if (method === "POST" && seg.length === 2) {
    const body = (ctx.body ?? {}) as { folderId?: string; requestId?: string };
    const db = env.db();
    const root = db.folders.find((f) => f.id === body.folderId && !f.is_system_inbox);
    if (!root) return { error: "folder_not_found" };
    const mine = [...tasks.values()].find((x) => x.requestId === String(body.requestId ?? ""));
    if (mine) return { task: view(mine), created: false, existing: false };
    const active = [...tasks.values()].find(ACTIVE);
    if (active) return { task: view(active), created: false, existing: true };

    // 范围快照：目录及全部后代；已转资料/归档排除，私密只计数
    const ids = new Set<string>([root.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of db.folders) {
        if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id) && !f.is_system_inbox) {
          ids.add(f.id);
          grew = true;
        }
      }
    }
    const ts = env.now();
    const items: MockItem[] = [];
    let protectedCount = 0;
    let excluded = 0;
    const nodeKeys = new Set<string>();
    const catSet = new Set<string>();
    for (const b of db.bookmarks) {
      if (!ids.has(b.folder_id)) continue;
      if (b.materialized || b.status === "archived") {
        excluded++;
        continue;
      }
      if (b.is_private === 1) {
        protectedCount++;
        continue;
      }
      const plan = planOf(b, { db, rootName: root.name });
      if (plan.key) {
        nodeKeys.add(plan.key);
        if (plan.key.startsWith("s:")) nodeKeys.add(`t:${plan.key.slice(2).split("/")[0]}`);
      } else if (plan.category) catSet.add(plan.category);
      items.push({
        id: env.nid("ti"), bookmark_id: b.id, title: b.title, decision: "remaining", reason: null, retryable: false,
        from_path: null, to_path: null, category_path: null, batch: null, updated_at: ts, plan, fromFolder: b.folder_id,
      });
    }
    if (items.length === 0) return { error: "empty_scope" };
    const nodes: Node[] = [...nodeKeys].map((key) => {
      const isSub = key.startsWith("s:");
      const name = isSub ? key.slice(2).split("/")[1]! : key.slice(2);
      const first = items.find((it) => it.plan?.key === key)?.plan;
      // 一级主题：规划里指定复用库内某个目录（可在来源之外）则直接复用；否则按规划建在来源目录下或顶级
      const reuseId = isSub ? null : (first?.reuseId ?? null);
      return {
        key, name, parentKey: isSub ? `t:${key.slice(2).split("/")[0]}` : null,
        reuseId, id: reuseId, ...(isSub || reuseId ? {} : { placement: first?.top ? "top" as const : "inside" as const }),
      };
    });
    // D95 成组门槛（与服务端同口径）：新目录直接承接不足 MIN_NEW_FOLDER_ITEMS 条同类就不建。
    // 二级不足 → 撤销，条目回流一级；一级直接承接不足：没有保住的子目录 → 不建；只保住一个 → 连它一起撤销
    const inflow = new Map<string, number>();
    for (const it of items) if (it.plan?.key) inflow.set(it.plan.key, (inflow.get(it.plan.key) ?? 0) + 1);
    const alive = new Set(nodes.map((n) => n.key));
    for (const n of nodes.filter((x) => x.parentKey && !x.reuseId)) {
      if ((inflow.get(n.key) ?? 0) >= MIN_NEW_FOLDER_ITEMS) continue;
      alive.delete(n.key);
      inflow.set(n.parentKey!, (inflow.get(n.parentKey!) ?? 0) + (inflow.get(n.key) ?? 0));
    }
    for (const n of nodes.filter((x) => !x.parentKey && !x.reuseId)) {
      const subs = nodes.filter((x) => x.parentKey === n.key && alive.has(x.key) && !x.reuseId);
      if ((inflow.get(n.key) ?? 0) >= MIN_NEW_FOLDER_ITEMS || subs.length >= 2) continue;
      alive.delete(subs.length === 1 ? subs[0]!.key : n.key);
    }
    for (const it of items) {
      const key = it.plan?.key;
      if (!key || alive.has(key)) continue;
      const parent = nodes.find((n) => n.key === key)?.parentKey;
      if (parent && alive.has(parent)) it.plan = { ...it.plan!, key: parent };
      else {
        it.plan = null;
        it.reason = "too_few_to_group";
      }
    }
    const keptNodes = nodes.filter((n) => alive.has(n.key));
    const existingCats = new Set(db.materials.map((m) => m.category).filter(Boolean) as string[]);
    const task: MockTask = {
      id: env.nid("task"), requestId: String(body.requestId ?? ""), folder_id: root.id, folder_name: root.name,
      status: "running", phase: "plan", phase_note: `正在归纳内容主题 · 0 / ${items.length}`, mode: "ai",
      total: items.length + protectedCount, checked: 0, remaining: items.length + protectedCount, planned: 0,
      moved: 0, moved_outside: 0, converted: 0, new_materials: 0, reused_materials: 0, unchanged: 0, skipped: protectedCount, failed: 0,
      protected_count: protectedCount, excluded_archived: excluded,
      planned_new_folders: keptNodes.filter((n) => !n.reuseId).length, created_folders: 0, reused_folders: 0,
      planned_categories: catSet.size, new_categories: 0, reused_categories: 0, topics: [], error: null, revision: 1,
      can_continue: true, continue_expires_at: null, undo_status: "none", undo_restored: 0, undo_kept: 0,
      undo_categories: 0, undo_folders: 0, created_at: ts, started_at: ts, phase_at: ts, finished_at: null,
      summary: null, items, nodes: keptNodes, cats: [...catSet].map((c) => ({ path: c, existedBefore: existingCats.has(c) })),
      versionId: null, sourceIds: [...ids],
    };
    tasks.set(task.id, task);
    // 规划阶段：逐批「归纳」（演示态只推进计数，结论已在上面落定）→ 提交阶段
    let planned = 0;
    const planStep = (x: MockTask): void => {
      if (x.status === "stopping") return finish(x, env);
      planned = Math.min(x.items.length, planned + 6);
      x.planned = planned;
      x.phase_note = `正在归纳内容主题 · ${planned} / ${x.items.length}`;
      touch(x);
      if (planned < x.items.length) schedule(x, planStep, 420);
      else {
        x.phase = "commit";
        x.phase_note = "正在归位与转换";
        touch(x);
        schedule(x, (y) => commitBatch(y, env), 600);
      }
    };
    schedule(task, planStep, 500);
    return { task: view(task), created: true, existing: false };
  }

  if (method === "GET" && seg.length === 2) {
    const all = [...tasks.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const active = all.find(ACTIVE);
    return { tasks: all.slice(offset, offset + limit).map(view), total: all.length, active: active ? { id: active.id } : null };
  }
  if (!t) return undefined;

  if (method === "GET" && seg.length === 3) return { task: view(t) };

  if (method === "GET" && seg[3] === "items") {
    const map: Record<string, string[]> = {
      moved: ["moved"], converted: ["converted"], unchanged: ["keep"], skipped: ["skip"], failed: ["fail"],
      changed: ["moved", "converted"],
    };
    const decisions = map[ctx.query.get("result") ?? ""];
    const rows = decisions ? t.items.filter((it) => decisions.includes(it.decision)) : t.items;
    return {
      items: rows.slice(offset, offset + limit).map(publicItem),
      total: rows.length,
      protectedCount: decisions?.includes("skip") ? t.protected_count : 0,
    };
  }

  if (method === "GET" && seg[3] === "folders") {
    // 未创建的节点按规划推算完整路径：顶级主题只写主题名，其余从被整理目录写起（与服务端同口径）
    const plannedPath = (n: Node): string => {
      if (n.id) return pathOf(env.db(), n.id, t.folder_id);
      if (!n.parentKey) return n.placement === "top" ? n.name : `${t.folder_name} / ${n.name}`;
      const parent = t.nodes.find((x) => x.key === n.parentKey);
      return parent ? `${plannedPath(parent)} / ${n.name}` : n.name;
    };
    const rows: OrganizeTaskFolder[] = t.nodes.map((n) => {
      const mine = t.items.filter((it) => it.decision === "moved" && it.plan?.key === n.key).length;
      return {
        key: n.key,
        path: plannedPath(n),
        state: n.reuseId ? "reused" : n.id ? "created" : "unapplied",
        folder_id: n.id, planned_count: mine, actual_count: mine,
        outside: outsideOf(t, n),
      };
    });
    return { folders: rows.slice(offset, offset + limit), total: rows.length };
  }

  if (method === "GET" && seg[3] === "material-categories") {
    const rows: OrganizeTaskCategory[] = t.cats.map((c) => {
      const mine = t.items.filter((it) => it.decision === "converted" && it.plan?.category === c.path).length;
      return {
        path: c.path, state: mine > 0 ? (c.existedBefore ? "reused" : "new") : "unapplied",
        planned_count: mine, actual_count: mine,
      };
    });
    return { categories: rows.slice(offset, offset + limit), total: rows.length };
  }

  if (method === "POST" && seg[3] === "stop") {
    if (["queued", "running"].includes(t.status)) {
      t.status = "stopping";
      touch(t);
    }
    return { task: view(t) };
  }

  if (method === "POST" && seg[3] === "continue") {
    if (ACTIVE(t) || t.status === "stopping") return { error: "task_active" };
    if (t.undo_status !== "none") return { error: "task_undo_started" };
    const mode = (ctx.body as { mode?: string } | undefined)?.mode === "failed" ? "failed" : "remaining";
    const targets = t.items.filter((it) => (mode === "failed" ? it.decision === "fail" : it.decision === "remaining" || it.decision === "fail"));
    if (targets.length === 0) return { error: "nothing_to_continue" };
    for (const it of targets) {
      it.decision = "remaining";
      it.reason = null;
    }
    t.status = "running";
    t.phase = "commit";
    t.finished_at = null;
    t.phase_note = "正在归位与转换";
    touch(t);
    schedule(t, (x) => commitBatch(x, env), 500);
    return { task: view(t), reopened: targets.length };
  }

  if (method === "POST" && seg[3] === "undo") {
    if (["pending", "running", "completed"].includes(t.undo_status)) {
      return { task: view(t), pending: ["pending", "running"].includes(t.undo_status) };
    }
    // 运行中：先停止并排空，再逆放（提交循环在下一个批次边界收尾）
    if (["queued", "running"].includes(t.status)) {
      t.status = "stopping";
      t.undo_status = "pending";
      touch(t);
      return { task: view(t), pending: true };
    }
    if (!t.versionId) return { error: "nothing_to_undo" };
    runUndo(t, env);
    return { task: view(t), pending: false };
  }

  return undefined;
}
