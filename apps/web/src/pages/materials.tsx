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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Clapperboard, Download, FileText, Image as ImageIcon, LibraryBig, Loader2, RotateCcw, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, NumberedPagination, PageScroll, PageHeader, toast } from "@/components/shared";
import { useRoute, useShell } from "@/components/layout";
import { useLiveRefresh } from "@/lib/live-refresh";
import { fetchers, type MaterialCounts, type MaterialFacets, type MaterialRow } from "@/lib/api";
import { categoryEmoji, tagEmoji } from "@/lib/tag-emoji";
import { cn } from "@/lib/utils";

type KindFilter = "" | "article" | "video" | "image";
type MaterialAction = "export" | "dismiss" | "restore";
const PAGE_SIZE = 10;

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
  // D92 深链：整理结果里的「查看资料分类」跳 #materials?category=一级/二级，进入即选中该分类
  const deepCategory = useRoute().params.get("category");
  const [items, setItems] = useState<MaterialRow[]>([]);
  const [counts, setCounts] = useState<MaterialCounts>({ total: 0, article: 0, video: 0, image: 0 });
  const [facets, setFacets] = useState<MaterialFacets | null>(null);
  const [filter, setFilter] = useState<KindFilter>("");
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState<string | null>(deepCategory);
  const [uncategorized, setUncategorized] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<{ id: string; kind: MaterialAction } | null>(null);
  const actionInFlight = useRef(false);
  useEffect(() => {
    setCatFilter(deepCategory);
    setUncategorized(false);
    setPage(1);
  }, [deepCategory]);
  const view = useMemo(() => ({ cfg, filter, q, catFilter, uncategorized, page }), [cfg, filter, q, catFilter, uncategorized, page]);
  const request = useRef<{ view: typeof view; controller: AbortController; promise: Promise<void> } | null>(null);

  const load = useCallback((silent = false): Promise<void> => {
    // 同一视图共享在途请求；切筛选/翻页取消旧请求，迟到响应无权覆盖新页。
    if (request.current?.view === view && !request.current.controller.signal.aborted) return request.current.promise;
    request.current?.controller.abort();
    const controller = new AbortController();
    if (!silent) {
      setLoading(true);
      setItems([]);
    }
    setRefreshing(true);
    const promise = fetchers
      .materials(view.cfg, {
        type: view.filter || undefined,
        q: view.q || undefined,
        category: view.catFilter || undefined,
        uncategorized: view.uncategorized,
        limit: PAGE_SIZE,
        offset: (view.page - 1) * PAGE_SIZE,
      }, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        setCounts(r.counts);
        setTotal(r.total);
        setLoadError(null);
        const lastPage = Math.max(1, Math.ceil(r.total / PAGE_SIZE));
        if (view.page > lastPage) {
          setPage(lastPage); // 移出/外部删除使末页失效时，重新查询最近的合法页。
          return;
        }
        setItems(r.items);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : "请稍后重试");
        throw err;
      })
      .finally(() => {
        if (request.current?.controller !== controller) return;
        request.current = null;
        setLoading(false);
        setRefreshing(false);
      });
    request.current = { view, controller, promise };
    return promise;
  }, [view]);

  useEffect(() => {
    void load().catch(() => { /* loadError 已展示，保留失败而不是伪装空列表。 */ });
    return () => request.current?.controller.abort();
  }, [load]);

  // 分面统计始终为全库计数，移出与外部变更后刷新。
  const loadFacets = useCallback(() => fetchers
    .materialFacets(cfg)
    .then(setFacets)
    .catch(() => setFacets(null)), [cfg]);
  useEffect(() => { void loadFacets(); }, [loadFacets]);

  const busy = loading || refreshing || action !== null;
  // 复用 D82 在途/阻塞补轮：门铃不与分页、恢复、移出并发抢写列表。
  const liveRefresh = useLiveRefresh({
    refresh: async () => { await Promise.all([load(true), loadFacets()]); },
    blocked: busy,
  });

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

  const runAction = async (it: MaterialRow, kind: MaterialAction) => {
    // ref 覆盖 React 提交前的同帧连击；行内操作与翻页共用 busy 禁用态。
    if (busy || actionInFlight.current) return;
    actionInFlight.current = true;
    setAction({ id: it.id, kind });
    try {
      if (kind === "export") {
        const blob = await fetchers.materialExport(cfg, it.id);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${it.title.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 60) || "material"}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
        return;
      }
      if (kind === "restore") {
        await fetchers.materialRestore(cfg, it.id);
        // 服务端已确认恢复；即使随后刷新失败，也不能继续展示「恢复」旧操作。
        setItems((rows) => rows.map((row) => row.id === it.id ? { ...row, materialized: 0 } : row));
        toast.ok("已恢复为书签，资料仍保留；浏览器收藏夹将在同步后出现");
      } else {
        await fetchers.materialDismiss(cfg, it.id);
        toast.ok("已移出资料库（书签仍保留在书签库）");
      }
      // 刷新失败独立可见，不把已确认的写入误报为失败；load 内校准合法页码。
      await load(true).catch(() => { /* loadError 提供重试入口。 */ });
      if (kind === "dismiss") await loadFacets();
    } catch (err) {
      const message = kind === "restore" ? "恢复失败" : kind === "dismiss" ? "移出失败" : "导出失败";
      toast.err(`${message}${err instanceof Error ? `：${err.message}` : ""}`);
    } finally {
      actionInFlight.current = false;
      setAction(null);
    }
  };

  const filtersActive = filter !== "" || q !== "" || catFilter !== null || uncategorized;

  return (
    <PageScroll>
      <PageHeader
        icon={<LibraryBig className="size-4" />}
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
                setPage(1);
              }}
              className={cn(
                "data-row mb-0.5 flex w-full items-center gap-1.5 px-2 py-1 text-[13px]",
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
                    setPage(1);
                    if (catFilter === top.name) setCatFilter(null);
                    else {
                      setCatFilter(top.name);
                      setUncategorized(false);
                    }
                  }}
                  className={cn(
                    "data-row flex w-full items-center gap-1.5 px-2 py-1 text-[13px]",
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
                        setPage(1);
                        if (catFilter === path) setCatFilter(null);
                        else {
                          setCatFilter(path);
                          setUncategorized(false);
                        }
                      }}
                      className={cn(
                        "data-row flex w-full items-center gap-1.5 py-1 pr-2 text-xs",
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
                  setPage(1);
                  if (uncategorized) setUncategorized(false);
                  else {
                    setUncategorized(true);
                    setCatFilter(null);
                  }
                }}
                className={cn(
                  "data-row mt-0.5 flex w-full items-center gap-1.5 px-2 py-1 text-[13px]",
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
                  onClick={() => { setFilter(f.key); setPage(1); }}
                  aria-pressed={filter === f.key}
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
                onChange={(e) => { setQ(e.target.value); setPage(1); }}
                aria-label="搜索资料标题、摘要与全文"
                placeholder="搜标题、摘要与全文"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>

          {loadError && (
            <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2 text-xs">
              <p>资料列表加载失败：{loadError}</p>
              <Button variant="outline" size="sm" disabled={busy} onClick={liveRefresh.retry}>重试</Button>
            </div>
          )}
          {loading ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
              <Loader2 className="size-4 animate-spin" />
              正在加载…
            </div>
          ) : loadError && items.length === 0 ? null : items.length === 0 ? (
            <EmptyState
              icon="📚"
              title={filtersActive ? "没有符合条件的内容" : "资料库还是空的"}
              hint={
                filtersActive
                  ? "换个分类、类型或关键词试试。"
                  : "用扩展收藏文章、视频或图片后会自动分类入库；已有书签在服务端启动时完成了一次存量回灌。"
              }
            />
          ) : (
            <ul aria-label="资料列表" aria-busy={busy}>
              {items.map((it, i) => {
                const meta = KIND_META[it.type];
                const KindIcon = meta.icon;
                const pending = action?.id === it.id ? action.kind : null;
                return (
                  <li key={it.id}>
                    {/* 规范 #4：整行 hover/focus-within；分隔线独立于圆角数据行。 */}
                    <div className="data-row m-1 flex items-center gap-3 px-3 py-2.5">
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
                        <Button
                          variant="ghost"
                          size="xs"
                          className="size-7 p-0"
                          title="打开原页"
                          aria-label={`打开原页：${it.title}`}
                          disabled={busy}
                          onClick={() => window.open(it.url_raw, "_blank", "noopener,noreferrer")}
                        >
                          <ArrowUpRight data-icon="inline-start" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="size-7 p-0"
                          title="导出 Markdown"
                          aria-label={`导出 Markdown：${it.title}`}
                          disabled={busy}
                          onClick={() => void runAction(it, "export")}
                        >
                          {pending === "export" ? <Loader2 data-icon="inline-start" aria-hidden="true" className="animate-spin" /> : <Download data-icon="inline-start" aria-hidden="true" />}
                        </Button>
                        {it.materialized === 1 ? (
                          // D91：恢复保留资料，服务端确认后切换为「移出资料库」。
                          <Button
                            variant="ghost"
                            size="xs"
                            className="size-7 p-0"
                            title="恢复为书签（资料保留；浏览器收藏夹节点同步后重建）"
                            aria-label={`恢复为书签：${it.title}（资料保留）`}
                            disabled={busy}
                            onClick={() => void runAction(it, "restore")}
                          >
                            {pending === "restore" ? <Loader2 data-icon="inline-start" aria-hidden="true" className="animate-spin" /> : <RotateCcw data-icon="inline-start" aria-hidden="true" />}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="size-7 p-0"
                            title="移出资料库（书签保留）"
                            aria-label={`移出资料库：${it.title}（书签保留）`}
                            disabled={busy}
                            onClick={() => void runAction(it, "dismiss")}
                          >
                            {pending === "dismiss" ? <Loader2 data-icon="inline-start" aria-hidden="true" className="animate-spin" /> : <Trash2 data-icon="inline-start" aria-hidden="true" />}
                          </Button>
                        )}
                      </div>
                    </div>
                    {i < items.length - 1 && <div aria-hidden="true" className="bg-border/40 mx-4 h-px" />}
                  </li>
                );
              })}
            </ul>
          )}
          <NumberedPagination
            label="资料列表分页"
            page={page}
            total={total}
            pageSize={PAGE_SIZE}
            disabled={busy || loadError !== null}
            onPageChange={(next) => {
              if (!busy && !actionInFlight.current && next !== page) setPage(next);
            }}
          />
        </div>
      </div>
    </PageScroll>
  );
}
