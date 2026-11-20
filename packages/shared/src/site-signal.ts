/**
 * 站点化分析 · 规则信号（D30/D31，切片 B）
 *
 * 三类判定（零 LLM 成本先行，AI 信号在服务端基于 L1 摘要叠加）：
 *  - site_tool  官网 / 工具 / 服务类站点（首页 · 主页面）→ 进入导航
 *  - site_ref   资料类站点（文档 / wiki / 教程首页）→ 默认不入导航（D31，书签库保留）
 *  - content    内容页（文章 / 详情 / 商品）→ 保留在书签库，同域多篇归并为一个站点卡
 *
 * 设计约束：
 *  - 纯确定性、<50ms；与 URL 规范化共用 canonical 的 host/registrableDomain；
 *  - 信号全部可解释（signals 数组），管理台「看名单/看明细」直接展示；
 *  - 深层文档页（如某篇指南）完全不入、也不提示建卡（D37 收口）。
 */
import type { CanonicalUrlResult } from "./url";

export type SiteKind = "site_tool" | "site_ref" | "content";

export interface SiteSignal {
  kind: SiteKind;
  confidence: number;
  /** 可解释信号（管理台名单展示用） */
  signals: string[];
  registrableDomain: string;
  /** 是否站点根/近根（0–1 段路径）——同站归并时优先作为站点卡入口 */
  isNearRoot: boolean;
}

/** 内容页路径模式：文章 / 详情 / 商品 / UGC 常见 URL 形态 */
const CONTENT_PATH_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\/(p|post|posts|article|articles|blog|entry|questions|question|item|detail|details|view|thread|status|watch|pin)\/[^/]+/i, label: "文章/详情路径" },
  { re: /\/(zhinan|gonglue|news|listing)\//, label: "内容频道路径" },
  { re: /\/(20\d{2})\/(0[1-9]|1[0-2])\//, label: "日期路径" },
  { re: /github\.com\/[^/]+\/[^/]+\/(blob|tree|commit|issues|pull)\//i, label: "GitHub 内容页" },
  { re: /\/(dp|gp|product)\/[A-Z0-9]{10}(\/|$)/, label: "商品详情" },
  { re: /\/[a-z0-9]{16,}(\/|$)/i, label: "长 ID 路径" },
  { re: /\/(zh-cn|en-us|zh|en)\/(blog|articles?)\//i, label: "本地化文章路径" },
];

/** 资料站信号：文档 / wiki / 教程首页（域名或路径形态） */
const REF_HOST_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /^(docs?|developer|developers|learn|wiki|guide|manual|book|doc)\./i, label: "docs/developer 子域" },
  { re: /\.(readthedocs\.io|readthedocs\.org|gitbook\.io|gitbook\.com|github\.io|wikimedia\.org|wikipedia\.org)$/i, label: "文档托管域" },
];

const REF_PATH_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\/(docs?|documentation|wiki|guide|guides|tutorial|tutorials|manual|reference|api|learn|book)\b/i, label: "文档路径段" },
];

/** 已知内容平台（二级域即内容页，首页归并到主域） */
const CONTENT_SUBDOMAINS: Array<{ re: RegExp; label: string }> = [
  { re: /^(zhuanlan|zhidao)\.zhihu\.com$/i, label: "知乎专栏" },
  { re: /^juejin\.cn$/i, label: "掘金文章" },
  { re: /^mp\.weixin\.qq\.com$/i, label: "公众号文章" },
  { re: /^medium\.com$/i, label: "Medium 文章" },
  { re: /^blog\.csdn\.net$/i, label: "CSDN 文章" },
  { re: /^segmentfault\.com$/i, label: "思否文章" },
];

/** 已知工具/官网白名单（命中即 site_tool，高置信） */
const TOOL_DOMAINS = new Set([
  "github.com", "gitlab.com", "figma.com", "canva.com", "excalidraw.com",
  "notion.so", "vercel.com", "netlify.com", "cloudflare.com", "npmjs.com",
  "caniuse.com", "regex101.com", "translate.google.com", "maps.google.com",
  "taobao.com", "jd.com", "smzdm.com", "v2ex.com",
]);

function pathDepth(pathname: string): number {
  const segs = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  return segs.length;
}

