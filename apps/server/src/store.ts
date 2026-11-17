/** 仓储层 —— 全部 SQL 集中在此，路由不直接摸 SQL */
import { canonicalizeUrl } from "@mf/shared";
import type { Db } from "./db";
import { newId, now } from "./db";

export interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  sort: number;
  source: string;
  is_system_inbox: number;
  created_at: string;
}

export interface BookmarkRow {
  id: string;
  folder_id: string;
  url_raw: string;
  url_canonical: string;
  title: string;
  description: string | null;
  status: string;
  favicon_url: string | null;
  cover_url: string | null;
  added_at: string;
  last_checked_at: string | null;
  pinned: number;
  is_private: number;
  created_at: string;
}

export class Store {
  constructor(readonly db: Db) {}

  // ---------- folders ----------
  listFolders(): FolderRow[] {
    return this.db
      .prepare("SELECT * FROM folders ORDER BY sort, name")
      .all() as unknown as FolderRow[];
  }

  getFolder(id: string): FolderRow | undefined {
    return this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as
      | FolderRow
      | undefined;
  }

  findFolderByName(name: string): FolderRow | undefined {
    return this.db
      .prepare("SELECT * FROM folders WHERE name = ? ORDER BY sort LIMIT 1")
      .get(name) as FolderRow | undefined;
  }

  createFolder(
    name: string,
    parentId: string | null,
    source = "user",
    isSystemInbox = false,
  ): FolderRow {
    const row: FolderRow = {
      id: newId(),
      parent_id: parentId,
      name,
      sort: Date.now() % 1e9,
      source,
      is_system_inbox: isSystemInbox ? 1 : 0,
      created_at: now(),
    };
    this.db
      .prepare(
        "INSERT INTO folders (id, parent_id, name, sort, source, is_system_inbox, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.parent_id,
        row.name,
        row.sort,
        row.source,
        row.is_system_inbox,
        row.created_at,
      );
      this.recordChange("folder", row.id, "upsert", { id: row.id, name: row.name, parent_id: row.parent_id });
    return row;
  }

  /** 沿 folderPath 逐级 find-or-create（ingest 的目录树映射） */
  ensurePath(path: string[]): FolderRow {
    let parentId: string | null = null;
    let current: FolderRow | null = null;
    for (const name of path) {
      const stmt = current
        ? this.db.prepare(
            "SELECT * FROM folders WHERE name = ? AND parent_id = ? LIMIT 1",
          )
        : this.db.prepare(
            "SELECT * FROM folders WHERE name = ? AND parent_id IS NULL LIMIT 1",
          );
      const found = (
        current ? stmt.get(name, current.id) : stmt.get(name)
      ) as FolderRow | undefined;
      current = found ?? this.createFolder(name, parentId, "imported");
      parentId = current.id;
    }
    // path 为空时落到根下的"未整理"
    return current ?? this.ensurePath(["未整理"]);
  }

  inboxFolder(): FolderRow | undefined {
    return this.db
      .prepare("SELECT * FROM folders WHERE is_system_inbox = 1 LIMIT 1")
      .get() as FolderRow | undefined;
  }

  deleteFolderIfEmpty(id: string): boolean {
    const hasChildren = this.db
      .prepare("SELECT 1 FROM folders WHERE parent_id = ? LIMIT 1")
      .get(id);
    const hasBookmarks = this.db
      .prepare("SELECT 1 FROM bookmarks WHERE folder_id = ? LIMIT 1")
      .get(id);
    if (hasChildren || hasBookmarks) return false;
    this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
    this.recordChange("folder", id, "delete", { id });
    return true;
  }

  // ---------- bookmarks ----------
  getBookmark(id: string): BookmarkRow | undefined {
    return this.db.prepare("SELECT * FROM bookmarks WHERE id = ?").get(id) as
      | BookmarkRow
      | undefined;
  }

  findByCanonical(urlCanonical: string): BookmarkRow | undefined {
    return this.db
      .prepare("SELECT * FROM bookmarks WHERE url_canonical = ?")
      .get(urlCanonical) as BookmarkRow | undefined;
  }

