/**
 * URL 规范化 —— 查重键（url_canonical UNIQUE）与相似提示的基础。
 *
 * DEV-13（2026-11-18）保守化改版（规则版本 2）：
 *  - 查重键只承担"同一页面"语义，不再改写 URL 本身：
 *    保留原 scheme（http 不再强制升级 https）、保留 www、保留 fragment（SPA hash 路由
 *    `#/a` 与 `#/b` 是不同页面）、保留非默认端口、保留业务/签名参数。
 *  - 只删除已验证的纯广告点击 tracking 参数（utm_* / 各广告平台 click id）；
 *    不再全局删除 ref / ref_src / share_token / st / si —— 这些在部分站点承担业务语义。
 *  - 相似提示（similarKey）：去 scheme、去 www、去 fragment 的宽松形态，仅供
 *    查重建议（maintain duplicate scan）参考，永不作为自动合并或打开地址的依据。
 *  - 打开/抓取地址一律使用 raw URL（原始书签 URL），见 apps/server 路由审计。
 *
 * 历史兼容：规则版本 1（旧行为）的存量键由 server 迁移 v4 用 raw 重算并出报告。
 */

/** 规则版本：键规则变更时 +1（bookmarks.url_key_version 记录每行使用版本） */
export const URL_KEY_RULES_VERSION = 2;

/** 已验证的纯 tracking 参数（只删这些；白名单外一律保留——保守优先） */
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
  "utm_reader",
  "utm_social",
  "utm_name",
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
  "ttclid",
  "yclid",
  "msclkid",
  "spm",
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
  /** 精确查重键（UNIQUE 约束用；不承担网络打开语义） */
  canonical: string;
  /** 小写 host（保留 www） */
  domain: string;
  registrableDomain: string;
  /** 规则版本（当前 URL_KEY_RULES_VERSION） */
  rulesVersion: number;
  /** 相似提示键：去 scheme/www/hash。仅用于"疑似重复"建议，不用于自动合并 */
  similarKey: string;
  /** 被移除的纯 tracking 参数名（解释性） */
  droppedParams?: string[];
}

export function canonicalizeUrl(raw: string): CanonicalUrlResult | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)) return null;

  // 协议保留原样（仅小写）。不同 scheme 可能指向不同服务（如 http 内网设备管理页）。
  // 域名小写；保留 www（www.example.com 与 example.com 可能是不同站点）。
  url.protocol = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  // hostname setter 会做 IDN 处理，直接赋小写值
  url.hostname = host;
  // 剥离 userinfo（user:pass@）：凭据不是页面身份——带凭据与不带凭据是同一查重键，
  // 且凭据绝不进库/进 API 回显（raw URL 原样保留在 url_raw 供打开）
  url.username = "";
  url.password = "";

  // 只删已验证 tracking 参数
  const dropped: string[] = [];
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      dropped.push(key);
      url.searchParams.delete(key);
    }
  }

  // 路径：编码归一 + 末斜杠去除（根路径保留）
  url.pathname = normalizeEncoding(url.pathname).replace(/\/+$/, "") || "/";

  // fragment 保留：SPA hash 路由（#/a vs #/b）是不同页面，锚点保守保留不误吞

  // 相似提示键：去 scheme、去 www、去 hash
  let similar: URL;
  try {
    similar = new URL(url.toString());
  } catch {
    return null; // 理论不可达（url 已构造成功）
  }
  similar.hash = "";
  let similarHost = similar.hostname;
  if (similarHost.startsWith("www.")) similarHost = similarHost.slice(4);
  const similarKey = `${similarHost}${similar.pathname}${similar.search}`;

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
    rulesVersion: URL_KEY_RULES_VERSION,
    similarKey,
    ...(dropped.length > 0 ? { droppedParams: dropped } : {}),
  };
}
