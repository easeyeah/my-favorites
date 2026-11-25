/** 仓储层 —— 全部 SQL 集中在此，路由不直接摸 SQL */
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { canonicalizeUrl, INBOX_FOLDER_TITLE, isPrivacyDomain } from "@mf/shared";
import type { Db } from "./db";
import { newId, now } from "./db";
import { protectKeyForStorage, keyForUse } from "./secret-box";
import { currentSyncDevice, currentUserId } from "./tenancy";

export interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  sort: number;
  source: string;
  is_system_inbox: number;
  created_at: string;
  /** D81 §3-A：浏览器根映射（bar=书签栏 / other=其他书签）——不同根下同名目录不串号 */
  root?: string;
  /** 目录修订号（D81 复核 R05，v16）：改名/搬家递增；同步回执与变更载荷携带，baseRevision 冲突检测依据 */
  rev?: number;
}

/** 目录变更载荷统一出口（upsert/move 共用字段口径：id/name/parent_id/root/rev） */
const folderChangePayload = (f: FolderRow): Record<string, unknown> => ({
  id: f.id,
  name: f.name,
  parent_id: f.parent_id,
  root: f.root === "other" ? "other" : "bar",
  rev: f.rev ?? 0,
});

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
  /** D91 收纳盒自动转资料：非 NULL = 已软移出书签体系（资料面正常可见，书签面/同步快照排除） */
  materialized_at?: string | null;
  materialized_from_folder_id?: string | null;
  materialized_generation?: number;
  materialized_version_id?: string | null;
  /** A3-4 冲突检测：用户手动修改计数（提案前后对比） */
  content_revision?: number;
  /** D30 站点化三类标注（site_tool/site_ref/content；null = 未分析） */
  site_type?: string | null;
  /** 疑似失效连续周期（原型 14：连续 2 周期升级确认候选） */
  suspect_streak?: number;
  /** 可解释失败原因（报告明细「为什么访问不了」） */
  last_fail_reason?: string | null;
  /** 查重键规则版本（DEV-13；url 编辑时随 canonical 一并更新） */
  url_key_version?: number;
}

export interface MaterialConversionCandidate {
  bookmark_id: string;
  entry_id: string;
  url_raw: string;
  content_revision: number;
  privacy_revision: number;
  state: string;
  authorized_text: string | null;
  evidence_kind: string | null;
  attempts: number;
  fail_reason: string | null;
  next_attempt_at: string | null;
  updated_at: string;
}

/** D92 目录整理任务状态（计数口径：total = moved + converted + unchanged + skipped + failed + remaining） */
export type OrganizeTaskStatus =
  | "queued"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "completed_with_issues"
  | "failed";

export interface OrganizeTaskRow {
  id: string;
  request_id: string;
  folder_id: string;
  folder_name: string;
  status: OrganizeTaskStatus;
  /** scope | evidence | plan | commit | summarize */
  phase: string;
  /** 运行器阶段说明（进行中的批次/等待；仅本进程内存态，重启后为空） */
  phase_note: string | null;
  /** ai | rule_only */
  mode: string;
  total: number;
  moved: number;
  converted: number;
  new_materials: number;
  reused_materials: number;
  unchanged: number;
  skipped: number;
  failed: number;
  /** 受保护条目数（私密/隐私域/敏感宿主）：计入 skipped，不落明细行 */
  protected_count: number;
  excluded_archived: number;
  planned_new_folders: number;
  created_folders: number;
  reused_folders: number;
  planned_categories: number;
  new_categories: number;
  reused_categories: number;
  plan_json: string | null;
  error: string | null;
  lease: string | null;
  lease_at: string | null;
  revision: number;
  can_continue: number;
  continue_expires_at: string | null;
  /** none | pending | running | completed | partial | failed */
  undo_status: string;
  undo_cursor: number;
  undo_restored: number;
  undo_kept: number;
  undo_categories: number;
  undo_folders: number;
  created_at: string;
  started_at: string | null;
  phase_at: string | null;
  finished_at: string | null;
}

/** 任务内一条来源收藏：await 前基线 + 逐条判断。decision = remaining | moved | converted | keep | skip | fail */
export interface OrganizeTaskItemRow {
  id: string;
  task_id: string;
  bookmark_id: string;
  seq: number;
  title: string | null;
  base_folder_id: string;
  base_revision: number;
  privacy_revision: number;
  /** bookmark | material | undetermined（规划后确定） */
  kind: string | null;
  material_type: string | null;
  /** cache | crawl | url_rule */
  evidence_ref: string | null;
  decision: string;
  reason: string | null;
  plan_decision: string | null;
  plan_target_key: string | null;
  plan_category: string | null;
  plan_material_type: string | null;
  plan_reason: string | null;
  from_path: string | null;
  to_path: string | null;
  category_before: string | null;
  /** absent | active | dismissed */
  material_before: string | null;
  attempts: number;
  batch: number | null;
  version_id: string | null;
  retryable: number;
  updated_at: string;
}

export interface MaterialFilter {
  type?: string;
  q?: string;
  tag?: string;
  category?: string;
  uncategorized?: boolean;
  folderId?: string;
  limit?: number;
  offset?: number;
  includePrivate?: boolean;
}

export class Store {
  /**
   * D67：数据源可以是固定 Db（自建/既有测试）或解析器（云端按请求上下文取用户库）。
   * this.db 每次访问时解析——公开路由/后台无上下文时回退主库（tenancy.ts）。
   */
  private readonly dbSource: Db | (() => Db);

  constructor(dbSource: Db | (() => Db)) {
    this.dbSource = dbSource;
  }

  get db(): Db {
    return typeof this.dbSource === "function" ? this.dbSource() : this.dbSource;
  }

  // ---------- 变更日志（多端同步） ----------
  // D46 防回环的发起设备标记已迁至请求上下文（tenancy.currentSyncDevice）：
  // sync-apply 以 runAsSyncDevice 包裹执行体，产生的变更日志自动携带发起设备
  //（该设备 pullChanges 时被排除）；其他改动路径无上下文，device=null 全员下发。
  // D67 由单例可变字段改为 ALS——多用户下全局字段会跨用户污染防回环标记。

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

  /** 目录重命名（收纳盒等系统目录拒绝改名）。D81 复核 R05：递增 rev，变更载荷带 root/rev */
  renameFolder(id: string, name: string): FolderRow | undefined {
    const row = this.getFolder(id);
    if (!row || row.is_system_inbox === 1) return undefined;
    this.db.prepare("UPDATE folders SET name = ?, rev = rev + 1 WHERE id = ?").run(name, id);
    const after = this.getFolder(id)!;
    this.recordChange("folder", id, "upsert", folderChangePayload(after));
    return after;
  }

  /** 系统收纳盒改名：仅供 /inbox/setup 幂等校准（D36 术语迁移），用户面重命名仍走 renameFolder */
  renameSystemFolder(id: string, name: string): FolderRow | undefined {
    const row = this.getFolder(id);
    if (!row) return undefined;
    this.db.prepare("UPDATE folders SET name = ?, rev = rev + 1 WHERE id = ?").run(name, id);
    const after = this.getFolder(id)!;
    this.recordChange("folder", id, "upsert", folderChangePayload(after));
    return after;
  }

  findFolderByName(name: string): FolderRow | undefined {
    return this.db
      .prepare("SELECT * FROM folders WHERE name = ? ORDER BY sort LIMIT 1")
      .get(name) as FolderRow | undefined;
  }

  /**
   * 目录子树 ID 集合（含自身）。D89：目录级整理/资料提取的作用域——
   * 树是扁平 parent_id 结构，用一次全量目录表在内存做闭包，避免递归 SQL。
   */
  folderSubtreeIds(folderId: string): string[] {
    const folders = this.listFolders();
    const children = new Map<string | null, string[]>();
    for (const f of folders) {
      const key = f.parent_id ?? null;
      const arr = children.get(key) ?? [];
      arr.push(f.id);
      children.set(key, arr);
    }
    const out: string[] = [];
    const queue = [folderId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      for (const child of children.get(id) ?? []) queue.push(child);
    }
    return out;
  }

  /** D81 §3-A：同父同名同根查找（folder.create 幂等绑定用；根级含悬空父，与 ensurePath 同口径） */
  findFolderUnder(name: string, parentId: string | null, root = "bar"): FolderRow | undefined {
    return (parentId
      ? this.db.prepare("SELECT * FROM folders WHERE name = ? AND parent_id = ? AND IFNULL(root,'bar') = ? LIMIT 1").get(name, parentId, root)
      : this.db
          .prepare(
            `SELECT * FROM folders WHERE name = ?
             AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM folders))
             AND IFNULL(root,'bar') = ?
             ORDER BY (parent_id IS NULL) DESC, sort, name LIMIT 1`,
          )
          .get(name, root)) as FolderRow | undefined;
  }

  /** 初次同步只认领本设备尚未占用的候选；同名兄弟是不同实体，不按名称合并。 */
  findUnclaimedFolderUnder(name: string, parentId: string | null, root: string, deviceId: string): FolderRow | undefined {
    return this.db.prepare(
      `SELECT f.* FROM folders f
       WHERE f.name = ? AND IFNULL(f.root,'bar') = ?
         AND (f.parent_id = ? OR (? IS NULL AND (f.parent_id IS NULL OR f.parent_id NOT IN (SELECT id FROM folders))))
         AND NOT EXISTS (SELECT 1 FROM folder_identity i WHERE i.device_id = ? AND i.app_folder_id = f.id)
       ORDER BY (f.parent_id IS NULL) DESC, f.sort, f.rowid LIMIT 1`,
    ).get(name, root, parentId, parentId, deviceId) as FolderRow | undefined;
  }

