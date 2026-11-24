/**
 * A4-1 安全默认值（2026-11-17）+ DEV-05（2026-11-18）：
 *  - 非开发部署首启必须设置管理员密码，设置完成前 /api/v1 全部 503（setup 通道除外）；
 *  - setup 需要部署引导凭据（MF_SETUP_TOKEN env 或 dataDir/bootstrap-token.txt），
 *    防止暴露端口后任何人抢先设管理员；初始化原子幂等（并发 setup 至多一个成功）；
 *  - 登录速率限制（内存滑窗：5 次/分钟/key，key 区分 admin 模式与导航站 slug）；
 *  - 令牌摘要存储、到期、撤销（registry.ts / auth.ts）。
 * D73：管理员凭据/引导凭据是「部署级」状态 → 主库 registry 承载；
 *      所有部署共用注册/登录；生产首启在无管理员且无用户时才要求 setup。
 */
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Hono } from "hono";
import type { Registry } from "./registry";
import { runAsUser, SELF_USER_ID } from "./tenancy";
import { authEnabled, safeEqual } from "./auth";
import { hashPassword, verifyPasswordHash } from "./password";

/** 非开发部署判定：MF_ENV 显式 dev/test = 开发；production 或 docker 默认 = 生产语义 */
export function isProductionLike(): boolean {
  const env = process.env.MF_ENV ?? "";
  if (env === "dev" || env === "test" || env === "development") return false;
  return true; // 未设置时：Docker 部署按生产语义处理（本地开发显式 MF_ENV=dev）
}

/** 管理员凭据是否已初始化（registry 部署级 settings.admin_password_hash 存在） */
export function adminInitialized(registry: Registry): boolean {
  return registry.getSetting("admin_password_hash") !== null;
}

/**
 * 生产语义 + 未初始化 + 无任何注册用户 = 需要 setup（D68 统一：注册即身份——
 * 只要存在注册用户（或已设管理员），门槛即解除；首次部署也可走 /auth/register 建号替代 setup）
 */
export function setupRequired(registry: Registry): boolean {
  return isProductionLike() && !adminInitialized(registry) && registry.countUsers() === 0;
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
 *  2. registry 部署级 settings 内已生成的凭据（进程重启后保持一致）；
 *  3. 首次生成随机凭据并写入 dataDir/bootstrap-token.txt（权限 600）——
 *     日志只提示文件路径，不打印凭据本身（凭据不进 URL/公共日志）。
 * 仅生产语义（isProductionLike）调用；dev/test 保持免凭据（本地开发体验）。
 */
export function ensureBootstrapToken(registry: Registry, dataDir: string): string {
  const envToken = process.env.MF_SETUP_TOKEN;
  if (envToken && envToken.length > 0) return envToken;
  const existing = registry.getSetting(BOOTSTRAP_KEY);
  if (existing) return existing;
  const generated = randomBytes(24).toString("base64url");
  registry.setSetting(BOOTSTRAP_KEY, generated);
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
 * A4-1 挂载（D68 统一）：env 密码/生产语义 → 令牌门槛；dev 开放模式 → 有令牌建上下文、无令牌匿名（self 主库）。
 */
export function mountSecurity(app: Hono, registry: Registry, adminPassword: string | undefined): void {
  // 场景一：环境变量密码（开发/既有部署兼容）→ 严格令牌门槛
  if (authEnabled(adminPassword)) return mountTokenAuth(app, registry);

  // 场景二：仅生产语义（MF_ENV 非 dev/test）启用强制门槛。
  // 开发模式（MF_ENV=dev/test/development 或显式本地）：不设密码不拦 API（保持本地开发体验），
  // 但携带令牌时仍建立用户上下文（D68 多用户：注册用户的请求必须落到自己的数据文件）。
  if (!isProductionLike()) {
    app.use("*", async (c, next) => {
      const header = c.req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      const resolved = token ? registry.resolveToken(token) : undefined;
      // 开放开发模式只豁免「未携带凭据」的本机请求；坏令牌/停用令牌绝不能降级成 owner。
      if (token && !resolved) return c.json({ error: "unauthorized" }, 401);
      if (resolved) return runAsUser(resolved.userId, () => next());
      await next();
    });
    return;
  }
  app.use("*", async (c, next) => {
    const pathName = c.req.path;
    // setup 通道永远放行到路由层（路由自己校验引导凭据/拒绝重复初始化/弱密码）
    if (pathName.startsWith("/api/v1/admin/setup") || pathName.startsWith("/healthz")) {
      return next();
    }
    if (setupRequired(registry)) {
      return c.json({ error: "admin_setup_required", setup: "/api/v1/admin/setup" }, 503);
    }
    return requireToken(c, registry, next);
  });
}

/** D67 统一令牌门槛：摘要校验 + 以令牌归属用户建立请求上下文（Store.db 据此取数据文件） */
export function mountTokenAuth(app: Hono, registry: Registry): void {
  app.use("*", async (c, next) => {
    return requireToken(c, registry, next);
  });
}

async function requireToken(
  c: { json: (body: { error: string }, status: number) => Response; req: { header: (n: string) => string | undefined } },
  registry: Registry,
  next: () => Promise<void>,
): Promise<Response | void> {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const resolved = token ? registry.resolveToken(token) : undefined;
  if (!resolved) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await runAsUser(resolved.userId, () => next());
}

/**
 * 首启设置管理员密码（仅一次；原子幂等）。
 * DEV-05：生产语义要求引导凭据（header x-mf-setup-token）；并发 setup 至多一个成功。
 */
export async function adminSetup(
  registry: Registry,
  password: string,
  bootstrapToken: string,
  dataDir: string,
): Promise<{ ok: true } | { error: string }> {
  if (adminInitialized(registry)) return { error: "already_initialized" };
  if (password.length < 8) return { error: "password_too_short_min_8" };
  if (isProductionLike()) {
    const expected = ensureBootstrapToken(registry, dataDir);
    if (!bootstrapToken || !safeEqual(bootstrapToken, expected)) {
      return { error: "setup_token_required" };
    }
  }
  const { hash } = await hashPassword(password);
  // 原子初始化：settings 主键冲突 = 已被并发请求抢先完成 → 拒绝（不覆盖）
  if (!registry.setSettingOnce("admin_password_hash", hash)) {
    return { error: "already_initialized" };
  }
  // 一次性：设置成功后引导凭据立即失效；同时补齐 owner 用户名账号，统一登录无需等重启。
  registry.deleteSetting(BOOTSTRAP_KEY);
  registry.ensureOwnerAccount();
  return { ok: true };
}

/** DB hash 模式登录（限速；key 由调用方前缀区分模式） */
export function loginWithDbHash(
  registry: Registry,
  password: string,
  label: string,
  clientKey: string,
): { token: string; tokenId: string } | { error: string; status: number } {
  if (loginRateLimited(clientKey)) {
    return { error: "rate_limited", status: 429 };
  }
  const hash = registry.getSetting("admin_password_hash");
  if (!hash || !verifyPasswordHash(password, hash)) {
    recordLoginFailure(clientKey);
    return { error: "invalid_password", status: 401 };
  }
  clearLoginFailures(clientKey);
  const created = registry.createToken(SELF_USER_ID, label);
  return { token: created.token, tokenId: created.tokenId };
}

// 重导出保持既有 import 兼容（原 auth.ts 的 login 已迁至 registry 口径）
export { safeEqual };
void safeEqual;
