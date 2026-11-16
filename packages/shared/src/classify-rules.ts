/**
 * 域名分类规则引擎（技术方案 §5.2 阶段1 / F1.4 即时归位 / F1.5 收件箱初判）
 *
 * 设计：纯确定性、零 LLM 成本、<50ms。域名→类目映射冷启动仅需几十条常见站点，
 * 规则版准确率目标 60–70%，内容级精修由阶段2（LLM）兜底。
 */

export interface RuleResult {
  category: string;
  confidence: number;
  /** 规则来源：domain_map=域名映射，keyword=标题关键词，none=未命中 */
  source: "domain_map" | "keyword" | "none";
}

/** 域名 → 类目（registrableDomain 级别；维护原则：只收录高置信度的知名站点） */
const DOMAIN_MAP: Record<string, string> = {
  // 开发
  "github.com": "开发",
  "gitlab.com": "开发",
  "stackoverflow.com": "开发",
  "developer.mozilla.org": "开发",
  "npmjs.com": "开发",
  "vercel.com": "开发",
  "cloudflare.com": "开发",
  "rust-lang.org": "开发",
  "golang.org": "开发",
  "python.org": "开发",
  "nodejs.org": "开发",
  // 设计
  "figma.com": "设计",
  "dribbble.com": "设计",
  "behance.net": "设计",
  "awwwards.com": "设计",
  // 视频/娱乐
  "youtube.com": "视频",
  "bilibili.com": "视频",
  "iqiyi.com": "视频",
  "douyin.com": "视频",
  "netflix.com": "视频",
  // 阅读/学习
  "wikipedia.org": "阅读",
  "zhihu.com": "阅读",
  "juejin.cn": "阅读",
  "medium.com": "阅读",
  "fewiki.com": "阅读",
  "notion.so": "工具",
  // 社交
  "twitter.com": "社交",
  "x.com": "社交",
  "weibo.com": "社交",
  "reddit.com": "社交",
  "v2ex.com": "社交",
  // 购物
  "taobao.com": "购物",
  "jd.com": "购物",
  "amazon.com": "购物",
  "smzdm.com": "购物",
  // 工具
  "canva.com": "工具",
  "excalidraw.com": "工具",
};

/** 标题关键词 → 类目（次级信号，置信度低于域名映射） */
const KEYWORD_RULES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /教程|指南| handbook|guide|tutorial/i, category: "学习" },
  { pattern: /文档|docs|documentation|api reference/i, category: "文档" },
  { pattern: /博客|blog|article/i, category: "阅读" },
  { pattern: /工具|tool|converter|generator/i, category: "工具" },
];

export function classifyByRules(
  registrableDomain: string,
  title: string,
): RuleResult {
  const byDomain = DOMAIN_MAP[registrableDomain];
  if (byDomain) return { category: byDomain, confidence: 0.85, source: "domain_map" };

  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(title)) {
      return { category: rule.category, confidence: 0.6, source: "keyword" };
    }
  }
  return { category: "未分类", confidence: 0.3, source: "none" };
}

/**
 * 收件箱流水线阈值（技术方案 §6.1）：
 * ≥ CONFident AUTO = 自动归位；否则留在收件箱（永不丢书签）
 */
export const AUTO_MOVE_CONFIDENCE = 0.8;
