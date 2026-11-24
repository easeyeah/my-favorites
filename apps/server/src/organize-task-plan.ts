/**
 * D92 目录整理任务 · 规划内核（《书签目录自动整理重设计》§5）
 *
 *  ① 先按内容发现主题——首轮不给旧目录名（旧结构是参考不是答案），跨批用已归纳的主题名保持一致；
 *  ② 合并同义主题，生成最多两层的分类树；
 *  ③ 最后才与旧目录做语义映射：语义与粒度都合适才复用（按稳定目录 ID），否则新建；
 *  ④ 内容资料另走一路：用途判定 → 正文取证（已授权缓存 / 受控补抓）→ 内容型判定 → 资料分类；
 *  ⑤ 每条来源收藏恰有一个明确判断：move / convert / keep / fail / skip——不把「模型没给结果」当作「无需调整」。
 *
 * 这里只做判断、不落库：提交（事务、守卫、计数）在 organize-task.ts 的运行器内完成。
 * 模型调用闸、停止检查、进度说明由运行器通过 PlanHost 注入。
 */
import {
  MATERIAL_ARTICLE_MIN_TEXT,
  canonicalizeUrl,
  classifyByRules,
  classifyMaterialKind,
} from "@mf/shared";
import { isLlmContentModeration } from "@mf/ai/llm-client";
import type { BookmarkRow, OrganizeTaskItemRow, OrganizeTaskRow, Store } from "./store";

/** 单次主题发现的条目上限（并按模型上下文预算约束） */
export const PLAN_BATCH = 30;
/** 内容型判定批量（只送标题/网址/正文前 400 字） */
const JUDGE_BATCH = 10;
/** move 初始门槛：既有与新目录同标准（待隔离样本验证的产品默认，不代表准确率） */
export const MOVE_CONFIDENCE = 0.8;
/** convert 更保守：资料用途与分类均须明确 */
export const CONVERT_CONFIDENCE = 0.85;
/** 防失控上限（不是生成目标）：新目录节点 / 新资料分类路径 */
export const MAX_NEW_FOLDERS = 64;
export const MAX_CATEGORIES = 64;
const TOPIC_NAME_MAX = 12;
const CATEGORY_LEVEL_MAX = 20;
const MAX_TOPIC_SAMPLE = 4;
/** 映射时附带的现有目录上限（按书签数降序；其余目录走确定性同名匹配兜底） */
const MAX_MAPPING_FOLDERS = 200;

const VAGUE_TOPICS = new Set([
  "其他", "杂项", "未分类", "工具", "常用", "收藏", "书签", "分类", "暂定", "misc", "other", "unknown",
]);
const VAGUE_CATEGORY = new Set(["文章", "资料", "其他", "未分类", "内容", "网页", "article", "other"]);

export interface FolderNode {
  /** 任务内稳定 key：t:<主题> / s:<主题>/<子主题> / e:<目录ID>（规则复用） */
  key: string;
  name: string;
  /** null = 直接挂在被整理目录下 */
  parentKey: string | null;
  /** 复用的既有目录 ID（null = 新建） */
  reuseId: string | null;
  /** 实际目录 ID：复用目录即 reuseId；新建目录在首次提交时回填 */
  id: string | null;
}

export interface TaskPlan {
  version: 1;
  rootFolderId: string;
  folderNodes: FolderNode[];
  categories: Array<{ path: string; existedBefore: boolean }>;
  /** 归纳出的顶层主题（结果页摘要用） */
  topics: string[];
}

export type PlanDecision = "move" | "convert" | "keep" | "fail" | "skip";

export interface ItemPlan {
  itemId: string;
  bookmarkId: string;
  decision: PlanDecision;
  targetKey: string | null;
  /** 资料分类完整路径（"一级/二级"） */
  category: string | null;
  materialType: string | null;
  reason: string;
  retryable: number;
  kind: "bookmark" | "material" | null;
  /** cache | crawl | url_rule */
  evidenceRef: string | null;
}

