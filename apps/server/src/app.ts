/**
 * 全部路由（技术方案 §5）。buildApp 注入依赖便于测试（app.request 直调）。
 * M2/M3：鉴权、同步、维护周报、语义搜索、BYOK 配置、导航模板/密码、配额、私密书签、迁移回灌。
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import {
  ingestRequest,
  captureRequest,
  canonicalizeUrl,
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
import type { MaintenanceService } from "./maintenance";
import type { SemanticService } from "./semantic";

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
  api.use(logger());
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

  // ---------- 鉴权（F6.2，设置 ADMIN_PASSWORD 后启用） ----------
  mountAuth(api, store, adminPassword);

  const privateVisible = (c: { req: { header: (n: string) => string | undefined } }): boolean =>
    c.req.header("x-mf-private") === "1";

  const listVisibleBookmarks = (
    c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } },
  ): BookmarkRow[] => {
    const rows = store.listBookmarks({
      folderId: c.req.query("folderId"),
      status: c.req.query("status"),
      limit: c.req.query("limit") ? Math.min(Number(c.req.query("limit")), 1000) : undefined,
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

  api.post("/inbox/process", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { bookmarkIds?: string[] };
    const inbox = store.inboxFolder();
    if (!inbox) return c.json({ error: "inbox_not_setup" }, 400);
    const ids = body.bookmarkIds ?? [];
    if (ids.length === 0) {
      for (const bm of store.listBookmarks({ folderId: inbox.id, limit: 100 })) {
        ids.push(bm.id);
      }
    }
    const result = await pipeline.processInbox(ids, inbox.id);
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
    const results: Array<{ id: string; ok: boolean; reason?: string }> = [];
    for (const bm of targets) {
      if (!bm) continue;
      if (bm.is_private || pipeline.privacyCheck(bm.url_canonical)) {
        store.upsertCache({
          bookmarkId: bm.id,
          fetchedVia: "server_crawl",
          failReason: "privacy_domain_skipped",
        });
        results.push({ id: bm.id, ok: false, reason: "privacy_domain" });
        continue;
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const res = await fetch(bm.url_canonical, {
          signal: controller.signal,
          redirect: "follow",
          headers: {
            "user-agent": "my-favorites-bot/0.1 (+https://github.com/easeyeah/my-favorites)",
          },
        });
        clearTimeout(timer);
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
    if (!bookmarkId || !store.getBookmark(bookmarkId)) {
      return c.json({ error: "bookmark_not_found" }, 404);
    }
    const buf = await c.req.arrayBuffer();
    if (!buf || buf.byteLength === 0) return c.json({ error: "empty_body" }, 400);
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
    const id = store.saveProviderConfig({
      id: body.id,
      providerId: body.providerId,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey ?? null,
      purposeModels: body.purposeModels ?? {},
      enabled: body.enabled,
    });
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

  // F6.2 登录（自建管理员密码 → token）
  root.post("/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { password?: string; label?: string };
    if (!body.password) return c.json({ error: "password_required" }, 400);
    const result = login(store, adminPassword, body.password, body.label ?? "device");
    if ("error" in result) {
      return c.json(result, authEnabled(adminPassword) ? 401 : 400);
    }
    return c.json(result);
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
