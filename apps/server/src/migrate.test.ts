/** A3-1 迁移与备份基础设施测试：有序版本号 / WAL 一致性备份 / 旧库升级 / 恢复 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, schemaVersion } from "./db";
import { migrateWithBackup, backupDb, MIGRATIONS, type Migration } from "./migrate";

let dirs: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "mf-migrate-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("有序版本号迁移", () => {
  it("新库：一次应用到全部版本，schema_migrations 记录完整", () => {
    const dir = tmpDir();
    const db = openDb(dir);
    const versions = (
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>
    ).map((r) => r.version);
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
    expect(schemaVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
    // v3 的表存在
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'bookmark_identity'").get(),
    ).toBeDefined();
    db.close();
  });

  it("重复 openDb 幂等：无新迁移、无新备份文件", () => {
    const dir = tmpDir();
    const db1 = openDb(dir);
    db1.close();
    const backupDir = path.join(dir, "backups");
    const countAfterFirst = existsSync(backupDir) ? readdirSync(backupDir).length : 0;
    const db2 = openDb(dir);
    const result = migrateWithBackup(db2, dir);
    expect(result.applied).toHaveLength(0);
    const countAfterSecond = existsSync(backupDir) ? readdirSync(backupDir).length : 0;
    expect(countAfterSecond).toBe(countAfterFirst); // 无新备份
    db2.close();
  });

  it("迁移失败：单版本事务回滚，不留半套", () => {
    const dir = tmpDir();
    const db = openDb(dir);
    db.close();
    // 构造一个必然失败的迁移（重复加同名列 → ALTER 报错）
    const badMigration: Migration = {
      version: 99,
      name: "must_fail",
      up: (d) => {
        d.exec("ALTER TABLE bookmarks ADD COLUMN archived_into TEXT"); // v2 已加过，必失败
      },
    };
    const db2 = new DatabaseSync(path.join(dir, "my-favorites.db"));
    db2.exec("PRAGMA journal_mode = WAL;");
    MIGRATIONS.push(badMigration);
    try {
      expect(() => migrateWithBackup(db2, dir)).toThrow(/migration v99/);
      // v99 未被记录
      const v = db2.prepare("SELECT 1 FROM schema_migrations WHERE version = 99").get();
      expect(v).toBeUndefined();
    } finally {
      MIGRATIONS.pop();
      db2.close();
    }
  });
});

describe("备份一致性（WAL 活跃）", () => {
  it("VACUUM INTO 备份包含 WAL 中未 checkpoint 的写入", () => {
    const dir = tmpDir();
    const db = openDb(dir);
    // 写入数据（停留在 WAL，不主动 checkpoint）
    db.prepare(
      "INSERT INTO folders (id, parent_id, name, sort, source, is_system_inbox, created_at) VALUES ('f1', NULL, '测试目录', 0, 'user', 0, ?)",
    ).run(new Date().toISOString());
    const walSize = () => (existsSync(path.join(dir, "my-favorites.db-wal")) ? readFileSync(path.join(dir, "my-favorites.db-wal")).byteLength : 0);
    expect(walSize()).toBeGreaterThan(0); // 确认 WAL 活跃

    const backupPath = backupDb(db, path.join(dir, "my-favorites.db"), path.join(dir, "backups", "wal-test.db"));
    expect(existsSync(backupPath)).toBe(true);

    // 备份文件独立可打开，且包含 WAL 中的数据
    const restored = new DatabaseSync(backupPath);
    const row = restored.prepare("SELECT name FROM folders WHERE id = 'f1'").get() as { name: string } | undefined;
    expect(row?.name).toBe("测试目录");
    restored.close();
    db.close();
  });

  it("旧版本数据库升级：M1 旧库（无 schema_migrations）→ 新框架无损升级", () => {
    const dir = tmpDir();
    const dbFile = path.join(dir, "my-favorites.db");
    // 模拟 M1 旧库：手写老 schema + 真实数据（无 schema_migrations 表）
    const old = new DatabaseSync(dbFile);
    old.exec("PRAGMA journal_mode = WAL;");
    old.exec(`CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'user', is_system_inbox INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE bookmarks (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES folders(id), url_raw TEXT NOT NULL, url_canonical TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'normal', favicon_url TEXT, cover_url TEXT, added_at TEXT NOT NULL, last_checked_at TEXT, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE content_cache (bookmark_id TEXT PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE, l1_summary TEXT, l1_tags TEXT, keywords TEXT, l2_text TEXT, lang TEXT, fetched_via TEXT, fetched_at TEXT, fail_reason TEXT);`);
    old.prepare("INSERT INTO folders (id, name, created_at) VALUES ('old-f', '旧目录', '2026-01-01T00:00:00Z')").run();
    old.prepare(
      "INSERT INTO bookmarks (id, folder_id, url_raw, url_canonical, title, added_at, created_at) VALUES ('old-b1', 'old-f', 'https://old.example.com/a', 'https://old.example.com/a', '旧书签', '2026-01-01', '2026-01-01')",
    ).run();
    old.prepare(
      "INSERT INTO content_cache (bookmark_id, l2_text, fetched_via, fetched_at) VALUES ('old-b1', '旧正文', 'extension_capture', '2026-01-01')",
    ).run();
    old.close();

    // 新框架打开：基线幂等重放 + v2/v3 应用，且迁移前自动备份
    const db = openDb(dir);
    const versions = (
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>
    ).map((r) => r.version);
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
    // 旧数据无损
    expect((db.prepare("SELECT title FROM bookmarks WHERE id = 'old-b1'").get() as { title: string }).title).toBe("旧书签");
    expect((db.prepare("SELECT l2_text FROM content_cache WHERE bookmark_id = 'old-b1'").get() as { l2_text: string }).l2_text).toBe("旧正文");
    // 迁移前备份存在且可打开
    const backupDir = path.join(dir, "backups");
    const backups = existsSync(backupDir)
      ? readdirSync(backupDir).filter((f) => f.startsWith("pre-migrate"))
      : [];
    expect(backups.length).toBe(1);
    const restoredDb = new DatabaseSync(path.join(backupDir, backups[0]!));
    expect((restoredDb.prepare("SELECT COUNT(*) as c FROM bookmarks").get() as { c: number }).c).toBe(1);
    restoredDb.close();
    db.close();
  });

  it("备份恢复演练：备份文件可作为完整数据目录恢复使用", () => {
    const dirA = tmpDir();
    const dbA = openDb(dirA);
    // 造数据：目录+书签+缓存+快照记录+整理版本
    dbA.prepare("INSERT INTO folders (id, name, created_at) VALUES ('f1', '恢复测试', '2026-01-01')").run();
    dbA.prepare("INSERT INTO bookmarks (id, folder_id, url_raw, url_canonical, title, added_at, created_at) VALUES ('b1', 'f1', 'https://restore.example.com/x', 'https://restore.example.com/x', '恢复目标', '2026-01-01', '2026-01-01')").run();
    dbA.prepare("INSERT INTO content_cache (bookmark_id, l2_text, fetched_via, fetched_at) VALUES ('b1', '要恢复的正文', 'extension_capture', '2026-01-01')").run();
    dbA.prepare("INSERT INTO organize_version (id, actions, created_at, reverted) VALUES ('v1', '[]', '2026-01-01', 0)").run();
    const backupPath = backupDb(dbA, path.join(dirA, "my-favorites.db"), path.join(dirA, "backups", "restore-src.db"));
    dbA.close();

    // 恢复到新数据目录
    const dirB = tmpDir();
    mkdirSync(path.join(dirB, "backups"), { recursive: true });
    writeFileSync(path.join(dirB, "my-favorites.db"), readFileSync(backupPath));
    const dbB = openDb(dirB); // 恢复库再走一次迁移（应为 no-op）
    expect((dbB.prepare("SELECT l2_text FROM content_cache WHERE bookmark_id = 'b1'").get() as { l2_text: string }).l2_text).toBe("要恢复的正文");
    expect((dbB.prepare("SELECT COUNT(*) as c FROM organize_version").get() as { c: number }).c).toBe(1);
    dbB.close();
  });
});
