/**
 * 隐私规则本地缓存与同步（A1-2）：捕获前的强制前置层。
 * DEV-03（2026-11-18）失效策略修订：
 *  - 规则缓存显式状态：unknown（从未加载）/ fresh（已同步且未超期）/ stale（超期）/ error（损坏）；
 *  - 仅 fresh 允许敏感五动作；unknown/stale/error 一律 policy_not_loaded 保守拒绝
 *    （保留标题/URL 基础收藏，不读取正文/不上传/不调模型/不快照）；
 *  - 旧用户规则（stale）仍用于【拒绝】判定：命中旧隐私域即使 stale 也拒绝（不因过期放行）；
 *  - 规则缓存按服务端实例隔离：切换服务器/实例 → 状态按 stale 处理 → 重新同步前拒绝敏感动作
 *    （旧实例规则仍参与拒绝判定——保守方向，绝不因切实例而放行）。
 */
import { browser } from "wxt/browser";
import { api, getConfig } from "./api";
import {
  builtinPrivacyRules,
  checkPrivacy,
  type PrivacyDecision,
  type PrivacyRules,
} from "@mf/shared";

/** 规则缓存状态 */
export type PrivacyRulesStatus = "unknown" | "fresh" | "stale" | "error";

interface StoredRules {
  rules: PrivacyRules;
  syncedAt: number;
  /** 规则来源实例（api base origin），上下文隔离用 */
  instance: string;
}

/** 本地规则最长有效期：超时未刷新 = stale → 敏感动作拒绝 */
const RULES_MAX_AGE_MS = 24 * 3600_000;

async function apiOrigin(): Promise<string> {
  try {
    const { serverUrl } = await getConfig();
    return new URL(serverUrl).origin;
  } catch {
    return "unknown-instance";
  }
}

async function cachedKey(): Promise<string> {
  return `privacyRules:${await apiOrigin()}`;
}

/** 读取本地规则及其状态（不兜底放行——状态由调用方消费） */
async function loadCached(): Promise<{ rules: PrivacyRules | null; status: PrivacyRulesStatus }> {
  try {
    const key = await cachedKey();
    const stored = (await browser.storage.local.get(key))[key] as StoredRules | undefined;
    if (!stored) return { rules: null, status: "unknown" };
    if (
      !stored.rules ||
      !Array.isArray(stored.rules.patterns) ||
      typeof stored.rules.revision !== "number"
    ) {
      return { rules: null, status: "error" };
    }
    if (stored.instance !== (await apiOrigin())) return { rules: stored.rules, status: "stale" };
    if (Date.now() - stored.syncedAt >= RULES_MAX_AGE_MS) {
      return { rules: stored.rules, status: "stale" };
    }
    return { rules: stored.rules, status: "fresh" };
  } catch {
    return { rules: null, status: "error" };
  }
}

/** 从服务端拉取最新规则并落本地（登录/启动/设置变更时调用） */
export async function syncPrivacyRules(): Promise<PrivacyRules> {
  try {
    const remote = await api<{ patterns: string[]; revision: number }>("/privacy/rules", {});
    // 异常/空响应不得洗白为 fresh（内置项不可删，合法清单永不为空）：
    // 清除旧缓存 → 状态回 unknown → 敏感动作保守拒绝，绝不放行五动作
    if (!Array.isArray(remote.patterns) || remote.patterns.length === 0) {
      await browser.storage.local.remove(await cachedKey());
      return builtinPrivacyRules();
    }
    const rules: PrivacyRules = {
      patterns: remote.patterns,
      revision: typeof remote.revision === "number" ? remote.revision : 0,
    };
    await browser.storage.local.set({
      [await cachedKey()]: {
        rules,
        syncedAt: Date.now(),
        instance: await apiOrigin(),
      } satisfies StoredRules,
    });
    return rules;
  } catch {
    // 服务端不可达：保留现有本地缓存（状态按超期判定——stale 即拒绝）
    const cached = await loadCached();
    return cached.rules ?? builtinPrivacyRules();
  }
}

/**
 * 判定入口（DEV-03 失效策略）：
 *  - fresh：正常判定（命中隐私域/私密 → 拒绝；否则允许）；
 *  - unknown / error：全部敏感动作拒绝（policy_not_loaded）；
 *  - stale：先按【缓存的旧规则】做拒绝判定（命中 → privacy_domain 拒绝，不因过期放行），
 *    未命中也拒绝（policy_not_loaded）——宁可少整理，不可先读后传。
 */
export async function decidePrivacy(
  action: Parameters<typeof checkPrivacy>[0],
  url: string,
  opts?: { isPrivateBookmark?: boolean },
): Promise<PrivacyDecision> {
  const { rules, status } = await loadCached();
  if (status === "fresh" && rules) {
    return checkPrivacy(action, url, rules, opts);
  }
  if (rules) {
    // stale：旧规则仍可拒绝（命中即 privacy_domain）
    const deny = checkPrivacy(action, url, rules, opts);
    if (!deny.allowed) return deny;
  }
  return checkPrivacy(action, url, null, opts); // policy_not_loaded（保守拒绝）
}
