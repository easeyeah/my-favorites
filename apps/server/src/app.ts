/**
 * 全部路由（技术方案 §5）。buildApp 注入依赖便于测试（app.request 直调）。
 * M2/M3：鉴权、同步、维护周报、语义搜索、BYOK 配置、导航模板/密码、配额、私密书签、迁移回灌。
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  ingestRequest,
  captureRequest,
  canonicalizeUrl,
  classifyByRules,
  isPrivacyDomain,
  parseNetscapeBookmarks,
  exportNetscapeHtml,
  INBOX_FOLDER_TITLE,
} from "@mf/shared";
import type { LlmClient } from "@mf/ai/llm-client";
import { newId, now } from "./db";
import { SERVER_VERSION } from "./version";
import { Store, type BookmarkRow } from "./store";
import { Pipeline } from "./pipeline";
import { OrganizeService } from "./organize";
import { enqueueBrowserReorder, enqueueMirrorMoves } from "./organize";
import { applySyncMutations } from "./sync-apply";
import { ChangeHub } from "./events";
import { analyzeSiteProjection, type SiteProjection } from "./site-analysis";
import { dispatchWebhooks, deliverHook } from "./hooks";
import {
  navData,
  renderNavHtml,
  renderPasswordPage,
  NAV_TEMPLATES,
  type NavTemplate,
  type NavData,
} from "./nav";
import { login, authEnabled } from "./auth";
import { Registry, type AdminUserRow, type UserRole, type UserRow } from "./registry";
import { UserDbManager, currentUserId, runAsUser, SELF_USER_ID } from "./tenancy";
import {
  mountSecurity,
  mountTokenAuth,
  adminSetup,
  loginWithDbHash,
  isProductionLike,
  setupRequired,
} from "./security";
import type { MaintenanceService } from "./maintenance";
import type { SemanticService } from "./semantic";
import { fetchGuardConfigFromEnv, guardedFetch, ipCoveredByAllowlist, type FetchGuardConfig } from "./fetch-guard";
import { resolveFavicon } from "./favicon";
import { buildMaterialMarkdown, removeCoverFile } from "./materials";
import { handleMcpRequest } from "./mcp";
import { buildSnapshotView } from "./snapshot-view";
import { buildUserExport } from "./user-export";
import {
  NAV_ACCESS_COOKIE,
  navAccessCookieHeader,
  navClearCookieHeader,
  signNavAccess,
  verifyNavAccess,
} from "./nav-auth";
import { loginRateLimited, recordLoginFailure, clearLoginFailures } from "./security";

export type LlmFor = (purpose: "organize" | "summarize" | "embedding") => LlmClient | null;

export interface AppDeps {
  store: Store;
  llmFor: LlmFor;
  dataDir: string;
  pipeline: Pipeline;
  organize: OrganizeService;
  semantic: SemanticService;
  maintenance: MaintenanceService;
  adminPassword?: string;
  /** D68 统一部署：registry（主库注册表）/ userDbs（用户库池）——所有部署形态同一套
   *  用户名登录 + 多用户隔离，不再有 self/cloud 分叉（缺省自建实例，既有测试零改动） */
  registry?: Registry;
  userDbs?: UserDbManager;
  /** 网络守卫配置（favicon 等出站抓取用）；缺省按环境变量推断，测试可注入回环放行 */
  guardConfig?: FetchGuardConfig;
}

// 密码哈希已提取至 ./password.ts（DEV-23 消除循环依赖）；此处重导出保持既有 import 兼容
export { hashPassword, verifyPasswordHash } from "./password";
import { hashPassword, verifyPasswordHash } from "./password";

