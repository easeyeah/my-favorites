/**
 * 资料库（D61）：收藏内容三级识别的实体面——文章已存全文显性化、视频留封面、图片存主图。
 * 卡片流形态（用户拍板独立第五页签）；自动入库、直接生效，移出资料库是唯一手工动作（书签本体不动）。
 * 导出 Markdown 是首发对外出口（零 API 依赖，投递到任何笔记应用由用户自拖）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Clapperboard, FileText, Image as ImageIcon, Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, EmptyState, PageScroll, PageHeader, toast } from "@/components/shared";
import { useShell, useRoute } from "@/components/layout";
import { fetchers, type MaterialDetail, type MaterialRow } from "@/lib/api";
import { cn } from "@/lib/utils";

type KindFilter = "" | "article" | "video" | "image";

const KIND_META: Record<MaterialRow["type"], { label: string; icon: typeof FileText }> = {
  article: { label: "文章", icon: FileText },
  video: { label: "视频", icon: Clapperboard },
  image: { label: "图片", icon: ImageIcon },
};

const FILTERS: Array<{ key: KindFilter; label: string }> = [
  { key: "", label: "全部" },
  { key: "article", label: "文章" },
  { key: "video", label: "视频" },
  { key: "image", label: "图片" },
];

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
  const [counts, setCounts] = useState({ total: 0, article: 0, video: 0, image: 0 });
  const [filter, setFilter] = useState<KindFilter>("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<MaterialDetail | null>(null);
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const coverRefs = useRef(new Set<string>());

  const load = useCallback(() => {
    setLoading(true);
    fetchers
      .materials(cfg, { type: filter || undefined, q: q || undefined, limit: 60 })
      .then((r) => {
        setItems(r.items);
        setCounts(r.counts);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [cfg, filter, q]);

  useEffect(load, [load]);

  // 封面异步加载（Blob + 鉴权，objectURL 复用直至卸载）
  useEffect(() => {
    for (const it of items) {
      if (!it.has_cover || coverRefs.current.has(it.id)) continue;
      coverRefs.current.add(it.id);
      fetchers
        .materialCover(cfg, it.id)
        .then((b) => setCoverUrls((prev) => ({ ...prev, [it.id]: URL.createObjectURL(b) })))
        .catch(() => coverRefs.current.delete(it.id));
    }
  }, [items, cfg]);
  useEffect(
    () => () => {
      for (const u of Object.values(coverUrls)) URL.revokeObjectURL(u);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 卸载时一次性回收
    [],
  );

  const openDetail = (id: string) => {
    fetchers
      .materialDetail(cfg, id)
      .then(setDetail)
      .catch(() => toast.err("加载详情失败"));
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
        setDetail(null);
        coverRefs.current.delete(id);
        load();
      })
      .catch(() => toast.err("移出失败"));
  };

  return (
    <PageScroll>
      <PageHeader
        title="资料库"
        sub="收藏时自动识别：文章存全文、视频留封面、图片存主图——整理结果都在这里，可检索、可导出"
      />

      {/* 筛选行：类型 chips + 检索（行 hover 语言与书签库一致） */}
      <div className="mb-4 flex items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
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
              ? "换个关键词或类型试试。"
              : "用扩展收藏文章、视频或图片后会自动出现在这里；已有书签在服务端启动时完成了一次存量回灌。"
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => {
            const meta = KIND_META[it.type];
            const KindIcon = meta.icon;
            const cover = coverUrls[it.id];
            return (
              <button
                key={it.id}
                onClick={() => openDetail(it.id)}
                className="group rounded-xl bg-card text-left shadow-sm transition-shadow hover:shadow-md"
              >
                {/* 封面区：16:9 浅底占位；无封面用类型图标 */}
                <div className="bg-muted relative aspect-video w-full overflow-hidden rounded-t-xl">
                  {cover ? (
                    <img src={cover} alt="" className="size-full object-cover" loading="lazy" />
                  ) : (
                    <div className="text-muted-foreground/60 flex size-full items-center justify-center">
                      <KindIcon className="size-7" />
                    </div>
                  )}
                </div>
                <div className="space-y-1.5 px-3.5 py-3">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
                      <KindIcon className="size-2.5" />
                      {meta.label}
                    </Badge>
                    {it.type === "article" && it.l2_len > 0 && (
                      <Badge variant="secondary" className="text-primary bg-primary/10 px-1.5 py-0 text-[10px]">
                        已存全文
                      </Badge>
                    )}
                    {it.snapshot_count > 0 && (
                      <span className="text-[10px]" title="已有原页快照">
                        📸
                      </span>
                    )}
                    <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">{timeAgo(it.created_at)}</span>
                  </div>
                  <p className="line-clamp-2 text-[13px] font-medium leading-snug">{it.title}</p>
                  {it.l1_summary && <p className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">{it.l1_summary}</p>}
                  <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
                    <span className="truncate">{hostOf(it.url_canonical)}</span>
                    {it.folder_name && <span className="shrink-0 opacity-70">· {it.folder_name}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* 详情阅读：浮层允许（Dialog 功能必需件）；全文 scroll-slim 固定高度 */}
      <Dialog open={detail !== null} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="max-h-[85vh] max-w-[720px] overflow-hidden">
          {detail && (
            <>
              <DialogHeader>
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary" className="text-[10px]">
                    {KIND_META[detail.type].label}
                  </Badge>
                  {detail.type === "article" && detail.l2_len > 0 && (
                    <Badge variant="secondary" className="text-primary bg-primary/10 text-[10px]">
                      已存全文 {detail.l2_len.toLocaleString()} 字
                    </Badge>
                  )}
                  {detail.snapshot_count > 0 && (
                    <Badge variant="secondary" className="text-[10px]">
                      📸 快照可用
                    </Badge>
                  )}
                </div>
                <DialogTitle className="text-left text-base leading-snug">{detail.title}</DialogTitle>
                <DialogDescription className="text-left">
                  {hostOf(detail.url_canonical)}
                  {detail.folder_name ? ` · ${detail.folder_name}` : ""}
                  {detail.signals.length > 0 ? ` · 识别信号：${detail.signals.join("、")}` : ""}
                </DialogDescription>
              </DialogHeader>
              <div className="scroll-slim -mx-1 max-h-[46vh] overflow-y-auto px-1">
                {detail.l1_summary && (
                  <p className="text-muted-foreground mb-3 border-l-2 border-primary/30 pl-3 text-xs leading-relaxed">
                    {detail.l1_summary}
                  </p>
                )}
                {detail.l2_text ? (
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{detail.l2_text}</p>
                ) : (
                  <p className="text-muted-foreground py-4 text-center text-xs">
                    {detail.type === "video"
                      ? "视频收藏仅存元数据（封面/来源），不下载视频本体。"
                      : detail.type === "image"
                        ? "图片收藏已存主图，正文无文本内容。"
                        : "暂未捕获到正文——用扩展重新收藏或等待服务端补漏抓取后出现。"}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                <Btn primary onClick={() => window.open(detail.url_raw, "_blank")}>
                  打开原页
                </Btn>
                <Btn onClick={() => void exportMd(detail.id, detail.title)}>导出 Markdown</Btn>
                {detail.snapshot_count > 0 && (
                  <Btn onClick={() => go("bookmarks")}>在书签库查看快照</Btn>
                )}
                <Btn danger className="ml-auto" onClick={() => dismiss(detail.id)}>
                  移出资料库
                </Btn>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </PageScroll>
  );
}