  createFolder(
    name: string,
    parentId: string | null,
    source = "user",
    isSystemInbox = false,
    root = "bar",
  ): FolderRow {
    const row: FolderRow = {
      id: newId(),
      parent_id: parentId,
      name,
      sort: Date.now() % 1e9,
      source,
      is_system_inbox: isSystemInbox ? 1 : 0,
      created_at: now(),
      root,
      rev: 0,
    };
    this.db
      .prepare(
        "INSERT INTO folders (id, parent_id, name, sort, source, is_system_inbox, created_at, root, rev) VALUES (?,?,?,?,?,?,?,?,0)",
      )
      .run(
        row.id,
        row.parent_id,
        row.name,
        row.sort,
        row.source,
        row.is_system_inbox,
        row.created_at,
        root,
      );
      this.recordChange("folder", row.id, "upsert", folderChangePayload(row));
    return row;
  }

  /** 沿 folderPath 逐级 find-or-create（ingest 的目录树映射）。D81：root 维度隔离同名目录 */
  ensurePath(path: string[], root = "bar"): FolderRow {
    let parentId: string | null = null;
    let current: FolderRow | null = null;
    for (const name of path) {
      // D79：根级匹配含「悬空父」目录（parent_id 指向不存在的 id，如传入浏览器根 "1"）——
      // 扩展 fetchAppFolders 的路径构造把悬空父视同根级，ensurePath 必须同口径，
      // 否则同名根目录被重复创建（create 绑定尊重目录后暴露：绑定把书签移进重复目录）
      const stmt = current
        ? this.db.prepare(
            "SELECT * FROM folders WHERE name = ? AND parent_id = ? AND IFNULL(root,'bar') = ? LIMIT 1",
          )
        : this.db.prepare(
            `SELECT * FROM folders WHERE name = ?
             AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM folders))
             AND IFNULL(root,'bar') = ?
             ORDER BY (parent_id IS NULL) DESC, sort, name LIMIT 1`,
          );
      const found = (
        current ? stmt.get(name, current.id, root) : stmt.get(name, root)
      ) as FolderRow | undefined;
      current = found ?? this.createFolder(name, parentId, "imported", false, root);
      parentId = current.id;
    }
    // path 为空时落到根下的"未整理"（ loose 书签不分根，统一落 bar 的未整理）
    return current ?? this.ensurePath(["未整理"]);
  }

  /**
   * D81 §3-A / 复核 R04：目录搬家（reparent）——父目录与根归属纳入同一次移动。
   *  - 根继承：搬到某父目录下 → 继承该父的 root；搬到根级（newParentId=null）→ 取 newRoot ?? 当前 root；
   *  - 跨根移动 → 子孙 root 在同一事务内一致更新（root 逐行存储，不更新则子树路径键与另一根串号）；
   *  - 无变化判定 = 父相同 **且** 根相同（两端 parent_id 同为 null 的跨根移动不是 noop）；
   *  - 校验父存在、禁止成环；系统收纳盒不可移动。
   * 变更日志 op=move，载荷 {to, parent_id, root, rev} 供同步引擎搬运浏览器节点并推进修订缓存。
   */
  moveFolder(id: string, newParentId: string | null, newRoot?: string): FolderRow | undefined {
    const row = this.getFolder(id);
    if (!row || row.is_system_inbox === 1) return undefined;
    const curRoot = row.root === "other" ? "other" : "bar";
    let targetRoot = curRoot;
    if (newParentId !== null) {
      const parent = this.getFolder(newParentId);
      if (!parent) return undefined;
      // 成环校验：从新父沿 parent_id 上溯，命中自身即成环
      let cur: FolderRow | undefined = parent;
      const seen = new Set<string>();
      while (cur && !seen.has(cur.id)) {
        if (cur.id === id) return undefined;
        seen.add(cur.id);
        cur = cur.parent_id ? this.getFolder(cur.parent_id) : undefined;
      }
      if (newParentId === id) return undefined;
      targetRoot = parent.root === "other" ? "other" : "bar";
    } else if (newRoot === "other" || newRoot === "bar") {
      targetRoot = newRoot;
    }
    if ((row.parent_id ?? null) === newParentId && targetRoot === curRoot) return row; // noop：父与根都未变
    this.db.exec("SAVEPOINT mf_move_folder");
    try {
      this.db.prepare("UPDATE folders SET parent_id = ?, rev = rev + 1 WHERE id = ?").run(newParentId, id);
      if (targetRoot !== curRoot) this.updateSubtreeRoot(id, targetRoot);
      this.recordChange("folder", id, "move", {
        id,
        to: newParentId,
        name: row.name,
        parent_id: newParentId,
        root: targetRoot,
        rev: (row.rev ?? 0) + 1,
      });
      this.db.exec("RELEASE mf_move_folder");
    } catch (err) {
      this.db.exec("ROLLBACK TO mf_move_folder");
      this.db.exec("RELEASE mf_move_folder");
      throw err;
    }
    return this.getFolder(id);
  }