  createBookmark(input: {
    folderId: string;
    urlRaw: string;
    urlCanonical: string;
    title: string;
    description?: string | null;
    faviconUrl?: string | null;
    addedAt?: string;
  }): BookmarkRow {
    const row: BookmarkRow = {
      id: newId(),
      folder_id: input.folderId,
      url_raw: input.urlRaw,
      url_canonical: input.urlCanonical,
      title: input.title,
      description: input.description ?? null,
      status: "normal",
      favicon_url: input.faviconUrl ?? null,
      cover_url: null,
      added_at: input.addedAt ?? now(),
      last_checked_at: null,
      pinned: 0,
      is_private: 0,
      created_at: now(),
    };
    this.db
      .prepare(
        "INSERT INTO bookmarks (id, folder_id, url_raw, url_canonical, title, description, status, favicon_url, cover_url, added_at, last_checked_at, pinned, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.folder_id,
        row.url_raw,
        row.url_canonical,
        row.title,
        row.description,
        row.status,
        row.favicon_url,
        row.cover_url,
        row.added_at,
        row.last_checked_at,
        row.pinned,
        row.created_at,
      );
      this.recordChange("bookmark", row.id, "upsert", row);
    return row;
  }

  updateBookmark(id: string, fields: Partial<BookmarkRow>): void {
    const keys = Object.keys(fields).filter(
      (k) => k !== "id" && fields[k as keyof BookmarkRow] !== undefined,
    );
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(", ");
    const vals = keys.map(
      (k) => fields[k as keyof BookmarkRow] as string | number | null,
    );
    this.db
      .prepare(`UPDATE bookmarks SET ${set} WHERE id = ?`)
      .run(...vals, id);
  }

  moveBookmark(id: string, toFolderId: string): BookmarkRow | undefined {
    const before = this.getBookmark(id);
    if (!before) return undefined;
    this.updateBookmark(id, { folder_id: toFolderId });
    const after = this.getBookmark(id);
    this.recordChange("bookmark", id, "move", { from: before.folder_id, to: toFolderId, url: after?.url_canonical, title: after?.title });
    return before;
  }

  deleteBookmark(id: string): BookmarkRow | undefined {
    const before = this.getBookmark(id);
    if (!before) return undefined;
    this.db.prepare("DELETE FROM content_cache WHERE bookmark_id = ?").run(id);
    this.db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
    this.recordChange("bookmark", id, "delete", { url: before.url_canonical, title: before.title, folder_id: before.folder_id });
    return before;
  }

  listBookmarks(filter?: {
    folderId?: string;
    status?: string;
    limit?: number;
  }): BookmarkRow[] {
    const conds: string[] = [];
    const args: (string | number)[] = [];
    if (filter?.folderId) {
      conds.push("folder_id = ?");
      args.push(filter.folderId);
    }
    if (filter?.status) {
      conds.push("status = ?");
      args.push(filter.status);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const limit = filter?.limit ?? 1000;
    return this.db
      .prepare(
        `SELECT * FROM bookmarks ${where} ORDER BY pinned DESC, added_at DESC LIMIT ${limit}`,
      )
      .all(...args) as unknown as BookmarkRow[];
  }

  search(q: string, limit = 50): BookmarkRow[] {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    return this.db
      .prepare(
        `SELECT DISTINCT b.* FROM bookmarks b
         LEFT JOIN content_cache c ON c.bookmark_id = b.id
         WHERE b.title LIKE ? OR b.url_canonical LIKE ? OR IFNULL(b.description,'') LIKE ? OR IFNULL(c.l2_text,'') LIKE ?
         LIMIT ?`,
      )
      .all(like, like, like, like, limit) as unknown as BookmarkRow[];
  }

  countBookmarks(): { total: number; dead: number; suspect: number } {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as total, SUM(status='dead') as dead, SUM(status='suspect') as suspect FROM bookmarks",
      )
      .get() as { total: number; dead: number | null; suspect: number | null };
    return { total: row.total, dead: row.dead ?? 0, suspect: row.suspect ?? 0 };
  }

  // ---------- content_cache ----------
  upsertCache(input: {
    bookmarkId: string;
    l1Summary?: string | null;
    l1Tags?: string[];
    keywords?: string[];
    l2Text?: string | null;
    lang?: string | null;
    fetchedVia: string;
    failReason?: string | null;
  }): void {
    this.db
      .prepare(
        "INSERT INTO content_cache (bookmark_id, l1_summary, l1_tags, keywords, l2_text, lang, fetched_via, fetched_at, fail_reason) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(bookmark_id) DO UPDATE SET l1_summary=COALESCE(excluded.l1_summary, l1_summary), l1_tags=COALESCE(excluded.l1_tags, l1_tags), keywords=COALESCE(excluded.keywords, keywords), l2_text=COALESCE(excluded.l2_text, l2_text), lang=COALESCE(excluded.lang, lang), fetched_via=excluded.fetched_via, fetched_at=excluded.fetched_at, fail_reason=excluded.fail_reason",
      )
      .run(
        input.bookmarkId,
        input.l1Summary ?? null,
        JSON.stringify(input.l1Tags ?? []),
        JSON.stringify(input.keywords ?? []),
        input.l2Text ?? null,
        input.lang ?? null,
        input.fetchedVia,
        now(),
        input.failReason ?? null,
      );
  }

