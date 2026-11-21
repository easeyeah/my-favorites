/**
 * D43 敏感宿主启发式判定（2026-11-20 立项）
 *
 * 产品立场：不做道德判断，只做工程规避——**不外发、不误伤功能、不误发布**。
 * 用途（三道防线的前两道）：
 *  1. 整理建批前命中项不进 LLM 批次（供应商审核是整包拒收，一颗毒丸废掉整次整理）；
 *  2. 「敏感内容旁路」功能点据此全库标私密；
 *  3. 后漏项由 organize 的事后二分隔离兜底（错误码识别见 @mf/ai isLlmContentModeration）。
 *
 * 词表原则（纯数据、可审计）：
 *  - 只收录通用词素 token，**不内置任何真实站点全名**；
 *  - 宁可漏判（漏判由事后二分隔离兜住），不可滥判——误伤代价 = 被误标私密，
 *    管理台「显示私密」可查、可逐条取消，全程可撤销；
 *  - 解析失败的 URL 返回 false：不可解析场景已被隐私门按保守处理覆盖（isPrivacyDomain）。
 */

/** 「私人收藏」目录名——旁路功能的投递目标（三端共用常量，避免文案漂移） */
export const PRIVATE_FOLDER_NAME = "私人收藏";

/**
 * host 任意位置包含即命中：这些词素在正规站点名里几乎不出现在词中，
 * 子串匹配误伤概率可忽略（xxx 三连字符正常域名不会出现）。
 */
const HOST_CONTAINS_TOKENS = [
  "porn",
  "hentai",
  "xxx",
  "nsfw",
  "eroge",
  "nude",
  "naked",
  "sext",
  "fuck",
  "fetish",
];

/**
 * 仅当 host 的某个点分标签**以词素开头**才命中：sex/jav 类短词做子串会误伤
 * （essex、javascript），限定前缀后假阳性大幅收窄。
 * jav 额外排除 java 前缀——javascript/javadev 类开发者域名不是敏感站。
 */
const LABEL_PREFIX_TOKENS = ["sex", "jav", "nude", "porn"];
const LABEL_PREFIX_EXCLUDE: Record<string, string> = { jav: "java" };

/** 成人专用顶级域（注册即表明用途，直接按后缀命中） */
const SENSITIVE_TLDS = [".xxx", ".porn", ".adult", ".sex"];

function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null; // 解析失败交由隐私门保守处理，本函数不判
  }
}

/** host 是否命中敏感宿主启发式。纯本地字符串判定，零网络、零内容读取。 */
export function isSensitiveHost(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (SENSITIVE_TLDS.some((tld) => host.endsWith(tld))) return true;
  if (HOST_CONTAINS_TOKENS.some((token) => host.includes(token))) return true;
  return host.split(".").some((label) =>
    LABEL_PREFIX_TOKENS.some((token) => {
      const excluded = LABEL_PREFIX_EXCLUDE[token];
      if (excluded && label.startsWith(excluded)) return false;
      return label.startsWith(token);
    }),
  );
}