export interface PlanOutcome {
  plan: TaskPlan;
  items: ItemPlan[];
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface PlanHost {
  store: Store;
  /** 模型调用（运行器注入全局并发闸与一次受限重试；审核拒收不重试） */
  callJson<T>(messages: ChatMessage[]): Promise<T>;
  /** 让出事件循环并核对停止标志 / 租约 / 撤销请求 */
  checkpoint(): Promise<void>;
  note(text: string): void;
  /** 五动作隐私判定（call_model / server_fetch），以当前规则为准 */
  privacyAllowed(bm: BookmarkRow, action: "call_model" | "server_fetch"): boolean;
  /** 受控补抓（串行闸 + 总预算 + 隐私前置；不物化、不生成摘要） */
  crawl(bookmarkId: string): Promise<{ ok: boolean; reason?: string; detail?: string; text?: string }>;
}

export class PlanError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RawVerdict {
  use: "site" | "content" | "unsure";
  topic: string;
  subtopic: string;
  topicKey: string;
  subKey: string | null;
  confidence: number;
  reason: string;
}

interface TopicResult {
  index?: number;
  use?: string;
  topic?: string;
  subtopic?: string;
  confidence?: number;
  reason?: string;
}

interface JudgeResult {
  index?: number;
  material?: boolean;
  confidence?: number;
  category?: unknown;
}

interface JudgeCandidate {
  it: OrganizeTaskItemRow;
  bm: BookmarkRow;
  type: string;
  signals: string[];
  excerpt: string;
  evidence: "cache" | "crawl" | "url_rule";
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** 主题/目录名卫生：去路径分隔符与多余空白，限长；空串或含糊名称返回 "" */
function cleanTopic(raw: unknown): string {
  const s = String(raw ?? "")
    .replace(/[/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TOPIC_NAME_MAX);
  if (!s || VAGUE_TOPICS.has(s.toLowerCase())) return "";
  return s;
}

/** 资料分类路径：1–2 级，每级 trim 后 ≤20 字且不含 "/"；含糊名称整条拒绝（不静默截断后误并语义） */
function cleanCategory(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2) return null;
  const levels: string[] = [];
  for (const level of raw) {
    const s = String(level ?? "").replace(/[/\\]/g, " ").replace(/\s+/g, " ").trim();
    if (!s || s.length > CATEGORY_LEVEL_MAX || VAGUE_CATEGORY.has(s.toLowerCase())) return null;
    levels.push(s);
  }
  return levels.join("/");
}

function textOf(cache: Record<string, unknown> | undefined): string {
  return typeof cache?.l2_text === "string" ? cache.l2_text : "";
}

/** 模型输入用网址：只保留主机与路径（不外发查询参数/片段） */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.slice(0, 160);
  } catch {
    return url.slice(0, 160);
  }
}

function fail(it: OrganizeTaskItemRow, reason: string, retryable: number): ItemPlan {
  return {
    itemId: it.id, bookmarkId: it.bookmark_id, decision: "fail", targetKey: null, category: null,
    materialType: null, reason, retryable, kind: null, evidenceRef: null,
  };
}

function keep(it: OrganizeTaskItemRow, reason: string): ItemPlan {
  return {
    itemId: it.id, bookmarkId: it.bookmark_id, decision: "keep", targetKey: null, category: null,
    materialType: null, reason, retryable: 0, kind: "bookmark", evidenceRef: null,
  };
}

function skip(it: OrganizeTaskItemRow, reason: string): ItemPlan {
  return {
    itemId: it.id, bookmarkId: it.bookmark_id, decision: "skip", targetKey: null, category: null,
    materialType: null, reason, retryable: 0, kind: null, evidenceRef: null,
  };
}

