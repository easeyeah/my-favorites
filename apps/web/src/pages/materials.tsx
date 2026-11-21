/**
 * 资料库（D61/D64）：收藏内容三级识别的实体面。
 * 形态定位（D64 用户拍板）：资料管理的最终价值是「经 MCP 供 AI 工具调用」，人逛页面是次要
 * 场景——不做阅读效果，行式列表即可；分类标签是一等展示位（目录 = AI 分类结果，主色语义；
 * AI 标签 = 内容证据），让「分类很厉害」一眼可见。
 * 行内操作：打开原页 / 导出 Markdown / 移出资料库（软删，书签不动）。
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Clapperboard, Download, FileText, Image as ImageIcon, Loader2, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState, PageScroll, PageHeader, toast } from "@/components/shared";
import { useShell, useRoute } from "@/components/layout";
import { fetchers, type MaterialCounts, type MaterialRow } from "@/lib/api";
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
  const { go } = useRoute();
  const [items, setItems] = useState<MaterialRow[]>([]);
  const [counts, setCounts] = useState<MaterialCounts>({ total: 0, article: 0, video: 0, image: 0 });
  const [filter, setFilter] = useState<KindFilter>("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchers
      .materials(cfg, { type: filter || undefined, q: q || undefined, limit: 100 })
      .then((r) => {
        setItems(r.items);
        setCounts(r.counts);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [cfg, filter, q]);

  useEffect(load, [load]);

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
      })
      .catch(() => toast.err("移出失败"));
  };

  const openOriginal = (id: string) => {
    const it = items.find((x) => x.id === id);
    if (it) window.open(it.url_raw, "_blank");
  };

  return (
    <PageScroll>
      <PageHeader
        title="资料库"
        sub="收藏内容经 AI 自动分类入库：文章存全文、视频留封面、图片存主图——AI 工具可经 MCP 直连本库检索与阅读"
      />

      {/* 筛选行：类型 chips（带计数，分类规模一眼可见）+ 检索 */}
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
        <div className="relative ml-auto w-56">
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
          title={q || filter ? "没有符合条件的内容" : "资料库还是空的"}
          hint={
            q || filter
              ? "换个关键词、类型或标签试试。"
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
    </PageScroll>
  );
}