  getCache(bookmarkId: string): Record<string, unknown> | undefined {
    const row = this.db
      .prepare("SELECT * FROM content_cache WHERE bookmark_id = ?")
      .get(bookmarkId) as Record<string, unknown> | undefined;
    if (row) {
      row.l1_tags = JSON.parse((row.l1_tags as string) ?? "[]");
      row.keywords = JSON.parse((row.keywords as string) ?? "[]");
    }
    return row;
  }

  bookmarksMissingContent(limit = 20): BookmarkRow[] {
    return this.db
      .prepare(
        `SELECT b.* FROM bookmarks b LEFT JOIN content_cache c ON c.bookmark_id = b.id
         WHERE c.bookmark_id IS NULL AND b.status = 'normal' LIMIT ?`,
      )
      .all(limit) as unknown as BookmarkRow[];
  }

  // ---------- domain_cache ----------
  lookupDomain(domain: string): string | undefined {
    const row = this.db
      .prepare("SELECT category FROM domain_cache WHERE domain = ?")
      .get(domain) as { category: string } | undefined;
    return row?.category;
  }

  bumpDomain(domain: string, category: string): void {
    this.db
      .prepare(
        "INSERT INTO domain_cache (domain, category, hits, updated_at) VALUES (?,?,1,?) ON CONFLICT(domain) DO UPDATE SET hits = hits + 1, updated_at = ?",
      )
      .run(domain, category, now(), now());
  }

  // ---------- organize versions ----------
  saveVersion(sessionId: string | null, actions: unknown[]): string {
    const id = newId();
    this.db
      .prepare(
        "INSERT INTO organize_version (id, session_id, actions, created_at, reverted) VALUES (?,?,?,?,0)",
      )
      .run(id, sessionId, JSON.stringify(actions), now());
    return id;
  }

  getVersion(id: string): { id: string; actions: unknown[]; reverted: number } | undefined {
    const row = this.db
      .prepare("SELECT * FROM organize_version WHERE id = ?")
      .get(id) as { id: string; actions: string; reverted: number } | undefined;
    if (!row) return undefined;
    return { ...row, actions: JSON.parse(row.actions) as unknown[] };
  }

  markReverted(id: string): void {
    this.db.prepare("UPDATE organize_version SET reverted = 1 WHERE id = ?").run(id);
  }

  // ---------- idempotency ----------
  getIdempotent(key: string): unknown | undefined {
    const row = this.db
      .prepare("SELECT result FROM idempotency WHERE key = ?")
      .get(key) as { result: string } | undefined;
    return row ? JSON.parse(row.result) : undefined;
  }

  saveIdempotent(key: string, result: unknown): void {
    this.db
      .prepare("INSERT INTO idempotency (key, result, created_at) VALUES (?,?,?)")
      .run(key, JSON.stringify(result), now());
  }

  // ---------- events ----------
  recordEvents(events: Array<{ name: string; props?: unknown }>): number {
    const ins = this.db.prepare(
      "INSERT INTO events (name, props, created_at) VALUES (?,?,?)",
    );
    for (const e of events) {
      ins.run(e.name, JSON.stringify(e.props ?? {}), now());
    }
    return events.length;
  }