function topicSystem(rootName: string, known: string[], userRules: string[]): string {
  const knownNote =
    known.length > 0 ? `此前批次已归纳出的主题：${JSON.stringify(known)}。语义相同必须使用完全相同的名称；确属新主题才新增。` : "";
  const rules = userRules.length > 0 ? `用户整理偏好（必须遵守）：${JSON.stringify(userRules)}。` : "";
  return (
    `你是书签整理助手。用户正在整理目录「${rootName}」里的收藏。请根据每条收藏的标题、网址和已有摘要，按内容用途与主题归纳分类。\n` +
    "判断规则：\n" +
    "1. use：该页面主要价值是「反复访问的网站或工具入口」填 \"site\"；是有实质正文、值得保存下来阅读的文章、教程、文档、报告填 \"content\"；无法判断填 \"unsure\"。\n" +
    `2. topic：按内容主题给一个简短、通用的分类名（不超过 ${TOPIC_NAME_MAX} 个字），例如「前端开发」「部署运维」「远程控制」「设计资源」。不要照抄某条收藏的长标题，不要用「其他」「杂项」「未分类」「工具」这类没有信息量的名称。\n` +
    `3. subtopic：仅当该主题下确实存在多个明显不同的子主题时给出更细的一级名称（不超过 ${TOPIC_NAME_MAX} 个字），否则填空字符串。不要为了细分而细分。\n` +
    "4. 同一主题必须始终使用相同名称，不要一会儿叫「前端」一会儿叫「前端开发」。" +
    knownNote +
    "\n5. confidence：0 到 1，表示你对用途与主题判断的把握；证据不足就给低分。\n" +
    rules +
    '只返回 JSON：{"results":[{"index":0,"use":"site","topic":"分类名","subtopic":"","confidence":0.9,"reason":"不超过20字"}]}，必须覆盖每一个 index。'
  );
}

function consolidateSystem(): string {
  return (
    "下面是分批归纳出的书签主题（含子主题）及条目数。请合并语义相同或高度相近的主题并给出规范名称：canonical 为合并后的名称（不超过 " +
    TOPIC_NAME_MAX +
    " 个字）；语义相同的多个主题必须返回完全相同的 canonical。保留确有区别的主题，不要把不同主题硬并成「其他」。子主题同理；若某子主题与所属主题规范名相同，canonical 填空字符串。\n" +
    '只返回 JSON：{"topics":[{"name":"原主题名","canonical":"规范名","subtopics":[{"name":"原子主题名","canonical":"规范子主题名"}]}]}，必须覆盖全部主题与子主题。'
  );
}

function mapSystem(rootName: string): string {
  return (
    `你是书签目录规划助手。用户正在整理目录「${rootName}」。已按内容归纳出下面的主题；请判断每个主题是否有「语义和粒度都合适」的现成子目录可以承接：有则 reuseId 填该目录的 id，没有则填 null（将新建目录）。\n` +
    "判断要点：\n" +
    "- 按代表书签理解每个现有目录实际收录的内容，不要只看目录名字面。\n" +
    "- 仅名称相近但内容混杂的宽泛目录（如「工具」「其他」「常用」）不算合适，不要把明确主题并进去。\n" +
    "- 现有目录内容与主题一致且粒度相当才复用；粒度过粗或过细都不复用。主题正好对应被整理目录本身的，reuseId 填该目录 id。\n" +
    '只返回 JSON：{"nodes":[{"key":"…","reuseId":"目录id或null"}]}，必须覆盖全部 key。'
  );
}

function judgeSystem(): string {
  return (
    "你是资料整理助手。判断每个网页是否属于「资料」：有实质正文、值得保存下来阅读、检索或引用的文章、教程、文档、报告等；工具首页、登录页、导航站、搜索结果、列表页等内容壳不属于资料。\n" +
    `对属于资料的条目给出内容分类路径 category：最多两级，每级不超过 ${CATEGORY_LEVEL_MAX} 个字，概括内容主题（如 ["技术开发","容器部署"]），不要用「文章」「资料」「其他」这类无意义名称。existingCategories 是用户已有的资料分类，语义一致时优先原样复用其中一项。\n` +
    "knownMaterial 为 true 的条目已按网址形态确认是视频或图片资料，只需给出分类，material 固定为 true。\n" +
    '只返回 JSON：{"results":[{"index":0,"material":true,"confidence":0.9,"category":["一级","二级"]}]}，必须覆盖每一个 index。'
  );
}

// ==================== 规则降级（未配置模型） ====================

/**
 * 无模型：只把域名规则命中且「本子树内恰有一个同名目录」的条目归到该目录（按稳定 ID）。
 * 不凭固定域名映射造一棵号称智能的新树，也不做任何资料转换；其余保留并说明规则未命中。
 */
