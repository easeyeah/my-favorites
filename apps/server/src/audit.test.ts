/**
 * D58 操作审计日志回归（2026-11-21）：
 *  - 认证三态入审计（成功/失败/限速），detail 绝不落密码；
 *  - 令牌撤销（列表 ID / logout）入审计；
 *  - 配置变更（供应商 / 偏好 / Webhook）与导航站发布入审计；
 *  - GET /audit 只读查询 + limit 上限；
 *  - pruneRetention：changes/events/idempotency 按天裁剪、audit_log 保最近 1000 条。
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";
import { clearLoginFailures } from "./security";

let env: TestEnv;
afterEach(() => env?.cleanup());

/** 测试密码运行时生成（避免源码出现字面量凭据） */
const pass = (): string => randomBytes(12).toString("hex");

/** 限速器是 security.ts 模块级内存 Map，key 在测试环境恒为 admin-env:local——跨测试必须显式清零 */
function resetRateLimit(): void {
  clearLoginFailures("admin-env:local");
}

interface AuditRow {
  id: number;
  kind: string;
  detail: string | null;
  source: string | null;
  created_at: string;
}

async function auditRows(e: TestEnv, token?: string): Promise<AuditRow[]> {
  const res = await e.app.request("/api/v1/audit?limit=500", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditRow[] }).events;
}

async function loginWrong(e: TestEnv, password: string): Promise<Response> {
  return e.app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, label: "web-admin" }),
  });
}

describe("D58 认证审计（env 密码模式）", () => {
  it("登录失败/成功入审计；detail 不含密码原文", async () => {
    const adminPassword = pass();
    env = makeEnv(null, false, { adminPassword });
    resetRateLimit();
    const wrong = pass();
    // 错密码 → 401 + auth.failed
    const bad = await loginWrong(env, wrong);
    expect(bad.status).toBe(401);
    // 对密码 → 200 + auth.login
    const ok = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword, label: "web-admin" }),
    });
    expect(ok.status).toBe(200);
    const { token } = (await ok.json()) as { token: string };

    const rows = await auditRows(env, token);
    const failed = rows.find((r) => r.kind === "auth.failed");
    expect(failed).toBeDefined();
    expect(failed!.detail).toContain("登录失败");
    expect(failed!.detail).not.toContain(wrong); // 红线：密码绝不落日志
    expect(failed!.source).not.toBeNull();
    const login = rows.find((r) => r.kind === "auth.login");
    expect(login).toBeDefined();
    expect(login!.detail).toContain("web-admin");
  });

  it("限速触发入审计（auth.rate_limited）", async () => {
    env = makeEnv(null, false, { adminPassword: pass() });
    resetRateLimit();
    // 同 key 连错 5 次触发限速（security.ts MAX_ATTEMPTS=5）
    for (let i = 0; i < 5; i++) {
      await loginWrong(env, "nope-" + randomBytes(2).toString("hex"));
    }
    const limited = await loginWrong(env, "nope-final");
    expect(limited.status).toBe(429);
    // 全部请求都被限速/拒绝，没有可用 token——直接查 store（/audit 路由已在其他用例覆盖）
    const rows = env.store.listAudit(500);
    expect(rows.find((r) => r.kind === "auth.rate_limited")).toBeDefined();
  });
});

