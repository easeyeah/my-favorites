/**
 * 引导导入展平单测（2026-11-23 自主评审 R1–R7 回归锁）。
 *  R1 多级目录层级必须保留——旧实现按「path 是否为空」判虚拟根，逐层命中同一条件，
 *     所有书签 folderPath 恒为 []（目录结构全丢）；本文件第 1 例即该缺陷的回归断言。
 *  R2 只跳过第一层虚拟根，第 2 层同名目录（如「链接」）仍是用户目录
 *  R3 只导入 http(s)
 *  R4 标题 / 目录名 / 目录深度按服务端 schema 上限截断（否则一条超限让整批 100 条 400）
 *  R5 addedAt 透传（毫秒，兼容秒级脏数据）
 *  R6 Netscape 通道剥虚拟根（否则凭空建出「书签栏」目录）
 */
import { describe, expect, it } from "vitest";
import { flattenBookmarkTree, normalizeFolderPath, normalizeIngestItem, type TreeNode } from "./import";

const rootWith = (children: TreeNode[]): TreeNode[] => [{ id: "0", title: "", children }];

describe("flattenBookmarkTree（F1.1 通道1）", () => {
  it("R1：保留多级目录层级，虚拟根（书签栏/其他书签）不入路径", () => {
    const items = flattenBookmarkTree(
      rootWith([
        {
          id: "1",
          title: "书签栏",
          children: [
            {
              id: "10",
              title: "开发",
              children: [
                {
                  id: "11",
                  title: "前端",
                  children: [{ id: "12", title: "MDN", url: "https://developer.mozilla.org/" }],
                },
              ],
            },
          ],
        },
        { id: "2", title: "其他书签", children: [{ id: "20", title: "根书签", url: "https://example.org/" }] },
      ]),
    );

    expect(items.map((i) => i.folderPath)).toEqual([["开发", "前端"], []]);
    expect(items[0]?.title).toBe("MDN");
    expect(items[0]?.browserId).toBe("12");
  });

  it("R2：第一层虚拟根名跳过，第 2 层同名目录保留（D55 仅第一层判定）", () => {
    const items = flattenBookmarkTree(
      rootWith([
        {
          id: "1",
          title: "收藏夹栏",
          children: [
            {
              id: "10",
              title: "链接",
              children: [{ id: "11", title: "站", url: "https://a.test/" }],
            },
          ],
        },
      ]),
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.folderPath).toEqual(["链接"]);
  });

  it("R3：只导入 http(s)，chrome:// 与扩展页跳过", () => {
    const items = flattenBookmarkTree(
      rootWith([
        {
          id: "1",
          title: "书签栏",
          children: [
            { id: "10", title: "设置", url: "chrome://settings/" },
            { id: "11", title: "扩展", url: "chrome-extension://abc/welcome.html" },
            { id: "12", title: "站点", url: "https://ok.test/" },
            { id: "13", title: "明文", url: "http://plain.test/" },
          ],
        },
      ]),
    );

    expect(items.map((i) => i.url)).toEqual(["https://ok.test/", "http://plain.test/"]);
  });

  it("R4：超长标题 / 目录名 / 目录深度按 schema 上限截断（不炸整批）", () => {
    const longTitle = "长".repeat(600);
    const longFolder = "目".repeat(300);
    let deep: TreeNode = { id: "leaf", title: "叶子", url: "https://deep.test/" };
    for (let i = 19; i >= 0; i--) deep = { id: `f${i}`, title: `层${i}`, children: [deep] };

    const items = flattenBookmarkTree(
      rootWith([
        { id: "1", title: "书签栏", children: [{ id: "10", title: longFolder, children: [deep] }] },
        { id: "2", title: "其他书签", children: [{ id: "20", title: longTitle, url: "https://long.test/" }] },
      ]),
    );

    // 16 层上限：超长目录占第 1 层，其后还能再带 15 层（层0…层14）
    expect(items[0]?.folderPath).toHaveLength(16);
    expect(items[0]?.folderPath[0]).toHaveLength(256);
    expect(items[0]?.folderPath[15]).toBe("层14");
    expect(items[1]?.title).toHaveLength(200);
  });

  it("R5：dateAdded 透传为 ISO（毫秒，兼容秒级）", () => {
    const ms = Date.UTC(2023, 6, 22, 4, 26, 40);
    const items = flattenBookmarkTree(
      rootWith([
        {
          id: "1",
          title: "书签栏",
          children: [
            { id: "10", title: "毫秒", url: "https://ms.test/", dateAdded: ms },
            { id: "11", title: "秒", url: "https://s.test/", dateAdded: Math.floor(ms / 1000) },
            { id: "12", title: "脏值", url: "https://bad.test/", dateAdded: Number.NaN },
          ],
        },
      ]),
    );

    expect(items[0]?.addedAt).toBe(new Date(ms).toISOString());
    expect(items[1]?.addedAt).toBe(new Date(ms).toISOString());
    expect(items[2]?.addedAt).toBeUndefined();
  });

  it("无标题书签以 URL 兜底（schema 要求 title 非空）", () => {
    const items = flattenBookmarkTree(rootWith([{ id: "1", title: "书签栏", children: [{ id: "10", title: "  ", url: "https://untitled.test/" }] }]));
    expect(items[0]?.title).toBe("https://untitled.test/");
  });
});

describe("normalizeFolderPath（Netscape 通道 R6）", () => {
  it("剥掉开头的虚拟根，其余层级保留", () => {
    expect(normalizeFolderPath(["书签栏", "开发"])).toEqual(["开发"]);
    expect(normalizeFolderPath(["Bookmarks Bar"])).toEqual([]);
    expect(normalizeFolderPath(["收藏夹栏", "工具", "书签栏"])).toEqual(["工具", "书签栏"]);
  });

  it("空名与超长名归一", () => {
    expect(normalizeFolderPath(["开发", "   "])).toEqual(["开发"]);
    expect(normalizeFolderPath(["目".repeat(300)])[0]).toHaveLength(256);
  });
});

describe("normalizeIngestItem", () => {
  it("可选字段缺省时不写入空值（避免 schema 边界歧义）", () => {
    const item = normalizeIngestItem({ url: "https://a.test/", title: "A", folderPath: [] });
    expect(item).toEqual({ url: "https://a.test/", title: "A", folderPath: [] });
  });
});
