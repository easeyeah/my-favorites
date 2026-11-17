/** 服务端 API 客户端与扩展配置（storage 封装） */
import { browser } from "wxt/browser";

export interface ExtensionConfig {
  serverUrl: string;
  /** 浏览器书签树中收件箱文件夹的扩展侧 id（与服务器端 inbox 对应） */
  inboxExtId?: string;
  /** 自建端管理员密码登录后的 token（F6.2 鉴权） */
  token?: string;
  /** 多端同步游标（F1.7） */
  syncCursor?: number;
  /** 周报已读标记（按天） */
  reportReadDate?: string;
}

const DEFAULTS: ExtensionConfig = { serverUrl: "http://localhost:3000" };

export async function getConfig(): Promise<ExtensionConfig> {
  const stored = await browser.storage.local.get(["serverUrl", "inboxExtId", "token", "syncCursor", "reportReadDate"]);
  return {
    ...DEFAULTS,
    ...(stored.serverUrl ? { serverUrl: stored.serverUrl as string } : {}),
    ...(stored.inboxExtId ? { inboxExtId: stored.inboxExtId as string } : {}),
    ...(stored.token ? { token: stored.token as string } : {}),
    ...(stored.syncCursor !== undefined ? { syncCursor: stored.syncCursor as number } : {}),
    ...(stored.reportReadDate ? { reportReadDate: stored.reportReadDate as string } : {}),
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
  "diff_accepted",
  "nav_generated",
  "ntp_enabled",
  "inbox_auto_sorted",
  "snapshot_created",
  "weekly_report_clicked",
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
    throw new Error(`api ${pathname} failed: HTTP ${res.status}`);
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
export interface OrganizeSessionDto {
  sessionId: string;
  status: "proposed" | "answered";
  answer: string;
  proposal: Array<{
    type: "move" | "rename" | "merge" | "createFolder";
    bookmarkId?: string;
    bookmarkTitle?: string;
    fromFolder?: string;
    toFolder?: string;
    mergeFrom?: string[];
    folderName?: string;
  }> | null;
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
    items: Array<{ title: string; url: string; favicon: string | null; dead?: boolean }>;
  }>;
}
