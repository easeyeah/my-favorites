/**
 * 服务端 API 客户端与领域类型（管理台唯一数据出口）。
 * 配置持久化：serverUrl → localStorage；token → localStorage（记住设备）或 sessionStorage（会话级）。
 * 演示模式（?mock / VITE_MOCK=1）：网络层统一改走 lib/mock.ts 的内存后端，页面代码无感知。
 */
import { isMock, mockBlob, mockRequestAsync, mockRootPost, MOCK_SERVER_INFO } from "./mock";

const CONFIG_KEY = "mf-admin-config";
const TOKEN_KEY = "mf-admin-token";

export interface AdminConfig {
  serverUrl: string;
  token: string;
}

export interface HealthInfo {
  ok: boolean;
  form: string;
  version: string;
  deployMode?: "unified" | "self" | "cloud";
  registrationOpen?: boolean;
}

export interface AuthIdentity {
  userId: string;
  username: string | null;
  displayName: string | null;
  role: "admin" | "user";
  isAdmin: boolean;
  registrationOpen: boolean;
  deployMode: "unified" | "self" | "cloud";
}

export interface SystemUser {
  id: string;
  username: string;
  display_name: string | null;
  role: "admin" | "user";
  disabled_at: string | null;
  created_at: string;
}

/** 由页面托管方式推断默认服务端：同源即服务端（生产由服务端静态托管；dev 由 vite 代理到 3000） */
export function defaultServerUrl(): string {
  if (typeof location === "undefined") return "http://127.0.0.1:3000";
  if (location.protocol.startsWith("http")) return location.origin;
  return "http://127.0.0.1:3000";
}

export function loadConfig(): AdminConfig {
  let saved: Partial<AdminConfig> = {};
  try {
    saved = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}") as Partial<AdminConfig>;
  } catch {
    /* 忽略坏配置，回退默认 */
  }
  const token =
    localStorage.getItem(TOKEN_KEY) ??
    sessionStorage.getItem(TOKEN_KEY) ??
    tokenFor(saved.serverUrl ?? '');
  return {
    serverUrl: saved.serverUrl ?? defaultServerUrl(),
    token,
  };
}

export function saveServerUrl(serverUrl: string): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ serverUrl }));
}

// ---------- 多服务端：列表 + 按服务端记忆令牌（切换免重复登录） ----------

const SERVERS_KEY = 'mf-servers'
const TOKENS_KEY = 'mf-tokens'

/** 官方云服务地址（云形态上线前的规划常量；上线后零改动生效） */
export const OFFICIAL_CLOUD_URL = 'https://cloud.my-favorites.app'