export function planRuleOnly(host: PlanHost, task: OrganizeTaskRow, items: OrganizeTaskItemRow[]): PlanOutcome {
  const { store } = host;
  const subtree = new Set(store.folderSubtreeIds(task.folder_id));
  const byName = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const f of store.listFolders()) {
    if (!subtree.has(f.id) || f.is_system_inbox === 1) continue;
    counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
    byName.set(f.name, f.id);
  }
  const nodes = new Map<string, FolderNode>();
  const out: ItemPlan[] = [];
  for (const it of items) {
    const bm = store.getBookmark(it.bookmark_id);
    if (!bm) {
      out.push(fail(it, "bookmark_unavailable", 0));
      continue;
    }
    const parsed = canonicalizeUrl(bm.url_canonical);
    const rule = parsed ? classifyByRules(parsed.registrableDomain, bm.title) : null;
    if (!rule || rule.source !== "domain_map") {
      out.push(keep(it, "rule_unmatched"));
      continue;
    }
    const hits = counts.get(rule.category) ?? 0;
    if (hits === 0) {
      out.push(keep(it, "rule_target_not_in_scope"));
      continue;
    }
    if (hits > 1) {
      out.push(keep(it, "ambiguous_target"));
      continue;
    }
    const targetId = byName.get(rule.category)!;
    if (bm.folder_id === targetId) {
      out.push(keep(it, "already_placed"));
      continue;
    }
    const key = `e:${targetId}`;
    if (!nodes.has(key)) {
      nodes.set(key, { key, name: rule.category, parentKey: null, reuseId: targetId, id: targetId });
    }
    out.push({
      itemId: it.id, bookmarkId: it.bookmark_id, decision: "move", targetKey: key, category: null,
      materialType: null, reason: "domain_rule", retryable: 0, kind: "bookmark", evidenceRef: null,
    });
  }
  return {
    plan: { version: 1, rootFolderId: task.folder_id, folderNodes: [...nodes.values()], categories: [], topics: [] },
    items: out,
  };
}

// ==================== AI 规划 ====================