export function buildApp(deps: AppDeps): Hono {
  const { store, llmFor, pipeline, organize, dataDir, semantic, maintenance, adminPassword } = deps;
  // D68 统一部署：登录=用户名+密码（注册开放，MF_REGISTER_OPEN 可关）；
  // 多用户隔离=每用户独立 SQLite 文件（owner 'self' 恒主库）；DEPLOY_MODE 分叉退役。
  const registry = deps.registry ?? new Registry(store.db);
  const userDbs = deps.userDbs ?? new UserDbManager(dataDir, store.db);
  // 旧单管理员部署自动 provisioning owner 用户名账号（admin/旧密码）——统一表单可登录既有数据
  registry.ensureOwnerAccount(adminPassword);
  const guardConfig = deps.guardConfig ?? fetchGuardConfigFromEnv();
  const esc = (v: string): string =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const safeUser = (user: UserRow): AdminUserRow => ({
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    disabled_at: user.disabled_at,
    created_at: user.created_at,
  });
  const adminRequired = (c: Context): Response | null =>
    registry.isAdmin(currentUserId()) ? null : c.json({ error: "admin_required" }, 403);

  // D50：变更广播（Store 钩子 → SSE 订阅者）
  const hub = new ChangeHub();
  store.onRecorded = (ch) => hub.publish(ch);

  const api = new Hono().basePath("/api/v1");
  // A1-3 日志脱敏：hono 默认 logger 会输出完整 path+query（含 /by-url?url= 的完整隐私 URL）。
  // 自定义 logger：只输出方法、路径模板（去 query）、状态、耗时。
  api.use(async (c, next) => {
    const start = Date.now();
    await next();
    const pathOnly = c.req.path.split("?")[0];
    console.log(
      `${c.req.method} ${pathOnly} → ${c.res?.status ?? "?"} ${Date.now() - start}ms`,
    );
  });
  // DEV-05 来源白名单：CORS 不代替认证，只决定是否下发跨域头。
  // 允许：显式配置（MF_ALLOWED_ORIGINS 逗号分隔，含扩展 chrome-extension:// origin）；
  // 非生产语义下放行 localhost 与浏览器扩展开发源。未认可来源不下发 CORS 头（浏览器拒绝跨域），
  // 非浏览器请求仍走认证中间件。
  const allowedOrigins = new Set(
    (process.env.MF_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // CORS 不代替认证，只决定是否下发跨域头。API 与根路由（/auth/login、/healthz）共用同一策略，
  // 否则分离部署的 Web 管理台无法跨源登录（根路由此前无 CORS，预检必败）。
  const sharedCors = cors({
    origin: (origin) => {
      if (!origin) return null;
      if (allowedOrigins.has(origin)) return origin;
      if (!isProductionLike()) {
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
        if (origin.startsWith("chrome-extension://")) return origin;
        if (origin.startsWith("moz-extension://")) return origin;
      }
      return null;
    },
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-MF-Private",
      "X-MF-Device",
    ],
  });
  api.use("*", sharedCors);

  // ---------- 鉴权（F6.2 + A4-1 + DEV-05 + D68 统一） ----------
  // 注册/用户名登录对一切部署形态开放（root 级公开路由）；令牌即请求上下文。
  // setup 门槛仅在「生产语义 + 无管理员 + 无任何注册用户」时拦截（首部署可 setup 或 register 二选一）。
  mountSecurity(api, registry, adminPassword);
  if (!authEnabled(adminPassword)) {
    // 首启 setup（legacy 兼容通道；仅一次）。DEV-05：生产语义要求部署引导凭据，
    // 禁止暴露端口后任何人抢先设管理员（凭据来源：MF_SETUP_TOKEN env 或 dataDir 引导文件）
    api.post("/admin/setup", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { password?: string };
      if (!body.password) return c.json({ error: "password_required" }, 400);
      const bootstrap = c.req.header("x-mf-setup-token") ?? "";
      const result = await adminSetup(registry, body.password, bootstrap, dataDir);
      if ("error" in result) return c.json({ error: result.error }, result.error === "setup_token_required" || result.error === "setup_token_invalid" ? 403 : 400);
      store.audit("setup.done", "管理员密码初始化完成（引导凭据已失效）", clientKeyOf(c));
      return c.json(result);
    });
  }

  const privateVisible = (c: { req: { header: (n: string) => string | undefined } }): boolean =>
    c.req.header("x-mf-private") === "1";

  // DEV-05 客户端标识：仅在显式信任代理（MF_TRUST_PROXY=1，自建反代白名单）时
  // 采信 X-Forwarded-For；否则用 TCP 对端地址——伪造代理头不能绕过限速。
  // D58：同时作为审计日志 source（登录失败/限速/配置变更的来源追溯）。
  const clientKeyOf = (c: { req: { header: (n: string) => string | undefined }; env: unknown }): string => {
    if (process.env.MF_TRUST_PROXY === "1") {
      const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (fwd) return fwd;
    }
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming;
    return incoming?.socket?.remoteAddress ?? "local";
  };

  const listVisibleBookmarks = (
    c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } },
  ): BookmarkRow[] => {
    const rows = store.listBookmarks({
      folderId: c.req.query("folderId"),
      status: c.req.query("status"),
      // 原型 11：站点类型 / 有快照筛选（切片 B 分析标注后可用）
      siteType: c.req.query("siteType") || undefined,
      hasSnapshot: c.req.query("hasSnapshot") === "1",
      limit: c.req.query("limit") ? Math.min(Number(c.req.query("limit")), 1000) : undefined,
      offset: c.req.query("offset") ? Math.max(Number(c.req.query("offset")), 0) : undefined,
    });
    return privateVisible(c) ? rows : rows.filter((b) => !b.is_private);
  };

  // ---------- F1.1 导入（幂等 + 去重 + 目录树映射） ----------
  api.post("/bookmarks/ingest", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ingestRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", detail: parsed.error.issues }, 400);
    }
    const key = c.req.header("Idempotency-Key") ?? parsed.data.idempotencyKey;
    const cached = store.getIdempotent(key);
    if (cached) {
      return c.json({ ...(cached as object), idempotent_replay: true });
    }
    let imported = 0;
    let skippedDuplicate = 0;
    let skippedInvalid = 0;
    const batchSeen = new Set<string>();
    // D44：导入即建浏览器身份映射（deviceId + browserId → 应用库书签），
    // 之后管理台删除才能精确镜像 remove 浏览器节点（无映射则不动浏览器）
    const deviceId = parsed.data.deviceId;
    if (deviceId) store.ensureDevice(deviceId);
    for (const item of parsed.data.items) {
      const canon = canonicalizeUrl(item.url);
      if (!canon) {
        skippedInvalid++;
        continue;
      }
      const existing = store.findByCanonical(canon.canonical);
      if (batchSeen.has(canon.canonical) || existing) {
        // 重复 URL 也回填身份（同浏览器节点重复导入幂等；跨设备同 URL 指向同一条应用库书签）
        if (deviceId && item.browserId && existing) {
          store.upsertIdentity({ deviceId, browserBookmarkId: item.browserId, appBookmarkId: existing.id });
        }
        skippedDuplicate++;
        continue;
      }
      batchSeen.add(canon.canonical);
      // 导入不进收件箱（AGENTS.md 红线 5）：直接落映射目录
      const folder = store.ensurePath(item.folderPath);
      const bm = store.createBookmark({
        folderId: folder.id,
        urlRaw: item.url,
        urlCanonical: canon.canonical,
        urlKeyVersion: canon.rulesVersion,
        title: item.title,
        addedAt: item.addedAt,
      });
      if (deviceId && item.browserId) {
        store.upsertIdentity({ deviceId, browserBookmarkId: item.browserId, appBookmarkId: bm.id });
      }
      imported++;
    }
    const result = {
      imported,
      skipped_duplicate: skippedDuplicate,
      skipped_invalid: skippedInvalid,
      total: parsed.data.items.length,
    };
    store.saveIdempotent(key, result);
    return c.json(result);
  });

  api.post("/bookmarks/ingest/html", async (c) => {
    const html = await c.req.text();
    if (!html.includes("<A ")) {
      return c.json({ error: "invalid_netscape_html" }, 400);
    }
    const items = parseNetscapeBookmarks(html);
    const key = c.req.header("Idempotency-Key") ?? newId();
    const cached = store.getIdempotent(key);
    if (cached) {
      return c.json({ ...(cached as object), idempotent_replay: true });
    }
    let imported = 0;
    let skippedDuplicate = 0;
    for (const item of items) {
      const canon = canonicalizeUrl(item.url);
      if (!canon || store.findByCanonical(canon.canonical)) {
        skippedDuplicate++;
        continue;
      }
      const folder = store.ensurePath(item.folderPath);
      store.createBookmark({
        folderId: folder.id,
        urlRaw: item.url,
        urlCanonical: canon.canonical,
        urlKeyVersion: canon.rulesVersion,
        title: item.title,
        addedAt: item.addedAt,
      });
      imported++;
    }
    const result = { imported, skipped_duplicate: skippedDuplicate, total: items.length };
    store.saveIdempotent(key, result);
    return c.json(result);
  });

  // ---------- F1.6 导出 / M3 迁移回灌（F6.2 迁移工具） ----------
  api.get("/export/json", (c) => {
    const folders = store.listFolders();
    const bookmarks = listVisibleBookmarks(c);
    return c.json({
      exported_at: new Date().toISOString(),
      folders,
      bookmarks,
      caches: bookmarks.map((b) => store.getCache(b.id)).filter(Boolean),
    });
  });

  // D73：显式「导出我的全部数据」与旧隐私过滤导出分开；包含私密/软归档内容，但绝不含凭据。
  api.get("/export/user", (c) => {
    const user = registry.findUserById(currentUserId());
    const payload = buildUserExport(store.db, user ? safeUser(user) : null);
    const name = user?.username ?? "owner";
    c.header("content-disposition", `attachment; filename="my-favorites-${name}-export.json"`);
    store.audit("data.exported", "导出当前账号全部数据", clientKeyOf(c));
    return c.json(payload);
  });

  api.post("/import/json", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      folders?: Array<{ id: string; parent_id: string | null; name: string; source?: string; is_system_inbox?: number }>;
      bookmarks?: Array<Record<string, unknown>>;
    } | null;
    if (!body?.bookmarks || !Array.isArray(body.bookmarks)) {
      return c.json({ error: "invalid_export_format" }, 400);
    }
    let restored = 0;
    let skipped = 0;
    for (const f of body.folders ?? []) {
      const exists = store.getFolder(String(f.id));
      if (!exists) {
        store.db
          .prepare(
            "INSERT OR IGNORE INTO folders (id, parent_id, name, sort, source, is_system_inbox, created_at) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            String(f.id),
            f.parent_id ?? null,
            String(f.name),
            Date.now() % 1e9,
            f.source ?? "imported",
            f.is_system_inbox ?? 0,
            now(),
          );
      }
    }
    for (const b of body.bookmarks) {
      const id = String(b.id);
      if (store.getBookmark(id)) {
        skipped++;
        continue;
      }
      try {
        store.db
          .prepare(
            "INSERT INTO bookmarks (id, folder_id, url_raw, url_canonical, title, description, status, favicon_url, cover_url, added_at, last_checked_at, pinned, is_private, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            String(b.folder_id),
            String(b.url_raw),
            String(b.url_canonical),
            String(b.title),
            (b.description as string | null) ?? null,
            (b.status as string) ?? "normal",
            (b.favicon_url as string | null) ?? null,
            (b.cover_url as string | null) ?? null,
            String(b.added_at),
            (b.last_checked_at as string | null) ?? null,
            Number(b.pinned ?? 0),
            Number(b.is_private ?? 0),
            String(b.created_at ?? now()),
          );
        restored++;
      } catch {
        skipped++;
      }
    }
    return c.json({ restored, skipped });
  });

  api.get("/export/html", (c) => {
    const folders = store.listFolders();
    const folderName = (id: string) => folders.find((f) => f.id === id)?.name ?? "未整理";
    const items = store
      .listBookmarks({ limit: 10000 })
      .map((b) => ({
        url: b.url_raw,
        title: b.title,
        folderPath: [folderName(b.folder_id)],
        addedAt: b.added_at,
      }));
    c.header("content-type", "text/html; charset=utf-8");
    c.header("content-disposition", "attachment; filename=bookmarks.html");
    return c.body(exportNetscapeHtml(items));
  });

  // ---------- F1.3 目录与书签 CRUD ----------
  api.get("/folders", (c) => c.json(store.listFolders()));

  // 目录树 + 计数聚合（服务端 GROUP BY，客户端不拉全量数数）
  api.get("/folders/tree", (c) =>
    c.json(store.folderTree(!privateVisible(c))),
  );

  // 按 URL 精确查重（索引命中 O(1)，替代拉列表遍历）
  api.get("/bookmarks/by-url", (c) => {
    const raw = c.req.query("url");
    if (!raw) return c.json({ error: "url_required" }, 400);
    const canon = canonicalizeUrl(raw);
    if (!canon) return c.json({ error: "invalid_url" }, 400);
    const bm = store.findByCanonical(canon.canonical);
    if (!bm) return c.json({ found: false });
    if (bm.is_private && !privateVisible(c)) return c.json({ found: false });
    return c.json({ found: true, bookmark: bm });
  });
  api.post("/folders", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      parentId?: string;
      isSystemInbox?: boolean;
    };
    if (!body.name) return c.json({ error: "name_required" }, 400);
    const folder = store.createFolder(
      body.name,
      body.parentId ?? null,
      "user",
      body.isSystemInbox === true,
    );
    return c.json(folder, 201);
  });

  // 目录重命名 / 搬家（D81 §3-A：parentId 触发 reparent，校验父存在+禁止成环；收纳盒等系统目录拒绝）
  api.patch("/folders/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; parentId?: string | null };
    const id = c.req.param("id");
    let folder = store.getFolder(id);
    if (!folder) return c.json({ error: "not_found_or_system" }, 400);
    if (body.parentId !== undefined) {
      const moved = store.moveFolder(id, body.parentId || null);
      if (!moved) return c.json({ error: "invalid_move", hint: "目标父目录不存在、成环或系统目录" }, 400);
      folder = moved;
    }
    const name = body.name?.trim();
    if (name) {
      const renamed = store.renameFolder(id, name);
      if (!renamed) return c.json({ error: "not_found_or_system" }, 400);
      folder = renamed;
    }
    if (body.parentId === undefined && !name) return c.json({ error: "name_or_parentId_required" }, 400);
    return c.json(folder);
  });

  // 删除目录：仅允许空目录（无子目录且无书签）——数据安全兜底
  api.delete("/folders/:id", async (c) => {
    const id = c.req.param("id");
    const folder = store.getFolder(id);
    if (!folder) return c.json({ error: "not_found" }, 404);
    if (folder.is_system_inbox === 1) return c.json({ error: "system_folder" }, 400);
    // D73：目录删除升级为树删（目录 + 全部子书签/子目录），完整同步到浏览器——
    // 此前仅支持空目录（非空 400 不产生变更），用户删了目录浏览器永远残留。
    // 镜像链：子书签 deleteBookmark 逐条 remove 镜像；目录删除事件带目录名，
    // 同步引擎按名移除浏览器对应目录壳（空）；sync-apply 回执cancelled 同旧口径。
    const acc = store.deleteFolderTree(id);
    return c.json({ ok: true, folders: acc.folders, bookmarks: acc.bookmarks });
  });

  api.get("/bookmarks", (c) => c.json(listVisibleBookmarks(c)));

  // 注意：必须先于 /bookmarks/:id 注册，否则 "top" 会被当作 id 匹配（404）
  api.get("/bookmarks/top", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 8), 24);
    return c.json({ items: store.topClickedBookmarks(limit) });
  });

  api.get("/bookmarks/:id", (c) => {
    const bm = store.getBookmark(c.req.param("id"));
    if (!bm) return c.json({ error: "not_found" }, 404);
    if (bm.is_private && !privateVisible(c)) {
      return c.json({ error: "private_bookmark" }, 403);
    }
    return c.json({ ...bm, cache: store.getCache(bm.id) ?? null });
  });

  api.post("/bookmarks", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: string;
      title?: string;
      folderId?: string;
      folderPath?: string[];
      /** 原型 02 popup「为什么收藏它？」备注 */
      description?: string;
    };
    if (!body.url) return c.json({ error: "url_required" }, 400);
    const canon = canonicalizeUrl(body.url);
    if (!canon) return c.json({ error: "invalid_url" }, 400);
    const existing = store.findByCanonical(canon.canonical);
    if (existing) {
      return c.json({ ...existing, duplicate: true }, 200);
    }
    const suggest = pipeline.suggest(body.url, body.title ?? body.url);
    const folderIdForced =
      body.folderId && store.getFolder(body.folderId) ? body.folderId : undefined;
    const folderId =
      folderIdForced ??
      suggest.folderId ??
      (suggest.folderPath.length > 0 ? store.ensurePath(suggest.folderPath).id : undefined) ??
      store.inboxFolder()?.id ??
      store.ensurePath(["未整理"]).id;
    const bm = store.createBookmark({
      folderId,
      urlRaw: body.url,
      urlCanonical: canon.canonical,
        urlKeyVersion: canon.rulesVersion,
      title: body.title ?? body.url,
      ...(body.description ? { description: body.description.slice(0, 500) } : {}),
    });
    // D33 出站 Hook（异步不阻塞；隐私命中永不外发）
    dispatchWebhooks(store, "bookmark.added", {
      bookmarkId: bm.id,
      url: body.url,
      title: bm.title,
      bookmark: { title: bm.title, folder: store.getFolder(folderId)?.name ?? null },
    });
    // D61 资料库：视频/图片凭 URL 形态即时入库（文章等捕获到全文后再显性化）
    if (pipeline.syncMode) await pipeline.materialize(bm.id);
    else void pipeline.materialize(bm.id);
    return c.json({ ...bm, suggest }, 201);
  });

  api.patch("/bookmarks/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      folderId?: string;
      status?: string;
      pinned?: boolean;
      isPrivate?: boolean;
      /** D52：编辑 URL = 换资源，重算查重键；正文缓存随之作废 */
      url?: string;
      /** D52：备注（为什么收藏它） */
      description?: string;
    };
    const id = c.req.param("id");
    const bm = store.getBookmark(id);
    if (!bm) return c.json({ error: "not_found" }, 404);
    const fields: Parameters<Store["updateBookmark"]>[1] = {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.folderId !== undefined ? { folder_id: body.folderId } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned ? 1 : 0 } : {}),
      ...(body.isPrivate !== undefined ? { is_private: body.isPrivate ? 1 : 0 } : {}),
      ...(body.description !== undefined ? { description: body.description.slice(0, 2000) } : {}),
    };
    // D77：手动改目录 = 用户意图神圣 → 清自动归位状态（分类自检永不再复核此条）
    if (body.folderId !== undefined && body.folderId !== bm.folder_id) store.clearInboxState(id);
    if (body.url !== undefined && body.url !== bm.url_raw) {
      const canon = canonicalizeUrl(body.url);
      if (!canon) return c.json({ error: "invalid_url" }, 400);
      const dup = store.findByCanonical(canon.canonical);
      if (dup && dup.id !== id) return c.json({ error: "duplicate_url", existing_id: dup.id }, 409);
      Object.assign(fields, {
        url_raw: body.url,
        url_canonical: canon.canonical,
        url_key_version: canon.rulesVersion,
      });
      store.clearCache(id); // 内容归属旧 URL，快照保留（历史资产）
    }
    store.updateBookmark(id, fields);
    const updated = store.getBookmark(c.req.param("id"));
    if (updated?.is_private) {
      // 私密书签不参与内容抓取/AI（隐私红线）
      store.upsertCache({
        bookmarkId: updated.id,
        fetchedVia: "extension_capture",
        failReason: "privacy_domain_skipped",
      });
    }
    return c.json(updated);
  });

  api.delete("/bookmarks/:id", (c) => {
    // 删除由用户显式发起（红线 3：AI 只出建议清单，不自动删除）
    const bm = store.getBookmark(c.req.param("id"));
    if (!bm) return c.json({ error: "not_found" }, 404);
    // D79：盒内待分类条目取消（浏览器删盒内节点）——仅当条目仍在盒内才允许删，
    // 防止与归位流水线竞态窗口误删已归位条目（归位后删除走普通双向同步）
    if (c.req.query("ifInbox") === "1") {
      const inbox = store.inboxFolder();
      if (!inbox || bm.folder_id !== inbox.id) return c.json({ error: "not_in_inbox" }, 409);
    }
    const deleted = store.deleteBookmark(c.req.param("id"));
    if (!deleted) return c.json({ error: "not_found" }, 404);
    return c.json({ deleted: deleted.id });
  });

  // ---------- F1.4 即时归位建议 ----------
  api.post("/bookmarks/suggest", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: string; title?: string };
    if (!body.url) return c.json({ error: "url_required" }, 400);
    return c.json(pipeline.suggest(body.url, body.title ?? ""));
  });

  // ---------- F1.5 收纳盒（自动收纳；D36 术语） ----------
  api.get("/inbox/count", (c) => {
    const inbox = store.inboxFolder();
    if (!inbox) return c.json({ count: 0 });
    const rows = store.listInboxWithState();
    return c.json({ count: rows.length, ambiguous: rows.filter((r) => r.state === "ambiguous").length });
  });

  // 收纳盒面板（原型 06）：箱内条目 + 状态机（pending/处理中、ambiguous 歧义滞留、
  // privacy_hold 隐私、retry 失败重试）+ 最近已归位（撤销入口带版本）
  api.get("/inbox/items", (c) => {
    const items = store.listInboxWithState();
    const placed = store.listInboxRecentPlaced(5);
    const domainRules = store.getDomainPlaceRules();
    const withSuggest = items.map((it) => {
      const parsed = canonicalizeUrl(it.url_canonical);
      const rule = parsed ? classifyByRules(parsed.registrableDomain, it.title) : null;
      return {
        ...it,
        suggestCategory: rule && rule.source !== "none" ? rule.category : null,
        domainRuleFolderId: domainRules[parsed?.registrableDomain ?? ""] ?? null,
      };
    });
    return c.json({ items: withSuggest, placed, ambiguousCount: items.filter((i) => i.state === "ambiguous").length });
  });

  // 手动选目录 / 改目录（D37：隐私条目「按域名记忆」本地规则可自动归位，不走 AI）
  api.post("/inbox/assign", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      bookmarkId?: string; folderId?: string; deviceId?: string; rememberDomain?: boolean;
    };
    if (!body.bookmarkId || !body.folderId) return c.json({ error: "bookmarkId_folderId_required" }, 400);
    const bm = store.getBookmark(body.bookmarkId);
    const folder = store.getFolder(body.folderId);
    if (!bm || !folder) return c.json({ error: "not_found" }, 404);
    store.moveBookmark(bm.id, folder.id);
    store.clearInboxState(bm.id);
    if (body.deviceId) enqueueMirrorMoves(store, bm.id, folder.id, body.deviceId);
    if (body.rememberDomain) {
      const parsed = canonicalizeUrl(bm.url_canonical);
      if (parsed) store.setDomainPlaceRule(parsed.registrableDomain, folder.id);
    }
    return c.json({ ok: true, folderName: folder.name });
  });

  // 立即重试：清除重试计数 → 重新走流水线（复用 /inbox/process 单条路径）
  api.post("/inbox/retry", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { bookmarkId?: string; deviceId?: string };
    if (!body.bookmarkId) return c.json({ error: "bookmarkId_required" }, 400);
    const bm = store.getBookmark(body.bookmarkId);
    if (!bm) return c.json({ error: "not_found" }, 404);
    store.upsertInboxState(bm.id, "pending", null, null, 0);
    const inbox = store.inboxFolder();
    if (!inbox || bm.folder_id !== inbox.id) return c.json({ error: "not_in_inbox" }, 400);
    const deviceId = body.deviceId ?? (c.req.header("x-mf-device") ?? undefined);
    const result = await pipeline.processInbox([bm.id], inbox.id, { deviceId });
    return c.json(result);
  });

  api.post("/inbox/setup", (c) => {
    const existing = store.inboxFolder();
    if (existing) {
      // D36 术语校准：旧库名「📥 自动整理」幂等改为「📥 收纳盒」
      if (existing.name !== INBOX_FOLDER_TITLE) {
        return c.json(store.renameSystemFolder(existing.id, INBOX_FOLDER_TITLE));
      }
      return c.json(existing);
    }
    const folder = store.createFolder(INBOX_FOLDER_TITLE, null, "user", true);
    return c.json(folder, 201);
  });

  // ---------- A2-1/A2-2：设备注册 + 浏览器书签身份映射 ----------
  api.post("/devices/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { deviceId?: string; label?: string };
    if (!body.deviceId || body.deviceId.length < 8) {
      return c.json({ error: "deviceId_required" }, 400);
    }
    store.ensureDevice(body.deviceId, body.label);
    return c.json({ ok: true });
  });

  /**
   * A2-2 收件箱映射入库：浏览器事件携带 (deviceId, browserBookmarkId, url, title)。
   * 服务端按 canonical URL 幂等找/建应用库书签（收件箱目录），建立身份映射，
   * 返回应用库书签 ID。重复事件 → 同一 ID（幂等，不重复建书签/任务）。
   */
  api.post("/inbox/map", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      deviceId?: string;
      browserBookmarkId?: string;
      url?: string;
      title?: string;
    };
    if (!body.deviceId || !body.browserBookmarkId || !body.url) {
      return c.json({ error: "deviceId_browserBookmarkId_url_required" }, 400);
    }
    store.ensureDevice(body.deviceId);
    const canon = canonicalizeUrl(body.url);
    if (!canon) return c.json({ error: "invalid_url" }, 400);

    const inbox = store.inboxFolder() ?? store.createFolder(INBOX_FOLDER_TITLE, null, "user", true);

    // 三路径合一（已有映射 / canonical 查重绑定 / 新建）——D72：镜像补投对一切路径生效
    const existingAppId = store.findAppBookmarkId(body.deviceId, body.browserBookmarkId);
    const byCanonical = canon.canonical ? store.findByCanonical(canon.canonical) ?? null : null;
    const bm =
      (existingAppId ? store.getBookmark(existingAppId) : undefined) ??
      byCanonical ??
      store.createBookmark({
        folderId: inbox.id,
        urlRaw: body.url,
        urlCanonical: canon.canonical,
        urlKeyVersion: canon.rulesVersion,
        title: body.title ?? body.url,
      });
    store.upsertIdentity({
      deviceId: body.deviceId,
      browserBookmarkId: body.browserBookmarkId,
      appBookmarkId: bm.id,
    });
    // D78：已归位条目被再次丢入投递口 = 用户「重新分类」意图 → 库条目移回收纳盒重走流水线。
    // 旧实现（D72）反向补「移出」镜像，把用户刚丢入的节点弹回原目录——投递口不收已归位条目，
    // 浏览器与管理台再次分叉。D72 滞留场景（镜像让位致节点 stuck 在盒内）由同步引擎
    // 身份收敛（②'）负责移出，不靠此处弹回。
    if (bm.folder_id !== inbox.id) {
      store.moveBookmark(bm.id, inbox.id);
      store.upsertInboxState(bm.id, "pending", null, null, 0);
    }
    return c.json({ bookmarkId: bm.id, mapped: true, duplicate: byCanonical !== undefined });
  });

  /**
   * A2-3/A2-4 待执行操作（浏览器镜像 D20）：
   * 扩展拉取 pending 操作 → 执行浏览器节点移动 → 回执。
   * 幂等：enqueue 已去重；回执后不再下发；失败递增 attempts 保留待重试。
   */
  api.get("/browser/ops", (c) => {
    const deviceId = c.req.query("deviceId");
    if (!deviceId) return c.json({ error: "deviceId_required" }, 400);
    return c.json({ ops: store.pendingBrowserOps(deviceId) });
  });

  api.post("/browser/ops/:id/result", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      status?: "done" | "failed" | "cancelled";
      error?: string;
    };
    const id = Number(c.req.param("id"));
    if (!body.status || !["done", "failed", "cancelled"].includes(body.status)) {
      return c.json({ error: "status_required" }, 400);
    }
    if (!store.completeBrowserOp(id, body.status, body.error)) {
      return c.json({ error: "op_not_found_or_not_pending" }, 404);
    }
    return c.json({ ok: true });
  });

  /** D45 浏览器书签重排：按管理台列表口径为含映射书签的目录生成顺序快照入队（可限定设备） */
  api.post("/browser/reorder", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { deviceId?: string };
    return c.json(enqueueBrowserReorder(store, body.deviceId));
  });

  // ---------- A1-1 隐私规则下发（扩展端同步本地） ----------
  api.get("/privacy/rules", (c) => c.json(store.privacyRules()));

  api.post("/privacy/rules", async (c) => {
    // 用户自定义隐私规则（追加/删除自定义项；内置项不可删）
    const body = (await c.req.json().catch(() => ({}))) as {
      add?: string[];
      remove?: string[];
      /** 规则变化后是否清理存量内容（默认清理；界面需先展示清理范围） */
      purgeExisting?: boolean;
    };
    for (const p of body.add ?? []) {
      if (typeof p === "string" && p.length > 0 && p.length <= 253) store.addPrivacyPattern(p.trim().toLowerCase());
    }
    for (const p of body.remove ?? []) {
      if (typeof p === "string") store.removePrivacyPattern(p.trim().toLowerCase());
    }
    // A1-5：规则变化后清理存量（正文/摘要/关键词/向量/快照）；
    // 已发送给第三方的数据无法追回（界面需说明）
    let purged: { bookmarks: number; snapshots: number } | null = null;
    if (body.purgeExisting !== false) {
      purged = store.purgeContentForPrivacyRules((url) =>
        isPrivacyDomain(url, { patterns: store.privacyPatterns() }),
      );
    }
    return c.json({ ...store.privacyRules(), purged });
  });

  api.post("/inbox/process", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      bookmarkIds?: string[];
      /** A2-4 镜像模式：触发设备（用于把移动镜像回浏览器书签） */
      deviceId?: string;
    };
    const inbox = store.inboxFolder();
    if (!inbox) return c.json({ error: "inbox_not_setup" }, 400);
    const ids = body.bookmarkIds ?? [];
    if (ids.length === 0) {
      for (const bm of store.listBookmarks({ folderId: inbox.id, limit: 100 })) {
        ids.push(bm.id);
      }
    }
    // DEV-08：镜像操作在流水线提交事务内入队（崩溃无「已提交但无镜像」空窗），
    // 不再事务外补排。
    const result = await pipeline.processInbox(ids, inbox.id, { deviceId: body.deviceId });
    return c.json(result);
  });

  // ---------- F2.1 内容捕获上行 ----------
  api.post("/content/capture", async (c) => {
    const parsed = captureRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", detail: parsed.error.issues }, 400);
    }
    const bm = store.getBookmark(parsed.data.bookmarkId);
    if (!bm) return c.json({ error: "not_found" }, 404);
    const result = await pipeline.capture({
      bookmarkId: bm.id,
      l2Text: parsed.data.l2Text,
      description: parsed.data.description,
      faviconDataUrl: parsed.data.faviconDataUrl,
      ogImage: parsed.data.ogImage,
      urlForPrivacyCheck: bm.url_canonical,
    });
    void semantic.embedBookmark(bm.id); // 语义索引（fire-and-forget）
    return c.json(result);
  });

  // DEV-02：内容读取先从书签对象授权（存在性 + 私密可见性），再读缓存；
  // 不存在与不允许读取返回同一 404（避免泄露"对象存在"这一元数据）
  api.get("/content/:bookmarkId", (c) => {
    const bm = store.getBookmark(c.req.param("bookmarkId"));
    if (!bm || bm.archived_into) return c.json({ error: "not_found" }, 404);
    if (bm.is_private && !privateVisible(c)) return c.json({ error: "not_found" }, 404);
    const cache = store.getCache(c.req.param("bookmarkId"));
    if (!cache) return c.json({ error: "not_found" }, 404);
    return c.json(cache);
  });

  // ---------- 站点原始图标（favicon）回填 ----------
  // 前端 SiteIcon 对缺图书签异步调用；成功后以 data URL 持久化到 bookmarks.favicon_url，
  // 与扩展快照捕获通道同字段同语义——一次获取，列表/导航站/新标签页全部复用
  api.get("/favicon", async (c) => {
    const url = c.req.query("url") ?? "";
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return c.json({ error: "invalid_url" }, 400);
    }
    const bm = store.findByCanonical(parsed.toString()) ?? store.findByCanonical(url);
    if (bm?.favicon_url) return c.json({ favicon_url: bm.favicon_url });
    // 红线②：隐私域名/私密书签不向站点发起取图请求（探测即泄露"该域名在册"）。
    // 与死链探测同规则的唯一例外：部署显式 allowlist 且目标为字面内网 IP（NAS 自有服务需要图标）
    const decision = pipeline.serverDecide("server_fetch", url, {
      isPrivateBookmark: bm?.is_private === 1,
    });
    if (!decision.allowed && !ipCoveredByAllowlist(parsed.hostname.replace(/^\[|\]$/g, ""), guardConfig)) {
      return c.json({ favicon_url: null, reason: `privacy_${decision.reason}` });
    }
    const icon = await resolveFavicon(url, guardConfig);
    if (icon && bm) store.updateBookmark(bm.id, { favicon_url: icon });
    return c.json({ favicon_url: icon });
  });

  // ---------- F2.2 服务端补漏抓取 ----------
  api.post("/crawl/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
    const targets = body.ids?.length
      ? body.ids.map((id) => store.getBookmark(id)).filter((b) => b !== undefined)
      : store.bookmarksMissingContent(10);
    const results: Array<{ id: string; ok: boolean; reason?: string }> = [];
    for (const bm of targets) {
      if (!bm) continue;
      // D70：补抓实现收敛到 pipeline.crawlOne（与收纳盒资料扫描共用；隐私/守卫内聚）
      const r = await pipeline.crawlOne(bm.id);
      if (r.ok) void semantic.embedBookmark(bm.id);
      results.push({ id: bm.id, ok: r.ok, reason: r.reason });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return c.json({ processed: results.length, results });
  });

  // ---------- D61 资料库（收藏内容三级识别的实体面：文章已存全文显性化/视频元数据/图片主图） ----------
  api.get("/materials", (c) => {
    return c.json({
      items: store.listMaterials({
        type: c.req.query("type") || undefined,
        q: c.req.query("q") || undefined,
        tag: c.req.query("tag") || undefined,
        category: c.req.query("category") || undefined,
        uncategorized: c.req.query("uncategorized") === "1",
        limit: c.req.query("limit") ? Math.min(Number(c.req.query("limit")), 200) : undefined,
        offset: c.req.query("offset") ? Math.max(Number(c.req.query("offset")), 0) : undefined,
        includePrivate: privateVisible(c),
      }),
      counts: store.countMaterials(),
    });
  });

  // 分面统计（左侧双维度面板：分类树计数 + AI 标签频次榜）——先于 /materials/:id 注册避免被截胡
  api.get("/materials/facets", (c) => c.json(store.materialFacets(privateVisible(c))));

  // D89 目录资料扫描（SSE 逐条进度；断开即停）：内容页书签抓正文入资料库，
  // 抓取失败条目随 done 事件返回「建议丢弃」清单（只建议——归档/删除由用户确认，红线③）
  api.get("/materials/scan/stream", (c) => {
    const folderId = c.req.query("folderId");
    if (!folderId) return c.json({ error: "folderId_required" }, 400);
    const includeSubfolders = c.req.query("includeSubfolders") !== "0";
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 30) || 30, 1), 60);
    const uid = currentUserId();
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "start", data: JSON.stringify({ limit }) });
      try {
        const result = await runAsUser(uid, () =>
          pipeline.scanFolderForMaterials(folderId, {
            includeSubfolders,
            limit,
            onItem: (item, done, total) => {
              if (stream.aborted) return false; // 客户端断开 → 停止后续抓取
              void stream.writeSSE({ event: "item", data: JSON.stringify({ ...item, done, total }) });
              return true;
            },
          }),
        );
        await stream.writeSSE({ event: "done", data: JSON.stringify(result) });
      } catch (err) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: String(err).slice(0, 200) }) });
      }
    });
  });

  api.get("/materials/:id", (c) => {
    const m = store.getMaterial(c.req.param("id"));
    if (!m) return c.json({ error: "not_found" }, 404);
    if (m.is_private === 1 && !privateVisible(c)) return c.json({ error: "not_found" }, 404);
    return c.json(m);
  });

  // 封面文件（魔数嗅探后落盘的本地图）：nosniff + private 缓存；路径纵深校验防 traversal
  api.get("/materials/:id/cover", (c) => {
    const ref = store.getMaterialCoverPath(c.req.param("id"));
    if (!ref) return c.json({ error: "not_found" }, 404);
    const base = path.resolve(dataDir, "materials");
    const abs = path.resolve(dataDir, ref.relPath);
    if (!abs.startsWith(base + path.sep) || !existsSync(abs)) {
      return c.json({ error: "not_found" }, 404);
    }
    const buf = readFileSync(abs);
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": ref.mime,
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
      },
    });
  });

  // Markdown 导出（D61 首发：零 API 依赖的通用笔记应用出口）
  api.get("/materials/:id/export", (c) => {
    const m = store.getMaterial(c.req.param("id"));
    if (!m) return c.json({ error: "not_found" }, 404);
    if (m.is_private === 1 && !privateVisible(c)) return c.json({ error: "not_found" }, 404);
    const md = buildMaterialMarkdown(m);
    const rawTitle = String(m.title ?? "material").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 60) || "material";
    return new Response(md, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="material-${m.id}.md"; filename*=UTF-8''${encodeURIComponent(`${rawTitle}.md`)}`,
        "x-content-type-options": "nosniff",
      },
    });
  });

  // 移出资料库：软删（书签本体不动；防 capture/crawl 复活），封面文件即时清理
  api.delete("/materials/:id", (c) => {
    const id = c.req.param("id");
    const ref = store.getMaterialCoverPath(id);
    const ok = store.dismissMaterial(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    if (ref) removeCoverFile(dataDir, ref.relPath);
    return c.json({ ok: true });
  });

  // ---------- D64 MCP 端点：资料库的 AI 一等消费面（鉴权随 /api/v1 中间件） ----------
  api.post("/mcp", (c) => handleMcpRequest(store, c));

  // ---------- F3 整理（D27 act + undo：一次调用直接生效，安全网 = 版本撤销） ----------
  api.post("/organize/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };
    if (!body.message) return c.json({ error: "message_required" }, 400);
    try {
      const result = await organize.handleMessage(body.message);
      // F3.8 偏好记忆：只统计实际生效（applied 的 move）；冲突/跳过不计入偏好
      for (const a of result.appliedActions ?? []) {
        if (a.type === "move" && a.toFolderName) store.recordCategoryAdoption(a.toFolderName);
      }
      // D33 出站 Hook：整理完成事件（聚合，不含单条内容）
      if (result.status === "applied") {
        dispatchWebhooks(store, "bookmark.organized", {
          versionId: result.versionId,
          applied: result.applied ?? 0,
        });
      }
      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // D89 目录级重新整理：范围=目录子树，目标限定子树内、可在该目录下新建子目录；
  // 与全库整理共用版本/撤销内核（红线③：只移动，不删除/不归档）
  api.post("/organize/folder", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      folderId?: string;
      includeSubfolders?: boolean;
    };
    if (!body.folderId) return c.json({ error: "folderId_required" }, 400);
    try {
      const result = await organize.reclassifyFolder(body.folderId, {
        includeSubfolders: body.includeSubfolders !== false,
      });
      for (const a of result.appliedActions ?? []) {
        if (a.type === "move" && a.toFolderName) store.recordCategoryAdoption(a.toFolderName);
      }
      if (result.status === "applied") {
        dispatchWebhooks(store, "bookmark.organized", {
          versionId: result.versionId,
          applied: result.applied ?? 0,
        });
      }
      return c.json(result, 201);
    } catch (err) {
      if (String(err).includes("folder_not_found")) {
        return c.json({ error: "folder_not_found" }, 404);
      }
      return c.json({ error: String(err) }, 500);
    }
  });

  // DEV-08/14：历史版本列表（通知卡 / 只读明细 / 版本时间线三处撤销入口的兜底一环）
  api.get("/organize/versions", (c) => c.json({ versions: store.listVersions() }));

  api.post("/organize/rollback/:versionId", (c) => {
    try {
      return c.json(organize.rollback(c.req.param("versionId")));
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // D43 敏感内容旁路（tidy 功能点，点了就跑）：全库命中项标私密 + 移入「私人收藏」，单事务、可撤销
  api.post("/tidy/sensitive", (c) => {
    try {
      const result = organize.sweepSensitive();
      // D33 出站 Hook：整理完成事件（聚合计数，不含单条内容）
      if (result.marked > 0) {
        dispatchWebhooks(store, "bookmark.organized", {
          versionId: result.versionId,
          applied: result.marked,
        });
      }
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // ---------- F7 搜索（全文 + 语义） ----------
  api.get("/search", async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ results: [] });
    if (c.req.query("semantic") === "1") {
      const rows = await semantic.search(q, 20, { includePrivate: privateVisible(c) });
      return c.json({ results: rows, mode: "semantic" });
    }
    // DEV-02：关键词搜索默认排除私密；X-MF-Private 为已鉴权管理面的显式显示开关
    return c.json({ results: store.search(q, 50, { includePrivate: privateVisible(c) }), mode: "fulltext" });
  });

  // ---------- F4 导航站（DEV-01：显式发布集合 + 确认计数 + 撤销发布） ----------
  api.get("/nav/data", (c) => {
    // 管理面预览：过滤私密/软归档（与公开渲染同一边界；不提供全库公开渲染）
    const folders = store.listFolders().filter((f) => !f.is_system_inbox);
    const data: NavData = {
      title: "我的导航",
      groups: folders
        .map((f) => ({
          name: f.name,
          items: store
            .listBookmarks({ folderId: f.id, limit: 200 })
            .filter((b) => b.status !== "archived" && b.is_private === 0)
            .map((b) => ({
              title: b.title,
              url: b.url_raw,
              favicon: b.favicon_url,
              dead: b.status === "dead",
              summary: (store.getCache(b.id)?.l1_summary as string | null) ?? null,
              siteType: b.site_type ?? null,
              hasSnapshot: store.hasSnapshot(b.id),
            })),
        }))
        .filter((g) => g.items.length > 0),
    };
    return c.json(data);
  });

  // ---------- D30/D31 站点化分析（切片 B：投影可随时重建） ----------
  api.post("/nav/projection/rebuild", (c) => {
    const projection = analyzeSiteProjection(store);
    store.saveProjection(projection);
    return c.json({ ok: true, counts: projection.counts, built_at: store.getProjection()?.built_at ?? null });
  });

  api.get("/nav/projection", (c) => {
    return c.json({ projection: store.getProjection() ?? null });
  });

  // 看名单 / 看明细（原型 13：站点化分析卡逐行钻取）
  api.get("/nav/projection/list", (c) => {
    const kind = c.req.query("kind") ?? "sites";
    const projection = store.getProjection() as SiteProjection | undefined;
    if (!projection) return c.json({ error: "projection_not_built" }, 404);
    if (kind === "sites" || kind === "upgraded") {
      const rows = (projection.sites ?? [])
        .filter((s) => (kind === "upgraded" ? s.upgraded : true))
        .map((s) => ({ domain: s.domain, title: s.title, url: s.url, upgraded: s.upgraded, count: s.bookmarkIds.length }));
      return c.json({ rows });
    }
    if (kind === "refs") return c.json({ rows: projection.refs ?? [] });
    if (kind === "merged") return c.json({ rows: projection.merged ?? [] });
    if (kind === "content") {
      return c.json({ rows: store.listBySiteType("content", 500) });
    }
    return c.json({ error: "invalid_kind" }, 400);
  });

  // ---------- D29 最常访问（应用内点击计数） ----------
  api.post("/bookmarks/:id/click", (c) => {
    store.recordBookmarkClick(c.req.param("id"));
    return c.json({ ok: true });
  });
  // GET /bookmarks/top 注册在 /bookmarks/:id 之前（见上方书签查询路由块）
  api.get("/nav/sites", (c) => c.json(store.navSites()));

  /**
   * 发布（新建或更新）。默认私有：必须显式提供 folderIds/bookmarkIds 至少一项。
   * 返回 itemCount（“将公开 N 项”确认页数据源）；仅元数据/摘要进入公开响应。
   */
  api.post("/nav/publish", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      slug?: string;
      title?: string;
      template?: string;
      password?: string | null;
      folderIds?: string[];
      bookmarkIds?: string[];
    };
    const template = NAV_TEMPLATES.includes(body.template as NavTemplate)
      ? (body.template as NavTemplate)
      : "grid";
    const passwordHash =
      body.password === null
        ? null
        : body.password
          ? (await hashPassword(body.password)).hash
          : undefined; // undefined = 保持原密码（仅更新范围/模板）
    let slug = body.slug ?? "";
    if (slug) {
      const site = store.getNavSiteFull(slug);
      if (!site) return c.json({ error: "site_not_found" }, 404);
    } else {
      // 加密随机 slug + 唯一冲突重试
      do {
        slug = Store.newNavSlug();
      } while (store.getNavSiteFull(slug) !== undefined);
      store.saveNavSite(slug, body.title ?? "我的导航");
    }
    try {
      const { itemCount } = store.publishNavSite(
        slug,
        { folderIds: body.folderIds ?? [], bookmarkIds: body.bookmarkIds ?? [] },
        {
          title: body.title,
          template,
          passwordHash,
        },
      );
      const site = store.getNavSiteFull(slug)!;
      store.audit("nav.published", `发布导航站 /s/${slug}（公开 ${itemCount} 项）`, clientKeyOf(c));
      // D67：登记 slug → 数据属主（云端 /s/:slug 借此路由到用户库；自建恒 self）
      registry.setSlugOwner(slug, currentUserId());
      return c.json(
        { slug, url: `/s/${slug}`, template, itemCount, revision: site.revision, published: site.published === 1 },
        201,
      );
    } catch (err) {
      if (String(err).includes("empty_publication_scope")) {
        // 未选择任何内容：拒绝发布并回滚新建的空站点（默认私有红线）
        if (!body.slug) {
          store.db.prepare("DELETE FROM nav_site WHERE slug = ?").run(slug);
        }
        return c.json({ error: "empty_publication_scope", hint: "发布前必须显式选择书签或目录" }, 400);
      }
      throw err;
    }
  });

  api.post("/nav/sites/:slug/unpublish", (c) => {
    const slug = c.req.param("slug");
    const ok = store.unpublishNavSite(slug);
    if (!ok) return c.json({ error: "not_found" }, 404);
    registry.deleteSlug(slug);
    store.audit("nav.unpublished", `下线导航站 /s/${slug}`, clientKeyOf(c));
    return c.json({ unpublished: true });
  });

  // 站点配置回显（管理面；password_hash 不回传，只回传是否有密码）
  api.get("/nav/sites/:slug", (c) => {
    const site = store.getNavSiteFull(c.req.param("slug"));
    if (!site) return c.json({ error: "not_found" }, 404);
    const scope = store.navSiteScope(site.slug);
    return c.json({
      slug: site.slug,
      title: site.title,
      template: site.template,
      hasPassword: site.password_hash !== null,
      published: site.published === 1,
      revision: site.revision,
      scope,
      config: store.getNavSiteConfig(site.slug),
      itemCount: store.navSiteItems(site.slug).length,
    });
  });

  /**
   * PATCH 以完整当前配置为基线：缺字段保持原值；password 显式 null 才移除；
   * 只改 title 不再丢失密码/模板（修复 E02）。
   */
  api.patch("/nav/sites/:slug", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      template?: string;
      password?: string | null;
      /** 原型 13：主题色/搜索引擎/显示选项/水印/自定义卡/包含资料站（整体替换语义） */
      config?: Record<string, unknown>;
    };
    const site = store.getNavSiteFull(c.req.param("slug"));
    if (!site) return c.json({ error: "not_found" }, 404);
    const passwordHash =
      body.password === null ? null : body.password ? (await hashPassword(body.password)).hash : undefined;
    store.updateNavSite(c.req.param("slug"), {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.template && NAV_TEMPLATES.includes(body.template as NavTemplate)
        ? { template: body.template }
        : {}),
      ...(passwordHash !== undefined ? { passwordHash } : {}),
    });
    if (body.config !== undefined) store.setNavSiteConfig(c.req.param("slug"), body.config);
    const updated = store.getNavSiteFull(c.req.param("slug"))!;
    return c.json({
      slug: updated.slug,
      title: updated.title,
      template: updated.template,
      hasPassword: updated.password_hash !== null,
      published: updated.published === 1,
      revision: updated.revision,
      config: store.getNavSiteConfig(c.req.param("slug")),
    });
  });

  // DEV-01：匿名全库搜索已关闭。公开搜索一律 /s/:slug/search（限定站点发布集合，
  // 且受该站密码凭证约束）；私有搜索走已鉴权 /api/v1/search。

  // ---------- F2.4 快照（配额管控） ----------
  api.post("/snapshots", async (c) => {
    const bookmarkId = c.req.query("bookmarkId");
    const bm = bookmarkId ? store.getBookmark(bookmarkId) : undefined;
    if (!bookmarkId || !bm) {
      return c.json({ error: "bookmark_not_found" }, 404);
    }
    // A1-3 服务端纵深校验：隐私域/私密书签不接受快照上传
    const decision = pipeline.serverDecide("snapshot", bm.url_canonical, {
      isPrivateBookmark: bm.is_private === 1,
    });
    if (!decision.allowed) {
      return c.json({ error: "privacy_blocked", reason: decision.reason }, 403);
    }
    const buf = await c.req.arrayBuffer();
    if (!buf || buf.byteLength === 0) return c.json({ error: "empty_body" }, 400);
    // A4-4 前置：MHTML 格式 magic 校验（捕获失败/不完整文件不记为成功）
    const head = new TextDecoder("latin1").decode(buf.slice(0, 512));
    if (!/content-type:\s*multipart\/related/i.test(head) && !/^mime-version:/im.test(head)) {
      return c.json({ error: "invalid_mhtml_format" }, 400);
    }
    const MB = 1024 * 1024;
    if (buf.byteLength > 20 * MB) return c.json({ error: "snapshot_too_large", maxBytes: 20 * MB }, 413);
    // 配额（技术方案 §7.2）：snapshot_quota_bytes 未设置 = 不限（自建）；云端按套餐
    const quota = Number(store.getSetting("snapshot_quota_bytes") ?? 0);
    if (quota > 0 && store.snapshotUsageBytes() + buf.byteLength > quota) {
      return c.json({ error: "quota_exceeded", used: store.snapshotUsageBytes(), quota }, 402);
    }
    const id = newId();
    const dir = path.join(dataDir, "snapshots");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.mhtml`);
    writeFileSync(file, Buffer.from(buf));
    store.db
      .prepare(
        "INSERT INTO snapshot (id, bookmark_id, format, path, size, created_at, via) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, bookmarkId, "mhtml", file, buf.byteLength, new Date().toISOString(), "extension_mhtml");
    return c.json({ id, size: buf.byteLength, usageBytes: store.snapshotUsageBytes() }, 201);
  });

  // A4-4/A4-5：快照查看（净化视图，禁脚本/禁外联）与受控下载分开
  // 快照版本列表（原型 08/11：查看器版本 tabs + 书签详情抽屉；仅元数据不含内容）
  api.get("/snapshots", (c) => {
    const bookmarkId = c.req.query("bookmarkId");
    if (!bookmarkId) return c.json({ error: "bookmarkId_required" }, 400);
    if (!store.getBookmark(bookmarkId)) return c.json({ error: "bookmark_not_found" }, 404);
    return c.json({ snapshots: store.listSnapshots(bookmarkId) });
  });

  api.get("/snapshots/:id/view", (c) => {
    const row = store.db
      .prepare("SELECT s.*, b.url_canonical, b.title, b.is_private FROM snapshot s JOIN bookmarks b ON b.id = s.bookmark_id WHERE s.id = ?")
      .get(c.req.param("id")) as
      | { id: string; path: string; title: string; url_canonical: string; is_private: number }
      | undefined;
    if (!row) return c.json({ error: "not_found" }, 404);
    // 隐私域/私密书签：下载执行隐私检查（A4-5），查看同样受控
    const decision = pipeline.serverDecide("snapshot", row.url_canonical, {
      isPrivateBookmark: row.is_private === 1,
    });
    if (!decision.allowed) return c.json({ error: "privacy_blocked" }, 403);
    try {
      const mhtml = readFileSync(row.path, "utf8");
      const view = buildSnapshotView(mhtml, { snapshotId: row.id, title: row.title });
      if (!view.ok || !view.viewer) {
        // 无法安全内嵌：给出受控下载路径与说明（A4-5：不假装可显示）
        return c.html(
          `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>快照无法在线显示</title></head><body style="font:14px/1.6 -apple-system,sans-serif;max-width:560px;margin:15vh auto;padding:0 24px"><h2>该快照无法安全在线显示</h2><p>此 MHTML 不包含可净化的 HTML 部分，或解码失败。你可以下载原始文件后用浏览器打开，注意其中可能包含原始页面的脚本与外部引用。</p><p><a href="/api/v1/snapshots/${row.id}/download">下载原始 MHTML</a></p></body></html>`,
        );
      }
      c.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
      c.header("content-type", "text/html; charset=utf-8");
      return c.body(view.viewer);
    } catch {
      return c.json({ error: "file_missing" }, 500);
    }
  });

  // 受控下载：鉴权（API 中间件已保证）+ 隐私检查 + attachment（不内联执行）
  api.get("/snapshots/:id/download", (c) => {
    const row = store.db
      .prepare("SELECT s.*, b.url_canonical, b.is_private FROM snapshot s JOIN bookmarks b ON b.id = s.bookmark_id WHERE s.id = ?")
      .get(c.req.param("id")) as
      | { id: string; path: string; url_canonical: string; is_private: number }
      | undefined;
    if (!row) return c.json({ error: "not_found" }, 404);
    const decision = pipeline.serverDecide("snapshot", row.url_canonical, {
      isPrivateBookmark: row.is_private === 1,
    });
    if (!decision.allowed) return c.json({ error: "privacy_blocked" }, 403);
    try {
      const data = readFileSync(row.path);
      c.header("content-type", "application/octet-stream"); // 不用 message/rfc822 内联
      c.header("content-disposition", `attachment; filename="snapshot-${row.id}.mhtml"`);
      c.header("x-content-type-options", "nosniff");
      return c.body(data);
    } catch {
      return c.json({ error: "file_missing" }, 500);
    }
  });

  // DEV-02：旧快照直读接口已封堵——它绕过受控下载头/隐私检查（message/rfc822 可被内联渲染）。
  // 迁移指引：净化查看 /view，原始文件受控下载 /download（均鉴权 + 隐私检查）。
  api.get("/snapshots/:id", (c) => {
    void c.req.param("id");
    return c.json(
      {
        error: "endpoint_removed",
        hint: "旧快照直读已下线。净化查看: GET /api/v1/snapshots/:id/view；受控下载: GET /api/v1/snapshots/:id/download",
      },
      410,
    );
  });

  // ---------- F1.7 多端同步（变更日志 + 游标） ----------
  api.post("/sync/push", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      device?: string;
      changes?: Array<{ entity: string; entity_id: string; op: string; payload?: unknown }>;
    };
    if (!body.device || !Array.isArray(body.changes)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    for (const ch of body.changes) {
      store.recordChange(ch.entity, ch.entity_id, ch.op, ch.payload, body.device);
    }
    return c.json({ applied: body.changes.length, cursor: store.maxChangeId() });
  });

  api.get("/sync/pull", (c) => {
    const cursor = Number(c.req.query("cursor") ?? 0);
    const device = c.req.query("device") ?? c.req.header("x-mf-device") ?? null;
    // D81 §3-C：游标缺口检测 + 库代际校验——过期游标返回 reset_required，
    // 端侧走快照恢复协议（保留本地未提交操作，快照重建后重放），不静默跳事件。
    const minAvailableId = store.minChangeId();
    const maxChangeId = store.maxChangeId();
    const generation = store.syncGeneration();
    const clientGen = c.req.query("gen");
    const gap =
      (minAvailableId !== null && cursor < minAvailableId - 1) || // 裁剪边界越过
      (minAvailableId === null && cursor > 0) || // 日志被清空但设备有历史
      cursor > maxChangeId || // DB 恢复/回退（游标在未来）
      (clientGen !== undefined && clientGen !== generation); // 库代际不符（DB 替换）
    if (gap) {
      return c.json({ reset_required: true, items: [], cursor, minAvailableId, maxChangeId, generation });
    }
    return c.json({ ...store.pullChanges(cursor, device), minAvailableId, maxChangeId, generation });
  });

  /** D81 §3-C：一致性快照 + 固定水位（读事务内取数，快照完成后只拉水位之后的变更） */
  api.get("/sync/snapshot", (c) => c.json(store.syncSnapshot()));

  /** D81 §3-D-4：设备同步状态上报（开关关闭时显式停标，镜像 ops 恢复 legacy 语义） */
  api.post("/devices/sync-state", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { deviceId?: string; enabled?: boolean } | null;
    if (!body?.deviceId) return c.json({ error: "deviceId_required" }, 400);
    store.setDeviceSyncEnabled(body.deviceId, body.enabled === true);
    return c.json({ ok: true });
  });

  /**
   * D50 变更事件流（SSE）：库侧任何改动即推「有事发生，来拉」给扩展——
   * 管理台动作后浏览器秒级收敛的推送通道。不携带数据（真相仍是 changes 表+游标），
   * 丢事件不丢正确性（兜底 = 扩展 1 分钟告警）。1 秒合并窗口防整理批次刷屏，
   * 20 秒心跳保活（兼给 MV3 SW 续命）。
   */
  api.get("/events/stream", (c) => {
    // D67：本连接归属用户（中间件已建上下文）；云端只收自己的变更，自建恒 self 全量照旧
    const myUser = currentUserId();
    return streamSSE(c, async (stream) => {
      let dirty = false;
      const unsub = hub.subscribe((ev) => {
        if (!ev.user || ev.user === myUser) dirty = true;
      });
      try {
        await stream.writeSSE({ event: "hello", data: "{}" });
        let lastPing = Date.now();
        while (!stream.aborted) {
          await new Promise((r) => setTimeout(r, 1000));
          if (dirty) {
            dirty = false;
            await stream.writeSSE({ event: "change", data: JSON.stringify({ at: Date.now() }) });
            lastPing = Date.now();
          } else if (Date.now() - lastPing > 20_000) {
            lastPing = Date.now();
            await stream.writeSSE({ event: "ping", data: "{}" });
          }
        }
      } catch {
        /* 断连/写入失败：正常收尾 */
      } finally {
        unsub();
      }
    });
  });

  /** D46 双向同步：浏览器侧 diff 落库（幂等；变更日志带发起设备，不回声） */
  api.post("/sync/apply", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      deviceId?: string;
      mutations?: unknown[];
    } | null;
    if (!body?.deviceId || !Array.isArray(body.mutations)) {
      return c.json({ error: "deviceId_mutations_required" }, 400);
    }
    if (body.mutations.length > 2000) return c.json({ error: "too_many_mutations" }, 400);
    return c.json(applySyncMutations(store, body.deviceId, body.mutations));
  });

  /** D46 首次对齐：本设备身份映射与应用侧存在性（孤儿映射 = 库已删，浏览器待清） */
  api.get("/browser/identities", (c) => {
    const deviceId = c.req.query("deviceId");
    if (!deviceId) return c.json({ error: "deviceId_required" }, 400);
    const browserId = c.req.query("browserId"); // D79：单节点反查（盒内删除取消用，免全量拉取）
    const all = store.identitiesWithState(deviceId);
    return c.json({ identities: browserId ? all.filter((i) => i.browser_bookmark_id === browserId) : all });
  });

  /** D81 §3-A：本设备目录身份映射（folder_identity）——引擎每轮据此重建 fMap，跨 SW 重启不丢 */
  api.get("/browser/folder-identities", (c) => {
    const deviceId = c.req.query("deviceId");
    if (!deviceId) return c.json({ error: "deviceId_required" }, 400);
    return c.json({ identities: store.folderIdentities(deviceId) });
  });

  // ---------- F5 维护（死链/查重/周报/体检） ----------
  api.post("/maintenance/links/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
    const result = await maintenance.runLinkCheck(Math.min(body.limit ?? 20, 50));
    return c.json(result);
  });

  // ---------- F5 死链检测进度流（SSE：每检查完一条推送一条，断开即中止） ----------
  api.get("/maintenance/links/run/stream", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 50);
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "start", data: JSON.stringify({ total: limit }) });
      try {
        const result = await maintenance.runLinkCheckWithProgress(limit, (item, total) => {
          if (stream.aborted) return false; // 客户端断开 → 停止后续探测
          void stream.writeSSE({ event: "item", data: JSON.stringify({ ...item, total }) });
          return true;
        });
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            checked: result.checked,
            reportId: result.reportId,
            dead: result.results.filter((r) => r.verdict === "dead").length,
            suspect: result.results.filter((r) => r.verdict === "suspect").length,
            normal: result.results.filter((r) => r.verdict === "normal").length,
          }),
        });
      } catch (err) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: String(err).slice(0, 200) }) });
      }
    });
  });

  api.post("/maintenance/duplicates/run", (c) => c.json(maintenance.runDuplicateScan()));

  api.get("/maintenance/report/latest", (c) => {
    const type = c.req.query("type") ?? "link_check";
    const report = store.latestReport(type);
    if (!report) return c.json({ error: "no_report_yet" }, 404);
    return c.json(report);
  });

  api.get("/maintenance/reports", (c) => c.json(store.listReports(c.req.query("type"))));

  api.get("/health-report", (c) => c.json(maintenance.healthReport()));

  // ---------- BYOK 供应商配置（F3.7 技术方案 §6.1） ----------
  api.get("/settings/providers", (c) => c.json(store.listProviderConfigs()));

  api.post("/settings/providers", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      providerId?: string;
      baseUrl?: string;
      apiKey?: string | null;
      purposeModels?: Record<string, string>;
      enabled?: boolean;
    };
    if (!body.providerId || !body.baseUrl) {
      return c.json({ error: "providerId_and_baseUrl_required" }, 400);
    }
    let id: string;
    try {
      id = store.saveProviderConfig({
        id: body.id,
        providerId: body.providerId,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey ?? null,
        purposeModels: body.purposeModels ?? {},
        enabled: body.enabled,
      });
    } catch (err) {
      // A4-2：生产未配置 MF_SECRET_KEY → 明确指引（不静默明文落库）
      if (String(err).includes("MF_SECRET_KEY_required_for_provider_keys")) {
        return c.json(
          { error: "MF_SECRET_KEY_required_for_provider_keys", hint: "在部署环境中设置 MF_SECRET_KEY（≥16 字符）后再保存 Provider Key" },
          400,
        );
      }
      throw err;
    }
    // D58：配置变更入审计——detail 只落 providerId 与启停，绝不落 apiKey
    store.audit(
      "provider.saved",
      `保存 AI 供应商配置：${body.providerId}${body.enabled === false ? "（已停用）" : ""}`,
      clientKeyOf(c),
    );
    return c.json({ id }, 201);
  });

  api.post("/settings/providers/test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
    };
    if (!body.baseUrl) return c.json({ error: "baseUrl_required" }, 400);
    try {
      const { LlmClient } = await import("@mf/ai/llm-client");
      const client = new LlmClient({
        baseUrl: body.baseUrl,
        apiKey: body.apiKey ?? null,
        model: body.model ?? "default",
      });
      const content = await client.chat([{ role: "user", content: "ping" }], { timeoutMs: 10_000 });
      return c.json({ ok: true, sample: content.slice(0, 80) });
    } catch (err) {
      return c.json({ ok: false, error: String(err).slice(0, 200) });
    }
  });

  // 拉取供应商在线模型列表（OpenAI 兼容 GET /models；Anthropic 走自有端点与协议头）
  api.get("/settings/providers/:id/models", async (c) => {
    const row = store.enabledProviderConfigs().find((r) => r.id === c.req.param("id"));
    if (!row) return c.json({ error: "provider_not_found_or_disabled" }, 404);
    const base = row.base_url.replace(/\/$/, "");
    const isAnthropic = row.provider_id === "anthropic";
    const url = isAnthropic ? `${base}/v1/models` : `${base}/models`;
    const headers: Record<string, string> = isAnthropic
      ? { "x-api-key": row.api_key ?? "", "anthropic-version": "2023-06-01" }
      : row.api_key
        ? { authorization: `Bearer ${row.api_key}` }
        : {};
    try {
      // A1-4 统一出站守卫：管理员配置的 base_url 同样可能指向内网元数据端点（SSRF），
      // 与 crawl/favicon 同规——guardedFetch（SSRF 校验+连接固定+字节上限），不用裸 fetch
      const res = await guardedFetch(url, guardConfig, { headers }, {
        maxBytes: 1_000_000,
        timeoutMs: 10_000,
        totalTimeoutMs: 15_000,
      });
      if (!res.ok) {
        res.dispose();
        return c.json({ error: `provider_returned_${res.status}` }, 502);
      }
      const body = await res.readBody(1_000_000);
      const parsed = JSON.parse(body.toString("utf8")) as { data?: Array<{ id?: string }> };
      const models = (parsed.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
      return c.json({ models });
    } catch (err) {
      return c.json({ error: String(err).slice(0, 200) }, 502);
    }
  });

  api.get("/settings/prefs", (c) =>
    c.json({
      topCategories: store.topCategories(),
      adoption: store.getPref("category_adoption") ?? {},
      // D28 通知方式（管理台侧）：toast 轻提示（默认）/ card 通知卡 / silent 静默仅版本记录
      notifyStyle: store.getPref("notify_style") ?? "toast",
      // 原型 12：整理偏好记忆（用户可查看/删除的规则，如「同一文档多版本共存时不合并」）
      organizeRules: store.getOrganizeRules(),
    }),
  );

  // D28 + 原型 12：通知方式三档 / 整理偏好规则（管理台侧）
  api.patch("/settings/prefs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { notifyStyle?: unknown; organizeRules?: unknown };
    if (body.notifyStyle !== undefined && !["toast", "card", "silent"].includes(body.notifyStyle as string)) {
      return c.json({ error: "invalid_notify_style" }, 400);
    }
    if (body.notifyStyle !== undefined) store.setPref("notify_style", body.notifyStyle);
    if (body.organizeRules !== undefined) {
      if (!Array.isArray(body.organizeRules) || body.organizeRules.some((r) => typeof r !== "string")) {
        return c.json({ error: "invalid_organize_rules" }, 400);
      }
      store.setOrganizeRules(body.organizeRules as string[]);
    }
    // D58：偏好变更入审计（记改了哪些项，不记值——规则列表可能很长）
    {
      const changed: string[] = [];
      if (body.notifyStyle !== undefined) changed.push("通知方式");
      if (body.organizeRules !== undefined) changed.push("整理偏好规则");
      if (changed.length > 0) store.audit("settings.changed", `更新偏好：${changed.join("、")}`, clientKeyOf(c));
    }
    return c.json({
      ok: true,
      notifyStyle: store.getPref("notify_style") ?? "toast",
      organizeRules: store.getOrganizeRules(),
    });
  });

  // ---------- D33 集成 Hook（出站 Webhook：Key/Secret 落库、SSRF 防护、隐私前置） ----------
  api.get("/settings/webhooks", (c) => c.json({ webhooks: store.listHooks() }));

  api.post("/settings/webhooks", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string; label?: string; url?: string; events?: string[];
      granularity?: string; secret?: string | null; enabled?: boolean;
    };
    if (!body.label || !body.url || !/^https?:\/\//.test(body.url) || !Array.isArray(body.events) || body.events.length === 0) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { id } = store.saveHook({
      id: body.id,
      label: body.label,
      url: body.url,
      events: body.events,
      granularity: body.granularity === "full" ? "full" : "meta",
      secret: body.secret ?? undefined,
      enabled: body.enabled,
    });
    store.audit("webhook.saved", `保存 Webhook「${body.label}」（${body.events.join("/")}）`, clientKeyOf(c));
    return c.json({ ok: true, id }, 201);
  });

  api.delete("/settings/webhooks/:id", (c) => {
    const target = store.getHook(c.req.param("id"));
    const ok = store.deleteHook(c.req.param("id"));
    if (ok) store.audit("webhook.removed", `删除 Webhook「${target?.label ?? c.req.param("id")}」`, clientKeyOf(c));
    return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });

  // 测试：发一条 test 事件（走同一 SSRF/HMAC 链路；目标不可达时 ok=false + 原因，不抛 500）
  api.post("/settings/webhooks/:id/test", async (c) => {
    const hook = store.getHook(c.req.param("id"));
    if (!hook) return c.json({ error: "not_found" }, 404);
    const result = await deliverHook(hook.url, hook.secret, {
      event: "checkup.done",
      ts: new Date().toISOString(),
      data: { test: true, source: "my-favorites" },
    });
    return c.json(result);
  });

  // ---------- 埋点 ----------
  api.post("/analytics/events", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      events?: Array<{ name: string; props?: unknown }>;
    };
    if (!Array.isArray(body.events)) return c.json({ error: "invalid_request" }, 400);
    const recorded = store.recordEvents(body.events);
    return c.json({ recorded });
  });

  api.get("/analytics/summary", (c) => {
    const names = [
      "bookmark_saved",
      "install",
      "import_completed",
      "stage1_result_viewed",
      "diff_accepted", // 旧确认流事件（D27 前历史数据，仅保留统计）
      "organize_applied", // D27：整理直接生效（替代 diff_accepted）
      "nav_generated",
      "ntp_enabled",
      "inbox_auto_sorted",
      "snapshot_created",
      "weekly_report_clicked",
    ];
    return c.json(Object.fromEntries(names.map((n) => [n, store.countEvents(n)])));
  });

  // ---------- D73 系统管理：统一部署唯一的注册策略与用户管理面 ----------
  api.get("/admin/system", (c) => {
    const denied = adminRequired(c);
    if (denied) return denied;
    return c.json({ registrationOpen: registry.registrationOpen(), users: registry.listUsers() });
  });

  api.patch("/admin/system", async (c) => {
    const denied = adminRequired(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { registrationOpen?: boolean };
    if (typeof body.registrationOpen !== "boolean") {
      return c.json({ error: "registration_open_boolean_required" }, 400);
    }
    const changed = registry.registrationOpen() !== body.registrationOpen;
    registry.setRegistrationOpen(body.registrationOpen);
    if (changed) store.audit(
      "system.registration_changed",
      `${body.registrationOpen ? "开放" : "关闭"}公开注册`,
      clientKeyOf(c),
    );
    return c.json({ registrationOpen: registry.registrationOpen() });
  });

  api.post("/admin/users", async (c) => {
    const denied = adminRequired(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      displayName?: string;
      role?: UserRole;
    };
    if (!body.username || !body.password) {
      return c.json({ error: "username_password_required" }, 400);
    }
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(body.username)) {
      return c.json({ error: "invalid_username", hint: "3-32 位字母/数字/-/_" }, 400);
    }
    if (body.password.length < 8) return c.json({ error: "password_too_short_min_8" }, 400);
    if (body.role !== undefined && body.role !== "admin" && body.role !== "user") {
      return c.json({ error: "invalid_role" }, 400);
    }
    if (registry.findUserByUsername(body.username)) {
      return c.json({ error: "username_taken" }, 409);
    }
    const { hash } = await hashPassword(body.password);
    const user = registry.createUser(body.username, hash, body.displayName ?? null, body.role ?? "user");
    userDbs.dbFor(user.id);
    store.audit("user.created", `管理员创建账号 ${user.username}（${user.role === "admin" ? "管理员" : "普通用户"}）`, clientKeyOf(c));
    return c.json({ user: safeUser(user) }, 201);
  });

  api.patch("/admin/users/:id", async (c) => {
    const denied = adminRequired(c);
    if (denied) return denied;
    const target = registry.findUserById(c.req.param("id"));
    if (!target) return c.json({ error: "user_not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      disabled?: boolean;
      role?: UserRole;
      newPassword?: string;
    };
    if (body.disabled === undefined && body.role === undefined && body.newPassword === undefined) {
      return c.json({ error: "empty_user_update" }, 400);
    }
    if (body.disabled !== undefined && typeof body.disabled !== "boolean") {
      return c.json({ error: "disabled_boolean_required" }, 400);
    }
    if (body.role !== undefined && body.role !== "admin" && body.role !== "user") {
      return c.json({ error: "invalid_role" }, 400);
    }
    if (body.newPassword !== undefined && body.newPassword.length < 8) {
      return c.json({ error: "password_too_short_min_8" }, 400);
    }
    const demoting = body.role === "user" && target.role === "admin";
    const disabling = body.disabled === true && !target.disabled_at;
    if (target.id === SELF_USER_ID && (demoting || disabling)) {
      return c.json({ error: "owner_immutable" }, 400);
    }
    if (target.id === currentUserId() && (demoting || disabling)) {
      return c.json({ error: "cannot_disable_or_demote_self" }, 400);
    }
    if ((demoting || disabling) && !target.disabled_at && registry.countActiveAdmins(target.id) === 0) {
      return c.json({ error: "last_admin_required" }, 400);
    }
    if (body.newPassword !== undefined && target.id === SELF_USER_ID) {
      return c.json({ error: "owner_password_use_account_settings" }, 400);
    }
    if (body.role !== undefined) registry.setUserRole(target.id, body.role);
    if (body.disabled !== undefined) registry.setUserDisabled(target.id, body.disabled);
    let revokedTokens = 0;
    if (body.newPassword !== undefined) {
      const { hash } = await hashPassword(body.newPassword);
      registry.updateUserPassword(target.id, hash);
    }
    if (body.newPassword !== undefined || disabling) {
      revokedTokens = registry.revokeAllTokensForUser(target.id);
    }
    store.audit(
      "user.updated",
      `管理员更新账号 ${target.username}${body.role !== undefined && body.role !== target.role ? `（角色改为${body.role === "admin" ? "管理员" : "普通用户"}）` : ""}${disabling ? "（停用）" : ""}${body.disabled === false && target.disabled_at ? "（恢复使用）" : ""}${body.newPassword !== undefined ? "（重置密码）" : ""}`,
      clientKeyOf(c),
    );
    const updated = registry.findUserById(target.id)!;
    return c.json({ user: safeUser(updated), revokedTokens });
  });

  api.get("/admin/users/:id/export", (c) => {
    const denied = adminRequired(c);
    if (denied) return denied;
    const target = registry.findUserById(c.req.param("id"));
    if (!target) return c.json({ error: "user_not_found" }, 404);
    const payload = runAsUser(target.id, () => buildUserExport(store.db, safeUser(target)));
    c.header(
      "content-disposition",
      `attachment; filename="my-favorites-${target.username}-export.json"`,
    );
    store.audit("user.exported", `管理员导出账号 ${target.username} 的数据`, clientKeyOf(c));
    return c.json(payload);
  });

  // ---------- 令牌管理（DEV-05：非密 ID 列表 / 按 ID 撤销 / logout 失效；D67 registry 承载） ----------
  api.get("/auth/tokens", (c) => {
    // 列表不含任何 token 原值/摘要；token_id 为随机非密 ID，可直接用于撤销。
    // D68：恒按当前用户过滤（owner 'self' 亦然；列表不含任何 token 原值/摘要）
    const raw = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
    const current = raw ? registry.resolveToken(raw) : undefined;
    return c.json({ tokens: registry.listTokens(currentUserId()).map((t) => ({ ...t, current: t.token_id === current?.tokenId })) });
  });

  api.post("/auth/tokens/revoke-others", (c) => {
    const raw = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
    const current = raw ? registry.resolveToken(raw) : undefined;
    if (!current || current.userId !== currentUserId()) return c.json({ error: "unauthorized" }, 401);
    const revoked = registry.revokeOtherTokens(currentUserId(), current.tokenId);
    if (revoked) registry.audit("token.revoked", `撤销其他登录会话（${revoked} 个），保留当前会话`, clientKeyOf(c));
    return c.json({ revoked });
  });

  api.delete("/auth/tokens/:tokenId", (c) => {
    const tokenId = c.req.param("tokenId");
    const mine = registry.listTokens(currentUserId());
    const target = mine.find((t) => t.token_id === tokenId);
    // 多用户边界：非本人的 tokenId 与不存在同等 404，绝不能凭 ID 撤销其他用户令牌。
    if (!target) return c.json({ error: "not_found_or_already_revoked" }, 404);
    const ok = registry.revokeTokenById(tokenId);
    if (!ok) return c.json({ error: "not_found_or_already_revoked" }, 404);
    registry.audit("token.revoked", `撤销令牌「${target?.label ?? tokenId}」`, clientKeyOf(c));
    return c.json({ revoked: true });
  });

  api.post("/auth/logout", (c) => {
    // 撤销当前请求使用的 token（摘要匹配）
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const revoked = token ? registry.revokeByRawToken(token) : false;
    if (revoked) registry.audit("token.revoked", "退出登录（撤销当前令牌）", clientKeyOf(c));
    return c.json({ loggedOut: revoked });
  });

  // ---------- D67 账号安全：改密码 / 当前身份 ----------
  api.post("/auth/password", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { oldPassword?: string; newPassword?: string };
    if (!body.oldPassword || !body.newPassword) {
      return c.json({ error: "old_new_password_required" }, 400);
    }
    if (body.newPassword.length < 8) return c.json({ error: "password_too_short_min_8" }, 400);
    // 改密码是一次凭据校验 → 与登录同级的限速（key 区分场景）
    const key = `pw:${clientKeyOf(c)}`;
    if (loginRateLimited(key)) return c.json({ error: "rate_limited" }, 429);
    const uid = currentUserId();
    if (uid === SELF_USER_ID && authEnabled(adminPassword)) {
      // owner + env 密码：凭据由部署环境管理，不提供在线改密
      return c.json(
        { error: "env_password_managed_externally", hint: "ADMIN_PASSWORD 由部署环境变量管理，请修改部署配置" },
        400,
      );
    }
    const owner = registry.findUserById(uid);
    if (!owner) return c.json({ error: "unauthorized" }, 401);
    if (!verifyPasswordHash(body.oldPassword, owner.password_hash)) {
      recordLoginFailure(key);
      return c.json({ error: "invalid_password" }, 401);
    }
    const newHash = (await hashPassword(body.newPassword)).hash;
    registry.updateUserPassword(uid, newHash);
    if (uid === SELF_USER_ID) {
      // owner 双写：DB-hash 旧登录路径（{password}）与新用户名登录保持同一凭据
      registry.setSetting("admin_password_hash", newHash);
    }
    clearLoginFailures(key);
    // 红线：审计只记事件，绝不落密码
    registry.audit("password.changed", `修改密码（${owner.username}）`, clientKeyOf(c));
    return c.json({ changed: true });
  });

  api.get("/auth/me", (c) => {
    const user = registry.findUserById(currentUserId());
    return c.json({
      userId: currentUserId(),
      username: user?.username ?? null,
      displayName: user?.display_name ?? null,
      role: user?.role ?? (currentUserId() === SELF_USER_ID ? "admin" : "user"),
      isAdmin: registry.isAdmin(currentUserId()),
      registrationOpen: registry.registrationOpen(),
      deployMode: "unified",
    });
  });

  // ---------- 操作审计日志（D58：设置页「操作日志」分区数据源；走上方鉴权中间件） ----------
  api.get("/audit", (c) => {
    const positiveInt = (value: string | undefined, fallback: number, max: number): number => {
      const n = Number(value);
      return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
    };
    const limit = positiveInt(c.req.query("limit"), 25, 500);
    const requestedPage = positiveInt(c.req.query("page"), 1, Number.MAX_SAFE_INTEGER);
    // 每库保留 1000 条；多取一倍覆盖每日裁剪前的短暂增量。
    // 同库只读一次，异库保留独立标识，不按内容去重（重复失败也是有效审计）。
    const events = [
      ...registry.listAudit(2000).map((e) => ({ ...e, eventId: `registry:${e.id}` })),
      ...(store.db === registry.db ? [] : store.listAudit(2000).map((e) => ({ ...e, eventId: `user:${e.id}` }))),
    ].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id || a.eventId.localeCompare(b.eventId));
    const total = events.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(requestedPage, totalPages);
    return c.json({ events: events.slice((page - 1) * limit, page * limit), total, page, pageSize: limit, totalPages });
  });

  // ---------- stats ----------
  api.get("/stats", (c) => {
    const counts = store.countBookmarks();
    return c.json({
      ...counts,
      folders: store.listFolders().length,
      navSites: store.navSites().length,
    });
  });

  // ---------- 公开页与根级路由 ----------
  const root = new Hono();
  root.use("*", sharedCors);
  root.get("/healthz", (c) =>
    c.json({
      ok: true,
      form: process.env.MF_FORM ?? "self-hosted",
      version: SERVER_VERSION,
      // D73：所有部署同一张登录页；注册入口只由管理员控制的持久化开关决定。
      deployMode: "unified",
      registrationOpen: registry.registrationOpen(),
    }),
  );

  // F6.2/A4-1 + DEV-05 登录（环境变量密码或 DB hash；两种模式统一限速，key 区分模式）
  // D67 云端：username + password 多用户登录；自建保持单管理员密码（传 username 直接拒绝）
  root.post("/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      label?: string;
    };
    if (!body.password) return c.json({ error: "password_required" }, 400);
    const clientKey = clientKeyOf(c);
    const label = body.label ?? "device";
    // D58：登录三态入审计日志（限速/失败此前只在内存滑窗，重启即失、被爆破无感知）。
    // detail 只落 label/username，绝不落密码。
    // D68 统一：username + password 是一切部署形态的默认登录（自托管=官方云，仅地址不同）
    if (body.username) {
      const key = `user:${body.username}:${clientKey}`;
      if (loginRateLimited(key)) {
        store.audit("auth.rate_limited", `登录被限速：${body.username}`, clientKey);
        return c.json({ error: "rate_limited" }, 429);
      }
      const user = registry.findUserByUsername(body.username);
      if (!user || !verifyPasswordHash(body.password, user.password_hash)) {
        recordLoginFailure(key);
        // 用户不存在与密码错误同一响应：不暴露账号是否存在
        store.audit("auth.failed", `登录失败：${body.username}（${label}）`, clientKey);
        return c.json({ error: "invalid_password" }, 401);
      }
      if (user.disabled_at) {
        store.audit("auth.failed", `停用账号尝试登录：${body.username}（${label}）`, clientKey);
        return c.json({ error: "account_disabled" }, 403);
      }
      clearLoginFailures(key);
      const created = registry.createToken(user.id, label);
      store.audit("auth.login", `登录成功：${body.username}（${label}）`, clientKey);
      return c.json({
        token: created.token,
        tokenId: created.tokenId,
        username: user.username,
        displayName: user.display_name,
      });
    }
    // 兼容：无 username = 旧单管理员密码登录（owner；旧扩展/脚本不受影响）。
    // 环境变量模式：同样限速（修复 E07：env 密码无速率限制）
    if (authEnabled(adminPassword)) {
      const key = `admin-env:${clientKey}`;
      if (loginRateLimited(key)) {
        store.audit("auth.rate_limited", `登录被限速（env 模式）`, clientKey);
        return c.json({ error: "rate_limited" }, 429);
      }
      const result = login(registry, adminPassword, body.password, label);
      if ("error" in result) {
        recordLoginFailure(key);
        store.audit("auth.failed", `登录失败：密码错误（${label}）`, clientKey);
        return c.json(result, result.error === "auth_disabled" ? 400 : 401);
      }
      clearLoginFailures(key);
      store.audit("auth.login", `登录成功（${label}）`, clientKey);
      return c.json(result);
    }
    // A4-1 DB hash 模式（生产语义首启 setup 后）
    if (isProductionLike() && !setupRequired(registry)) {
      const result = loginWithDbHash(registry, body.password, label, `admin-db:${clientKey}`);
      if ("status" in result) {
        const status = result.status as 401 | 429;
        if (result.error === "rate_limited") store.audit("auth.rate_limited", "登录被限速", clientKey);
        else store.audit("auth.failed", `登录失败：密码错误（${label}）`, clientKey);
        return c.json({ error: result.error }, status);
      }
      store.audit("auth.login", `登录成功（${label}）`, clientKey);
      return c.json(result);
    }
    return c.json({ error: "auth_disabled" }, 400);
  });

  // D68 统一注册：一切部署形态开放（自托管多用户=云多用户，仅地址不同）。
  // 注册即建用户库（迁移同版）+ 签发首令牌；限速同登录，防批量注册。
  root.post("/auth/register", async (c) => {
    // D73：管理员面板持久化控制；MF_REGISTER_OPEN 仅作为首次未设置时的兼容默认值。
    if (!registry.registrationOpen()) {
      return c.json({ error: "register_closed", hint: "该实例已关闭注册" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      displayName?: string;
      label?: string;
    };
    if (!body.username || !body.password) {
      return c.json({ error: "username_password_required" }, 400);
    }
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(body.username)) {
      return c.json({ error: "invalid_username", hint: "3-32 位字母/数字/-/_" }, 400);
    }
    if (body.password.length < 8) return c.json({ error: "password_too_short_min_8" }, 400);
    const clientKey = clientKeyOf(c);
    const key = `register:${clientKey}`;
    if (loginRateLimited(key)) {
      store.audit("auth.rate_limited", "注册被限速", clientKey);
      return c.json({ error: "rate_limited" }, 429);
    }
    if (registry.findUserByUsername(body.username)) {
      return c.json({ error: "username_taken" }, 409);
    }
    const { hash } = await hashPassword(body.password);
    // 全新部署的第一个账号就是系统管理员；后续公开注册一律普通用户。
    const firstAccount = registry.countUsers() === 0;
    const user = registry.createUser(
      body.username,
      hash,
      body.displayName ?? null,
      firstAccount ? "admin" : "user",
    );
    userDbs.dbFor(user.id); // 注册即建数据文件（openDb 内含同版迁移）
    const created = registry.createToken(user.id, body.label ?? "signup");
    store.audit("user.registered", `注册账号 ${user.username}`, clientKey);
    return c.json(
      { token: created.token, tokenId: created.tokenId, username: user.username, displayName: user.display_name },
      201,
    );
  });

  // D21（2026-11-18）：删除公开体检报告 HTML 获客页——该功能服务于官方云 SaaS 的
  // 传播裂变设想，在 D15 自建端形态下无获客目标，且无鉴权暴露统计、误导管理台用户。
  // JSON 数据端点保留（/api/v1/health-report，管理台概览数据源）。云端阶段如需落地页重新设计。

  // DEV-01：全局 /s/search 已关闭（曾可匿名搜全库，包括私密书签）。
  // 公开搜索必须携带站点标识：/s/:slug/search 且仅覆盖该站显式发布集合。
  root.get("/s/search", (c) => {
    return c.json(
      {
        error: "endpoint_removed",
        hint: "公开搜索请访问具体站点：/s/<slug>/search；全库搜索需要登录 /api/v1/search",
      },
      410,
    );
  });

  // ---------- Web 管理台静态托管（F6.2：单容器自带 Web 界面，打开服务端地址即是管理台） ----------
  const webDist = process.env.WEB_DIST_DIR ?? path.join(process.cwd(), "web-dist");
  const hasAdminUi = existsSync(path.join(webDist, "index.html"));
  if (hasAdminUi) {
    const ASSET_MIME: Record<string, string> = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".html": "text/html",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
    };
    // index.html 每请求读取（不缓存进内存）：dev 场景 web 构建产物更新后无需重启即生效
    root.get("/", (c) => c.html(readFileSync(path.join(webDist, "index.html"), "utf8")));
    // 静态目录白名单托管（2026-11-20 修复：此前只挂 /assets/*，/brand、/providers 全 404，
    // 顶栏品牌标与管理台供应商 logo 破图）：assets/ 带 hash 可长缓存，其余固定文件名短缓存
    const staticDirs = ["assets", "brand", "providers"] as const;
    for (const dir of staticDirs) {
      root.get(`/${dir}/*`, (c) => {
        const rel = c.req.path.replace(`/${dir}/`, "");
        // 防目录穿越
        const rootDir = path.resolve(webDist, dir);
        const file = path.resolve(rootDir, rel);
        if (!file.startsWith(rootDir + path.sep)) {
          return c.json({ error: "forbidden" }, 403);
        }
        try {
          const data = readFileSync(file);
          c.header("content-type", ASSET_MIME[path.extname(file)] ?? "application/octet-stream");
          c.header("cache-control", dir === "assets" ? "public, max-age=86400" : "public, max-age=300");
          return c.body(data);
        } catch {
          return c.json({ error: "not_found" }, 404);
        }
      });
    }
    root.get("/favicon.ico", (c) => c.body(null, 204));
  }

  // ---------- 导航站公开页（DEV-01：唯一实现路径；显式发布集合 + POST 密码凭证） ----------

  /** D67：公开站点路由到数据属主（云端 public_slugs 索引；自建恒 self 直查主库，行为不变） */
  const asSlugOwner = <T>(slug: string, fn: () => T): T => {
    const owner = registry.slugOwner(slug);
    return owner && owner !== SELF_USER_ID ? runAsUser(owner, fn) : fn();
  };

  /** 访问判定：站点已发布 且（无密码 或 持有效访问凭证——绑定 slug+revision） */
  const navAccessAllowed = (c: { req: { header: (n: string) => string | undefined } }, site: NonNullable<ReturnType<typeof store.getNavSiteFull>>): boolean => {
    if (site.published !== 1) return false;
    if (!site.password_hash) return true;
    const cookie = c.req.header("cookie") ?? "";
    const match = new RegExp(`(?:^|;\\s*)${NAV_ACCESS_COOKIE(site.slug)}=([^;]+)`).exec(cookie);
    return verifyNavAccess(store, registry, site.slug, site.revision, match?.[1] ? decodeURIComponent(match[1]) : undefined);
  };

  // 密码验证（POST）：独立于管理员登录的限速（key: nav:<slug>:<client>），
  // 成功签发短期 HttpOnly cookie；旧 ?p= 查询参数通道移除。
  root.post("/s/:slug/auth", async (c) => {
    const slug = c.req.param("slug");
    const site = asSlugOwner(slug, () => store.getNavSiteFull(slug));
    if (!site || site.published !== 1 || !site.password_hash) {
      return c.json({ error: "not_found" }, 404);
    }
    const bodyForm = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
    const password = typeof bodyForm.password === "string" ? bodyForm.password : "";
    const key = `nav:${site.slug}:${clientKeyOf(c)}`;
    if (!password || loginRateLimited(key) || !verifyPasswordHash(password, site.password_hash)) {
      if (password) recordLoginFailure(key);
      c.header("content-type", "text/html; charset=utf-8");
      c.header("cache-control", "no-store");
      c.header("referrer-policy", "no-referrer");
      return c.body(renderPasswordPage(site.title, site.slug, true), 401);
    }
    clearLoginFailures(key);
    const token = signNavAccess(store, registry, site.slug, site.revision);
    c.header("set-cookie", navAccessCookieHeader(site.slug, token, new URL(c.req.url).protocol === "https:"));
    c.header("cache-control", "no-store");
    return c.redirect(`/s/${site.slug}`, 303);
  });

  // 公开站首页（模板 + 密码凭证；未发布站点显示占位说明，不回退全库数据）
  root.get("/s/:slug", (c) =>
    asSlugOwner(c.req.param("slug"), () => {
      const site = store.getNavSiteFull(c.req.param("slug"));
      if (!site) return c.json({ error: "not_found" }, 404);
      c.header("cache-control", "no-store"); // 站点内容随发布范围变化，禁止中间缓存
      c.header("referrer-policy", "no-referrer");
      c.header("content-type", "text/html; charset=utf-8");
      if (site.published !== 1) {
        // DEV-01：存量站点缺少显式发布集合 → 待确认/不可公开（升级说明见 docs）
        return c.body(renderUnpublishedPage(site.title));
      }
      if (!navAccessAllowed(c, site)) {
        return c.body(renderPasswordPage(site.title, site.slug));
      }
      return c.body(
        renderNavHtml(navData(store, site.slug, site.title), {
          // 原型 13：水印自建端可关（D12 全功能开放）；主题色/显示选项/自定义卡走站点 config
          watermark: store.getNavSiteConfig(site.slug).watermark !== false,
          template: (site.template as NavTemplate) ?? "grid",
          config: store.getNavSiteConfig(site.slug) as { themeColor?: string; showSummary?: boolean; snapshotBadge?: boolean; customCards?: Array<{ title: string; url: string; desc?: string; favicon?: string }> },
        }),
      );
    }),
  );

  // 站内搜索（q 全量转义；仅该站显式发布集合；密码站需有效凭证）
  root.get("/s/:slug/search", (c) =>
    asSlugOwner(c.req.param("slug"), () => {
      const site = store.getNavSiteFull(c.req.param("slug"));
      if (!site || site.published !== 1) return c.json({ error: "not_found" }, 404);
      c.header("cache-control", "no-store");
      c.header("referrer-policy", "no-referrer");
      c.header("content-type", "text/html; charset=utf-8");
      if (!navAccessAllowed(c, site)) {
        return c.body(renderPasswordPage(site.title, site.slug));
      }
      const q = c.req.query("q") ?? "";
      const items = store
        .navSiteItems(site.slug)
        .filter((it) => it.title.toLowerCase().includes(q.toLowerCase()) || it.url_raw.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 50);
      return c.body(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${esc(q)} - 搜索结果</title>
<style>
  :root { --bg:#f7f7f8; --text:#222; --muted:#888; --card:#fff; --border:#e5e5e8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161618; --text:#eee; --muted:#999; --card:#222225; --border:#333; } }
  body { margin:0 auto; max-width:720px; padding:40px 24px; background:var(--bg); color:var(--text);
         font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  ul { list-style:none; padding:0; }
  li { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:12px 16px; margin:8px 0; }
  a { color:inherit; text-decoration:none; } a:hover { text-decoration:underline; }
  .back { color:var(--muted); font-size:13px; }
</style>
</head><body><h1>“${esc(q)}”的搜索结果</h1><ul>${items
          .map((r) => `<li><a href="${esc(r.url_raw)}">${esc(r.title)}</a></li>`)
          .join("")}</ul><p><a class="back" href="/s/${esc(site.slug)}">← 返回</a></p></body></html>`,
      );
    }),
  );

  root.route("/", api);
  return root;
}

/** DEV-01：未发布站点占位页（存量站点升级后待管理员确认发布） */
function renderUnpublishedPage(title: string): string {
  const esc = (v: string): string =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="font:15px/1.6 -apple-system,sans-serif;max-width:480px;margin:20vh auto;padding:0 24px;color:#333">
<h2>该站点暂未发布</h2><p>导航站升级后需要在管理台重新确认发布范围（书签/目录选择）后才会对外可见。这是 v0.4 的安全变更：公开内容不再默认全库。</p>
</body></html>`;
}
