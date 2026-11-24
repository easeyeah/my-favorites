/** A1 完整隐私策略链路验收：纵深校验 / 网络防护 / 规则同步与存量清理 */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";
import {
  isForbiddenIp,
  guardFetchTarget,
  guardedFetch,
  GuardError,
  fetchGuardConfigFromEnv,
} from "./fetch-guard";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("A1-3 服务端纵深校验（不信任客户端声明）", () => {
  it("扩展未拦截时，隐私正文直连上传服务端仍被拒绝（第二道防线）", async () => {
    env = makeEnv(null);
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://icbc.bank/login", title: "银行" }),
      })
    ).json()) as { id: string };
    const res = await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: bm.id, l2Text: "敏感正文内容".repeat(10) }),
    });
    const body = (await res.json()) as { skippedPrivacy: boolean; skipReason: string };
    expect(body.skippedPrivacy).toBe(true);
    expect(body.skipReason).toBe("privacy_domain");
    // 正文未入库
    const cache = env.store.getCache(bm.id);
    expect(cache?.l2_text).toBeNull();
    expect(cache?.fail_reason).toBe("privacy_privacy_domain");
  });

  it("私密书签正文直连上传同样被拒（private_bookmark 优先）", async () => {
    env = makeEnv(null);
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://normal-site.example.com/article", title: "文章" }),
      })
    ).json()) as { id: string };
    await env.app.request(`/api/v1/bookmarks/${bm.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isPrivate: true }),
    });
    const res = await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: bm.id, l2Text: "私密正文".repeat(10) }),
    });
    const body = (await res.json()) as { skippedPrivacy: boolean; skipReason: string };
    expect(body.skippedPrivacy).toBe(true);
    expect(body.skipReason).toBe("private_bookmark");
  });

  it("快照上传：隐私域书签 403 拒绝", async () => {
    env = makeEnv(null);
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://icbc.bank/x", title: "x" }),
      })
    ).json()) as { id: string };
    const res = await env.app.request(`/api/v1/snapshots?bookmarkId=${bm.id}`, {
      method: "POST",
      headers: { "content-type": "message/rfc822" },
      body: "MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=\"x\"",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("privacy_blocked");
  });

  it("AI 摘要：隐私域书签即使已有正文也不调用模型（call_model 判定）", async () => {
    // 用同步模式 + 会抛错的 LLM 探测是否被调用
    let called = false;
    const llm = {
      chatJson: async () => {
        called = true;
        return {};
      },
      chat: async () => "",
    } as unknown as import("@mf/ai/llm-client").LlmClient;
    env = makeEnv(llm, true); // syncAi：maybeSummarize 同步执行
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://pay.tenpay.com/secret", title: "支付" }),
      })
    ).json()) as { id: string };
    // 直接给隐私书签塞正文（模拟历史存量），再触发 capture → 摘要链路
    env.store.upsertCache({ bookmarkId: bm.id, l2Text: "很长的敏感正文内容".repeat(10), fetchedVia: "extension_capture" });
    const summarized = await env.pipeline.maybeSummarize(bm.id);
    expect(summarized).toBe(false);
    expect(called).toBe(false); // 模型从未被调用
  });
});

describe("A1-1 规则下发与修订版本", () => {
  it("GET /privacy/rules 返回规则与修订版本；变更后 revision 递增", async () => {
    env = makeEnv(null);
    const before = (await (
      await env.app.request("/api/v1/privacy/rules")
    ).json()) as { patterns: string[]; revision: number };
    expect(before.revision).toBe(0);
    expect(before.patterns).toContain("*.bank");

    await env.app.request("/api/v1/privacy/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ add: ["secret.example.com"] }),
    });
    const after = (await (
      await env.app.request("/api/v1/privacy/rules")
    ).json()) as { patterns: string[]; revision: number };
    expect(after.revision).toBe(1);
    expect(after.patterns).toContain("secret.example.com");

    // 新规则生效：secret.example.com 的正文上传被拒
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://secret.example.com/page", title: "p" }),
      })
    ).json()) as { id: string };
    const cap = (await (
      await env.app.request("/api/v1/content/capture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookmarkId: bm.id, l2Text: "正文".repeat(30) }),
      })
    ).json()) as { skippedPrivacy: boolean };
    expect(cap.skippedPrivacy).toBe(true);
  });

  it("内置隐私项不可被用户删除", async () => {
    env = makeEnv(null);
    await env.app.request("/api/v1/privacy/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remove: ["*.bank"] }),
    });
    const rules = (await (
      await env.app.request("/api/v1/privacy/rules")
    ).json()) as { patterns: string[] };
    expect(rules.patterns).toContain("*.bank");
  });
});

describe("A1-5 规则变化后的存量清理", () => {
  it("新增规则清理存量正文/向量/快照；标题与 URL 保留", async () => {
    env = makeEnv(null);
    // 先收藏正常域书签并塞正文 + 快照
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://old-friend.example.org/diary", title: "日记" }),
      })
    ).json()) as { id: string };
    await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: bm.id, l2Text: "历史正文的存量内容".repeat(20) }),
    });
    const up = (await (
      await env.app.request(`/api/v1/snapshots?bookmarkId=${bm.id}`, {
        method: "POST",
        headers: { "content-type": "message/rfc822" },
        body: "MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=\"x\"\r\n\r\nsnapshot-body",
      })
    ).json()) as { id: string };
    expect(up.id).toBeTruthy();

    // 把该域加进隐私规则 → 存量被清理
    const res = (await (
      await env.app.request("/api/v1/privacy/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ add: ["old-friend.example.org"] }),
      })
    ).json()) as { purged: { bookmarks: number; snapshots: number } };
    expect(res.purged.bookmarks).toBe(1);
    expect(res.purged.snapshots).toBe(1);

    const cache = env.store.getCache(bm.id);
    expect(cache?.l2_text).toBeNull();
    expect(cache?.fail_reason).toBe("privacy_rules_changed");
    expect(env.store.db.prepare("SELECT COUNT(*) as c FROM snapshot").get()).toMatchObject({ c: 0 });
    // 书签本身保留（标题/URL 不删）
    expect(env.store.getBookmark(bm.id)?.title).toBe("日记");
  });
});

describe("A1-4 抓取网络访问策略", () => {
  it("禁止 IP 段判定：私网/回环/链路本地/CGNAT/IPv6 ULA", () => {
    for (const ip of [
      "10.1.2.3", "192.168.1.1", "172.20.3.4", "127.0.0.1", "0.0.0.1",
      "169.254.169.254", "100.64.0.1", "224.0.0.1",
      "::1", "fe80::1", "fd00::1", "ff02::1", "::ffff:10.0.0.1",
    ]) {
      expect(isForbiddenIp(ip), ip).toBe(true);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700::1111"]) {
      expect(isForbiddenIp(ip), ip).toBe(false);
    }
  });

  it("字面 IP 目标直接拒绝；公网域名放行", async () => {
    const strict = { mode: "selfhosted_strict" as const };
    await expect(guardFetchTarget("http://192.168.1.1/admin", strict)).resolves.toMatchObject({
      allowed: false,
      reason: "literal_ip_forbidden",
    });
    await expect(guardFetchTarget("http://127.0.0.1:3000/x", strict)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(guardFetchTarget("ftp://example.com/x", strict)).resolves.toMatchObject({
      allowed: false,
      reason: "scheme_forbidden",
    });
    await expect(guardFetchTarget("https://example.com/", strict)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("DNS 解析出的私网地址被拒（DNS rebinding 基础防护）", async () => {
    const strict = { mode: "selfhosted_strict" as const };
    // localhost 域名解析为 127.0.0.1
    await expect(guardFetchTarget("http://localhost:8080/", strict)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("自建 allowlist 模式：命中允许网段放行，未命中拒绝", async () => {
    const allow = { mode: "selfhosted_allowlist" as const, allowedCidrs: ["192.168.0.0/16"] };
    await expect(guardFetchTarget("http://192.168.1.10:8443/router", allow)).resolves.toMatchObject({
      allowed: true,
    });
    const other = { mode: "selfhosted_allowlist" as const, allowedCidrs: ["10.0.0.0/8"] };
    await expect(guardFetchTarget("http://192.168.1.10:8443/router", other)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("guardedFetch：重定向到禁止目标时被拦截（每跳校验）", async () => {
    // mock fetch：第一跳 302 → Location: http://127.0.0.1/x
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("redirector.example.com")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:8080/evil" },
        });
      }
      return new Response("should not reach", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        guardedFetch("https://redirector.example.com/a", { mode: "selfhosted_strict" }),
      ).rejects.toThrow(GuardError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("环境变量构建：部署名称不改变抓取策略；MF_ALLOW_INTRANET_FETCH=1 → allowlist", () => {
    const savedForm = process.env.MF_FORM;
    const savedAllow = process.env.MF_ALLOW_INTRANET_FETCH;
    try {
      process.env.MF_FORM = "cloud";
      expect(fetchGuardConfigFromEnv().mode).toBe("selfhosted_strict");
      process.env.MF_FORM = "self-hosted";
      expect(fetchGuardConfigFromEnv().mode).toBe("selfhosted_strict");
      process.env.MF_ALLOW_INTRANET_FETCH = "1";
      const cfg = fetchGuardConfigFromEnv();
      expect(cfg.mode).toBe("selfhosted_allowlist");
      expect(cfg.allowedCidrs).toContain("10.0.0.0/8");
    } finally {
      if (savedForm === undefined) delete process.env.MF_FORM;
      else process.env.MF_FORM = savedForm;
      if (savedAllow === undefined) delete process.env.MF_ALLOW_INTRANET_FETCH;
      else process.env.MF_ALLOW_INTRANET_FETCH = savedAllow;
    }
  });
});
