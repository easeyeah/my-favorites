/**
 * D43 敏感宿主启发式单测 —— 一律合成域名（*.example 族），不引用任何真实站点。
 */
import { describe, expect, it } from "vitest";
import { isSensitiveHost, PRIVATE_FOLDER_NAME } from "./sensitive";

describe("isSensitiveHost", () => {
  it("通用词素子串命中", () => {
    expect(isSensitiveHost("https://pornclips.example/")).toBe(true);
    expect(isSensitiveHost("https://www.hentai-draw.example")).toBe(true);
    expect(isSensitiveHost("https://xxx-vids.example")).toBe(true);
    expect(isSensitiveHost("https://nsfw.art.example")).toBe(true);
    expect(isSensitiveHost("http://fetish-archive.example")).toBe(true);
  });

  it("成人专用 TLD 命中", () => {
    expect(isSensitiveHost("https://myshop.example.xxx")).toBe(true);
    expect(isSensitiveHost("https://blog.porn")).toBe(true);
  });

  it("sex/jav 类短词只在标签前缀命中", () => {
    expect(isSensitiveHost("https://sex-toys-guide.example")).toBe(true);
    expect(isSensitiveHost("https://moster.example.jav")).toBe(true);
    expect(isSensitiveHost("https://jav-club.example")).toBe(true);
  });

  it("假阳性防护：词中短词不误伤", () => {
    expect(isSensitiveHost("https://javascript-tutorial.example")).toBe(false);
    expect(isSensitiveHost("https://essex-county-museum.example")).toBe(false);
    expect(isSensitiveHost("https://javadev.example")).toBe(false);
  });

  it("正常站点不误伤", () => {
    for (const url of [
      "https://github.example",
      "https://news.ycombinator.example",
      "https://www.douban.example/movie",
      "https://pancake-recipes.example",
    ]) {
      expect(isSensitiveHost(url)).toBe(false);
    }
  });

  it("解析失败返回 false（保守处理归隐私门）", () => {
    expect(isSensitiveHost("not a url")).toBe(false);
    expect(isSensitiveHost("")).toBe(false);
    expect(isSensitiveHost("javascript:alert(1)")).toBe(false);
  });

  it("私人收藏目录名常量", () => {
    expect(PRIVATE_FOLDER_NAME).toBe("私人收藏");
  });
});
