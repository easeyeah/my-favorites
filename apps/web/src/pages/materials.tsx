/**
 * 资料库（D61/D64）：收藏内容三级识别的实体面。
 * 形态定位（D64 用户拍板）：资料管理的最终价值是「经 MCP 供 AI 工具调用」，人逛页面是次要
 * 场景——不做阅读效果，行式列表即可；分类标签是一等展示位。
 * 左侧双维度面板：分类树（目录体系，子树聚合计数，按资料剪枝）+ AI 标签频次榜——
 * 标签无层级不造假树；目录/标签/类型/关键词四维正交可叠加。
 * 行 = 标题 + 已存全文徽章 + 📸 + 分类标签行 + 行内操作（打开原页/导出/移出）。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Clapperboard, Download, FileText, Image as ImageIcon, Loader2, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState, PageScroll, PageHeader, toast } from "@/components/shared";
import { useShell, useRoute } from "@/components/layout";
import { fetchers, type MaterialCounts, type MaterialFacets, type MaterialRow } from "@/lib/api";
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

/** 分面目录 → 按资料子树计数构建展示树（剪掉无资料的分支；count = 子树聚合） */
interface MaterialFolderNode {
  id: string;
  name: string;
  count: number;
  depth: number;
  childCount: number;
}

function buildMaterialTree(
  tree: Array<{ id: string; name: string; parent_id: string | null }>,
  counts: Map<string, number>,
): MaterialFolderNode[] {
  const byId = new Map(tree.map((f) => [f.id, { ...f, children: [] as string[] }]));
  const childrenOf = new Map<string | null, string[]>();
  for (const f of byId.values()) {
    const list = childrenOf.get(f.parent_id) ?? [];
    list.push(f.id);
    childrenOf.set(f.parent_id, list);
  }
  const subtreeCount = (id: string): number => {
    let sum = counts.get(id) ?? 0;
    for (const c of childrenOf.get(id) ?? []) sum += subtreeCount(c);
    return sum;
  };
  const rows: MaterialFolderNode[] = [];
  const walk = (id: string, depth: number): void => {
    const node = byId.get(id);
    if (!node) return;
    const count = subtreeCount(id);
    if (count <= 0) return; // 剪枝：无资料的分支不渲染
    const childList = (childrenOf.get(id) ?? []).filter((c) => subtreeCount(c) > 0);
    rows.push({ id, name: node.name, count, depth, childCount: childList.length });
    for (const c of (childrenOf.get(id) ?? []).sort()) walk(c, depth + 1);
  };
  for (const root of childrenOf.get(null) ?? [].sort()) walk(root, 0);
  return rows;
}

