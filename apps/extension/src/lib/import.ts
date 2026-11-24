/**
 * 浏览器书签树 → 导入条目展平（F1.1 通道1：一键读取）+ 两条导入通道共用的条目归一。
 * 纯函数，浏览器侧与测试共用。
 *
 * 规则：
 * - 跳过第一层虚拟根（"书签栏"/"收藏夹栏"/"链接"/"" 等）——D55：这一层永远不是用户目录
 * - 叶子节点（url 存在）携带其上方相对 folderPath（不含虚拟根层）
 * - 仅保留 http(s) 链接（chrome://、扩展页不导入）
 * - 按服务端 schema 上限截断（标题 / 目录名 / 目录深度）——一条超限会让整批 100 条 400
 * - 保留 addedAt（浏览器 dateAdded）与 browserId（D44 身份映射）
 */
import { VIRTUAL_BOOKMARK_ROOT_TITLES, isVirtualBookmarkRootTitle } from "@mf/shared";

export interface BookmarkImportItem {
  url: string;
  title: string;
  folderPath: string[];
  addedAt?: string;
  /** D44：浏览器书签节点 id（服务端据此建 A2-1 身份映射，供镜像删除精确定位） */
  browserId?: string;
}

export interface TreeNode {
  id: string;
  title?: string;
  url?: string;
  /** Chrome/Edge bookmarks API：毫秒时间戳 */
  dateAdded?: number;
  children?: TreeNode[];
}

/** 服务端 schema 限制（packages/shared ingestRequest）：防御性截断，避免整批 400 */
const MAX_TITLE = 200; // schema 512，取更保守值
const MAX_FOLDER_DEPTH = 16; // = schema 上限
const MAX_FOLDER_NAME = 256; // = schema 上限

/** dateAdded（毫秒，兼容秒级脏数据）→ ISO；非法值返回 undefined（不让整条条目失效） */
function addedAtOf(raw: number | undefined): string | undefined {
  if (!raw || !Number.isFinite(raw)) return undefined;
  const ms = raw > 1e12 ? raw : raw * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function clampPath(path: string[]): string[] {
  return path
    .slice(0, MAX_FOLDER_DEPTH)
    .map((name) => name.trim().slice(0, MAX_FOLDER_NAME))
    .filter((name) => name.length > 0);
}

/**
 * Netscape 文件通道：剥掉顶层虚拟根再截断。
 * Chrome/Firefox 导出的第一层是「书签栏」「Bookmarks Bar」等容器名，
 * 原样入库会凭空建出同名目录（树通道却跳过了——两条通道结果必须一致）。
 */
export function normalizeFolderPath(path: string[]): string[] {
  let i = 0;
  while (i < path.length && VIRTUAL_BOOKMARK_ROOT_TITLES.has((path[i] ?? "").trim())) i++;
  return clampPath(path.slice(i));
}

/** 两条通道共用的 ingest 条目归一（schema 上限 + 标题兜底） */
export function normalizeIngestItem(
  item: Omit<BookmarkImportItem, "folderPath"> & { folderPath: string[] },
): BookmarkImportItem {
  return {
    url: item.url,
    title: item.title.trim().slice(0, MAX_TITLE) || item.url,
    folderPath: clampPath(item.folderPath),
    ...(item.addedAt ? { addedAt: item.addedAt } : {}),
    ...(item.browserId ? { browserId: item.browserId } : {}),
  };
}

/**
 * 展平浏览器书签树。
 * 深度语义：getTree 的根容器先剥掉，其子节点（书签栏/其他书签…）深度 = 0（虚拟根层），再往下是用户目录。
 * 只有「第一层且标题命中虚拟根集合」才跳过——用户在第 2 层建名叫「链接」的目录仍保留（D55）。
 */
export function flattenBookmarkTree(root: TreeNode[]): BookmarkImportItem[] {
  const items: BookmarkImportItem[] = [];

  const walk = (nodes: TreeNode[], path: string[], depth: number): void => {
    for (const node of nodes) {
      if (node.url) {
        if (!/^https?:/i.test(node.url)) continue; // 只导入 http(s)
        items.push(
          normalizeIngestItem({
            url: node.url,
            title: node.title ?? node.url,
            folderPath: path,
            addedAt: addedAtOf(node.dateAdded),
            browserId: node.id,
          }),
        );
        continue;
      }
      const title = (node.title ?? "").trim();
      // 无名容器 + 第一层虚拟根都不是用户目录
      const isVirtualShell = !title || isVirtualBookmarkRootTitle(title, depth);
      const nextPath = isVirtualShell || path.length >= MAX_FOLDER_DEPTH ? path : [...path, title];
      if (node.children?.length) walk(node.children, nextPath, depth + 1);
    }
  };

  // getTree 返回单个无名根容器，其子节点才是书签栏/其他书签（虚拟根层）
  const onlyRoot = root.length === 1 && !root[0]?.url && !(root[0]?.title ?? "").trim();
  walk(onlyRoot ? (root[0]?.children ?? []) : root, [], 0);
  return items;
}
