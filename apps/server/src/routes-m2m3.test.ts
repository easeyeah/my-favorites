/** M2/M3：鉴权/同步/死链/查重/体检/语义/BYOK/偏好/模板/密码/配额/私密/迁移 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

async function seed(env: TestEnv): Promise<void> {
  await env.app.request("/api/v1/bookmarks/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "seed-m2m3",
      items: [
        { url: "https://github.com/rust", title: "Rust 仓库", folderPath: ["开发"] },
        { url: "https://github.com/go", title: "Go 仓库", folderPath: ["开发"] },
        { url: "https://bilibili.com", title: "哔哩哔哩", folderPath: ["娱乐"] },
        // 近重复组（同域同名）
        { url: "https://dup.example.com/one", title: "重复页", folderPath: ["杂项"] },
        { url: "https://dup.example.com/two", title: "重复页", folderPath: ["杂项"] },
      ],
    }),
  });
}

describe("鉴权（F6.2 ADMIN_PASSWORD）", () => {
  it("启用后：未带 token 全部 401；登录后放行", async () => {
    env = makeEnv(null, false, { adminPassword: "secret-123" });
    await seed(env);
    const noAuth = await env.app.request("/api/v1/bookmarks");
    expect(noAuth.status).toBe(401);

    const badLogin = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(badLogin.status).toBe(401);

    const goodLogin = await env.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "secret-123", label: "e2e" }),
    });
    const { token } = (await goodLogin.json()) as { token: string };
    expect(token).toHaveLength(64);

    const ok = await env.app.request("/api/v1/bookmarks", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);

    // 公开路由不受鉴权影响
    expect((await env.app.request("/healthz")).status).toBe(200);
  });

  it("未启用：保持无鉴权（向后兼容本地开发）", async () => {
    env = makeEnv();
    expect((await env.app.request("/api/v1/bookmarks")).status).toBe(200);
  });
});

describe("多端同步（F1.7）", () => {
  it("变更入 change log；device B 按 cursor 增量拉取且看不到自己的", async () => {
    env = makeEnv();
    await seed(env); // 产生的变更记录 device=null
    await env.app.request("/api/v1/inbox/setup", { method: "POST" });

    const pull = (await (
      await env.app.request("/api/v1/sync/pull?cursor=0&device=device-b")
    ).json()) as {
      items: Array<{ entity: string; op: string; device: string | null }>;
      cursor: number;
    };
    expect(pull.items.length).toBeGreaterThan(5);
    expect(pull.cursor).toBeGreaterThan(0);

    // device-a push 两条
    const push = (await (
      await env.app.request("/api/v1/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device: "device-a",
          changes: [
            { entity: "bookmark", entity_id: "x1", op: "upsert", payload: { title: "x1" } },
            { entity: "bookmark", entity_id: "x2", op: "delete", payload: null },
          ],
        }),
      })
    ).json()) as { applied: number; cursor: number };
    expect(push.applied).toBe(2);

    // device-b 拉取增量（含 device-a 的，不含自己的）
    const pull2 = (await (
      await env.app.request(`/api/v1/sync/pull?cursor=${pull.cursor}&device=device-b`)
    ).json()) as { items: Array<{ device: string | null }> };
    expect(pull2.items.length).toBe(2);
    expect(pull2.items.every((i) => i.device === "device-a")).toBe(true);
  });
});

describe("死链检测 + 查重 + 体检（F5）", () => {
  it("三级判定：本地可达=normal，不可达端口=dead", async () => {
    // 本地"正常站"
    const okServer = http.createServer((_q, r) => {
      r.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => okServer.listen(31801, r));

    env = makeEnv();
    await env.app.request("/api/v1/bookmarks/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "seed-links",
        items: [
          { url: "http://127.0.0.1:31801/alive", title: "可达页", folderPath: [] },
          { url: "http://127.0.0.1:59997/dead", title: "死链页", folderPath: [] },
        ],
      }),
    });
    const res = await env.app.request("/api/v1/maintenance/links/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 10 }),
    });
    const body = (await res.json()) as {
      checked: number;
      results: Array<{ verdict: string; url: string }>;
      reportId: string;
    };
    expect(body.checked).toBe(2);
    const alive = body.results.find((r) => r.url.includes("alive"));
    const dead = body.results.find((r) => r.url.includes("59997"));
    expect(alive?.verdict).toBe("normal");
    expect(dead?.verdict).toBe("dead");

    // 状态落库 + 周报可取
    const report = (await (
      await env.app.request("/api/v1/maintenance/report/latest?type=link_check")
    ).json()) as { findings: { dead: number } };
    expect(report.findings.dead).toBe(1);
    okServer.close();
  });

  it("查重扫描产出合并建议（不自动删除，红线 3）", async () => {
    env = makeEnv();
    await seed(env);
    const res = await env.app.request("/api/v1/maintenance/duplicates/run", { method: "POST" });
    const body = (await res.json()) as { groups: number; suggestions: Array<{ keep: string; dupes: string[] }> };
    expect(body.groups).toBe(1);
    expect(body.suggestions[0]?.dupes).toHaveLength(1);
    // 库内仍 5 条（未自动删除）
    const all = (await (await env.app.request("/api/v1/bookmarks")).json()) as unknown[];
    expect(all.length).toBe(5);
  });

  it("体检报告 JSON（概览数据源；D21 删除 HTML 获客页）", async () => {
    env = makeEnv();
    await seed(env);
    const json = (await (
      await env.app.request("/api/v1/health-report")
    ).json()) as { duplicates: number };
    expect(json.duplicates).toBe(1);
    // D21（2026-11-18）：公开 HTML 获客页已删除——API 保留（管理台概览数据源）
    const page = await env.app.request("/health-report");
    expect(page.status).toBe(404);
  });
});

describe("语义搜索 + BYOK（F7.2 / F3.7）", () => {
  const embedClient = {
    embeddings: async (text: string) => {
      // 确定性词袋向量：语义相近文本向量相近
      const dict = ["rust", "go", "github", "video", "bilibili", "开发"];
      const v = dict.map((w) => (text.toLowerCase().includes(w) ? 1 : 0));
      return v;
    },
  } as unknown as import("@mf/ai/llm-client").LlmClient;

  it("语义搜索：内容向量命中（且排除私密书签）", async () => {
    env = makeEnv(null, true, { embedClient });
    await seed(env);
    const all = (await (await env.app.request("/api/v1/bookmarks")).json()) as Array<{
      id: string;
      title: string;
    }>;
    // 手动向量化（真实流程由 capture 触发）
    for (const b of all) {
      await env.semantic.embedBookmark(b.id);
    }
    const res = await env.app.request("/api/v1/search?q=rust&semantic=1");
    const body = (await res.json()) as { mode: string; results: Array<{ title: string }> };
    expect(body.mode).toBe("semantic");
    expect(body.results.some((r) => r.title === "Rust 仓库")).toBe(true);
    expect(body.results.every((r) => r.title !== "哔哩哔哩")).toBe(true);
  });

  it("BYOK 供应商配置：保存/列表脱敏/测试端点", async () => {
    env = makeEnv();
    const save = (await (
      await env.app.request("/api/v1/settings/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "deepseek",
          baseUrl: "http://127.0.0.1:31809/v1",
          apiKey: "sk-secret",
          purposeModels: { organize: "deepseek-chat", embedding: "deepseek-emb" },
        }),
      })
    ).json()) as { id: string };
    expect(save.id).toBeTruthy();

    const list = (await (await env.app.request("/api/v1/settings/providers")).json()) as Array<{
      provider_id: string;
      api_key: string | null;
      purpose_models: Record<string, string>;
    }>;
    expect(list[0]?.provider_id).toBe("deepseek");
    expect(list[0]?.api_key).toBe("********"); // 脱敏
    expect(list[0]?.purpose_models["organize"]).toBe("deepseek-chat");

    // 测试端点：不可达 → ok:false（不抛 500）
    const test = (await (
      await env.app.request("/api/v1/settings/providers/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "http://127.0.0.1:59998/v1", apiKey: "x" }),
      })
    ).json()) as { ok: boolean };
    expect(test.ok).toBe(false);
  });

  it("偏好记忆：apply 记录采纳目录，prefs 可查", async () => {
    env = makeEnv(null);
    await seed(env);
    const session = (await (
      await env.app.request("/api/v1/organize/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "整理" }),
      })
    ).json()) as { sessionId: string };
    await env.app.request(`/api/v1/organize/sessions/${session.sessionId}/apply`, { method: "POST" });
    const prefs = (await (await env.app.request("/api/v1/settings/prefs")).json()) as {
      topCategories: string[];
    };
    // github 种子本就在「开发」目录（无移动提案），bilibili 从「娱乐」→「视频」被采纳
    expect(prefs.topCategories).toContain("视频");
  });
});

describe("导航模板 + 密码访问（F4.2/F4.4）", () => {
  it.each(["grid", "list", "cards", "home"] as const)("%s 模板渲染", async (template) => {
    env = makeEnv();
    await seed(env);
    const pub = (await (
      await env.app.request("/api/v1/nav/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "T", template }),
      })
    ).json()) as { slug: string };
    const html = await (await env.app.request(`/s/${pub.slug}`)).text();
    expect(html).toContain("T");
    if (template === "cards") expect(html).toContain("minmax(230px");
    if (template === "list") expect(html).toContain("border-bottom");
    if (template === "home") expect(html).toContain("greet");
    if (template === "grid") expect(html).toContain("minmax(150px");
  });

  it("密码访问：无密码看验证页，正确密码进入", async () => {
    env = makeEnv();
    await seed(env);
    const pub = (await (
      await env.app.request("/api/v1/nav/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "加密站", password: "pass123" }),
      })
    ).json()) as { slug: string };
    const locked = await (await env.app.request(`/s/${pub.slug}`)).text();
    expect(locked).toContain("访问验证");
    const opened = await (await env.app.request(`/s/${pub.slug}?p=pass123`)).text();
    expect(opened).toContain("加密站");
    const wrong = await (await env.app.request(`/s/${pub.slug}?p=wrong`)).text();
    expect(wrong).toContain("访问验证");
  });
});

describe("快照配额 + 私密书签 + 迁移回灌", () => {
  it("快照配额：超限 402（F6.1 云端行为，自建默认不限）", async () => {
    env = makeEnv();
    env.store.setSetting("snapshot_quota_bytes", "10");
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/q", title: "q" }),
      })
    ).json()) as { id: string };
    const res = await env.app.request(`/api/v1/snapshots?bookmarkId=${bm.id}`, {
      method: "POST",
      headers: { "content-type": "message/rfc822" },
      // 合法 MHTML 头（A4-4 格式校验通过）+ 超配额体积
      body:
        "MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=\"---x\"\r\n\r\n" +
        "超过 10 字节的快照内容（pad pad pad pad pad）",
    });
    expect(res.status).toBe(402);
  });

  it("快照格式校验：非 MHTML 内容 400，不记为成功（A4-4）", async () => {
    env = makeEnv();
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/fmt", title: "fmt" }),
      })
    ).json()) as { id: string };
    const res = await env.app.request(`/api/v1/snapshots?bookmarkId=${bm.id}`, {
      method: "POST",
      headers: { "content-type": "message/rfc822" },
      body: "这不是 MHTML 格式的任意字节",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_mhtml_format");
    // 无快照记录
    expect(env.store.db.prepare("SELECT COUNT(*) as c FROM snapshot").get()).toMatchObject({ c: 0 });
  });

  it("私密书签：列表默认隐藏、详情 403、内容抓取被拒（隐私红线）", async () => {
    env = makeEnv();
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://private.example.com/secret", title: "机密" }),
      })
    ).json()) as { id: string };
    await env.app.request(`/api/v1/bookmarks/${bm.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isPrivate: true }),
    });
    const list = (await (await env.app.request("/api/v1/bookmarks")).json()) as unknown[];
    expect(list.length).toBe(0);
    const detail = await env.app.request(`/api/v1/bookmarks/${bm.id}`);
    expect(detail.status).toBe(403);
    const withHeader = await env.app.request(`/api/v1/bookmarks/${bm.id}`, {
      headers: { "x-mf-private": "1" },
    });
    expect(withHeader.status).toBe(200);
    // 抓取拒绝
    const crawl = (await (
      await env.app.request("/api/v1/crawl/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [bm.id] }),
      })
    ).json()) as { results: Array<{ reason: string }> };
    expect(crawl.results[0]?.reason).toBe("privacy"); // A1-3：隐私拒绝（域/私密书签统一）
  });

  it("导出 → 导入回灌（迁移工具 round-trip）", async () => {
    env = makeEnv();
    await seed(env);
    const exportBody = (await (
      await env.app.request("/api/v1/export/json")
    ).json()) as { folders: unknown[]; bookmarks: unknown[] };

    // 新环境回灌
    const env2 = makeEnv();
    const imp = (await (
      await env2.app.request("/api/v1/import/json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(exportBody),
      })
    ).json()) as { restored: number; skipped: number };
    expect(imp.restored).toBe(5);
    expect(imp.skipped).toBe(0);
    const all = (await (await env2.app.request("/api/v1/bookmarks")).json()) as Array<{
      title: string;
    }>;
    expect(all.length).toBe(5);
    env2.cleanup();
  });
});
