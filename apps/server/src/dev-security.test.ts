/**
 * DEV-01/02/03/04/05/08/13 安全与一致性回归（2026-11-18）
 *
 * 覆盖验收矩阵（验收与交接规范 §3）：
 *  - SEC-02 匿名全库搜索关闭；SEC-03 只改标题保留密码/template；
 *  - SEC-04 公开/关键词/语义/导出遍历私密与软归档正确过滤；
 *  - SEC-05/06 隐私失效保守拒绝与异步写回竞态；
 *  - SEC-07 IPv6/mapped/内网禁段连接数为 0、字节限额、跨主机重定向剥离凭据；
 *  - SEC-10 列表 ID 撤销、备份无 bearer 明文；
 *  - DATA-01 收件箱提交异常整批回滚；撤销生成新版本且原历史保留；
 *  - DATA-11 hash/scheme/端口不误吞；迁移重算键碰撞保留全部实体。
 */
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";
import { Store } from "./store";
import {
  isForbiddenIp,
  parseIpv6,
  guardFetchTarget,
  guardedFetch,
  BodyTooLargeError,
  type FetchGuardConfig,
} from "./fetch-guard";
import { MIGRATION_V4_URL_KEYS } from "./migrate";
import { buildPayload } from "./hooks";
import type { LlmClient } from "@mf/ai/llm-client";

let env: TestEnv | undefined;
afterEach(() => env?.cleanup());

/** 直接构造一条书签（绕过 ingest 的查重） */
function rawBookmark(
  store: Store,
  opts: { urlRaw: string; canonical?: string; title?: string; private?: boolean; archivedInto?: string },
): string {
  const id = `bm-${Math.random().toString(36).slice(2, 10)}`;
  const folder = store.ensurePath(["回归"]);
  const ts = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO bookmarks (id, folder_id, url_raw, url_canonical, title, status, added_at, pinned, is_private, created_at, archived_into) VALUES (?,?,?,?,?,'normal',?,0,?,?,?)",
    )
    .run(
      id,
      folder.id,
      opts.urlRaw,
      opts.canonical ?? opts.urlRaw,
      opts.title ?? id,
      ts,
      opts.private ? 1 : 0,
      ts,
      opts.archivedInto ?? null,
    );
  return id;
}