  /** 子孙 root 一致更新（递归 CTE；R04：子树跨根搬家事务内同改） */
  private updateSubtreeRoot(rootId: string, root: string): void {
    this.db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT ?
           UNION ALL
           SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
         )
         UPDATE folders SET root = ? WHERE id IN (SELECT id FROM sub)`,
      )
      .run(rootId, root);
  }

  inboxFolder(): FolderRow | undefined {
    return this.db
      .prepare("SELECT * FROM folders WHERE is_system_inbox = 1 LIMIT 1")
      .get() as FolderRow | undefined;
  }

  deleteFolderIfEmpty(id: string): boolean {
    if (this.getFolder(id)?.is_system_inbox === 1) return false;
    const hasChildren = this.db
      .prepare("SELECT 1 FROM folders WHERE parent_id = ? LIMIT 1")
      .get(id);
    const hasBookmarks = this.db
      .prepare("SELECT 1 FROM bookmarks WHERE folder_id = ? LIMIT 1")
      .get(id);
    if (hasChildren || hasBookmarks) return false;
    const folderName = this.getFolder(id)?.name ?? "";
    this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
    this.deleteFolderIdentitiesForApp(id); // D81：目录身份随目录删除清理
    // D73：载荷带目录名——同步引擎按名定位浏览器对应目录（id 映射在目录删除后无法反查）
    this.recordChange("folder", id, "delete", { id, name: folderName });
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
    // D81：SAVEPOINT 替代 BEGIN——可嵌套于 sync-apply 的每操作 SAVEPOINT（原子性不变）
    this.db.exec("SAVEPOINT mf_dft");
    try {
      this.deleteFolderTreeInner(id, opts, acc);
      this.db.exec("RELEASE mf_dft");
    } catch (err) {
      this.db.exec("ROLLBACK TO mf_dft");
      this.db.exec("RELEASE mf_dft");
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
    const folderName = this.getFolder(id)?.name ?? "";
    this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
    this.deleteFolderIdentitiesForApp(id); // D81：目录身份随树删清理
    // D73：载荷带目录名（同上）
    this.recordChange("folder", id, "delete", { id, name: folderName });
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
    // 收藏落库、变更日志、新入口持久候选同事务，崩溃不能留下「已收藏但永远未登记」的空窗。
    this.db.exec("SAVEPOINT mf_create_bookmark");
    try {
      this.db.prepare(
        "INSERT INTO bookmarks (id, folder_id, url_raw, url_canonical, title, description, status, favicon_url, cover_url, added_at, last_checked_at, pinned, created_at, url_key_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        row.id, row.folder_id, row.url_raw, row.url_canonical, row.title, row.description,
        row.status, row.favicon_url, row.cover_url, row.added_at, row.last_checked_at,
        row.pinned, row.created_at, input.urlKeyVersion ?? 2,
      );
      // D81 R05：完整行含 DB 默认修订，端侧才能固定生成时的 baseRevision。
      this.recordChange("bookmark", row.id, "upsert", this.getBookmark(row.id)!);
      if (this.getFolder(input.folderId)?.is_system_inbox === 1) this.registerMaterialCandidate(row.id);
      this.db.exec("RELEASE mf_create_bookmark");
      return this.getBookmark(row.id)!;
    } catch (err) {
      this.db.exec("ROLLBACK TO mf_create_bookmark");
      this.db.exec("RELEASE mf_create_bookmark");
      throw err;
    }
  }

  updateBookmark(id: string, fields: Partial<BookmarkRow>): void {
    const before = this.getBookmark(id);
    // 隐藏行的 FK 锚点及生命周期仅由转换/恢复内核修改；普通后台更新不能移出锚点。
    const lifecycleCols = ["id", "materialized_at", "materialized_from_folder_id", "materialized_generation", "materialized_version_id"];
    const keys = Object.keys(fields).filter(
      (k) => !lifecycleCols.includes(k) && !(before?.materialized_at && k === "folder_id") && fields[k as keyof BookmarkRow] !== undefined,
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
    // 隐藏资料更新不得发活 upsert/move（会复活浏览器节点）；materialize 携带完整新修订。
    if (before?.materialized_at) {
      this.recordChange("bookmark", id, "materialize", this.getBookmark(id)!);
      return;
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
      // D81 复核 R05：move 载荷带 content_revision 与 url_raw——移动本身递增修订，
      // 端侧若仍持旧修订提交后续编辑会假冲突（用户修改被回退）
      this.recordChange("bookmark", id, "move", {
        from: null,
        to: String(fields.folder_id),
        url: after?.url_canonical,
        url_raw: after?.url_raw,
        title: after?.title,
        folder_id: String(fields.folder_id),
        content_revision: after?.content_revision ?? 0,
      });
    }
  }

  moveBookmark(id: string, toFolderId: string): BookmarkRow | undefined {
    const before = this.getBookmark(id);
    if (!before || before.materialized_at) return undefined;
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
    // D81 §3-D-4（D80 Tier2-D）：已同步设备停发镜像 ops——删除由同步引擎 pull 收敛，
    // 镜像 remove 与引擎两套机制搬同一节点是回环/竞态病灶；mirrorGuard 时间窗随之退役。
    for (const ident of this.identitiesForApp(id)) {
      if (opts.skipMirrorRemoveForDevice && ident.device_id === opts.skipMirrorRemoveForDevice) continue;
      if (this.deviceSyncEnabled(ident.device_id)) continue;
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

  /** 新收纳盒入口登记；已恢复/已取消的条目不会被自动重新转换。 */
  registerMaterialCandidate(bookmarkId: string, newEntry = false): void {
    const bm = this.getBookmark(bookmarkId);
    if (!bm || bm.materialized_at || (bm.materialized_generation ?? 0) > 0 ||
        this.getFolder(bm.folder_id)?.is_system_inbox !== 1) return;
    const previous = this.getMaterialCandidate(bookmarkId);
    if (previous && !newEntry) return;
    this.db.prepare(
      `INSERT INTO material_conversion_candidate
       (bookmark_id, entry_id, url_raw, content_revision, privacy_revision, updated_at)
       VALUES (?,?,?,?,?,?) ON CONFLICT(bookmark_id) DO UPDATE SET
       entry_id=excluded.entry_id, url_raw=excluded.url_raw, content_revision=excluded.content_revision,
       privacy_revision=excluded.privacy_revision, state='pending', authorized_text=NULL,
       evidence_kind=NULL, attempts=0, fail_reason=NULL, next_attempt_at=NULL, updated_at=excluded.updated_at`,
    ).run(bookmarkId, newId(), bm.url_raw, bm.content_revision ?? 1, this.privacyRevision(), now());
  }

  getMaterialCandidate(bookmarkId: string): MaterialConversionCandidate | undefined {
    return this.db.prepare("SELECT * FROM material_conversion_candidate WHERE bookmark_id = ?")
      .get(bookmarkId) as MaterialConversionCandidate | undefined;
  }

  materialCandidateMatches(cand: MaterialConversionCandidate): boolean {
    const bm = this.getBookmark(cand.bookmark_id);
    const current = this.getMaterialCandidate(cand.bookmark_id);
    return Boolean(bm && current && current.entry_id === cand.entry_id &&
      ["pending", "retry", "ready"].includes(current.state) &&
      !bm.materialized_at && !bm.archived_into && bm.status !== "archived" && bm.is_private !== 1 &&
      bm.url_raw === cand.url_raw && (bm.content_revision ?? 1) === cand.content_revision &&
      this.privacyRevision() === cand.privacy_revision &&
      !isPrivacyDomain(bm.url_raw, { patterns: this.privacyPatterns() }));
  }

  /** 仅自动归位/捕获元数据更新可重绑修订；用户移动/撤销通过 clearInboxState 永久取消资格。 */
  rebaseMaterialCandidate(bookmarkId: string, previousRevision: number): void {
    const bm = this.getBookmark(bookmarkId);
    if (!bm) return;
    this.db.prepare(`UPDATE material_conversion_candidate SET content_revision = ?, updated_at = ?
      WHERE bookmark_id = ? AND content_revision = ? AND state IN ('pending','retry') AND url_raw = ?`)
      .run(bm.content_revision ?? 1, now(), bookmarkId, previousRevision, bm.url_raw);
  }

  authorizeMaterialCandidateText(bookmarkId: string, text: string): void {
    const cand = this.getMaterialCandidate(bookmarkId);
    if (!cand || !this.materialCandidateMatches(cand)) return;
    this.db.prepare("UPDATE material_conversion_candidate SET authorized_text = ?, updated_at = ? WHERE bookmark_id = ?")
      .run(text.slice(0, 20_000), now(), bookmarkId);
  }

  setMaterialCandidateState(bookmarkId: string, state: string, reason: string | null = null, kind?: string): void {
    const retryAt = state === "retry" ? new Date(Date.now() + 60_000).toISOString() : null;
    this.db.prepare(`UPDATE material_conversion_candidate SET state = ?, fail_reason = ?, evidence_kind = ?,
      authorized_text = CASE WHEN ? IN ('done','cancelled') THEN NULL ELSE authorized_text END,
      next_attempt_at = ?, attempts = attempts + CASE WHEN ? = 'retry' THEN 1 ELSE 0 END, updated_at = ?
      WHERE bookmark_id = ?`).run(state, reason, kind ?? null, state, retryAt, state, now(), bookmarkId);
  }

  pendingMaterialCandidates(limit = 10): MaterialConversionCandidate[] {
    return this.db.prepare(`SELECT * FROM material_conversion_candidate
      WHERE state IN ('pending','retry','ready') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY updated_at, bookmark_id LIMIT ?`).all(now(), limit) as unknown as MaterialConversionCandidate[];
  }

  /** 短事务内：当前轮成功证据 + URL/实体/策略 CAS；隐藏行归唯一系统盒，避免普通目录树删级联毁资料。 */
  convertToMaterial(bookmarkId: string, undo?: { revision: number; generation: number; versionId: string }): { folderId: string } | false {
    const bm = this.getBookmark(bookmarkId);
    if (!bm || bm.archived_into || bm.status === "archived" || bm.materialized_at || bm.is_private === 1 ||
        isPrivacyDomain(bm.url_raw, { patterns: this.privacyPatterns() })) return false;
    if (undo) {
      if (bm.content_revision !== undo.revision || bm.materialized_generation !== undo.generation ||
          bm.materialized_version_id !== undo.versionId) return false;
    } else {
      const cand = this.getMaterialCandidate(bookmarkId);
      if (!cand || cand.state !== "ready" || !cand.evidence_kind || !this.materialCandidateMatches(cand) ||
          (bm.materialized_generation ?? 0) > 0) return false;
    }
    if (!this.getActiveMaterialByBookmark(bookmarkId)) return false;
    const inbox = this.inboxFolder() ?? this.createFolder(INBOX_FOLDER_TITLE, null, "user", true);
    this.db.prepare(`UPDATE bookmarks SET materialized_at = ?, materialized_from_folder_id = folder_id,
      folder_id = ?, content_revision = content_revision + 1,
      materialized_generation = materialized_generation + 1, materialized_version_id = NULL WHERE id = ?`)
      .run(now(), inbox.id, bookmarkId);
    this.upsertInboxState(bookmarkId, "placed", null, "资料库", 0);
    this.setMaterialCandidateState(bookmarkId, "done");
    this.recordChange("bookmark", bookmarkId, "materialize", this.getBookmark(bookmarkId)!);
    return { folderId: bm.folder_id };
  }

  /** 恢复仍保留资料；原普通目录不在则落「未整理」。恢复/撤销都取消自动转换资格。 */
  restoreMaterialBookmark(bookmarkId: string, expected?: { revision: number; generation: number; versionId: string }): BookmarkRow | undefined {
    const bm = this.getBookmark(bookmarkId);
    if (!bm?.materialized_at) return undefined;
    if (expected && (bm.content_revision !== expected.revision || bm.materialized_generation !== expected.generation ||
        bm.materialized_version_id !== expected.versionId)) return undefined;
    const original = bm.materialized_from_folder_id ? this.getFolder(bm.materialized_from_folder_id) : undefined;
    const target = original && !original.is_system_inbox ? original : this.ensurePath(["未整理"]);
    this.db.prepare(`UPDATE bookmarks SET materialized_at = NULL, folder_id = ?,
      content_revision = content_revision + 1, materialized_version_id = NULL WHERE id = ?`)
      .run(target.id, bookmarkId);
    this.setMaterialCandidateState(bookmarkId, "cancelled", "restored_by_user");
    this.setInboxConvertVersion(bookmarkId, null);
    this.markClassificationReviewed(bookmarkId);
    const after = this.getBookmark(bookmarkId)!;
    this.recordChange("bookmark", bookmarkId, "upsert", after);
    return after;
  }

  setMaterialVersion(bookmarkId: string, versionId: string): void {
    this.db.prepare("UPDATE bookmarks SET materialized_version_id = ? WHERE id = ?").run(versionId, bookmarkId);
    if (this.getBookmark(bookmarkId)?.materialized_at) this.setInboxConvertVersion(bookmarkId, versionId);
  }

  /**
   * D92 显式整理任务转资料：资格来自用户圈定的目录任务（不伪造收纳盒候选，也不借 undo 参数绕过）。
   * 调用方必须在同一短事务内已完成本轮内容证据校验；本方法内再查实体生命周期、隐私与资料状态。
   * 资料 + 分类 + 软移出必须同事务成立——任何一步不满足即返回 error，不留半转换。
   * 版本归属由调用方保存任务版本后经 setMaterialVersion 回填。
   */
  convertToMaterialFromTask(
    bookmarkId: string,
    input: { type: string; signals?: string[]; meta?: Record<string, unknown>; category: string[] },
  ):
    | {
        materialId: string;
        materialCreated: boolean;
        categoryBefore: string | null;
        categorySourceBefore: string | null;
        categoryRevisionAfter: number;
        fromFolderId: string;
      }
    | { error: "bookmark_unavailable" | "material_dismissed" | "category_invalid" }
  {
    const bm = this.getBookmark(bookmarkId);
    if (
      !bm ||
      bm.archived_into ||
      bm.status === "archived" ||
      bm.materialized_at ||
      bm.is_private === 1 ||
      isPrivacyDomain(bm.url_raw, { patterns: this.privacyPatterns() })
    ) {
      return { error: "bookmark_unavailable" };
    }
    const cleanCategory = input.category.map((s) => s.trim()).filter(Boolean);
    if (cleanCategory.length === 0 || cleanCategory.length > 2 || cleanCategory.some((s) => s.length > 20 || s.includes("/"))) {
      return { error: "category_invalid" };
    }
    const existing = this.db
      .prepare("SELECT id, status, category, category_source FROM material WHERE bookmark_id = ?")
      .get(bookmarkId) as { id: string; status: string; category: string | null; category_source: string | null } | undefined;
    // 此前已移出资料库是用户的决定：不隐式复活，也不隐藏对应书签
    if (existing && existing.status !== "active") return { error: "material_dismissed" };
    const materialId = existing?.id ?? this.upsertMaterial({ bookmarkId, type: input.type, signals: input.signals, meta: input.meta }).id;
    if (!this.setMaterialCategory(materialId, cleanCategory, { source: "organize_task" })) {
      return { error: "category_invalid" };
    }
    const inbox = this.inboxFolder() ?? this.createFolder(INBOX_FOLDER_TITLE, null, "user", true);
    this.db.prepare(`UPDATE bookmarks SET materialized_at = ?, materialized_from_folder_id = folder_id,
      folder_id = ?, content_revision = content_revision + 1,
      materialized_generation = materialized_generation + 1, materialized_version_id = NULL WHERE id = ?`)
      .run(now(), inbox.id, bookmarkId);
    // 显式整理即用户意图：退出旧收纳盒自动归位/自检/转换候选资格
    this.clearInboxState(bookmarkId);
    this.recordChange("bookmark", bookmarkId, "materialize", this.getBookmark(bookmarkId)!);
    return {
      materialId,
      materialCreated: !existing,
      categoryBefore: existing?.category ?? null,
      categorySourceBefore: existing?.category_source ?? null,
      categoryRevisionAfter: this.getMaterialCategoryState(materialId)!.category_revision,
      fromFolderId: bm.folder_id,
    };
  }

  /** D52：URL 编辑后正文缓存作废（快照是历史资产，保留） */
  clearCache(bookmarkId: string): void {
    this.db.prepare("DELETE FROM content_cache WHERE bookmark_id = ?").run(bookmarkId);
  }

  /** D46 首次对齐：本设备全部身份映射 + 应用侧书签是否仍存在（孤儿映射=库已删，浏览器侧待清） */
  identitiesWithState(deviceId: string): Array<{
    browser_bookmark_id: string; app_bookmark_id: string; app_exists: boolean;
    materialized: number; url_raw: string | null;
  }> {
    return this.db.prepare(
      `SELECT i.browser_bookmark_id, i.app_bookmark_id,
              (b.id IS NOT NULL AND b.materialized_at IS NULL AND b.archived_into IS NULL) AS app_exists,
              CASE WHEN b.materialized_at IS NOT NULL THEN 1 ELSE 0 END AS materialized,
              b.url_raw
       FROM bookmark_identity i LEFT JOIN bookmarks b ON b.id = i.app_bookmark_id
       WHERE i.device_id = ?`,
    ).all(deviceId) as unknown as Array<{
      browser_bookmark_id: string; app_bookmark_id: string; app_exists: boolean;
      materialized: number; url_raw: string | null;
    }>;
  }

  listBookmarks(filter?: {
    folderId?: string;
    /** D89：子树范围（IN 查询，目录级整理/资料扫描用；与 folderId 互斥选择） */
    folderIds?: string[];
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
    if (filter?.folderIds && filter.folderIds.length > 0) {
      const ids = filter.folderIds.slice(0, 500);
      // 极端子树（>500 目录）截断保护 SQL 变量上限——超出的深层分支本轮不进作用域，下轮续扫
      if (filter.folderIds.length > 500) {
        console.warn(`[listBookmarks] folderIds truncated 500/${filter.folderIds.length}`);
      }
      conds.push(`folder_id IN (${ids.map(() => "?").join(",")})`);
      args.push(...ids);
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
      ? `SELECT b.* FROM bookmarks b LEFT JOIN content_cache cc ON cc.bookmark_id = b.id ${where ? where + " AND" : "WHERE"} b.archived_into IS NULL AND b.materialized_at IS NULL ORDER BY b.pinned DESC, b.added_at DESC, b.id LIMIT ${limit} OFFSET ${offset}`
      : `SELECT * FROM bookmarks ${where ? where + " AND" : "WHERE"} archived_into IS NULL AND materialized_at IS NULL ORDER BY pinned DESC, added_at DESC, id LIMIT ${limit} OFFSET ${offset}`;
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
         WHERE b.archived_into IS NULL AND b.materialized_at IS NULL${privacyCond} AND (b.title LIKE ? OR b.url_canonical LIKE ? OR IFNULL(b.description,'') LIKE ? OR IFNULL(c.l2_text,'') LIKE ?)
         LIMIT ?`,
      )
      .all(like, like, like, like, limit) as unknown as BookmarkRow[];
  }

  countBookmarks(): { total: number; dead: number; suspect: number } {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as total, SUM(status='dead') as dead, SUM(status='suspect') as suspect FROM bookmarks WHERE archived_into IS NULL AND materialized_at IS NULL",
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
         WHERE c.bookmark_id IS NULL AND b.status = 'normal' AND b.archived_into IS NULL AND b.materialized_at IS NULL LIMIT ?`,
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
           AND (b.materialized_at IS NULL OR EXISTS (SELECT 1 FROM material m WHERE m.bookmark_id = b.id AND m.status = 'active'))
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
  private materialWhere(filter: MaterialFilter): { conds: string[]; args: (string | number)[] } {
    const conds: string[] = ["m.status = 'active'", "b.archived_into IS NULL"];
    const args: (string | number)[] = [];
    if (!filter.includePrivate) conds.push("b.is_private = 0");
    if (filter.uncategorized) {
      conds.push("m.category IS NULL");
    } else if (filter.category) {
      // 资料自有分类（D65）：点一级节点 = 其子树（前缀匹配），点二级 = 精确
      conds.push("(m.category = ? OR m.category LIKE ?)");
      args.push(filter.category, `${filter.category}/%`);
    }
    if (filter.type) {
      conds.push("m.type = ?");
      args.push(filter.type);
    }
    if (filter.folderId) {
      // 支持逗号分隔多目录（书签库联动场景保留；资料库自有分类走 category）
      const ids = filter.folderId
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 200);
      if (ids.length === 1) {
        conds.push("b.folder_id = ?");
        args.push(ids[0]!);
      } else if (ids.length > 1) {
        conds.push(`b.folder_id IN (${ids.map(() => "?").join(",")})`);
        args.push(...ids);
      }
    }
    if (filter.tag) {
      // 标签筛选：l1_tags 是 JSON 数组文本，以引号定界精确匹配数组元素（防子串误命中）
      const safe = filter.tag.replace(/["\\%]/g, "");
      if (safe) {
        conds.push("IFNULL(cc.l1_tags,'[]') LIKE ?");
        args.push(`%"${safe}"%`);
      }
    }
    if (filter.q) {
      const like = `%${filter.q.replace(/[%_]/g, "")}%`;
      conds.push(
        "(b.title LIKE ? OR b.url_canonical LIKE ? OR IFNULL(cc.l1_summary,'') LIKE ? OR IFNULL(cc.l2_text,'') LIKE ?)",
      );
      args.push(like, like, like, like);
    }
    return { conds, args };
  }

  countFilteredMaterials(filter: MaterialFilter): number {
    const { conds, args } = this.materialWhere(filter);
    return (this.db.prepare(`SELECT COUNT(*) AS total FROM material m
      JOIN bookmarks b ON b.id = m.bookmark_id LEFT JOIN content_cache cc ON cc.bookmark_id = b.id
      WHERE ${conds.join(" AND ")}`).get(...args) as { total: number }).total;
  }

  listMaterials(filter: MaterialFilter): Array<Record<string, unknown>> {
    const { conds, args } = this.materialWhere(filter);
    const limit = filter.limit ?? 10;
    const offset = filter.offset ?? 0;
    const sql = [
      "SELECT m.id, m.bookmark_id, m.type, m.category, m.cover_url, m.cover_mime, m.cover_size, m.meta, m.signals, m.created_at, m.updated_at,",
      "  b.title, b.url_canonical, b.url_raw, b.favicon_url, b.folder_id, b.added_at, IFNULL(b.materialized_at,'') <> '' AS materialized,",
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
      r.materialized = Number(r.materialized) === 1 ? 1 : 0;
    }
    return rows;
  }

  /** 资料条目详情（含 l2 全文引用——阅读视图用）；不存在或已 dismiss 返回 undefined */
  getMaterial(id: string): Record<string, unknown> | undefined {
    const row = this.db
      .prepare(
        [
          "SELECT m.*, b.title, b.url_canonical, b.url_raw, b.favicon_url, b.folder_id, b.is_private, IFNULL(b.materialized_at,'') <> '' AS materialized,",
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
      row.materialized = Number(row.materialized) === 1 ? 1 : 0;
    }
    return row;
  }

  /** 资料条目存在性（孤儿封面清理用：不看 status，行在即文件不清理） */
  materialExists(id: string): boolean {
    return (this.db.prepare("SELECT 1 FROM material WHERE id = ?").get(id) as unknown) != null;
  }

  /**
   * 资料库分面统计（D65 左侧面板）：AI 分类树计数（按 category 路径聚合）+ AI 标签频次榜。
   * 口径与列表一致（active + 非软归档 + 非私密，随 includePrivate）。
   * category 存储形态 = "一级/二级"；未分类（NULL）由前端用 counts.total - Σcategories 推导。
   */
  materialFacets(includePrivate = false): {
    categories: Array<{ category: string; count: number }>;
    tags: Array<{ tag: string; count: number }>;
  } {
    const privacyCond = includePrivate ? "" : " AND b.is_private = 0";
    const categories = this.db
      .prepare(
        [
          "SELECT m.category AS category, COUNT(*) AS count",
          "FROM material m JOIN bookmarks b ON b.id = m.bookmark_id",
          "WHERE m.status = 'active' AND b.archived_into IS NULL AND m.category IS NOT NULL" + privacyCond,
          "GROUP BY m.category ORDER BY COUNT(*) DESC",
        ].join(" "),
      )
      .all() as Array<{ category: string; count: number }>;
    const tags = this.db
      .prepare(
        [
          "SELECT je.value AS tag, COUNT(*) AS count",
          "FROM material m JOIN bookmarks b ON b.id = m.bookmark_id JOIN content_cache cc ON cc.bookmark_id = b.id",
          "JOIN json_each(CASE WHEN json_valid(IFNULL(cc.l1_tags,'[]')) THEN IFNULL(cc.l1_tags,'[]') ELSE '[]' END) je",
          "WHERE m.status = 'active' AND b.archived_into IS NULL" + privacyCond,
          "GROUP BY je.value ORDER BY COUNT(*) DESC LIMIT 500",
        ].join(" "),
      )
      .all() as Array<{ tag: string; count: number }>;
    return { categories, tags };
  }

  /**
   * 写入 AI 分类路径（存储形态 "一级/二级"；空数组=清空为未分类）。
   * D92 分类 CAS：category_revision 随每次写入递增；来源优先级——迟到的摘要（D65）与分类回填
   * 不得覆盖显式整理任务/用户指定的分类，返回 false 表示本次未写入。
   */
  setMaterialCategory(id: string, path: string[], opts: { source?: "auto" | "organize_task" } = {}): boolean {
    const source = opts.source ?? "auto";
    if (source === "auto") {
      const cur = this.db
        .prepare("SELECT category, category_source FROM material WHERE id = ?")
        .get(id) as { category: string | null; category_source: string | null } | undefined;
      if (!cur) return false;
      if (cur.category !== null && (cur.category_source === "organize_task" || cur.category_source === "manual")) {
        return false;
      }
    }
    const clean = path
      .map((s) => s.trim().slice(0, 20))
      .filter(Boolean)
      .slice(0, 2);
    const category = clean.length > 0 ? clean.join("/") : null;
    this.db
      .prepare("UPDATE material SET category = ?, category_source = ?, category_revision = category_revision + 1, updated_at = ? WHERE id = ?")
      .run(category, category === null ? null : source, now(), id);
    return true;
  }

  /** D92：分类修订回读（撤销守卫：后续被改过分类的资料不再被整次撤销覆盖） */
  getMaterialCategoryState(id: string): { id: string; category: string | null; category_revision: number; category_source: string | null } | undefined {
    return this.db
      .prepare("SELECT id, category, category_revision, category_source FROM material WHERE id = ?")
      .get(id) as { id: string; category: string | null; category_revision: number; category_source: string | null } | undefined;
  }

  /** D92 撤销：分类回到任务写入前的值与来源；修订不符（用户或后续任务改过）则保留并返回 false */
  restoreMaterialCategory(
    id: string,
    before: { category: string | null; source: string | null },
    expectedRevision: number,
  ): boolean {
    const res = this.db
      .prepare("UPDATE material SET category = ?, category_source = ?, category_revision = category_revision + 1, updated_at = ? WHERE id = ? AND category_revision = ?")
      .run(before.category, before.source, now(), id, expectedRevision);
    return res.changes > 0;
  }

  /** 待分类回灌候选：已有 L1 摘要（内容证据充分）但尚无分类的资料条目 */
  materialsMissingCategory(limit = 5): Array<{ id: string; bookmark_id: string }> {
    return this.db
      .prepare(
        [
          "SELECT m.id, m.bookmark_id FROM material m",
          "JOIN bookmarks b ON b.id = m.bookmark_id JOIN content_cache cc ON cc.bookmark_id = b.id",
          "WHERE m.status = 'active' AND m.category IS NULL AND IFNULL(cc.l1_summary,'') != '' AND b.is_private = 0",
          "ORDER BY m.created_at DESC LIMIT ?",
        ].join(" "),
      )
      .all(limit) as Array<{ id: string; bookmark_id: string }>;
  }

  /** 按书标记取资料条目（含 dismissed——封面回填对已移出条目照常写库，不展示） */
  getMaterialByBookmark(bookmarkId: string): { id: string } | undefined {
    return this.db
      .prepare("SELECT id FROM material WHERE bookmark_id = ?")
      .get(bookmarkId) as { id: string } | undefined;
  }

  /** D89 目录资料扫描：确认物化是否生效（dismissed 不算——用户已移出不复活） */
  getActiveMaterialByBookmark(bookmarkId: string): { id: string } | undefined {
    return this.db
      .prepare("SELECT id FROM material WHERE bookmark_id = ? AND status = 'active'")
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
    opts: {
      kind?: "apply" | "undo";
      revertsVersionId?: string | null;
      label?: string | null;
      /** D92：目录整理任务关联——一次任务的多批版本可聚合展示与整次撤销 */
      taskId?: string | null;
      taskBatch?: number | null;
    } = {},
  ): string {
    const id = newId();
    this.db
      .prepare(
        "INSERT INTO organize_version (id, session_id, actions, created_at, reverted, kind, reverts_version_id, label, task_id, task_batch) VALUES (?,?,?,?,0,?,?,?,?,?)",
      )
      .run(
        id,
        sessionId,
        JSON.stringify(actions),
        now(),
        opts.kind ?? "apply",
        opts.revertsVersionId ?? null,
        opts.label ?? null,
        opts.taskId ?? null,
        opts.taskBatch ?? null,
      );
    return id;
  }

  getVersion(id: string): { id: string; actions: unknown[]; reverted: number; session_id: string | null; kind: string; reverts_version_id: string | null; label: string | null; task_id: string | null } | undefined {
    const row = this.db
      .prepare("SELECT * FROM organize_version WHERE id = ?")
      .get(id) as { id: string; actions: string; reverted: number; session_id: string | null; kind: string; reverts_version_id: string | null; label: string | null; task_id: string | null } | undefined;
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

  /** 列出会话/撤销历史（DEV-14 前置；刷新后仍可查看）。D91：带 label（material_convert）；D92：带任务关联 */
  countVersions(): number {
    return (this.db.prepare("SELECT COUNT(*) AS total FROM organize_version").get() as { total: number }).total;
  }

  listVersions(limit = 50, offset = 0): Array<{ id: string; session_id: string | null; kind: string; reverted: number; created_at: string; actionCount: number; label: string | null; task_id: string | null; task_batch: number | null }> {
    const rows = this.db
      .prepare(
        "SELECT id, session_id, kind, reverted, created_at, actions, label, task_id, task_batch FROM organize_version ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset) as unknown as Array<{
      id: string;
      session_id: string | null;
      kind: string;
      reverted: number;
      created_at: string;
      actions: string;
      label: string | null;
      task_id: string | null;
      task_batch: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      kind: r.kind,
      reverted: r.reverted,
      created_at: r.created_at,
      actionCount: (JSON.parse(r.actions) as unknown[]).length,
      label: r.label ?? null,
      task_id: r.task_id ?? null,
      task_batch: r.task_batch ?? null,
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
        // D91：待识别的授权正文也是派生内容，必须与缓存同步清理并终止旧入口任务。
        this.setMaterialCandidateState(bm.id, "cancelled", "privacy_rules_changed");
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

  /** D81 §3-D-5：节点退出同步范围（URL 变非 http）→ 解绑身份，库条目保留 */
  unbindIdentity(deviceId: string, browserBookmarkId: string): void {
    this.db
      .prepare("DELETE FROM bookmark_identity WHERE device_id = ? AND browser_bookmark_id = ?")
      .run(deviceId, browserBookmarkId);
  }

  // ---------- D81 §3-A：目录稳定身份（folder_identity，迁移 v15） ----------
  /** 路径名仅作初次导入匹配；绑定后按 ID 同步——改名/搬家/同名族不再分叉 */
  upsertFolderIdentity(input: { deviceId: string; browserFolderId: string; appFolderId: string; replaceFromAppFolderId?: string; liveBrowserFolderIds?: string[] }): void {
    const current = this.resolveBoundFolderId(input.deviceId, input.browserFolderId);
    if (current === input.appFolderId) return; // 旧别名的原样重放不改绑；分离由显式操作逐个完成。
    if (current && current !== input.replaceFromAppFolderId) throw new Error("folder_identity_changed");
    // 只有设备完整目录快照能证明旧 ID 已死亡；不按时间、过滤后的子树或单次读取失败猜测。
    if (Array.isArray(input.liveBrowserFolderIds) && input.liveBrowserFolderIds.every((id) => typeof id === "string")) {
      const live = new Set(input.liveBrowserFolderIds);
      if (!live.has(input.browserFolderId)) throw new Error("folder_identity_snapshot_stale");
      const old = this.db.prepare("SELECT browser_folder_id FROM folder_identity WHERE device_id = ? AND app_folder_id = ?")
        .all(input.deviceId, input.appFolderId) as Array<{ browser_folder_id: string }>;
      for (const i of old) if (!live.has(i.browser_folder_id)) this.deleteFolderIdentity(input.deviceId, i.browser_folder_id);
    }
    const occupied = this.db.prepare(
      "SELECT 1 FROM folder_identity WHERE device_id = ? AND app_folder_id = ? AND browser_folder_id != ? LIMIT 1",
    ).get(input.deviceId, input.appFolderId, input.browserFolderId);
    if (occupied) throw new Error("folder_identity_occupied");
    this.db
      .prepare(
        `INSERT INTO folder_identity (device_id, browser_folder_id, app_folder_id, mapped_at)
         VALUES (?,?,?,?)
         ON CONFLICT(device_id, browser_folder_id) DO UPDATE SET app_folder_id = excluded.app_folder_id, mapped_at = excluded.mapped_at`,
      )
      .run(input.deviceId, input.browserFolderId, input.appFolderId, now());
  }

  findAppFolderId(deviceId: string, browserFolderId: string): string | undefined {
    const row = this.db
      .prepare("SELECT app_folder_id FROM folder_identity WHERE device_id = ? AND browser_folder_id = ?")
      .get(deviceId, browserFolderId) as { app_folder_id: string } | undefined;
    return row?.app_folder_id;
  }

  folderIdentities(deviceId: string): Array<{ browser_folder_id: string; app_folder_id: string; app_exists: boolean }> {
    return this.db
      .prepare(
        `SELECT i.browser_folder_id, i.app_folder_id,
                (SELECT COUNT(*) FROM folders f WHERE f.id = i.app_folder_id) > 0 AS app_exists
         FROM folder_identity i WHERE i.device_id = ?`,
      )
      .all(deviceId) as unknown as Array<{ browser_folder_id: string; app_folder_id: string; app_exists: boolean }>;
  }

  /** 目录删除时清身份映射（树删逐目录调用） */
  deleteFolderIdentitiesForApp(appFolderId: string): void {
    this.db.prepare("DELETE FROM folder_identity WHERE app_folder_id = ?").run(appFolderId);
  }

  /** 单条目录身份删除（身份指向已不存在的目录 = 陈旧映射，绑定时清理后退路径解析） */
  deleteFolderIdentity(deviceId: string, browserFolderId: string): void {
    this.db.prepare("DELETE FROM folder_identity WHERE device_id = ? AND browser_folder_id = ?").run(deviceId, browserFolderId);
  }

  /**
   * D81 复核 R03：按浏览器目录 id 解析**仍然有效**的稳定身份。
   * 命中且库目录存在 → 返回 appFolderId（调用方必须以它为目标，不得被路径回退改写）；
   * 命中但库目录已不存在 → 清掉陈旧身份返回 undefined（调用方退路径解析）。
   */
  resolveBoundFolderId(deviceId: string, browserFolderId: string): string | undefined {
    const appFolderId = this.findAppFolderId(deviceId, browserFolderId);
    if (!appFolderId) return undefined;
    if (this.getFolder(appFolderId)) return appFolderId;
    this.deleteFolderIdentity(deviceId, browserFolderId);
    return undefined;
  }

  // ---------- D81 §3-D-4：已同步设备停发镜像 ops（D80 Tier2-D） ----------
  setDeviceSyncEnabled(deviceId: string, enabled: boolean): void {
    this.ensureDevice(deviceId);
    this.db.prepare("UPDATE device SET sync_enabled = ? WHERE device_id = ?").run(enabled ? 1 : 0, deviceId);
  }

  deviceSyncEnabled(deviceId: string): boolean {
    const row = this.db.prepare("SELECT sync_enabled FROM device WHERE device_id = ?").get(deviceId) as
      | { sync_enabled: number }
      | undefined;
    return row?.sync_enabled === 1;
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
    // D81 §3-D-4（D80 Tier2-D）：已同步设备停发一切镜像 ops——浏览器写入由同步引擎
    // 单一执行器负责（pull 收敛 + 收纳盒残留收敛），镜像队列与引擎双写是竞态病灶。
    if (this.deviceSyncEnabled(input.deviceId)) return 0;
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

  // ---------- 鉴权 token（D67 迁至 registry.ts——令牌是跨用户共享面，主库承载） ----------

  // ---------- 变更日志（多端同步） ----------
  /** D50：变更日志落库后的进程内广播钩子（buildApp 挂 SSE 推送；异常绝不影响写入主路径） */
  onRecorded?: (ch: { entity: string; entity_id: string; op: string; device: string | null; user?: string }) => void;

  recordChange(entity: string, entityId: string, op: string, payload: unknown, device?: string): void {
    const dev = device ?? currentSyncDevice() ?? null;
    this.db
      .prepare(
        "INSERT INTO changes (entity, entity_id, op, payload, device, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(entity, entityId, op, JSON.stringify(payload ?? null), dev, now());
    try {
      // D67：附带变更所属用户（请求上下文解析），SSE 按用户过滤（自建恒 self，全量照旧）
      this.onRecorded?.({ entity, entity_id: entityId, op, device: dev, user: currentUserId() });
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

  // ---------- D81 §3-C：快照水位 + 库代际 + 过期恢复协议 ----------
  /** 日志保留边界（changes 最小 id；空日志 null）——pull 据此判定游标缺口 */
  minChangeId(): number | null {
    const row = this.db.prepare("SELECT MIN(id) as m FROM changes").get() as { m: number | null };
    return row.m ?? null;
  }

  /** 库代际标识（迁移 v15 生成）：DB 恢复/替换后与设备存储的代际不符 → reset_required */
  syncGeneration(): string {
    const row = this.db.prepare("SELECT value FROM sync_meta WHERE key = 'generation'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? "";
  }

  /**
   * 一致性快照（评审 §3-C）：读事务内取水位 + 全量目录/书签——WAL 下读事务是一致性视图，
   * 水位与数据同边界；快照完成后设备只拉水位之后的变更（期间写入 id > watermark，下轮 pull 接住）。
   * 书签仅同步必需字段（不含正文/快照，隐私面不变）。
   */
  syncSnapshot(): {
    folders: FolderRow[];
    bookmarks: Array<{ id: string; folder_id: string; title: string; url_raw: string; url_canonical: string; pinned: number; status: string; content_revision: number }>;
    watermark: number;
    generation: string;
    minAvailableId: number | null;
  } {
    this.db.exec("BEGIN");
    try {
      const watermark = this.maxChangeId();
      const folders = this.listFolders();
      const bookmarks = this.db
        .prepare("SELECT id, folder_id, title, url_raw, url_canonical, pinned, status, IFNULL(content_revision,0) AS content_revision FROM bookmarks WHERE archived_into IS NULL AND materialized_at IS NULL")
        .all() as unknown as Array<{ id: string; folder_id: string; title: string; url_raw: string; url_canonical: string; pinned: number; status: string; content_revision: number }>;
      const generation = this.syncGeneration();
      const minAvailableId = this.minChangeId();
      this.db.exec("COMMIT");
      return { folders, bookmarks, watermark, generation, minAvailableId };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---------- D81 §3-D-2：操作回执（opId 幂等，事务内数据修改+日志+回执） ----------
  opReceipt(opId: string): unknown | null {
    const row = this.db.prepare("SELECT result FROM sync_op_receipt WHERE op_id = ?").get(opId) as
      | { result: string }
      | undefined;
    return row ? JSON.parse(row.result) : null;
  }

  saveOpReceipt(opId: string, deviceId: string, result: unknown): void {
    this.db
      .prepare("INSERT OR REPLACE INTO sync_op_receipt (op_id, device_id, result, created_at) VALUES (?,?,?,?)")
      .run(opId, deviceId, JSON.stringify(result ?? null), now());
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
        "SELECT id, kind, detail, source, created_at FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(Math.min(Math.max(1, Math.trunc(limit)), 2000)) as unknown as Array<{
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

  /** D81：操作回执保留裁剪（7 天，与 idempotency 同口径；opId 幂等窗口足够覆盖重试队列寿命） */
  pruneOpReceipts(): number {
    const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
    return Number(this.db.prepare("DELETE FROM sync_op_receipt WHERE created_at < ?").run(cutoff).changes);
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
         AND archived_into IS NULL AND materialized_at IS NULL
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
      .prepare("SELECT COUNT(*) as c, MIN(added_at) as o FROM bookmarks WHERE added_at < ? AND is_private = 0 AND archived_into IS NULL AND materialized_at IS NULL")
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
         WHERE status = 'normal' AND pinned = 0 AND archived_into IS NULL AND materialized_at IS NULL AND is_private = 0 AND added_at < ?
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

  /** D76：每目录代表书签（置顶优先→新入库；排除用户归档与合并软归档）——整理 prompt 用内容
   *  归纳目录语义，不再只给扁平目录名让模型凭字面猜（「在线工具」吞掉原生远控客户端的教训）。
   *  D92 隐私前置：样本会进入模型输入，私密书签与隐私域名的标题一律不作为代表书签外发。 */
  folderSampleTitles(perFolder = 3): Map<string, string[]> {
    const rows = this.db
      .prepare(
        `SELECT folder_id, title, url_canonical FROM (
           SELECT folder_id, title, url_canonical, ROW_NUMBER() OVER (PARTITION BY folder_id ORDER BY pinned DESC, added_at DESC) AS rn
           FROM bookmarks WHERE archived_into IS NULL AND materialized_at IS NULL AND status <> 'archived' AND title <> '' AND is_private = 0
         ) WHERE rn <= ?`,
      )
      .all(perFolder + 6) as Array<{ folder_id: string; title: string; url_canonical: string }>;
    const patterns = this.privacyPatterns();
    const out = new Map<string, string[]>();
    for (const r of rows) {
      if (isPrivacyDomain(r.url_canonical, { patterns })) continue;
      const arr = out.get(r.folder_id) ?? [];
      if (arr.length >= perFolder) continue;
      arr.push(r.title);
      out.set(r.folder_id, arr);
    }
    return out;
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
      .prepare("SELECT folder_id, COUNT(*) as c FROM bookmarks WHERE archived_into IS NULL AND materialized_at IS NULL GROUP BY folder_id")
      .all() as unknown as Array<{ folder_id: string; c: number }>;
    for (const r of rows) counts.set(r.folder_id, r.c);
    // 排除私密书签的计数（与列表可见性一致）
    if (privateVisibleOnly) {
      const visibleCounts = new Map<string, number>();
      const visRows = this.db
        .prepare("SELECT folder_id, COUNT(*) as c FROM bookmarks WHERE is_private = 0 AND archived_into IS NULL AND materialized_at IS NULL GROUP BY folder_id")
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
         WHERE b.archived_into IS NULL AND b.materialized_at IS NULL AND b.is_private = 0 AND b.status != 'archived'
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
        "SELECT COALESCE(site_type, 'unanalyzed') AS k, COUNT(*) AS c FROM bookmarks WHERE archived_into IS NULL AND materialized_at IS NULL GROUP BY k",
      )
      .all() as Array<{ k: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.k, r.c]));
  }

  listBySiteType(siteType: string, limit = 500): Array<{ id: string; title: string; url_canonical: string; folder_id: string }> {
    return this.db
      .prepare(
        "SELECT id, title, url_canonical, folder_id FROM bookmarks WHERE site_type = ? AND archived_into IS NULL AND materialized_at IS NULL ORDER BY added_at DESC LIMIT ?",
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
          "attempts=excluded.attempts, updated_at=excluded.updated_at, " +
          // D78：重回收纳盒（pending）= 新一轮生命周期 → 清复核标记，归位后重新自检（D77）
          "reviewed_at = CASE WHEN excluded.state = 'pending' THEN NULL ELSE inbox_state.reviewed_at END",
      )
      .run(bookmarkId, state, confidence ?? null, reason ?? null, attempts ?? 0, now());
  }

  getInboxState(bookmarkId: string): { state: string; confidence: number | null; reason: string | null; attempts: number; reviewed_at: string | null } | undefined {
    return this.db.prepare("SELECT state, confidence, reason, attempts, reviewed_at FROM inbox_state WHERE bookmark_id = ?").get(bookmarkId) as
      | { state: string; confidence: number | null; reason: string | null; attempts: number; reviewed_at: string | null }
      | undefined;
  }

  /** D77：分类自检候选——自动归位（placed）且未复核；手动归位会 clearInboxState → 天然排除。
   *  排除私密/软归档；新归位优先（updated_at DESC） */
  classificationReviewCandidates(limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT s.bookmark_id FROM inbox_state s JOIN bookmarks b ON b.id = s.bookmark_id
         WHERE s.state = 'placed' AND s.reviewed_at IS NULL AND b.is_private = 0 AND b.archived_into IS NULL AND b.materialized_at IS NULL
         ORDER BY s.updated_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ bookmark_id: string }>;
    return rows.map((r) => r.bookmark_id);
  }

  /** D77：复核终结标记（kept/moved 都算）——一次性，防 LLM 非确定性振荡 */
  markClassificationReviewed(bookmarkId: string): void {
    this.db.prepare("UPDATE inbox_state SET reviewed_at = ? WHERE bookmark_id = ?").run(now(), bookmarkId);
  }

  clearInboxState(bookmarkId: string): void {
    this.db.prepare("DELETE FROM inbox_state WHERE bookmark_id = ?").run(bookmarkId);
    this.setMaterialCandidateState(bookmarkId, "cancelled", "manual_intent");
  }

  setInboxStateVersion(bookmarkId: string, versionId: string): void {
    this.db.prepare("UPDATE inbox_state SET version_id = ? WHERE bookmark_id = ?").run(versionId, bookmarkId);
  }

  /** D91：记录/清除本条的转资料版本（去向行「撤销」直达转换版本；恢复时清除） */
  setInboxConvertVersion(bookmarkId: string, versionId: string | null): void {
    this.db
      .prepare("UPDATE inbox_state SET convert_version_id = ? WHERE bookmark_id = ?")
      .run(versionId, bookmarkId);
  }

  /** 收纳盒面板「已自动归位」区：最近 placed 条目（已移出箱，含撤销入口的版本）。
   *  D91：转资料条目（materialized_at 非空）仍在去向历史中，去向显示「资料库」。 */
  countInboxRecentPlaced(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS total FROM inbox_state s JOIN bookmarks b ON b.id = s.bookmark_id
      WHERE s.state = 'placed' AND b.archived_into IS NULL`).get() as { total: number }).total;
  }

  listInboxRecentPlaced(limit = 10, offset = 0): Array<{
    bookmark_id: string; title: string; url_canonical: string; reason: string | null;
    updated_at: string; version_id: string | null; folder_name: string | null;
    materialized: number; convert_version_id: string | null;
  }> {
    // D54：带归位目标目录名（用户的核心问题「它去哪了」）
    return this.db
      .prepare(
        `SELECT s.bookmark_id, b.title, b.url_canonical, s.reason, s.updated_at, s.version_id,
                f.name AS folder_name,
                IFNULL(b.materialized_at, '') <> '' AS materialized,
                s.convert_version_id
         FROM inbox_state s
         JOIN bookmarks b ON b.id = s.bookmark_id
         LEFT JOIN folders f ON f.id = b.folder_id
         WHERE s.state = 'placed' AND b.archived_into IS NULL
         ORDER BY s.updated_at DESC, s.bookmark_id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<{
      bookmark_id: string; title: string; url_canonical: string; reason: string | null;
      updated_at: string; version_id: string | null; folder_name: string | null;
      materialized: number; convert_version_id: string | null;
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
         WHERE b.folder_id = ? AND b.archived_into IS NULL AND b.materialized_at IS NULL
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
         WHERE b.archived_into IS NULL AND b.materialized_at IS NULL AND b.is_private = 0 AND b.status != 'archived'
         ORDER BY c.clicks DESC, c.last_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; title: string; url_canonical: string; favicon_url: string | null; clicks: number }>;
  }

  // ---------- D92 目录整理任务（organize_task / organize_task_item） ----------

  /** 目录子树内全部有效书签（软归档/已转资料排除）——任务范围快照用；递归 CTE 去重，目录成环时自然终止 */
  subtreeBookmarks(rootFolderId: string): BookmarkRow[] {
    return this.db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT ?
           UNION
           SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
         )
         SELECT b.* FROM bookmarks b
         WHERE b.folder_id IN (SELECT id FROM sub) AND b.archived_into IS NULL AND b.materialized_at IS NULL
         ORDER BY b.added_at DESC, b.id`,
      )
      .all(rootFolderId) as unknown as BookmarkRow[];
  }

  /** 目录自根起的深度（根级 = 1；不存在返回 0） */
  folderDepth(folderId: string): number {
    let depth = 0;
    let cur = this.getFolder(folderId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      depth += 1;
      seen.add(cur.id);
      cur = cur.parent_id ? this.getFolder(cur.parent_id) : undefined;
    }
    return depth;
  }

  private static readonly TASK_COLUMNS = new Set([
    "status", "phase", "phase_note", "mode", "total", "moved", "converted", "new_materials", "reused_materials", "unchanged",
    "skipped", "failed", "protected_count", "excluded_archived", "planned_new_folders", "created_folders",
    "reused_folders", "planned_categories", "new_categories", "reused_categories", "plan_json", "error", "lease",
    "lease_at", "revision", "can_continue", "continue_expires_at", "undo_status", "undo_cursor", "undo_restored",
    "undo_kept", "undo_categories", "undo_folders", "started_at", "phase_at", "finished_at",
  ]);

  getOrganizeTask(id: string): OrganizeTaskRow | undefined {
    return this.db.prepare("SELECT * FROM organize_task WHERE id = ?").get(id) as OrganizeTaskRow | undefined;
  }

  findOrganizeTaskByRequest(requestId: string): OrganizeTaskRow | undefined {
    return this.db.prepare("SELECT * FROM organize_task WHERE request_id = ?").get(requestId) as OrganizeTaskRow | undefined;
  }

  /** 账号级准入：进行中的整理任务或进行中的撤销（二者共用同一执行槽） */
  activeOrganizeTask(): OrganizeTaskRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM organize_task
         WHERE status IN ('queued','running','stopping') OR undo_status IN ('pending','running')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as OrganizeTaskRow | undefined;
  }

  /** 启动/定时恢复：进程重启或 worker 异常退出后仍挂在活动态的任务 */
  interruptibleOrganizeTasks(): OrganizeTaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM organize_task
         WHERE status IN ('queued','running','stopping') OR undo_status IN ('pending','running')
         ORDER BY created_at`,
      )
      .all() as unknown as OrganizeTaskRow[];
  }

  countOrganizeTasks(): number {
    return (this.db.prepare("SELECT COUNT(*) AS total FROM organize_task").get() as { total: number }).total;
  }

  listOrganizeTasks(limit = 10, offset = 0): OrganizeTaskRow[] {
    return this.db
      .prepare("SELECT * FROM organize_task ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as unknown as OrganizeTaskRow[];
  }

  updateOrganizeTask(id: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields).filter((k) => Store.TASK_COLUMNS.has(k));
    if (keys.length === 0) return;
    this.db
      .prepare(`UPDATE organize_task SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...(keys.map((k) => fields[k] as string | number | null) as Array<string | number | null>), id);
  }

  /** 任务状态推进：revision 单调递增（轮询/SSE 门铃据此判断有无变化），可同时刷新阶段时间 */
  bumpOrganizeTask(id: string, fields: Record<string, unknown> = {}, touchPhase = true): void {
    const keys = Object.keys(fields).filter((k) => Store.TASK_COLUMNS.has(k));
    const sets = ["revision = revision + 1", ...(touchPhase ? ["phase_at = ?"] : []), ...keys.map((k) => `${k} = ?`)];
    this.db
      .prepare(`UPDATE organize_task SET ${sets.join(", ")} WHERE id = ?`)
      .run(
        ...(touchPhase ? [now()] : []),
        ...(keys.map((k) => fields[k] as string | number | null) as Array<string | number | null>),
        id,
      );
  }

  /** 已形成规划但尚未提交的条目数（规划阶段进度） */
  countOrganizeTaskPlanned(taskId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM organize_task_item WHERE task_id = ? AND decision = 'remaining' AND plan_decision IS NOT NULL")
        .get(taskId) as { c: number }
    ).c;
  }

  /** 已移动条目的落点节点 key（D94：据此统计有多少条移出了来源目录） */
  organizeTaskMovedTargetKeys(taskId: string): string[] {
    return (
      this.db
        .prepare("SELECT plan_target_key AS k FROM organize_task_item WHERE task_id = ? AND decision = 'moved' AND plan_target_key IS NOT NULL")
        .all(taskId) as Array<{ k: string }>
    ).map((r) => r.k);
  }

  /** 任务视图用：已落库的书签目录 / 资料分类承接数（只聚合，不加载明细） */
  organizeTaskTargetCounts(taskId: string): { folders: Map<string, number>; categories: Map<string, number> } {
    const folders = new Map<string, number>();
    for (const r of this.db
      .prepare("SELECT plan_target_key AS k, COUNT(*) AS c FROM organize_task_item WHERE task_id = ? AND decision = 'moved' AND plan_target_key IS NOT NULL GROUP BY plan_target_key")
      .all(taskId) as Array<{ k: string; c: number }>) folders.set(r.k, r.c);
    const categories = new Map<string, number>();
    for (const r of this.db
      .prepare("SELECT plan_category AS k, COUNT(*) AS c FROM organize_task_item WHERE task_id = ? AND decision = 'converted' AND plan_category IS NOT NULL GROUP BY plan_category")
      .all(taskId) as Array<{ k: string; c: number }>) categories.set(r.k, r.c);
    return { folders, categories };
  }

  /** 新建任务 + 范围快照（同事务）：固定总数，此后新收藏不混入本任务 */
  createOrganizeTask(task: OrganizeTaskRow, items: OrganizeTaskItemRow[]): void {
    this.db.exec("SAVEPOINT mf_organize_task_create");
    try {
      const { id, ...rest } = task;
      const taskCols = Object.keys(rest);
      this.db
        .prepare(
          `INSERT INTO organize_task (id, ${taskCols.join(", ")}) VALUES (?, ${taskCols.map(() => "?").join(", ")})`,
        )
        .run(id, ...(taskCols.map((c) => rest[c as keyof typeof rest] as string | number | null) as Array<string | number | null>));
      const ins = this.db.prepare(
        `INSERT INTO organize_task_item (id, task_id, bookmark_id, seq, title, base_folder_id, base_revision, privacy_revision,
          kind, material_type, evidence_ref, decision, reason, plan_decision, plan_target_key, plan_category, plan_material_type,
          plan_reason, from_path, to_path, category_before, material_before, attempts, batch, version_id, retryable, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const it of items) {
        ins.run(
          it.id, it.task_id, it.bookmark_id, it.seq, it.title, it.base_folder_id, it.base_revision, it.privacy_revision,
          it.kind, it.material_type, it.evidence_ref, it.decision, it.reason, it.plan_decision, it.plan_target_key,
          it.plan_category, it.plan_material_type, it.plan_reason, it.from_path, it.to_path, it.category_before,
          it.material_before, it.attempts, it.batch, it.version_id, it.retryable, it.updated_at,
        );
      }
      this.db.exec("RELEASE mf_organize_task_create");
    } catch (err) {
      this.db.exec("ROLLBACK TO mf_organize_task_create");
      this.db.exec("RELEASE mf_organize_task_create");
      throw err;
    }
  }

  /** 任务项分页。decisions 为空 = 全部；分页前总数由 countOrganizeTaskItems 给出 */
  listOrganizeTaskItems(
    taskId: string,
    opts: { decisions?: string[]; limit?: number; offset?: number; recent?: boolean } = {},
  ): OrganizeTaskItemRow[] {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 10));
    const offset = Math.max(0, opts.offset ?? 0);
    const order = opts.recent ? "updated_at DESC, seq DESC" : "seq ASC";
    if (!opts.decisions || opts.decisions.length === 0) {
      return this.db
        .prepare(`SELECT * FROM organize_task_item WHERE task_id = ? ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(taskId, limit, offset) as unknown as OrganizeTaskItemRow[];
    }
    const marks = opts.decisions.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM organize_task_item WHERE task_id = ? AND decision IN (${marks}) ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(taskId, ...opts.decisions, limit, offset) as unknown as OrganizeTaskItemRow[];
  }

  countOrganizeTaskItems(taskId: string, decisions?: string[]): number {
    if (!decisions || decisions.length === 0) {
      return (this.db.prepare("SELECT COUNT(*) AS c FROM organize_task_item WHERE task_id = ?").get(taskId) as { c: number }).c;
    }
    const marks = decisions.map(() => "?").join(",");
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM organize_task_item WHERE task_id = ? AND decision IN (${marks})`)
        .get(taskId, ...decisions) as { c: number }
    ).c;
  }

  private static readonly TASK_ITEM_COLUMNS = new Set([
    "kind", "material_type", "evidence_ref", "decision", "reason", "plan_decision", "plan_target_key", "plan_category",
    "plan_material_type", "plan_reason", "from_path", "to_path", "category_before", "material_before", "attempts",
    "batch", "version_id", "retryable", "updated_at",
  ]);

  updateOrganizeTaskItem(id: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields).filter((k) => Store.TASK_ITEM_COLUMNS.has(k));
    if (keys.length === 0) return;
    this.db
      .prepare(`UPDATE organize_task_item SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...(keys.map((k) => fields[k] as string | number | null) as Array<string | number | null>), id);
  }

  getOrganizeTaskItemByBookmark(taskId: string, bookmarkId: string): OrganizeTaskItemRow | undefined {
    return this.db
      .prepare("SELECT * FROM organize_task_item WHERE task_id = ? AND bookmark_id = ?")
      .get(taskId, bookmarkId) as OrganizeTaskItemRow | undefined;
  }

  /** 运行器取任务项（不分页；决策集合为内部枚举，空数组 = 全部） */
  organizeTaskItemsByDecision(taskId: string, decisions: string[]): OrganizeTaskItemRow[] {
    if (decisions.length === 0) {
      return this.db
        .prepare("SELECT * FROM organize_task_item WHERE task_id = ? ORDER BY seq")
        .all(taskId) as unknown as OrganizeTaskItemRow[];
    }
    const marks = decisions.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM organize_task_item WHERE task_id = ? AND decision IN (${marks}) ORDER BY seq`)
      .all(taskId, ...decisions) as unknown as OrganizeTaskItemRow[];
  }

  /** 一次任务的全部批次版本（提交顺序；撤销按其逆序） */
  taskVersions(taskId: string): Array<{ id: string; batch: number | null; reverted: number }> {
    return this.db
      .prepare("SELECT id, task_batch, reverted FROM organize_version WHERE task_id = ? ORDER BY created_at, rowid")
      .all(taskId) as unknown as Array<{ id: string; batch: number | null; reverted: number }>;
  }

  /** 按分类结果聚合计数（任务计数器的唯一来源——每次提交后由明细行重算，不做增量加减） */
  organizeTaskCounters(taskId: string): {
    moved: number;
    converted: number;
    newMaterials: number;
    reusedMaterials: number;
    unchanged: number;
    skipped: number;
    failed: number;
    remaining: number;
    /** unchanged 中「证据不足」的条目数 */
    insufficient: number;
    /** D95：unchanged 中「同类太少，未单独建目录」的条目数 */
    tooFew: number;
  } {
    const rows = this.db
      .prepare(
        `SELECT decision, IFNULL(material_before,'') AS mb, COUNT(*) AS c FROM organize_task_item
         WHERE task_id = ? GROUP BY decision, mb`,
      )
      .all(taskId) as Array<{ decision: string; mb: string; c: number }>;
    const out = { moved: 0, converted: 0, newMaterials: 0, reusedMaterials: 0, unchanged: 0, skipped: 0, failed: 0, remaining: 0, insufficient: 0, tooFew: 0 };
    for (const r of rows) {
      if (r.decision === "moved") out.moved += r.c;
      else if (r.decision === "converted") {
        out.converted += r.c;
        if (r.mb === "active") out.reusedMaterials += r.c;
        else out.newMaterials += r.c;
      } else if (r.decision === "keep") out.unchanged += r.c;
      else if (r.decision === "skip") out.skipped += r.c;
      else if (r.decision === "fail") out.failed += r.c;
      else out.remaining += r.c;
    }
    // 证据不足单独计：AI 模式下属于「需要说明的问题」，不是「位置本来就好」
    out.insufficient = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM organize_task_item WHERE task_id = ? AND decision = 'keep' AND reason = 'insufficient_evidence'")
        .get(taskId) as { c: number }
    ).c;
    // D95：同类太少、不值得单独建目录而保留原位的条目
    out.tooFew = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM organize_task_item WHERE task_id = ? AND decision = 'keep' AND reason = 'too_few_to_group'")
        .get(taskId) as { c: number }
    ).c;
    return out;
  }

  /**
   * D92 明细保留：终态任务 30 天 / 每库最近 20 次之外先原子禁用「继续」，再裁剪逐条明细与计划。
   * 版本事实不裁剪——历史版本的撤销入口不因明细过期失效。
   */
  pruneOrganizeTasks(): number {
    const terminal = "('stopped','completed','completed_with_issues','failed')";
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    this.db
      .prepare(`UPDATE organize_task SET can_continue = 0 WHERE can_continue = 1 AND status IN ${terminal} AND created_at < ?`)
      .run(cutoff);
    this.db
      .prepare(
        `UPDATE organize_task SET can_continue = 0 WHERE can_continue = 1 AND status IN ${terminal}
           AND id IN (SELECT id FROM organize_task WHERE status IN ${terminal} ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET 20)`,
      )
      .run();
    this.db.prepare("UPDATE organize_task SET plan_json = NULL WHERE can_continue = 0").run();
    return Number(
      this.db.prepare("DELETE FROM organize_task_item WHERE task_id IN (SELECT id FROM organize_task WHERE can_continue = 0)").run().changes,
    );
  }
}