/** 判定单条书签的站点信号（规则信号，零成本） */
export function classifySiteSignal(url: string): SiteSignal | null {
  const parsed = /^https?:\/\//i.test(url) ? safeParse(url) : null;
  if (!parsed) return null;
  const host = parsed.domain.toLowerCase();
  const reg = parsed.registrableDomain.toLowerCase();
  const path = new URL(parsed.canonical).pathname;
  const depth = pathDepth(path);
  const signals: string[] = [];

  // ① 内容页路径模式（最强信号）
  for (const { re, label } of CONTENT_PATH_PATTERNS) {
    if (re.test(url)) {
      signals.push(label);
      break;
    }
  }
  for (const { re, label } of CONTENT_SUBDOMAINS) {
    if (label && re.test(host) && depth >= 1) {
      signals.push(label);
      break;
    }
  }
  const isGithubContent = /github\.com$/i.test(reg) && /\/(blob|tree|commit|issues|pull)\//.test(path);
  if (signals.length > 0 || isGithubContent) {
    return {
      kind: "content",
      confidence: 0.9,
      signals: isGithubContent && signals.length === 0 ? ["GitHub 内容页"] : signals,
      registrableDomain: reg,
      isNearRoot: false,
    };
  }

  // ② 资料站信号（docs/developer 子域、文档路径）——仅在近根时判资料站；
  //    深层文档页按内容页处理（D37：深层文档完全不入导航）
  const refHost = REF_HOST_PATTERNS.find(({ re, label }) => re.test(host));
  const refPath = REF_PATH_PATTERNS.find(({ re, label }) => re.test(path));
  if ((refHost || refPath) && depth <= 2) {
    return {
      kind: "site_ref",
      confidence: refHost ? 0.85 : 0.7,
      signals: [refHost?.label ?? "", refPath?.label ?? "文档路径段"].filter(Boolean),
      registrableDomain: reg,
      isNearRoot: depth <= 1,
    };
  }

  // ③ 工具/官网白名单
  if (TOOL_DOMAINS.has(reg)) {
    return { kind: "site_tool", confidence: 0.9, signals: ["已知工具/官网"], registrableDomain: reg, isNearRoot: depth <= 1 };
  }

  // ④ 兜底：近根（首页/单段路径）→ site_tool；深路径无内容特征 → content（保守，宁可不进导航）
  if (depth <= 1) {
    return { kind: "site_tool", confidence: 0.6, signals: ["站点根/近根"], registrableDomain: reg, isNearRoot: true };
  }
  return { kind: "content", confidence: 0.5, signals: ["深层路径"], registrableDomain: reg, isNearRoot: false };
}

function safeParse(url: string): CanonicalUrlResult | null {
  // 轻量解析：只取 host/registrableDomain/path（避免循环依赖 url.ts 之外的导出）
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const parts = host.split(".");
    // 粗略 registrableDomain：常见双段后缀兜底（与 url.ts 的精确表不一致也无妨——投影仅内部使用）
    const twoLevelTlds = /\.(co|com|net|org|gov|edu)\.[a-z]{2}$/i.test(host) ? 3 : 2;
    const registrableDomain = parts.length > twoLevelTlds ? parts.slice(-twoLevelTlds).join(".") : host;
    return {
      canonical: u.toString(),
      domain: host,
      registrableDomain,
      rulesVersion: 0,
      similarKey: "",
      droppedParams: [],
    } satisfies CanonicalUrlResult;
  } catch {
    return null;
  }
}

/** AI 信号叠加：基于 L1 摘要判三类（有缓存时修正规则信号） */
export function refineWithSummary(rule: SiteSignal, summary: string | null | undefined): SiteSignal {
  if (!summary) return rule;
  const s = summary.toLowerCase();
  if (/(文档|文档站|官方文档|api 参考|reference|wiki|教程首页|手册)/.test(s) && rule.kind === "site_tool") {
    return { ...rule, kind: "site_ref", confidence: 0.8, signals: [...rule.signals, "AI 摘要:文档站"] };
  }
  if (/(文章|博客|教程|笔记|评测|分享了一|记录了一|介绍了)/.test(s) && rule.kind !== "content") {
    return { ...rule, kind: "content", confidence: 0.75, signals: [...rule.signals, "AI 摘要:文章/教程"] };
  }
  return rule;
}
