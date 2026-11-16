/**
 * URL 规范化 —— 查重（F5.2）、唯一约束（url_canonical）、域名缓存（F1.4）的基础。
 * 规则（技术方案 §4）：去 tracking 参数、统一 https、统一末斜杠、小写域名。
 */

/** 常见 tracking 参数前缀与完整名单（维护原则：宁多勿漏，误杀参数不损伤页面功能） */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_source_platform",
  "utm_creative_format",
  "utm_marketing_tactic",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "igshid",
  "igsh",
  "si",
  "spm",
  "ttclid",
  "yclid",
  "msclkid",
  "ref",
  "ref_src",
  "ref_url",
  "referrer",
  "vbvid",
  "share_token",
  "st",
]);

/** 百分号编码差异不影响语义的字符（RFC 3986 unreserved） */
function normalizeEncoding(pathname: string): string {
  try {
    return encodeURI(decodeURI(pathname));
  } catch {
    return pathname;
  }
}

export interface CanonicalUrlResult {
  canonical: string;
  domain: string;
  registrableDomain: string;
}

/**
 * 生成规范化 URL。
 * - 协议统一为 https（本地地址与扩展页除外）
 * - 域名小写，www. 前缀去除
 * - 去除 tracking 参数
 * - 路径末斜杠统一去除（根路径除外）
 * - 去除 fragment（# 后内容不参与查重）
 */
export function canonicalizeUrl(raw: string): CanonicalUrlResult | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)) return null;

  // 协议统一：本地/内网地址保留原协议
  const isLocal =
    url.hostname === "localhost" ||
    /^(127|10)\./.test(url.hostname) ||
    /^192\.168\./.test(url.hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname);

  if (!isLocal) url.protocol = "https:";

  // 域名：小写 + 去 www
  let host = url.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  url.hostname = host;

  // 去除 tracking 参数
  const dropped: string[] = [];
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      dropped.push(key);
      url.searchParams.delete(key);
    }
  }

  // 路径：编码归一 + 末斜杠去除
  url.pathname = normalizeEncoding(url.pathname).replace(/\/+$/, "") || "/";

  // fragment 不参与查重
  url.hash = "";

  // registrableDomain：取末两级（对 co.uk 等多级后缀做常见表处理，不引入依赖）
  const parts = host.split(".");
  const secondLevelTlds = new Set([
    "co.uk",
    "org.uk",
    "gov.uk",
    "com.cn",
    "net.cn",
    "org.cn",
    "gov.cn",
    "co.jp",
    "com.au",
    "co.nz",
    "com.hk",
    "com.tw",
  ]);
  const registrableDomain =
    parts.length > 2 && secondLevelTlds.has(parts.slice(-2).join("."))
      ? parts.slice(-3).join(".")
      : parts.slice(-2).join(".");

  return {
    canonical: url.toString(),
    domain: host,
    registrableDomain,
    ...(dropped.length > 0 ? { _droppedParams: dropped } : {}),
  } as CanonicalUrlResult & { _droppedParams?: string[] };
}
