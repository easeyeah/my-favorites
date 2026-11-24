/** 服务端 API 客户端与扩展配置（storage 封装） */
import { browser } from "wxt/browser";

/** 官方云服务地址（D67 云形态；筹备期占位，服务上线后即用） */
export const OFFICIAL_CLOUD_URL = "https://cloud.my-favorites.app";

/** 已保存的服务条目（D67 Bitwarden 式服务下拉：官方云内置不入列，其余为用户添加的自建/自部署服务） */
export interface ServerEntry {
  url: string;
  /** 下拉展示名（添加时选填，默认取主机名） */
  label: string;
  /** 形态由 /healthz 探测自动判定（决定登录表单是管理员密码还是用户名+密码） */
  mode?: "self" | "cloud";
}

/** 整理通知方式：统一在管理台设置；card 目前与 toast 使用相同提示，silent 仅保留版本记录。 */
export type NotifyStyle = "toast" | "card" | "silent";

export interface ExtensionConfig {
  serverUrl: string;
  /** 浏览器书签树中收纳盒文件夹的扩展侧 id（与服务器端 inbox 对应） */
  inboxExtId?: string;
  /** 自建端管理员密码登录后的 token（F6.2 鉴权） */
  token?: string;
  /** D67：登录身份展示名（自建=管理员；云端=用户名） */
  accountName?: string;
  /** D67：服务形态（自建=self 默认 / 云端=cloud）；云地址可改后不能再从 URL 推断，显式持久化 */
  serverMode?: "self" | "cloud";
  /** D67 Bitwarden 式：已保存的自建/自部署服务列表（官方云为内置项不入列） */
  servers?: ServerEntry[];
  /** 各服务地址的令牌记忆（切换服务免重登；config.token 恒等于当前服务的令牌） */
  serverTokens?: Record<string, string>;
  /** 下拉当前选中的服务地址 */
  activeServer?: string;
  /** 多端同步游标（F1.7） */
  syncCursor?: number;
  /** 周报已读标记（按天） */
  reportReadDate?: string;
  /** 仅兼容旧本地配置；不再消费或覆盖服务端 notify_style，通知统一在管理台设置。 */
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
    "accountName",
    "serverMode",
    "servers",
    "serverTokens",
    "activeServer",
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
    ...(stored.accountName ? { accountName: stored.accountName as string } : {}),
    ...(stored.serverMode ? { serverMode: stored.serverMode as "self" | "cloud" } : {}),
    ...(stored.servers ? { servers: stored.servers as ServerEntry[] } : {}),
    ...(stored.serverTokens ? { serverTokens: stored.serverTokens as Record<string, string> } : {}),
    ...(stored.activeServer ? { activeServer: stored.activeServer as string } : {}),
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

/** 完成通知专用：按当前服务 + 令牌读取管理台偏好，不缓存、不使用旧本地 notifyStyle。
 * expected 绑定发起整理时的身份；请求期间退出/切服/换号时返回 null，丢弃旧身份的通知。
 * 只能在非核心完成通知路径调用；3 秒预算覆盖请求与响应体，失败降级 toast 并留下脱敏诊断。 */
export async function getServerNotifyStyle(
  expected?: Pick<ExtensionConfig, "serverUrl" | "token">,
): Promise<NotifyStyle | null> {
  const account = await getConfig();
  const sameAccount = (other: Pick<ExtensionConfig, "serverUrl" | "token">): boolean =>
    other.serverUrl === account.serverUrl && other.token === account.token;
  if (expected && !sameAccount(expected)) return null;
  // 退出后不匿名读取开发服务的 owner 偏好，也不借用其他服务记忆的令牌。
  if (!account.token) return "toast";

  let style: NotifyStyle = "toast";
  let reason: string | null = null;
  try {
    // 不走 api() 的两次配置读取，避免切服务窗口将旧地址与新令牌拼到同一请求。
    const res = await fetch(`${account.serverUrl.replace(/\/+$/, "")}/api/v1/settings/prefs`, {
      headers: { authorization: `Bearer ${account.token}` },
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      priority: "low",
    });
    if (!res.ok) {
      reason = `http_${res.status}`;
    } else {
      const prefs = (await res.json()) as { notifyStyle?: unknown } | null;
      if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
        reason = "invalid_response";
      } else if (prefs.notifyStyle === "toast" || prefs.notifyStyle === "card" || prefs.notifyStyle === "silent") {
        style = prefs.notifyStyle;
      } else if (prefs.notifyStyle !== undefined) {
        reason = "invalid_notify_style";
      }
    }
  } catch (err) {
    reason = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "request_failed";
  }

  // 成功和失败回退都要核对身份，不能将旧账号的 silent 或 fallback 应用到新账号。
  if (!sameAccount(await getConfig())) return null;
  if (reason) console.warn("[notify] server preference unavailable; falling back to toast:", reason);
  try {
    // 仅诊断，不存令牌、偏好值、响应体或原始异常；失败不影响已完成的整理。
    await browser.storage.local.set({
      mfNotifyPrefsLastError: reason ? { reason, at: new Date().toISOString() } : null,
    });
  } catch {
    console.warn("[notify] preference diagnostic could not be stored");
  }
  return sameAccount(await getConfig()) ? style : null;
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
  await saveConfig({ token: body.token, accountName: "管理员" });
  return body;
}

/** D73：所有部署统一的用户名 + 密码登录；错误码由调用方映射为可行动文案。 */
export async function loginAccount(
  username: string,
  password: string,
): Promise<{ token: string; username?: string }> {
  const { serverUrl } = await getConfig();
  const res = await fetch(`${serverUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, label: "extension" }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; username?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `login failed: HTTP ${res.status}`);
  await saveConfig({ token: body.token!, accountName: body.username ?? username });
  return { token: body.token!, username: body.username };
}

/** 统一注册：是否可用由目标实例管理员的注册开关决定；成功即签发首令牌。 */
export async function registerAccount(
  username: string,
  password: string,
): Promise<{ token: string; username?: string }> {
  const { serverUrl } = await getConfig();
  const res = await fetch(`${serverUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, label: "extension" }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; username?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `register failed: HTTP ${res.status}`);
  await saveConfig({ token: body.token!, accountName: body.username ?? username });
  return { token: body.token!, username: body.username };
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
