/** 服务端 API 客户端与扩展配置（storage 封装） */
import { browser } from "wxt/browser";

/** 整理通知方式（D28 三档，扩展端与管理台各自设置）：轻提示（默认）/ 通知卡 / 静默仅版本记录 */
export type NotifyStyle = "toast" | "card" | "silent";

export interface ExtensionConfig {
  serverUrl: string;
  /** 浏览器书签树中收纳盒文件夹的扩展侧 id（与服务器端 inbox 对应） */
  inboxExtId?: string;
  /** 自建端管理员密码登录后的 token（F6.2 鉴权） */
  token?: string;
  /** 多端同步游标（F1.7） */
  syncCursor?: number;
  /** 周报已读标记（按天） */
  reportReadDate?: string;
  /** 整理通知方式（D28 端侧偏好；options 页可调） */
  notifyStyle?: NotifyStyle;
  /** 原型 07：收纳盒投递口位置（1=书签栏 默认 / 2=其他书签） */
  inboxParent?: string;
  /** D44：管理台删除书签时是否同步删除浏览器书签（默认关；仅对有身份映射的条目生效）。
   *  D46 起由总开关 favoritesSync 接管，此字段仅作旧配置兼容（保留=尊重用户历史选择）。 */
  syncDeleteToBrowser?: boolean;
  /** D46：收藏夹双向直接同步总开关（默认关；开启即全量对齐 + 每 10 分钟/事件后增量收敛） */
  favoritesSync?: boolean;
}

const DEFAULTS: ExtensionConfig = { serverUrl: "http://127.0.0.1:3000" };

export async function getConfig(): Promise<ExtensionConfig> {
  const stored = await browser.storage.local.get([
    "serverUrl",
    "inboxExtId",
    "token",
    "syncCursor",
    "reportReadDate",
    "notifyStyle",
    "inboxParent",
    "syncDeleteToBrowser",
    "favoritesSync",
  ]);
  return {
    ...DEFAULTS,
    ...(stored.serverUrl ? { serverUrl: stored.serverUrl as string } : {}),
    ...(stored.inboxExtId ? { inboxExtId: stored.inboxExtId as string } : {}),
    ...(stored.token ? { token: stored.token as string } : {}),
    ...(stored.syncCursor !== undefined ? { syncCursor: stored.syncCursor as number } : {}),
    ...(stored.reportReadDate ? { reportReadDate: stored.reportReadDate as string } : {}),
    ...(stored.notifyStyle ? { notifyStyle: stored.notifyStyle as NotifyStyle } : {}),
    ...(stored.inboxParent ? { inboxParent: stored.inboxParent as string } : {}),
    ...(stored.syncDeleteToBrowser !== undefined
      ? { syncDeleteToBrowser: stored.syncDeleteToBrowser as boolean }
      : {}),
    ...(stored.favoritesSync !== undefined ? { favoritesSync: stored.favoritesSync as boolean } : {}),
  };
}

export async function saveConfig(patch: Partial<ExtensionConfig>): Promise<void> {
  await browser.storage.local.set(patch);
}

/** 自建端登录（F6.2）：密码 → token */
export async function login(password: string): Promise<{ token: string }> {
  const { serverUrl } = await getConfig();
  const res = await fetch(`${serverUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, label: "extension" }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  const body = (await res.json()) as { token: string };
  await saveConfig({ token: body.token });
  return body;
}

const EVENTS = [
  "bookmark_saved",
  "install",
  "import_completed",
  "stage1_result_viewed",
  "diff_accepted", // 旧确认流事件（D27 前历史数据）
  "organize_applied", // D27：整理直接生效
  "nav_generated",
  "ntp_enabled",
  "inbox_auto_sorted",
  "snapshot_created",
  "weekly_report_clicked",
  "browser_reordered", // D45：按管理台顺序重排浏览器书签
] as const;
export type EventName = (typeof EVENTS)[number];

/** 埋点批量上报（fire-and-forget，失败静默——埋点永不影响主流程） */
export async function sendEvent(name: EventName, props?: Record<string, unknown>): Promise<void> {
  try {
    const { serverUrl } = await getConfig();
    await fetch(`${serverUrl}/api/v1/analytics/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ name, props }] }),
    });
  } catch {
    // 静默
  }
}

