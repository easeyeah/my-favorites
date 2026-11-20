/**
 * 演示模式 mock 后端：URL 带 ?mock 进入（或 VITE_MOCK=1），?nomock 退出。
 * 在 api.ts 网络层统一拦截——页面代码与服务端数据契约完全不变，无服务端也能跑通全部界面。
 * 内存数据库挂 globalThis（HMR/路由切换不丢状态）；增删改都真实生效（移动/回滚/发布/整理会话）。
 */
import type {
  Bookmark,
  DupScanReport,
  FolderTreeNode,
  HealthReport,
  LinkCheckReport,
  NavSite,
  NavSiteDetail,
  ProviderConfigRow,
  Stats,
  TokenRow,
  VersionRow,
} from "./api";

const MOCK_KEY = "mf-mock-demo";

export function isMock(): boolean {
  if (typeof location === "undefined") return false;
  const qs = new URLSearchParams(location.search);
  if (qs.has("mock")) {
    localStorage.setItem(MOCK_KEY, "1");
    return true;
  }
  if (qs.has("nomock")) {
    localStorage.removeItem(MOCK_KEY);
    return false;
  }
  return localStorage.getItem(MOCK_KEY) === "1" || (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_MOCK === "1";
}

// ---------- 内存数据库 ----------

interface MockVersion extends VersionRow {
  moves?: Array<{ id: string; from: string }>;
  /** 本批 AI 新建的目录（rollback 时已空则删——与服务端 deleteFolderIfEmpty 同口径） */
  createdFolders?: string[];
}

interface MockDb {
  seq: number;
  folders: Array<{ id: string; name: string; parent_id: string | null; is_system_inbox: number }>;
  bookmarks: Bookmark[];
  versions: MockVersion[];
  sites: NavSite[];
  siteDetail: Record<string, NavSiteDetail>;
  providers: ProviderConfigRow[];
  tokens: TokenRow[];
  /** D28 整理通知方式（管理台侧演示态） */
  notifyStyle: "toast" | "card" | "silent";
  /** 原型 12 整理偏好规则（演示态） */
  organizeRules: string[];
  privacy: string[];
  webhooks: Array<{ id: string; url: string; events: string[]; enabled: boolean }>;
  lastLink: LinkCheckReport;
  lastDup: DupScanReport;
}

const h = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();
const d = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

function seed(): MockDb {
  /** cache 为 BookmarkDetail 的扩展字段：detail 路由回传，列表路由不影响 */
  const B = (
    id: string,
    folder_id: string,
    title: string,
    url: string,
    extra: Partial<Bookmark> & { summary?: string; tags?: string[]; fail?: string } = {},
  ): Bookmark => {
    const { summary, tags, fail, ...rest } = extra;
    const base: Bookmark = {
      id,
      folder_id,
      url_raw: url,
      url_canonical: url,
      title,
      description: null,
      status: "normal",
      favicon_url: null,
      added_at: d(3 + Math.floor(Math.random() * 200)),
      last_checked_at: h(30),
      pinned: 0,
      is_private: 0,
      ...rest,
    };
    if (summary || tags || fail) {
      Object.assign(base, {
        cache: {
          l1_summary: summary ?? null,
          l1_tags: tags,
          lang: "zh",
          fetched_via: "server-crawl",
          fetched_at: h(26),
          fail_reason: fail ?? null,
        },
      });
    }
    return base;
  };

  const bookmarks: Bookmark[] = [
    // 收纳盒（@inbox）：6 条增量
    B("b-in1", "f-inbox", "Rust 1.82 发布说明", "https://rust-lang.org/releases/1-82", {
      added_at: h(3),
      summary: "Rust 1.82 带来了新的生命周期语法与不安全属性检查改进。",
      tags: ["rust", "发布说明"],
    }),
    B("b-in2", "f-inbox", "用 AI 重做了一遍个人知识库", "https://sspai.com/post/9handbook", { added_at: h(5) }),
    B("b-in3", "f-inbox", "CSS Anchor Positioning 一览", "https://css-tricks.com/css-anchor-positioning", { added_at: h(9) }),
    B("b-in4", "f-inbox", "这家面馆只开三小时", "https://m.dianping.com/shop/angler-noodle", { added_at: h(26), is_private: 1 }),
    B("b-in5", "f-inbox", "TypeScript 泛型工具类型速查", "https://typescript-toolkit.dev/cheatsheet", { added_at: h(31) }),
    B("b-in6", "f-inbox", "2026 秋季新品发布会汇总", "https://apple.com/events/fall-2026", { added_at: h(50) }),

    // 开发工具 / 前端 / 后端
    B("b-1", "f-fe", "React 官方文档", "https://react.dev/learn", {
      summary: "React 官方学习教程：组件、状态、数据流与 Hooks 的现代用法。",
      tags: ["react", "前端", "文档"],
      added_at: d(120),
    }),
    B("b-2", "f-fe", "Vite 7 迁移指南", "https://vite.dev/guide/migration", { tags: ["vite", "构建"], added_at: d(90) }),
    B("b-3", "f-fe", "Tailwind CSS v4 官方文档", "https://tailwindcss.com/docs", { summary: "v4 的 CSS-first 配置与主题变量体系。", tags: ["css", "tailwind"] }),
    B("b-4", "f-fe", "Tailwind CSS v4 文档（备用镜像）", "https://tailwindcss.com/docs/", { added_at: d(10) }),
    B("b-5", "f-fe", "MDN Web 文档", "https://developer.mozilla.org/zh-CN/", { tags: ["web", "参考"] }),
    B("b-6", "f-fe", "Can I Use", "https://caniuse.com/", {}),
    B("b-7", "f-be", "Docker 官方文档", "https://docs.docker.com/", { tags: ["docker", "运维"] }),
    B("b-8", "f-be", "PostgreSQL 17 发布说明", "https://www.postgresql.org/docs/17/release", { fail: "403（反爬拦截）" }),
    B("b-9", "f-be", "Nginx 配置生成器", "https://nginxconfig.io/", {}),
    B("b-10", "f-be", "Kubernetes 中文社区", "https://kubernetes.org.cn/", {}),
    B("b-11", "f-dev", "阮一峰的科技爱好者周刊", "https://www.ruanyifeng.com/blog/weekly", { summary: "每周记录值得分享的科技内容，读书、工具与行业观察。", tags: ["周刊"] }),
    B("b-12", "f-dev", "深入 Node.js 事件循环（旧博客）", "http://old-blog.example.com/node-event-loop", { status: "dead", added_at: d(1500), fail: "连接超时" }),

    // 设计灵感
    B("b-13", "f-design", "Dribbble", "https://dribbble.com/", { tags: ["设计", "灵感"] }),
    B("b-14", "f-design", "Mobbin · 移动端设计模式库", "https://mobbin.com/", {}),
    B("b-15", "f-design", "中国色", "http://zhongguose.com/", { summary: "中国传统色色谱，附 RGB/CMYK 值，适合找国风配色。", tags: ["配色", "国风"] }),
    B("b-16", "f-design", "Figma 学习手册", "https://figma.com/resource-library/", {}),

    // 阅读清单
    B("b-17", "f-read", "Paul Graham Essays", "https://paulgraham.com/articles", { tags: ["随笔"] }),
    B("b-18", "f-read", "《卡片笔记写作法》读书笔记", "https://sspai.com/post/card-notes", { summary: "以卡片盒笔记法为核心的实践总结：日常收集、每周回顾、长期沉淀。", tags: ["笔记", "读书"] }),
    B("b-19", "f-read", "漫谈程序员的三种成长曲线", "https://blog.example-curve.dev/growth", { status: "dead", added_at: d(900), fail: "HTTP 410 Gone" }),
    B("b-20", "f-read", "Hacker News", "https://news.ycombinator.com/", { fail: "403（反爬拦截）" }),

    // 影音娱乐
    B("b-21", "f-media", "豆瓣电影 Top250", "https://movie.douban.com/top250", { is_private: 1, added_at: d(700) }),
    B("b-22", "f-media", "B 站收藏夹：纪录片区", "https://space.bilibili.com/favlist", {}),

    // 学习课程
    B("b-23", "f-learn", "MIT 6.006 算法导论", "https://ocw.mit.edu/courses/6-006", { tags: ["算法", "课程"] }),
    B("b-24", "f-learn", "CS 自学指南", "https://csdiy.wiki/", { summary: "汇总全世界优秀的计算机自学课程与学习路线。", tags: ["CS", "自学"] }),

    // 生活服务（含归档样例）
    B("b-25", "f-life", "12306 购票", "https://www.12306.cn/", { is_private: 1 }),
    B("b-26", "f-life", "国家图书馆", "http://www.nlc.cn/", { status: "archived", added_at: d(2100) }),
    B("b-27", "f-life", "2019 年前端工具盘点（过时）", "https://medium.com/front-tools-2019", { status: "archived", added_at: d(2400) }),
    B("b-28", "f-dev", "老版 Webpack 4 教程", "https://webpack-archive.example.com/v4", { status: "dead", added_at: d(1300), fail: "DNS 解析失败" }),
  ];

  const folders = [
    { id: "f-inbox", name: "收纳盒", parent_id: null, is_system_inbox: 1 },
    { id: "f-dev", name: "开发工具", parent_id: null, is_system_inbox: 0 },
    { id: "f-fe", name: "前端", parent_id: "f-dev", is_system_inbox: 0 },
    { id: "f-be", name: "后端与运维", parent_id: "f-dev", is_system_inbox: 0 },
    { id: "f-design", name: "设计灵感", parent_id: null, is_system_inbox: 0 },
    { id: "f-read", name: "阅读清单", parent_id: null, is_system_inbox: 0 },
    { id: "f-media", name: "影音娱乐", parent_id: null, is_system_inbox: 0 },
    { id: "f-learn", name: "学习课程", parent_id: null, is_system_inbox: 0 },
    { id: "f-life", name: "生活服务", parent_id: null, is_system_inbox: 0 },
  ];

  const dead = bookmarks.filter((b) => b.status === "dead");
  const suspect = bookmarks.filter((b) => b.status === "normal" && (b as Bookmark & { cache?: { fail_reason?: string } }).cache?.fail_reason?.startsWith("403"));

  const lastLink: LinkCheckReport = {
    id: "rpt-link-seed",
    created_at: h(40),
    findings: {
      checked: bookmarks.filter((b) => b.status !== "archived").length,
      dead: dead.length,
      suspect: suspect.length,
      normal: bookmarks.filter((b) => b.status !== "archived").length - dead.length - suspect.length,
      results: [
        ...dead.map((b) => ({ id: b.id, url: b.url_canonical, title: b.title, verdict: "dead" as const, detail: cacheFail(b) ?? "探测失败" })),
        ...suspect.map((b) => ({ id: b.id, url: b.url_canonical, title: b.title, verdict: "suspect" as const, detail: cacheFail(b) ?? "403（反爬拦截）" })),
      ],
    },
  };
  const lastDup: DupScanReport = {
    id: "rpt-dup-1",
    created_at: h(28),
    findings: {
      groups: 1,
      suggestions: [
        {
          keep: "b-3",
          title: "Tailwind CSS v4 官方文档",
          dupes: ["b-4"],
          items: [
            { id: "b-3", title: "Tailwind CSS v4 官方文档", url: "https://tailwindcss.com/docs", isKeep: true },
            { id: "b-4", title: "Tailwind CSS v4 文档（备用镜像）", url: "https://tailwindcss.com/docs/", isKeep: false },
          ],
        },
      ],
    },
  };

  const versions: MockVersion[] = [
    { id: "ver-a1b2c3d4", session_id: null, kind: "收纳盒自动归位", reverted: 0, created_at: h(2), actionCount: 3, moves: [] },
    { id: "ver-e5f6a7b8", session_id: null, kind: "「开发工具」重分类", reverted: 0, created_at: d(1), actionCount: 12, moves: [] },
    { id: "ver-c9d0e1f2", session_id: null, kind: "合并重复", reverted: 1, created_at: d(3), actionCount: 1, moves: [] },
  ];

  return {
    seq: 100,
    folders,
    bookmarks,
    versions,
    sites: [{ slug: "x7k2pq9m", title: "我的导航站", template: "grid", published: 1, revision: 3 }],
    siteDetail: {
      x7k2pq9m: {
        slug: "x7k2pq9m",
        title: "我的导航站",
        template: "grid",
        published: 1,
        revision: 3,
        hasPassword: false,
        scope: { folderIds: ["f-dev", "f-design"] },
        itemCount: 16,
      },
    },
    providers: [
      {
        id: "prov-1",
        provider_id: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        api_key: "********",
        has_key: true,
        purpose_models: { organize: "deepseek-chat", summarize: "deepseek-chat" },
        enabled: 1,
        created_at: d(6),
      },
    ],
    tokens: [
      { token_id: "tok-9f8e7d6c", label: "本机 Chrome 扩展", created_at: d(17), expires_at: null, revoked_at: null, last_used_at: h(1) },
      { token_id: "tok-1a2b3c4d", label: "web-admin", created_at: d(9), expires_at: null, revoked_at: null, last_used_at: h(4) },
    ],
    notifyStyle: "toast",
    organizeRules: ["同一文档的多个版本共存时不合并"],
    privacy: ["*.12306.cn", "*.alipay.com", "*.icbc.com.cn", "*.gov.cn", "*.dianping.com", "*.bank-of-china.com"],
    webhooks: [
      { id: "wh-1", url: "https://hooks.example.com/mf", events: ["bookmark.added"], enabled: true },
    ],
    lastLink,
    lastDup,
  };
}

function cacheFail(b: Bookmark): string | undefined {
  return (b as Bookmark & { cache?: { fail_reason?: string | null } }).cache?.fail_reason ?? undefined;
}

// globalThis 单例：HMR / 路由切换不丢；数据结构变更时升版本自动重播种
const DB_VERSION = 4;
const g = globalThis as typeof globalThis & { __mfMockDb?: MockDb; __mfMockDbV?: number };
const db: MockDb = (() => {
  if (g.__mfMockDb && g.__mfMockDbV === DB_VERSION) return g.__mfMockDb;
  const fresh = seed();
  g.__mfMockDb = fresh;
  g.__mfMockDbV = DB_VERSION;
  return fresh;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nid = (p: string) => `${p}-${(db.seq++).toString(36)}`;
const now = () => new Date().toISOString();

/** 网络层拦截时统一加一点拟真延迟，骨架屏/转场可见 */
export async function mockRequestAsync(method: string, rawPath: string, ctx: MockCtx): Promise<unknown> {
  await sleep(140 + Math.random() * 240);
  return mockRequest(method, rawPath, ctx);
}

// ---------- 派生数据 ----------

function folderTree(): FolderTreeNode[] {
  return db.folders.map((f) => {
    const own = db.bookmarks.filter((b) => b.folder_id === f.id).length;
    // 子树 totalCount：父目录聚拢全部后代
    const ids = new Set<string>([f.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of db.folders) {
        if (x.parent_id && ids.has(x.parent_id) && !ids.has(x.id)) {
          ids.add(x.id);
          grew = true;
        }
      }
    }
    return { ...f, directCount: own, totalCount: db.bookmarks.filter((b) => ids.has(b.folder_id)).length };
  });
}

function buildLinkReport(): LinkCheckReport {
  const dead = db.bookmarks.filter((b) => b.status === "dead");
  const suspect = db.bookmarks.filter((b) => b.status === "normal" && cacheFail(b)?.startsWith("403"));
  const checked = db.bookmarks.filter((b) => b.status !== "archived").length;
  return {
    id: nid("rpt"),
    created_at: now(),
    findings: {
      checked,
      dead: dead.length,
      suspect: suspect.length,
      normal: checked - dead.length - suspect.length,
      results: [
        ...dead.map((b) => ({ id: b.id, url: b.url_canonical, title: b.title, verdict: "dead" as const, detail: cacheFail(b) ?? "探测失败" })),
        ...suspect.map((b) => ({ id: b.id, url: b.url_canonical, title: b.title, verdict: "suspect" as const, detail: cacheFail(b) ?? "403（反爬拦截）" })),
      ],
    },
  };
}

// ---------- 规则引擎式的收纳盒 / 整理建议 ----------

const MOVE_RULES: Array<[RegExp, string]> = [
  [/rust|typescript|css|react|vue|node|前端|docker|k8s|nginx|postgres|算法|程序/i, "f-dev"],
  [/设计|配色|figma|dribbble|ui/i, "f-design"],
  [/读书|笔记|essay|周刊|程序员/i, "f-read"],
  [/电影|豆瓣|bilibili|b 站|剧|影/i, "f-media"],
  [/课程|教程|学习|指南|速查|cheatsheet/i, "f-learn"],
  [/面馆|探店|购票|发布会|生活/i, "f-life"],
];

function suggestFolder(b: Bookmark): string {
  for (const [re, fid] of MOVE_RULES) if (re.test(b.title) || re.test(b.url_canonical)) return fid;
  return "f-read";
}

/** 「全库重分类」候选：优先收纳盒增量，否则取最早收藏的 3 条（提案与应用共用同一口径） */
function reorgCandidates(): Bookmark[] {
  const inb = db.bookmarks.filter((b) => b.folder_id === "f-inbox");
  if (inb.length > 0) return inb.slice(0, 3);
  return db.bookmarks
    .filter((b) => b.folder_id !== "f-inbox")
    .sort((a, b) => a.added_at.localeCompare(b.added_at))
    .slice(0, 3);
}

const fname = (id: string): string => db.folders.find((f) => f.id === id)?.name ?? id;

function applyMoves(
  items: Array<{ id: string; to: string }>,
  kind: string,
  createdFolders: string[] = [],
): MockVersion {
  const moves = items.map(({ id, to }) => {
    const b = db.bookmarks.find((x) => x.id === id)!;
    const from = b.folder_id;
    b.folder_id = to;
    return { id, from };
  });
  const v: MockVersion = {
    id: nid("ver"),
    session_id: null,
    kind,
    reverted: 0,
    created_at: now(),
    actionCount: moves.length,
    moves,
    createdFolders,
  };
  db.versions.unshift(v);
  return v;
}

function addVersion(kind: string, actionCount: number): void {
  db.versions.unshift({ id: nid("ver"), session_id: null, kind, reverted: 0, created_at: now(), actionCount, moves: [] });
}

/** 重新扫描重复组并写回 lastDup（合并/删除后调用，保持角标与确认弹窗口径一致） */
function rebuildDupReport(): void {
  const groups: DupScanReport["findings"]["suggestions"] = [];
  const byKey = new Map<string, string[]>();
  for (const b of db.bookmarks) {
    const key = b.url_canonical.replace(/\/$/, "").toLowerCase();
    byKey.set(key, [...(byKey.get(key) ?? []), b.id]);
  }
  for (const ids of byKey.values()) {
    if (ids.length > 1) {
      const keep = ids[0]!;
      groups.push({
        keep,
        title: db.bookmarks.find((b) => b.id === keep)!.title,
        dupes: ids.slice(1),
        items: ids.map((id) => {
          const b = db.bookmarks.find((x) => x.id === id)!;
          return { id, title: b.title, url: b.url_canonical, isKeep: id === keep };
        }),
      });
    }
  }
  db.lastDup = { id: nid("rpt"), created_at: now(), findings: { groups: groups.length, suggestions: groups } };
}

// ---------- 请求路由 ----------

export interface MockCtx {
  query: URLSearchParams;
  body?: unknown;
  html?: string;
}

const subtreeIds = (folderId: string): Set<string> => {
  const ids = new Set<string>([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of db.folders) {
      if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return ids;
};

/** 返回 undefined = 路由未命中（调用方按 404 处理） */
export function mockRequest(method: string, rawPath: string, ctx: MockCtx): unknown {
  const path = rawPath.replace(/^\/api\/v1/, "").split("?")[0] ?? "";
  const seg = path.split("/").filter(Boolean);

  // ---------- GET ----------
  if (method === "GET" && path === "/stats") {
    const s: Stats = {
      total: db.bookmarks.length,
      dead: db.bookmarks.filter((b) => b.status === "dead").length,
      suspect: db.bookmarks.filter((b) => b.status === "suspect").length,
      folders: db.folders.filter((f) => f.is_system_inbox !== 1).length,
      navSites: db.sites.filter((x) => x.published === 1).length,
    };
    return s;
  }
  if (method === "GET" && path === "/health-report") {
    const r: HealthReport = {
      dead: db.bookmarks.filter((b) => b.status === "dead").length,
      suspect: db.bookmarks.filter((b) => b.status === "suspect").length,
      duplicates: db.lastDup.findings.groups,
      stale: 12,
      oldestBookmark: d(2400),
      snapshotUsageMb: 86,
    };
    return r;
  }
  if (method === "GET" && (path === "/folders/tree" || path === "/folders")) return folderTree();
  if (method === "GET" && path === "/bookmarks") {
    const folderId = ctx.query.get("folderId") ?? undefined;
    const status = ctx.query.get("status") ?? undefined;
    const limit = Number(ctx.query.get("limit") ?? 100);
    const offset = Number(ctx.query.get("offset") ?? 0);
    let list = db.bookmarks;
    if (folderId) {
      const ids = subtreeIds(folderId);
      list = list.filter((b) => ids.has(b.folder_id));
    }
    if (status === "suspect") {
      // 疑似失效：未被确认失效、抓取被 403 反爬拦截（保守规则仅标注）
      list = list.filter((b) => b.status === "normal" && cacheFail(b)?.startsWith("403"));
    } else if (status) {
      list = list.filter((b) => b.status === status);
    }
    return list.slice(offset, offset + limit);
  }
  if (method === "GET" && seg[0] === "bookmarks" && seg.length === 2) {
    const b = db.bookmarks.find((x) => x.id === seg[1]);
    return b ? { ...b, cache: (b as BookmarkDetailLike).cache ?? null } : undefined;
  }
  if (method === "GET" && path === "/search") {
    const q = (ctx.query.get("q") ?? "").toLowerCase();
    return {
      results: db.bookmarks.filter((b) => b.title.toLowerCase().includes(q) || b.url_canonical.toLowerCase().includes(q)),
    };
  }
  if (method === "GET" && path === "/organize/versions") return { versions: db.versions };
  if (method === "GET" && seg[0] === "maintenance" && seg[1] === "report" && seg[2] === "latest") {
    return ctx.query.get("type") === "duplicate_scan" ? db.lastDup : db.lastLink;
  }
  if (method === "GET" && path === "/nav/sites") return db.sites;
  if (method === "GET" && seg[0] === "nav" && seg[1] === "sites" && seg.length === 3) return db.siteDetail[seg[2] ?? ""];
  if (method === "GET" && path === "/settings/providers") return db.providers;
  // D28 通知偏好（管理台侧）：读 + 改（演示态存内存）
  if (method === "GET" && path === "/settings/prefs") {
    return { topCategories: ["开发", "工具", "阅读清单"], adoption: {}, notifyStyle: db.notifyStyle, organizeRules: db.organizeRules };
  }
  if (method === "PATCH" && path === "/settings/prefs") {
    const body = (ctx.body ?? {}) as { notifyStyle?: string; organizeRules?: string[] };
    if (body.notifyStyle === "toast" || body.notifyStyle === "card" || body.notifyStyle === "silent") db.notifyStyle = body.notifyStyle;
    if (Array.isArray(body.organizeRules)) db.organizeRules = body.organizeRules;
    return { ok: true, notifyStyle: db.notifyStyle, organizeRules: db.organizeRules };
  }
  // 在线模型列表（演示：模拟供应商 /models 响应）
  if (method === "GET" && seg[0] === "settings" && seg[1] === "providers" && seg[2] && seg[3] === "models") {
    return { models: ["deepseek-chat", "deepseek-reasoner", "deepseek-v3-0324", "deepseek-r1-0528", "deepseek-coder"] };
  }
  if (method === "GET" && path === "/auth/tokens") return { tokens: db.tokens };
  if (method === "GET" && path === "/privacy/rules") return { patterns: [...db.privacy], revision: 7 };
  if (method === "GET" && path === "/stats/storage") {
    const marks = db.bookmarks.length
    const sqliteMb = +(0.4 + marks * 0.02).toFixed(1)
    const snapshotsMb = +(db.bookmarks.filter((b) => b.status !== 'archived').length * 0.35).toFixed(1)
    const iconsMb = +(marks * 0.015).toFixed(2)
    const backupsMb = 12.5
    const totalMb = +(sqliteMb + snapshotsMb + iconsMb + backupsMb).toFixed(1)
    return { sqliteMb, snapshotsMb, iconsMb, backupsMb, totalMb }
  }
  if (method === "GET" && path === "/settings/webhooks") return { webhooks: db.webhooks }
  if (method === "POST" && path === "/settings/webhooks") {
    const body = (ctx.body ?? {}) as { url?: string; events?: string[] }
    if (!body.url || !/^https?:\/\//.test(body.url)) return { error: "url_required" }
    const wh = { id: nid("wh"), url: body.url, events: body.events ?? ["bookmark.added"], enabled: true }
    db.webhooks.push(wh)
    return wh
  }
  if (method === "PATCH" && seg[0] === "settings" && seg[1] === "webhooks" && seg.length === 3) {
    const wh = db.webhooks.find((x) => x.id === seg[2])
    if (!wh) return { error: "not_found" }
    const body = (ctx.body ?? {}) as { enabled?: boolean }
    if (body.enabled !== undefined) wh.enabled = body.enabled
    return wh
  }
  if (method === "DELETE" && seg[0] === "settings" && seg[1] === "webhooks" && seg.length === 3) {
    db.webhooks = db.webhooks.filter((x) => x.id !== seg[2])
    return { ok: true }
  }
  if (method === "POST" && seg[0] === "settings" && seg[1] === "webhooks" && seg[3] === "test" && seg.length === 4) {
    const wh = db.webhooks.find((x) => x.id === seg[2])
    if (!wh) return undefined
    if (!/^https?:\/\//.test(wh.url)) return { ok: false, error: "url_invalid" }
    return { ok: true }
  }

  // ---------- 书签写操作 ----------
  if (method === "PATCH" && seg[0] === "bookmarks" && seg.length === 2) {
    const b = db.bookmarks.find((x) => x.id === seg[1]);
    if (!b) return undefined;
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    if (typeof body.folderId === "string") b.folder_id = body.folderId;
    if (typeof body.status === "string") b.status = body.status;
    if (body.isPrivate !== undefined) b.is_private = body.isPrivate ? 1 : 0;
    if (typeof body.title === "string") b.title = body.title;
    return b;
  }
  if (method === "DELETE" && seg[0] === "bookmarks" && seg.length === 2) {
    db.bookmarks = db.bookmarks.filter((x) => x.id !== seg[1]);
    db.lastLink = { ...buildLinkReport(), created_at: db.lastLink.created_at };
    return { ok: true };
  }
  if (method === "POST" && path === "/bookmarks") {
    const body = (ctx.body ?? {}) as { url: string; title?: string; folderId?: string };
    const canon = body.url.trim();
    if (db.bookmarks.some((b) => b.url_canonical.replace(/\/$/, "") === canon.replace(/\/$/, "")))
      return { ...db.bookmarks[0], duplicate: true };
    const b: Bookmark = {
      id: nid("b"),
      folder_id: body.folderId ?? "f-inbox",
      url_raw: canon,
      url_canonical: canon,
      title: body.title || canon,
      description: null,
      status: "normal",
      favicon_url: null,
      added_at: now(),
      last_checked_at: null,
      pinned: 0,
      is_private: 0,
    };
    db.bookmarks.unshift(b);
    const sug = suggestFolder(b);
    const nameOf = (id: string) => db.folders.find((f) => f.id === id)?.name ?? id;
    return { ...b, suggest: sug !== b.folder_id ? { folderPath: [nameOf(sug)] } : undefined };
  }
  if (method === "POST" && path === "/folders") {
    const body = (ctx.body ?? {}) as { name: string; parentId?: string };
    db.folders.push({ id: nid("f"), name: body.name, parent_id: body.parentId ?? null, is_system_inbox: 0 });
    return { ok: true };
  }
  if (method === "PATCH" && seg[0] === "folders" && seg.length === 2) {
    const body = (ctx.body ?? {}) as { name?: string };
    const f = db.folders.find((x) => x.id === seg[1]);
    if (!f || f.is_system_inbox === 1 || !body.name?.trim()) return { error: "not_found_or_system" };
    f.name = body.name.trim();
    return f;
  }
  if (method === "DELETE" && seg[0] === "folders" && seg.length === 2) {
    const f = db.folders.find((x) => x.id === seg[1]);
    if (!f) return undefined;
    const hasChildren = db.folders.some((x) => x.parent_id === f.id);
    const hasMarks = db.bookmarks.some((b) => b.folder_id === f.id);
    if (f.is_system_inbox === 1 || hasChildren || hasMarks) return { error: "folder_not_empty" };
    db.folders = db.folders.filter((x) => x.id !== f.id);
    return { ok: true };
  }

  // ---------- 收纳盒 / 整理 / 回滚 ----------
  // ---------- 原型补齐端点（mock 演示态） ----------
  if (method === "GET" && path === "/inbox/count") {
    const n = db.bookmarks.filter((b) => b.folder_id === "f-inbox").length;
    return { count: n, ambiguous: Math.min(1, n) };
  }
  if (method === "GET" && path === "/inbox/items") {
    const items = db.bookmarks
      .filter((b) => b.folder_id === "f-inbox")
      .map((b, i) => ({
        id: b.id,
        title: b.title,
        url_canonical: b.url_canonical,
        added_at: b.added_at,
        is_private: b.url_canonical.includes("bank") ? 1 : 0,
        state: b.url_canonical.includes("bank")
          ? "privacy_hold"
          : i % 4 === 0
            ? "ambiguous"
            : "pending",
        confidence: i % 4 === 0 ? 0.41 : null,
        reason: null,
        attempts: i % 4 === 1 ? 2 : 0,
        suggestCategory: i % 4 === 0 ? "生活" : null,
        domainRuleFolderId: null,
      }));
    return { items, placed: [], ambiguousCount: items.filter((x) => x.state === "ambiguous").length };
  }
  if (method === "POST" && path === "/inbox/assign") {
    const { bookmarkId, folderId } = (ctx.body ?? {}) as { bookmarkId?: string; folderId?: string };
    const b = db.bookmarks.find((x) => x.id === bookmarkId);
    if (b && folderId) b.folder_id = folderId;
    return { ok: true };
  }
  if (method === "POST" && path === "/inbox/retry") return { moved: 0, left: [] };
  if (method === "GET" && path === "/nav/projection") {
    return {
      projection: {
        built_at: new Date().toISOString(),
        counts: { sites: 12, refs: 3, merged: 8, upgraded: 2, content: 17 },
        sites: [
          { domain: "github.com", title: "GitHub", url: "https://github.com", upgraded: false, count: 4 },
          { domain: "figma.com", title: "Figma", url: "https://figma.com", upgraded: false, count: 1 },
        ],
        refs: [{ domain: "developer.mozilla.org", title: "MDN Web Docs", url: "https://developer.mozilla.org" }],
        merged: [{ domain: "zhihu.com", siteTitle: "知乎", contentCount: 3 }],
        contentCount: 17,
      },
    };
  }
  if (method === "POST" && path === "/nav/projection/rebuild") {
    return { ok: true, counts: { sites: 12, refs: 3, merged: 8, upgraded: 2, content: 17 }, built_at: new Date().toISOString() };
  }
  if (method === "GET" && path === "/nav/projection/list") {
    const kind = ctx.query.get("kind") ?? "sites";
    if (kind === "content") {
      const rows = db.bookmarks.slice(0, 6).map((b) => ({ id: b.id, title: b.title, url_canonical: b.url_canonical, folder_id: b.folder_id }));
      return { rows };
    }
    return { rows: [{ domain: "github.com", title: "GitHub", url: "https://github.com", upgraded: false, count: 4 }] };
  }
  if (method === "GET" && path === "/bookmarks/top") {
    const items = db.bookmarks.slice(0, 8).map((b) => ({ id: b.id, title: b.title, url_canonical: b.url_canonical, favicon_url: b.favicon_url, clicks: 3 }));
    return { items };
  }
  if (method === "POST" && /^\/bookmarks\/[\w-]+\/click$/.test(path)) return { ok: true };
  if (method === "GET" && path === "/snapshots" && ctx.query.get("bookmarkId")) {
    return { snapshots: [{ id: nid("snap"), created_at: new Date().toISOString(), size: 2.1 * 1024 * 1024, via: "extension_capture" }] };
  }
  if (method === "POST" && path === "/inbox/process") {
    const inb = db.bookmarks.filter((b) => b.folder_id === "f-inbox");
    if (inb.length === 0) return { moved: 0, items: [] };
    const targets = inb.map((b) => ({ b, to: suggestFolder(b) }));
    applyMoves(
      targets.map(({ b, to }) => ({ id: b.id, to })),
      "收纳盒自动归位",
    );
    const items = targets.map(({ b, to }) => ({ title: b.title, to: fname(to) }));
    return { moved: items.length, items };
  }
  if (method === "POST" && path === "/organize/sessions") {
    // D27 act + undo：一次调用 = 计划 + 直接生效；actions 只作事后只读明细
    const msg = String((ctx.body as { message?: string })?.message ?? "");
    const id = nid("ses");
    if (/合并|重复/.test(msg)) {
      const sugg = db.lastDup.findings.suggestions;
      if (sugg.length === 0) {
        return {
          sessionId: id,
          status: "answered",
          answer: "扫了一遍全库，没有发现重复书签，这一步可以跳过 ✅",
          actions: null,
        };
      }
      const dupes = sugg.flatMap((g) => g.dupes);
      db.bookmarks = db.bookmarks.filter((b) => !dupes.includes(b.id));
      addVersion("合并重复", dupes.length);
      rebuildDupReport();
      return {
        sessionId: id,
        status: "applied",
        answer: `发现 ${sugg.length} 组重复书签（同域名同标题 / 规范 URL 撞车）。已合并：每组保留最早收藏的一条，其余直接移除——7 天内可在版本历史一键恢复。`,
        actions: sugg.map((g) => ({ type: "merge", bookmarkTitle: g.title, mergeFrom: g.dupes })),
        versionId: db.versions[0]!.id,
        applied: dupes.length,
      };
    }
    if (/归档|arch/i.test(msg)) {
      // 红线③：归档/删除类永不自动执行——只出建议清单（answered，无版本）
      const candidates = [...db.bookmarks]
        .filter((b) => b.status === "normal")
        .sort((a, b) => a.added_at.localeCompare(b.added_at))
        .slice(0, 4);
      return {
        sessionId: id,
        status: "answered",
        answer: `找出 ${candidates.length} 条归档候选（收藏较早且近期未访问）。清单仅供参考，是否归档由你决定——归档/删除类永不自动执行。`,
        actions: candidates.map((b) => ({
          type: "archive",
          bookmarkTitle: b.title,
          fromFolder: db.folders.find((f) => f.id === b.folder_id)?.name ?? "未整理",
        })),
      };
    }
    if (/撤销|回滚/.test(msg)) {
      return {
        sessionId: id,
        status: "answered",
        answer: "撤销请直接用右侧「版本历史」里的回滚按钮——回滚 = 逆放 diff 生成新版本，历史永不删除。",
        actions: null,
      };
    }
    // 整理/重分类：createFolder 真建目录（同名幂等），move 直接落位
    const candidates = reorgCandidates();
    const fromInbox = candidates.some((b) => b.folder_id === "f-inbox");
    // AI 主题书签归入新目录「AI 与工具」——演示 createFolder + move 的组合（目录已建则复用）
    const AI_RE = /ai|llm|知识库|agent|智能/i;
    const NEW_FOLDER = "AI 与工具";
    const actions: Array<Record<string, unknown>> = candidates.map((b) => {
      const ai = AI_RE.test(b.title) || AI_RE.test(b.url_canonical);
      return {
        type: "move",
        bookmarkId: b.id,
        bookmarkTitle: b.title,
        fromFolder: db.folders.find((f) => f.id === b.folder_id)?.name ?? "未整理",
        toFolder: ai
          ? NEW_FOLDER
          : (db.folders.find((f) => f.id === suggestFolder(b))?.name ?? "阅读清单"),
        ...(ai ? { plannedFolderId: "f-ai-new" } : {}),
      };
    });
    const createdIds: string[] = [];
    if (actions.some((p) => p.toFolder === NEW_FOLDER) && !db.folders.some((f) => f.name === NEW_FOLDER)) {
      db.folders.push({ id: "f-ai-new", name: NEW_FOLDER, parent_id: null, is_system_inbox: 0 });
      createdIds.push("f-ai-new");
      actions.unshift({ type: "createFolder", folderName: NEW_FOLDER, plannedFolderId: "f-ai-new" });
    }
    const targets = actions
      .filter((a) => a.type === "move" && typeof a.bookmarkId === "string")
      .map((a) => ({
        id: a.bookmarkId as string,
        to: db.folders.find((f) => f.name === a.toFolder)?.id ?? (a.plannedFolderId as string) ?? "f-read",
      }))
      .filter((t) => db.bookmarks.some((b) => b.id === t.id));
    const v = applyMoves(targets, "整理直接生效", createdIds);
    return {
      sessionId: id,
      status: "applied",
      answer: `我把最需要处理的 ${candidates.length} 条直接整理到位了${fromInbox ? "（都来自收纳盒）" : ""}：只做移动，不做任何删除；每一次挪动都记入版本历史，不满意可整批撤销。`,
      actions,
      versionId: v.id,
      applied: v.actionCount,
    };
  }
  if (method === "POST" && seg[0] === "organize" && seg[1] === "rollback" && seg.length === 3) {
    const v = db.versions.find((x) => x.id === seg[2]);
    if (!v) return undefined;
    let n = 0;
    for (const mv of v.moves ?? []) {
      const b = db.bookmarks.find((x) => x.id === mv.id);
      if (b) {
        b.folder_id = mv.from;
        n++;
      }
    }
    // createFolder 的逆操作（逆放序：书签已先移回，目录空则删；用户另投了书签进去则保留）
    for (const fid of v.createdFolders ?? []) {
      if (!db.bookmarks.some((b) => b.folder_id === fid)) {
        db.folders = db.folders.filter((f) => f.id !== fid);
        n++;
      }
    }
    v.reverted = n || v.actionCount;
    addVersion(`回滚 · ${v.kind}`, v.reverted);
    return { reversed: v.reverted };
  }

  // ---------- 维护任务 ----------
  if (method === "POST" && path === "/crawl/run") return { processed: 5 };
  if (method === "POST" && path === "/maintenance/links/run") {
    const f = db.lastLink.findings;
    return { checked: f.checked, results: (f.results ?? []).map((r) => ({ verdict: r.verdict })) };
  }
  if (method === "POST" && path === "/maintenance/duplicates/run") {
    rebuildDupReport();
    return { ok: true };
  }

  // ---------- 导航站 ----------
  if (method === "POST" && path === "/nav/publish") {
    const body = (ctx.body ?? {}) as { title: string; template: string; password?: string; folderIds: string[] };
    const existing = db.sites[0];
    const slug = existing?.slug ?? nid("s").slice(-8);
    const count = db.bookmarks.filter(
      (b) => (body.folderIds ?? []).includes(b.folder_id) && b.is_private !== 1 && b.status !== "archived",
    ).length;
    db.sites = [{ slug, title: body.title, template: body.template, published: 1, revision: (existing?.revision ?? 0) + 1 }];
    db.siteDetail[slug] = {
      slug,
      title: body.title,
      template: body.template,
      published: 1,
      revision: (existing?.revision ?? 0) + 1,
      hasPassword: Boolean(body.password),
      scope: { folderIds: body.folderIds },
      itemCount: count,
    };
    return { slug, url: `/s/${slug}`, itemCount: count, published: true };
  }
  if (method === "PATCH" && seg[0] === "nav" && seg[1] === "sites" && seg.length === 3) {
    const slug = seg[2] ?? "";
    const body = (ctx.body ?? {}) as { template?: string };
    const s = db.sites.find((x) => x.slug === slug);
    if (s && body.template) s.template = body.template;
    if (db.siteDetail[slug] && body.template) db.siteDetail[slug].template = body.template;
    return { ok: true };
  }
  if (method === "POST" && seg[0] === "nav" && seg[1] === "sites" && seg[3] === "unpublish") {
    const slug = seg[2] ?? "";
    const s = db.sites.find((x) => x.slug === slug);
    if (s) s.published = 0;
    if (db.siteDetail[slug]) db.siteDetail[slug].published = 0;
    return { ok: true };
  }

  // ---------- 设置 ----------
  if (method === "POST" && path === "/settings/providers") {
    const body = (ctx.body ?? {}) as {
      id?: string;
      providerId: string;
      baseUrl: string;
      purposeModels?: ProviderConfigRow["purpose_models"];
    };
    if (body.id) {
      const r = db.providers.find((x) => x.id === body.id);
      if (r) {
        r.provider_id = body.providerId;
        r.base_url = body.baseUrl;
        if (body.purposeModels) r.purpose_models = body.purposeModels;
        return r;
      }
    }
    const row: ProviderConfigRow = {
      id: nid("prov"),
      provider_id: body.providerId,
      base_url: body.baseUrl,
      api_key: "********",
      has_key: true,
      purpose_models: body.purposeModels ?? {},
      enabled: 1,
      created_at: now(),
    };
    db.providers.push(row);
    return row;
  }
  if (method === "POST" && seg[0] === "settings" && seg[1] === "providers" && seg[2] === "test") {
    return { ok: true, sample: "（演示模式）你好，模型连接正常。" };
  }
  if (method === "POST" && path === "/privacy/rules") {
    const body = (ctx.body ?? {}) as { add?: string[]; remove?: string[] };
    if (body.add) db.privacy = [...new Set([...db.privacy, ...body.add])];
    if (body.remove) db.privacy = db.privacy.filter((p) => !body.remove!.includes(p));
    return { patterns: [...db.privacy], purged: body.remove ? { bookmarks: 0, snapshots: 0 } : null };
  }

  // ---------- 认证 / 导入 ----------
  if (method === "POST" && path === "/auth/logout") return { ok: true };
  if (method === "DELETE" && seg[0] === "auth" && seg[1] === "tokens" && seg.length === 3) {
    db.tokens = db.tokens.filter((t) => t.token_id !== seg[2]);
    return { ok: true };
  }
  if (method === "POST" && path === "/import/json") {
    const body = ctx.body as { bookmarks?: unknown[] } | null;
    const n = Array.isArray(body?.bookmarks) ? body.bookmarks.length : 12;
    return { restored: n, skipped: 0 };
  }
  if (method === "POST" && path === "/bookmarks/ingest/html") {
    const n = (ctx.html?.match(/<a\s/g) ?? []).length || 18;
    return { imported: n, skipped_duplicate: 2 };
  }
  return undefined;
}

interface BookmarkDetailLike {
  cache?: { l1_summary?: string | null; l1_tags?: string[]; fail_reason?: string | null } | null;
}

/** 免登录根路由（登录 / 首启设置）——演示模式任意密码可进 */
export function mockRootPost(path: string, body: unknown): unknown {
  if (path === "/auth/login") {
    const password = (body as { password?: string })?.password ?? "";
    if (!password) return { error: "密码不能为空" };
    return { token: "mock-token-demo", tokenId: "tok-demo" };
  }
  if (path === "/api/v1/admin/setup") return { token: "mock-token-demo" };
  return { error: "未知的演示路由" };
}

/** 导出类接口：返回真实 blob，可下载打开 */
export function mockBlob(path: string): Blob {
  const p = path.split("?")[0] ?? "";
  if (p.endsWith("/export/json")) {
    const payload = { exported_at: now(), version: "mock", folders: db.folders, bookmarks: db.bookmarks };
    return new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  }
  const rows = db.bookmarks.map((b) => `<DT><A HREF="${b.url_canonical}">${b.title}</A>`).join("\n");
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${rows}\n</DL><p>`;
  return new Blob([html], { type: "text/html" });
}

/** 死链检测 SSE 的演示版：逐条推送，节奏接近真实 */
export async function* mockLinkCheckStream(
  limit: number,
): AsyncGenerator<{ event: "start" | "item" | "done" | "error"; data: Record<string, unknown> }> {
  const targets = db.bookmarks.filter((b) => b.status !== "archived").slice(0, limit);
  await sleep(400);
  yield { event: "start", data: { total: targets.length } };
  let dead = 0;
  let suspect = 0;
  let normal = 0;
  for (let i = 0; i < targets.length; i++) {
    const b = targets[i]!;
    await sleep(160 + Math.random() * 300);
    let verdict: "normal" | "suspect" | "dead" = "normal";
    if (b.status === "dead") verdict = "dead";
    else if (cacheFail(b)?.startsWith("403")) verdict = "suspect";
    else if (Math.random() < 0.06) verdict = "suspect";
    if (verdict === "dead") dead++;
    else if (verdict === "suspect") suspect++;
    else normal++;
    yield { event: "item", data: { i, title: b.title, host: hostOf(b.url_canonical), verdict, total: targets.length } };
  }
  yield { event: "done", data: { checked: targets.length, dead, suspect, normal } };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 供连接状态展示 */
export const MOCK_SERVER_INFO = { ok: true, form: "demo", version: "0.3.2-mock" };