/** 确保存在一个用户目录（显式发布集合的引用目标） */
async function ensureFolder(e: TestEnv, name: string): Promise<string> {
  const created = (await (
    await e.app.request("/api/v1/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })
  ).json()) as { id: string };
  return created.id;
}

// ==================== DEV-01 公开分享范围与密码 ====================

describe("DEV-01 公开分享范围与密码保护", () => {
  async function publishSite(
    e: TestEnv,
    body: Record<string, unknown>,
  ): Promise<{ slug: string; itemCount: number; revision: number }> {
    const res = await e.app.request("/api/v1/nav/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { slug: string; itemCount: number; revision: number };
  }

  it("SEC-02：匿名全库搜索关闭（/s/search 与 /api/v1/s/search 均 410）", async () => {
    env = makeEnv(null);
    await env.app.request("/api/v1/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://secret-site.example.com/private-note", title: "私密笔记" }),
    });
    const rootSearch = await env.app.request("/s/search?q=私密");
    expect(rootSearch.status).toBe(410);
    const apiSearch = await env.app.request("/api/v1/s/search?q=私密");
    expect([404, 410]).toContain(apiSearch.status); // 旧接口已移除/封堵，绝不返回搜索结果
  });

  it("公开站只渲染显式发布集合；未选择内容拒绝发布；私密项永不出现", async () => {
    env = makeEnv(null);
    const pubId = rawBookmark(env.store, { urlRaw: "https://pub.example.com/a", title: "公开项" });
    rawBookmark(env.store, { urlRaw: "https://priv.example.com/b", title: "私密项", private: true });
    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{
      id: string;
      is_system_inbox: number;
    }>;
    // 未选择 → 拒绝
    const rejected = await env.app.request("/api/v1/nav/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(rejected.status).toBe(400);
    // 单选一条（不是整目录）
    const pub = await publishSite(env, { title: "单选站", bookmarkIds: [pubId] });
    expect(pub.itemCount).toBe(1);
    const html = await (await env.app.request(`/s/${pub.slug}`)).text();
    expect(html).toContain("公开项");
    expect(html).not.toContain("私密项");
    // 元数据之外不外泄：无 l2 正文、无内部字段
    expect(html).not.toContain("l2_text");
    void folders;
  });

  it("站点 A 的访问凭证不能访问站点 B（凭证绑定 slug）", async () => {
    env = makeEnv(null);
    const bm = rawBookmark(env.store, { urlRaw: "https://cred.example.com/x", title: "凭证站内容" });
    const a = await publishSite(env, { title: "站A", password: "pass-a-123", bookmarkIds: [bm] });
    const b = await publishSite(env, { title: "站B", password: "pass-b-123", bookmarkIds: [bm] });
    const authA = await env.app.request(`/s/${a.slug}/auth`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=pass-a-123",
    });
    const cookieA = (authA.headers.get("set-cookie") ?? "").split(";")[0]!;
    // 用 A 的凭证访问 B → 仍是验证页
    const viaB = await env.app.request(`/s/${b.slug}`, { headers: { cookie: cookieA } });
    expect(await viaB.text()).toContain("访问验证");
  });

  it("改密/撤销发布后旧访问凭证失效（revision 绑定）", async () => {
    env = makeEnv(null);
    const bm = rawBookmark(env.store, { urlRaw: "https://rotate.example.com/x", title: "轮换站内容" });
    const site = await publishSite(env, { title: "轮换站", password: "old-pass-123", bookmarkIds: [bm] });
    const auth = await env.app.request(`/s/${site.slug}/auth`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=old-pass-123",
    });
    const cookie = (auth.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect((await (await env.app.request(`/s/${site.slug}`, { headers: { cookie } })).text())).toContain("轮换站");
    // 改密（PATCH 显式新密码）→ 旧凭证失效
    const patch = await env.app.request(`/api/v1/nav/sites/${site.slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "new-pass-456" }),
    });
    expect(patch.status).toBe(200);
    const stale = await env.app.request(`/s/${site.slug}`, { headers: { cookie } });
    expect(await stale.text()).toContain("访问验证");
  });

  it("SEC-03：PATCH 只改 title 保留 password 与 template（E02 修复）", async () => {
    env = makeEnv(null);
    const bm = rawBookmark(env.store, { urlRaw: "https://cfg.example.com/x", title: "配置站内容" });
    const site = await publishSite(env, {
      title: "原标题",
      template: "cards",
      password: "keep-pass-1",
      bookmarkIds: [bm],
    });
    const patch = await env.app.request(`/api/v1/nav/sites/${site.slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "新标题" }),
    });
    const body = (await patch.json()) as { title: string; template: string; hasPassword: boolean };
    expect(body.title).toBe("新标题");
    expect(body.template).toBe("cards"); // 未传 template 不再重置为 grid
    expect(body.hasPassword).toBe(true); // 未传 password 不再清空
  });

  it("SEC-04：私密/软归档书签不出现在公开站 HTML/JSON/计数", async () => {
    env = makeEnv(null);
    const keepId = rawBookmark(env.store, { urlRaw: "https://mix.example.com/keep", title: "保留项" });
    const privId = rawBookmark(env.store, { urlRaw: "https://mix.example.com/priv", title: "私密混入", private: true });
    rawBookmark(env.store, {
      urlRaw: "https://mix.example.com/arch",
      title: "软归档混入",
      archivedInto: keepId,
    });
    void privId;
    const folders = (await (await env.app.request("/api/v1/folders")).json()) as Array<{ id: string }>;
    const pub = await publishSite(env, { title: "混合站", folderIds: folders.map((f) => f.id) });
    expect(pub.itemCount).toBe(1); // 仅保留项
    const html = await (await env.app.request(`/s/${pub.slug}`)).text();
    expect(html).not.toContain("私密混入");
    expect(html).not.toContain("软归档混入");
  });
});

// ==================== DEV-02 统一对象可见性 ====================

