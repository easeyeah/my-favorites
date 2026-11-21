/** 站点原始图标：MIME 嗅探 / link 解析 / 端点回填与隐私红线 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";
import { extractIconHrefs, resetFaviconCaches, resolveFavicon, sniffImageMime } from "./favicon";
import type { FetchGuardConfig } from "./fetch-guard";

let env: TestEnv;
afterEach(() => {
  env?.cleanup();
  resetFaviconCaches();
});

// 测试放行回环（等价部署显式 MF_ALLOW_INTRANET_FETCH）；makeEnv 的 app 侧同口径注入
const LOOPBACK: FetchGuardConfig = { mode: "selfhosted_allowlist", allowedCidrs: ["127.0.0.1/32"] };

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(20)]);
const HTML = Buffer.from("<!doctype html><html><body>not an image</body></html>");

async function listen(site: http.Server): Promise<number> {
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  return (site.address() as AddressInfo).port;
}

describe("sniffImageMime", () => {
  it("魔数识别 png/ico/svg；非图片返回 null", () => {
    expect(sniffImageMime(PNG, "application/octet-stream")).toBe("image/png");
    expect(sniffImageMime(ICO, undefined)).toBe("image/x-icon");
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "text/html")).toBe(
      "image/svg+xml",
    );
    // 404 页伪装 200：内容不是图片
    expect(sniffImageMime(HTML, "text/html")).toBeNull();
  });
});

describe("extractIconHrefs", () => {
  it("解析 rel=icon/shortcut icon/apple-touch-icon 并按 base 展开；忽略 data: 与样式表", () => {
    const html = `
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel="icon" type="image/png" sizes="32x32" href="fav/icon.png">
      <link rel="shortcut icon" href="https://cdn.example.net/x.ico">
      <link rel="icon" href="data:image/png;base64,AAA">
      <link rel="stylesheet" href="/app.css">`;
    const hrefs = extractIconHrefs(html, "https://foo.example");
    expect(hrefs).toContain("https://foo.example/fav/icon.png");
    expect(hrefs).toContain("https://cdn.example.net/x.ico");
    expect(hrefs.some((h) => h.startsWith("data:"))).toBe(false);
    expect(hrefs.some((h) => h.endsWith(".css"))).toBe(false);
    // apple-touch-icon 排最后
    expect(hrefs[hrefs.length - 1]).toBe("https://foo.example/touch.png");
  });
});

describe("resolveFavicon", () => {
  it("根 favicon.ico 命中并转 data URL", async () => {
    const site = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/vnd.microsoft.icon" });
      res.end(ICO);
    });
    const port = await listen(site);
    const icon = await resolveFavicon(`http://127.0.0.1:${port}/page`, LOOPBACK);
    expect(icon).toMatch(/^data:image\/x-icon;base64,/);
    site.close();
  });

  it("首页 <link rel=icon> 兜底命中", async () => {
    const site = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      if (p === "/brand.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG);
      } else if (p === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<html><head><link rel="icon" href="/brand.png"></head></html>');
      } else {
        res.writeHead(404);
        res.end(HTML);
      }
    });
    const port = await listen(site);
    const icon = await resolveFavicon(`http://127.0.0.1:${port}/some/page`, LOOPBACK);
    expect(icon).toMatch(/^data:image\/png;base64,/);
    site.close();
  });

  it("不可达站点返回 null；进程内负缓存后不再重试", async () => {
    // 59997 无监听：第一次解析失败（含 https 对侧尝试），第二次直接命中负缓存返回 null
    const dead = "http://127.0.0.1:59997/";
    expect(await resolveFavicon(dead, LOOPBACK)).toBeNull();
    const t0 = Date.now();
    expect(await resolveFavicon(dead, LOOPBACK)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("GET /api/v1/favicon 端点", () => {
  it("缺图书签：取回站点原始图标并持久化到 favicon_url；再次请求直接读库不再出网", async () => {
    let icoServed = 0;
    const site = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      if (p === "/favicon.ico") {
        icoServed++;
        res.writeHead(200, { "content-type": "image/x-icon" });
        res.end(ICO);
      } else {
        res.writeHead(404);
        res.end(HTML);
      }
    });
    const port = await listen(site);
    env = makeEnv();
    const url = `http://127.0.0.1:${port}/page`;
    env.store.createBookmark({
      folderId: env.store.ensurePath(["开发"]).id,
      urlRaw: url,
      urlCanonical: url,
      title: "站点",
    });

    const first = (await (await env.app.request(`/api/v1/favicon?url=${encodeURIComponent(url)}`)).json()) as {
      favicon_url: string;
    };
    expect(first.favicon_url).toMatch(/^data:image\/x-icon;base64,/);
    // 已入库：列表载荷直接带出；二次请求读库，站点零新增命中
    expect(env.store.findByCanonical(url)?.favicon_url).toMatch(/^data:/);
    const hitsBefore = icoServed;
    const second = (await (await env.app.request(`/api/v1/favicon?url=${encodeURIComponent(url)}`)).json()) as {
      favicon_url: string;
    };
    expect(second.favicon_url).toMatch(/^data:/);
    expect(icoServed).toBe(hitsBefore);
    site.close();
  });

  it("隐私红线：隐私域不发起取图；非法 url 400；私密书签拒绝", async () => {
    env = makeEnv();
    const res = await env.app.request(`/api/v1/favicon?url=${encodeURIComponent("https://www.icloud.com/mail")}`);
    const body = (await res.json()) as { favicon_url: null; reason: string };
    expect(body.favicon_url).toBeNull();
    expect(body.reason).toContain("privacy");

    expect((await env.app.request("/api/v1/favicon?url=javascript:alert(1)")).status).toBe(400);
    expect((await env.app.request("/api/v1/favicon")).status).toBe(400);

    const url = "https://example.org/private-page";
    const bm = env.store.createBookmark({
      folderId: env.store.ensurePath(["杂项"]).id,
      urlRaw: url,
      urlCanonical: url,
      title: "私密",
    });
    env.store.updateBookmark(bm.id, { is_private: 1 });
    const priv = (await (await env.app.request(`/api/v1/favicon?url=${encodeURIComponent(url)}`)).json()) as {
      favicon_url: null;
      reason: string;
    };
    expect(priv.favicon_url).toBeNull();
    expect(priv.reason).toBe("privacy_private_bookmark");
  });
});
