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
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalizeUrl } from "@mf/shared";

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

/**
 * 版本 4：DEV-13 保守 URL 查重键（规则 v2）迁移。
 *  - bookmarks.url_key_version 记录每行键规则版本；
 *  - 用 raw URL 重算全部存量键；碰撞/无法解析的行保留旧键并出报告（不 DELETE/不覆盖）。
 */
export const MIGRATION_V4_URL_KEYS: Migration = {
  version: 4,
  name: "conservative_url_keys",
  up: (db) => {
    const addColumn = (table: string, column: string, decl: string): void => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    };
    addColumn("bookmarks", "url_key_version", "INTEGER NOT NULL DEFAULT 1");

    // {canonical URL} → 首个申请该键的书签 id；后续同键行视为碰撞
    const claimed = new Map<string, string>();
    const collisions: Array<{ id: string; url_raw: string; keptKey: string; newKey: string }> = [];
    const invalid: Array<{ id: string; url_raw: string }> = [];
    const rows = db
      .prepare("SELECT id, url_raw, url_canonical FROM bookmarks ORDER BY created_at, id")
      .all() as Array<{ id: string; url_raw: string; url_canonical: string }>;
    const update = db.prepare("UPDATE bookmarks SET url_canonical = ?, url_key_version = 2 WHERE id = ?");
    const report: Record<string, unknown> = { scanned: rows.length, recomputed: 0, collisions: [], invalid: [] };
    for (const r of rows) {
      let newKey: string | null = null;
      try {
        // 直接复用 @mf/shared canonicalizeUrl（同步纯函数，静态 import 即可）——
        // 迁移产物必须与运行时入库键逐字节一致，内联复制曾与 v2 漂移（缺编码归一）导致静默重复。
        newKey = canonicalizeUrl(r.url_raw)?.canonical ?? null;
      } catch {
        newKey = null;
      }
      if (!newKey) {
        invalid.push({ id: r.id, url_raw: r.url_raw });
        continue;
      }
      if (newKey === r.url_canonical) {
        update.run(r.url_canonical, r.id); // 键未变，仅补版本标记
        continue;
      }
      const owner = claimed.get(newKey);
      if (owner !== undefined && owner !== r.id) {
        // 碰撞：保留全部实体，后到者维持旧键（查重可能漏合并，绝不删除/覆盖）
        collisions.push({ id: r.id, url_raw: r.url_raw, keptKey: r.url_canonical, newKey });
        continue;
      }
      claimed.set(newKey, r.id);
      update.run(newKey, r.id);
      report.recomputed = ((report.recomputed as number) ?? 0) + 1;
    }
    report.collisions = collisions;
    report.invalid = invalid;
    if (collisions.length > 0 || invalid.length > 0) {
      db.prepare("INSERT INTO maintenance_report (id, type, findings, created_at) VALUES (?,?,?,?)").run(
        crypto.randomUUID(),
        "url_key_migration",
        JSON.stringify(report),
        new Date().toISOString(),
      );
    }
  },
};

/**
 * 版本 5：DEV-01 导航站显式发布集合。
 *  - nav_site 增加 published（默认 0：存量站点降级为待确认，不再全库公开）、revision、updated_at；
 *  - 显式发布集合表（站点 × 目录 / 站点 × 书签），公开页只渲染集合内元数据。
 */
