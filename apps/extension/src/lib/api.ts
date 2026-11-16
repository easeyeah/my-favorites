/** 服务端 API 客户端与扩展配置（storage 封装） */
import { browser } from "wxt/browser";

export interface ExtensionConfig {
  serverUrl: string;
  /** 浏览器书签树中收件箱文件夹的扩展侧 id（与服务器端 inbox 对应） */
  inboxExtId?: string;
}

const DEFAULTS: ExtensionConfig = { serverUrl: "http://localhost:3000" };

export async function getConfig(): Promise<ExtensionConfig> {
  const stored = await browser.storage.local.get(["serverUrl", "inboxExtId"]);
  return {
    ...DEFAULTS,
    ...(stored.serverUrl ? { serverUrl: stored.serverUrl as string } : {}),
    ...(stored.inboxExtId ? { inboxExtId: stored.inboxExtId as string } : {}),
  };
}

export async function saveConfig(patch: Partial<ExtensionConfig>): Promise<void> {
  await browser.storage.local.set(patch);
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
export interface NavDataDto {
  title: string;
  groups: Array<{
    name: string;
    items: Array<{ title: string; url: string; favicon: string | null; dead?: boolean }>;
  }>;
}