describe("D58 令牌与配置审计", () => {
  it("撤销令牌入审计（列表 ID 与 logout 两路）", async () => {
    const adminPassword = pass();
    env = makeEnv(null, false, { adminPassword });
    resetRateLimit();
    const login = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword, label: "我的扩展" }),
    });
    const { token, tokenId } = (await login.json()) as { token: string; tokenId: string };
    const auth = { authorization: `Bearer ${token}` };

    const rv = await env.app.request(`/api/v1/auth/tokens/${tokenId}`, { method: "DELETE", headers: auth });
    expect(rv.status).toBe(200);
    // logout：再签一个并撤销
    const login2 = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword }),
    });
    const t2 = (await login2.json()) as { token: string };
    const out = await env.app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${t2.token}` },
    });
    expect(out.status).toBe(200);
    // 前两个 token 都已撤销——再签一个仅供查询
    const login3 = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword }),
    });
    const t3 = (await login3.json()) as { token: string };

    const rows = await auditRows(env, t3.token);
    const revoked = rows.filter((r) => r.kind === "token.revoked");
    expect(revoked.length).toBe(2);
    expect(revoked.some((r) => r.detail!.includes("我的扩展"))).toBe(true);
  });

  it("供应商保存 / 偏好变更入审计", async () => {
    env = makeEnv();
    const pv = await env.app.request("/api/v1/settings/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "deepseek", baseUrl: "https://api.deepseek.com/v1" }),
    });
    expect(pv.status).toBe(201);
    const pf = await env.app.request("/api/v1/settings/prefs", {
      method: "PATCH",
      body: JSON.stringify({ notifyStyle: "card" }),
      headers: { "content-type": "application/json" },
    });
    expect(pf.status).toBe(200);

    const rows = await auditRows(env);
    expect(rows.find((r) => r.kind === "provider.saved" && r.detail!.includes("deepseek"))).toBeDefined();
    expect(rows.find((r) => r.kind === "settings.changed" && r.detail!.includes("通知方式"))).toBeDefined();
  });

  it("导航站发布/下线入审计", async () => {
    env = makeEnv();
    const folder = env.store.ensurePath(["公开"]);
    // 发布作用域必须非空（默认私有红线：empty_publication_scope → 400）
    env.store.createBookmark({ folderId: folder.id, urlRaw: "https://example.com/public", urlCanonical: "https://example.com/public", title: "公开书签" });
    const pub = await env.app.request("/api/v1/nav/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderIds: [folder.id], title: "测试站" }),
    });
    expect(pub.status).toBe(201);
    const { slug } = (await pub.json()) as { slug: string };
    const un = await env.app.request(`/api/v1/nav/sites/${slug}/unpublish`, { method: "POST" });
    expect(un.status).toBe(200);

    const rows = await auditRows(env);
    const published = rows.find((r) => r.kind === "nav.published");
    expect(published).toBeDefined();
    expect(published!.detail).toContain(slug);
    expect(rows.find((r) => r.kind === "nav.unpublished")).toBeDefined();
  });

  it("GET /audit 只读查询与 limit 上限", async () => {
    env = makeEnv();
    for (let i = 0; i < 3; i++) env.store.audit("custom.kind", `事件 ${i}`);
    const res = await env.app.request("/api/v1/audit");
    const body = (await res.json()) as { events: AuditRow[] };
    expect(body.events.length).toBe(3);
    expect(body.events[0]!.kind).toBe("custom.kind");
    env.store.audit("x", "y");
    const capped = (await (await env.app.request("/api/v1/audit?limit=9999")).json()) as { events: AuditRow[] };
    expect(capped.events.length).toBe(4);
  });
});

describe("D58 pruneRetention（保留裁剪）", () => {
  it("changes/events/idempotency 按天裁剪；audit_log 保最近 1000 条", async () => {
    env = makeEnv();
    const old = new Date(Date.now() - 100 * 86400_000).toISOString(); // 超过全部保留窗口（最长 events 90d）
    const fresh = new Date().toISOString();
    const db = env.store.db;
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO changes (entity, entity_id, op, payload, device, created_at) VALUES ('bookmark', ?, 'upsert', '{}', null, ?)").run(`old-${i}`, old);
      db.prepare("INSERT INTO events (name, props, created_at) VALUES ('import_completed', '{}', ?)").run(old);
      db.prepare("INSERT INTO idempotency (key, result, created_at) VALUES (?, '{}', ?)").run(`old-key-${i}`, old);
      db.prepare("INSERT INTO changes (entity, entity_id, op, payload, device, created_at) VALUES ('bookmark', ?, 'upsert', '{}', null, ?)").run(`new-${i}`, fresh);
      db.prepare("INSERT INTO events (name, props, created_at) VALUES ('install', '{}', ?)").run(fresh);
      db.prepare("INSERT INTO idempotency (key, result, created_at) VALUES (?, '{}', ?)").run(`new-key-${i}`, fresh);
    }
    // audit：插入 1005 条，应裁掉最早 5 条（保最近 1000）
    const ins = db.prepare("INSERT INTO audit_log (kind, detail, source, created_at) VALUES ('x', 'y', null, ?)");
    for (let i = 0; i < 1005; i++) ins.run(old);

    const r = env.store.pruneRetention();
    expect(r.changes).toBe(5);
    expect(r.events).toBe(5);
    expect(r.idempotency).toBe(5);
    expect(r.audit).toBe(5);

    const cnt = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
    expect(cnt("SELECT COUNT(*) as c FROM changes WHERE created_at < ?")).toBe(0);
    expect(cnt("SELECT COUNT(*) as c FROM audit_log")).toBe(1000);
    // 幂等重跑：再跑一次全 0
    const r2 = env.store.pruneRetention();
    expect(r2.changes + r2.events + r2.idempotency + r2.audit).toBe(0);
  });
});
