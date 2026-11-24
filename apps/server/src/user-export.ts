/** D73：单用户数据导出。只含内容与非密配置，绝不导出密码、令牌、API Key 或导航站密码。 */
import type { Db } from "./db";
import type { AdminUserRow } from "./registry";

function rows(db: Db, sql: string): Array<Record<string, unknown>> {
  return db.prepare(sql).all() as unknown as Array<Record<string, unknown>>;
}

export function buildUserExport(db: Db, account: AdminUserRow | null): Record<string, unknown> {
  return {
    format: "my-favorites-user-data",
    format_version: 1,
    exported_at: new Date().toISOString(),
    account: account
      ? {
          username: account.username,
          display_name: account.display_name,
          role: account.role,
          created_at: account.created_at,
        }
      : null,
    // folders/bookmarks/caches 保持既有 /import/json 可直接消费的顶层格式。
    folders: rows(db, "SELECT * FROM folders ORDER BY created_at, id"),
    bookmarks: rows(db, "SELECT * FROM bookmarks ORDER BY created_at, id"),
    caches: rows(
      db,
      `SELECT bookmark_id, l1_summary, l1_tags, keywords, l2_text, lang,
              fetched_via, fetched_at, fail_reason
       FROM content_cache ORDER BY bookmark_id`,
    ),
    materials: rows(
      db,
      `SELECT id, bookmark_id, type, status, cover_mime, cover_size, cover_url,
              meta, signals, created_at, updated_at, category
       FROM material ORDER BY created_at, id`,
    ),
    inbox: rows(db, "SELECT * FROM inbox_state ORDER BY updated_at, bookmark_id"),
    organize_versions: rows(db, "SELECT * FROM organize_version ORDER BY created_at, id"),
    organize_sessions: rows(db, "SELECT * FROM organize_session ORDER BY created_at, id"),
    snapshots: rows(db, "SELECT id, bookmark_id, format, size, created_at, via FROM snapshot ORDER BY created_at, id"),
    nav_sites: rows(
      db,
      `SELECT slug, title, visibility, created_at, template, published, revision, updated_at, config
       FROM nav_site ORDER BY created_at, slug`,
    ),
    nav_site_folders: rows(db, "SELECT * FROM nav_site_folder ORDER BY slug, folder_id"),
    nav_site_bookmarks: rows(db, "SELECT * FROM nav_site_bookmark ORDER BY slug, bookmark_id"),
    preferences: rows(db, "SELECT * FROM prefs ORDER BY key"),
    privacy_domains: rows(db, "SELECT * FROM privacy_domain ORDER BY pattern"),
    providers: rows(
      db,
      "SELECT provider_id, base_url, purpose_models, enabled, created_at FROM provider_config ORDER BY created_at, id",
    ),
  };
}
