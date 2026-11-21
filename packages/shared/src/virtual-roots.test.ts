import { describe, expect, it } from "vitest";
import { VIRTUAL_BOOKMARK_ROOT_TITLES, isVirtualBookmarkRootTitle } from "./index";

describe("D55 书签树虚拟顶层（浏览器平台差异回归锁）", () => {
  it("Chrome/Edge 中英文第一层虚拟名全部识别", () => {
    for (const t of ["书签栏", "收藏夹栏", "收藏夹", "链接", "其他书签", "其他收藏夹", "Bookmarks Bar", "Favorites Bar", "Favorites", "Links", "Other bookmarks", "Other favorites", ""]) {
      expect(isVirtualBookmarkRootTitle(t, 0)).toBe(true);
    }
  });

  it("仅第一层按标题判定：真实层级允许同名文件夹（「开发」「未整理」等是合法业务目录）", () => {
    expect(isVirtualBookmarkRootTitle("收藏夹栏", 1)).toBe(false);
    expect(isVirtualBookmarkRootTitle("未整理", 0)).toBe(false); // 「未整理」不是任何浏览器的虚拟根标题
    expect(isVirtualBookmarkRootTitle("开发", 0)).toBe(false);
  });

  it("集合封闭：不得把业务目录名混入虚拟名", () => {
    for (const biz of ["开发", "未整理", "私人收藏", "前端"]) {
      expect(VIRTUAL_BOOKMARK_ROOT_TITLES.has(biz)).toBe(false);
    }
  });
});
