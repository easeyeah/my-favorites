/**
 * 注册表层（D67）——跨用户共享面，全部落在主库：
 *  - users：统一用户账号（owner id=self 恒主库，其余用户独立数据文件）；
 *  - tokens：全形态令牌（自建 user_id=self；云端按用户签发/隔离列表）；
 *  - 部署级 settings：admin_password_hash / bootstrap / nav_cookie_secret——
 *    这些属于「这套部署」而非「某个用户」，云端也必须跨用户一致（nav HMAC 密钥）；
 *  - 认证类审计（auth.xxx / token.xxx / user.xxx / password.xxx）落主库 audit_log；
 *    数据类审计（导航站发布/偏好/供应商变更）仍走 Store.audit（云端随用户库）；
 *  - public_slugs：公开站点 slug → 数据属主索引（云端 /s/:slug 借此路由到用户库；
 *    自建恒 self，查询短路等价于旧行为）。
 */
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db";
import { newId, now } from "./db";
import { SELF_USER_ID } from "./tenancy";
import { hashPasswordSync } from "./password";

export type UserRole = "admin" | "user";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  role: UserRole;
  disabled_at: string | null;
  created_at: string;
}

/** 管理面返回的安全用户投影：绝不带 password_hash。 */
export interface AdminUserRow {
  id: string;
  username: string;
  display_name: string | null;
  role: UserRole;
  disabled_at: string | null;
  created_at: string;
}

export interface TokenRow {
  current?: boolean;
  token_id: string;
  label: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class Registry {
  constructor(readonly db: Db) {}

  // ---------- D68 统一登录：owner 账号 provisioning ----------
  /**
   * 旧单管理员部署（ADMIN_PASSWORD env / settings DB hash）升级到统一用户名登录时，
   * 自动为数据属主（id='self'，主库）配一个用户名账号：username='admin'，密码=旧管理员密码。
   * 只在账号不存在时创建一次（绝不覆盖——此后 owner 就是普通用户账号，改密走 /auth/password）；
   * 旧 {password} 无用户名登录路径保留（兼容旧扩展/脚本），两路凭据等价。
   */
  ensureOwnerAccount(adminPassword?: string): void {
    if (this.findUserById(SELF_USER_ID)) return;
    const hash = adminPassword ? hashPasswordSync(adminPassword) : this.getSetting("admin_password_hash");
    if (!hash) return; // 未配置旧管理员（纯注册模式）→ 无需 provisioning
    this.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(SELF_USER_ID, "admin", hash, "管理员", "admin", now());
  }

  countUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
    return row.c;
  }

  // ---------- 用户账号（users） ----------
  createUser(
    username: string,
    passwordHash: string,
    displayName?: string | null,
    role: UserRole = "user",
  ): UserRow {
    const row: UserRow = {
      id: newId(),
      username,
      password_hash: passwordHash,
      display_name: displayName?.slice(0, 32) || null,
      role,
      disabled_at: null,
      created_at: now(),
    };
    this.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, display_name, role, disabled_at, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(row.id, row.username, row.password_hash, row.display_name, row.role, null, row.created_at);
    return row;
  }