export function Materials() {
  const { cfg } = useShell();
  const { go } = useRoute();
  const [items, setItems] = useState<MaterialRow[]>([]);
  const [counts, setCounts] = useState<MaterialCounts>({ total: 0, article: 0, video: 0, image: 0 });
  const [facets, setFacets] = useState<MaterialFacets | null>(null);
  const [filter, setFilter] = useState<KindFilter>("");
  const [q, setQ] = useState("");
  const [folderIds, setFolderIds] = useState<string[] | null>(null);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [tag, setTag] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchers
      .materials(cfg, {
        type: filter || undefined,
        q: q || undefined,
        tag: tag || undefined,
        folderId: folderIds?.length ? folderIds.join(",") : undefined,
        limit: 100,
      })
      .then((r) => {
        setItems(r.items);
        setCounts(r.counts);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [cfg, filter, q, tag, folderIds]);

  useEffect(load, [load]);

  // 分面统计：仅随配置变化（全局计数），移出资料库后手动刷新
  const loadFacets = useCallback(() => {
    fetchers
      .materialFacets(cfg)
      .then(setFacets)
      .catch(() => setFacets(null));
  }, [cfg]);
  useEffect(loadFacets, [loadFacets]);

  const [treeSource, setTreeSource] = useState<Array<{ id: string; name: string; parent_id: string | null }>>([]);
  useEffect(() => {
    fetchers
      .folderTree(cfg)
      .then((t) => setTreeSource(t.map((n) => ({ id: n.id, name: n.name, parent_id: n.parent_id }))))
      .catch(() => setTreeSource([]));
  }, [cfg]);

  const countMap = useMemo(
    () => new Map((facets?.folders ?? []).map((f) => [f.folder_id, f.count])),
    [facets],
  );
  const materialTree = useMemo(() => buildMaterialTree(treeSource, countMap), [treeSource, countMap]);

  const pickFolder = (nodeId: string, subtreeIds: string[]) => {
    if (activeFolderId === nodeId) {
      setActiveFolderId(null);
      setFolderIds(null);
    } else {
      setActiveFolderId(nodeId);
      setFolderIds(subtreeIds);
    }
  };

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

  const filtersActive = filter !== "" || q !== "" || tag !== "" || folderIds !== null;

  return (
    <PageScroll>
      <PageHeader
        title="资料库"
        sub="收藏内容经 AI 自动分类入库：文章存全文、视频留封面、图片存主图——AI 工具可经 MCP 直连本库检索与阅读"
      />

      <div className="flex gap-5">
        {/* 左：双维度分面面板（分类树 + AI 标签榜） */}
        <aside className="scroll-slim hidden max-h-[calc(100vh-11rem)] w-52 shrink-0 self-start overflow-y-auto md:sticky md:top-32 md:block">
          <section>
            <p className="text-muted-foreground mb-1.5 text-[11px] font-medium">分类</p>
            <button
              onClick={() => {
                setActiveFolderId(null);
                setFolderIds(null);
              }}
              className={cn(
                "mb-0.5 flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] transition-colors",
                activeFolderId === null ? "bg-primary/10 font-medium text-primary" : "hover:bg-accent/60 text-foreground",
              )}
            >
              <span className="shrink-0">📚</span>
              <span className="min-w-0 flex-1 truncate text-left">全部资料</span>
              <span className="tabular text-muted-foreground shrink-0 text-[11px]">{counts.total}</span>
            </button>
            {materialTree.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  // 子树筛选：本节点 + 全部后代目录（与展示计数口径一致）
                  const ids: string[] = [n.id];
                  const collect = (pid: string): void => {
                    for (const c of materialTree.filter((x) => treeSource.find((t) => t.id === x.id)?.parent_id === pid)) {
                      ids.push(c.id);
                      collect(c.id);
                    }
                  };
                  collect(n.id);
                  pickFolder(n.id, ids);
                }}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-[13px] transition-colors",
                  activeFolderId === n.id ? "bg-primary/10 font-medium text-primary" : "hover:bg-accent/60 text-foreground",
                )}
                style={{ paddingLeft: 8 + n.depth * 14 }}
                title={n.name}
              >
                <span className="min-w-0 flex-1 truncate text-left">{n.name}</span>
                <span className="tabular text-muted-foreground shrink-0 text-[11px]">{n.count}</span>
              </button>
            ))}
          </section>

          {(facets?.tags.length ?? 0) > 0 && (
            <section className="mt-5">
              <p className="text-muted-foreground mb-1.5 text-[11px] font-medium">AI 标签</p>
              {facets!.tags.map((t) => (
                <button
                  key={t.tag}
                  onClick={() => setTag(tag === t.tag ? "" : t.tag)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] transition-colors",
                    tag === t.tag ? "bg-primary/10 font-medium text-primary" : "hover:bg-accent/60 text-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{t.tag}</span>
                  <span className="tabular text-muted-foreground shrink-0 text-[11px]">{t.count}</span>
                </button>
              ))}
            </section>
          )}
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
                  ? "换个目录、标签、类型或关键词试试。"
                  : "用扩展收藏文章、视频或图片后会自动分类入库；已有书签在服务端启动时完成了一次存量回灌。"
              }
            />
          ) : (
            <ul>
              {items.map((it, i) => {
                const meta = KIND_META[it.type];
                const KindIcon = meta.icon;
                const tags = (it.l1_tags ?? []).slice(0, 5);
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
                          {it.folder_name && (
                            <Badge
                              variant="secondary"
                              className="text-primary bg-primary/10 px-1.5 py-0 text-[10px]"
                              title={it.signals.length > 0 ? `AI 分类 · 识别信号：${it.signals.join("、")}` : "AI 分类"}
                            >
                              {it.folder_name}
                            </Badge>
                          )}
                          {tags.map((t) => (
                            <Badge key={t} variant="secondary" className="px-1.5 py-0 text-[10px]">
                              {t}
                            </Badge>
                          ))}
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

          {/* MCP 提示：安静事实行（本库对 AI 工具开放） */}
          {counts.total > 0 && (
            <p className="text-muted-foreground mt-4 text-[11px]">
              ⚡ 本库已开放 MCP 接口：<code className="font-mono">POST /api/v1/mcp</code>
              （materials_search / materials_get / materials_recent），Claude、Cursor 等 AI 工具配好服务端地址与令牌即可直接检索和阅读全文。
              <button className="hover:text-foreground ml-1 underline underline-offset-2" onClick={() => go("settings")}>
                获取令牌 →
              </button>
            </p>
          )}
        </div>
      </div>
    </PageScroll>
  );
}
