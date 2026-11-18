/**
 * 全部路由（技术方案 §5）。buildApp 注入依赖便于测试（app.request 直调）。
 * M2/M3：鉴权、同步、维护周报、语义搜索、BYOK 配置、导航模板/密码、配额、私密书签、迁移回灌。
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import {
  ingestRequest,
  captureRequest,
  canonicalizeUrl,
  isPrivacyDomain,
  parseNetscapeBookmarks,
  exportNetscapeHtml,
} from "@mf/shared";
import type { LlmClient } from "@mf/ai/llm-client";
import { newId, now } from "./db";
import { Store, type BookmarkRow } from "./store";
import { Pipeline } from "./pipeline";
import { OrganizeService } from "./organize";
import { navData, renderNavHtml, renderPasswordPage, NAV_TEMPLATES, type NavTemplate } from "./nav";
import { login, mountAuth, authEnabled } from "./auth";
import {
  mountSecurity,
  adminSetup,
  loginWithDbHash,
  isProductionLike,
  setupRequired,
} from "./security";
import type { MaintenanceService } from "./maintenance";
import type { SemanticService } from "./semantic";
import { fetchGuardConfigFromEnv, guardedFetch } from "./fetch-guard";
import { buildSnapshotView } from "./snapshot-view";

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
}

// ---------- 密码哈希（scrypt，无外部依赖） ----------
export async function hashPassword(password: string): Promise<{ hash: string }> {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return { hash: `s1:${salt}:${hash}` };
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split(":");
  const version = parts[0];
  const salt = parts[1];
  const hash = parts[2];
  if (version !== "s1" || !salt || !hash) return false;
  return scryptSync(password, salt, 32).toString("hex") === hash;
}

export function buildApp(deps: AppDeps): Hono {
  const { store, llmFor, pipeline, organize, dataDir, semantic, maintenance, adminPassword } = deps;
  const esc = (v: string): string =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
  api.use(
    "*",
    cors({
      origin: (origin) => origin,
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "Idempotency-Key",
        "X-MF-Private",
        "X-MF-Device",
      ],
    }),
  );

  // ---------- 鉴权（F6.2 + A4-1 安全默认值） ----------
  // 环境变量密码模式：原逻辑；生产语义无密码：强制 setup 门槛（503）或 DB hash + token
  if (authEnabled(adminPassword)) {
    mountAuth(api, store, adminPassword);
  } else {
    mountSecurity(api, store, adminPassword);
    // 首启 setup（唯一免鉴权通道；仅一次）
    api.post("/admin/setup", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { password?: string };
      if (!body.password) return c.json({ error: "password_required" }, 400);
      const result = await adminSetup(store, body.password);
      if ("error" in result) return c.json({ error: result.error }, 400);
      return c.json(result);
    });
  }

  const privateVisible = (c: { req: { header: (n: string) => string | undefined } }): boolean =>
    c.req.header("x-mf-private") === "1";

  const listVisibleBookmarks = (
    c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } },
  ): BookmarkRow[] => {
    const rows = store.listBookmarks({
      folderId: c.req.query("folderId"),
      status: c.req.query("status"),
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
    for (const item of parsed.data.items) {
      const canon = canonicalizeUrl(item.url);
      if (!canon) {
        skippedInvalid++;
        continue;
      }
      if (batchSeen.has(canon.canonical) || store.findByCanonical(canon.canonical)) {
        skippedDuplicate++;
        continue;
      }
      batchSeen.add(canon.canonical);
      // 导入不进收件箱（AGENTS.md 红线 5）：直接落映射目录
      const folder = store.ensurePath(item.folderPath);
      store.createBookmark({
        folderId: folder.id,
        urlRaw: item.url,
        urlCanonical: canon.canonical,
        title: item.title,
        addedAt: item.addedAt,
      });
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

  api.get("/bookmarks", (c) => c.json(listVisibleBookmarks(c)));

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
      title: body.title ?? body.url,
    });
    return c.json({ ...bm, suggest }, 201);
  });

  api.patch("/bookmarks/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      folderId?: string;
      status?: string;
      pinned?: boolean;
      isPrivate?: boolean;
    };
    const bm = store.getBookmark(c.req.param("id"));
    if (!bm) return c.json({ error: "not_found" }, 404);
    store.updateBookmark(c.req.param("id"), {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.folderId !== undefined ? { folder_id: body.folderId } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned ? 1 : 0 } : {}),
      ...(body.isPrivate !== undefined ? { is_private: body.isPrivate ? 1 : 0 } : {}),
    });
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

  // ---------- F1.5 收件箱 ----------
  api.post("/inbox/setup", (c) => {
    const existing = store.inboxFolder();
    if (existing) return c.json(existing);
    const folder = store.createFolder("📥 自动整理", null, "user", true);
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

    // 已有映射 → 直接返回（重复事件幂等）
    const existingAppId = store.findAppBookmarkId(body.deviceId, body.browserBookmarkId);
    if (existingAppId && store.getBookmark(existingAppId)) {
      return c.json({ bookmarkId: existingAppId, mapped: true, duplicate: true });
    }
    // canonical 查重（扩展已收藏过 / 导入过）
    const byCanonical = store.findByCanonical(canon.canonical);
    const inbox = store.inboxFolder() ?? store.createFolder("📥 自动整理", null, "user", true);
    const bm =
      byCanonical ??
      store.createBookmark({
        folderId: inbox.id,
        urlRaw: body.url,
        urlCanonical: canon.canonical,
        title: body.title ?? body.url,
      });
    store.upsertIdentity({
      deviceId: body.deviceId,
      browserBookmarkId: body.browserBookmarkId,
      appBookmarkId: bm.id,
    });
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
    store.completeBrowserOp(id, body.status, body.error);
    return c.json({ ok: true });
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
    const result = await pipeline.processInbox(ids, inbox.id);
    // A2-4 镜像模式（D20）：应用库归位后，为触发设备排浏览器节点移动操作。
    // 不与 DB 事务共用（浏览器外部状态），走持久待执行队列，扩展拉取后执行。
    if (body.deviceId) {
      for (const mv of result.moved) {
        for (const ident of store.identitiesForApp(mv.id)) {
          if (ident.device_id !== body.deviceId) continue;
          const target = store.findFolderByName(mv.to);
          if (!target) continue;
          // 浏览器侧目标目录节点：按「分类名」在映射表里找该设备的节点（扩展端 ensureMirrorFolder 维护）
          store.enqueueBrowserOpIdempotent({
            deviceId: ident.device_id,
            op: "move",
            browserBookmarkId: ident.browser_bookmark_id,
            targetBrowserParentId: `mf-folder:${target.name}`,
            payload: { folderName: target.name, appFolderId: target.id },
          });
        }
      }
    }
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
      urlForPrivacyCheck: bm.url_canonical,
    });
    void semantic.embedBookmark(bm.id); // 语义索引（fire-and-forget）
    return c.json(result);
  });

  api.get("/content/:bookmarkId", (c) => {
    const cache = store.getCache(c.req.param("bookmarkId"));
    if (!cache) return c.json({ error: "not_found" }, 404);
    return c.json(cache);
  });

  // ---------- F2.2 服务端补漏抓取 ----------
  api.post("/crawl/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
    const targets = body.ids?.length
      ? body.ids.map((id) => store.getBookmark(id)).filter((b) => b !== undefined)
      : store.bookmarksMissingContent(10);
    const guardConfig = fetchGuardConfigFromEnv();
    const results: Array<{ id: string; ok: boolean; reason?: string }> = [];
    for (const bm of targets) {
      if (!bm) continue;
      // A1-3 服务端纵深校验：隐私域/私密书签禁止抓取（独立判定，不信任任何客户端声明）
      const decision = pipeline.serverDecide("server_fetch", bm.url_canonical, {
        isPrivateBookmark: bm.is_private === 1,
      });
      if (!decision.allowed) {
        store.upsertCache({
          bookmarkId: bm.id,
          fetchedVia: "server_crawl",
          failReason: `privacy_${decision.reason}`,
        });
        results.push({ id: bm.id, ok: false, reason: "privacy" });
        continue;
      }
      try {
        // A1-4 网络访问策略：私网/回环/链路本地禁止（自建显式开启才放行）；每跳重定向重新校验
        const res = await guardedFetch(bm.url_canonical, guardConfig, {
          headers: {
            "user-agent": "my-favorites-bot/0.1 (+https://github.com/easeyeah/my-favorites)",
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = (await res.text()).slice(0, 500_000);
        const description =
          /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
          /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1];
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 20_000);
        store.upsertCache({
          bookmarkId: bm.id,
          l2Text: text || null,
          fetchedVia: "server_crawl",
        });
        if (description && !bm.description) {
          store.updateBookmark(bm.id, { description: description.slice(0, 500) });
        }
        await pipeline.maybeSummarize(bm.id);
        void semantic.embedBookmark(bm.id);
        results.push({ id: bm.id, ok: true });
      } catch (err) {
        store.upsertCache({
          bookmarkId: bm.id,
          fetchedVia: "server_crawl",
          failReason: `crawl_failed:${String(err).slice(0, 120)}`,
        });
        results.push({ id: bm.id, ok: false, reason: "crawl_failed" });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return c.json({ processed: results.length, results });
  });

  // ---------- F3 聊天整理 ----------
  api.post("/organize/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };
    if (!body.message) return c.json({ error: "message_required" }, 400);
    const result = await organize.handleMessage(body.message);
    return c.json(result, 201);
  });

  api.post("/organize/sessions/:id/apply", (c) => {
    try {
      const result = organize.apply(c.req.param("id"));
      // F3.8 偏好记忆：记录采纳的目录迁移
      const session = store.db
        .prepare("SELECT proposal FROM organize_session WHERE id = ?")
        .get(c.req.param("id")) as { proposal: string | null } | undefined;
      if (session?.proposal) {
        const proposal = JSON.parse(session.proposal) as Array<{ type: string; toFolder?: string }>;
        for (const a of proposal) {
          if (a.type === "move" && a.toFolder) store.recordCategoryAdoption(a.toFolder);
        }
      }
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  api.post("/organize/rollback/:versionId", (c) => {
    try {
      return c.json(organize.rollback(c.req.param("versionId")));
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // ---------- F7 搜索（全文 + 语义） ----------
  api.get("/search", async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ results: [] });
    if (c.req.query("semantic") === "1") {
      const rows = await semantic.search(q);
      return c.json({ results: rows, mode: "semantic" });
    }
    return c.json({ results: store.search(q), mode: "fulltext" });
  });

  // ---------- F4 导航站（模板/发布/密码） ----------
  api.get("/nav/data", (c) => c.json(navData(store)));
  api.get("/nav/sites", (c) => c.json(store.navSites()));

  api.post("/nav/publish", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      template?: string;
      password?: string;
    };
    const slug = Math.random().toString(36).slice(2, 10); // 随机不可枚举（D5）
    const template = NAV_TEMPLATES.includes(body.template as NavTemplate)
      ? (body.template as NavTemplate)
      : "grid";
    store.saveNavSite(slug, body.title ?? "我的导航");
    const passwordHash = body.password ? (await hashPassword(body.password)).hash : null;
    store.db
      .prepare("UPDATE nav_site SET template = ?, password_hash = ? WHERE slug = ?")
      .run(template, passwordHash, slug);
    return c.json({ slug, url: `/s/${slug}`, template }, 201);
  });

  api.patch("/nav/sites/:slug", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      template?: string;
      password?: string | null;
    };
    const site = store.getNavSiteFull(c.req.param("slug"));
    if (!site) return c.json({ error: "not_found" }, 404);
    const passwordHash =
      body.password === null ? null : body.password ? (await hashPassword(body.password)).hash : undefined;
    store.updateNavSite(c.req.param("slug"), {
      ...(body.title ? { title: body.title } : {}),
      ...(body.template && NAV_TEMPLATES.includes(body.template as NavTemplate)
        ? { template: body.template }
        : {}),
      ...(passwordHash !== undefined ? { passwordHash } : {}),
    });
    return c.json(store.getNavSiteFull(c.req.param("slug")));
  });

  api.get("/s/search", (c) => {
    const q = c.req.query("q") ?? "";
    const results = store.search(q, 20);
    c.header("content-type", "text/html; charset=utf-8");
    return c.body(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(q)} - 搜索结果</title>
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
</head><body><h1>“${esc(q)}”的搜索结果</h1><ul>${results
        .map((r) => `<li><a href="${esc(r.url_raw)}">${esc(r.title)}</a></li>`)
        .join("")}</ul><p><a class="back" href="javascript:history.back()">← 返回</a></p></body></html>`,
    );
  });

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

  api.get("/snapshots/:id", (c) => {
    const row = store.db
      .prepare("SELECT * FROM snapshot WHERE id = ?")
      .get(c.req.param("id")) as
      | { id: string; path: string; size: number; format: string }
      | undefined;
    if (!row) return c.json({ error: "not_found" }, 404);
    try {
      const data = readFileSync(row.path);
      c.header("content-type", "message/rfc822");
      return c.body(data);
    } catch {
      return c.json({ error: "file_missing" }, 500);
    }
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
    return c.json(store.pullChanges(cursor, device));
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

  api.get("/settings/prefs", (c) =>
    c.json({
      topCategories: store.topCategories(),
      adoption: store.getPref("category_adoption") ?? {},
    }),
  );

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
      "diff_accepted",
      "nav_generated",
      "ntp_enabled",
      "inbox_auto_sorted",
      "snapshot_created",
      "weekly_report_clicked",
    ];
    return c.json(Object.fromEntries(names.map((n) => [n, store.countEvents(n)])));
  });

  // ---------- 令牌管理（A4-1：可撤销、可失效） ----------
  api.get("/auth/tokens", (c) => {
    const rows = store.db
      .prepare("SELECT token, label, created_at FROM tokens ORDER BY created_at DESC")
      .all() as unknown as Array<{ token: string; label: string | null; created_at: string }>;
    return c.json({
      tokens: rows.map((r) => ({ ...r, token: `${r.token.slice(0, 8)}…` })), // 脱敏展示
    });
  });

  api.delete("/auth/tokens/:token", (c) => {
    const token = c.req.param("token");
    store.db.prepare("DELETE FROM tokens WHERE token = ?").run(token);
    return c.json({ revoked: true });
  });

  api.post("/auth/logout", (c) => {
    // 撤销当前请求使用的 token
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token) store.db.prepare("DELETE FROM tokens WHERE token = ?").run(token);
    return c.json({ loggedOut: true });
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
  root.get("/healthz", (c) =>
    c.json({
      ok: true,
      form: process.env.MF_FORM ?? "self-hosted",
      version: process.env.MF_VERSION ?? "0.1.0",
    }),
  );

  // F6.2/A4-1 登录（环境变量密码或 DB hash；均带速率限制）
  root.post("/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { password?: string; label?: string };
    if (!body.password) return c.json({ error: "password_required" }, 400);
    // 环境变量模式（兼容既有部署）
    if (authEnabled(adminPassword)) {
      const result = login(store, adminPassword, body.password, body.label ?? "device");
      if ("error" in result) {
        return c.json(result, result.error === "auth_disabled" ? 400 : 401);
      }
      return c.json(result);
    }
    // A4-1 DB hash 模式（生产语义首启 setup 后）
    if (isProductionLike() && !setupRequired(store)) {
      const clientKey = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
      const result = loginWithDbHash(store, body.password, body.label ?? "device", clientKey);
      if ("status" in result) {
        const status = result.status as 401 | 429;
        return c.json({ error: result.error }, status);
      }
      return c.json(result);
    }
    return c.json({ error: "auth_disabled" }, 400);
  });

  // 体检报告页（获客钩子：可分享）
  root.get("/health-report", (c) => {
    const report = maintenance.healthReport();
    c.header("content-type", "text/html; charset=utf-8");
    return c.body(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>书签体检报告</title>
<style>:root{--bg:#f7f7f8;--text:#222;--muted:#888;--card:#fff;--border:#e5e5e8}
@media (prefers-color-scheme: dark){:root{--bg:#161618;--text:#eee;--muted:#999;--card:#222225;--border:#333}}
body{margin:0 auto;max-width:560px;padding:40px 24px;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,"PingFang SC",sans-serif}
.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:24px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;text-align:center}
.num{font-size:28px;font-weight:700}.bad{color:#e5484d}.ok{color:#30a46c}
footer{margin-top:28px;text-align:center;color:var(--muted);font-size:12px}</style></head>
<body><h1>📊 书签体检报告</h1>
<div class="cards">
<div class="card"><div class="num ${report.dead > 0 ? "bad" : "ok"}">${report.dead}</div><div style="color:var(--muted)">死链</div></div>
<div class="card"><div class="num ${report.suspect > 0 ? "bad" : "ok"}">${report.suspect}</div><div style="color:var(--muted)">疑似失效</div></div>
<div class="card"><div class="num ${report.duplicates > 0 ? "bad" : "ok"}">${report.duplicates}</div><div style="color:var(--muted)">重复组</div></div>
<div class="card"><div class="num">${report.stale}</div><div style="color:var(--muted)">久未整理</div></div>
</div>
<footer>⚡ 由 <a href="https://github.com/easeyeah/my-favorites">my-favorites</a> 体检生成</footer></body></html>`,
    );
  });

  // 导航站搜索落地页（P0 XSS 修复版：q 全量转义）
  root.get("/s/search", (c) => {
    const q = c.req.query("q") ?? "";
    const results = store.search(q, 20);
    c.header("content-type", "text/html; charset=utf-8");
    return c.body(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(q)} - 搜索结果</title>
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
</head><body><h1>“${esc(q)}”的搜索结果</h1><ul>${results
        .map((r) => `<li><a href="${esc(r.url_raw)}">${esc(r.title)}</a></li>`)
        .join("")}</ul><p><a class="back" href="javascript:history.back()">← 返回</a></p></body></html>`,
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
    root.get("/assets/*", (c) => {
      const rel = c.req.path.replace(/^\/assets\//, "");
      // 防目录穿越
      const file = path.resolve(webDist, "assets", rel);
      if (!file.startsWith(path.resolve(webDist, "assets"))) {
        return c.json({ error: "forbidden" }, 403);
      }
      try {
        const data = readFileSync(file);
        c.header("content-type", ASSET_MIME[path.extname(file)] ?? "application/octet-stream");
        c.header("cache-control", "public, max-age=86400"); // 带 hash 的产物可长缓存
        return c.body(data);
      } catch {
        return c.json({ error: "not_found" }, 404);
      }
    });
    root.get("/favicon.ico", (c) => c.body(null, 204));
  }

  // 导航站公开页（模板 + 密码）
  root.get("/s/:slug", (c) => {
    const site = store.getNavSiteFull(c.req.param("slug"));
    if (!site) return c.json({ error: "not_found" }, 404);
    if (site.password_hash) {
      const p = c.req.query("p") ?? "";
      if (!p || !verifyPasswordHash(p, site.password_hash)) {
        c.header("content-type", "text/html; charset=utf-8");
        return c.body(renderPasswordPage(site.title));
      }
    }
    c.header("content-type", "text/html; charset=utf-8");
    return c.body(
      renderNavHtml(navData(store, site.title), {
        watermark: true,
        template: (site.template as NavTemplate) ?? "grid",
      }),
    );
  });

  root.get("/s/:slug", (c) => {
    const site = store.getNavSiteFull(c.req.param("slug"));
    if (!site) return c.json({ error: "not_found" }, 404);
    if (site.password_hash) {
      const p = c.req.query("p") ?? "";
      if (!p || !verifyPasswordHash(p, site.password_hash)) {
        c.header("content-type", "text/html; charset=utf-8");
        return c.body(renderPasswordPage(site.title));
      }
    }
    c.header("content-type", "text/html; charset=utf-8");
    return c.body(
      renderNavHtml(navData(store, site.title), {
        watermark: true,
        template: (site.template as NavTemplate) ?? "grid",
      }),
    );
  });

  root.route("/", api);
  return root;
}
