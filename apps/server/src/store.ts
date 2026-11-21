/** 仓储层 —— 全部 SQL 集中在此，路由不直接摸 SQL */
import { rmSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { canonicalizeUrl } from "@mf/shared";
import type { Db } from "./db";
import { newId, now } from "./db";
import { protectKeyForStorage, keyForUse } from "./secret-box";

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
  /** A3-5 软归档：被合并时指向保留方；NULL = 正常书签 */
  archived_into?: string | null;
  /** A3-4 冲突检测：用户手动修改计数（提案前后对比） */
  content_revision?: number;
  /** D30 站点化三类标注（site_tool/site_ref/content；null = 未分析） */
  site_type?: string | null;
  /** 疑似失效连续周期（原型 14：连续 2 周期升级确认候选） */
  suspect_streak?: number;
  /** 可解释失败原因（报告明细「为什么访问不了」） */
  last_fail_reason?: string | null;
}

export class Store {
  constructor(readonly db: Db) {}

  /**
   * D46 双向同步：sync-apply 执行期间的变更日志自动携带发起设备（device 列），
   * 该设备 pullChanges 时被排除——浏览器→库的改动不再回声到浏览器（防回环）。
   * 其他改动路径（整理/管理台）此值为 null，日志照旧全员下发。
   */
  syncApplyDevice: string | null = null;

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

  /** 目录重命名（收纳盒等系统目录拒绝改名） */
  renameFolder(id: string, name: string): FolderRow | undefined {
    const row = this.getFolder(id);
    if (!row || row.is_system_inbox === 1) return undefined;
    this.db.prepare("UPDATE folders SET name = ? WHERE id = ?").run(name, id);
    this.recordChange("folder", id, "upsert", { id, name, parent_id: row.parent_id });
    return this.getFolder(id);
  }