  countEvents(name?: string): number {
    const row = name
      ? (this.db
          .prepare("SELECT COUNT(*) as c FROM events WHERE name = ?")
          .get(name) as { c: number })
      : (this.db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number });
    return row.c;
  }

  // ---------- privacy ----------
  privacyPatterns(): string[] {
    return (
      this.db.prepare("SELECT pattern FROM privacy_domain").all() as unknown as Array<{
        pattern: string;
      }>
    ).map((r) => r.pattern);
  }

  addPrivacyPattern(pattern: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO privacy_domain (pattern, builtin) VALUES (?, 0)")
      .run(pattern);
  }

  // ---------- nav ----------
  saveNavSite(slug: string, title: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO nav_site (slug, title, visibility, created_at) VALUES (?,?, 'unlisted', ?)",
      )
      .run(slug, title, now());
  }

  getNavSite(slug: string): { slug: string; title: string } | undefined {
    return this.db.prepare("SELECT * FROM nav_site WHERE slug = ?").get(slug) as
      | { slug: string; title: string }
      | undefined;
  }

  // ==================== M2/M3：鉴权 / 同步 / 维护 / 偏好 / 供应商 / 设置 ====================

  // ---------- 鉴权 token ----------
  createToken(label: string): string {
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    this.db
      .prepare("INSERT INTO tokens (token, label, created_at) VALUES (?,?,?)")
      .run(token, label, now());
    return token;
  }

  hasToken(token: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM tokens WHERE token = ?").get(token) !== undefined
    );
  }

  // ---------- 变更日志（多端同步） ----------
  recordChange(entity: string, entityId: string, op: string, payload: unknown, device?: string): void {
    this.db
      .prepare(
        "INSERT INTO changes (entity, entity_id, op, payload, device, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(entity, entityId, op, JSON.stringify(payload ?? null), device ?? null, now());
  }

  /** 拉取 device 之外、cursor 之后的变更（M1 上限 500 条/次，游标续传） */
  pullChanges(cursor: number, device: string | null, limit = 500): {
    items: Array<{ id: number; entity: string; entity_id: string; op: string; payload: unknown; device: string | null }>;
    cursor: number;
  } {
    const rows = this.db
      .prepare(
        `SELECT * FROM changes WHERE id > ? AND IFNULL(device,'') != ? ORDER BY id LIMIT ${limit}`,
      )
      .all(cursor, device ?? "") as unknown as Array<{
      id: number;
      entity: string;
      entity_id: string;
      op: string;
      payload: string | null;
      device: string | null;
    }>;
    return {
      items: rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })),
      cursor: rows.length > 0 ? rows[rows.length - 1]!.id : cursor,
    };
  }

  maxChangeId(): number {
    const row = this.db.prepare("SELECT MAX(id) as m FROM changes").get() as { m: number | null };
    return row.m ?? 0;
  }

  // ---------- 维护报告 ----------
  saveReport(type: string, findings: unknown): string {
    const id = newId();
    this.db
      .prepare("INSERT INTO maintenance_report (id, type, findings, created_at) VALUES (?,?,?,?)")
      .run(id, type, JSON.stringify(findings), now());
    return id;
  }

  latestReport(type: string): { id: string; findings: unknown; created_at: string } | undefined {
    const row = this.db
      .prepare("SELECT * FROM maintenance_report WHERE type = ? ORDER BY created_at DESC LIMIT 1")
      .get(type) as { id: string; findings: string; created_at: string } | undefined;
    return row ? { id: row.id, findings: JSON.parse(row.findings), created_at: row.created_at } : undefined;
  }

  listReports(type?: string): Array<{ id: string; type: string; created_at: string }> {
    const stmt = type
      ? this.db.prepare(
          "SELECT id, type, created_at FROM maintenance_report WHERE type = ? ORDER BY created_at DESC LIMIT 50",
        )
      : this.db.prepare(
          "SELECT id, type, created_at FROM maintenance_report ORDER BY created_at DESC LIMIT 50",
        );
    return (
      type ? stmt.all(type) : stmt.all()
    ) as unknown as Array<{ id: string; type: string; created_at: string }>;
  }

  /** 死链检测的候选：最久未检查的 N 条（跳过私密书签——隐私红线） */
  candidatesForLinkCheck(limit: number): BookmarkRow[] {
    return this.db
      .prepare(
        `SELECT * FROM bookmarks WHERE status != 'archived' AND is_private = 0
         ORDER BY IFNULL(last_checked_at, '1970') ASC LIMIT ${limit}`,
      )
      .all() as unknown as BookmarkRow[];
  }

  /** 查重候选：同域同名分组（跳过私密） */
  duplicateGroups(): Array<{ key: string; items: BookmarkRow[] }> {
    const all = this.listBookmarks({ limit: 10000 }).filter((b) => !b.is_private);
    const groups = new Map<string, BookmarkRow[]>();
    for (const bm of all) {
      const parsed = canonicalizeUrl(bm.url_canonical);
      const key = `${parsed?.registrableDomain ?? bm.url_canonical}\n${bm.title}`;
      const arr = groups.get(key) ?? [];
      arr.push(bm);
      groups.set(key, arr);
    }
    return [...groups.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([key, items]) => ({ key, items }));
  }

  /** 体检：久未检查/久未访问统计 */
  staleStats(daysThreshold = 365): { stale: number; oldestCheck: string | null } {
    const threshold = new Date(Date.now() - daysThreshold * 86_400_000).toISOString();
    const row = this.db
      .prepare("SELECT COUNT(*) as c, MIN(added_at) as o FROM bookmarks WHERE added_at < ? AND is_private = 0")
      .get(threshold) as { c: number; o: string | null };
    return { stale: row.c, oldestCheck: row.o };
  }

  // ---------- 偏好记忆 ----------
  getPref(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM prefs WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  setPref(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO prefs (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, JSON.stringify(value), now());
  }

  /** 记录一次采纳的目录迁移（F3.8 偏好记忆数据源） */
  recordCategoryAdoption(category: string): void {
    const current = (this.getPref("category_adoption") as Record<string, number>) ?? {};
    current[category] = (current[category] ?? 0) + 1;
    this.setPref("category_adoption", current);
  }

  topCategories(limit = 5): string[] {
    const adoption = (this.getPref("category_adoption") as Record<string, number>) ?? {};
    return Object.entries(adoption)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k]) => k);
  }

  // ---------- BYOK 供应商配置 ----------
  listProviderConfigs(): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare("SELECT * FROM provider_config ORDER BY created_at")
      .all() as unknown as Array<Record<string, unknown>>;
    for (const r of rows) {
      r.purpose_models = JSON.parse((r.purpose_models as string) ?? "{}");
      r.api_key = r.api_key ? "********" : null; // 不回显明文
      r.has_key = true;
    }
    return rows;
  }

  saveProviderConfig(input: {
    id?: string;
    providerId: string;
    baseUrl: string;
    apiKey?: string | null;
    purposeModels?: Record<string, string>;
    enabled?: boolean;
  }): string {
    const id = input.id ?? newId();
    this.db
      .prepare(
        "INSERT INTO provider_config (id, provider_id, base_url, api_key, purpose_models, enabled, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, base_url=excluded.base_url, api_key=COALESCE(excluded.api_key, api_key), purpose_models=excluded.purpose_models, enabled=excluded.enabled",
      )
      .run(id, input.providerId, input.baseUrl, input.apiKey ?? null, JSON.stringify(input.purposeModels ?? {}), input.enabled === false ? 0 : 1, now());
    return id;
  }

  enabledProviderConfigs(): Array<{
    id: string;
    provider_id: string;
    base_url: string;
    api_key: string | null;
    purpose_models: Record<string, string>;
  }> {
    const rows = this.db
      .prepare("SELECT * FROM provider_config WHERE enabled = 1 ORDER BY created_at")
      .all() as unknown as Array<{
      id: string;
      provider_id: string;
      base_url: string;
      api_key: string | null;
      purpose_models: string;
    }>;
    return rows.map((r) => ({ ...r, purpose_models: JSON.parse(r.purpose_models) }));
  }

  // ---------- 设置 KV ----------
  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  snapshotUsageBytes(): number {
    const row = this.db.prepare("SELECT IFNULL(SUM(size),0) as s FROM snapshot").get() as {
      s: number;
    };
    return row.s;
  }

  // ---------- 导航站配置更新 ----------
  updateNavSite(slug: string, patch: { title?: string; template?: string; passwordHash?: string | null }): void {
    const current = this.getNavSite(slug);
    if (!current) return;
    this.db
      .prepare("UPDATE nav_site SET title = ?, template = ?, password_hash = ? WHERE slug = ?")
      .run(
        patch.title ?? current.title,
        patch.template ?? "grid",
        patch.passwordHash !== undefined ? patch.passwordHash : null,
        slug,
      );
  }

  getNavSiteFull(slug: string): {
    slug: string;
    title: string;
    template: string;
    password_hash: string | null;
  } | undefined {
    return this.db.prepare("SELECT * FROM nav_site WHERE slug = ?").get(slug) as
      | { slug: string; title: string; template: string; password_hash: string | null }
      | undefined;
  }

  navSites(): Array<{ slug: string; title: string; template: string }> {
    return this.db
      .prepare("SELECT slug, title, template FROM nav_site ORDER BY created_at DESC")
      .all() as unknown as Array<{ slug: string; title: string; template: string }>;
  }
}