export async function api<T>(
  pathname: string,
  init?: RequestInit & { idempotencyKey?: string },
): Promise<T> {
  const { serverUrl } = await getConfig();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  const { token } = await getConfig();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${serverUrl}/api/v1${pathname}`, { ...init, headers });
  if (!res.ok) {
    // 读响应体里的校验详情（zod 400 会带 issues），错误信息可诊断
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: unknown; error?: string };
      if (body.error) detail = body.error;
      if (Array.isArray(body.detail)) {
        detail += " " + body.detail.map((d) => JSON.stringify(d)).join("; ").slice(0, 300);
      }
    } catch {
      // body 非 JSON
    }
    throw new Error(`api ${pathname} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

// ---------- API 类型 ----------
export interface BookmarkDto {
  id: string;
  folder_id: string;
  url_canonical: string;
  title: string;
  status: string;
  duplicate?: boolean;
}
export interface SuggestDto {
  category: string;
  confidence: number;
  source: "domain_cache" | "domain_map" | "keyword" | "none";
  folderId: string | null;
  folderPath: string[];
  privacy: boolean;
}
export interface FolderDto {
  id: string;
  name: string;
  parent_id: string | null;
  is_system_inbox: number;
}

/** 收纳盒面板条目（原型 06 状态机） */
export interface InboxItemDto {
  id: string;
  title: string;
  url_canonical: string;
  added_at: string;
  is_private: number;
  state: "pending" | "classifying" | "placed" | "ambiguous" | "privacy_hold" | "retry" | string;
  confidence: number | null;
  reason: string | null;
  attempts: number;
  suggestCategory: string | null;
  domainRuleFolderId: string | null;
}

export interface InboxPlacedDto {
  bookmark_id: string;
  title: string;
  url_canonical: string;
  reason: string | null;
  updated_at: string;
  version_id: string | null;
  /** D54：归位目标目录名（回答「它去哪了」） */
  folder_name: string | null;
}

export interface VersionDto {
  id: string;
  session_id: string | null;
  kind: string;
  reverted: number;
  created_at: string;
  actionCount: number;
}
/** D27 act + undo：一次调用直接生效；actions 为只读明细（事后呈现，不承担确认职责） */
export interface OrganizeRunDto {
  sessionId: string;
  status: "applied" | "answered";
  answer: string;
  actions: Array<{
    type: "move" | "rename" | "merge" | "createFolder" | string;
    bookmarkId?: string;
    bookmarkTitle?: string;
    fromFolder?: string;
    toFolder?: string;
    mergeFrom?: string[];
    folderName?: string;
  }> | null;
  versionId?: string;
  applied?: number;
  conflicts?: Array<{ bookmarkId: string; reason: string }>;
}
/** 上传 MHTML 快照（F2.4 一键快照） */
export async function uploadSnapshot(
  bookmarkId: string,
  mhtml: ArrayBuffer,
): Promise<{ id: string; size: number }> {
  const { serverUrl, token } = await getConfig();
  const res = await fetch(`${serverUrl}/api/v1/snapshots?bookmarkId=${encodeURIComponent(bookmarkId)}`, {
    method: "POST",
    headers: { "content-type": "message/rfc822", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: mhtml,
  });
  if (!res.ok) throw new Error(`snapshot upload failed: HTTP ${res.status}`);
  return (await res.json()) as { id: string; size: number };
}

/** 多端同步：拉取增量（F1.7） */
export async function syncPull(): Promise<{
  items: Array<{ entity: string; entity_id: string; op: string; payload: unknown }>;
  cursor: number;
}> {
  const { syncCursor = 0 } = await getConfig();
  return api<{ items: Array<{ entity: string; entity_id: string; op: string; payload: unknown }>; cursor: number }>(
    `/sync/pull?cursor=${syncCursor}&device=extension`,
    {},
  );
}

export interface WeeklyReport {
  findings: { dead?: number; suspect?: number; groups?: number };
  created_at: string;
}

/** 周报拉取（F5.5 留存钩子④） */
export async function fetchWeeklyReport(): Promise<WeeklyReport | null> {
  try {
    return await api<WeeklyReport>("/maintenance/report/latest?type=link_check", {});
  } catch {
    return null;
  }
}

export interface NavDataDto {
  title: string;
  groups: Array<{
    name: string;
    items: Array<{
      title: string;
      url: string;
      favicon: string | null;
      dead?: boolean;
      summary?: string | null;
      siteType?: string | null;
      hasSnapshot?: boolean;
    }>;
  }>;
}
