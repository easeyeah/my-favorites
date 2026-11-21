/**
 * 资料库服务模块（D61，2026-11-21）：封面落盘、Markdown 导出、存量回灌、孤儿封面清理
 *
 * 分工与依赖：
 *  - 识别在 packages/shared（classifyMaterialKind，纯规则零成本）；
 *  - 仓储在 store.ts（material 表 SQL）；
 *  - 本模块只做文件与导出（封面文件落 DATA_DIR/materials/，与快照同款本地磁盘对象）；
 *  - 出站下载全部走 guardedFetch（SSRF 守卫），隐私判定（server_fetch 动作）由调用端点前置——
 *    与 favicon.ts 同规：本模块是网络执行者，不是策略判定者。
 * 存量回灌为一次性纯本地分类（零网络零封面），完成位存 prefs。
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { isPrivacyDomain, MATERIAL_ARTICLE_MIN_TEXT, classifyMaterialKind } from "@mf/shared";
import { guardedFetch, fetchGuardConfigFromEnv, type FetchGuardConfig } from "./fetch-guard";
import { sniffImageMime } from "./favicon";
import type { Store } from "./store";

/** 封面字节上限：og:image 与直链主图常规在几百 KB~2MB；超限视为非可用封面 */
const MAX_COVER_BYTES = 2 * 1024 * 1024;
const UA = "my-favorites-bot/0.1 (+https://github.com/easeyeah/my-favorites)";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

/** 下载封面/主图字节并嗅探 MIME；失败返回 null（调用方决定是否写负缓存/重试） */
export async function fetchMaterialCover(
  url: string,
  guard: FetchGuardConfig = fetchGuardConfigFromEnv(),
): Promise<{ buf: Buffer; mime: string } | null> {
  try {
    const res = await guardedFetch(url, guard, { headers: { "user-agent": UA } }, {
      maxBytes: MAX_COVER_BYTES,
      timeoutMs: 10_000,
      totalTimeoutMs: 20_000,
    });
    if (!res.ok) {
      res.dispose();
      return null;
    }
    const buf = await res.readBody(MAX_COVER_BYTES);
    const mime = sniffImageMime(buf, res.header("content-type"));
    if (!mime || mime === "image/x-icon") return null; // ico 当不了内容封面
    return { buf, mime };
  } catch {
    return null;
  }
}

/** 封面落盘：DATA_DIR/materials/<materialId>.<ext>；返回相对路径（库内只存相对，便于整体迁移） */
export function saveCoverFile(dataDir: string, materialId: string, buf: Buffer, mime: string): string | null {
  const ext = MIME_EXT[mime];
  if (!ext) return null;
  const dir = path.resolve(dataDir, "materials");
  // 纵深防御：materialId 来自库内 UUID、ext 来自白名单映射——此处仍做包含校验，
  // 静态污点扫描对「函数参数拼路径」不可见该不变量（Mimosa path-traversal HIGH 消解口径）
  const abs = path.resolve(dir, `${materialId}.${ext}`);
  if (!abs.startsWith(dir + path.sep)) return null;
  mkdirSync(dir, { recursive: true });
  const relPath = path.join("materials", `${materialId}.${ext}`);
  writeFileSync(abs, buf);
  return relPath;
}

/** 删除封面文件（不存在静默——幂等）；路径必须落在 materials/ 目录内 */
export function removeCoverFile(dataDir: string, relPath: string): void {
  try {
    const base = path.resolve(dataDir, "materials");
    const abs = path.resolve(dataDir, relPath);
    if (!abs.startsWith(base + path.sep)) return; // 越界路径直接忽略（纵深防御）
    unlinkSync(abs);
  } catch {
    /* 文件可能已不存在 */
  }
}

/** 孤儿封面清理：文件在、material 行已不在（书签删除走 FK 级联，文件无钩子）——启动时跑一次 */
export function sweepOrphanCovers(dataDir: string, store: Store): number {
  const dir = path.join(dataDir, "materials");
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    const materialId = f.replace(/\.[a-z0-9]+$/i, "");
    if (!store.getMaterial(materialId) && !store.materialExists(materialId)) {
      removeCoverFile(dataDir, path.join("materials", f));
      removed += 1;
    }
  }
  return removed;
}

/**
 * 存量回灌（一次性，纯本地）：对全部书签做三级分类并入库。
 * 视频/图片按 URL 形态无条件入库；文章仅在已存全文（l2_text ≥ 阈值）时入库。
 * 零网络、零封面下载（封面由后续 capture/crawl 增量补齐）。
 */
export function backfillMaterials(store: Store): { scanned: number; created: number } {
  const flag = "materials_backfilled_v10";
  if (store.getPref(flag)) return { scanned: 0, created: 0 };
  const patterns = store.privacyPatterns();
  const bookmarks = store.listBookmarks({ limit: 100_000 });
  let created = 0;
  for (const bm of bookmarks) {
    if (bm.is_private === 1) continue;
    if (isPrivacyDomain(bm.url_raw, { patterns })) continue; // 隐私域名：仅存 URL 原则，不入内容库
    const cls = classifyMaterialKind(bm.url_canonical);
    if (!cls) continue;
    if (cls.kind === "article") {
      const cache = store.getCache(bm.id);
      const l2Len = typeof cache?.l2_text === "string" ? (cache.l2_text as string).length : 0;
      if (l2Len < MATERIAL_ARTICLE_MIN_TEXT) continue; // 未存全文的文章不显性化
    }
    store.upsertMaterial({ bookmarkId: bm.id, type: cls.kind, signals: cls.signals });
    created += 1;
  }
  store.setPref(flag, { at: new Date().toISOString(), created });
  return { scanned: bookmarks.length, created };
}

const yamlEscape = (v: string): string => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Markdown 导出（front-matter + 摘要 + 正文/元数据 + 来源），与主流笔记应用（Obsidian/语雀/Notion 导入）兼容 */
export function buildMaterialMarkdown(m: Record<string, unknown>): string {
  const tags = Array.isArray(m.l1_tags) ? (m.l1_tags as string[]) : [];
  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: ${yamlEscape(String(m.title ?? ""))}`);
  lines.push(`source: ${yamlEscape(String(m.url_canonical ?? ""))}`);
  lines.push(`kind: ${String(m.type ?? "article")}`);
  lines.push(`collected: ${yamlEscape(String(m.created_at ?? ""))}`);
  if (m.folder_name) lines.push(`folder: ${yamlEscape(String(m.folder_name))}`);
  if (tags.length > 0) lines.push(`tags: [${tags.map((t) => yamlEscape(String(t))).join(", ")}]`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${String(m.title ?? "")}`);
  lines.push("");
  const summary = typeof m.l1_summary === "string" ? m.l1_summary : "";
  if (summary) {
    lines.push(`> ${summary}`);
    lines.push("");
  }
  const l2 = typeof m.l2_text === "string" ? m.l2_text : "";
  const type = String(m.type ?? "article");
  if (type === "video") {
    lines.push("**视频收藏**：仅存元数据，不下载视频本体。");
    lines.push("");
  } else if (type === "image") {
    lines.push("**图片收藏**：主图已在资料库本地留档。");
    lines.push("");
  } else if (l2) {
    lines.push(l2);
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(`原文：${String(m.url_raw ?? m.url_canonical ?? "")}`);
  if ((m.snapshot_count as number) > 0) {
    lines.push("");
    lines.push("*该收藏已有 MHTML 快照，可在管理台查看净化后的原页存档。*");
  }
  lines.push("");
  return lines.join("\n");
}
