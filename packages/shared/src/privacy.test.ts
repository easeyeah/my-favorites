/** A1-1 隐私策略引擎：五动作判定 / 保守降级 / 修订版本 */
import { describe, expect, it } from "vitest";
import { checkPrivacy, checkAllPrivacy, builtinPrivacyRules, isPrivacyDomainUrl } from "./privacy";

describe("checkPrivacy 五动作", () => {
  const rules = builtinPrivacyRules();

  it("普通 URL：五动作全部允许", () => {
    for (const action of ["read_content", "upload_content", "call_model", "server_fetch", "snapshot"] as const) {
      const d = checkPrivacy(action, "https://github.com/x", rules);
      expect(d.allowed).toBe(true);
      expect(d.reason).toBe("ok");
    }
  });

  it("隐私域名（*.bank）：五动作全部禁止，原因可解释", () => {
    const d = checkPrivacy("read_content", "https://icbc.bank/login", rules);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("privacy_domain");
    expect(d.explanation).toContain("隐私域名");
    // 上传/模型/抓取/快照同样禁止
    expect(checkPrivacy("upload_content", "https://icbc.bank/x", rules).allowed).toBe(false);
    expect(checkPrivacy("call_model", "https://icbc.bank/x", rules).allowed).toBe(false);
    expect(checkPrivacy("server_fetch", "https://sub.icbc.bank/x", rules).allowed).toBe(false);
    expect(checkPrivacy("snapshot", "https://icbc.bank/x", rules).allowed).toBe(false);
  });

  it("私密书签：内容类动作禁止（优先于域名判定）", () => {
    const d = checkPrivacy("upload_content", "https://normal-site.com/a", rules, {
      isPrivateBookmark: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("private_bookmark");
    expect(checkPrivacy("snapshot", "https://normal-site.com/a", rules, { isPrivateBookmark: true }).allowed).toBe(false);
    expect(checkPrivacy("server_fetch", "https://normal-site.com/a", rules, { isPrivateBookmark: true }).allowed).toBe(false);
  });

  it("规则未加载：敏感动作保守禁止（A1-2 红线：不先上传后补校验）", () => {
    for (const nullish of [null, undefined]) {
      const d = checkPrivacy("read_content", "https://anything.com/x", nullish);
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe("policy_not_loaded");
    }
  });

  it("URL 解析异常：按隐私处理（保守）", () => {
    const d = checkPrivacy("read_content", "not a valid url ::::", rules);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("privacy_domain");
  });

  it("修订版本随规则传递（同步失效检测基础）", () => {
    const d = checkPrivacy("read_content", "https://x.com/", { patterns: [], revision: 42 });
    expect(d.rulesRevision).toBe(42);
  });

  it("checkAllPrivacy 与逐个判定语义一致", () => {
    const all = checkAllPrivacy("https://mail.example.bank/", rules);
    expect(Object.keys(all)).toHaveLength(5);
    for (const d of Object.values(all)) {
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe("privacy_domain");
    }
    const okAll = checkAllPrivacy("https://example.com/", rules);
    for (const d of Object.values(okAll)) expect(d.allowed).toBe(true);
  });

  it("isPrivacyDomainUrl：子域匹配 / 非匹配 / 精确匹配", () => {
    expect(isPrivacyDomainUrl("https://a.b.icloud.com/x", ["icloud.com"])).toBe(true);
    expect(isPrivacyDomainUrl("https://icloud.com/x", ["icloud.com"])).toBe(true);
    expect(isPrivacyDomainUrl("https://noticloud.com/x", ["icloud.com"])).toBe(false);
    expect(isPrivacyDomainUrl("https://x.cn.bank/y", ["*.bank"])).toBe(true);
    expect(isPrivacyDomainUrl("https://localhost:3000/x", ["localhost"])).toBe(true);
  });
});
