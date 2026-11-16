/**
 * 全部路由（技术方案 §5）。buildApp 注入依赖便于测试（app.request 直调）。
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ingestRequest,
  captureRequest,
  canonicalizeUrl,
  parseNetscapeBookmarks,
  exportNetscapeHtml,
} from "@mf/shared";
import type { LlmClient } from "@mf/ai/llm-client";
import { newId } from "./db";
import { Store } from "./store";
import { Pipeline } from "./pipeline";
import { OrganizeService } from "./organize";
import { navData, renderNavHtml } from "./nav";

export interface AppDeps {
  store: Store;
  llm: LlmClient | null;
  dataDir: string;
  pipeline: Pipeline;
  organize: OrganizeService;
}

export function buildApp(deps: AppDeps): Hono {
  const { store, llm, pipeline, organize, dataDir } = deps;
  const api = new Hono().basePath("/api/v1");

  api.use(logger());
  api.use(
    "*",
    cors({
      origin: (origin) => origin,
      allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    }),
  );
  const app = api;

  // ---------- F1.1 导入（幂等 + 去重 + 目录树映射） ----------
  app.post("/bookmarks/ingest", async (c) => {
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
    const batchSeen = new Set<string>();
    for (const item of parsed.data.items) {
      const canon = canonicalizeUrl(item.url);
      if (!canon) {
        skippedDuplicate++;
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
      total: parsed.data.items.length,
    };
    store.saveIdempotent(key, result);
    return c.json(result);
  });

  // Netscape HTML 文件导入
  app.post("/bookmarks/ingest/html", async (c) => {
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

  // ---------- F1.6 导出（数据可迁移承诺） ----------
  app.get("/export/json", (c) => {
    const folders = store.listFolders();
    const bookmarks = store.listBookmarks({ limit: 10000 });
    return c.json({
      exported_at: new Date().toISOString(),
      folders,
      bookmarks,
      caches: bookmarks.map((b) => store.getCache(b.id)).filter(Boolean),
    });
  });

  app.get("/export/html", (c) => {
    const folders = store.listFolders();
    const folderName = (id: string) =>
      folders.find((f) => f.id === id)?.name ?? "未整理";
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
  app.get("/folders", (c) => c.json(store.listFolders()));
  app.post("/folders", async (c) => {
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

  app.get("/bookmarks", (c) => {
    const q = c.req.query();
    return c.json(
      store.listBookmarks({
        folderId: q.folderId,
        status: q.status,
        limit: q.limit ? Math.min(Number(q.limit), 1000) : undefined,
      }),
    );
  });

  app.get("/bookmarks/:id", (c) => {
    const bm = store.getBookmark(c.req.param("id"));
    if (!bm) return c.json({ error: "not_found" }, 404);
    return c.json({ ...bm, cache: store.getCache(bm.id) ?? null });
  });

  app.post("/bookmarks", async (c) => {
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
    // folderId 必须真实存在（否则外键 500）；无效则回退到建议/未整理
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

  app.patch("/bookmarks/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      folderId?: string;
      status?: string;
      pinned?: boolean;
    };
    const bm = store.getBookmark(c.req.param("id"));
    if (!bm) return c.json({ error: "not_found" }, 404);
    store.updateBookmark(c.req.param("id"), {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.folderId !== undefined ? { folder_id: body.folderId } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned ? 1 : 0 } : {}),
    });
    return c.json(store.getBookmark(c.req.param("id")));
  });

  app.delete("/bookmarks/:id", (c) => {
    // 删除由用户显式发起（红线 3：AI 只出建议清单，不自动删除）
    const deleted = store.deleteBookmark(c.req.param("id"));
    if (!deleted) return c.json({ error: "not_found" }, 404);
    return c.json({ deleted: deleted.id });
  });

  // ---------- F1.4 即时归位建议 ----------
  app.post("/bookmarks/suggest", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: string;
      title?: string;
    };
    if (!body.url) return c.json({ error: "url_required" }, 400);
    return c.json(pipeline.suggest(body.url, body.title ?? ""));
  });

  // ---------- F1.5 收件箱 ----------
  app.post("/inbox/setup", (c) => {
    const existing = store.inboxFolder();
    if (existing) return c.json(existing);
    const folder = store.createFolder("📥 自动整理", null, "user", true);
    return c.json(folder, 201);
  });

  app.post("/inbox/process", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { bookmarkIds?: string[] };
    const inbox = store.inboxFolder();
    if (!inbox) return c.json({ error: "inbox_not_setup" }, 400);
    const ids = body.bookmarkIds ?? [];
    if (ids.length === 0) {
      // 未指定则处理收件箱内全部
      for (const bm of store.listBookmarks({ folderId: inbox.id, limit: 100 })) {
        ids.push(bm.id);
      }
    }
    const result = await pipeline.processInbox(ids, inbox.id);
    return c.json(result);
  });

  // ---------- F2.1 内容捕获上行 ----------
  app.post("/content/capture", async (c) => {
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
    return c.json(result);
  });

  app.get("/content/:bookmarkId", (c) => {
    const cache = store.getCache(c.req.param("bookmarkId"));
    if (!cache) return c.json({ error: "not_found" }, 404);
    return c.json(cache);
  });

  // ---------- F2.2 服务端补漏抓取（礼貌抓取：串行限速 500ms） ----------
  app.post("/crawl/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
    const targets = body.ids?.length
      ? body.ids.map((id) => store.getBookmark(id)).filter((b) => b !== undefined)
      : store.bookmarksMissingContent(10);
    const results: Array<{ id: string; ok: boolean; reason?: string }> = [];
    for (const bm of targets) {
      if (!bm) continue;
      if (pipeline.privacyCheck(bm.url_canonical)) {
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
          headers: { "user-agent": "my-favorites-bot/0.1 (+https://github.com/easeyeah/my-favorites)" },
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = (await res.text()).slice(0, 500_000);
        const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
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
  app.post("/organize/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };
    if (!body.message) return c.json({ error: "message_required" }, 400);
    const result = await organize.handleMessage(body.message);
    return c.json(result, 201);
  });

  app.post("/organize/sessions/:id/apply", (c) => {
    try {
      return c.json(organize.apply(c.req.param("id")));
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.post("/organize/rollback/:versionId", (c) => {
    try {
      return c.json(organize.rollback(c.req.param("versionId")));
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // ---------- F7 搜索 ----------
  app.get("/search", (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ results: [] });
    return c.json({ results: store.search(q) });
  });

  // ---------- F4 导航站 ----------
  app.get("/nav/data", (c) => c.json(navData(store)));

  app.post("/nav/publish", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    const slug = Math.random().toString(36).slice(2, 10); // 随机不可枚举（D5）
    store.saveNavSite(slug, body.title ?? "我的导航");
    return c.json({ slug, url: `/s/${slug}` }, 201);
  });

  // 注意：/s/* 是公开页，必须在根路径；见下方 root 挂载
  // ---------- F2.4 快照 ----------
  app.post("/snapshots", async (c) => {
    const bookmarkId = c.req.query("bookmarkId");
    if (!bookmarkId || !store.getBookmark(bookmarkId)) {
      return c.json({ error: "bookmark_not_found" }, 404);
    }
    const buf = await c.req.arrayBuffer();
    if (!buf || buf.byteLength === 0) return c.json({ error: "empty_body" }, 400);
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
    return c.json({ id, size: buf.byteLength }, 201);
  });

  app.get("/snapshots/:id", (c) => {
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

  // ---------- 埋点（8+1 事件批量上报） ----------
  app.post("/analytics/events", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      events?: Array<{ name: string; props?: unknown }>;
    };
    if (!Array.isArray(body.events)) return c.json({ error: "invalid_request" }, 400);
    const recorded = store.recordEvents(body.events);
    return c.json({ recorded });
  });

  app.get("/analytics/summary", (c) => {
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

  // ---------- 维护（M1 提供 stats，死链任务 M2） ----------
  app.get("/stats", (c) => {
    const stats = store.countBookmarks();
    const folders = store.listFolders().length;
    return c.json({ ...stats, folders });
  });

  // ---------- 公开页与根级健康检查（必须挂在根路径，app 带 /api/v1 前缀） ----------
  const root = new Hono();
  root.get("/healthz", (c) =>
    c.json({
      ok: true,
      form: process.env.MF_FORM ?? "self-hosted",
      version: process.env.MF_VERSION ?? "0.1.0",
    }),
  );
  root.get("/s/search", (c) => {
    const q = c.req.query("q") ?? "";
    // P0 修复：q 反射进 HTML，必须转义（review 发现的反射型 XSS）
    const esc = (v: string): string =>
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  root.get("/s/:slug", (c) => {
    const site = store.getNavSite(c.req.param("slug"));
    if (!site) return c.json({ error: "not_found" }, 404);
    c.header("content-type", "text/html; charset=utf-8");
    return c.body(renderNavHtml(navData(store, site.title), { watermark: true }));
  });
  root.route("/", app);
  return root;
}
