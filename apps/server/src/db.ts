/**
 * 数据层 —— node:sqlite（工程决策：M1 用 Node 内置 SQLite，零原生依赖、
 * bundle 兼容、容器免编译工具链；Drizzle/Postgres 推迟到云端阶段，见开发报告）
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "my-favorites.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'user',
      is_system_inbox INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL REFERENCES folders(id),
      url_raw TEXT NOT NULL,
      url_canonical TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'normal',
      favicon_url TEXT,
      cover_url TEXT,
      added_at TEXT NOT NULL,
      last_checked_at TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks(folder_id);
    CREATE TABLE IF NOT EXISTS content_cache (
      bookmark_id TEXT PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
      l1_summary TEXT,
      l1_tags TEXT,
      keywords TEXT,
      l2_text TEXT,
      lang TEXT,
      fetched_via TEXT,
      fetched_at TEXT,
      fail_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS domain_cache (
      domain TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organize_version (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      actions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reverted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS organize_session (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      answer TEXT,
      proposal TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      props TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshot (
      id TEXT PRIMARY KEY,
      bookmark_id TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'mhtml',
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      via TEXT NOT NULL DEFAULT 'extension_mhtml'
    );
    CREATE TABLE IF NOT EXISTS privacy_domain (
      pattern TEXT PRIMARY KEY,
      builtin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS nav_site (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'unlisted',
      created_at TEXT NOT NULL
    );
  `);

  // 内置隐私域名（用户可增不可删，AGENTS.md 红线 2）
  const builtin: string[] = [
    "*.bank",
    "*.local",
    "localhost",
    "127.0.0.1",
    "icloud.com",
    "alipay.com",
    "tenpay.com",
  ];
  const ins = db.prepare(
    "INSERT OR IGNORE INTO privacy_domain (pattern, builtin) VALUES (?, 1)",
  );
  for (const p of builtin) ins.run(p);
}

export const now = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();