export const MIGRATION_V5_NAV_PUBLICATION: Migration = {
  version: 5,
  name: "nav_site_publication_scope",
  up: (db) => {
    const addColumn = (table: string, column: string, decl: string): void => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    };
    addColumn("nav_site", "published", "INTEGER NOT NULL DEFAULT 0");
    addColumn("nav_site", "revision", "INTEGER NOT NULL DEFAULT 1");
    addColumn("nav_site", "updated_at", "TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS nav_site_folder (
        slug TEXT NOT NULL, folder_id TEXT NOT NULL, PRIMARY KEY (slug, folder_id)
      );
      CREATE TABLE IF NOT EXISTS nav_site_bookmark (
        slug TEXT NOT NULL, bookmark_id TEXT NOT NULL, PRIMARY KEY (slug, bookmark_id)
      );
    `);
  },
};

/**
 * 版本 6：DEV-05 令牌加固。
 *  - tokens 增加 token_id（非密随机 ID，撤销用）、token_hash（SHA-256 摘要）、
 *    expires_at / revoked_at / last_used_at；
 *  - 存量明文 token 迁移为摘要（备份中不再存在可用 bearer 明文）。
 */
export const MIGRATION_V6_TOKEN_HARDENING: Migration = {
  version: 6,
  name: "token_digest_and_lifecycle",
  up: (db) => {
    const addColumn = (table: string, column: string, decl: string): void => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    };
    addColumn("tokens", "token_id", "TEXT");
    addColumn("tokens", "token_hash", "TEXT");
    addColumn("tokens", "expires_at", "TEXT");
    addColumn("tokens", "revoked_at", "TEXT");
    addColumn("tokens", "last_used_at", "TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_id ON tokens(token_id);");
    // 存量明文 → 摘要（不可逆；旧 bearer 立即失效，用户需重新登录——升级说明记录）
    const rows = db
      .prepare("SELECT token FROM tokens WHERE token_hash IS NULL")
      .all() as Array<{ token: string }>;
    const upd = db.prepare("UPDATE tokens SET token_id = ?, token_hash = ?, token = 'migrated' WHERE token = ?");
    for (const r of rows) {
      const id = crypto.randomUUID();
      const digest = createHash("sha256").update(r.token).digest("hex");
      upd.run(id, digest, r.token);
    }
  },
};

/**
 * 版本 7：DEV-08 撤销即新版本 + DEV-03 快照清理待办台账。
 *  - organize_version.reverts_version_id：撤销生成的补偿版本指向原版本（原历史不删除）；
 *  - pending_snapshot_deletions：文件删除失败保留待清理记录（不"删索引即成功"）。
 */
export const MIGRATION_V7_UNDO_AND_PURGE_LEDGER: Migration = {
  version: 7,
  name: "undo_version_and_purge_ledger",
  up: (db) => {
    const addColumn = (table: string, column: string, decl: string): void => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    };
    addColumn("organize_version", "reverts_version_id", "TEXT");
    addColumn("organize_version", "kind", "TEXT NOT NULL DEFAULT 'apply'");
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_snapshot_deletions (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, reason TEXT NOT NULL, attempted_at TEXT NOT NULL
      );
    `);
  },
};

/**
 * 版本 8：原型补齐底座（2026-11-20）。
 *  - bookmarks.site_type：站点化三类（site_tool/site_ref/content，D30/D31，可空=未分析）；
 *  - bookmarks.suspect_streak / last_fail_reason：疑似失效连续周期与可解释失败原因（原型 14）；
 *  - nav_site.config：导航站配置 JSON（主题色/搜索引擎/显示选项/水印/自定义卡/包含资料站，原型 13）；
 *  - hook：集成 Hook（D33 出站 Webhook，事件/HMAC/粒度/启停）；
 *  - inbox_state：收纳盒条目状态机（pending/classifying/placed/ambiguous/privacy_hold/retry，原型 06）；
 *  - bookmark_click：应用内点击计数（D29 最常访问数据源）。
 */