  /** 系统收纳盒改名：仅供 /inbox/setup 幂等校准（D36 术语迁移），用户面重命名仍走 renameFolder */
  renameSystemFolder(id: string, name: string): FolderRow | undefined {
    const row = this.getFolder(id);
    if (!row) return undefined;
    this.db.prepare("UPDATE folders SET name = ? WHERE id = ?").run(name, id);
    this.recordChange("folder", id, "upsert", { id, name, parent_id: row.parent_id });
    return this.getFolder(id);
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

  /**
   * D56：目录树删除（浏览器删目录 → 库同步）。子优先递归删「子目录 + 全部子书签 + 本目录」，
   * 不受 deleteFolderIfEmpty 的"仅空目录"限制（那会导致父目录在子目录未删时删不掉而残留）。
   * 系统收纳盒拒绝。事务包裹保证原子；书签走 deleteBookmark（记日志 + 给他设备排 remove，
   * skipMirrorRemoveForDevice 跳过发起设备——其浏览器节点已删，无需回程）。
   */
  deleteFolderTree(id: string, opts: { skipMirrorRemoveForDevice?: string } = {}): { folders: number; bookmarks: number } {
    const folder = this.getFolder(id);
    if (!folder || folder.is_system_inbox === 1) return { folders: 0, bookmarks: 0 };
    const acc = { folders: 0, bookmarks: 0 };
    this.db.exec("BEGIN");
    try {
      this.deleteFolderTreeInner(id, opts, acc);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return acc;
  }

  /** 子优先递归（事务由外层 deleteFolderTree 统一管理，避免嵌套 BEGIN） */
  private deleteFolderTreeInner(id: string, opts: { skipMirrorRemoveForDevice?: string }, acc: { folders: number; bookmarks: number }): void {
    const children = this.db.prepare("SELECT id FROM folders WHERE parent_id = ?").all(id) as Array<{ id: string }>;
    for (const c of children) this.deleteFolderTreeInner(c.id, opts, acc);
    const bms = this.db.prepare("SELECT id FROM bookmarks WHERE folder_id = ?").all(id) as Array<{ id: string }>;
    for (const b of bms) {
      this.deleteBookmark(b.id, opts);
      acc.bookmarks++;
    }
    this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
    this.recordChange("folder", id, "delete", { id });
    acc.folders++;
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
    /** 查重键规则版本（DEV-13；与 @mf/shared URL_KEY_RULES_VERSION 一致） */
    urlKeyVersion?: number;
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
        "INSERT INTO bookmarks (id, folder_id, url_raw, url_canonical, title, description, status, favicon_url, cover_url, added_at, last_checked_at, pinned, created_at, url_key_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
        input.urlKeyVersion ?? 2,
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
    // A3-4 冲突检测信号：用户手动修改（标题/目录/状态/固定/私密）递增修订版本
    const manualCols = ["title", "folder_id", "status", "pinned", "is_private", "url_raw", "description"];
    if (keys.some((k) => manualCols.includes(k))) {
      this.db
        .prepare("UPDATE bookmarks SET content_revision = content_revision + 1 WHERE id = ?")
        .run(id);
    }
    // D46 双向同步：同步相关字段的修改进变更日志（此前只 create/move/delete 有日志，
    // 改名/置顶不会传播到浏览器侧）。folder_id 变化记 move（与 moveBookmark 同形）。
    // D52：url_raw/description 编辑同样入日志（浏览器侧节点 URL/标题跟随）。
    if (keys.some((k) => ["title", "status", "pinned", "is_private", "url_raw", "description"].includes(k))) {
      const after = this.getBookmark(id);
      if (after) this.recordChange("bookmark", id, "upsert", after);
    }
    if (keys.includes("folder_id") && fields.folder_id !== undefined) {
      const after = this.getBookmark(id);
      this.recordChange("bookmark", id, "move", {
        from: null,
        to: String(fields.folder_id),
        url: after?.url_canonical,
        title: after?.title,
      });
    }
  }

  moveBookmark(id: string, toFolderId: string): BookmarkRow | undefined {
    const before = this.getBookmark(id);
    if (!before) return undefined;
    // D46：move 变更日志由 updateBookmark(folder_id) 统一记录，此处不再重复
    this.updateBookmark(id, { folder_id: toFolderId });
    return before;
  }

  deleteBookmark(
    id: string,
    opts: { skipMirrorRemoveForDevice?: string } = {},
  ): BookmarkRow | undefined {
    const before = this.getBookmark(id);
    if (!before) return undefined;
    // D44 受控镜像删除 / D46：有浏览器身份映射（A2-1）的书签入队 remove 操作。
    // 服务端只排队；是否真的动浏览器节点由扩展端同步开关决定（默认关）。
    // skipMirrorRemoveForDevice：浏览器→库方向的删除不回程删发起方自己。
    for (const ident of this.identitiesForApp(id)) {
      if (opts.skipMirrorRemoveForDevice && ident.device_id === opts.skipMirrorRemoveForDevice) continue;
      this.enqueueBrowserOpIdempotent({
        deviceId: ident.device_id,
        op: "remove",
        browserBookmarkId: ident.browser_bookmark_id,
        payload: { url: before.url_canonical, title: before.title },
      });
    }
    this.db.prepare("DELETE FROM content_cache WHERE bookmark_id = ?").run(id);
    this.db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
    this.recordChange("bookmark", id, "delete", { url: before.url_canonical, title: before.title, folder_id: before.folder_id });
    return before;
  }

  /** D52：URL 编辑后正文缓存作废（快照是历史资产，保留） */
  clearCache(bookmarkId: string): void {
    this.db.prepare("DELETE FROM content_cache WHERE bookmark_id = ?").run(bookmarkId);
  }

  /** D46 首次对齐：本设备全部身份映射 + 应用侧书签是否仍存在（孤儿映射=库已删，浏览器侧待清） */
  identitiesWithState(deviceId: string): Array<{ browser_bookmark_id: string; app_bookmark_id: string; app_exists: boolean }> {
    return this.db
      .prepare(
        `SELECT i.browser_bookmark_id, i.app_bookmark_id,
                (SELECT COUNT(*) FROM bookmarks b WHERE b.id = i.app_bookmark_id) > 0 AS app_exists
         FROM bookmark_identity i WHERE i.device_id = ?`,
      )
      .all(deviceId) as unknown as Array<{ browser_bookmark_id: string; app_bookmark_id: string; app_exists: boolean }>;
  }

  listBookmarks(filter?: {
    folderId?: string;
    status?: string;
    siteType?: string;
    hasSnapshot?: boolean;
    limit?: number;
    offset?: number;
  }): BookmarkRow[] {
    const conds: string[] = [];
    const args: (string | number)[] = [];
    if (filter?.folderId) {
      conds.push("folder_id = ?");
      args.push(filter.folderId);
    }
    // 疑似失效：未被确认失效、抓取被 403 反爬拦截（保守规则仅标注，见功能文档 D 系列）
    const wantSuspect = filter?.status === "suspect";
    if (filter?.status && !wantSuspect) {
      conds.push("status = ?");
      args.push(filter.status);
    }
    if (wantSuspect) {
      conds.push("b.status = 'normal'");
      conds.push("cc.fail_reason LIKE '403%'");
    }
    // 站点类型 / 有快照筛选（原型 11；与 suspect 探测路径不同 SQL 形态，互斥使用）
    if (!wantSuspect && filter?.siteType) {
      conds.push("site_type = ?");
      args.push(filter.siteType);
    }
    if (!wantSuspect && filter?.hasSnapshot) {
      conds.push("id IN (SELECT bookmark_id FROM snapshot)");
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const limit = filter?.limit ?? 1000;
    // 追加 id 保证分页稳定排序（同 added_at 时不错位）；A3-5：软归档书签不出现在常规列表
    const offset = filter?.offset ?? 0;
    const sql = wantSuspect
      ? `SELECT b.* FROM bookmarks b LEFT JOIN content_cache cc ON cc.bookmark_id = b.id ${where ? where + " AND" : "WHERE"} b.archived_into IS NULL ORDER BY b.pinned DESC, b.added_at DESC, b.id LIMIT ${limit} OFFSET ${offset}`
      : `SELECT * FROM bookmarks ${where ? where + " AND" : "WHERE"} archived_into IS NULL ORDER BY pinned DESC, added_at DESC, id LIMIT ${limit} OFFSET ${offset}`;
    return this.db.prepare(sql).all(...args) as unknown as BookmarkRow[];
  }

  /**
   * 关键词搜索。DEV-02：默认排除私密与软归档（所有读入口一致边界）；
   * includePrivate 仅限已鉴权管理面的显式开关（X-MF-Private），公开入口永不传入。
   */
  search(q: string, limit = 50, opts: { includePrivate?: boolean } = {}): BookmarkRow[] {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const privacyCond = opts.includePrivate ? "" : " AND b.is_private = 0";
    return this.db
      .prepare(
        `SELECT DISTINCT b.* FROM bookmarks b
         LEFT JOIN content_cache c ON c.bookmark_id = b.id
         WHERE b.archived_into IS NULL${privacyCond} AND (b.title LIKE ? OR b.url_canonical LIKE ? OR IFNULL(b.description,'') LIKE ? OR IFNULL(c.l2_text,'') LIKE ?)
         LIMIT ?`,
      )
      .all(like, like, like, like, limit) as unknown as BookmarkRow[];
  }

  countBookmarks(): { total: number; dead: number; suspect: number } {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as total, SUM(status='dead') as dead, SUM(status='suspect') as suspect FROM bookmarks WHERE archived_into IS NULL",
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

  /**
   * D63 摘要补扫候选：有正文（≥40 字，与 maybeSummarize 同阈值）但缺 L1 摘要。
   * 可重试 = 无失败原因（fire-and-forget 丢失）或 llm_unavailable / stale_policy_discarded
   * （当时不可用/过期丢弃，重跑安全——引擎内仍有现行策略判定兜底）；privacy_* 拒绝不重试。
   */
  bookmarksMissingSummary(limit = 5): BookmarkRow[] {
    return this.db
      .prepare(
        `SELECT b.* FROM bookmarks b JOIN content_cache cc ON cc.bookmark_id = b.id
         WHERE b.archived_into IS NULL AND b.is_private = 0
           AND LENGTH(IFNULL(cc.l2_text,'')) >= 40
           AND IFNULL(cc.l1_summary,'') = ''
           AND (cc.fail_reason IS NULL OR cc.fail_reason NOT LIKE 'privacy_%')
         ORDER BY b.added_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as BookmarkRow[];
  }

  // ---------- material（资料库，D61：正文/摘要引用 content_cache 不复制，封面文件在 DATA_DIR/materials/） ----------
  upsertMaterial(input: {
    bookmarkId: string;
    type: string;
    signals?: string[];
    meta?: Record<string, unknown>;
  }): { id: string; created: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM material WHERE bookmark_id = ?")
      .get(input.bookmarkId) as { id: string } | undefined;
    if (existing) {
      // 已在库：刷新类型与信号（封面字段与创建时间保留；status 不动——dismissed 是用户的移出决定，防"复活"）
      this.db
        .prepare(
          "UPDATE material SET type = ?, signals = ?, meta = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          input.type,
          JSON.stringify(input.signals ?? []),
          JSON.stringify(input.meta ?? {}),
          now(),
          existing.id,
        );
      return { id: existing.id, created: false };
    }
    const id = newId();
    this.db
      .prepare(
        "INSERT INTO material (id, bookmark_id, type, status, meta, signals, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.bookmarkId,
        input.type,
        "active",
        JSON.stringify(input.meta ?? {}),
        JSON.stringify(input.signals ?? []),
        now(),
        now(),
      );
    return { id, created: true };
  }

  /**
   * 资料库列表（JOIN 书签与内容缓存：标题/URL/目录/图标实时取自主数据，
   * 摘要取 L1，正文只取长度——全文走 /materials/:id 详情，列表不拖 20KB 正文）。
   * 默认排除私密书签（与 search/listBookmarks 同边界）；软归档书签的条目一并隐藏。
   */
  listMaterials(filter: {
    type?: string;
    q?: string;
    limit?: number;
    offset?: number;
    includePrivate?: boolean;
  }): Array<Record<string, unknown>> {
    const conds: string[] = ["m.status = 'active'", "b.archived_into IS NULL"];
    const args: (string | number)[] = [];
    if (!filter.includePrivate) conds.push("b.is_private = 0");
    if (filter.type) {
      conds.push("m.type = ?");
      args.push(filter.type);
    }
    if (filter.q) {
      const like = `%${filter.q.replace(/[%_]/g, "")}%`;
      conds.push(
        "(b.title LIKE ? OR b.url_canonical LIKE ? OR IFNULL(cc.l1_summary,'') LIKE ? OR IFNULL(cc.l2_text,'') LIKE ?)",
      );
      args.push(like, like, like, like);
    }
    const limit = filter.limit ?? 60;
    const offset = filter.offset ?? 0;
    const sql = [
      "SELECT m.id, m.bookmark_id, m.type, m.cover_url, m.cover_mime, m.cover_size, m.meta, m.signals, m.created_at, m.updated_at,",
      "  b.title, b.url_canonical, b.url_raw, b.favicon_url, b.folder_id, b.added_at,",
      "  cc.l1_summary, cc.l1_tags, LENGTH(IFNULL(cc.l2_text,'')) AS l2_len,",
      "  (SELECT COUNT(*) FROM snapshot s WHERE s.bookmark_id = b.id) AS snapshot_count,",
      "  (SELECT name FROM folders f WHERE f.id = b.folder_id) AS folder_name",
      "FROM material m",
      "JOIN bookmarks b ON b.id = m.bookmark_id",
      "LEFT JOIN content_cache cc ON cc.bookmark_id = b.id",
      `WHERE ${conds.join(" AND ")}`,
      "ORDER BY m.created_at DESC, m.id DESC",
      `LIMIT ${limit} OFFSET ${offset}`,
    ].join(" ");
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    for (const r of rows) {
      r.signals = JSON.parse((r.signals as string) ?? "[]");
      r.meta = JSON.parse((r.meta as string) ?? "{}");
      r.l1_tags = JSON.parse((r.l1_tags as string) ?? "[]");
      r.has_cover = r.cover_mime != null && (r.cover_size as number) > 0;
    }
    return rows;
  }

  /** 资料条目详情（含 l2 全文引用——阅读视图用）；不存在或已 dismiss 返回 undefined */
  getMaterial(id: string): Record<string, unknown> | undefined {
    const row = this.db
      .prepare(
        [
          "SELECT m.*, b.title, b.url_canonical, b.url_raw, b.favicon_url, b.folder_id, b.is_private,",
          "  cc.l1_summary, cc.l1_tags, cc.l2_text, LENGTH(IFNULL(cc.l2_text,'')) AS l2_len,",
          "  (SELECT COUNT(*) FROM snapshot s WHERE s.bookmark_id = b.id) AS snapshot_count,",
          "  (SELECT name FROM folders f WHERE f.id = b.folder_id) AS folder_name",
          "FROM material m",
          "JOIN bookmarks b ON b.id = m.bookmark_id",
          "LEFT JOIN content_cache cc ON cc.bookmark_id = b.id",
          "WHERE m.id = ? AND m.status = 'active' AND b.archived_into IS NULL",
        ].join(" "),
      )
      .get(id) as Record<string, unknown> | undefined;
    if (row) {
      row.signals = JSON.parse((row.signals as string) ?? "[]");
      row.meta = JSON.parse((row.meta as string) ?? "{}");
      row.l1_tags = JSON.parse((row.l1_tags as string) ?? "[]");
      row.has_cover = row.cover_mime != null && (row.cover_size as number) > 0;
    }
    return row;
  }

  /** 资料条目存在性（孤儿封面清理用：不看 status，行在即文件不清理） */
  materialExists(id: string): boolean {
    return (this.db.prepare("SELECT 1 FROM material WHERE id = ?").get(id) as unknown) != null;
  }

  /** 按书标记取资料条目（含 dismissed——封面回填对已移出条目照常写库，不展示） */
  getMaterialByBookmark(bookmarkId: string): { id: string } | undefined {
    return this.db
      .prepare("SELECT id FROM material WHERE bookmark_id = ?")
      .get(bookmarkId) as { id: string } | undefined;
  }

  /** 资料库计数（按类型；口径与列表一致：active + 非软归档 + 非私密） */
  countMaterials(): { total: number; article: number; video: number; image: number } {
    const row = this.db
      .prepare(
        [
          "SELECT COUNT(*) AS total,",
          "  SUM(m.type = 'article') AS article,",
          "  SUM(m.type = 'video') AS video,",
          "  SUM(m.type = 'image') AS image",
          "FROM material m JOIN bookmarks b ON b.id = m.bookmark_id",
          "WHERE m.status = 'active' AND b.archived_into IS NULL AND b.is_private = 0",
        ].join(" "),
      )
      .get() as { total: number; article: number | null; video: number | null; image: number | null };
    return {
      total: row.total,
      article: row.article ?? 0,
      video: row.video ?? 0,
      image: row.image ?? 0,
    };
  }

  /** 用户主动移出资料库（软删：书签本体不动，防 capture/crawl 复活；幂等——重复 dismiss 计 404） */
  dismissMaterial(id: string): boolean {
    const res = this.db
      .prepare("UPDATE material SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'active'")
      .run(now(), id);
    return res.changes > 0;
  }

  /** 落盘封面信息（materials.ts 下载成功后回填） */
  setMaterialCover(id: string, cover: { mime: string; size: number; url: string; relPath: string }): void {
    this.db
      .prepare(
        "UPDATE material SET cover_path = ?, cover_mime = ?, cover_size = ?, cover_url = ?, updated_at = ? WHERE id = ?",
      )
      .run(cover.relPath, cover.mime, cover.size, cover.url, now(), id);
  }

  /** 封面文件相对路径（DATA_DIR 相对），供路由层读文件 */
  getMaterialCoverPath(id: string): { relPath: string; mime: string } | undefined {
    const row = this.db
      .prepare("SELECT cover_path, cover_mime FROM material WHERE id = ? AND status = 'active'")
      .get(id) as { cover_path: string | null; cover_mime: string | null } | undefined;
    if (!row?.cover_path || !row.cover_mime) return undefined;
    return { relPath: row.cover_path, mime: row.cover_mime };
  }

  /** 清空封面引用（文件删除后调用） */
  clearMaterialCover(id: string): void {
    this.db
      .prepare("UPDATE material SET cover_path = NULL, cover_mime = NULL, cover_size = NULL, updated_at = ? WHERE id = ?")
      .run(now(), id);
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

  // ---------- organize versions（DEV-08：apply/undo 双版本历史） ----------
  saveVersion(
    sessionId: string | null,
    actions: unknown[],
    opts: { kind?: "apply" | "undo"; revertsVersionId?: string | null } = {},
  ): string {
    const id = newId();
    this.db
      .prepare(
        "INSERT INTO organize_version (id, session_id, actions, created_at, reverted, kind, reverts_version_id) VALUES (?,?,?,?,0,?,?)",
      )
      .run(id, sessionId, JSON.stringify(actions), now(), opts.kind ?? "apply", opts.revertsVersionId ?? null);
    return id;
  }

  getVersion(id: string): { id: string; actions: unknown[]; reverted: number; session_id: string | null; kind: string; reverts_version_id: string | null } | undefined {
    const row = this.db
      .prepare("SELECT * FROM organize_version WHERE id = ?")
      .get(id) as { id: string; actions: string; reverted: number; session_id: string | null; kind: string; reverts_version_id: string | null } | undefined;
    if (!row) return undefined;
    return { ...row, actions: JSON.parse(row.actions) as unknown[] };
  }

  /** DEV-08 apply 幂等：同一会话已提交的版本（崩溃后重试返回原结果，不产生第二份版本） */
  getVersionBySession(sessionId: string): { id: string; actions: unknown[]; reverted: number } | undefined {
    const row = this.db
      .prepare("SELECT * FROM organize_version WHERE session_id = ? AND kind = 'apply' ORDER BY created_at DESC LIMIT 1")
      .get(sessionId) as { id: string; actions: string; reverted: number } | undefined;
    if (!row) return undefined;
    return { id: row.id, actions: JSON.parse(row.actions) as unknown[], reverted: row.reverted };
  }

  markReverted(id: string): void {
    this.db.prepare("UPDATE organize_version SET reverted = 1 WHERE id = ?").run(id);
  }

  /** 列出会话/撤销历史（DEV-14 前置；刷新后仍可查看） */
  listVersions(limit = 50): Array<{ id: string; session_id: string | null; kind: string; reverted: number; created_at: string; actionCount: number }> {
    const rows = this.db
      .prepare(
        "SELECT id, session_id, kind, reverted, created_at, actions FROM organize_version ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as unknown as Array<{
      id: string;
      session_id: string | null;
      kind: string;
      reverted: number;
      created_at: string;
      actions: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      kind: r.kind,
      reverted: r.reverted,
      created_at: r.created_at,
      actionCount: (JSON.parse(r.actions) as unknown[]).length,
    }));
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
    this.bumpPrivacyRevision();
  }

  removePrivacyPattern(pattern: string): void {
    // 内置项不可删（AGENTS.md 红线 2：用户可增不可删）
    this.db
      .prepare("DELETE FROM privacy_domain WHERE pattern = ? AND builtin = 0")
      .run(pattern);
    this.bumpPrivacyRevision();
  }

  /** 隐私规则修订版本：每次变更 +1（A1-1，扩展端同步失效检测） */
  privacyRevision(): number {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'privacy_rules_revision'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private bumpPrivacyRevision(): void {
    this.setSetting("privacy_rules_revision", String(this.privacyRevision() + 1));
  }

  /** A1-1 统一策略规则视图（服务端纵深校验与 /privacy/rules 下发共用） */
  privacyRules(): { patterns: string[]; revision: number } {
    return { patterns: this.privacyPatterns(), revision: this.privacyRevision() };
  }

  /**
   * A1-5 隐私规则变化后的存量清理（DEV-03 修订）：
   *  - 覆盖软归档书签（listBookmarks 默认排除 archived_into，此处独立分页查询全量）；
   *  - 游标分页扫描，不静默截断；
   *  - 文件删除失败写入 pending_snapshot_deletions 台账（不"删索引即成功"），
   *    下次清理/重启重试；
   *  - 仅清理派生内容，永不删除原书签（红线 3）。
   */
  purgeContentForPrivacyRules(isPrivacy: (url: string) => boolean): {
    bookmarks: number;
    snapshots: number;
    failedFileDeletions: number;
  } {
    let bookmarks = 0;
    let snapshots = 0;
    let failedFileDeletions = 0;
    const PAGE = 500;
    let lastId = "";
    for (;;) {
      const rows = this.db
        .prepare(
          "SELECT id, url_canonical, is_private FROM bookmarks WHERE id > ? ORDER BY id LIMIT ?",
        )
        .all(lastId, PAGE) as unknown as Array<{
        id: string;
        url_canonical: string;
        is_private: number;
      }>;
      if (rows.length === 0) break;
      for (const bm of rows) {
        lastId = bm.id;
        if (!isPrivacy(bm.url_canonical) && bm.is_private === 0) continue;
        const cache = this.getCache(bm.id);
        if (cache) {
          this.db
            .prepare(
              "UPDATE content_cache SET l1_summary = NULL, l1_tags = '[]', keywords = '[]', l2_text = NULL, embedding = NULL, fail_reason = 'privacy_rules_changed' WHERE bookmark_id = ?",
            )
            .run(bm.id);
          bookmarks++;
        }
        // 关联快照删除（文件 + 索引）；文件删除失败 → 台账，索引一并保留待重试
        const snaps = this.db
          .prepare("SELECT id, path FROM snapshot WHERE bookmark_id = ?")
          .all(bm.id) as unknown as Array<{ id: string; path: string }>;
        for (const s of snaps) {
          try {
            rmSync(s.path, { force: true });
            // force: true 时文件缺失不抛错——直接删索引
            this.db.prepare("DELETE FROM snapshot WHERE id = ?").run(s.id);
            snapshots++;
          } catch {
            // 真实删除失败（权限/占用）：保留索引 + 记台账，可重试可观测
            this.db
              .prepare(
                "INSERT OR REPLACE INTO pending_snapshot_deletions (id, path, reason, attempted_at) VALUES (?,?,?,?)",
              )
              .run(s.id, s.path, "privacy_purge_failed", now());
            failedFileDeletions++;
          }
        }
      }
    }
    // 重试历史台账（本次可能已能删除：如权限恢复）
    failedFileDeletions += this.retryPendingSnapshotDeletions();
    return { bookmarks, snapshots, failedFileDeletions };
  }

  /** 重试台账中失败的快照文件删除；成功项移除台账与索引 */
  retryPendingSnapshotDeletions(): number {
    const pending = this.db
      .prepare("SELECT id, path FROM pending_snapshot_deletions")
      .all() as unknown as Array<{ id: string; path: string }>;
    let done = 0;
    for (const p of pending) {
      try {
        rmSync(p.path, { force: true });
        this.db.prepare("DELETE FROM snapshot WHERE id = ?").run(p.id);
        this.db.prepare("DELETE FROM pending_snapshot_deletions WHERE id = ?").run(p.id);
        done++;
      } catch {
        // 仍失败：保留台账
      }
    }
    return done;
  }

  // ---------- nav（完整实现在文件尾部 nav 区块；此处保留旧签名兼容） ----------

  // ==================== A2：设备身份映射 / 待执行操作 / 软归档 ====================

  // ---------- 设备（A2-1） ----------
  ensureDevice(deviceId: string, label?: string): void {
    this.db
      .prepare(
        "INSERT INTO device (device_id, label, created_at, last_seen_at) VALUES (?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, label = COALESCE(NULLIF(excluded.label, ''), label)",
      )
      .run(deviceId, label ?? null, now(), now());
  }

  /** A2-1 核心映射：device_id + browser_bookmark_id ↔ app_bookmark_id（幂等 upsert） */
  upsertIdentity(input: {
    deviceId: string;
    browserBookmarkId: string;
    appBookmarkId: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO bookmark_identity (device_id, browser_bookmark_id, app_bookmark_id, mapped_at)
         VALUES (?,?,?,?)
         ON CONFLICT(device_id, browser_bookmark_id) DO UPDATE SET app_bookmark_id = excluded.app_bookmark_id, mapped_at = excluded.mapped_at`,
      )
      .run(input.deviceId, input.browserBookmarkId, input.appBookmarkId, now());
  }

  /** 按浏览器节点 ID 找应用库书签 ID（收件箱事件入口的映射查询） */
  findAppBookmarkId(deviceId: string, browserBookmarkId: string): string | undefined {
    const row = this.db
      .prepare("SELECT app_bookmark_id FROM bookmark_identity WHERE device_id = ? AND browser_bookmark_id = ?")
      .get(deviceId, browserBookmarkId) as { app_bookmark_id: string } | undefined;
    return row?.app_bookmark_id;
  }

  identitiesForApp(appBookmarkId: string): Array<{ device_id: string; browser_bookmark_id: string }> {
    return this.db
      .prepare("SELECT device_id, browser_bookmark_id FROM bookmark_identity WHERE app_bookmark_id = ?")
      .all(appBookmarkId) as unknown as Array<{ device_id: string; browser_bookmark_id: string }>;
  }

  // ---------- 浏览器待执行操作（A2-3/A2-4 镜像模式 D20：持久队列，不与 DB 事务共用） ----------
  enqueueBrowserOp(input: {
    deviceId: string;
    /** move=归位镜像；remove=D44 受控镜像删除；reorder=D45 按管理台顺序重排浏览器文件夹 */
    op: "move" | "create" | "remove" | "reorder";
    browserBookmarkId?: string | null;
    targetBrowserParentId?: string | null;
    payload?: unknown;
  }): number {
    const r = this.db
      .prepare(
        `INSERT INTO pending_browser_ops
           (device_id, op, browser_bookmark_id, target_browser_parent_id, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.deviceId,
        input.op,
        input.browserBookmarkId ?? null,
        input.targetBrowserParentId ?? null,
        JSON.stringify(input.payload ?? null),
        now(),
        now(),
      );
    return Number(r.lastInsertRowid);
  }

  /** 幂等入队：同 device+op+bookmark+target 的 pending 操作不重复入队（A2 验收：重复事件不产生重复任务） */
  enqueueBrowserOpIdempotent(input: Parameters<Store["enqueueBrowserOp"]>[0]): number | null {
    const dup = this.db
      .prepare(
        `SELECT id FROM pending_browser_ops
         WHERE device_id = ? AND op = ? AND IFNULL(browser_bookmark_id,'') = IFNULL(?,'')
           AND IFNULL(target_browser_parent_id,'') = IFNULL(?,'') AND status = 'pending'`,
      )
      .get(input.deviceId, input.op, input.browserBookmarkId ?? null, input.targetBrowserParentId ?? null) as
      | { id: number }
      | undefined;
    if (dup) return null;
    return this.enqueueBrowserOp(input);
  }

  pendingBrowserOps(deviceId?: string): Array<{
    id: number;
    device_id: string;
    op: string;
    browser_bookmark_id: string | null;
    target_browser_parent_id: string | null;
    payload: unknown;
    attempts: number;
  }> {
    const rows = (deviceId
      ? this.db
          .prepare("SELECT * FROM pending_browser_ops WHERE status = 'pending' AND device_id = ? ORDER BY id")
          .all(deviceId)
      : this.db
          .prepare("SELECT * FROM pending_browser_ops WHERE status = 'pending' ORDER BY id")
          .all()) as unknown as Array<{
      id: number;
      device_id: string;
      op: string;
      browser_bookmark_id: string | null;
      target_browser_parent_id: string | null;
      payload: string | null;
      attempts: number;
    }>;
    return rows.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
  }

  /** 回执终结：仅对 pending 生效；返回是否命中（防乱序/重复回执误终结已执行操作） */
  completeBrowserOp(id: number, status: "done" | "failed" | "cancelled", lastError?: string): boolean {
    const r = this.db
      .prepare(
        "UPDATE pending_browser_ops SET status = ?, last_error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(status, lastError ?? null, now(), id);
    return Number(r.changes) > 0;
  }

  /**
   * DEV-08/09 撤销补偿：撤销移动时取消同节点的待执行旧移动（避免旧操作晚到覆盖撤销）。
   * 已执行（done）的操作不在此取消——补偿由 rollback 的反向移动承载。
   */
  cancelPendingBrowserOps(deviceId: string, browserBookmarkId: string, targetFolderName?: string): number {
    const r = this.db
      .prepare(
        `UPDATE pending_browser_ops SET status = 'cancelled', last_error = 'superseded_by_undo', updated_at = ?
         WHERE device_id = ? AND browser_bookmark_id = ? AND status = 'pending' AND op = 'move'
           AND (? IS NULL OR target_browser_parent_id != ?)`,
      )
      .run(now(), deviceId, browserBookmarkId, targetFolderName ?? null, `mf-folder:${targetFolderName ?? ""}`);
    return Number(r.changes);
  }

  /** D45：重排操作以「最新顺序快照」为准——重新排队前先终结该设备+目录的旧 pending reorder */
  cancelPendingReorderOps(deviceId: string, targetBrowserParentId: string): number {
    const r = this.db
      .prepare(
        `UPDATE pending_browser_ops SET status = 'cancelled', last_error = 'superseded_by_requeue', updated_at = ?
         WHERE device_id = ? AND op = 'reorder' AND target_browser_parent_id = ? AND status = 'pending'`,
      )
      .run(now(), deviceId, targetBrowserParentId);
    return Number(r.changes);
  }

  bumpBrowserOpAttempt(id: number, error: string): void {
    this.db
      .prepare("UPDATE pending_browser_ops SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?")
      .run(error.slice(0, 300), now(), id);
  }

  // ==================== M2/M3：鉴权 / 同步 / 维护 / 偏好 / 供应商 / 设置 ====================

  // ---------- 鉴权 token（DEV-05：摘要存储 + 非密 ID + 生命周期） ----------
  static hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /**
   * 签发令牌：原值只在返回时出现一次，库中仅存 SHA-256 摘要与随机非密 ID。
   * ttlHours 默认 30 天；null = 不过期（ADMIN_PASSWORD 模式可显式选择）。
   */
  createToken(label: string, ttlHours: number | null = 24 * 30): { token: string; tokenId: string } {
    const token =
      randomBytes(32).toString("base64url");
    const tokenId = newId();
    const expiresAt = ttlHours !== null ? new Date(Date.now() + ttlHours * 3600_000).toISOString() : null;
    this.db
      .prepare(
        "INSERT INTO tokens (token, token_id, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(tokenId, tokenId, Store.hashToken(token), label, now(), expiresAt);
    return { token, tokenId };
  }

  /** 校验令牌：摘要匹配 + 未撤销 + 未过期；命中时更新 last_used_at */
  resolveToken(token: string): { tokenId: string; label: string | null } | undefined {
    const digest = Store.hashToken(token);
    const row = this.db
      .prepare(
        "SELECT token_id, label, expires_at, revoked_at FROM tokens WHERE token_hash = ?",
      )
      .get(digest) as
      | { token_id: string; label: string | null; expires_at: string | null; revoked_at: string | null }
      | undefined;
    if (!row || row.revoked_at) return undefined;
    if (row.expires_at && row.expires_at <= now()) return undefined;
    this.db
      .prepare("UPDATE tokens SET last_used_at = ? WHERE token_id = ?")
      .run(now(), row.token_id);
    return { tokenId: row.token_id, label: row.label };
  }

  /** 兼容旧中间件签名：仅判有效与否 */
  hasToken(token: string): boolean {
    return this.resolveToken(token) !== undefined;
  }

  listTokens(): Array<{
    token_id: string;
    label: string | null;
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    last_used_at: string | null;
  }> {
    return this.db
      .prepare(
        "SELECT token_id, label, created_at, expires_at, revoked_at, last_used_at FROM tokens ORDER BY created_at DESC",
      )
      .all() as unknown as Array<{
      token_id: string;
      label: string | null;
      created_at: string;
      expires_at: string | null;
      revoked_at: string | null;
      last_used_at: string | null;
    }>;
  }

  /** 按 ID 撤销（列表展示的是非密 ID，用户无需保存完整 token） */
  revokeTokenById(tokenId: string): boolean {
    const r = this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL")
      .run(now(), tokenId);
    return Number(r.changes) > 0;
  }

  /** 按原值撤销（logout：当前请求携带的 token） */
  revokeByRawToken(token: string): boolean {
    const r = this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .run(now(), Store.hashToken(token));
    return Number(r.changes) > 0;
  }

  // ---------- 变更日志（多端同步） ----------
  /** D50：变更日志落库后的进程内广播钩子（buildApp 挂 SSE 推送；异常绝不影响写入主路径） */
  onRecorded?: (ch: { entity: string; entity_id: string; op: string; device: string | null }) => void;

  recordChange(entity: string, entityId: string, op: string, payload: unknown, device?: string): void {
    const dev = device ?? this.syncApplyDevice ?? null;
    this.db
      .prepare(
        "INSERT INTO changes (entity, entity_id, op, payload, device, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(entity, entityId, op, JSON.stringify(payload ?? null), dev, now());
    try {
      this.onRecorded?.({ entity, entity_id: entityId, op, device: dev });
    } catch {
      /* 广播失败不影响主路径；SSE 客户端靠兜底告警自愈 */
    }
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

  // ---------- 操作审计日志（D58：认证/令牌/配置/发布四类事件） ----------
  /**
   * 记一条审计事件。红线：detail 是一行人类可读摘要，
   * 绝不落密码/token 原值或摘要/apiKey——调用方负责脱敏。
   * source = 客户端标识（IP 或 clientKey），单用户部署下用于追溯来源。
   */
  audit(kind: string, detail: string, source?: string | null): void {
    this.db
      .prepare("INSERT INTO audit_log (kind, detail, source, created_at) VALUES (?,?,?,?)")
      .run(kind, detail.slice(0, 300), source?.slice(0, 100) ?? null, now());
  }

  listAudit(limit = 100): Array<{ id: number; kind: string; detail: string | null; source: string | null; created_at: string }> {
    return this.db
      .prepare(
        `SELECT id, kind, detail, source, created_at FROM audit_log ORDER BY id DESC LIMIT ${Math.min(limit, 500)}`,
      )
      .all() as unknown as Array<{
      id: number;
      kind: string;
      detail: string | null;
      source: string | null;
      created_at: string;
    }>;
  }

  /**
   * 增长表保留裁剪（D58，NAS 单文件 SQLite 红线——三张只增不减的表此前无任何清理）：
   *  - changes：同步游标日志，保 14 天（设备长期离线漏拉由 D53 treesDiffer catch-up 全量对齐兜底，裁剪安全）；
   *  - events：产品埋点，保 90 天；
   *  - idempotency：导入幂等缓存，保 7 天；
   *  - audit_log：保最近 1000 条。
   * 幂等可重跑：调用点 = 启动一次 + startScheduler 每日一次。
   */
  pruneRetention(): { changes: number; events: number; idempotency: number; audit: number } {
    const count = (sql: string, ...args: Array<string | number>): number => {
      const r = this.db.prepare(sql).run(...args);
      return Number(r.changes);
    };
    const daysAgo = (d: number): string => new Date(Date.now() - d * 86400_000).toISOString();
    return {
      changes: count("DELETE FROM changes WHERE created_at < ?", daysAgo(14)),
      events: count("DELETE FROM events WHERE created_at < ?", daysAgo(90)),
      idempotency: count("DELETE FROM idempotency WHERE created_at < ?", daysAgo(7)),
      audit: count(
        "DELETE FROM audit_log WHERE id <= (SELECT MAX(id) - 1000 FROM audit_log)",
      ),
    };
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

  /** 归档建议清单（原型 14）：久收藏未归档非置顶——只建议不执行（红线③） */
  archiveCandidates(days = 730, limit = 50): Array<{ id: string; title: string; url_canonical: string; folder_id: string; added_at: string; hasSnapshot: boolean }> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, title, url_canonical, folder_id, added_at,
                (id IN (SELECT bookmark_id FROM snapshot)) AS has_snapshot
         FROM bookmarks
         WHERE status = 'normal' AND pinned = 0 AND archived_into IS NULL AND is_private = 0 AND added_at < ?
         ORDER BY added_at LIMIT ?`,
      )
      .all(cutoff, limit) as Array<{ id: string; title: string; url_canonical: string; folder_id: string; added_at: string; has_snapshot: number }>;
    return rows.map((r) => ({ ...r, hasSnapshot: r.has_snapshot === 1 }));
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
      r.api_key = r.api_key ? "********" : null; // 不回显明文（A4-2：展示永远脱敏）
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
    // A4-2：密钥加密保存（生产无 MF_SECRET_KEY 时拒绝保存明文）
    const protectedKey = protectKeyForStorage(input.apiKey ?? null);
    this.db
      .prepare(
        "INSERT INTO provider_config (id, provider_id, base_url, api_key, purpose_models, enabled, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, base_url=excluded.base_url, api_key=COALESCE(excluded.api_key, api_key), purpose_models=excluded.purpose_models, enabled=excluded.enabled",
      )
      .run(id, input.providerId, input.baseUrl, protectedKey, JSON.stringify(input.purposeModels ?? {}), input.enabled === false ? 0 : 1, now());
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
    return rows.map((r) => ({
      ...r,
      api_key: keyForUse(r.api_key), // A4-2：使用时解密（内存中短暂存在）
      purpose_models: JSON.parse(r.purpose_models),
    }));
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

  /**
   * 目录树 + 计数聚合（设计原则：计数由服务端 GROUP BY 聚合，
   * 客户端不拉全量书签数数——上万书签也是一次轻查询）
   */
  folderTree(privateVisibleOnly: boolean): Array<{
    id: string;
    name: string;
    parent_id: string | null;
    is_system_inbox: number;
    directCount: number;
    totalCount: number;
  }> {
    const folders = this.listFolders();
    const counts = new Map<string, number>();
    const rows = this.db
      .prepare("SELECT folder_id, COUNT(*) as c FROM bookmarks WHERE archived_into IS NULL GROUP BY folder_id")
      .all() as unknown as Array<{ folder_id: string; c: number }>;
    for (const r of rows) counts.set(r.folder_id, r.c);
    // 排除私密书签的计数（与列表可见性一致）
    if (privateVisibleOnly) {
      const visibleCounts = new Map<string, number>();
      const visRows = this.db
        .prepare("SELECT folder_id, COUNT(*) as c FROM bookmarks WHERE is_private = 0 AND archived_into IS NULL GROUP BY folder_id")
        .all() as unknown as Array<{ folder_id: string; c: number }>;
      for (const r of visRows) visibleCounts.set(r.folder_id, r.c);
      for (const f of folders) {
        counts.set(f.id, visibleCounts.get(f.id) ?? 0);
      }
    }
    // 子孙聚合：后序遍历（多轮收敛处理任意深度）
    const byParent = new Map<string | null, typeof folders>();
    for (const f of folders) {
      const arr = byParent.get(f.parent_id) ?? [];
      arr.push(f);
      byParent.set(f.parent_id, arr);
    }
    const totalCache = new Map<string, number>();
    const computeTotal = (id: string, seen = new Set<string>()): number => {
      if (totalCache.has(id)) return totalCache.get(id)!;
      if (seen.has(id)) return counts.get(id) ?? 0; // 防环
      seen.add(id);
      let total = counts.get(id) ?? 0;
      for (const child of byParent.get(id) ?? []) {
        total += computeTotal(child.id, seen);
      }
      totalCache.set(id, total);
      return total;
    };
    return folders.map((f) => ({
      id: f.id,
      name: f.name,
      parent_id: f.parent_id,
      is_system_inbox: f.is_system_inbox,
      directCount: counts.get(f.id) ?? 0,
      totalCount: computeTotal(f.id),
    }));
  }

  // ==================== nav（DEV-01：显式发布集合 / 密码 / revision） ====================

  /** 加密随机 slug（不可枚举；冲突时上层重试） */
  static newNavSlug(): string {
    return randomBytes(9).toString("base64url");
  }

  saveNavSite(slug: string, title: string): void {
    this.db
      .prepare(
        "INSERT INTO nav_site (slug, title, visibility, template, password_hash, published, revision, created_at, updated_at) VALUES (?,?, 'private', 'grid', NULL, 0, 1, ?, ?)",
      )
      .run(slug, title, now(), now());
  }

  getNavSite(slug: string): { slug: string; title: string } | undefined {
    return this.db.prepare("SELECT slug, title FROM nav_site WHERE slug = ?").get(slug) as
      | { slug: string; title: string }
      | undefined;
  }

  getNavSiteFull(slug: string): {
    slug: string;
    title: string;
    template: string;
    password_hash: string | null;
    published: number;
    revision: number;
    updated_at: string | null;
  } | undefined {
    return this.db
      .prepare(
        "SELECT slug, title, template, password_hash, published, revision, updated_at FROM nav_site WHERE slug = ?",
      )
      .get(slug) as
      | {
          slug: string;
          title: string;
          template: string;
          password_hash: string | null;
          published: number;
          revision: number;
          updated_at: string | null;
        }
      | undefined;
  }

  /**
   * DEV-01 PATCH 语义：以完整当前配置为基线，缺字段保持原值，显式 null 才移除密码。
   * （修复 E02：旧实现未传 password/template 时清空密码/重置模板）
   */
  updateNavSite(
    slug: string,
    patch: { title?: string; template?: string; passwordHash?: string | null },
  ): void {
    const current = this.getNavSiteFull(slug);
    if (!current) return;
    this.db
      .prepare(
        "UPDATE nav_site SET title = ?, template = ?, password_hash = ?, updated_at = ? WHERE slug = ?",
      )
      .run(
        patch.title !== undefined ? patch.title : current.title,
        patch.template !== undefined ? patch.template : current.template,
        patch.passwordHash !== undefined ? patch.passwordHash : current.password_hash,
        now(),
        slug,
      );
    // 修改密码/模板影响已授权访客 → 撤销旧访问凭证（revision 入 cookie 签名）
    if (patch.passwordHash !== undefined) this.bumpNavRevision(slug);
  }

  /** 目录改名后保持发布集合有效（发布集合存 folder_id，不受改名影响；此处仅 bump） */
  bumpNavRevision(slug: string): void {
    this.db
      .prepare("UPDATE nav_site SET revision = revision + 1, updated_at = ? WHERE slug = ?")
      .run(now(), slug);
  }

  /**
   * 发布/更新发布集合（事务）：显式选择的书签与目录，写入后 published=1 并 bump revision。
   * 只发布显式集合；未选择任何项 = 拒绝发布（默认私有红线）。
   */
  publishNavSite(
    slug: string,
    selection: { folderIds: string[]; bookmarkIds: string[] },
    meta: { title?: string; template?: string; passwordHash?: string | null } = {},
  ): { itemCount: number } {
    const site = this.getNavSiteFull(slug);
    if (!site) throw new Error("site_not_found");
    if (selection.folderIds.length === 0 && selection.bookmarkIds.length === 0) {
      throw new Error("empty_publication_scope");
    }
    const db = this.db;
    db.exec("BEGIN");
    try {
      // 校验引用存在（防悬挂）
      const bmIds = selection.bookmarkIds.filter((id) => this.getBookmark(id));
      const folderIds = selection.folderIds.filter((id) => this.getFolder(id));
      db.prepare("DELETE FROM nav_site_folder WHERE slug = ?").run(slug);
      db.prepare("DELETE FROM nav_site_bookmark WHERE slug = ?").run(slug);
      const insF = db.prepare("INSERT OR IGNORE INTO nav_site_folder (slug, folder_id) VALUES (?,?)");
      for (const fid of folderIds) insF.run(slug, fid);
      const insB = db.prepare("INSERT OR IGNORE INTO nav_site_bookmark (slug, bookmark_id) VALUES (?,?)");
      for (const bid of bmIds) insB.run(slug, bid);
      const itemCount = this.navSiteItems(slug).length;
      if (itemCount === 0) throw new Error("empty_publication_scope");
      db.prepare(
        "UPDATE nav_site SET published = 1, revision = revision + 1, title = ?, template = ?, password_hash = ?, updated_at = ? WHERE slug = ?",
      ).run(
        meta.title !== undefined ? meta.title : site.title,
        meta.template !== undefined ? meta.template : site.template,
        meta.passwordHash !== undefined ? meta.passwordHash : site.password_hash,
        now(),
        slug,
      );
      db.exec("COMMIT");
      return { itemCount };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 撤销发布：published=0 + bump revision（旧访问凭证与发布集合同时失效） */
  unpublishNavSite(slug: string): boolean {
    const site = this.getNavSiteFull(slug);
    if (!site) return false;
    this.db
      .prepare("UPDATE nav_site SET published = 0, revision = revision + 1, updated_at = ? WHERE slug = ?")
      .run(now(), slug);
    return true;
  }

  /** 显式发布集合（发布配置回显用；不含展开的书签） */
  navSiteScope(slug: string): { folderIds: string[]; bookmarkIds: string[] } {
    const folders = this.db
      .prepare("SELECT folder_id FROM nav_site_folder WHERE slug = ?")
      .all(slug) as unknown as Array<{ folder_id: string }>;
    const bookmarks = this.db
      .prepare("SELECT bookmark_id FROM nav_site_bookmark WHERE slug = ?")
      .all(slug) as unknown as Array<{ bookmark_id: string }>;
    return {
      folderIds: folders.map((r) => r.folder_id),
      bookmarkIds: bookmarks.map((r) => r.bookmark_id),
    };
  }

  /**
   * 公开站数据：仅显式集合内的书签（目录展开 + 单选书签），过滤私密/软归档/归档态，
   * 仅元数据 + 允许的 L1 摘要——不含正文（l2_text）、不含快照内容、不含内部字段。
   */
  navSiteItems(slug: string): Array<{
    id: string;
    folder_id: string;
    title: string;
    url_raw: string;
    favicon_url: string | null;
    dead: boolean;
    summary: string | null;
    site_type: string | null;
    has_snapshot: boolean;
  }> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT b.id, b.folder_id, b.title, b.url_raw, b.favicon_url, b.status, b.site_type, c.l1_summary,
                (b.id IN (SELECT bookmark_id FROM snapshot)) AS has_snapshot
         FROM bookmarks b
         LEFT JOIN content_cache c ON c.bookmark_id = b.id
         WHERE b.archived_into IS NULL AND b.is_private = 0 AND b.status != 'archived'
           AND (b.id IN (SELECT bookmark_id FROM nav_site_bookmark WHERE slug = ?)
                OR b.folder_id IN (SELECT folder_id FROM nav_site_folder WHERE slug = ?))`,
      )
      .all(slug, slug) as unknown as Array<{
      id: string;
      folder_id: string;
      title: string;
      url_raw: string;
      favicon_url: string | null;
      status: string;
      site_type: string | null;
      l1_summary: string | null;
      has_snapshot: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      folder_id: r.folder_id,
      title: r.title,
      url_raw: r.url_raw,
      favicon_url: r.favicon_url,
      dead: r.status === "dead",
      summary: r.l1_summary,
      site_type: r.site_type,
      has_snapshot: r.has_snapshot === 1,
    }));
  }

  navSites(): Array<{
    slug: string;
    title: string;
    template: string;
    published: number;
    revision: number;
  }> {
    return this.db
      .prepare(
        "SELECT slug, title, template, published, revision FROM nav_site ORDER BY created_at DESC",
      )
      .all() as unknown as Array<{
      slug: string;
      title: string;
      template: string;
      published: number;
      revision: number;
    }>;
  }

  // ---------- 原型补齐底座（2026-11-20，迁移 v8） ----------

  /** 快照存在性（导航卡「📸 有快照」标识 / 书签库筛选；红线④：仅状态，永不给内容） */
  hasSnapshot(bookmarkId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM snapshot WHERE bookmark_id = ? LIMIT 1").get(bookmarkId);
    return row !== undefined;
  }

  /** 快照版本列表（原型 08/11：版本切换 tabs + 详情抽屉） */
  listSnapshots(bookmarkId: string): Array<{ id: string; created_at: string; size: number; via: string }> {
    return this.db
      .prepare("SELECT id, created_at, size, via FROM snapshot WHERE bookmark_id = ? ORDER BY created_at DESC")
      .all(bookmarkId) as Array<{ id: string; created_at: string; size: number; via: string }>;
  }

  /** 站点化分析：写回单条 site_type（D30/D31；分析是投影，不改其它书签数据） */
  setSiteType(bookmarkId: string, siteType: string | null): void {
    this.db.prepare("UPDATE bookmarks SET site_type = ? WHERE id = ?").run(siteType, bookmarkId);
  }

  countBySiteType(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT COALESCE(site_type, 'unanalyzed') AS k, COUNT(*) AS c FROM bookmarks WHERE archived_into IS NULL GROUP BY k",
      )
      .all() as Array<{ k: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.k, r.c]));
  }

  listBySiteType(siteType: string, limit = 500): Array<{ id: string; title: string; url_canonical: string; folder_id: string }> {
    return this.db
      .prepare(
        "SELECT id, title, url_canonical, folder_id FROM bookmarks WHERE site_type = ? AND archived_into IS NULL ORDER BY added_at DESC LIMIT ?",
      )
      .all(siteType, limit) as Array<{ id: string; title: string; url_canonical: string; folder_id: string }>;
  }

  /** 站点投影缓存（分析结果可随时重建；存 prefs JSON） */
  saveProjection(projection: object): void {
    this.setPref("nav_projection", { ...projection, built_at: now() });
  }

  getProjection():
    | (Record<string, unknown> & { built_at?: string })
    | undefined {
    return this.getPref("nav_projection") as
      | (Record<string, unknown> & { built_at?: string })
      | undefined;
  }

  // ---------- nav_site.config（原型 13：主题色/引擎/显示选项/水印/自定义卡/包含资料站） ----------
  getNavSiteConfig(slug: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT config FROM nav_site WHERE slug = ?").get(slug) as
      | { config: string | null }
      | undefined;
    if (!row?.config) return {};
    try {
      return JSON.parse(row.config) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  setNavSiteConfig(slug: string, config: Record<string, unknown>): void {
    this.db
      .prepare("UPDATE nav_site SET config = ?, updated_at = ? WHERE slug = ?")
      .run(JSON.stringify(config), now(), slug);
  }

  // ---------- D33 集成 Hook（出站 Webhook） ----------
  listHooks(): Array<{
    id: string; label: string; url: string; events: string[];
    granularity: string; enabled: number; has_secret: boolean; created_at: string;
  }> {
    const rows = this.db
      .prepare("SELECT * FROM hook ORDER BY created_at")
      .all() as Array<{ id: string; label: string; url: string; events: string; granularity: string; secret: string | null; enabled: number; created_at: string }>;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      url: r.url,
      events: JSON.parse(r.events) as string[],
      granularity: r.granularity,
      enabled: r.enabled,
      has_secret: Boolean(r.secret),
      created_at: r.created_at,
    }));
  }

  saveHook(input: {
    id?: string; label: string; url: string; events: string[];
    granularity?: string; secret?: string | null; enabled?: boolean;
  }): { id: string } {
    const id = input.id ?? newId();
    const granularity = input.granularity ?? "meta";
    const enabled = input.enabled === false ? 0 : 1;
    if (input.id) {
      // 更新：secret 为 undefined = 保持原值，null = 清除
      const current = this.db.prepare("SELECT secret FROM hook WHERE id = ?").get(input.id) as { secret: string | null } | undefined;
      if (!current) throw new Error("hook_not_found");
      const secret = input.secret === undefined ? current.secret : input.secret;
      this.db
        .prepare("UPDATE hook SET label=?, url=?, events=?, granularity=?, secret=?, enabled=? WHERE id=?")
        .run(input.label, input.url, JSON.stringify(input.events), granularity, secret, enabled, id);
    } else {
      this.db
        .prepare("INSERT INTO hook (id, label, url, events, secret, granularity, enabled, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, input.label, input.url, JSON.stringify(input.events), input.secret ?? null, granularity, enabled, now());
    }
    return { id };
  }

  deleteHook(id: string): boolean {
    const r = this.db.prepare("DELETE FROM hook WHERE id = ?").run(id);
    return r.changes > 0;
  }

  getHook(id: string): { id: string; label: string; url: string; events: string[]; secret: string | null; granularity: string; enabled: number } | undefined {
    const r = this.db.prepare("SELECT * FROM hook WHERE id = ?").get(id) as
      | { id: string; label: string; url: string; events: string; secret: string | null; granularity: string; enabled: number }
      | undefined;
    return r ? { ...r, events: JSON.parse(r.events) as string[] } : undefined;
  }

  enabledHooksForEvent(event: string): Array<{ id: string; label: string; url: string; secret: string | null; granularity: string }> {
    return this.listHooks()
      .filter((h) => h.enabled === 1 && h.events.includes(event))
      .map((h) => ({ id: h.id, label: h.label, url: h.url, secret: null, granularity: h.granularity }));
  }

  // ---------- 收纳盒条目状态机（原型 06） ----------
  upsertInboxState(bookmarkId: string, state: string, confidence?: number | null, reason?: string | null, attempts?: number): void {
    this.db
      .prepare(
        "INSERT INTO inbox_state (bookmark_id, state, confidence, reason, attempts, updated_at) VALUES (?,?,?,?,?,?) " +
          "ON CONFLICT(bookmark_id) DO UPDATE SET state=excluded.state, confidence=excluded.confidence, reason=excluded.reason, " +
          "attempts=excluded.attempts, updated_at=excluded.updated_at",
      )
      .run(bookmarkId, state, confidence ?? null, reason ?? null, attempts ?? 0, now());
  }

  getInboxState(bookmarkId: string): { state: string; confidence: number | null; reason: string | null; attempts: number } | undefined {
    return this.db.prepare("SELECT state, confidence, reason, attempts FROM inbox_state WHERE bookmark_id = ?").get(bookmarkId) as
      | { state: string; confidence: number | null; reason: string | null; attempts: number }
      | undefined;
  }

  clearInboxState(bookmarkId: string): void {
    this.db.prepare("DELETE FROM inbox_state WHERE bookmark_id = ?").run(bookmarkId);
  }

  setInboxStateVersion(bookmarkId: string, versionId: string): void {
    this.db.prepare("UPDATE inbox_state SET version_id = ? WHERE bookmark_id = ?").run(versionId, bookmarkId);
  }

  /** 收纳盒面板「已自动归位」区：最近 placed 条目（已移出箱，含撤销入口的版本） */
  listInboxRecentPlaced(limit = 5): Array<{
    bookmark_id: string; title: string; url_canonical: string; reason: string | null;
    updated_at: string; version_id: string | null; folder_name: string | null;
  }> {
    // D54：带归位目标目录名（用户的核心问题「它去哪了」）
    return this.db
      .prepare(
        `SELECT s.bookmark_id, b.title, b.url_canonical, s.reason, s.updated_at, s.version_id,
                f.name AS folder_name
         FROM inbox_state s
         JOIN bookmarks b ON b.id = s.bookmark_id
         LEFT JOIN folders f ON f.id = b.folder_id
         WHERE s.state = 'placed' AND b.archived_into IS NULL
         ORDER BY s.updated_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      bookmark_id: string; title: string; url_canonical: string; reason: string | null;
      updated_at: string; version_id: string | null; folder_name: string | null;
    }>;
  }

  /** 收纳盒面板数据：箱内书签 + 状态（无状态行默认 pending） */
  listInboxWithState(): Array<{
    id: string; title: string; url_canonical: string; added_at: string; is_private: number;
    state: string; confidence: number | null; reason: string | null; attempts: number;
  }> {
    const inbox = this.inboxFolder();
    if (!inbox) return [];
    const rows = this.db
      .prepare(
        `SELECT b.id, b.title, b.url_canonical, b.added_at, b.is_private,
                COALESCE(s.state, 'pending') AS state, s.confidence, s.reason, COALESCE(s.attempts, 0) AS attempts
         FROM bookmarks b LEFT JOIN inbox_state s ON s.bookmark_id = b.id
         WHERE b.folder_id = ? AND b.archived_into IS NULL
         ORDER BY b.added_at DESC LIMIT 200`,
      )
      .all(inbox.id) as Array<{
      id: string; title: string; url_canonical: string; added_at: string; is_private: number;
      state: string; confidence: number | null; reason: string | null; attempts: number;
    }>;
    return rows;
  }

  /** 隐私域名本地记忆规则（不走 AI，按域名自动归位）：prefs JSON domain→folderId */
  getDomainPlaceRules(): Record<string, string> {
    return (this.getPref("domain_place_rules") as Record<string, string>) ?? {};
  }

  setDomainPlaceRule(domain: string, folderId: string | null): void {
    const rules = this.getDomainPlaceRules();
    if (folderId === null) delete rules[domain];
    else rules[domain] = folderId;
    this.setPref("domain_place_rules", rules);
  }

  /** 整理偏好记忆（原型 12）：用户可查看/删除的规则，注入整理 LLM system prompt */
  getOrganizeRules(): string[] {
    return (this.getPref("organize_rules") as string[]) ?? [];
  }

  setOrganizeRules(rules: string[]): void {
    this.setPref("organize_rules", rules);
  }

  addOrganizeRule(rule: string): void {
    const rules = this.getOrganizeRules();
    if (!rules.includes(rule)) rules.push(rule);
    this.setOrganizeRules(rules);
  }

  // ---------- D29 最常访问（应用内点击计数） ----------
  recordBookmarkClick(bookmarkId: string): void {
    this.db
      .prepare(
        "INSERT INTO bookmark_click (bookmark_id, clicks, last_at) VALUES (?,1,?) " +
          "ON CONFLICT(bookmark_id) DO UPDATE SET clicks = clicks + 1, last_at = excluded.last_at",
      )
      .run(bookmarkId, now());
  }

  topClickedBookmarks(limit = 8): Array<{ id: string; title: string; url_canonical: string; favicon_url: string | null; clicks: number }> {
    return this.db
      .prepare(
        `SELECT b.id, b.title, b.url_canonical, b.favicon_url, c.clicks
         FROM bookmark_click c JOIN bookmarks b ON b.id = c.bookmark_id
         WHERE b.archived_into IS NULL AND b.is_private = 0 AND b.status != 'archived'
         ORDER BY c.clicks DESC, c.last_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; title: string; url_canonical: string; favicon_url: string | null; clicks: number }>;
  }
}
