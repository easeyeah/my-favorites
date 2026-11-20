/**
 * DEV-01 导航站访问凭证：密码不再走查询参数（?p= 会进入日志/referrer/历史记录）。
 * POST 验证成功后签发短期 HMAC 凭证（HttpOnly Cookie），绑定 slug + revision + 过期时间：
 *  - 改密/重新发布/撤销发布 → revision bump → 旧凭证全部失效；
 *  - Cookie 限定 Path=/s/<slug>、HttpOnly、SameSite=Lax；https 部署加 Secure；
 *  - 密码验证与管理员登录分别限速（key 不同，见 app.ts /security.ts）。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store";

/** 凭证有效期：8 小时（短期，限定站点） */
const ACCESS_TTL_MS = 8 * 3600_000;

export const NAV_ACCESS_COOKIE = (slug: string): string => `mf_nav_${slug}`;

function hmacSecret(store: Store): string {
  const key = store.getSetting("nav_cookie_secret");
  if (key) return key;
  // 首次生成并持久化（重启后已发凭证不失效；不写日志/不下发前端）
  const generated = randomBytes(32).toString("hex");
  store.setSetting("nav_cookie_secret", generated);
  return generated;
}

export function signNavAccess(store: Store, slug: string, revision: number): string {
  const exp = Date.now() + ACCESS_TTL_MS;
  const payload = `${slug}|${revision}|${exp}`;
  const sig = createHmac("sha256", hmacSecret(store)).update(payload).digest("hex");
  return `${exp}|${sig}`;
}

export function verifyNavAccess(
  store: Store,
  slug: string,
  revision: number,
  value: string | undefined,
): boolean {
  if (!value) return false;
  const parts = value.split("|");
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  const sig = parts[1] ?? "";
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const payload = `${slug}|${revision}|${exp}`;
  const expected = createHmac("sha256", hmacSecret(store)).update(payload).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** Set-Cookie 值（手工拼装，避免依赖 cookie 库；https 判定由调用方传入 isSecure） */
export function navAccessCookieHeader(
  slug: string,
  value: string,
  isSecure: boolean,
): string {
  return [
    `${NAV_ACCESS_COOKIE(slug)}=${value}`,
    "Path=/s/" + slug,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(ACCESS_TTL_MS / 1000)}`,
    ...(isSecure ? ["Secure"] : []),
  ].join("; ");
}

export function navClearCookieHeader(slug: string): string {
  return `${NAV_ACCESS_COOKIE(slug)}=; Path=/s/${slug}; HttpOnly; SameSite=Lax; Max-Age=0`;
}