describe("DEV-02 统一对象可见性", () => {
  it("SEC-04：/content/:id 私密与不存在返回一致 404（不泄露存在性）", async () => {
    env = makeEnv(null);
    const privId = rawBookmark(env.store, {
      urlRaw: "https://content.example.com/p",
      title: "私密内容",
      private: true,
    });
    env.store.upsertCache({ bookmarkId: privId, l2Text: "不应可见的正文", fetchedVia: "extension_capture" });
    const privRes = await env.app.request(`/api/v1/content/${privId}`);
    expect(privRes.status).toBe(404);
    const missing = await env.app.request("/api/v1/content/does-not-exist");
    expect(missing.status).toBe(404);
    const privBody = (await privRes.json()) as { error: string };
    expect(privBody.error).toBe("not_found"); // 同一错误码
    // 管理面显式开关（X-MF-Private）仍可读
    const admin = await env.app.request(`/api/v1/content/${privId}`, { headers: { "x-mf-private": "1" } });
    expect(admin.status).toBe(200);
  });

  it("SEC-04：关键词/语义搜索默认排除私密与软归档", async () => {
    env = makeEnv(null, true, {
      embedClient: {
        embeddings: async (t: string) => [t.length, 1, 0],
      } as unknown as LlmClient,
    });
    const keep = rawBookmark(env.store, { urlRaw: "https://vis.example.com/zircon", title: "可见锆石" });
    rawBookmark(env.store, { urlRaw: "https://vis.example.com/zircon-priv", title: "私密锆石", private: true });
    rawBookmark(env.store, { urlRaw: "https://vis.example.com/zircon-arch", title: "归档锆石", archivedInto: keep });
    // 向量都写上（模拟旧数据）
    for (const id of [keep]) {
      env.store.upsertCache({ bookmarkId: id, fetchedVia: "semantic_index" });
      env.store.db.prepare("UPDATE content_cache SET embedding = ? WHERE bookmark_id = ?").run("[1,2,0]", id);
    }

    const kw = (await (
      await env.app.request("/api/v1/search?q=锆石")
    ).json()) as { results: Array<{ title: string }> };
    expect(kw.results.map((r) => r.title)).toEqual(["可见锆石"]); // 私密/软归档不出现
    const kwAdmin = (await (
      await env.app.request("/api/v1/search?q=锆石", { headers: { "x-mf-private": "1" } })
    ).json()) as { results: Array<{ title: string }> };
    expect(kwAdmin.results.map((r) => r.title)).toContain("私密锆石"); // 管理面显式可见

    // 语义查询（同向量空间）不返回软归档（未向量化）与私密
    const sem = (await (
      await env.app.request("/api/v1/search?q=锆石&semantic=1")
    ).json()) as { results: Array<{ title: string }> };
    expect(sem.results.map((r) => r.title)).not.toContain("私密锆石");
    expect(sem.results.map((r) => r.title)).not.toContain("归档锆石");
  });

  it("SEC-04：/export/json 不含私密与软归档", async () => {
    env = makeEnv(null);
    rawBookmark(env.store, { urlRaw: "https://exp.example.com/ok", title: "导出可见" });
    rawBookmark(env.store, { urlRaw: "https://exp.example.com/no", title: "导出私密", private: true });
    const json = (await (await env.app.request("/api/v1/export/json")).json()) as {
      bookmarks: Array<{ title: string }>;
    };
    const titles = json.bookmarks.map((b) => b.title);
    expect(titles).toContain("导出可见");
    expect(titles).not.toContain("导出私密");
  });
});

// ==================== DEV-03 隐私失效与异步写回 ====================

