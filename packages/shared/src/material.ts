/**
 * 收藏内容识别三级策略（D32，切片 D 升级为「切片 D·资料库」，D61）
 *
 * 三类判定（纯确定性规则，零成本，可解释）：
 *  - article  文章 → 条件入库：仅当已存全文（content_cache.l2_text）时显性化为资料条目
 *  - video    视频 → 无条件入库：仅元数据（封面/来源站），不下载视频本体（版权/审核/成本四重否决）
 *  - image    图片 → 无条件入库：主图 = URL 本体（服务端抓取动作落盘）
 *
 * 设计约束：与 site-signal 同风格——纯函数、信号可解释、保守判定
 * （识别不了的 URL 一律按 article 兜底，而 article 必须有全文才入库，不会误伤）。
 */

export type MaterialKind = "article" | "video" | "image";

export interface MaterialClassification {
  kind: MaterialKind;
  /** 可解释信号（资料库条目展示「为什么是这一类」） */
  signals: string[];
}

/** 图片直链：路径以图片扩展名结尾（query/hash 前判定） */
const IMAGE_PATH_RE = /\.(jpe?g|png|webp|gif|bmp|svg|avif|tiff?)(?:[?#]|$)/i;

/**
 * 视频站点模式：host 匹配 + 路径形态守卫（同站的频道页/首页不算视频）。
 * b23.tv 是哔哩哔哩短链域，任意路径都指向视频，不设路径守卫。
 */
const VIDEO_SITES: Array<{ host: RegExp; path?: RegExp; label: string }> = [
  { host: /(^|\.)youtube\.com$/i, path: /^\/(watch|shorts|embed)\b/i, label: "YouTube" },
  { host: /(^|\.)youtu\.be$/i, label: "YouTube" },
  { host: /(^|\.)bilibili\.com$/i, path: /^\/video\//i, label: "哔哩哔哩" },
  { host: /(^|\.)b23\.tv$/i, label: "哔哩哔哩" },
  { host: /(^|\.)ixigua\.com$/i, path: /^\/\d/i, label: "西瓜视频" },
  { host: /^v\.qq\.com$/i, path: /^\/x\/(cover|page)\//i, label: "腾讯视频" },
  { host: /(^|\.)iqiyi\.com$/i, path: /^\/v_/i, label: "爱奇艺" },
  { host: /(^|\.)youku\.com$/i, path: /^\/v_show\//i, label: "优酷" },
  { host: /(^|\.)vimeo\.com$/i, path: /^\/\d+/i, label: "Vimeo" },
  { host: /(^|\.)douyin\.com$/i, path: /^\/video\//i, label: "抖音" },
  { host: /(^|\.)mgtv\.com$/i, path: /^\/b\//i, label: "芒果TV" },
  { host: /(^|\.)ted\.com$/i, path: /^\/talks\//i, label: "TED" },
];

/** 文章「已存全文」入库阈值（content_cache.l2_text 字符数下限） */
export const MATERIAL_ARTICLE_MIN_TEXT = 200;

/** 判定单条收藏的内容形态（解析失败的 URL 返回 null，不入资料库） */
export function classifyMaterialKind(url: string): MaterialClassification | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  // ① 图片直链（最强形态信号）
  if (IMAGE_PATH_RE.test(path)) {
    return { kind: "image", signals: ["图片直链"] };
  }

  // ② 视频站点（host + 路径守卫，缺路径模式则任意路径命中）
  for (const { host: hre, path: pre, label } of VIDEO_SITES) {
    if (!hre.test(host)) continue;
    if (pre && !pre.test(path)) continue;
    return { kind: "video", signals: [label] };
  }

  // ③ 兜底 article：是否入库由调用方结合「已存全文」判定（此处不携带内容）
  return { kind: "article", signals: [] };
}
