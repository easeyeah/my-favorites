/**
 * D68 统一登录/多租户集成测试：注册、登录、数据隔离、连接池、账号安全——
 * 对一切部署形态通用（自托管=官方云，仅地址不同；DEPLOY_MODE 已退役）。
 *  - 统一用户名注册/登录（自托管同样开放，MF_REGISTER_OPEN 可关）；
 *  - 旧单管理员兼容：{password} 无用户名登录仍可用；owner 自动 provisioning（username=admin）；
 *  - setup 门槛：生产语义 + 无管理员 + 无注册用户才拦；注册首个用户即解除；
 *  - 数据隔离：每用户独立 SQLite 文件；公开站 slug 全局路由；审计合并。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixturePassword, makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;

afterEach(() => {
  env?.cleanup();
  env = undefined as unknown as TestEnv;
});

const CRED = "cloud-fixture-pass-1"; // 注册用凭据（≥8 位）

function bearer(token: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

async function register(
  app: TestEnv["app"],
  username: string,
  password = CRED,
): Promise<{ status: number; token?: string; username?: string; error?: string }> {
  const res = await app.request("/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, label: `device-${username}` }),
  });
  const body = (await res.json()) as { token?: string; username?: string; error?: string };
  return { status: res.status, token: body.token, username: body.username, error: body.error };
}

describe("D68 统一登录：注册与登录", () => {
  it("healthz 报告 unified；注册 → 201 + 令牌可用 + /auth/me 回身份", async () => {
    env = makeEnv();
    const health = (await (await env.app.request("/healthz")).json()) as { deployMode: string };
    expect(health.deployMode).toBe("unified");

    const reg = await register(env.app, "alice");
    expect(reg.status).toBe(201);
    expect(reg.token).toBeTruthy();
    expect(reg.username).toBe("alice");

    const me = (await (
      await env.app.request("/api/v1/auth/me", { headers: bearer(reg.token!) })
    ).json()) as { username: string; userId: string; deployMode: string };
    expect(me.username).toBe("alice");
    expect(me.deployMode).toBe("unified");
    expect(me.userId).not.toBe("self");
  });

  it("注册校验：重名 409（大小写不敏感）/ 非法用户名 / 弱密码", async () => {
    env = makeEnv();
    expect((await register(env.app, "alice")).status).toBe(201);
    expect((await register(env.app, "alice")).status).toBe(409);
    expect((await register(env.app, "ALICE")).status).toBe(409);
    const bad = await register(env.app, "ab");
    expect(bad.error).toBe("invalid_username");
    const short = await register(env.app, "carol", "tiny");
    expect(short.error).toBe("password_too_short_min_8");
  });

  it("MF_REGISTER_OPEN=0 关闭注册（已有用户登录不受影响）", async () => {
    env = makeEnv();
    await register(env.app, "alice");
    const saved = process.env.MF_REGISTER_OPEN;
    process.env.MF_REGISTER_OPEN = "0";
    try {
      const closed = await register(env.app, "bob");
      expect(closed.status).toBe(403);
      expect(closed.error).toBe("register_closed");
    } finally {
      if (saved === undefined) delete process.env.MF_REGISTER_OPEN;
      else process.env.MF_REGISTER_OPEN = saved;
    }
    const login = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: CRED }),
    });
    expect(login.status).toBe(200);
  });

  it("登录：正确凭据换新令牌；错误凭据 401（不区分账号是否存在）", async () => {
    env = makeEnv();
    await register(env.app, "alice");
    const ok = (await (
      await env.app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "alice", password: CRED, label: "web" }),
      })
    ).json()) as { token: string; username: string };
    expect(ok.token).toBeTruthy();
    expect(ok.username).toBe("alice");

    const noUser = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ghost", password: CRED }),
    });
    expect(noUser.status).toBe(401);
    expect(((await noUser.json()) as { error: string }).error).toBe("invalid_password");
  });
});

describe("D68 旧单管理员兼容（既有部署零破坏）", () => {
  it("{password} 无用户名登录仍可用（env 密码模式）", async () => {
    env = makeEnv(null, false, { adminPassword: fixturePassword("main") });
    const res = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: fixturePassword("main"), label: "legacy-ext" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toBeTruthy();
    const ok = await env.app.request("/api/v1/bookmarks", { headers: bearer(body.token) });
    expect(ok.status).toBe(200);
  });

  it("owner 自动 provisioning：username=admin + 旧管理员密码 → 登录到 owner 数据（主库）", async () => {
    env = makeEnv(null, false, { adminPassword: fixturePassword("main") });
    // provisioning 在 buildApp 内完成
    const owner = env.registry.findUserById("self");
    expect(owner?.username).toBe("admin");
    const res = (await (
      await env.app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: fixturePassword("main"), label: "web" }),
      })
    ).json()) as { token: string; username: string };
    expect(res.username).toBe("admin");
    const me = (await (
      await env.app.request("/api/v1/auth/me", { headers: bearer(res.token) })
    ).json()) as { userId: string };
    expect(me.userId).toBe("self"); // owner 数据 = 主库
  });

  it("env 密码部署同样开放注册（多用户自托管）；注册用户与 owner 数据隔离", async () => {
    env = makeEnv(null, false, { adminPassword: fixturePassword("main") });
    const reg = await register(env.app, "family");
    expect(reg.status).toBe(201);
    // family 建书签 → 落在自己文件
    const res = await env.app.request("/api/v1/bookmarks", {
      method: "POST",
      headers: bearer(reg.token!),
      body: JSON.stringify({ url: "https://example.com/family-item", title: "family独有" }),
    });
    expect(res.status).toBeLessThan(300);
    // owner（admin 登录）看不到 family 的书签
    const ownerLogin = (await (
      await env.app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: fixturePassword("main") }),
      })
    ).json()) as { token: string };
    const ownerList = (await (
      await env.app.request("/api/v1/bookmarks", { headers: bearer(ownerLogin.token) })
    ).json()) as Array<{ title: string }>;
    expect(ownerList.some((b) => b.title === "family独有")).toBe(false);
    // family 的数据文件独立存在
    const me = (await (
      await env.app.request("/api/v1/auth/me", { headers: bearer(reg.token!) })
    ).json()) as { userId: string };
    expect(existsSync(path.join(env.dataDir, "users", me.userId, "my-favorites.db"))).toBe(true);
  });
});

describe("D68 setup 门槛（有注册用户自动解除）", () => {
  it("生产语义 + 无管理员 + 无用户 → 503；注册首个用户后 → 放行", async () => {
    const saved = process.env.MF_ENV;
    process.env.MF_ENV = "production";
    try {
      env = makeEnv();
      const blocked = await env.app.request("/api/v1/bookmarks");
      expect(blocked.status).toBe(503);
      // 注册（root 级公开路由，不受门槛拦）→ 门槛解除
      const reg = await register(env.app, "first");
      expect(reg.status).toBe(201);
      const ok = await env.app.request("/api/v1/bookmarks", { headers: bearer(reg.token!) });
      expect(ok.status).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.MF_ENV;
      else process.env.MF_ENV = saved;
    }
  });
});

describe("D68 数据隔离与公开站路由", () => {
  async function seedForUser(app: TestEnv["app"], token: string, title: string): Promise<string> {
    const res = await app.request("/api/v1/bookmarks", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ url: `https://example.com/${title}`, title }),
    });
    expect(res.status).toBeLessThan(300);
    const bm = (await res.json()) as { id: string };
    return bm.id;
  }

  it("A/B 两用户：书签互不可见；令牌列表隔离；各自独立数据文件", async () => {
    env = makeEnv();
    const a = await register(env.app, "alice");
    const b = await register(env.app, "bob");
    const bmA = await seedForUser(env.app, a.token!, "alice-bookmark");
    const bmB = await seedForUser(env.app, b.token!, "bob-bookmark");

    const listA = (await (
      await env.app.request("/api/v1/bookmarks", { headers: bearer(a.token!) })
    ).json()) as Array<{ id: string; title: string }>;
    const listB = (await (
      await env.app.request("/api/v1/bookmarks", { headers: bearer(b.token!) })
    ).json()) as Array<{ id: string; title: string }>;
    expect(listA.map((x) => x.title)).toEqual(["alice-bookmark"]);
    expect(listB.map((x) => x.title)).toEqual(["bob-bookmark"]);
    expect(listB.some((x) => x.id === bmA)).toBe(false);
    expect(listA.some((x) => x.id === bmB)).toBe(false);

    const tokensA = (await (
      await env.app.request("/api/v1/auth/tokens", { headers: bearer(a.token!) })
    ).json()) as { tokens: Array<{ label: string | null }> };
    expect(tokensA.tokens.every((t) => t.label === "device-alice")).toBe(true);

    const meA = (await (
      await env.app.request("/api/v1/auth/me", { headers: bearer(a.token!) })
    ).json()) as { userId: string };
    expect(existsSync(path.join(env.dataDir, "users", meA.userId, "my-favorites.db"))).toBe(true);
    void bmB;
  });

  it("公开站点 slug 路由：A/B 各发布一站，公开页各渲染各的数据", async () => {
    env = makeEnv();
    const a = await register(env.app, "alice");
    const b = await register(env.app, "bob");
    const bmA = await seedForUser(env.app, a.token!, "alice-bookmark");
    const bmB = await seedForUser(env.app, b.token!, "bob-bookmark");

    const pubA = (await (
      await env.app.request("/api/v1/nav/publish", {
        method: "POST",
        headers: bearer(a.token!),
        body: JSON.stringify({ title: "Alice 站", bookmarkIds: [bmA] }),
      })
    ).json()) as { slug: string };
    const pubB = (await (
      await env.app.request("/api/v1/nav/publish", {
        method: "POST",
        headers: bearer(b.token!),
        body: JSON.stringify({ title: "Bob 站", bookmarkIds: [bmB] }),
      })
    ).json()) as { slug: string };

    const htmlA = await (await env.app.request(`/s/${pubA.slug}`)).text();
    const htmlB = await (await env.app.request(`/s/${pubB.slug}`)).text();
    expect(htmlA).toContain("Alice 站");
    expect(htmlA).toContain("alice-bookmark");
    expect(htmlB).toContain("Bob 站");
    expect(htmlB).toContain("bob-bookmark");
    expect(htmlA).not.toContain("bob-bookmark");
    expect(htmlB).not.toContain("alice-bookmark");

    await env.app.request(`/api/v1/nav/sites/${pubA.slug}/unpublish`, {
      method: "POST",
      headers: bearer(a.token!),
    });
    const after = await (await env.app.request(`/s/${pubA.slug}`)).text();
    expect(after).not.toContain("alice-bookmark");
  });
});

describe("D68 连接池（1000 用户容量口径）", () => {
  it("打开句柄数受上限约束；回收后重开数据完好", async () => {
    env = makeEnv();
    const { UserDbManager } = await import("./tenancy");
    const pool = new UserDbManager(env.dataDir, env.registry.db, 8, 60_000);
    const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
    for (const id of ids) pool.dbFor(id).prepare("SELECT 1").get();
    expect(pool.openCount).toBeLessThanOrEqual(8);
    const first = ids[0]!;
    const db1 = pool.dbFor(first);
    db1.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("pool-probe", "v1");
    for (let i = 6; i < 20; i++) pool.dbFor(ids[i]!);
    expect(pool.openCount).toBeLessThanOrEqual(8);
    const reopened = pool.dbFor(first);
    const row = reopened.prepare("SELECT value FROM settings WHERE key = 'pool-probe'").get() as { value: string };
    expect(row.value).toBe("v1");
    pool.closeAll();
  });

  it("sweepIdle：闲置连接回收、当前上下文用户跳过", async () => {
    env = makeEnv();
    const { UserDbManager, runAsUser } = await import("./tenancy");
    const pool = new UserDbManager(env.dataDir, env.registry.db, 64, 0);
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    pool.dbFor(a);
    pool.dbFor(b);
    expect(pool.openCount).toBe(2);
    expect(pool.sweepIdle()).toBe(2);
    expect(pool.openCount).toBe(0);
    pool.dbFor(a);
    const closed = runAsUser(a, () => pool.sweepIdle());
    expect(closed).toBe(0);
    expect(pool.openCount).toBe(1);
    pool.closeAll();
  });
});

describe("D68 账号安全与审计", () => {
  it("改密码：旧密码 401 → 新密码登录成功；错误旧密码 401", async () => {
    env = makeEnv();
    const a = await register(env.app, "alice");
    const wrong = await env.app.request("/api/v1/auth/password", {
      method: "POST",
      headers: bearer(a.token!),
      body: JSON.stringify({ oldPassword: "wrong-old-pass", newPassword: "brand-new-pass-2" }),
    });
    expect(wrong.status).toBe(401);

    const changed = await env.app.request("/api/v1/auth/password", {
      method: "POST",
      headers: bearer(a.token!),
      body: JSON.stringify({ oldPassword: CRED, newPassword: "brand-new-pass-2" }),
    });
    expect(changed.status).toBe(200);

    const oldLogin = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: CRED }),
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "brand-new-pass-2" }),
    });
    expect(newLogin.status).toBe(200);
  });

  it("审计合并：注册（主库认证事件）+ 发布站点（用户库数据事件）都可在 /audit 看到", async () => {
    env = makeEnv();
    const a = await register(env.app, "alice");
    const bmA = await seedHelper(env.app, a.token!);
    await env.app.request("/api/v1/nav/publish", {
      method: "POST",
      headers: bearer(a.token!),
      body: JSON.stringify({ title: "A 站", bookmarkIds: [bmA] }),
    });
    const audit = (await (
      await env.app.request("/api/v1/audit", { headers: bearer(a.token!) })
    ).json()) as { events: Array<{ kind: string }> };
    const kinds = audit.events.map((e) => e.kind);
    expect(kinds).toContain("user.registered");
    expect(kinds).toContain("nav.published");
  });

  async function seedHelper(app: TestEnv["app"], token: string): Promise<string> {
    const res = await app.request("/api/v1/bookmarks", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ url: "https://example.com/audit-seed", title: "audit-seed" }),
    });
    return ((await res.json()) as { id: string }).id;
  }
});