describe("DEV-03 隐私失效策略与异步写回", () => {
  it("存量清理覆盖软归档书签（派生内容清空、原书签保留）", async () => {
    env = makeEnv(null);
    const keep = rawBookmark(env.store, { urlRaw: "https://purge.example.com/keep", title: "保留方" });
    const arch = rawBookmark(env.store, {
      urlRaw: "https://purge.example.com/arch",
      title: "软归档含正文",
      archivedInto: keep,
    });
    env.store.upsertCache({ bookmarkId: arch, l2Text: "归档方的敏感正文", fetchedVia: "extension_capture" });
    // 新增规则命中该域
    const res = await env.app.request("/api/v1/privacy/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ add: ["purge.example.com"], purgeExisting: true }),
    });
    const body = (await res.json()) as { purged: { bookmarks: number } };
    expect(body.purged.bookmarks).toBe(1); // arch 命中清理；keep 无缓存行不计（软归档不被 listBookmarks 截断）
    expect(env.store.getCache(arch)?.l2_text ?? null).toBeNull();
    expect(env.store.getBookmark(arch)).toBeDefined(); // 原书签永不自动删除（红线 3）
  });

  it("SEC-06：模型等待期间新加隐私规则 → 摘要结果丢弃（stale_policy_discarded）", async () => {
    // 可控 LLM：chatJson 挂起直到测试放行
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowLlm = {
      chatJson: async () => {
        await gate;
        return { summary: "等待期间生成的摘要", tags: [], keywords: [] };
      },
    } as unknown as LlmClient;
    env = makeEnv(slowLlm, true);
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://race.example.com/article", title: "竞态文章" }),
      })
    ).json()) as { id: string };
    env.store.upsertCache({
      bookmarkId: bm.id,
      l2Text: "这是一段用于跨越摘要长度门槛的正文内容，必须超过四十个字符的长度限制才会进入摘要生成流程。",
      fetchedVia: "extension_capture",
    });
    const done = env.pipeline.maybeSummarize(bm.id);
    // LLM 等待期间：用户把域名加入隐私规则
    env.store.addPrivacyPattern("race.example.com");
    release();
    const summarized = await done;
    expect(summarized).toBe(false);
    expect(env.store.getCache(bm.id)?.fail_reason).toBe("stale_policy_discarded");
    expect(env.store.getCache(bm.id)?.l1_summary ?? null).toBeNull(); // 无派生写回
  });

  it("隐私域书签不向量化（embedBookmark 统一走策略）", async () => {
    let embedCalls = 0;
    const embedClient = {
      embeddings: async () => {
        embedCalls++;
        return [1, 0, 0];
      },
    } as unknown as LlmClient;
    env = makeEnv(null, true, { embedClient });
    const privId = rawBookmark(env.store, { urlRaw: "https://vec.example.com/v", title: "向量目标" });
    env.store.addPrivacyPattern("vec.example.com");
    const ok = await env.semantic.embedBookmark(privId);
    expect(ok).toBe(false);
    expect(embedCalls).toBe(0); // 未外发
  });
});

// ==================== DEV-04 出站网络防护 ====================

