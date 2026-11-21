/**
 * 管理台静态托管回归（2026-11-20 修复：只挂 /assets/* 导致 /brand、/providers 404，
 * 顶栏品牌标与供应商 logo 破图）：白名单目录全部可服务、MIME 正确、目录穿越被拦。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv | undefined;
let distDir: string | undefined;

function makeWebDist() {
  distDir = mkdtempSync(path.join(tmpdir(), "mf-webdist-"));
  mkdirSync(path.join(distDir!, "assets"), { recursive: true });
  mkdirSync(path.join(distDir!, "brand"), { recursive: true });
  mkdirSync(path.join(distDir!, "providers"), { recursive: true });
  writeFileSync(path.join(distDir!, "index.html"), "<html>admin</html>");
  writeFileSync(path.join(distDir!, "brand", "mark-color.svg"), "<svg>mark</svg>");
  writeFileSync(path.join(distDir!, "providers", "deepseek.png"), "PNG");
  writeFileSync(path.join(distDir!, "assets", "index-abc123.js"), "console.log(1)");
}

function envWithWebDist() {
  makeWebDist();
  process.env.WEB_DIST_DIR = distDir;
  env = makeEnv();
}

afterEach(() => {
  env?.cleanup();
  env = undefined;
  if (distDir) {
    rmSync(distDir, { recursive: true, force: true });
    distDir = undefined;
  }
  delete process.env.WEB_DIST_DIR;
});

describe("管理台静态托管白名单", () => {
  it("GET / 返回 index.html", async () => {
    envWithWebDist();
    const res = await env!.app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("admin");
  });

  it("/assets/* 带 hash 产物：200 + JS MIME + 长缓存", async () => {
    envWithWebDist();
    const res = await env!.app.request("/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
  });

  it("/brand/* 品牌标：200 + SVG MIME（此前 404 的缺陷点）", async () => {
    envWithWebDist();
    const res = await env!.app.request("/brand/mark-color.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toContain("<svg>");
  });

  it("/providers/* 供应商 logo：200（此前 404 的缺陷点）", async () => {
    envWithWebDist();
    const res = await env!.app.request("/providers/deepseek.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("白名单外路径与目录穿越不放行", async () => {
    envWithWebDist();
    const outside = await env!.app.request("/secrets/foo.svg");
    expect(outside.status).not.toBe(200);
    const traversal = await env!.app.request("/brand/%2e%2e%2findex.html");
    expect(traversal.status).not.toBe(200);
    const notFound = await env!.app.request("/brand/no-such-file.svg");
    expect(notFound.status).toBe(404);
  });
});
