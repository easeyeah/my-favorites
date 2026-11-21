export * from "./url";
export * from "./classify-rules";
export * from "./site-signal";
export * from "./material";
export * from "./netscape";
export * from "./eval-samples";
export * from "./privacy";
export * from "./sensitive";
export * from "./widgets";

/** 领域类型 —— 技术方案 §4 数据模型的 TS 侧镜像（DB schema 以 server 端 Drizzle 为准） */

export type BookmarkStatus = "normal" | "dead" | "suspect" | "archived";

export type FetchVia = "extension_capture" | "server_crawl";

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  sort: number;
  /** imported | ai_created | user */
  source: "imported" | "ai_created" | "user";
  /** 自动收纳系统目录（F1.5/D36「收纳盒」）：每个空间至多一个 */
  isSystemInbox: boolean;
}

/** 系统收纳盒的展示名（D36：UI 文案层一律「收纳盒」；代码层 is_system_inbox、/inbox/* 内部命名保留） */
export const INBOX_FOLDER_TITLE = "📥 收纳盒";


/**
 * D55：Edge/Chrome 书签树的顶层虚拟节点标题（"书签栏"/"收藏夹栏"/"Other favorites"…）。
 * 这一层**永远不是用户文件夹**——任何「浏览器树 ↔ 库目录路径」匹配必须穿透它。
 * 曾因把它当真实层级，同步引擎把「收藏夹栏/xxx」整棵复制进库与书签栏，制造批量重复目录。
 */
export const VIRTUAL_BOOKMARK_ROOT_TITLES: ReadonlySet<string> = new Set([
  "",
  "书签栏",
  "收藏夹栏",
  "收藏夹",
  "链接", // Edge 中文"其他收藏夹"节点名（实测出现在第一层）
  "其他书签",
  "其他收藏夹",
  "Bookmarks Bar",
  "Favorites Bar",
  "Favorites",
  "Links",
  "Other bookmarks",
  "Other favorites",
]);

/** 浏览器树节点是否为顶层虚拟节点（仅当处于第一层时按标题判定；真实文件夹允许同名） */
export function isVirtualBookmarkRootTitle(title: string | undefined, depth: number): boolean {
  return depth === 0 && VIRTUAL_BOOKMARK_ROOT_TITLES.has((title ?? "").trim());
}

export interface Bookmark {
  id: string;
  folderId: string;
  urlRaw: string;
  urlCanonical: string;
  title: string;
  description: string | null;
  status: BookmarkStatus;
  faviconUrl: string | null;
  coverUrl: string | null;
  addedAt: string;
  lastCheckedAt: string | null;
  pinned: boolean;
}

/** L1/L2 内容缓存（云端默认只存 L1+L2，L3 快照见 snapshot） */
export interface ContentCache {
  bookmarkId: string;
  l1Summary: string | null;
  l1Tags: string[];
  keywords: string[];
  l2Text: string | null;
  lang: string | null;
  fetchedVia: FetchVia;
  fetchedAt: string;
  /** null = 抓取成功 */
  failReason: string | null;
}

/** 整理版本 diff —— 收件箱自动归位与聊天整理共用（回滚 = 逆放） */
export type OrganizeAction =
  | { type: "move"; bookmarkId: string; fromFolderId: string; toFolderId: string }
  | { type: "rename"; bookmarkId: string; from: string; to: string }
  | { type: "merge"; fromBookmarkIds: string[]; intoBookmarkId: string }
  | { type: "createFolder"; folderId: string; parentId: string | null; name: string }
  // D43 敏感内容旁路：标私密（+可选移入私人收藏）；fromPrivate 携原值供精确回滚
  | { type: "markPrivate"; bookmarkId: string; fromPrivate: 0 | 1; fromFolderId: string; toFolderId: string | null };

export interface OrganizeVersion {
  id: string;
  actions: OrganizeAction[];
  createdAt: string;
  reverted: boolean;
}

// ---------- zod schema（API 边界校验，扩展与服务端共用） ----------

import { z } from "zod";

export const bookmarkIngestItem = z.object({
  url: z.string().min(1),
  title: z.string().min(1).max(512),
  folderPath: z.array(z.string().max(256)).max(16).default([]),
  addedAt: z.string().datetime().optional(),
  /** D44：浏览器书签节点 id（配合 ingestRequest.deviceId 建立 A2-1 身份映射，镜像删除靠它精确定位） */
  browserId: z.string().min(1).max(64).optional(),
});

export const ingestRequest = z.object({
  items: z.array(bookmarkIngestItem).min(1).max(2000),
  /** 幂等键：扩展 SW 中断重试不重复导入 */
  idempotencyKey: z.string().min(8).max(128),
  /** D44：导入来源设备（提供且条目带 browserId 时写入 bookmark_identity） */
  deviceId: z.string().min(8).max(64).optional(),
});

export type IngestRequest = z.infer<typeof ingestRequest>;

export const captureRequest = z.object({
  bookmarkId: z.string().min(1),
  /** Readability 提取的正文（L2），截断由服务端执行（红线：20KB/条） */
  l2Text: z.string().max(40_000).optional(),
  description: z.string().max(2_000).optional(),
  faviconDataUrl: z.string().max(100_000).optional(),
  /** D61 资料库：页面 og:image（视频封面/文章封面/图片主图线索），绝对 URL；服务端经 server_fetch 动作下载落盘 */
  ogImage: z.string().url().max(2_048).optional(),
});

export type CaptureRequest = z.infer<typeof captureRequest>;

/** 隐私域名校验 —— 在分类引擎内部强制执行（AGENTS.md 红线 2），非可选步骤 */
export interface PrivacyDomainList {
  patterns: string[];
}

/**
 * 域名级隐私判定。DEV-03 修订：直接解析 host（不经 canonicalizeUrl——查重键规则
 * 会拒绝非 http(s)，但隐私判定必须覆盖任意 scheme）；解析失败保守按隐私处理。
 */
export function isPrivacyDomain(url: string, list: PrivacyDomainList): boolean {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return true; // 解析不了的 URL 按隐私处理（保守，不外发）
  }
  return list.patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase(); // 用户可录入大写条目（*.Alipay.COM），须与 host 同口径比较
    if (!pattern) return false;
    if (pattern.startsWith("*.")) {
      return host.endsWith(pattern.slice(1));
    }
    return host === pattern || host.endsWith(`.${pattern}`);
  });
}

/** 内置默认隐私清单（技术方案 §9）：银行/内网段——用户可增不可删内置项 */
export const DEFAULT_PRIVACY_DOMAINS: PrivacyDomainList = {
  patterns: [
    "*.bank",
    "*.local",
    "localhost",
    "127.0.0.1",
    "10.0.0.0/8-placeholder",
  ].filter((p) => !p.includes("/")),
};
