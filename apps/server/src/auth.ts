/**
 * 自建端鉴权（F6.2）：设置 ADMIN_PASSWORD 后所有 /api/v1 需要 Bearer token。
 * /healthz、/s/*（公开导航页）保持公开。未设置密码 = 无鉴权（本地开发/测试）。
 * DEV-05：令牌只存摘要（registry.resolveToken 校验），支持到期/撤销/last_used。
 * D67：令牌归属用户——中间件统一在 security.ts mountTokenAuth（解析后 runAsUser
 * 建立请求上下文：自建恒 self=主库，云端路由到用户数据文件）。
 */
import { timingSafeEqual } from "node:crypto";
import type { Registry } from "./registry";
import { SELF_USER_ID } from "./tenancy";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function authEnabled(adminPassword: string | undefined): boolean {
  return Boolean(adminPassword && adminPassword.length > 0);
}

export function login(
  registry: Registry,
  adminPassword: string | undefined,
  password: string,
  label: string,
): { token: string; tokenId: string } | { error: string } {
  if (!authEnabled(adminPassword) || !adminPassword) return { error: "auth_disabled" };
  if (!safeEqual(password, adminPassword)) return { error: "invalid_password" };
  // DEV-05：原值只在本响应出现一次；库内仅摘要（默认 30 天到期）。
  // tokenId 为非密随机 ID，客户端可保存用于在令牌列表中识别本设备。
  const created = registry.createToken(SELF_USER_ID, label);
  return { token: created.token, tokenId: created.tokenId };
}