  findUserByUsername(username: string): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
      .get(username) as UserRow | undefined;
  }

  findUserById(id: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  updateUserPassword(id: string, passwordHash: string): void {
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
  }

  listUsers(): AdminUserRow[] {
    return this.db
      .prepare(
        "SELECT id, username, display_name, role, disabled_at, created_at FROM users ORDER BY created_at, id",
      )
      .all() as unknown as AdminUserRow[];
  }

  countActiveAdmins(exceptId?: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id != COALESCE(?, '')",
      )
      .get(exceptId ?? null) as { c: number };
    return row.c;
  }

  setUserDisabled(id: string, disabled: boolean): void {
    this.db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(disabled ? now() : null, id);
  }

  setUserRole(id: string, role: UserRole): void {
    this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  }

  /** 当前身份是否可进系统管理；旧 dev/无账号的 self 保留本机管理员语义。 */
  isAdmin(id: string): boolean {
    const user = this.findUserById(id);
    return user ? user.role === "admin" && !user.disabled_at : id === SELF_USER_ID;
  }

  /** D73：持久化注册策略优先；未设置时兼容 MF_REGISTER_OPEN 作为初始默认值。 */
  registrationOpen(): boolean {
    const saved = this.getSetting("registration_open");
    if (saved !== null) return saved === "1";
    return !["0", "false"].includes((process.env.MF_REGISTER_OPEN ?? "1").toLowerCase());
  }

  setRegistrationOpen(open: boolean): void {
    this.setSetting("registration_open", open ? "1" : "0");
  }

  /** 后台任务遍历口径：自建 = [self]（主库）；云端 = 全部已注册用户 */
  /** 后台任务遍历口径：owner 主库（恒含，即便未 provisioning）+ 全部注册用户（各自数据文件） */
  listUserIds(): string[] {
    const users = (
      this.db.prepare("SELECT id FROM users WHERE disabled_at IS NULL").all() as Array<{ id: string }>
    ).map((r) => r.id);
    return [SELF_USER_ID, ...users.filter((id) => id !== SELF_USER_ID)];
  }

  // ---------- 令牌（DEV-05 语义不变，新增 user 归属） ----------
  /**
   * 签发令牌：原值只在返回时出现一次，库中仅存 SHA-256 摘要与随机非密 ID。
   * ttlHours 默认 30 天；null = 不过期。
   */
  createToken(
    userId: string,
    label: string,
    ttlHours: number | null = 24 * 30,
  ): { token: string; tokenId: string } {
    const token = randomBytes(32).toString("base64url");
    const tokenId = newId();
    const expiresAt = ttlHours !== null ? new Date(Date.now() + ttlHours * 3600_000).toISOString() : null;
    this.db
      .prepare(
        "INSERT INTO tokens (token, token_id, token_hash, label, user_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(tokenId, tokenId, hashToken(token), label, userId, now(), expiresAt);
    return { token, tokenId };
  }

  /** 校验令牌：摘要匹配 + 未撤销 + 未过期；命中时更新 last_used_at；返回归属用户 */
  resolveToken(token: string): { tokenId: string; label: string | null; userId: string } | undefined {
    const digest = hashToken(token);
    const row = this.db
      .prepare(
        `SELECT t.token_id, t.label, t.user_id, t.expires_at, t.revoked_at, u.disabled_at
         FROM tokens t LEFT JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
      )
      .get(digest) as
      | {
          token_id: string;
          label: string | null;
          user_id: string | null;
          expires_at: string | null;
          revoked_at: string | null;
          disabled_at: string | null;
        }
      | undefined;
    if (!row || row.revoked_at || row.disabled_at) return undefined;
    if (row.expires_at && row.expires_at <= now()) return undefined;
    this.db.prepare("UPDATE tokens SET last_used_at = ? WHERE token_id = ?").run(now(), row.token_id);
    return { tokenId: row.token_id, label: row.label, userId: row.user_id ?? SELF_USER_ID };
  }

  /** 兼容旧中间件签名：仅判有效与否 */
  hasToken(token: string): boolean {
    return this.resolveToken(token) !== undefined;
  }

  /** 令牌列表；userId 给定时只看该用户（云端「我的令牌」） */
  listTokens(userId?: string): TokenRow[] {
    const rows = userId
      ? this.db
          .prepare(
            "SELECT token_id, label, created_at, expires_at, revoked_at, last_used_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC",
          )
          .all(userId)
      : this.db
          .prepare(
            "SELECT token_id, label, created_at, expires_at, revoked_at, last_used_at FROM tokens ORDER BY created_at DESC",
          )
          .all();
    return rows as unknown as TokenRow[];
  }

  revokeTokenById(tokenId: string): boolean {
    const r = this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL")
      .run(now(), tokenId);
    return Number(r.changes) > 0;
  }

  /** 按原值撤销（logout：当前请求携带的 token） */
  revokeByRawToken(token: string): boolean {
    const r = this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .run(now(), hashToken(token));
    return Number(r.changes) > 0;
  }

  revokeAllTokensForUser(userId: string): number {
    const r = this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(now(), userId);
    return Number(r.changes);
  }

  revokeOtherTokens(userId: string, currentTokenId: string): number {
    return Number(this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND token_id != ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
      .run(now(), userId, currentTokenId, now()).changes);
  }

  // ---------- 部署级 settings（与 Store 的用户级 settings 同表不同库：主库） ----------
  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** 仅在未设置时写入（setup 原子幂等）；false = 已存在 */
  setSettingOnce(key: string, value: string): boolean {
    const r = this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO NOTHING")
      .run(key, value);
    return Number(r.changes) > 0;
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  // ---------- 认证类审计（主库 audit_log；语义同 Store.audit，红线一致） ----------
  audit(kind: string, detail: string, source?: string | null): void {
    this.db
      .prepare("INSERT INTO audit_log (kind, detail, source, created_at) VALUES (?,?,?,?)")
      .run(kind, detail.slice(0, 300), source?.slice(0, 100) ?? null, now());
  }

  listAudit(limit = 100): Array<{ id: number; kind: string; detail: string | null; source: string | null; created_at: string }> {
    return this.db
      .prepare(
        "SELECT id, kind, detail, source, created_at FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(Math.min(Math.max(1, Math.trunc(limit)), 2000)) as unknown as Array<{
      id: number;
      kind: string;
      detail: string | null;
      source: string | null;
      created_at: string;
    }>;
  }

  // ---------- 公开站点 slug 索引（云端跨用户路由；自建恒 self） ----------
  setSlugOwner(slug: string, userId: string): void {
    this.db
      .prepare(
        "INSERT INTO public_slugs (slug, user_id, updated_at) VALUES (?,?,?) ON CONFLICT(slug) DO UPDATE SET user_id = excluded.user_id, updated_at = excluded.updated_at",
      )
      .run(slug, userId, now());
  }

  deleteSlug(slug: string): void {
    this.db.prepare("DELETE FROM public_slugs WHERE slug = ?").run(slug);
  }

  slugOwner(slug: string): string | null {
    const row = this.db.prepare("SELECT user_id FROM public_slugs WHERE slug = ?").get(slug) as
      | { user_id: string }
      | undefined;
    return row?.user_id ?? null;
  }
}
