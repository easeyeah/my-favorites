/**
 * 资料库（D61/D64/D65/D66 简化）：收藏内容三级识别的实体面。
 * 形态定位（D64 用户拍板）：资料管理的最终价值是「经 MCP 供 AI 工具调用」，人逛页面是次要
 * 场景——不做阅读效果，行式列表即可。
 * 左侧面板（D65/D66）：资料库自有 AI 分类树（两级路径，随摘要同一次 LLM 调用产出，涓流回灌
 * 存量）——**不用书签目录**（书签分类服务于浏览器心智，资料分类按内容语义），呈现方式参考
 * 书签库左树（层级缩进 + 计数 + 点选筛选）。
 * D66 简化：分类与标签双维度并存仍嫌复杂——**UI 只保留分类**；标签退回数据层（仍生成、
 * 仍进 MCP/导出，供 AI 检索），不再作为人的浏览维度。
 * 行 = 标题 + 已存全文徽章 + 📸 + 分类徽章 + 行内操作（打开原页/导出/移出）。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Clapperboard, Download, FileText, Image as ImageIcon, Loader2, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState, PageScroll, PageHeader, toast } from "@/components/shared";
import { useShell } from "@/components/layout";
import { fetchers, type MaterialCounts, type MaterialFacets, type MaterialRow } from "@/lib/api";
import { categoryEmoji, tagEmoji } from "@/lib/tag-emoji";
import { cn } from "@/lib/utils";

type KindFilter = "" | "article" | "video" | "image";

const KIND_META: Record<MaterialRow["type"], { label: string; icon: typeof FileText }> = {
  article: { label: "文章", icon: FileText },
  video: { label: "视频", icon: Clapperboard },
  image: { label: "图片", icon: ImageIcon },
};

const timeAgo = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} 分钟前`;
  if (mins < 86400 / 60_000) return `${Math.floor(mins / 60)} 小时前`;
  return `${Math.floor(mins / 1440)} 天前`;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

export function Materials() {
  const { cfg } = useShell();
  const [items, setItems] = useState<MaterialRow[]>([]);
  const [counts, setCounts] = useState<MaterialCounts>({ total: 0, article: 0, video: 0, image: 0 });
  const [facets, setFacets] = useState<MaterialFacets | null>(null);
  const [filter, setFilter] = useState<KindFilter>("");
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const [uncategorized, setUncategorized] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchers
      .materials(cfg, {
        type: filter || undefined,
        q: q || undefined,
        category: catFilter || undefined,
        uncategorized,
        limit: 100,
      })
      .then((r) => {
        setItems(r.items);
        setCounts(r.counts);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [cfg, filter, q, catFilter, uncategorized]);

  useEffect(load, [load]);

  // 分面统计：仅随配置变化（全局计数），移出资料库后手动刷新
  const loadFacets = useCallback(() => {
    fetchers
      .materialFacets(cfg)
      .then(setFacets)
      .catch(() => setFacets(null));
  }, [cfg]);
  useEffect(loadFacets, [loadFacets]);

  // 分类树：category 路径（"一级/二级"）→ 两层结构，一级计数 = 子树聚合
  const catTree = useMemo(() => {
    const tops = new Map<string, { name: string; count: number; subs: Array<{ name: string; count: number }> }>();
    for (const { category, count } of facets?.categories ?? []) {
      const parts = category.split("/");
      const top = parts[0] ?? "未分类";
      const sub = parts[1];
      const t = tops.get(top) ?? { name: top, count: 0, subs: [] as Array<{ name: string; count: number }> };
      t.count += count;
      if (sub) t.subs.push({ name: sub, count });
      tops.set(top, t);
    }
    return [...tops.values()].sort((a, b) => b.count - a.count);
  }, [facets]);
  const categorized = (facets?.categories ?? []).reduce((s, c) => s + c.count, 0);
  const uncategorizedCount = Math.max(0, counts.total - categorized);

  const exportMd = async (id: string, title: string) => {
    try {
      const blob = await fetchers.materialExport(cfg, id);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${title.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 60) || "material"}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      toast.err("导出失败");
    }
  };

  const dismiss = (id: string) => {
    fetchers
      .materialDismiss(cfg, id)
      .then(() => {
        toast.ok("已移出资料库（书签仍保留在书签库）");
        load();
        loadFacets();
      })
      .catch(() => toast.err("移出失败"));
  };

  const openOriginal = (id: string) => {
    const it = items.find((x) => x.id === id);
    if (it) window.open(it.url_raw, "_blank");
  };

  const filtersActive = filter !== "" || q !== "" || catFilter !== null || uncategorized;

  return (
    <PageScroll>
      <PageHeader
        title="资料库"
        sub="收藏内容经 AI 自动分类入库：文章存全文、视频留封面、图片存主图——AI 工具可经 MCP 直连本库检索与阅读"
      />

      <div className="flex gap-5">
        {/* 左：分面面板（AI 分类树 + AI 标签榜）——资料自有分类，不用书签目录（D65） */}
        <aside className="scroll-slim hidden max-h-[calc(100vh-11rem)] w-52 shrink-0 self-start overflow-y-auto md:sticky md:top-32 md:block">
          <section>
            <p className="text-muted-foreground mb-1.5 text-[11px] font-medium">分类</p>
            <button
              onClick={() => {
                setCatFilter(null);
                setUncategorized(false);
              }}
              className={cn(
                "mb-0.5 flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] transition-colors",
                catFilter === null && !uncategorized
                  ? "bg-primary/10 font-medium text-primary"
                  : "hover:bg-accent/60 text-foreground",
              )}
            >
              <span className="shrink-0">📚</span>
              <span className="min-w-0 flex-1 truncate text-left">全部资料</span>
              <span className="tabular text-muted-foreground shrink-0 text-[11px]">{counts.total}</span>
            </button>
            {catTree.map((top) => (
              <Fragment key={top.name}>
                <button
                  onClick={() => {
                    if (catFilter === top.name) setCatFilter(null);
                    else {
                      setCatFilter(top.name);
                      setUncategorized(false);
                    }
                  }}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] transition-colors",
                    catFilter === top.name ? "bg-primary/10 font-medium text-primary" : "hover:bg-accent/60 text-foreground",
                  )}
                >
                  <span className="shrink-0">{categoryEmoji(top.name)}</span>
                  <span className="min-w-0 flex-1 truncate text-left">{top.name}</span>
                  <span className="tabular text-muted-foreground shrink-0 text-[11px]">{top.count}</span>
                </button>
                {top.subs.map((sub) => {
                  const path = `${top.name}/${sub.name}`;
                  return (
                    <button
                      key={sub.name}
                      onClick={() => {
                        if (catFilter === path) setCatFilter(null);
                        else {
                          setCatFilter(path);
                          setUncategorized(false);
                        }
                      }}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-xs transition-colors",
                        catFilter === path ? "bg-primary/10 font-medium text-primary" : "hover:bg-accent/60 text-foreground",
                      )}
                      style={{ paddingLeft: 26 }}
                    >
                      <span className="shrink-0">{tagEmoji(sub.name)}</span>
                      <span className="min-w-0 flex-1 truncate text-left">{sub.name}</span>
                      <span className="tabular text-muted-foreground shrink-0 text-[11px]">{sub.count}</span>
                    </button>
                  );
                })}
              </Fragment>
            ))}
            {uncategorizedCount > 0 && (
              <button
                onClick={() => {
                  if (uncategorized) setUncategorized(false);
                  else {
                    setUncategorized(true);
                    setCatFilter(null);
                  }
                }}
                className={cn(
                  "mt-0.5 flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] transition-colors",
                  uncategorized ? "bg-primary/10 font-medium text-primary" : "hover:bg-accent/60 text-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">未分类</span>
                <span className="tabular text-muted-foreground shrink-0 text-[11px]">{uncategorizedCount}</span>
              </button>
            )}
          </section>

          {/* D66 简化：AI 标签不再作为人的浏览维度（分类与标签双维度并存仍嫌复杂）——
              标签退回数据层（仍生成、仍进 MCP/导出，供 AI 检索） */}
        </aside>

        {/* 右：筛选 + 行式列表 */}
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {([
                { key: "" as KindFilter, label: "全部", n: counts.total },
                { key: "article" as KindFilter, label: "文章", n: counts.article },
                { key: "video" as KindFilter, label: "视频", n: counts.video },
                { key: "image" as KindFilter, label: "图片", n: counts.image },
              ]).map((f) => (
                <button
                  key={f.key || "all"}
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs transition-colors",
                    filter === f.key
                      ? "bg-primary font-medium text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label}
                  <span className="tabular ml-1 opacity-70">{f.n}</span>
                </button>
              ))}
            </div>
            <div className="relative ml-auto w-48">
              <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜标题、摘要与全文"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>

          {loading ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
              <Loader2 className="size-4 animate-spin" />
              正在加载…
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon="📚"
              title={filtersActive ? "没有符合条件的内容" : "资料库还是空的"}
              hint={
                filtersActive
                  ? "换个分类、标签、类型或关键词试试。"
                  : "用扩展收藏文章、视频或图片后会自动分类入库；已有书签在服务端启动时完成了一次存量回灌。"
              }
            />
          ) : (
            <ul>
              {items.map((it, i) => {
                const meta = KIND_META[it.type];
                const KindIcon = meta.icon;
                return (
                  <Fragment key={it.id}>
                    {/* 规范 #4：分割线是独立元素（不挂在行 border 上）与圆角解耦——行只做圆角 hover 高亮 */}
                    <li className="group hover:bg-accent/40 m-1 flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors">
                      {/* 位 1+2：标题行 + 分类标签行 */}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <KindIcon className="text-muted-foreground size-3.5 shrink-0" />
                          <a
                            href={it.url_raw}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate text-[13px] font-medium underline-offset-2 hover:text-primary hover:underline"
                          >
                            {it.title}
                          </a>
                          {it.type === "article" && it.l2_len > 0 && (
                            <Badge variant="secondary" className="text-primary bg-primary/10 shrink-0 px-1.5 py-0 text-[10px]">
                              已存全文
                            </Badge>
                          )}
                          {it.snapshot_count > 0 && (
                            <span className="shrink-0 text-[10px]" title="已有原页快照">
                              📸
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {it.category && (
                            <Badge
                              variant="secondary"
                              className="text-primary bg-primary/10 px-1.5 py-0 text-[10px]"
                              title="AI 分类（资料库自有体系，按内容语义两级归类）"
                            >
                              {categoryEmoji(it.category)} {it.category.split("/").join(" / ")}
                            </Badge>
                          )}
                        </div>
                      </div>
                      {/* 位 3：类型 · 来源 · 时间 */}
                      <div className="text-muted-foreground shrink-0 text-right text-[11px] leading-relaxed">
                        <p>
                          {meta.label} · {hostOf(it.url_canonical)}
                        </p>
                        <p>{timeAgo(it.created_at)}</p>
                      </div>
                      {/* 位 4：行内操作 */}
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg p-1.5 transition-colors"
                          title="打开原页"
                          onClick={() => openOriginal(it.id)}
                        >
                          <ArrowUpRight className="size-3.5" />
                        </button>
                        <button
                          className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg p-1.5 transition-colors"
                          title="导出 Markdown"
                          onClick={() => void exportMd(it.id, it.title)}
                        >
                          <Download className="size-3.5" />
                        </button>
                        <button
                          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded-lg p-1.5 transition-colors"
                          title="移出资料库（书签保留）"
                          onClick={() => dismiss(it.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </li>
                    {i < items.length - 1 && <li aria-hidden className="border-border/40 mx-4 border-t" />}
                  </Fragment>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </PageScroll>
  );
}