export const MIGRATION_V8_PROTO_BASE: Migration = {
  version: 8,
  name: "proto_feature_base",
  up: (db) => {
    const addColumn = (table: string, column: string, decl: string): void => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    };
    addColumn("bookmarks", "site_type", "TEXT");
    addColumn("bookmarks", "suspect_streak", "INTEGER NOT NULL DEFAULT 0");
    addColumn("bookmarks", "last_fail_reason", "TEXT");
    addColumn("nav_site", "config", "TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS hook (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT '[]', secret TEXT, granularity TEXT NOT NULL DEFAULT 'meta',
        enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox_state (
        bookmark_id TEXT PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
        state TEXT NOT NULL, confidence REAL, reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        version_id TEXT
      );
      CREATE TABLE IF NOT EXISTS bookmark_click (
        bookmark_id TEXT PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
        clicks INTEGER NOT NULL DEFAULT 0, last_at TEXT NOT NULL
      );
    `);
  },
};

/**
 * 版本 9：操作审计日志（D58，2026-11-21）。
 *  - audit_log：认证（登录成功/失败/限速）、令牌（签发/撤销）、配置（偏好/供应商/Webhook/发布）
 *    四类事件的持久化审计记录——此前登录失败/限速只在内存滑窗（重启即失），
 *    配置变更无任何痕迹，自建端暴露公网时被爆破无感知。
 *  - 红线：detail 一行人类可读摘要，绝不落密码/token 原值/apiKey/摘要；
 *    source 存客户端标识（IP 或 clientKey），供单用户追溯来源。
 *  - 保留策略在 store.pruneRetention（每日 + 启动时裁剪，audit_log 保最近 1000 条）。
 */
export const MIGRATION_V9_AUDIT_LOG: Migration = {
  version: 9,
  name: "audit_log",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        detail TEXT,
        source TEXT,
        created_at TEXT NOT NULL
      );
    `);
  },
};

/**
 * 版本 10：资料库（D61，2026-11-21）。
 *  - material：收藏内容三级识别（D32）的一级实体——文章（仅已存全文）/视频（仅元数据，不下载本体）/
 *    图片（主图落盘）。正文/摘要不复制，引用 content_cache（删规则连带清理自然生效）；
 *  - bookmark_id UNIQUE：一条收藏至多一条资料条目（覆盖型 upsert）；
 *  - 封面文件落 DATA_DIR/materials/ 目录（与快照同款本地磁盘对象，单文件 SQLite 红线不破坏）；
 *  - status=dismissed：用户主动移出资料库的软删位（防 capture/crawl 再生成"复活"）；
 *  - 存量回灌：启动时一次性纯本地分类回灌（materials.ts backfillMaterials，零网络零封面）。
 */
export const MIGRATION_V10_MATERIAL: Migration = {
  version: 10,
  name: "material_library",
  up: (db) => {
    // DDL 逐条以 prepared statement 执行（等价于一次性 exec；迁移框架 up 内不得拼接用户输入）
    const statements = [
      "CREATE TABLE IF NOT EXISTS material (",
      "  id TEXT PRIMARY KEY,",
      "  bookmark_id TEXT NOT NULL UNIQUE REFERENCES bookmarks(id) ON DELETE CASCADE,",
      "  type TEXT NOT NULL,",
      "  status TEXT NOT NULL DEFAULT 'active',",
      "  cover_path TEXT,",
      "  cover_mime TEXT,",
      "  cover_size INTEGER,",
      "  cover_url TEXT,",
      "  meta TEXT NOT NULL DEFAULT '{}',",
      "  signals TEXT NOT NULL DEFAULT '[]',",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL",
      ");",
    ];
    db.prepare(statements.join("\n")).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_material_type ON material(type, status)").run();
  },
};

/** 全部迁移按版本升序注册（只追加） */
export const MIGRATIONS: Migration[] = [
  BASELINE_MIGRATION,
  MIGRATION_V2_SOFT_ARCHIVE,
  MIGRATION_V3_IDENTITY,
  MIGRATION_V4_URL_KEYS,
  MIGRATION_V5_NAV_PUBLICATION,
  MIGRATION_V6_TOKEN_HARDENING,
  MIGRATION_V7_UNDO_AND_PURGE_LEDGER,
  MIGRATION_V8_PROTO_BASE,
  MIGRATION_V9_AUDIT_LOG,
  MIGRATION_V10_MATERIAL,
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
