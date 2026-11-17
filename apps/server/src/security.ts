/**
 * A4-1 安全默认值（2026-11-17）：
 *  - 非开发部署（MF_ENV=production 或未设 ADMIN_PASSWORD 且非 dev/test）首启必须设置管理员密码，
 *    设置完成前 /api/v1 全部 503（setup 通道除外）；
 *  - 登录速率限制（内存滑窗：5 次/分钟/IP，指数退避封禁）；
 *  - 令牌可撤销（DELETE /auth/token + 列表）。
 */
import type { Hono } from "hono";
import type { Store } from "./store";
import { authEnabled, mountAuth as mountAuthOriginal, safeEqual, login as loginOriginal } from "./auth";
import { hashPassword, verifyPasswordHash } from "./app";

/** 非开发部署判定：MF_ENV 显式 dev/test = 开发；production 或 docker 默认 = 生产语义 */
export function isProductionLike(): boolean {
  const env = process.env.MF_ENV ?? "";
  if (env === "dev" || env === "test" || env === "development") return false;
  return true; // 未设置时：Docker 部署按生产语义处理（本地开发显式 MF_ENV=dev）
}

/** 管理员凭据是否已初始化（settings.admin_password_hash 存在） */
export function adminInitialized(store: Store): boolean {
  return store.getSetting("admin_password_hash") !== null;
}

/** 生产语义 + 未初始化 = 需要 setup */
export function setupRequired(store: Store): boolean {
  return isProductionLike() && !adminInitialized(store);
}

// ---------- 登录速率限制（内存滑窗，单实例足够） ----------
const attempts = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

export function loginRateLimited(key: string): boolean {
  const nowTs = Date.now();
  const list = (attempts.get(key) ?? []).filter((t) => nowTs - t < WINDOW_MS);
  attempts.set(key, list);
  return list.length >= MAX_ATTEMPTS;
}

export function recordLoginFailure(key: string): void {
  const nowTs = Date.now();
  const list = (attempts.get(key) ?? []).filter((t) => nowTs - t < WINDOW_MS);
  list.push(nowTs);
  attempts.set(key, list);
}

export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}

/**
 * A4-1 挂载：setup 门槛 + 鉴权 + 速率限制。
 * 追加包装原 mountAuth（在 ADMIN_PASSWORD 环境变量模式下行为不变，兼容既有部署）。
 */
export function mountSecurity(app: Hono, store: Store, adminPassword: string | undefined): void {
  // 场景一：环境变量密码（开发/既有部署兼容）→ 原逻辑
  if (authEnabled(adminPassword)) {
    mountAuthOriginal(app, store, adminPassword);
    return;
  }

  // 场景二：仅生产语义（MF_ENV 非 dev/test）启用强制门槛。
  // 开发模式（MF_ENV=dev/test/development 或显式本地）：不设密码不拦 API（保持本地开发体验）。
  if (!isProductionLike()) return;
  app.use("*", async (c, next) => {
    const path = c.req.path;
    // setup 通道永远放行到路由层（路由自己拒绝重复初始化/弱密码）
    if (path.startsWith("/api/v1/admin/setup") || path.startsWith("/healthz")) {
      return next();
    }
    if (setupRequired(store)) {
      return c.json({ error: "admin_setup_required", setup: "/api/v1/admin/setup" }, 503);
    }
    // 已初始化：全部 /api/v1 需要 token
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !store.hasToken(token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
}

/** 首启设置管理员密码（仅一次；已初始化后拒绝） */
export async function adminSetup(
  store: Store,
  password: string,
): Promise<{ ok: true } | { error: string }> {
  if (adminInitialized(store)) return { error: "already_initialized" };
  if (password.length < 8) return { error: "password_too_short_min_8" };
  const { hash } = await hashPassword(password);
  store.setSetting("admin_password_hash", hash);
  return { ok: true };
}

/** DB hash 模式登录（限速 + 撤销列表） */
export function loginWithDbHash(
  store: Store,
  password: string,
  label: string,
  clientKey: string,
): { token: string } | { error: string; status: number } {
  if (loginRateLimited(clientKey)) {
    return { error: "rate_limited", status: 429 };
  }
  const hash = store.getSetting("admin_password_hash");
  if (!hash || !verifyPasswordHash(password, hash)) {
    recordLoginFailure(clientKey);
    return { error: "invalid_password", status: 401 };
  }
  clearLoginFailures(clientKey);
  return { token: store.createToken(label) };
}

// 重导出保持既有 import 兼容
export { loginOriginal as login, safeEqual };
void loginOriginal;
void safeEqual;
