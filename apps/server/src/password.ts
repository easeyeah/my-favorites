/**
 * 密码哈希（scrypt，无外部依赖）。
 * DEV-23：从 app.ts 提取为独立模块，消除 app ↔ security 的循环依赖。
 * 格式 s1:<salt>:<hash>；admin 密码与导航站密码共用。
 */
import { randomBytes, scryptSync } from "node:crypto";

export async function hashPassword(password: string): Promise<{ hash: string }> {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return { hash: `s1:${salt}:${hash}` };
}

/** 同步版（D68 owner 账号 provisioning 用——buildApp 是同步函数，无法 await） */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `s1:${salt}:${hash}`;
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split(":");
  const version = parts[0];
  const salt = parts[1];
  const hash = parts[2];
  if (version !== "s1" || !salt || !hash) return false;
  return scryptSync(password, salt, 32).toString("hex") === hash;
}
