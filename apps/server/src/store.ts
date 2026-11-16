/** 仓储层 —— 全部 SQL 集中在此，路由不直接摸 SQL */
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
    return before;
  }

  deleteBookmark(id: string): BookmarkRow | undefined {
    const before = this.getBookmark(id);
    if (!before) return undefined;
    this.db.prepare("DELETE FROM content_cache WHERE bookmark_id = ?").run(id);
    this.db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
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
}
