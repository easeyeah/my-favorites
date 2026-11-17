/** 隐私规则本地缓存与同步（A1-2）：捕获前的强制前置层 */
import { browser } from "wxt/browser";
import { api } from "./api";
import {
  builtinPrivacyRules,
  checkPrivacy,
  type PrivacyDecision,
  type PrivacyRules,
} from "@mf/shared";

const RULES_STORAGE_KEY = "privacyRules";
/** 服务端规则修订版本号缓存键（检测同步失效） */
const RULES_REV_KEY = "privacyRulesRevision";
/** 本地规则最长有效期：超时未刷新 = 同步失效 → 用内置清单兜底并记录 */
const RULES_MAX_AGE_MS = 24 * 3600_000;

interface StoredRules {
  rules: PrivacyRules;
  syncedAt: number;
}

/** 读取本地隐私规则；未加载/过期/损坏 → 内置清单（revision 0，保守可用） */
export async function loadLocalPrivacyRules(): Promise<PrivacyRules> {
  try {
    const stored = (await browser.storage.local.get(RULES_STORAGE_KEY))[RULES_STORAGE_KEY] as
      | StoredRules
      | undefined;
    if (
      stored?.rules &&
      Array.isArray(stored.rules.patterns) &&
      typeof stored.rules.revision === "number" &&
      Date.now() - stored.syncedAt < RULES_MAX_AGE_MS
    ) {
      return stored.rules;
    }
  } catch {
    // storage 异常 → 内置兜底
  }
  return builtinPrivacyRules();
}

/** 从服务端拉取最新规则并落本地（登录/启动/设置变更时调用） */
export async function syncPrivacyRules(): Promise<PrivacyRules> {
  try {
    const remote = await api<{ patterns: string[]; revision: number }>("/privacy/rules", {});
    const rules: PrivacyRules = {
      patterns: remote.patterns?.length ? remote.patterns : builtinPrivacyRules().patterns,
      revision: remote.revision ?? 0,
    };
    await browser.storage.local.set({
      [RULES_STORAGE_KEY]: { rules, syncedAt: Date.now() } satisfies StoredRules,
      [RULES_REV_KEY]: rules.revision,
    });
    return rules;
  } catch {
    // 服务端不可达：保留现有本地规则（loadLocalPrivacyRules 的过期逻辑兜底）
    return loadLocalPrivacyRules();
  }
}

/**
 * 判定辅助：捕获流程统一入口。
 * 规则未加载 → policy_not_loaded（保守禁止敏感动作，绝不先读后检）。
 */
export async function decidePrivacy(
  action: Parameters<typeof checkPrivacy>[0],
  url: string,
  opts?: { isPrivateBookmark?: boolean },
): Promise<PrivacyDecision> {
  const rules = await loadLocalPrivacyRules();
  return checkPrivacy(action, url, rules, opts);
}
