/**
 * 全局命令面板（Ctrl/⌘+K）——「全局可达的搜索」形态：不占版面，任何页呼出。
 *  - 书签全文搜索（标题/URL/备注/正文缓存）；空结果时可切语义模式（服务端 embedder 可用时生效）
 *  - 页签跳转（今天 / 书签 / 收纳盒 / 导航站 / 设置）
 *  - 键盘：↑↓ 选择 · Enter 打开/跳转 · Esc 关闭
 * 设计约束（AGENTS 规范 #2）：header 只放安静入口，不渲染常驻大输入框。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookMarked, CornerDownLeft, Globe, House, Search, Settings, Sparkles } from "lucide-react";
import { fetchers, type AdminConfig, type Bookmark, type FolderTreeNode } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { TabKey } from "@/components/layout";
import { SiteIcon } from "@/components/shared";

type Item =
  | { kind: "bookmark"; bm: Bookmark }
  | { kind: "tab"; tab: TabKey; label: string; icon: typeof House }
  | { kind: "libsearch"; q: string };

// 收纳盒不是独立页签（原 D37 回滚定案）：入口是书签库左树置顶「📥 收纳盒」节点，
// 故此处不列 inbox——跳转统一去书签库。
const PAGES: Array<{ tab: TabKey; label: string; icon: typeof House }> = [
  { tab: "overview", label: "今天", icon: House },
  { tab: "bookmarks", label: "书签库 / 收纳盒", icon: BookMarked },
  { tab: "nav", label: "导航站", icon: Globe },
  { tab: "settings", label: "设置", icon: Settings },
];

export function CommandPalette({
  open,
  onClose,
  cfg,
  go,
}: {
  open: boolean;
  onClose: () => void;
  cfg: AdminConfig;
  go: (tab: TabKey, params?: Record<string, string>) => void;
}) {
  const [q, setQ] = useState("");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [semanticMode, setSemanticMode] = useState(false);
  const [semanticOn, setSemanticOn] = useState(false);
  const [tree, setTree] = useState<FolderTreeNode[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 打开时聚焦 + 拉目录树（书签行显示目录路径用）+ Esc 任意位置可关
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setQ("");
    setBookmarks([]);
    setActive(0);
    setSemanticOn(false);
    setTimeout(() => inputRef.current?.focus(), 30);
    fetchers.folderTree(cfg).then(setTree).catch(() => setTree([]));
  }, [open, cfg]);

  const folderPath = useCallback(
    (id: string): string => {
      const byId = new Map(tree.map((f) => [f.id, f]));
      const parts: string[] = [];
      let cur = byId.get(id);
      while (cur) {
        parts.unshift(cur.name);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
      return parts.join(" / ") || "未整理";
    },
    [tree],
  );

  // 页签匹配（空查询也给出，作为跳转器）
  const pageItems = useMemo<Item[]>(() => {
    const kw = q.trim().toLowerCase();
    return PAGES.filter((p) => !kw || p.label.toLowerCase().includes(kw)).map((p) => ({
      kind: "tab" as const,
      tab: p.tab,
      label: p.label,
      icon: p.icon,
    }));
  }, [q]);

  // 书签搜索（防抖 200ms；语义开关切换时立即重查）
  useEffect(() => {
    if (!open) return;
    const kw = q.trim();
    if (!kw) {
      setBookmarks([]);
      setSemanticMode(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const run = () => {
      const semantic = semanticOn ? 1 : undefined;
      void fetchers
        .search(cfg, kw, semantic)
        .then((r) => {
          setBookmarks(r.results.slice(0, 8));
          setSemanticMode(r.mode === "semantic");
        })
        .catch(() => setBookmarks([]));
    };
    if (semanticOn) run();
    else debounceRef.current = setTimeout(run, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q, semanticOn, open, cfg]);

  const items: Item[] = useMemo(() => {
    const bm: Item[] = bookmarks.map((bm) => ({ kind: "bookmark" as const, bm }));
    // 「在书签库中搜索」落地项不入 items（列表尾单独渲染，active = items.length 指向它）
    const kw = q.trim();
    return kw ? [...bm, ...pageItems] : [...pageItems, ...bm];
  }, [bookmarks, pageItems, q]);

  useEffect(() => setActive(0), [items.length, q]);

  const activate = (item: Item) => {
    if (item.kind === "tab") {
      go(item.tab);
      onClose();
    } else if (item.kind === "libsearch") {
      go("bookmarks", { q: item.q });
      onClose();
    } else {
      window.open(item.bm.url_raw ?? item.bm.url_canonical, "_blank");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length)); // items.length = 落地项位
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active] ?? (q.trim() && active === items.length ? { kind: "libsearch", q: q.trim() } : undefined);
      if (item) activate(item);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/30 pt-[12vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="mx-auto w-full max-w-xl rounded-2xl bg-popover shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="全局搜索"
      >
        {/* 输入行 */}
        <div className="border-border/60 flex items-center gap-2 border-b px-4 py-3">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索书签，或跳转到…"
            className="flex-1 bg-transparent text-sm outline-none"
          />
          <button
            onClick={() => setSemanticOn((v) => !v)}
            title="语义搜索（按内容含义匹配，需要管理台已配置 Embedding 模型）"
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] transition-colors",
              semanticOn
                ? "bg-primary font-medium text-primary-foreground"
                : "text-muted-foreground border hover:text-foreground",
            )}
          >
            <Sparkles className="size-3" /> 语义
          </button>
          <kbd className="text-muted-foreground/60 rounded border px-1 text-[10px]">Esc</kbd>
        </div>

        {/* 结果列表 */}
        <ul className="max-h-[52vh] overflow-y-auto p-1.5">
          {items.length === 0 && (
            <li className="text-muted-foreground px-3 py-6 text-center text-xs">
              {q.trim() ? "没有匹配的书签——试试语义搜索，或直接输入网址打开" : "输入关键词搜索书签，或选择要去的页面"}
            </li>
          )}
          {items.map((item, i) => {
            if (item.kind === "libsearch") return null; // 落地项在列表尾单独渲染
            if (item.kind === "tab") {
              const Icon = item.icon;
              return (
                <li key={`tab-${item.tab}`}>
                  <button
                    onMouseEnter={() => setActive(i)}
                    onClick={() => activate(item)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      i === active ? "bg-accent font-medium" : "hover:bg-accent/50",
                    )}
                  >
                    <Icon className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="flex-1">前往「{item.label}」</span>
                    <CornerDownLeft className="text-muted-foreground/50 size-3" />
                  </button>
                </li>
              );
            }
            return (
              <li key={item.bm.id}>
                <button
                  onMouseEnter={() => setActive(i)}
                  onClick={() => activate(item)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors",
                    i === active ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <SiteIcon title={item.bm.title} url={item.bm.url_canonical} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{item.bm.title}</span>
                    <span className="text-muted-foreground block truncate text-[11px]">{folderPath(item.bm.folder_id)}</span>
                  </span>
                  {semanticMode && (
                    <span className="text-primary shrink-0 rounded bg-primary/10 px-1.5 py-px text-[10px]">语义</span>
                  )}
                </button>
              </li>
            );

          })}
          {q.trim() && (
            <li>
              <button
                onMouseEnter={() => setActive(items.length)}
                onClick={() => activate({ kind: "libsearch", q: q.trim() })}
                className={cn(
                  "text-muted-foreground flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent/50",
                  active === items.length && "bg-accent text-foreground",
                )}
              >
                <BookMarked className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  在书签库中搜索「<span className="text-foreground font-medium">{q.trim()}</span>」——结果留在列表里可批量管理
                </span>
                <CornerDownLeft className="size-3 shrink-0" />
              </button>
            </li>
          )}
        </ul>
        <p className="text-muted-foreground/60 border-border/60 border-t px-4 py-1.5 text-center text-[10px]">
          ↑↓ 选择 · Enter 打开 / 跳转 · Esc 关闭
        </p>
      </div>
    </div>
  );
}
