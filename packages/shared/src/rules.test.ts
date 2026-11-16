import { describe, expect, it } from "vitest";
import { AUTO_MOVE_CONFIDENCE, classifyByRules } from "./classify-rules";
import { exportNetscapeHtml, parseNetscapeBookmarks } from "./netscape";

describe("classifyByRules（F1.4/F1.5 零成本初判）", () => {
  it("域名映射命中 github.com", () => {
    const r = classifyByRules("github.com", "my repo");
    expect(r).toMatchObject({ category: "开发", source: "domain_map" });
    expect(r.confidence).toBeGreaterThanOrEqual(AUTO_MOVE_CONFIDENCE);
  });

  it("标题关键词次级命中", () => {
    const r = classifyByRules("unknown-site.com", "Rust 入门教程");
    expect(r).toMatchObject({ category: "学习", source: "keyword" });
  });

  it("未命中返回未分类低置信度（留在收件箱）", () => {
    const r = classifyByRules("unknown-site.com", "随便一个页面");
    expect(r.source).toBe("none");
    expect(r.confidence).toBeLessThan(AUTO_MOVE_CONFIDENCE);
  });
});

describe("Netscape HTML 解析（F1.1 通道2）", () => {
  const SAMPLE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1690000000">书签栏</H3>
    <DL><p>
        <DT><H3>开发</H3>
        <DL><p>
            <DT><A HREF="https://github.com/x" ADD_DATE="1690000001">GitHub</A>
        </DL><p>
        <DT><A HREF="https://example.com/root" ADD_DATE="1690000002">根下书签</A>
    </DL><p>
</DL><p>`;

  it("解析目录路径与添加时间", () => {
    const items = parseNetscapeBookmarks(SAMPLE);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      url: "https://github.com/x",
      title: "GitHub",
      folderPath: ["书签栏", "开发"],
    });
    expect(items[0]?.addedAt).toBe("2023-07-22T04:26:41.000Z");
    expect(items[1]?.folderPath).toEqual(["书签栏"]);
  });

  it("导出后可再次解析（round-trip）", () => {
    const items = parseNetscapeBookmarks(SAMPLE);
    const html = exportNetscapeHtml(items);
    const reparsed = parseNetscapeBookmarks(html);
    expect(reparsed).toEqual(items);
  });

  it("标题特殊字符转义", () => {
    const html = exportNetscapeHtml([
      { url: "https://a.com", title: "a<b>&c", folderPath: [] },
    ]);
    expect(html).toContain("a&lt;b&gt;&amp;c");
  });
});