export function loadServerList(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(SERVERS_KEY) ?? '[]') as string[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function saveServerList(urls: string[]): void {
  localStorage.setItem(SERVERS_KEY, JSON.stringify(urls))
}

export function tokenFor(serverUrl: string): string {
  try {
    const map = JSON.parse(localStorage.getItem(TOKENS_KEY) ?? '{}') as Record<string, string>
    return map[serverUrl] ?? ''
  } catch {
    return ''
  }
}

export function rememberTokenFor(serverUrl: string, token: string): void {
  let map: Record<string, string> = {}
  try {
    map = JSON.parse(localStorage.getItem(TOKENS_KEY) ?? '{}') as Record<string, string>
  } catch {
    /* 忽略坏数据 */
  }
  if (token) map[serverUrl] = token
  else delete map[serverUrl]
  localStorage.setItem(TOKENS_KEY, JSON.stringify(map))
}

/** 记住设备 → 长期保存在 localStorage；否则仅当前标签会话。带 serverUrl 时同时按服务端记忆令牌 */
export function storeToken(token: string, remember: boolean, serverUrl?: string): void {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  if (serverUrl) rememberTokenFor(serverUrl, token);
  if (!token) return;
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public path: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiUrl(cfg: AdminConfig, path: string): string {
  return `${cfg.serverUrl.replace(/\/$/, "")}${path}`;
}

// ---------- D43「显示私密」：管理台可见性开关（服务端边界 = X-MF-Private 请求头） ----------

/** localStorage 键名（「显示私密」开关的持久化位；非凭据） */
const PRIVATE_VISIBLE_STORAGE_KEY = "mf-show-private";

export function loadPrivateVisible(): boolean {
  try {
    return localStorage.getItem(PRIVATE_VISIBLE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 状态持久：刷新后保持上次的私密可见性 */
export function savePrivateVisible(v: boolean): void {
  try {
    localStorage.setItem(PRIVATE_VISIBLE_STORAGE_KEY, v ? "1" : "0");
  } catch {
    /* 忽略存储失败 */
  }
}

/** 读类接口统一携带：开 → 显示私密项；关（默认）→ 服务端过滤（DEV-02 边界不变） */
function privateHeaders(): Record<string, string> {
  return loadPrivateVisible() ? { "X-MF-Private": "1" } : {};
}

async function api<T>(cfg: AdminConfig, path: string, init?: RequestInit, timeoutMs = 10 * 60_000): Promise<T> {
  if (isMock()) {
    const bodyStr = typeof init?.body === "string" ? init.body : undefined;
    const data = await mockRequestAsync(init?.method ?? "GET", path, {
      query: new URLSearchParams(path.split("?")[1] ?? ""),
      body: bodyStr ? (JSON.parse(bodyStr) as unknown) : undefined,
      headers: init?.headers as Record<string, string> | undefined,
    });
    if (data === undefined) throw new ApiError(404, path, "演示模式未覆盖该接口");
    return data as T;
  }
  let res: Response;
  try {
    // D82：调用方信号（视图切换取消旧请求）与长兜底超时合并——任一触发即中止。
    // 长兜底：维护任务（死链探测）是同步长任务，可达数分钟
    const timeout = AbortSignal.timeout(timeoutMs);
    res = await fetch(apiUrl(cfg, `/api/v1${path}`), {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      headers: {
        "content-type": "application/json",
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  } catch (err) {
    // 调用方主动取消（视图切换）原样抛出，与网络失败区分——刷新批次据此静默丢弃
    if (init?.signal?.aborted) throw err;
    throw new ApiError(0, path, err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
    throw new ApiError(res.status, path, body.hint ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** 二进制/文本下载（导出）：失败同样抛 ApiError */
async function apiDownload(cfg: AdminConfig, path: string): Promise<Blob> {
  if (isMock()) {
    await new Promise((r) => setTimeout(r, 300));
    return mockBlob(path);
  }
  const res = await fetch(apiUrl(cfg, `/api/v1${path}`), {
    signal: AbortSignal.timeout(2 * 60_000),
    headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
  });
  if (!res.ok) throw new ApiError(res.status, path, `HTTP ${res.status}`);
  return res.blob();
}

async function apiRawText(cfg: AdminConfig, path: string, body: string): Promise<unknown> {
  if (isMock()) {
    const data = await mockRequestAsync("POST", path, { query: new URLSearchParams(), html: body });
    if (data === undefined) throw new ApiError(404, path, "演示模式未覆盖该接口");
    return data;
  }
  const res = await fetch(apiUrl(cfg, `/api/v1${path}`), {
    method: "POST",
    signal: AbortSignal.timeout(2 * 60_000),
    headers: {
      "content-type": "text/html",
      ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
    },
    body,
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, path, j.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** 不带鉴权探活：返回 null 表示不可达 */
export async function probeHealth(serverUrl: string): Promise<HealthInfo | null> {
  if (isMock()) return MOCK_SERVER_INFO;
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as HealthInfo;
  } catch {
    return null;
  }
}

/** 未认证请求（登录/首启设置） */
async function rootPost<T>(
  cfg: AdminConfig,
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  if (isMock()) {
    const json = mockRootPost(path, body) as Record<string, unknown>;
    if (json && typeof json.error === "string") {
      const err = new ApiError(400, path, json.error);
      (err as ApiError & { payload?: Record<string, unknown> }).payload = json;
      throw err;
    }
    return json as T;
  }
  const res = await fetch(apiUrl(cfg, path), {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = new ApiError(res.status, path, String(json.error ?? `HTTP ${res.status}`));
    (err as ApiError & { payload?: Record<string, unknown> }).payload = json;
    throw err;
  }
  return json as T;
}

export const auth = {
  /** 兼容旧客户端：留空用户名，仅使用旧管理员密码登录 owner。 */
  login: (cfg: AdminConfig, password: string, label: string) =>
    rootPost<{ token: string; tokenId: string }>(cfg, "/auth/login", { password, label }),
  /** D73：所有部署统一的用户名 + 密码登录。 */
  loginAccount: (cfg: AdminConfig, username: string, password: string, label: string) =>
    rootPost<{ token: string; tokenId: string; username?: string; displayName?: string | null }>(
      cfg,
      "/auth/login",
      { username, password, label },
    ),
  /** 注册是否可用仅由目标实例管理员的注册开关决定。 */
  register: (cfg: AdminConfig, username: string, password: string, label: string) =>
    rootPost<{ token: string; tokenId: string; username?: string; displayName?: string | null }>(
      cfg,
      "/auth/register",
      { username, password, label },
    ),
  /** 当前身份与系统管理权限（所有部署同一契约）。 */
  me: (cfg: AdminConfig) => api<AuthIdentity>(cfg, "/auth/me"),
  /** 修改当前账号密码；owner 的 env 密码由部署配置管理。 */
  changePassword: (cfg: AdminConfig, oldPassword: string, newPassword: string) =>
    api<{ changed: boolean }>(cfg, "/auth/password", {
      method: "POST",
      body: JSON.stringify({ oldPassword, newPassword }),
    }),
  /** 首启设置：生产语义要求部署引导凭据（MF_SETUP_TOKEN env / dataDir 引导文件），走请求头下发 */
  setup: (cfg: AdminConfig, password: string, setupToken: string) =>
    rootPost<{ token?: string }>(cfg, "/api/v1/admin/setup", { password }, { "x-mf-setup-token": setupToken }),
};

/** 鉴权探测：200=已认证（或服务端未启用鉴权）；401=需要登录 */
export async function probeAuthorized(cfg: AdminConfig): Promise<"authed" | "unauthorized" | "offline"> {
  if (isMock()) return "authed";
  try {
    const res = await fetch(apiUrl(cfg, "/api/v1/stats"), {
      signal: AbortSignal.timeout(5000),
      headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
    });
    return res.ok ? "authed" : "unauthorized";
  } catch {
    return "offline";
  }
}

export const apiCall = api;
export const apiDownloadBlob = apiDownload;
export const apiPostHtml = apiRawText;

// ---------- 领域类型（与服务端 store.ts 对齐） ----------

export interface Bookmark {
  id: string;
  folder_id: string;
  url_raw: string;
  url_canonical: string;
  title: string;
  description: string | null;
  status: string; // normal | dead | suspect | archived
  favicon_url: string | null;
  added_at: string;
  last_checked_at: string | null;
  pinned: number;
  is_private: number;
  archived_into?: string | null;
  /** D30 站点化三类标注（site_tool/site_ref/content；null = 未分析） */
  site_type?: string | null;
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  is_system_inbox: number;
}

export interface FolderTreeNode extends Folder {
  directCount: number;
  totalCount: number;
}

export interface CacheInfo {
  l1_summary?: string | null;
  l1_tags?: string[];
  keywords?: string[];
  lang?: string | null;
  fetched_via?: string;
  fetched_at?: string;
  fail_reason?: string | null;
  l2_text?: string | null;
}

export interface BookmarkDetail extends Bookmark {
  cache: CacheInfo | null;
}

/** D54 收纳盒「最近归位」行（去向目录 + 理由 + 可撤销版本） */
export interface InboxPlaced {
  bookmark_id: string;
  title: string;
  url_canonical: string;
  reason: string | null;
  updated_at: string;
  version_id: string | null;
  folder_name: string | null;
}

export interface Stats {
  total: number;
  dead: number;
  suspect: number;
  folders: number;
  navSites: number;
}

export interface HealthReport {
  dead: number;
  suspect: number;
  duplicates: number;
  stale: number;
  oldestBookmark: string | null;
  snapshotUsageMb: number;
}

export interface LinkResult {
  id: string;
  url: string;
  title?: string;
  verdict: "normal" | "suspect" | "dead";
  detail: string;
  /** 原型 14：📸 有快照 → 「失效≠丢失」回看入口 */
  hasSnapshot?: boolean;
  folderName?: string | null;
  added_at?: string;
}

export interface ArchiveCandidate {
  id: string;
  title: string;
  url_canonical: string;
  folder_id: string;
  added_at: string;
  hasSnapshot: boolean;
}

export interface LinkCheckReport {
  id: string;
  created_at: string;
  findings: {
    checked: number;
    dead: number;
    suspect: number;
    normal: number;
    deadWithSnapshot?: number;
    results?: LinkResult[];
    /** 归档建议（永不自动执行，红线③；一键归档由用户点） */
    archiveCandidates?: ArchiveCandidate[];
  };
}

export interface DupSuggestion {
  keep: string;
  title: string;
  dupes: string[];
  items?: Array<{ id: string; title: string; url: string; isKeep: boolean }>;
}

export interface DupScanReport {
  id: string;
  created_at: string;
  findings: {
    groups: number;
    suggestions: DupSuggestion[];
  };
}

export interface VersionRow {
  id: string;
  session_id: string | null;
  kind: string;
  reverted: number;
  created_at: string;
  actionCount: number;
}

export interface ProposalAction {
  type: string; // move | merge | createFolder | ...
  bookmarkTitle?: string;
  fromFolder?: string;
  toFolder?: string;
  mergeFrom?: string[];
  folderName?: string;
}

/** D27 act + undo：一次调用直接生效；actions 为只读明细（事后呈现，不承担确认职责） */
export interface OrganizeResponse {
  sessionId: string;
  status: "applied" | "answered";
  answer: string;
  actions: ProposalAction[] | null;
  versionId?: string;
  applied?: number;
  conflicts?: Array<{ bookmarkId: string; reason: string }>;
}

export interface NavSite {
  slug: string;
  title: string;
  template: string;
  published: number;
  revision: number;
}

export interface NavSiteDetail extends NavSite {
  hasPassword: boolean;
  scope: { folderIds?: string[]; bookmarkIds?: string[] };
  itemCount: number;
  /** 原型 13：主题色/显示选项/水印/自定义卡（整体替换语义） */
  config?: NavSiteConfig;
}

export interface NavSiteConfig {
  themeColor?: string;
  showSummary?: boolean;
  snapshotBadge?: boolean;
  watermark?: boolean;
  includeRef?: boolean;
  customCards?: Array<{ title: string; url: string; desc?: string; favicon?: string }>;
}

export interface ProviderConfigRow {
  id: string;
  provider_id: string;
  base_url: string;
  api_key: string | null; // 服务端只回 "********"
  has_key?: boolean;
  purpose_models: Partial<Record<"organize" | "summarize" | "embedding", string>>;
  enabled: number;
  created_at?: string;
}

export interface TokenRow {
  current?: boolean;
  token_id: string;
  label: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

/** D61 资料库条目（列表行）：正文/摘要引用 content_cache；category = AI 两级分类路径（"一级/二级"） */
export interface MaterialRow {
  id: string;
  bookmark_id: string;
  type: "article" | "video" | "image";
  category: string | null;
  title: string;
  url_canonical: string;
  url_raw: string;
  favicon_url: string | null;
  folder_id: string;
  folder_name: string | null;
  added_at: string;
  l1_summary: string | null;
  l1_tags: string[];
  l2_len: number;
  snapshot_count: number;
  cover_url: string | null;
  cover_mime: string | null;
  has_cover: boolean;
  signals: string[];
  meta: Record<string, unknown>;
  created_at: string;
}

export interface MaterialDetail extends MaterialRow {
  is_private: number;
  l2_text: string | null;
}

export interface MaterialCounts {
  total: number;
  article: number;
  video: number;
  image: number;
}

/** D65 资料库分面统计（左侧面板）：AI 分类树计数 + AI 标签频次榜；未分类 = total − Σcategories */
export interface MaterialFacets {
  categories: Array<{ category: string; count: number }>;
  tags: Array<{ tag: string; count: number }>;
}

// ---------- 常用便捷封装 ----------

export const fetchers = {
  stats: (cfg: AdminConfig) => api<Stats>(cfg, "/stats"),
  healthReport: (cfg: AdminConfig) => api<HealthReport>(cfg, "/health-report"),
  folderTree: (cfg: AdminConfig, signal?: AbortSignal) =>
    api<FolderTreeNode[]>(cfg, "/folders/tree", { headers: privateHeaders(), signal }),
  bookmarks: (
    cfg: AdminConfig,
    q: {
      folderId?: string;
      status?: string;
      siteType?: string;
      hasSnapshot?: boolean;
      limit?: number;
      offset?: number;
    },
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams();
    if (q.folderId) p.set("folderId", q.folderId);
    if (q.status) p.set("status", q.status);
    if (q.siteType) p.set("siteType", q.siteType);
    if (q.hasSnapshot) p.set("hasSnapshot", "1");
    if (q.limit !== undefined) p.set("limit", String(q.limit));
    if (q.offset !== undefined) p.set("offset", String(q.offset));
    return api<Bookmark[]>(cfg, `/bookmarks?${p}`, { headers: privateHeaders(), signal });
  },
  bookmarkDetail: (cfg: AdminConfig, id: string, signal?: AbortSignal) =>
    api<BookmarkDetail>(cfg, `/bookmarks/${id}`, { signal }),
  inboxItems: (cfg: AdminConfig, signal?: AbortSignal) =>
    api<{ items: unknown[]; placed: InboxPlaced[]; ambiguousCount: number }>(cfg, "/inbox/items", { signal }),
  snapshots: (cfg: AdminConfig, bookmarkId: string) =>
    api<{ snapshots: Array<{ id: string; created_at: string; size: number; via: string }> }>(
      cfg,
      `/snapshots?bookmarkId=${encodeURIComponent(bookmarkId)}`,
    ),
  snapshotViewUrl: (cfg: AdminConfig) => `${cfg.serverUrl}/api/v1/snapshots`,
  search: (cfg: AdminConfig, q: string, semantic?: 1, signal?: AbortSignal) =>
    api<{ results: Bookmark[]; mode?: string }>(
      cfg,
      `/search?q=${encodeURIComponent(q)}${semantic ? "&semantic=1" : ""}`,
      { headers: privateHeaders(), signal },
    ),
  versions: (cfg: AdminConfig) => api<{ versions: VersionRow[] }>(cfg, "/organize/versions"),
  linkReport: (cfg: AdminConfig, signal?: AbortSignal) =>
    api<LinkCheckReport>(cfg, "/maintenance/report/latest?type=link_check", { signal }),
  dupReport: (cfg: AdminConfig) => api<DupScanReport>(cfg, "/maintenance/report/latest?type=duplicate_scan"),
  navSites: (cfg: AdminConfig) => api<NavSite[]>(cfg, "/nav/sites"),
  navSiteDetail: (cfg: AdminConfig, slug: string) => api<NavSiteDetail>(cfg, `/nav/sites/${slug}`),
  providers: (cfg: AdminConfig) => api<ProviderConfigRow[]>(cfg, "/settings/providers"),
  tokens: (cfg: AdminConfig) => api<{ tokens: TokenRow[] }>(cfg, "/auth/tokens"),
  system: (cfg: AdminConfig) =>
    api<{ registrationOpen: boolean; users: SystemUser[] }>(cfg, "/admin/system"),
  setRegistrationOpen: (cfg: AdminConfig, registrationOpen: boolean) =>
    api<{ registrationOpen: boolean }>(cfg, "/admin/system", {
      method: "PATCH",
      body: JSON.stringify({ registrationOpen }),
    }),
  createUser: (cfg: AdminConfig, input: { username: string; password: string; role: "admin" | "user" }) =>
    api<{ user: SystemUser }>(cfg, "/admin/users", { method: "POST", body: JSON.stringify(input) }),
  updateUser: (
    cfg: AdminConfig,
    id: string,
    input: { disabled?: boolean; role?: "admin" | "user"; newPassword?: string },
  ) =>
    api<{ user: SystemUser; revokedTokens: number }>(cfg, `/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  exportUser: (cfg: AdminConfig, id: string) =>
    apiDownload(cfg, `/admin/users/${encodeURIComponent(id)}/export`),
  /** D67 账号与安全：按非密 ID 撤销令牌 */
  revokeToken: (cfg: AdminConfig, tokenId: string) =>
    api<{ revoked: boolean }>(cfg, `/auth/tokens/${tokenId}`, { method: "DELETE" }),
  privacyRules: (cfg: AdminConfig) => api<{ patterns: string[]; revision: number }>(cfg, "/privacy/rules"),
  // ---------- D61 资料库 ----------
  materials: (
    cfg: AdminConfig,
    q: { type?: string; q?: string; category?: string; uncategorized?: boolean; limit?: number; offset?: number } = {},
  ) => {
    const p = new URLSearchParams();
    if (q.type) p.set("type", q.type);
    if (q.q) p.set("q", q.q);
    if (q.category) p.set("category", q.category);
    if (q.uncategorized) p.set("uncategorized", "1");
    if (q.limit !== undefined) p.set("limit", String(q.limit));
    if (q.offset !== undefined) p.set("offset", String(q.offset));
    return api<{ items: MaterialRow[]; counts: MaterialCounts }>(cfg, `/materials?${p}`, {
      headers: privateHeaders(),
    });
  },
  materialFacets: (cfg: AdminConfig) =>
    api<MaterialFacets>(cfg, "/materials/facets", { headers: privateHeaders() }),
  materialDetail: (cfg: AdminConfig, id: string) =>
    api<MaterialDetail>(cfg, `/materials/${id}`, { headers: privateHeaders() }),
  materialCover: (cfg: AdminConfig, id: string) => apiDownload(cfg, `/materials/${id}/cover`),
  materialExport: (cfg: AdminConfig, id: string) => apiDownload(cfg, `/materials/${id}/export`),
  materialDismiss: (cfg: AdminConfig, id: string) =>
    api<{ ok: boolean }>(cfg, `/materials/${id}`, { method: "DELETE" }),
};
