/** D73：统一部署的系统管理、注册策略、用户生命周期与数据导出。 */
import { afterEach, describe, expect, it } from "vitest";
import { fixturePassword, makeEnv, type TestEnv } from "./test-env";
import { runAsUser } from "./tenancy";

let env: TestEnv;

afterEach(() => {
  env?.cleanup();
  env = undefined as unknown as TestEnv;
});

function bearer(token: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

async function register(username: string, password = fixturePassword("a")) {
  const res = await env.app.request("/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, label: `test-${username}` }),
  });
  const body = (await res.json()) as { token?: string; tokenId?: string; error?: string };
  return { status: res.status, ...body };
}

async function login(username: string, password: string) {
  const res = await env.app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, label: "system-admin-test" }),
  });
  const body = (await res.json()) as { token?: string; error?: string };
  return { status: res.status, ...body };
}

describe("D73 系统管理权限与注册策略", () => {
  it("首个注册账号自动成为管理员；后续账号不能访问系统管理", async () => {
    env = makeEnv();
    const admin = await register("owner");
    const member = await register("member", fixturePassword("b"));
    expect(admin.status).toBe(201);
    expect(member.status).toBe(201);

    const adminMe = (await (
      await env.app.request("/api/v1/auth/me", { headers: bearer(admin.token!) })
    ).json()) as { role: string; isAdmin: boolean };
    const memberMe = (await (
      await env.app.request("/api/v1/auth/me", { headers: bearer(member.token!) })
    ).json()) as { role: string; isAdmin: boolean };
    expect(adminMe).toMatchObject({ role: "admin", isAdmin: true });
    expect(memberMe).toMatchObject({ role: "user", isAdmin: false });

    const denied = await env.app.request("/api/v1/admin/system", { headers: bearer(member.token!) });
    expect(denied.status).toBe(403);
    const allowed = await env.app.request("/api/v1/admin/system", { headers: bearer(admin.token!) });
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { users: Array<Record<string, unknown>> };
    expect(body.users).toHaveLength(2);
    expect(JSON.stringify(body.users)).not.toContain("password_hash");

    const crossRevoke = await env.app.request(`/api/v1/auth/tokens/${admin.tokenId}`, {
      method: "DELETE",
      headers: bearer(member.token!),
    });
    expect(crossRevoke.status).toBe(404);
    expect((await env.app.request("/api/v1/auth/me", { headers: bearer(admin.token!) })).status).toBe(200);
  });

  it("注册开关持久化优先于 env，healthz 同步公开状态", async () => {
    env = makeEnv();
    const admin = await register("owner");
    const saved = process.env.MF_REGISTER_OPEN;
    process.env.MF_REGISTER_OPEN = "1";
    try {
      const close = await env.app.request("/api/v1/admin/system", {
        method: "PATCH",
        headers: bearer(admin.token!),
        body: JSON.stringify({ registrationOpen: false }),
      });
      expect(close.status).toBe(200);
      expect(env.registry.getSetting("registration_open")).toBe("0");
      expect((await register("blocked")).error).toBe("register_closed");
      const health = (await (await env.app.request("/healthz")).json()) as { registrationOpen: boolean };
      expect(health.registrationOpen).toBe(false);

      await env.app.request("/api/v1/admin/system", {
        method: "PATCH",
        headers: bearer(admin.token!),
        body: JSON.stringify({ registrationOpen: true }),
      });
      expect((await register("allowed", fixturePassword("b"))).status).toBe(201);
    } finally {
      if (saved === undefined) delete process.env.MF_REGISTER_OPEN;
      else process.env.MF_REGISTER_OPEN = saved;
    }
  });
});

