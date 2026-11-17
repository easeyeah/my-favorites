/**
 * 数据层 —— node:sqlite（工程决策：M1 用 Node 内置 SQLite，零原生依赖、
 * bundle 兼容、容器免编译工具链；Drizzle/Postgres 推迟到云端阶段，见开发报告）
 * A3-1（2026-11-17）：迁移改为有序带版本号框架（./migrate.ts），迁移前自动备份。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrateWithBackup, BASELINE_MIGRATION, MIGRATIONS } from "./migrate";

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "my-favorites.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const result = migrateWithBackup(db, dataDir);
  if (result.applied.length > 0) {
    console.log(
      `[db] migrated ${result.fromVersion}→${result.toVersion}: ${result.applied.map((m) => `v${m.version}(${m.name})`).join(", ")}${result.backupPath ? `; backup: ${result.backupPath}` : ""}`,
    );
  }
  return db;
}

/** 旧签名兼容（现有测试直接调 migrate）：仅执行基线幂等重放 */
export function migrate(db: Db): void {
  BASELINE_MIGRATION.up(db);
}

/** 当前迁移框架版本（诊断/管理台展示） */
export function schemaVersion(db: Db): number {
  const rows = db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number | null };
  return rows.v ?? 0;
}

export { MIGRATIONS };

export const now = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();