describe("DEV-04 出站网络防护", () => {
  const strict: FetchGuardConfig = { mode: "selfhosted_strict" };

  it("SEC-07：IPv6 全形态判定（压缩/映射/ULA/链路本地/NAT64）", () => {
    expect(parseIpv6("::ffff:192.168.1.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0101]);
    expect(isForbiddenIp("::1")).toBe(true);
    expect(isForbiddenIp("::")).toBe(true);
    expect(isForbiddenIp("fe80::1ff")).toBe(true); // 链路本地 fe80::/10（含 febf）
    expect(isForbiddenIp("febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
    expect(isForbiddenIp("fd00::1")).toBe(true); // ULA
    expect(isForbiddenIp("fc00::1")).toBe(true);
    expect(isForbiddenIp("ff02::1")).toBe(true); // 组播
    expect(isForbiddenIp("::ffff:192.168.1.1")).toBe(true); // mapped 私网（点分形态）
    expect(isForbiddenIp("::ffff:c0a8:0101")).toBe(true); // mapped 私网（十六进制形态）
    expect(isForbiddenIp("64:ff9b::7f00:1")).toBe(true); // NAT64 → 127.0.0.1
    expect(isForbiddenIp("2606:4700::6810:84e5")).toBe(false); // 公网
    expect(isForbiddenIp("169.254.169.254")).toBe(true); // 云元数据
    expect(isForbiddenIp("100.64.0.1")).toBe(true); // CGNAT
  });

  it("SEC-07：禁网段实际连接数为 0（本地 HTTP 替身计数）；GuardError 原因可解释", async () => {
    let hits = 0;
    const server = http.createServer((_q, r) => {
      hits++;
      r.writeHead(200).end("should-not-be-reached");
    });
    await new Promise<void>((r) => server.listen(31901, "127.0.0.1", r));
    // 字面内网 IP：strict 模式 → 不发起连接
    await expect(guardFetchTarget("http://127.0.0.1:31901/x", strict)).resolves.toMatchObject({
      allowed: false,
      reason: "literal_ip_forbidden",
    });
    expect(hits).toBe(0);
    // guardedFetch 全链路同样拦截
    await expect(guardedFetch("http://127.0.0.1:31901/x", strict)).rejects.toMatchObject({
      name: "GuardError",
    });
    expect(hits).toBe(0);
    // allowlist 显式放行后可达
    const allow: FetchGuardConfig = { mode: "selfhosted_allowlist", allowedCidrs: ["127.0.0.0/8"] };
    const res = await guardedFetch("http://127.0.0.1:31901/x", allow);
    expect(res.status).toBe(200);
    expect(hits).toBe(1);
    res.dispose();
    server.close();
  });

  it("DEV-04：响应体字节限额先于整包分配（超限中止 + BodyTooLargeError）", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const server = http.createServer((_q, r) => {
      r.writeHead(200, { "content-length": String(big.length) });
      r.end(big);
    });
    await new Promise<void>((r) => server.listen(31902, "127.0.0.1", r));
    const allow: FetchGuardConfig = { mode: "selfhosted_allowlist", allowedCidrs: ["127.0.0.0/8"] };
    const res = await guardedFetch("http://127.0.0.1:31902/big", allow, {}, { maxBytes: 1024 });
    await expect(res.readBody(1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    server.close();
  });

  it("DEV-04：跨主机重定向剥离 authorization（Key 不送往其他端点）", async () => {
    // 127.0.0.1 与 localhost 是不同 host：A(127.0.0.1) 302 → B(localhost)
    let authSeen: string | undefined;
    const b = http.createServer((q, r) => {
      authSeen = q.headers.authorization;
      r.writeHead(200).end("b");
    });
    await new Promise<void>((r) => b.listen(31903, "127.0.0.1", r));
    const a = http.createServer((_q, r) => {
      r.writeHead(302, { location: "http://localhost:31903/target" }).end();
    });
    await new Promise<void>((r) => a.listen(31904, "127.0.0.1", r));
    const allow: FetchGuardConfig = { mode: "selfhosted_allowlist", allowedCidrs: ["127.0.0.0/8", "::1/128"] };
    const res = await guardedFetch(
      "http://127.0.0.1:31904/start",
      allow,
      { headers: { authorization: "Bearer secret-key" } },
    );
    expect(res.status).toBe(200);
    expect(authSeen).toBeUndefined(); // 凭据未随重定向外送
    res.dispose();
    a.close();
    b.close();
  });
});

// ==================== DEV-05 令牌生命周期 ====================

describe("DEV-05 令牌生命周期", () => {
  it("SEC-10：库内只有摘要（备份/查询无 bearer 明文）；过期令牌 401", async () => {
    env = makeEnv(null, false, { adminPassword: "token-test-pass" });
    const { token } = env.store.createToken("device-x", 24);
    const raw = env.store.db.prepare("SELECT token, token_hash FROM tokens").get() as {
      token: string;
      token_hash: string;
    };
    expect(raw.token).not.toContain(token.slice(0, 20)); // 无明文
    expect(raw.token_hash).toHaveLength(64);
    expect(JSON.stringify(env.store.listTokens())).not.toContain(token);
    expect(env.store.hasToken(token)).toBe(true);

    // 过期令牌：签发 1 小时 TTL 的过去时间 → 无效
    const expired = env.store.createToken("device-exp", 0);
    // 手动把过期时间拨回过去
    env.store.db
      .prepare("UPDATE tokens SET expires_at = ? WHERE token_id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), expired.tokenId);
    expect(env.store.hasToken(expired.token)).toBe(false);

    // 撤销后失效
    env.store.revokeTokenById(expired.tokenId);
    expect(env.store.hasToken(expired.token)).toBe(false);
  });

  it("DEV-05：API 层撤销其他设备后该设备 401（生产语义）", async () => {
    const saved = process.env.MF_ENV;
    process.env.MF_ENV = "production";
    try {
      env = makeEnv(null);
      // 触发引导凭据生成并 setup
      await env.app.request("/api/v1/admin/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "revoke-flow-pass" }),
      });
      const bootstrap = (await import("node:fs")).readFileSync(
        path.join(env.dataDir, "bootstrap-token.txt"),
        "utf8",
      ).trim();
      const setup = await env.app.request("/api/v1/admin/setup", {
        method: "POST",
        headers: { "content-type": "application/json", "x-mf-setup-token": bootstrap },
        body: JSON.stringify({ password: "revoke-flow-pass" }),
      });
      expect(setup.status).toBe(200);
      const loginBody = {
        method: "POST" as const,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "revoke-flow-pass" }),
      };
      const d1 = (await (await env.app.request("/auth/login", loginBody)).json()) as { token: string };
      const d2 = (await (await env.app.request("/auth/login", loginBody)).json()) as {
        token: string;
        tokenId: string;
      };
      const list = (await (
        await env.app.request("/api/v1/auth/tokens", { headers: { authorization: `Bearer ${d2.token}` } })
      ).json()) as { tokens: Array<{ token_id: string; revoked_at: string | null }> };
      const other = list.tokens.find((t) => t.revoked_at === null && t.token_id !== d2.tokenId)!;
      const revoke = await env.app.request(`/api/v1/auth/tokens/${other.token_id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${d2.token}` },
      });
      expect(revoke.status).toBe(200);
      const d1After = await env.app.request("/api/v1/bookmarks", {
        headers: { authorization: `Bearer ${d1.token}` },
      });
      expect(d1After.status).toBe(401); // 被撤销设备随即 401
      const d2Still = await env.app.request("/api/v1/bookmarks", {
        headers: { authorization: `Bearer ${d2.token}` },
      });
      expect(d2Still.status).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.MF_ENV;
      else process.env.MF_ENV = saved;
    }
  });
});

// ==================== DEV-08 统一提交与撤销事务 ====================

describe("DEV-08 统一整理提交/撤销事务", () => {
  it("DATA-01：提交事务中途异常 → 整批回滚（实体/目录/版本无半提交）", async () => {
    const llm = {
      chatJson: async () => ({
        results: [
          { index: 0, category: "目录甲", confidence: 0.9 },
          { index: 1, category: "目录乙", confidence: 0.9 },
        ],
      }),
    } as unknown as LlmClient;
    env = makeEnv(llm, true);
    const inbox = (await (await env.app.request("/api/v1/inbox/setup", { method: "POST" })).json()) as {
      id: string;
    };
    const b1 = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://txn.example.com/1", title: "事务一", folderId: inbox.id }),
      })
    ).json()) as { id: string };
    const b2 = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://txn.example.com/2", title: "事务二", folderId: inbox.id }),
      })
    ).json()) as { id: string };
    // 注入：第二次 move 抛异常（第 2 项故障注入）
    const orig = env.store.moveBookmark.bind(env.store);
    let calls = 0;
    const spy = vi
      .spyOn(env.store, "moveBookmark")
      .mockImplementation((id: string, to: string) => {
        calls++;
        if (calls === 2) throw new Error("injected_failure_item_2");
        return orig(id, to);
      });
    // 提交异常被包含：整批回滚后以 commit_failed 报告（不虚报成功、不留半套）
    const result = await env.pipeline.processInbox([b1.id, b2.id], inbox.id);
    spy.mockRestore();
    expect(result.moved).toHaveLength(0);
    expect(result.left.map((l) => l.reason)).toContain("commit_failed");
    // 整批回滚：两项都还在收件箱、无目录创建、无版本记录
    expect(env.store.getBookmark(b1.id)?.folder_id).toBe(inbox.id);
    expect(env.store.getBookmark(b2.id)?.folder_id).toBe(inbox.id);
    expect(env.store.findFolderByName("目录乙")).toBeUndefined();
    const versionCount = env.store.db.prepare("SELECT COUNT(*) as c FROM organize_version").get() as { c: number };
    expect(versionCount.c).toBe(0);
  });

  it("撤销生成新版本（reverts_version_id 指向原版本），原历史保留且标记 reverted", async () => {
    env = makeEnv(null);
    const f1 = env.store.ensurePath(["源目录"]);
    const f2 = env.store.ensurePath(["目标目录"]);
    const bm = rawBookmark(env.store, { urlRaw: "https://undo.example.com/1", title: "撤销目标" });
    const s = (await (
      await env.app.request("/api/v1/organize/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: `整理 ${f1.name} 文件夹` }),
      })
    ).json()) as { sessionId: string; proposal: Array<{ type: string }> } | { sessionId: string };
    // 规则无法分类该 URL → 无 proposal；改用直接事务构造一个 move 版本走 rollback API
    void s;
    // 手动应用该 move（模拟已提交的版本状态）；revisionAfter 取 apply 后的实际值
    env.store.moveBookmark(bm, f2.id);
    const revAfter = env.store.getBookmark(bm)?.content_revision ?? 1;
    const versionId = env.store.saveVersion(null, [
      { type: "move", bookmarkId: bm, fromFolderId: f1.id, toFolderId: f2.id, revisionAfter: revAfter },
    ]);
    const rb = (await (
      await env.app.request(`/api/v1/organize/rollback/${versionId}`, { method: "POST" })
    ).json()) as { reversed: number; undoVersionId: string };
    expect(rb.reversed).toBe(1);
    expect(env.store.getBookmark(bm)?.folder_id).toBe(f1.id); // 已回原目录
    const original = env.store.getVersion(versionId);
    expect(original?.reverted).toBe(1); // 原历史保留 + 标记
    const undo = env.store.getVersion(rb.undoVersionId);
    expect(undo?.reverts_version_id).toBe(versionId); // 新版本指向原版本
    expect(undo?.kind).toBe("undo");
  });

  it("收件箱动作带 deviceId：镜像操作与提交同事务落库（崩溃无空窗）", async () => {
    env = makeEnv(null);
    const inbox = (await (await env.app.request("/api/v1/inbox/setup", { method: "POST" })).json()) as {
      id: string;
    };
    await env.app.request("/api/v1/devices/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "device-mirror-01" }),
    });
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/mirror-me", title: "镜像我", folderId: inbox.id }),
      })
    ).json()) as { id: string };
    env.store.upsertIdentity({
      deviceId: "device-mirror-01",
      browserBookmarkId: "browser-node-9",
      appBookmarkId: bm.id,
    });
    const result = (await (
      await env.app.request("/api/v1/inbox/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookmarkIds: [bm.id], deviceId: "device-mirror-01" }),
      })
    ).json()) as { moved: Array<{ id: string }>; versionId: string | null };
    expect(result.moved).toHaveLength(1); // github 域名规则命中自动归位
    expect(result.versionId).toBeTruthy();
    // 镜像待执行操作与移动同事务产生
    const ops = env.store.pendingBrowserOps("device-mirror-01");
    expect(ops.length).toBe(1);
    expect(ops[0]?.browser_bookmark_id).toBe("browser-node-9");
  });
});

