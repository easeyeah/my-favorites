/**
 * 自建端鉴权（F6.2）：设置 ADMIN_PASSWORD 后所有 /api/v1 需要 Bearer token。
 * /healthz、/s/*（公开导航页）保持公开。未设置密码 = 无鉴权（本地开发/测试）。
 */
import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { Store } from "./store";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function authEnabled(adminPassword: string | undefined): boolean {
  return Boolean(adminPassword && adminPassword.length > 0);
}

export function login(
  store: Store,
  adminPassword: string | undefined,
  password: string,
  label: string,
): { token: string } | { error: string } {
  if (!authEnabled(adminPassword) || !adminPassword) return { error: "auth_disabled" };
  if (!safeEqual(password, adminPassword)) return { error: "invalid_password" };
  return { token: store.createToken(label) };
}

/** 挂载鉴权中间件：/api/v1 全部（root 公开路由在 outer app 上，不受影响） */
export function mountAuth(app: Hono, store: Store, adminPassword: string | undefined): void {
  if (!authEnabled(adminPassword)) return;
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !store.hasToken(token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
}
