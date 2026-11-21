import { describe, expect, it } from "vitest";
import { classifyMaterialKind, MATERIAL_ARTICLE_MIN_TEXT } from "./material";

describe("classifyMaterialKind（D61 收藏内容三级识别）", () => {
  it("图片直链 → image（扩展名 + query/hash 形态）", () => {
    for (const url of [
      "https://example.com/photos/cat.jpg",
      "https://example.com/a/b.PNG?size=large",
      "https://example.com/diagram.webp#main",
      "https://cdn.example.com/x/photo.jpeg",
      "https://example.com/animation.gif",
    ]) {
      const c = classifyMaterialKind(url);
      expect(c?.kind, url).toBe("image");
      expect(c?.signals).toContain("图片直链");
    }
  });

  it("视频站点 + 路径守卫命中 → video", () => {
    for (const [url, label] of [
      ["https://www.youtube.com/watch?v=abc123", "YouTube"],
      ["https://youtu.be/abc123", "YouTube"],
      ["https://www.youtube.com/shorts/xyz", "YouTube"],
      ["https://www.bilibili.com/video/BV1xx411c7mD", "哔哩哔哩"],
      ["https://b23.tv/abc123", "哔哩哔哩"],
      ["https://www.ixigua.com/7123456789012345678", "西瓜视频"],
      ["https://v.qq.com/x/cover/abc123.html", "腾讯视频"],
      ["https://www.iqiyi.com/v_19rro4lavo.html", "爱奇艺"],
      ["https://v.youku.com/v_show/id_XNTk3NDY=.html", "优酷"],
      ["https://vimeo.com/12345678", "Vimeo"],
      ["https://www.douyin.com/video/7123456789012345678", "抖音"],
      ["https://www.ted.com/talks/some_talk", "TED"],
    ] as const) {
      const c = classifyMaterialKind(url);
      expect(c?.kind, url).toBe("video");
      expect(c?.signals, url).toContain(label);
    }
  });

  it("视频站点的首页/频道页不算视频（路径守卫）", () => {
    for (const url of [
      "https://www.youtube.com/", // 首页
      "https://www.youtube.com/@somechannel", // 频道页
      "https://www.bilibili.com/", // B 站首页
      "https://space.bilibili.com/12345", // UP 主空间
      "https://www.iqiyi.com/", // 爱奇艺首页
      "https://v.qq.com/", // 腾讯视频首页
    ]) {
      expect(classifyMaterialKind(url)?.kind, url).toBe("article");
    }
  });

  it("解析失败/非 http 协议 → null（不入资料库）", () => {
    expect(classifyMaterialKind("not a url")).toBeNull();
    expect(classifyMaterialKind("chrome://extensions")).toBeNull();
    expect(classifyMaterialKind("ftp://example.com/a.jpg")).toBeNull();
    expect(classifyMaterialKind("")).toBeNull();
  });

  it("其余 http(s) URL → article 兜底（是否入库由调用方结合已存全文判定）", () => {
    for (const url of [
      "https://github.com/facebook/react/issues/12345",
      "https://zhuanlan.zhihu.com/p/123456",
      "https://example.com/blog/my-post",
      "https://developer.mozilla.org/zh-CN/docs/Web/API/fetch",
    ]) {
      expect(classifyMaterialKind(url)?.kind, url).toBe("article");
    }
  });

  it("文章入库阈值常量存在且为正（调用方语义：仅已存全文显性化）", () => {
    expect(MATERIAL_ARTICLE_MIN_TEXT).toBeGreaterThan(0);
  });
});
