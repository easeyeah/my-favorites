/**
 * 浏览器书签树 → 导入条目展平（F1.1 通道1：一键读取）。
 * 纯函数，浏览器侧与测试共用。
 *
 * 规则：
 * - 跳过顶层虚拟根（"书签栏"/"其他书签"/"" 等无名文件夹节点）
 * - 叶子节点（url 存在）携带其上方相对 folderPath（不含顶级虚拟层）
 * - 仅保留 http(s) 链接（chrome://、扩展页不导入）
 */
export interface BookmarkImportItem {
  url: string;
  title: string;
  folderPath: string[];
}

interface TreeNode {
  id: string;
  title?: string;
  url?: string;
  children?: TreeNode[];
}

const TOP_LEVEL_SKIP = new Set(["", "书签栏", "其他书签", "Bookmarks Bar", "Other favorites"]);

export function flattenBookmarkTree(root: TreeNode[]): BookmarkImportItem[] {
  const items: BookmarkImportItem[] = [];

  const walk = (nodes: TreeNode[], path: string[]): void => {
    for (const node of nodes) {
      if (node.url) {
        // 叶子书签节点
        if (!/^https?:/.test(node.url)) continue; // 只导入 http(s)
        items.push({
          url: node.url,
          title: node.title ?? node.url,
          folderPath: path.length > 0 ? [...path] : [],
        });
        continue;
      }
      // 文件夹节点：虚拟根（无标题）不进 path；有标题则入栈
      const nextPath =
        node.title && !TOP_LEVEL_SKIP.has(node.title) ? [...path, node.title] : path;
      if (node.children?.length) walk(node.children, nextPath);
    }
  };

  walk(root, []);
  return items;
}
