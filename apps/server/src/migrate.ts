/**
 * 数据库迁移与备份基础设施（A3-1，2026-11-17）
 *
 * 设计：
 *  - 有序、带版本号的迁移：schema_migrations 表记录已应用版本，只前进不回滚（AGENTS.md）。
 *  - 迁移前备份：node:sqlite 无 backup API，采用 SQLite 官方推荐的在线备份等效方案：
 *    `VACUUM INTO 'file'` —— 在 WAL 活跃下产出一致性快照（写事务级一致，含 WAL 内容）。
 *  - 旧库升级路径：基线 schema（M1 一次性 migrate()）= 版本 1；此后每个变更一个版本。
 */
import type { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";

/** 迁移步骤：version 单调递增；name 进日志；up 只前进 */
export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

/**
 * 版本 1：基线 = M1/M2/M3 全量 schema（原 db.ts migrate() 的内容）。
 * 旧库（无 schema_migrations 表）首次运行本框架时按"已处于版本 1"处理：
 * 用 CREATE TABLE IF NOT EXISTS 幂等重放，不破坏现有数据。
 */
export const BASELINE_MIGRATION: Migration = {
  version: 1,
  name: "baseline_m1_m2_m3",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'user',
        is_system_inbox INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookmarks (
        id TEXT PRIMARY KEY,
        folder_id TEXT NOT NULL REFERENCES folders(id),
        url_raw TEXT NOT NULL, url_canonical TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'normal',
        favicon_url TEXT, cover_url TEXT, added_at TEXT NOT NULL, last_checked_at TEXT,
        pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks(folder_id);
      CREATE TABLE IF NOT EXISTS content_cache (
        bookmark_id TEXT PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
        l1_summary TEXT, l1_tags TEXT, keywords TEXT, l2_text TEXT, lang TEXT,
        fetched_via TEXT, fetched_at TEXT, fail_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS domain_cache (
        domain TEXT PRIMARY KEY, category TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS organize_version (
        id TEXT PRIMARY KEY, session_id TEXT, actions TEXT NOT NULL,
        created_at TEXT NOT NULL, reverted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS organize_session (
        id TEXT PRIMARY KEY, message TEXT NOT NULL, status TEXT NOT NULL,
        answer TEXT, proposal TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY, result TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, props TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshot (
        id TEXT PRIMARY KEY, bookmark_id TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'mhtml', path TEXT NOT NULL,
        size INTEGER NOT NULL, created_at TEXT NOT NULL, via TEXT NOT NULL DEFAULT 'extension_mhtml'
      );
      CREATE TABLE IF NOT EXISTS privacy_domain (pattern TEXT PRIMARY KEY, builtin INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS nav_site (
        slug TEXT PRIMARY KEY, title TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'unlisted', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, label TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
        op TEXT NOT NULL, payload TEXT, device TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS maintenance_report (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, findings TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_config (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT,
        purpose_models TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // 原增量列（对旧库幂等）
    const addColumn = (table: string, column: string, decl: string): void => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    };
    addColumn("nav_site", "template", "TEXT NOT NULL DEFAULT 'grid'");
    addColumn("nav_site", "password_hash", "TEXT");
    addColumn("bookmarks", "is_private", "INTEGER NOT NULL DEFAULT 0");
    addColumn("content_cache", "embedding", "TEXT");
    // 内置隐私域名（幂等重放）
    const builtin = ["*.bank", "*.local", "localhost", "127.0.0.1", "icloud.com", "alipay.com", "tenpay.com"];
    const ins = db.prepare("INSERT OR IGNORE INTO privacy_domain (pattern, builtin) VALUES (?, 1)");
    for (const p of builtin) ins.run(p);
  },
};

/**
 * 版本 2：A3-2/A3-5 整理提案与软归档支撑。
 *  - organize_session 增加 base_revision（提案生成时的数据版本）与 status 冲突语义；
 *  - bookmarks 增加 archived_into（软归档：被合并方的保留指向，A3-5）；
 *  - bookmarks 增加 content_revision（A3-4 冲突检测：用户手改 bump）。
 */
export const MIGRATION_V2_SOFT_ARCHIVE: Migration = {
  version: 2,
  name: "organize_revision_and_soft_archive",
  up: (db) => {
    const addColumn = (table: string, column: string, decl: string): void => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    };
    addColumn("bookmarks", "archived_into", "TEXT"); // 软归档指向保留方 bookmark id（NULL=正常）
    addColumn("bookmarks", "content_revision", "INTEGER NOT NULL DEFAULT 1"); // 用户手改/内容变更计数
    addColumn("organize_session", "base_state", "TEXT"); // 提案生成时各书签 {id: folder_id} 快照
    addColumn("organize_session", "base_revisions", "TEXT"); // 提案生成时 {id: content_revision}
    // 软归档书签不出现在常规列表/导航（部分索引，查询用 WHERE archived_into IS NULL）
  },
};

/**
 * 版本 3：A2 身份映射与持久化待执行操作。
 *  - 设备表 + 浏览器书签映射（device_id + browser_bookmark_id ↔ app_bookmark_id 唯一）；
 *  - 浏览器待执行操作队列（pending_browser_ops：镜像模式 D20 的持久待执行记录）。
 */
export const MIGRATION_V3_IDENTITY: Migration = {
  version: 3,
  name: "device_identity_and_pending_ops",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS device (
        device_id TEXT PRIMARY KEY,
        label TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );
      CREATE TABLE IF NOT EXISTS bookmark_identity (
        device_id TEXT NOT NULL,
        browser_bookmark_id TEXT NOT NULL,
        app_bookmark_id TEXT NOT NULL,
        mapped_at TEXT NOT NULL,
        PRIMARY KEY (device_id, browser_bookmark_id)
      );
      CREATE INDEX IF NOT EXISTS idx_identity_app ON bookmark_identity(app_bookmark_id);
      CREATE TABLE IF NOT EXISTS pending_browser_ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        op TEXT NOT NULL,             -- move | create | remove
        browser_bookmark_id TEXT,
        target_browser_parent_id TEXT,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed | cancelled
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_browser_ops(status);
    `);
  },
};

/** 全部迁移按版本升序注册（只追加） */
export const MIGRATIONS: Migration[] = [
  BASELINE_MIGRATION,
  MIGRATION_V2_SOFT_ARCHIVE,
  MIGRATION_V3_IDENTITY,
];

export function appliedVersions(db: DatabaseSync): Set<number> {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
  )`);
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

export interface MigrateResult {
  applied: Array<{ version: number; name: string }>;
  fromVersion: number;
  toVersion: number;
  backupPath: string | null;
}

/**
 * 执行迁移（带自动备份）。
 * - 首次（无 schema_migrations 记录但库文件已存在）：先备份再跑基线。
 * - 有待应用版本：备份 → 逐版本事务执行 → 记录。
 * - 任何一步失败：抛错且不留半套（单版本事务回滚）。
 */
export function migrateWithBackup(db: DatabaseSync, dataDir: string): MigrateResult {
  mkdirSync(path.join(dataDir, "backups"), { recursive: true });
  const current = appliedVersions(db);
  const pending = MIGRATIONS.filter((m) => !current.has(m.version)).sort((a, b) => a.version - b.version);
  const dbFile = path.join(dataDir, "my-favorites.db");
  const fromVersion = Math.max(0, ...current);

  if (pending.length === 0) {
    return { applied: [], fromVersion, toVersion: fromVersion, backupPath: null };
  }

  // 迁移前备份（WAL 活跃下一致性快照：VACUUM INTO 等效在线备份）
  let backupPath: string | null = null;
  if (existsSync(dbFile)) {
    backupPath = backupDb(db, dbFile, path.join(dataDir, "backups", `pre-migrate-v${pending[0]!.version}-${Date.now()}.db`));
  }

  for (const m of pending) {
    db.exec("BEGIN");
    try {
      m.up(db);
      db
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)")
        .run(m.version, m.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      // 失败时清理本次备份？保留——失败现场对排查有价值，且占用极小
      throw new Error(`migration v${m.version} (${m.name}) failed: ${String(err)}`);
    }
  }
  return {
    applied: pending.map((m) => ({ version: m.version, name: m.name })),
    fromVersion,
    toVersion: Math.max(...pending.map((m) => m.version)),
    backupPath,
  };
}

/**
 * SQLite 在线备份（WAL 安全）。
 * VACUUM INTO 在写事务级一致地导出整个库（含 WAL 中未 checkpoint 的内容），
 * 优于直接复制主文件（会丢 WAL / 撕裂）。兜底：checkpoint 后复制源文件。
 */
export function backupDb(db: DatabaseSync, sourceDbFile: string, targetPath: string): string {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  try {
    db.prepare("VACUUM INTO ?").run(targetPath);
    return targetPath;
  } catch {
    // 兜底：强制 checkpoint 落盘后复制主文件（VACUUM INTO 不可用时）
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(sourceDbFile, targetPath);
    return targetPath;
  }
}
