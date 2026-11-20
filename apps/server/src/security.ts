/**
 * A4-1 安全默认值（2026-11-17）+ DEV-05（2026-11-18）：
 *  - 非开发部署首启必须设置管理员密码，设置完成前 /api/v1 全部 503（setup 通道除外）；
 *  - setup 需要部署引导凭据（MF_SETUP_TOKEN env 或 dataDir/bootstrap-token.txt），
 *    防止暴露端口后任何人抢先设管理员；初始化原子幂等（并发 setup 至多一个成功）；
 *  - 登录速率限制（内存滑窗：5 次/分钟/key，key 区分 admin 模式与导航站 slug）；
 *  - 令牌摘要存储、到期、撤销（见 store.ts / auth.ts）。
 */
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Hono } from "hono";
import type { Store } from "./store";
import { authEnabled, mountAuth as mountAuthOriginal, safeEqual, login as loginOriginal } from "./auth";
import { hashPassword, verifyPasswordHash } from "./password";

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

// ---------- 登录速率限制（内存滑窗，单实例足够；key 由调用方按场景前缀区分） ----------
const attempts = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
/** 上限保护 + 过期清理：防无界内存增长 */
const MAX_KEYS = 10_000;

export function loginRateLimited(key: string): boolean {
  const nowTs = Date.now();
  const list = (attempts.get(key) ?? []).filter((t) => nowTs - t < WINDOW_MS);
  if (attempts.size > MAX_KEYS) {
    for (const [k, v] of attempts) {
      if (v.every((t) => nowTs - t >= WINDOW_MS)) attempts.delete(k);
      if (attempts.size <= MAX_KEYS / 2) break;
    }
  }
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

// ---------- DEV-05 首启引导凭据 ----------
const BOOTSTRAP_KEY = "setup_bootstrap_token";

/**
 * 引导凭据来源优先级：
 *  1. MF_SETUP_TOKEN env（部署方显式注入；不落盘）；
 *  2. settings 内已生成的凭据（进程重启后保持一致）；
 *  3. 首次生成随机凭据并写入 dataDir/bootstrap-token.txt（权限 600）——
 *     日志只提示文件路径，不打印凭据本身（凭据不进 URL/公共日志）。
 * 仅生产语义（isProductionLike）调用；dev/test 保持免凭据（本地开发体验）。
 */
export function ensureBootstrapToken(store: Store, dataDir: string): string {
  const envToken = process.env.MF_SETUP_TOKEN;
  if (envToken && envToken.length > 0) return envToken;
  const existing = store.getSetting(BOOTSTRAP_KEY);
  if (existing) return existing;
  const generated = randomBytes(24).toString("base64url");
  store.setSetting(BOOTSTRAP_KEY, generated);
  try {
    const file = path.join(dataDir, "bootstrap-token.txt");
    writeFileSync(file, generated + "\n", { mode: 0o600 });
    console.log(`[security] 首启引导凭据已写入 ${file}（setup 时以 x-mf-setup-token 头携带；设置密码后自动失效）`);
  } catch {
    console.log("[security] 引导凭据已生成但写入文件失败，可从数据库 settings 表读取（MF_SETUP_TOKEN 亦可显式注入）");
  }
  return generated;
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
    const pathName = c.req.path;
    // setup 通道永远放行到路由层（路由自己校验引导凭据/拒绝重复初始化/弱密码）
    if (pathName.startsWith("/api/v1/admin/setup") || pathName.startsWith("/healthz")) {
      return next();
    }
    if (setupRequired(store)) {
      return c.json({ error: "admin_setup_required", setup: "/api/v1/admin/setup" }, 503);
    }
    // 已初始化：全部 /api/v1 需要 token（摘要校验 + 未撤销 + 未过期）
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !store.hasToken(token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
}

/**
 * 首启设置管理员密码（仅一次；原子幂等）。
 * DEV-05：生产语义要求引导凭据（header x-mf-setup-token）；并发 setup 至多一个成功。
 */
export async function adminSetup(
  store: Store,
  password: string,
  bootstrapToken: string,
  dataDir: string,
): Promise<{ ok: true } | { error: string }> {
  if (adminInitialized(store)) return { error: "already_initialized" };
  if (password.length < 8) return { error: "password_too_short_min_8" };
  if (isProductionLike()) {
    const expected = ensureBootstrapToken(store, dataDir);
    if (!bootstrapToken || !safeEqual(bootstrapToken, expected)) {
      return { error: "setup_token_required" };
    }
  }
  const { hash } = await hashPassword(password);
  // 原子初始化：settings 主键冲突 = 已被并发请求抢先完成 → 拒绝（不覆盖）
  const r = store.db
    .prepare("INSERT INTO settings (key, value) VALUES ('admin_password_hash', ?) ON CONFLICT(key) DO NOTHING")
    .run(hash);
  if (Number(r.changes) === 0) return { error: "already_initialized" };
  // 一次性：设置成功后引导凭据立即失效
  store.db.prepare("DELETE FROM settings WHERE key = ?").run(BOOTSTRAP_KEY);
  return { ok: true };
}

/** DB hash 模式登录（限速；key 由调用方前缀区分模式） */
export function loginWithDbHash(
  store: Store,
  password: string,
  label: string,
  clientKey: string,
): { token: string; tokenId: string } | { error: string; status: number } {
  if (loginRateLimited(clientKey)) {
    return { error: "rate_limited", status: 429 };
  }
  const hash = store.getSetting("admin_password_hash");
  if (!hash || !verifyPasswordHash(password, hash)) {
    recordLoginFailure(clientKey);
    return { error: "invalid_password", status: 401 };
  }
  clearLoginFailures(clientKey);
  const created = store.createToken(label);
  return { token: created.token, tokenId: created.tokenId };
}

// 重导出保持既有 import 兼容
export { loginOriginal as login, safeEqual };
void loginOriginal;
void safeEqual;
