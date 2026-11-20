/**
 * 站点化分析（D30/D31，切片 B）：应用书签库 → 站点投影
 *
 * - 分析是投影：不改书签目录数据（D16 库是主数据），只写 site_type 标注 + 缓存投影结果，可随时重建；
 * - 规则信号先行（shared/classifySiteSignal，零成本）+ AI 信号叠加（有 L1 摘要时 refineWithSummary）；
 * - 同站归并：同域多篇内容页 → 一个站点卡（首页直达）；只收藏过文章没有首页 → 域名根升级为站点卡
 *   （默认开启 · 可撤销 · 通知说明，D37 收口）；
 * - 资料类站点默认不入导航（D31），书签库保留，管理台开关 / 自定义卡可加回。
 */
import { classifySiteSignal, refineWithSummary } from "@mf/shared";
import type { Store } from "./store";

export interface SiteCard {
  domain: string;
  title: string;
  url: string;
  favicon: string | null;
  /** 组成该站点卡的书签（归并明细 / 域名根升级名单） */
  bookmarkIds: string[];
  /** upgraded = 域名根升级（原文章保留在书签库） */
  upgraded: boolean;
}

export interface SiteProjection {
  sites: SiteCard[];
  refs: Array<{ domain: string; title: string; url: string; bookmarkIds: string[] }>;
  /** 同域文章归并明细：域名 → 归并的内容页数 */
  merged: Array<{ domain: string; siteTitle: string; contentCount: number }>;
  contentCount: number;
  counts: { sites: number; refs: number; merged: number; upgraded: number; content: number };
}

export function analyzeSiteProjection(store: Store): SiteProjection {
  const bookmarks = store.listBookmarks({ limit: 10000 }).filter(
    (b) => !b.archived_into && b.is_private === 0 && b.status !== "archived",
  );

  const byDomain = new Map<
    string,
    { toolRoots: typeof bookmarks; refs: typeof bookmarks; contents: typeof bookmarks }
  >();
  const group = (domain: string) => {
    let g = byDomain.get(domain);
    if (!g) {
      g = { toolRoots: [], refs: [], contents: [] };
      byDomain.set(domain, g);
    }
    return g;
  };

  for (const b of bookmarks) {
    let signal = classifySiteSignal(b.url_raw);
    if (!signal) continue;
    const cache = store.getCache(b.id);
    signal = refineWithSummary(signal, (cache?.l1_summary as string | null | undefined) ?? null);
    const g = group(signal.registrableDomain);
    if (signal.kind === "site_tool") g.toolRoots.push(b);
    else if (signal.kind === "site_ref") g.refs.push(b);
    else g.contents.push(b);
    // 投影标注写回（分析不改目录；site_type 供书签库筛选与导航端过滤）
    store.setSiteType(b.id, signal.kind);
  }

  const sites: SiteCard[] = [];
  const refs: SiteProjection["refs"] = [];
  const merged: SiteProjection["merged"] = [];
  let upgraded = 0;

  for (const [domain, g] of byDomain) {
    const rootBookmark =
      g.toolRoots.find((b) => classifySiteSignal(b.url_raw)?.isNearRoot) ??
      g.toolRoots[0] ??
      null;
    if (rootBookmark) {
      // 站点卡：近根入口直达；其余工具页与内容页归并到该卡（点击直达首页）
      sites.push({
        domain,
        title: shortenSiteTitle(rootBookmark.title),
        url: rootBookmark.url_raw,
        favicon: rootBookmark.favicon_url,
        bookmarkIds: [rootBookmark.id, ...g.contents.map((b) => b.id)],
        upgraded: false,
      });
      if (g.contents.length > 0) {
        merged.push({ domain, siteTitle: rootBookmark.title, contentCount: g.contents.length });
      }
    } else if (g.refs.length > 0) {
      // 资料站：文档/wiki/教程首页——默认不入导航（D31），书签库保留
      const best = g.refs[0]!;
      refs.push({ domain, title: shortenSiteTitle(best.title), url: best.url_raw, bookmarkIds: g.refs.map((b) => b.id) });
    } else if (g.contents.length > 0) {
      // 只收藏过文章、没有首页 → 域名根升级为站点卡（默认开启 · 可撤销）
      const best = [...g.contents].sort((a, b) => a.added_at.localeCompare(b.added_at))[0]!;
      const root = `https://${domain}/`;
      sites.push({
        domain,
        title: domain,
        url: root,
        favicon: best.favicon_url,
        bookmarkIds: g.contents.map((b) => b.id),
        upgraded: true,
      });
      merged.push({ domain, siteTitle: domain, contentCount: g.contents.length });
      upgraded++;
    }
  }

  sites.sort((a, b) => a.domain.localeCompare(b.domain));
  refs.sort((a, b) => a.domain.localeCompare(b.domain));
  const contentCount = [...byDomain.values()].reduce((n, g) => n + g.contents.length, 0);
  return {
    sites,
    refs,
    merged,
    contentCount,
    counts: { sites: sites.length, refs: refs.length, merged: merged.length, upgraded, content: contentCount },
  };
}

/** AI 起站名的规则版兜底：截断俗长标题，取「站点名」直觉（首段 / 去修饰） */
function shortenSiteTitle(title: string): string {
  const t = title.split(/[|·—–\-–]/)[0]?.trim() ?? title;
  return t.length > 24 ? t.slice(0, 24) + "…" : t || "站点";
}