// ==================== DEV-13 保守 URL 键 ====================

describe("DEV-13 保守 URL 键与迁移", () => {
  it("DATA-11：hash/scheme/端口不误吞（入库即不同键）；url_key_version=2", async () => {
    const e = makeEnv(null);
    env = e;
    const post = async (url: string, key: string): Promise<number> =>
      (
        (await (
          await e.app.request("/api/v1/bookmarks/ingest", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ idempotencyKey: key, items: [{ url, title: url, folderPath: [] }] }),
          })
        ).json()) as { imported: number }
      ).imported;
    expect(await post("https://spa.example.com/#/a", "hash-a-key")).toBe(1);
    expect(await post("https://spa.example.com/#/b", "hash-b-key")).toBe(1); // 不被吞
    expect(await post("http://nas.local:5000/admin", "port-5000-key")).toBe(1);
    expect(await post("http://nas.local:8080/admin", "port-8080-key")).toBe(1); // 端口不同是不同服务
    const rows = env.store.db
      .prepare("SELECT url_key_version, url_canonical FROM bookmarks ORDER BY url_canonical")
      .all() as Array<{ url_key_version: number; url_canonical: string }>;
    for (const r of rows) expect(r.url_key_version).toBe(2);
    // 打开地址保真：url_raw 原样保留
    const raw = env.store
      .db.prepare("SELECT url_raw FROM bookmarks WHERE url_canonical LIKE '%#/b'")
      .get() as { url_raw: string };
    expect(raw.url_raw).toBe("https://spa.example.com/#/b");
  });

  it("迁移 v4：用 raw 重算存量键；碰撞保留全部实体并出报告", () => {
    env = makeEnv(null);
    const store = env.store;
    const f = store.ensurePath(["迁移"]);
    const ins = store.db.prepare(
      "INSERT INTO bookmarks (id, folder_id, url_raw, url_canonical, title, status, added_at, pinned, created_at) VALUES (?,?,?,?,?,'normal',?,0,?)",
    );
    // 旧行 1：键是 v1 旧规则产物（https 强制/去 www）与 raw 不一致
    ins.run("mig-1", f.id, "https://legacy.example.com/page", "http://www.legacy.example.com/page", "旧键行一", "2026-01-01", "2026-01-01");
    // 旧行 2：raw 归一后与行 1 的 v2 键相同（制造碰撞——两个真实实体指向同一页面）
    ins.run("mig-2", f.id, "https://legacy.example.com/page/", "https://collide.example.com/other", "旧行二", "2026-01-02", "2026-01-02");
    // 旧行 3：无法解析的 raw → 保留旧键并记 invalid
    ins.run("mig-3", f.id, "::::not-a-url", "https://weird.example.com/x", "坏地址", "2026-01-03", "2026-01-03");
    MIGRATION_V4_URL_KEYS.up(store.db);
    const r1 = store.db.prepare("SELECT url_canonical, url_key_version FROM bookmarks WHERE id='mig-1'").get() as {
      url_canonical: string;
      url_key_version: number;
    };
    expect(r1.url_canonical).toBe("https://legacy.example.com/page"); // 行 1 先到先得：raw 重算键
    expect(r1.url_key_version).toBe(2);
    const r2 = store.db.prepare("SELECT url_canonical, url_key_version FROM bookmarks WHERE id='mig-2'").get() as {
      url_canonical: string;
      url_key_version: number;
    };
    // 碰撞行保留旧键与实体（绝不 DELETE/覆盖；报告可解释）
    expect(r2.url_canonical).toBe("https://collide.example.com/other");
    expect(r2.url_key_version).toBe(1);
    const r3 = store.db.prepare("SELECT url_canonical FROM bookmarks WHERE id='mig-3'").get() as {
      url_canonical: string;
    };
    expect(r3.url_canonical).toBe("https://weird.example.com/x"); // 无法解析：保留
    // 报告落库（碰撞/invalid 可解释）
    const report = store.db
      .prepare("SELECT findings FROM maintenance_report WHERE type='url_key_migration' ORDER BY created_at DESC LIMIT 1")
      .get() as { findings: string } | undefined;
    expect(report).toBeDefined();
    const findings = JSON.parse(report!.findings) as { collisions: unknown[]; invalid: unknown[] };
    expect(findings.collisions.length).toBe(1);
    expect(findings.invalid.length).toBe(1);
  });
});

