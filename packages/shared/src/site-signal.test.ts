/** 站点化规则信号单元测试（D30/D31，切片 B） */
import { describe, expect, it } from "vitest";
import { classifySiteSignal, refineWithSummary } from "./site-signal";

describe("classifySiteSignal（站点三类规则信号）", () => {
  it("站点根/近根 → site_tool", () => {
    const s = classifySiteSignal("https://figma.com")!;
    expect(s.kind).toBe("site_tool");
    expect(s.isNearRoot).toBe(true);
  });

  it("已知工具域名 → site_tool 高置信", () => {
    const s = classifySiteSignal("https://caniuse.com/?search=grid")!;
    expect(s.kind).toBe("site_tool");
    expect(s.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("docs 子域近根 → site_ref（资料站，默认不入导航 D31）", () => {
    const s = classifySiteSignal("https://docs.python.org/zh-cn/")!;
    expect(s.kind).toBe("site_ref");
  });

  it("developer.mozilla.org → site_ref", () => {
    const s = classifySiteSignal("https://developer.mozilla.org/zh-CN/")!;
    expect(s.kind).toBe("site_ref");
  });

  it("文章路径 → content（不占导航位 D30）", () => {
    const s = classifySiteSignal("https://zhuanlan.zhihu.com/p/530923601")!;
    expect(s.kind).toBe("content");
  });

  it("日期路径博客 → content", () => {
    const s = classifySiteSignal("https://example.com/2023/11/my-post")!;
    expect(s.kind).toBe("content");
  });

  it("GitHub 内容页（blob/issues）→ content", () => {
    const s = classifySiteSignal("https://github.com/tikv/raft-rs/blob/master/README.md")!;
    expect(s.kind).toBe("content");
  });

  it("深层无特征路径 → content（保守：宁可不进导航）", () => {
    const s = classifySiteSignal("https://example.com/a/b/c/d")!;
    expect(s.kind).toBe("content");
    expect(s.isNearRoot).toBe(false);
  });

  it("非 http(s) / 非法 URL → null", () => {
    expect(classifySiteSignal("chrome://version")).toBeNull();
    expect(classifySiteSignal("not a url")).toBeNull();
  });

  it("refineWithSummary：摘要说文档站 → site_tool 修正为 site_ref", () => {
    const base = classifySiteSignal("https://orm.drizzle.team/")!;
    expect(base.kind).toBe("site_tool");
    const refined = refineWithSummary(base, "Drizzle ORM 官方文档与 API reference");
    expect(refined.kind).toBe("site_ref");
    expect(refined.signals).toContain("AI 摘要:文档站");
  });
});