export async function planWithAi(host: PlanHost, task: OrganizeTaskRow, items: OrganizeTaskItemRow[]): Promise<PlanOutcome> {
  const { store } = host;
  const root = store.getFolder(task.folder_id);
  if (!root) throw new PlanError("root_folder_missing", "被整理的目录已被删除，任务已停止，未应用剩余调整。");
  const userRules = store.getOrganizeRules();
  const plans = new Map<string, ItemPlan>();
  const usable: OrganizeTaskItemRow[] = [];
  for (const it of items) {
    if (store.getBookmark(it.bookmark_id)) usable.push(it);
    else plans.set(it.bookmark_id, fail(it, "bookmark_unavailable", 0));
  }

  // ---------- ① 主题发现：首轮不给旧目录名，跨批用已归纳主题名保持一致 ----------
  const verdicts = new Map<string, RawVerdict>();
  const known: string[] = [];
  let analyzed = 0;
  for (const batch of chunk(usable, PLAN_BATCH)) {
    await host.checkpoint();
    host.note(`正在归纳内容主题 · ${analyzed} / ${usable.length}`);
    const rows = batch.map((it) => ({ it, bm: store.getBookmark(it.bookmark_id)! }));
    let out: { results?: TopicResult[] } | null;
    try {
      out = await host.callJson<{ results?: TopicResult[] }>([
        { role: "system", content: topicSystem(root.name, known.slice(0, 40), userRules) },
        {
          role: "user",
          content: JSON.stringify(
            rows.map(({ bm }, i) => {
              const cache = store.getCache(bm.id);
              return {
                index: i,
                title: bm.title.slice(0, 200),
                url: safeUrl(bm.url_canonical),
                description: (bm.description ?? "").slice(0, 200),
                summary: typeof cache?.l1_summary === "string" ? cache.l1_summary.slice(0, 200) : "",
              };
            }),
          ),
        },
      ]);
    } catch (err) {
      // 整批失败如实记为失败（可重试），不把「没拿到结果」当作「无需调整」
      const reason = isLlmContentModeration(err) ? "content_rejected_by_model" : "model_error";
      for (const { it } of rows) plans.set(it.bookmark_id, fail(it, reason, 1));
      analyzed += rows.length;
      continue;
    }
    const byIndex = new Map<number, TopicResult>();
    for (const r of out?.results ?? []) if (typeof r?.index === "number") byIndex.set(r.index, r);
    for (const [i, { it }] of rows.entries()) {
      const raw = byIndex.get(i);
      const topic = cleanTopic(raw?.topic);
      const use = raw?.use === "site" || raw?.use === "content" ? raw.use : "unsure";
      if (!raw || use === "unsure" || !topic) {
        plans.set(it.bookmark_id, keep(it, raw ? "insufficient_evidence" : "model_output_incomplete"));
        analyzed += 1;
        continue;
      }
      const subtopic = cleanTopic(raw.subtopic);
      verdicts.set(it.bookmark_id, {
        use,
        topic,
        subtopic: subtopic && subtopic !== topic ? subtopic : "",
        topicKey: `t:${topic}`,
        subKey: null,
        confidence: Number(raw.confidence),
        reason: String(raw.reason ?? "").slice(0, 60),
      });
      if (!known.includes(topic) && known.length < 40) known.push(topic);
      analyzed += 1;
    }
  }

  // ---------- ② 合并同义主题 → 规范分类树 ----------
  interface SubAgg {
    count: number;
    samples: string[];
  }
  interface TopicAgg {
    count: number;
    samples: string[];
    subs: Map<string, SubAgg>;
  }
  const buildTree = (pick: (v: RawVerdict) => { topic: string; sub: string }): Map<string, TopicAgg> => {
    const tree = new Map<string, TopicAgg>();
    for (const [bookmarkId, v] of verdicts) {
      if (v.use === "unsure") continue;
      const { topic, sub } = pick(v);
      if (!topic) continue;
      const title = store.getBookmark(bookmarkId)?.title ?? "";
      const agg = tree.get(topic) ?? { count: 0, samples: [], subs: new Map<string, SubAgg>() };
      agg.count += 1;
      if (agg.samples.length < MAX_TOPIC_SAMPLE && title) agg.samples.push(title.slice(0, 40));
      tree.set(topic, agg);
      if (sub) {
        const s = agg.subs.get(sub) ?? { count: 0, samples: [] };
        s.count += 1;
        if (s.samples.length < MAX_TOPIC_SAMPLE && title) s.samples.push(title.slice(0, 40));
        agg.subs.set(sub, s);
      }
    }
    return tree;
  };
  let tree = buildTree((v) => ({ topic: v.topic, sub: v.subtopic }));
  if (tree.size > 1) {
    await host.checkpoint();
    host.note("正在合并同义主题");
    try {
      const out = await host.callJson<{
        topics?: Array<{ name?: string; canonical?: string; subtopics?: Array<{ name?: string; canonical?: string }> }>;
      }>([
        { role: "system", content: consolidateSystem() },
        {
          role: "user",
          content: JSON.stringify(
            [...tree].map(([name, agg]) => ({
              name,
              count: agg.count,
              subtopics: [...agg.subs].map(([sname, s]) => ({ name: sname, count: s.count })),
            })),
          ),
        },
      ]);
      const topicMap = new Map<string, string>(); // 原主题名 → 规范名
      const subMap = new Map<string, string>(); // 原主题/原子主题 → 规范子主题
      for (const t of out?.topics ?? []) {
        const canonical = cleanTopic(t?.canonical);
        if (!t?.name || !canonical) continue;
        topicMap.set(t.name, canonical);
        for (const s of t.subtopics ?? []) {
          const subCanonical = cleanTopic(s?.canonical);
          if (s?.name && subCanonical && subCanonical !== canonical) subMap.set(`${t.name}/${s.name}`, subCanonical);
        }
      }
      for (const v of verdicts.values()) {
        if (v.use === "unsure") continue;
        // 先取原主题名作键（下面才改写 v.topic），未被合并覆盖的子主题保持原名
        const rawTopic = v.topic;
        const rawSub = v.subtopic;
        v.topic = topicMap.get(rawTopic) ?? rawTopic;
        const mappedSub = rawSub ? subMap.get(`${rawTopic}/${rawSub}`) : undefined;
        const sub = mappedSub ?? rawSub;
        v.subtopic = sub && sub !== v.topic ? sub : "";
      }
      tree = buildTree((v) => ({ topic: v.topic, sub: v.subtopic }));
    } catch {
      // 合并失败不致命：沿用各批原始主题名（仍是合法名称），不中断整理
    }
  }
  for (const v of verdicts.values()) {
    v.topicKey = `t:${v.topic}`;
    v.subKey = v.subtopic ? `s:${v.topic}/${v.subtopic}` : null;
  }

  // ---------- ③ 与旧目录做语义映射：按稳定 ID 复用，或新建（新节点距被整理目录最多两层） ----------
  await host.checkpoint();
  host.note("正在对照现有目录，决定复用或新建");
  const subtree = new Set(store.folderSubtreeIds(task.folder_id));
  const samples = store.folderSampleTitles(3);
  const pool = new Map<string, { name: string; count: number; path: string; samples: string[] }>();
  for (const f of store.listFolders()) {
    if (!subtree.has(f.id) || f.is_system_inbox === 1) continue;
    pool.set(f.id, {
      name: f.name,
      count: store.listBookmarks({ folderId: f.id, limit: 1000 }).length,
      path: relPathOf(store, f.id, root.id),
      samples: samples.get(f.id) ?? [],
    });
  }
  const toMap: Array<{ key: string; name: string; count: number; samples: string[] }> = [];
  for (const [name, agg] of tree) {
    toMap.push({ key: `t:${name}`, name, count: agg.count, samples: agg.samples });
    for (const [sname, s] of agg.subs) {
      toMap.push({ key: `s:${name}/${sname}`, name: sname, count: s.count, samples: s.samples });
    }
  }
  const reuse = new Map<string, string | null>();
  if (toMap.length > 0) {
    const foldersForPrompt = [...pool]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, MAX_MAPPING_FOLDERS)
      .map(([id, f]) => ({ id, path: f.path, samples: f.samples }));
    let mapped: Map<string, string | null>;
    try {
      const out = await host.callJson<{ nodes?: Array<{ key?: string; reuseId?: string | null }> }>([
        { role: "system", content: mapSystem(root.name) },
        { role: "user", content: JSON.stringify({ nodes: toMap, folders: foldersForPrompt }) },
      ]);
      mapped = new Map((out?.nodes ?? []).map((n) => [String(n?.key ?? ""), n?.reuseId ? String(n.reuseId) : null]));
    } catch {
      // 规划是本次整理的前提：模型无响应时明确失败，不静默退化成「全建新目录」再宣称整理成功
      throw new PlanError("plan_mapping_failed", "目录方案规划失败（模型无响应或返回无效），尚未应用任何调整。可稍后重试。");
    }
    const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, "");
    const byNorm = new Map<string, string[]>();
    for (const [id, f] of pool) {
      byNorm.set(norm(f.name), [...(byNorm.get(norm(f.name)) ?? []), id]);
    }
    for (const node of toMap) {
      const picked = mapped.get(node.key);
      reuse.set(
        node.key,
        picked && pool.has(picked)
          ? picked
          : // 兜底：模型未复用或给出无效 ID 时，名称完全一致且唯一的现有目录直接复用（不建同义副本）
            (byNorm.get(norm(node.name))?.length === 1 ? byNorm.get(norm(node.name))![0]! : null),
      );
    }
  }
  const folderNodes: FolderNode[] = [];
  const nodeByKey = new Map<string, FolderNode>();
  const folderName = (id: string): string => store.getFolder(id)?.name ?? "";
  for (const [name, agg] of tree) {
    const key = `t:${name}`;
    const reuseId = reuse.get(key) ?? null;
    const node: FolderNode = { key, name: reuseId ? folderName(reuseId) : name, parentKey: null, reuseId, id: reuseId };
    folderNodes.push(node);
    nodeByKey.set(key, node);
    // 新子目录只挂在「新建的一级主题」或「被整理目录自身」之下——新节点距根最多两层
    const canCreateSub = !reuseId || reuseId === root.id;
    for (const [sname, s] of agg.subs) {
      const sKey = `s:${name}/${sname}`;
      const sReuse = reuse.get(sKey) ?? null;
      if (sReuse) {
        const subNode: FolderNode = { key: sKey, name: folderName(sReuse), parentKey: key, reuseId: sReuse, id: sReuse };
        folderNodes.push(subNode);
        nodeByKey.set(sKey, subNode);
      } else if (canCreateSub) {
        const subNode: FolderNode = { key: sKey, name: sname, parentKey: key, reuseId: null, id: null };
        folderNodes.push(subNode);
        nodeByKey.set(sKey, subNode);
      }
      // 不能新建子目录时，该子主题的条目落到所属主题（不越层、不丢条目）
    }
  }
  const newCount = (): number => folderNodes.filter((n) => !n.reuseId).length;
  if (newCount() > MAX_NEW_FOLDERS) {
    // 先做一次受限粗化：放弃新建的二级目录，条目归到所属一级主题
    for (const n of folderNodes.filter((x) => x.parentKey !== null && !x.reuseId)) nodeByKey.delete(n.key);
    for (let i = folderNodes.length - 1; i >= 0; i--) {
      if (folderNodes[i]!.parentKey !== null && !folderNodes[i]!.reuseId) folderNodes.splice(i, 1);
    }
    if (newCount() > MAX_NEW_FOLDERS) {
      throw new PlanError(
        "too_many_folders",
        `目录方案过细：拟新建 ${newCount()} 个目录，超过单次上限 ${MAX_NEW_FOLDERS}，尚未应用任何调整。`,
      );
    }
  }

  // ---------- ④ 内容资料：正文取证 → 内容型判定 → 资料分类 ----------
  const contentRows = usable.filter((it) => verdicts.get(it.bookmark_id)?.use === "content");
  const toJudge: JudgeCandidate[] = [];
  let evidenced = 0;
  for (const it of contentRows) {
    await host.checkpoint();
    host.note(`正在为内容页确认正文 · ${evidenced} / ${contentRows.length}`);
    evidenced += 1;
    const bm = store.getBookmark(it.bookmark_id)!;
    const v = verdicts.get(it.bookmark_id)!;
    const cls = classifyMaterialKind(bm.url_canonical);
    if (!cls) {
      v.use = "site";
      continue;
    }
    if (cls.kind === "video" || cls.kind === "image") {
      toJudge.push({ it, bm, type: cls.kind, signals: cls.signals, excerpt: "", evidence: "url_rule" });
      continue;
    }
    if (!host.privacyAllowed(bm, "call_model")) {
      plans.set(it.bookmark_id, skip(it, "privacy_changed"));
      continue;
    }
    let text = textOf(store.getCache(bm.id));
    let evidence: "cache" | "crawl" = "cache";
    if (text.length < MATERIAL_ARTICLE_MIN_TEXT) {
      if (!host.privacyAllowed(bm, "server_fetch")) {
        plans.set(it.bookmark_id, skip(it, "privacy_changed"));
        continue;
      }
      const crawled = await host.crawl(bm.id);
      if (!crawled.ok) {
        plans.set(it.bookmark_id, fail(it, `crawl_failed:${crawled.detail ?? crawled.reason ?? "unknown"}`.slice(0, 120), 1));
        continue;
      }
      text = crawled.text ?? textOf(store.getCache(bm.id));
      evidence = "crawl";
    }
    if (text.length < MATERIAL_ARTICLE_MIN_TEXT) {
      // 正文不足：不能确认为资料，按书签参与主题归位
      v.use = "site";
      continue;
    }
    toJudge.push({ it, bm, type: cls.kind, signals: cls.signals, excerpt: text.slice(0, 400), evidence });
  }

  const existingCategories = store.materialFacets(false).categories.map((c) => c.category);
  const existingSet = new Set(existingCategories);
  const categories: Array<{ path: string; existedBefore: boolean }> = [];
  const categorySet = new Set<string>();
  let judged = 0;
  for (const batch of chunk(toJudge, JUDGE_BATCH)) {
    await host.checkpoint();
    host.note(`正在判定内容资料与资料分类 · ${judged} / ${toJudge.length}`);
    let out: { results?: JudgeResult[] } | null;
    try {
      out = await host.callJson<{ results?: JudgeResult[] }>([
        { role: "system", content: judgeSystem() },
        {
          role: "user",
          content: JSON.stringify({
            existingCategories: existingCategories.slice(0, 150),
            items: batch.map((c, i) => ({
              index: i,
              title: c.bm.title.slice(0, 200),
              url: safeUrl(c.bm.url_canonical),
              excerpt: c.excerpt,
              knownMaterial: c.evidence === "url_rule",
            })),
          }),
        },
      ]);
    } catch (err) {
      const reason = isLlmContentModeration(err) ? "content_rejected_by_model" : "model_error";
      for (const c of batch) plans.set(c.it.bookmark_id, fail(c.it, reason, 1));
      judged += batch.length;
      continue;
    }
    const byIndex = new Map<number, JudgeResult>();
    for (const r of out?.results ?? []) if (typeof r?.index === "number") byIndex.set(r.index, r);
    for (const [i, c] of batch.entries()) {
      judged += 1;
      const raw = byIndex.get(i);
      const v = verdicts.get(c.it.bookmark_id)!;
      if (!raw) {
        plans.set(c.it.bookmark_id, fail(c.it, "model_output_incomplete", 1));
        continue;
      }
      // 网址形态已确认的媒体资料无需内容判定；其余必须由模型明确判为内容型（漏判不视为肯定）
      const material = c.evidence === "url_rule" ? true : raw.material === true;
      if (c.evidence !== "url_rule" && typeof raw.material !== "boolean") {
        plans.set(c.it.bookmark_id, fail(c.it, "invalid_model_output", 1));
        continue;
      }
      if (!material) {
        v.use = "site";
        continue;
      }
      if (!(Number(raw.confidence) >= CONVERT_CONFIDENCE)) {
        plans.set(c.it.bookmark_id, keep(c.it, "insufficient_evidence"));
        continue;
      }
      const category = cleanCategory(raw.category);
      if (!category) {
        plans.set(c.it.bookmark_id, fail(c.it, "category_invalid", 1));
        continue;
      }
      plans.set(c.it.bookmark_id, {
        itemId: c.it.id, bookmarkId: c.it.bookmark_id, decision: "convert", targetKey: null, category,
        materialType: c.type, reason: "content_page", retryable: 0, kind: "material", evidenceRef: c.evidence,
      });
      if (!categorySet.has(category)) {
        categorySet.add(category);
        categories.push({ path: category, existedBefore: existingSet.has(category) });
      }
    }
  }
  if (categories.length > MAX_CATEGORIES) {
    throw new PlanError(
      "too_many_categories",
      `资料分类方案过细：拟使用 ${categories.length} 个分类路径，超过单次上限 ${MAX_CATEGORIES}，尚未应用任何调整。`,
    );
  }

  // ---------- ⑤ 书签分支落点：目标与当前是同一目录 ID 才算「已在合适位置」 ----------
  for (const it of usable) {
    if (plans.has(it.bookmark_id)) continue;
    const v = verdicts.get(it.bookmark_id);
    if (!v) {
      plans.set(it.bookmark_id, fail(it, "model_output_incomplete", 1));
      continue;
    }
    if (v.use === "unsure" || !(v.confidence >= MOVE_CONFIDENCE)) {
      plans.set(it.bookmark_id, keep(it, "insufficient_evidence"));
      continue;
    }
    const key = v.subKey && nodeByKey.has(v.subKey) ? v.subKey : v.topicKey;
    const node = nodeByKey.get(key) ?? nodeByKey.get(v.topicKey);
    if (!node) {
      plans.set(it.bookmark_id, keep(it, "insufficient_evidence"));
      continue;
    }
    const bm = store.getBookmark(it.bookmark_id)!;
    if (node.id && bm.folder_id === node.id) {
      plans.set(it.bookmark_id, keep(it, "already_placed"));
      continue;
    }
    plans.set(it.bookmark_id, {
      itemId: it.id, bookmarkId: it.bookmark_id, decision: "move", targetKey: node.key, category: null,
      materialType: null, reason: v.reason || "topic_match", retryable: 0, kind: "bookmark", evidenceRef: null,
    });
  }

  // 每条输入都必须有判断：未覆盖的条目按失败收尾（提交阶段据此终结，不留永久 remaining）
  const itemsOut: ItemPlan[] = [];
  for (const it of items) {
    itemsOut.push(plans.get(it.bookmark_id) ?? fail(it, "not_planned", 1));
  }
  return {
    plan: {
      version: 1,
      rootFolderId: root.id,
      folderNodes,
      categories,
      topics: [...tree.keys()].slice(0, 8),
    },
    items: itemsOut,
  };
}

/** 目录相对被整理目录的路径（显示用：一级 / 二级） */
export function relPathOf(store: Store, folderId: string, rootId: string): string {
  const byId = new Map(store.listFolders().map((f) => [f.id, f] as const));
  const names: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(folderId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.unshift(cur.name);
    if (cur.id === rootId) break;
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return names.join(" / ");
}
