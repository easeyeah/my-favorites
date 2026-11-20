import { describe, expect, it } from "vitest";
import { canonicalizeUrl, isPrivacyDomain, URL_KEY_RULES_VERSION } from "./index";

describe("canonicalizeUrl（规则 v2：保守查重键）", () => {
  it("域名小写；不再强制 https、不再去 www", () => {
    expect(canonicalizeUrl("http://WWW.GitHub.com/liujx")?.canonical).toBe(
      "http://www.github.com/liujx",
    );
    expect(canonicalizeUrl("HTTPS://Example.COM")?.canonical).toBe("https://example.com/");
  });

  it("userinfo 剥离：凭据不进查重键（带/不带凭据同键）", () => {
    const withCreds = canonicalizeUrl("http://user:pass@Example.com/x");
    const plain = canonicalizeUrl("http://example.com/x");
    expect(withCreds!.canonical).toBe(plain!.canonical);
    expect(withCreds!.canonical).not.toContain("user");
    expect(withCreds!.canonical).not.toContain("pass");
  });

  it("只删除已验证 tracking 参数；业务/签名参数保留", () => {
    const r = canonicalizeUrl(
      "https://example.com/post?a=1&utm_source=rss&utm_medium=x&b=2&fbclid=AAA&sig=TOKEN",
    );
    expect(r?.canonical).toBe("https://example.com/post?a=1&b=2&sig=TOKEN");
    expect(r?.droppedParams).toEqual(["utm_source", "utm_medium", "fbclid"]);
  });

  it("ref / share_token / st / si 不再删除（可能承担业务语义）", () => {
    const r = canonicalizeUrl("https://example.com/a?ref=news&share_token=x&st=y&si=z&id=1");
    expect(r?.canonical).toBe("https://example.com/a?ref=news&share_token=x&st=y&si=z&id=1");
    expect(r?.droppedParams).toBeUndefined();
  });

  it("末斜杠归一（根路径保留）", () => {
    expect(canonicalizeUrl("https://example.com/docs/")?.canonical).toBe(
      "https://example.com/docs",
    );
    expect(canonicalizeUrl("https://example.com/")?.canonical).toBe("https://example.com/");
  });

  it("DEV-13 边界：hash 路由 #/a 与 #/b 不被合并", () => {
    expect(canonicalizeUrl("https://app.example.com/#/a")?.canonical).toBe(
      "https://app.example.com/#/a",
    );
    expect(canonicalizeUrl("https://app.example.com/#/b")?.canonical).toBe(
      "https://app.example.com/#/b",
    );
  });

  it("DEV-13 边界：http / https、www / 非 www 互不吞并；similarKey 相同（仅建议）", () => {
    const a = canonicalizeUrl("http://example.com/post");
    const b = canonicalizeUrl("https://www.example.com/post");
    expect(a?.canonical).not.toBe(b?.canonical);
    expect(a?.similarKey).toBe(b?.similarKey);
    expect(a?.rulesVersion).toBe(URL_KEY_RULES_VERSION);
  });

  it("DEV-13 边界：同域不同端口不合并", () => {
    expect(canonicalizeUrl("http://nas.local:5000/admin")?.canonical).toBe(
      "http://nas.local:5000/admin",
    );
    expect(canonicalizeUrl("http://nas.local:8080/admin")?.canonical).toBe(
      "http://nas.local:8080/admin",
    );
  });

  it("DEV-13 边界：中文/编码路径归一后稳定", () => {
    const a = canonicalizeUrl("https://zh.wikipedia.org/wiki/书签");
    const b = canonicalizeUrl("https://zh.wikipedia.org/wiki/%E4%B9%A6%E7%AD%BE");
    expect(a?.canonical).toBe(b?.canonical);
  });

  it("本地地址保留协议与端口", () => {
    expect(canonicalizeUrl("http://localhost:3000/api/v1")?.canonical).toBe(
      "http://localhost:3000/api/v1",
    );
    expect(canonicalizeUrl("http://192.168.1.10/admin")?.canonical).toBe(
      "http://192.168.1.10/admin",
    );
  });

  it("registrableDomain 处理多级后缀（含 www 前缀）", () => {
    expect(canonicalizeUrl("https://blog.example.co.uk/x")?.registrableDomain).toBe(
      "example.co.uk",
    );
    expect(canonicalizeUrl("https://github.com/x")?.registrableDomain).toBe("github.com");
    expect(canonicalizeUrl("https://www.github.com/x")?.registrableDomain).toBe("github.com");
  });

  it("非 http(s) 协议拒绝", () => {
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeUrl("chrome://extensions")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
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

  it("DEV-03：解析失败的 URL 保守按隐私处理（不因解析失败放行）", () => {
    expect(isPrivacyDomain("::::not-a-url", list)).toBe(true);
  });

  it("大写/带空白清单条目同口径命中（用户录入 *.Alipay.COM 不失效）", () => {
    expect(isPrivacyDomain("https://m.alipay.com/x", { patterns: ["*.Alipay.COM"] })).toBe(true);
    expect(isPrivacyDomain("https://m.alipay.com/x", { patterns: [" ALIPAY.COM "] })).toBe(true);
  });
});