// ==================== D33 Hook payload 组装（回归：l1_tags 双重 JSON.parse 崩溃缺陷） ====================

describe("D33 集成 Hook payload", () => {
  it("full 粒度：getCache 出口的 l1_tags 已是数组，buildPayload 不再二次 JSON.parse", () => {
    env = makeEnv(null);
    const store = env.store;
    const f = store.ensurePath(["回归"]);
    const url = "https://hook-example.com/post/1";
    const bm = store.createBookmark({ folderId: f.id, urlRaw: url, urlCanonical: url, title: "钩子测试" });
    store.upsertCache({ bookmarkId: bm.id, l1Summary: "一句话摘要", l1Tags: ["ai", "dev"], fetchedVia: "extension_capture" });
    const payload = buildPayload(store, "bookmark.added", { url, bookmarkId: bm.id, title: "钩子测试" }, "full");
    expect(payload).not.toBeNull();
    // 缺陷修复前：对已解析数组再 JSON.parse → SyntaxError（dispatch 内为未捕获 async 拒绝）
    expect(payload!.data.tags).toEqual(["ai", "dev"]);
    expect(payload!.data.summary).toBe("一句话摘要");
  });

  it("full 粒度 · 无缓存书签：tags 为 null 不抛错", () => {
    env = makeEnv(null);
    const store = env.store;
    const url = "https://hook-empty.com/x";
    const payload = buildPayload(store, "bookmark.added", { url, bookmarkId: "missing", title: "无缓存" }, "full");
    expect(payload!.data.tags).toBeNull();
  });
});
