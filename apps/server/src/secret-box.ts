/**
 * A4-2 Provider Key 加密保存（2026-11-17）
 *
 * 威胁模型：数据库文件（含备份）泄露时，Provider Key 不应明文可读。
 * 加密密钥 = 部署密钥（MF_SECRET_KEY 环境变量），与数据文件分离存储
 * （DB 泄露 ≠ 密钥泄露）。未配置 MF_SECRET_KEY 时：
 *  - 生产语义（MF_ENV 非 dev/test）：拒绝保存 key（强制配置）；
 *  - 开发：明文落库并标记（不阻碍本地开发，但生产不放宽）。
 * 展示永远脱敏；解密仅在使用时内存发生；禁止写入日志与普通导出。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGO = "aes-256-gcm";

function deriveKey(secret: string): Buffer {
  // 固定 salt 派生（secret 本身是高熵部署密钥；盐固定使同一 secret 可重复解密）
  return scryptSync(secret, "mf-provider-key-v1", 32);
}

export function secretKeyConfigured(): boolean {
  const k = process.env.MF_SECRET_KEY;
  return Boolean(k && k.length >= 16);
}

/** 加密：v1:<iv>:<tag>:<cipher>（base64 段） */
export function encryptSecret(plaintext: string): string {
  const secret = process.env.MF_SECRET_KEY!;
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string | null {
  try {
    if (!stored.startsWith("v1:")) return null;
    const [, ivB64, tagB64, dataB64] = stored.split(":");
    const secret = process.env.MF_SECRET_KEY!;
    const key = deriveKey(secret);
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64!, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64!, "base64")), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

/** 保存路径：加密或拒绝（生产无 MF_SECRET_KEY 时不得明文保存） */
export function protectKeyForStorage(plaintext: string | null): string | null {
  if (plaintext === null || plaintext === "") return null;
  if (secretKeyConfigured()) return encryptSecret(plaintext);
  if (process.env.MF_ENV === "dev" || process.env.MF_ENV === "test" || process.env.MF_ENV === "development") {
    return plaintext; // 开发模式明文（本地无威胁模型）；生产见下
  }
  // 生产语义未配密钥：拒绝（调用方转成错误响应，提示配置 MF_SECRET_KEY）
  throw new Error("MF_SECRET_KEY_required_for_provider_keys");
}

/** 使用路径：解密（加密态）或原样（开发明文态） */
export function keyForUse(stored: string | null): string | null {
  if (!stored) return null;
  if (stored.startsWith("v1:")) return decryptSecret(stored);
  return stored; // 开发明文
}
