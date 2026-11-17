/**
 * 隐私策略引擎（A1-1，2026-11-17）
 *
 * 显式策略判定入口——不再只依赖分类函数的副作用（AGENTS.md 红线 2 的强制路径）。
 * 分别控制五个动作：读取正文 / 上传正文 / 调用模型 / 服务端抓取 / 页面快照。
 * 返回允许/禁止结果及可解释原因；规则未加载/判断异常时保守降级为仅元数据。
 */

/** 五个受控动作 */
export type PrivacyAction =
  | "read_content" // 设备端读取页面正文（executeScript/DOM 提取）
  | "upload_content" // 上传正文/摘要/向量到服务端
  | "call_model" // 将内容发给 LLM 供应商
  | "server_fetch" // 服务端抓取原站（crawl/死链探测的正文获取面）
  | "snapshot"; // 页面快照（captureMHTML + 上传存储）

export interface PrivacyDecision {
  action: PrivacyAction;
  allowed: boolean;
  /** 机器可读原因码 */
  reason:
    | "ok" // 明确允许
    | "privacy_domain" // 命中隐私域名规则
    | "private_bookmark" // 书签被标记为私密
    | "policy_not_loaded" // 规则未加载/同步失效——保守禁止
    | "policy_error"; // 判定过程异常——保守禁止
  /** 人类可读解释（界面/日志展示，不含 URL 与正文） */
  explanation: string;
  /** 评估所依据的规则修订版本（用户自定义规则同步用） */
  rulesRevision: number;
}

export interface PrivacyRules {
  /** 隐私域名 pattern 列表（与 privacy_domain 表同步） */
  patterns: string[];
  /** 规则修订版本：每次用户改规则 +1；扩展端据此检测同步失效 */
  revision: number;
}

/** 内置默认规则（离线兜底：扩展本地至少有内置清单） */
export function builtinPrivacyRules(): PrivacyRules {
  return {
    patterns: ["*.bank", "*.local", "localhost", "127.0.0.1", "icloud.com", "alipay.com", "tenpay.com"],
    revision: 0,
  };
}

const EXPLANATIONS: Record<PrivacyDecision["reason"], string> = {
  ok: "允许：未命中隐私规则",
  privacy_domain: "禁止：命中隐私域名规则，内容不离开本设备（仅保留标题与地址）",
  private_bookmark: "禁止：该书签已标记为私密，不读取/上传正文、不调用模型",
  policy_not_loaded: "禁止：隐私规则尚未加载或已失效，保守降级为仅元数据",
  policy_error: "禁止：隐私判定过程出错，保守降级为仅元数据",
};

function decide(
  action: PrivacyAction,
  reason: PrivacyDecision["reason"],
  rulesRevision: number,
): PrivacyDecision {
  return {
    action,
    allowed: reason === "ok",
    reason,
    explanation: EXPLANATIONS[reason],
    rulesRevision,
  };
}

/**
 * 统一策略判定入口。
 * @param action 受控动作
 * @param url 目标 URL（原始或 canonical 均可）
 * @param rules 已加载的规则；null/undefined = 未加载（保守禁止敏感动作）
 * @param opts.isPrivateBookmark 书签是否被用户标记私密（私密 → 内容类动作全禁）
 *
 * 判定顺序（保守优先）：
 *  1. 规则未加载 → 敏感动作禁止（policy_not_loaded）
 *  2. 书签私密 → 除 server_fetch 外全禁（私密书签也不允许服务端抓取，此处同样禁止）
 *  3. 命中隐私域名 → 全部五个动作禁止
 *  4. 其余允许
 * 任何内部异常 → policy_error 禁止（不因异常放行）。
 */
export function checkPrivacy(
  action: PrivacyAction,
  url: string,
  rules: PrivacyRules | null | undefined,
  opts: { isPrivateBookmark?: boolean } = {},
): PrivacyDecision {
  try {
    if (!rules) return decide(action, "policy_not_loaded", 0);

    if (opts.isPrivateBookmark) {
      return decide(action, "private_bookmark", rules.revision);
    }

    if (isPrivacyDomainUrl(url, rules.patterns)) {
      return decide(action, "privacy_domain", rules.revision);
    }
    return decide(action, "ok", rules.revision);
  } catch {
    return decide(action, "policy_error", 0);
  }
}

/** 域名匹配（与现有 isPrivacyDomain 语义一致，独立实现避免循环依赖） */
export function isPrivacyDomainUrl(url: string, patterns: string[]): boolean {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return true; // 解析不了的 URL 按隐私处理（保守）
  }
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith("*.")) return host.endsWith(p.slice(1));
    return host === p || host.endsWith(`.${p}`);
  });
}

/**
 * 批量预判：一次 URL 解析产出全部五个动作的决策（扩展捕获流程用）。
 * 语义与逐个 checkPrivacy 完全一致。
 */
export function checkAllPrivacy(
  url: string,
  rules: PrivacyRules | null | undefined,
  opts: { isPrivateBookmark?: boolean } = {},
): Record<PrivacyAction, PrivacyDecision> {
  const actions: PrivacyAction[] = ["read_content", "upload_content", "call_model", "server_fetch", "snapshot"];
  return Object.fromEntries(
    actions.map((a) => [a, checkPrivacy(a, url, rules, opts)]),
  ) as Record<PrivacyAction, PrivacyDecision>;
}
