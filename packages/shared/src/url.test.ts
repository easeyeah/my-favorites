import { describe, expect, it } from "vitest";
import { canonicalizeUrl, isPrivacyDomain } from "./index";

describe("canonicalizeUrl", () => {
  it("统一 https 与小写域名、去 www", () => {
    expect(canonicalizeUrl("http://WWW.GitHub.com/liujx")?.canonical).toBe(
      "https://github.com/liujx",
    );
  });

  it("去除 tracking 参数", () => {
    const r = canonicalizeUrl("https://example.com/post?a=1&utm_source=rss&utm_medium=x&b=2");
    expect(r?.canonical).toBe("https://example.com/post?a=1&b=2");
    expect(r && "_droppedParams" in r).toBe(true);
  });

  it("末斜杠归一（根路径保留）", () => {
    expect(canonicalizeUrl("https://example.com/docs/")?.canonical).toBe(
      "https://example.com/docs",
    );
    expect(canonicalizeUrl("https://example.com/")?.canonical).toBe("https://example.com/");
  });

  it("fragment 不参与查重", () => {
    expect(canonicalizeUrl("https://example.com/page#section")?.canonical).toBe(
      "https://example.com/page",
    );
  });

  it("本地地址保留协议", () => {
    expect(canonicalizeUrl("http://localhost:3000/api/v1")?.canonical).toBe(
      "http://localhost:3000/api/v1",
    );
    expect(canonicalizeUrl("http://192.168.1.10/admin")?.canonical).toBe(
      "http://192.168.1.10/admin",
    );
  });

  it("registrableDomain 处理多级后缀", () => {
    expect(canonicalizeUrl("https://blog.example.co.uk/x")?.registrableDomain).toBe(
      "example.co.uk",
    );
    expect(canonicalizeUrl("https://github.com/x")?.registrableDomain).toBe("github.com");
  });

  it("非 http(s) 协议拒绝", () => {
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeUrl("chrome://extensions")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
  });

  it("同义 URL 规范化后一致（查重基础）", () => {
    const a = canonicalizeUrl("https://www.example.com/post/?utm_campaign=x");
    const b = canonicalizeUrl("http://example.com/post");
    expect(a?.canonical).toBe(b?.canonical);
  });
});

describe("isPrivacyDomain（红线 2：抓取/AI 前强制校验）", () => {
  const list = { patterns: ["*.bank", "internal.example.com", "corp.cn"] };

  it("通配后缀命中", () => {
    expect(isPrivacyDomain("https://icbc.bank/login", list)).toBe(true);
  });

  it("完整域名命中", () => {
    expect(isPrivacyDomain("https://internal.example.com/wiki", list)).toBe(true);
  });

  it("子域名命中", () => {
    expect(isPrivacyDomain("https://git.corp.cn/repo", list)).toBe(true);
  });

  it("未命中", () => {
    expect(isPrivacyDomain("https://github.com/liujx", list)).toBe(false);
  });
});