describe("D73 用户管理", () => {
  it("管理员创建用户、调整角色；新账号可登录到自己的租户", async () => {
    env = makeEnv();
    const admin = await register("owner");
    const created = await env.app.request("/api/v1/admin/users", {
      method: "POST",
      headers: bearer(admin.token!),
      body: JSON.stringify({ username: "family", password: fixturePassword("b"), role: "admin" }),
    });
    expect(created.status).toBe(201);
    const session = await login("family", fixturePassword("b"));
    expect(session.status).toBe(200);
    let me = (await (
      await env.app.request("/api/v1/auth/me", { headers: bearer(session.token!) })
    ).json()) as { role: string; userId: string };
    expect(me.role).toBe("admin");
    expect(me.userId).not.toBe("self");

    const target = env.registry.findUserByUsername("family")!;
    const demoted = await env.app.request(`/api/v1/admin/users/${target.id}`, {
      method: "PATCH",
      headers: bearer(admin.token!),
      body: JSON.stringify({ role: "user" }),
    });
    expect(demoted.status).toBe(200);
    me = (await (
      await env.app.request("/api/v1/auth/me", { headers: bearer(session.token!) })
    ).json()) as { role: string; userId: string };
    expect(me.role).toBe("user");
  });

  it("停用立即撤销令牌；启用后可登录；重置密码再次作废旧令牌", async () => {
    env = makeEnv();
    const admin = await register("owner");
    const member = await register("member", fixturePassword("b"));
    const target = env.registry.findUserByUsername("member")!;

    const disabled = await env.app.request(`/api/v1/admin/users/${target.id}`, {
      method: "PATCH",
      headers: bearer(admin.token!),
      body: JSON.stringify({ disabled: true }),
    });
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { revokedTokens: number }).revokedTokens).toBeGreaterThan(0);
    expect((await env.app.request("/api/v1/bookmarks", { headers: bearer(member.token!) })).status).toBe(401);
    expect((await login("member", fixturePassword("b"))).error).toBe("account_disabled");

    await env.app.request(`/api/v1/admin/users/${target.id}`, {
      method: "PATCH",
      headers: bearer(admin.token!),
      body: JSON.stringify({ disabled: false }),
    });
    const restored = await login("member", fixturePassword("b"));
    expect(restored.status).toBe(200);

    const reset = await env.app.request(`/api/v1/admin/users/${target.id}`, {
      method: "PATCH",
      headers: bearer(admin.token!),
      body: JSON.stringify({ newPassword: fixturePassword("new") }),
    });
    expect(reset.status).toBe(200);
    expect((await env.app.request("/api/v1/bookmarks", { headers: bearer(restored.token!) })).status).toBe(401);
    expect((await login("member", fixturePassword("b"))).status).toBe(401);
    expect((await login("member", fixturePassword("new"))).status).toBe(200);
  });

  it("owner 与当前管理员不可被停用或降级", async () => {
    env = makeEnv(null, false, { adminPassword: fixturePassword("main") });
    const owner = await login("admin", fixturePassword("main"));
    const ownerRow = env.registry.findUserById("self")!;
    const res = await env.app.request("/api/v1/admin/users/self", {
      method: "PATCH",
      headers: bearer(owner.token!),
      body: JSON.stringify({ disabled: true }),
    });
    expect(res.status).toBe(400);
    expect(ownerRow.role).toBe("admin");
  });
});

describe("D73 用户数据导出", () => {
  it("管理员导出目标用户全部内容（含私密），不夹带其他用户与任何凭据", async () => {
    env = makeEnv();
    const admin = await register("owner");
    const member = await register("member", fixturePassword("b"));
    const target = env.registry.findUserByUsername("member")!;

    const created = await env.app.request("/api/v1/bookmarks", {
      method: "POST",
      headers: bearer(member.token!),
      body: JSON.stringify({ url: "https://example.com/member-private", title: "member-private" }),
    });
    const bookmark = (await created.json()) as { id: string };
    await env.app.request(`/api/v1/bookmarks/${bookmark.id}`, {
      method: "PATCH",
      headers: bearer(member.token!),
      body: JSON.stringify({ isPrivate: true }),
    });
    await env.app.request("/api/v1/bookmarks", {
      method: "POST",
      headers: bearer(admin.token!),
      body: JSON.stringify({ url: "https://example.com/admin-only", title: "admin-only" }),
    });
    runAsUser(target.id, () => {
      env.store.db
        .prepare(
          "INSERT INTO provider_config (id, provider_id, base_url, api_key, purpose_models, enabled, created_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run("secret-provider", "deepseek", "https://api.deepseek.com/v1", "encrypted-secret", "{}", 1, new Date().toISOString());
      env.store.db
        .prepare(
          "INSERT INTO material (id, bookmark_id, type, status, cover_path, meta, signals, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run("material-secret-path", bookmark.id, "article", "active", "/private/cover.jpg", "{}", "[]", new Date().toISOString(), new Date().toISOString());
    });

    const exported = await env.app.request(`/api/v1/admin/users/${target.id}/export`, {
      headers: bearer(admin.token!),
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("member-export.json");
    const body = (await exported.json()) as {
      account: { username: string };
      bookmarks: Array<{ title: string; is_private: number }>;
    };
    expect(body.account.username).toBe("member");
    expect(body.bookmarks.some((b) => b.title === "member-private" && b.is_private === 1)).toBe(true);
    expect(body.bookmarks.some((b) => b.title === "admin-only")).toBe(false);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("password_hash");
    expect(serialized).not.toContain("token_hash");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("encrypted-secret");
    expect(serialized).not.toContain("cover_path");
    expect(serialized).not.toContain("/private/cover.jpg");

    // 旧 /export/json 的默认隐私边界不变；新「导出我的数据」显式包含私密。
    const legacy = await env.app.request("/api/v1/export/json", { headers: bearer(member.token!) });
    expect((await legacy.text()).includes("member-private")).toBe(false);
    const own = await env.app.request("/api/v1/export/user", { headers: bearer(member.token!) });
    expect((await own.text()).includes("member-private")).toBe(true);
  });
});
