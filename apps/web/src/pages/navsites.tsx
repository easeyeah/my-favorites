/**
 * 导航站管理（navsite 模块）：左侧子导航 + 右侧面板，单站点心智。
 * 我的站点＝状态条；模板＝选择 + 单独保存；发布设置＝标题 / 目录 / 密码。
 * 公开页仅元数据 + 摘要，快照内容永不可见（红线④）；默认私有，显式选范围。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Globe, LayoutTemplate, Loader2, RotateCcw, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Btn, EmptyState, PageScroll, toast } from "@/components/shared";
import { useShell } from "@/components/layout";
import { ApiError, apiCall, fetchers, apiUrl, type FolderTreeNode, type NavSite, type NavSiteDetail } from "@/lib/api";
import { cn } from "@/lib/utils";

type PaneKey = "site" | "template" | "settings";

/** 原型 13：主题色 / 显示选项 / 自定义卡 */
const THEME_COLORS = ['#4f46e5', '#0e9384', '#f79009', '#e5484d', '#1a1d29'];

const TEMPLATES: Array<{ id: string; name: string; note: string }> = [
  { id: "grid", name: "经典宫格", note: "分组宫格卡片，最像浏览器主页" },
  { id: "list", name: "极简清单", note: "单列清单，信息密度最高" },
  { id: "cards", name: "卡片瀑布流", note: "大卡片，摘要更完整" },
  { id: "home", name: "个人主页", note: "主侧栏布局，作品集气质" },
];

export function NavSites() {
  const { cfg, refreshBadges } = useShell();
  const [sites, setSites] = useState<NavSite[]>([]);
  const [details, setDetails] = useState<Record<string, NavSiteDetail>>({});
  const [tree, setTree] = useState<FolderTreeNode[]>([]);
  const [title, setTitle] = useState("我的导航站");
  const [template, setTemplate] = useState("grid");
  const [password, setPassword] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [pane, setPane] = useState<PaneKey>("site");
  const [templateSaved, setTemplateSaved] = useState<string>("grid");
  const initRef = useRef(false);
  // 原型 13：导航站配置（与私有新标签页配置相互独立，D29）
  const [themeColor, setThemeColor] = useState("#4f46e5");
  const [showSummary, setShowSummary] = useState(true);
  const [snapshotBadge, setSnapshotBadge] = useState(true);
  const [watermark, setWatermark] = useState(true);
  const [customCards, setCustomCards] = useState<Array<{ title: string; url: string; desc?: string }>>([]);
  const [cardDraft, setCardDraft] = useState({ title: "", url: "" });

  const load = useCallback(() => {
    fetchers.navSites(cfg).then(setSites).catch(() => setSites([]));
    fetchers.folderTree(cfg).then(setTree).catch(() => setTree([]));
  }, [cfg]);
  useEffect(load, [load]);

  // 站点详情并行拉取；首次拿到已发布站点时，把表单预填成当前配置并切到「我的站点」
  useEffect(() => {
    for (const s of sites) {
      fetchers
        .navSiteDetail(cfg, s.slug)
        .then((d) => {
          setDetails((prev) => ({ ...prev, [s.slug]: d }));
          if (!initRef.current && s.published === 1) {
            initRef.current = true;
            setTitle(d.title);
            setTemplate(d.template);
            setTemplateSaved(d.template);
            setSelected(new Set(d.scope.folderIds ?? []));
            if (d.config) {
              setThemeColor(d.config.themeColor ?? "#4f46e5");
              setShowSummary(d.config.showSummary !== false);
              setSnapshotBadge(d.config.snapshotBadge !== false);
              setWatermark(d.config.watermark !== false);
              setCustomCards(d.config.customCards ?? []);
            }
            setPane("site");
          }
        })
        .catch(() => {});
    }
  }, [sites, cfg]);

  const saveNavConfig = async () => {
    if (!site) {
      toast.info("先发布导航站，再保存外观配置");
      return;
    }
    setBusy(true);
    try {
      await apiCall(cfg, `/nav/sites/${site.slug}`, {
        method: "PATCH",
        body: JSON.stringify({
          config: { themeColor, showSummary, snapshotBadge, watermark, customCards },
        }),
      });
      toast.ok("外观配置已保存（站内实时生效）");
    } catch (e) {
      toast.err(`保存失败：${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const folders = useMemo(() => tree.filter((f) => f.is_system_inbox !== 1 && f.directCount + f.totalCount > 0), [tree]);
  const site = sites.find((s) => s.published === 1) ?? null;
  const detail = site ? details[site.slug] : undefined;

  const publish = async () => {
    if (selected.size === 0) {
      toast.info("默认私有：先在「发布设置」里勾选要公开的目录");
      setPane("settings");
      return;
    }
    setBusy(true);
    try {
      const r = await apiCall<{ slug: string; url: string; itemCount: number; published: boolean }>(cfg, "/nav/publish", {
        method: "POST",
        body: JSON.stringify({ title, template, password: password || undefined, folderIds: [...selected] }),
      });
      toast.ok(`${site ? "已更新" : "已发布"}：公开 ${r.itemCount} 项 · slug 随机不可枚举`);
      setTemplateSaved(template);
      setPassword("");
      setPane("site");
      load();
    } catch (e) {
      toast.err(`${site ? "更新" : "发布"}失败：${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveTemplate = async () => {
    if (!site || busy || template === templateSaved) return;
    setBusy(true);
    try {
      await apiCall(cfg, `/nav/sites/${site.slug}`, { method: "PATCH", body: JSON.stringify({ template }) });
      setTemplateSaved(template);
      toast.ok("模板已保存，公开页即时生效");
    } catch (e) {
      toast.err(`保存失败：${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async (slug: string) => {
    try {
      await apiCall(cfg, `/nav/sites/${slug}/unpublish`, { method: "POST" });
      toast.ok("已撤销发布（旧链接立即失效）");
      load();
      refreshBadges();
    } catch (e) {
      toast.err(`撤销失败：${e instanceof ApiError ? e.message : String(e)}`);
    }
  };

  const copyUrl = async (slug: string) => {
    await navigator.clipboard.writeText(apiUrl(cfg, `/s/${slug}`)).catch(() => {});
    toast.ok("链接已复制");
  };

  const RAIL: Array<{ key: PaneKey; label: string; icon: typeof Globe; badge?: string }> = [
    { key: "site", label: "我的站点", icon: Globe, badge: site ? "已发布" : undefined },
    { key: "template", label: "模板", icon: LayoutTemplate, badge: template !== templateSaved ? "有修改" : undefined },
    { key: "settings", label: "发布设置", icon: Settings2, badge: selected.size > 0 ? `${selected.size} 目录` : undefined },
  ];

  return (
    <PageScroll>
      <header className="mb-5">
        <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <Globe className="size-4" /> 导航站
        </h2>
        <p className="text-muted-foreground mt-1 text-[13px]">挑一批目录，生成一个可以发给朋友的导航主页。公开页仅元数据 + 摘要。</p>
      </header>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-[210px_1fr]">
        {/* 左：子导航 */}
        <aside className="hidden md:block">
          <div className="md:sticky md:top-24 space-y-0.5">
            {RAIL.map(({ key, label, icon: Icon, badge }) => (
              <button
                key={key}
                onClick={() => setPane(key)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                  pane === key ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                {badge && <span className="text-[10.5px] text-emerald-600 dark:text-emerald-400">{badge}</span>}
              </button>
            ))}
          </div>
        </aside>

        {/* 移动端功能 chips */}
        <div className="flex flex-wrap items-center gap-1.5 md:hidden">
          {RAIL.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setPane(key)}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs transition-colors",
                pane === key ? "bg-primary font-medium text-primary-foreground" : "bg-muted/70 text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 右：当前面板 */}
        <div className="min-w-0">
          {pane === "site" &&
            (site ? (
              <div className="bg-muted/40 rounded-xl p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      <span className="truncate">{site.title}</span>
                      <Badge variant="success">已发布</Badge>
                    </p>
                    <div className="mt-1 flex items-center gap-3">
                      <code className="text-muted-foreground truncate font-mono text-xs">
                        {cfg.serverUrl.replace(/^https?:\/\//, "")}/s/{site.slug}
                      </code>
                      <button className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs hover:underline" onClick={() => void copyUrl(site.slug)}>
                        <Copy className="size-3" /> 复制
                      </button>
                      <a className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs hover:underline" href={apiUrl(cfg, `/s/${site.slug}`)} target="_blank" rel="noreferrer">
                        预览 ↗
                      </a>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {detail && <span className="text-muted-foreground text-xs">公开 {detail.itemCount} 项</span>}
                    <button className="text-destructive inline-flex items-center gap-1 text-xs hover:underline" onClick={() => void unpublish(site.slug)}>
                      <RotateCcw className="size-3" /> 撤销发布
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState icon="🌐" title="还没有发布站点" hint="先在「模板」和「发布设置」里配置，发布后这里会显示站点状态与链接" />
            ))}

          {pane === "template" && (
            <div className="text-sm">
              <div>
                <label className="text-muted-foreground mb-1.5 block text-xs">挑一套模板</label>
                <div className="grid grid-cols-2 gap-2.5">
                  {TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTemplate(t.id)}
                      title={t.note}
                      className={cn(
                        "overflow-hidden rounded-xl text-left transition-colors",
                        template === t.id ? "bg-muted" : "hover:bg-accent/50",
                      )}
                    >
                      <TemplateThumb id={t.id} />
                      <div className="flex items-center gap-1 px-2.5 py-2 text-xs font-semibold">
                        {t.name}
                        {template === t.id && <Check className="ml-auto size-3.5" />}
                      </div>
                    </button>
                  ))}
                </div>
                {site && (
                  <div className="mt-2.5 flex justify-end">
                    <Btn onClick={() => void saveTemplate()} disabled={busy || template === templateSaved} title="把选中的模板应用到公开页">
                      {template === templateSaved ? "模板已保存" : "保存模板"}
                    </Btn>
                  </div>
                )}
              </div>
            </div>
          )}

          {pane === "settings" && (
            <div className="space-y-4 text-sm">
              <div>
                <label className="text-muted-foreground mb-1 block text-xs">站点标题</label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div>
                <label className="text-muted-foreground mb-1.5 block text-xs">公开哪些目录（私密 / 归档 / 收纳盒永不公开）</label>
                <div className="flex flex-wrap gap-1.5">
                  {folders.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => {
                        const next = new Set(selected);
                        if (next.has(f.id)) next.delete(f.id);
                        else next.add(f.id);
                        setSelected(next);
                      }}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs transition-colors",
                        selected.has(f.id) ? "border-primary/40 bg-primary text-primary-foreground" : "border-border hover:bg-accent",
                      )}
                    >
                      {f.name} · {f.totalCount}
                    </button>
                  ))}
                  {folders.length === 0 && <span className="text-muted-foreground text-xs">暂无目录，先去书签库整理</span>}
                </div>
                {selected.size > 0 && <p className="mt-1.5 text-xs">将公开这 {selected.size} 个目录下的书签（不含私密/归档项）</p>}
              </div>
              <div>
                <label className="text-muted-foreground mb-1 block text-xs">访问密码（可选 · 留空直接访问）</label>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="给分享链接加一层口令" />
              </div>
              <div className="border-t pt-4">
                <p className="mb-2 text-xs font-medium">外观（原型 13 · 实时预览）</p>
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-muted-foreground w-20 text-xs">主题色</span>
                  {THEME_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setThemeColor(c)}
                      aria-label={`主题色 ${c}`}
                      className={cn(
                        "size-6 rounded-lg border-2 transition-colors",
                        themeColor === c ? "border-primary" : "border-transparent",
                      )}
                      style={{ background: c }}
                    />
                  ))}
                </div>
                <div className="space-y-1.5 text-xs">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={showSummary} onChange={(e) => setShowSummary(e.target.checked)} />
                    显示书签摘要（仅 L1 摘要，<b>永不展示快照内容</b>）
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={snapshotBadge} onChange={(e) => setSnapshotBadge(e.target.checked)} />
                    失效书签显示「📸 快照可用」标识
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={watermark} onChange={(e) => setWatermark(e.target.checked)} />
                    页脚水印「由 my-favorites 生成」（自建端可关，D12）
                  </label>
                </div>
                <p className="text-muted-foreground mt-3 mb-1.5 text-xs font-medium">📌 自定义卡片（唯一允许任意 URL 的手动例外）</p>
                <ul className="space-y-1">
                  {customCards.map((c, i) => (
                    <li key={`${c.url}-${i}`} className="bg-muted/40 flex items-center gap-2 rounded-lg px-2.5 py-1 text-xs">
                      <span className="min-w-0 flex-1 truncate">{c.title} · <span className="text-muted-foreground">{c.url}</span></span>
                      <button className="text-muted-foreground hover:text-destructive" onClick={() => setCustomCards(list => list.filter((_, j) => j !== i))}>移除</button>
                    </li>
                  ))}
                </ul>
                <div className="mt-1.5 flex gap-1.5">
                  <Input className="h-7 flex-1 text-xs" placeholder="名称" value={cardDraft.title} onChange={(e) => setCardDraft(d => ({ ...d, title: e.target.value }))} />
                  <Input className="h-7 flex-1 text-xs" placeholder="https://…（可深链）" value={cardDraft.url} onChange={(e) => setCardDraft(d => ({ ...d, url: e.target.value }))} />
                  <Btn
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      if (!cardDraft.title || !/^https?:\/\//.test(cardDraft.url)) return;
                      setCustomCards(list => [...list, { title: cardDraft.title, url: cardDraft.url }]);
                      setCardDraft({ title: "", url: "" });
                    }}
                  >
                    ＋ 添加
                  </Btn>
                </div>
                <div className="mt-3 flex justify-end">
                  <Btn onClick={() => void saveNavConfig()} disabled={busy}>保存外观配置</Btn>
                </div>
              </div>
          <div className="flex justify-end">
            <Btn primary onClick={() => void publish()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Globe />} {site ? "保存设置" : "发布导航站"}
            </Btn>
          </div>
              <p className="text-muted-foreground text-[11px]">slug 加密随机不可枚举；死链卡片只显示「有快照」标识，快照内容不可访问（红线④）。</p>
            </div>
          )}
        </div>
      </div>
    </PageScroll>
  );
}

/** 模板缩略图（纯 CSS 示意） */
function TemplateThumb({ id }: { id: string }) {
  const box = "rounded bg-border/70";
  if (id === "list")
    return (
      <div className="bg-accent/60 space-y-1 p-2.5">
        <div className={cn(box, "h-2 w-full")} />
        <div className={cn(box, "h-2 w-5/6")} />
        <div className={cn(box, "h-2 w-full")} />
      </div>
    );
  if (id === "cards")
    return (
      <div className="bg-accent/60 grid grid-cols-2 gap-1.5 p-2.5">
        <div className={cn(box, "h-7")} />
        <div className={cn(box, "h-9")} />
        <div className={cn(box, "h-9")} />
        <div className={cn(box, "h-7")} />
      </div>
    );
  if (id === "home")
    return (
      <div className="bg-accent/60 grid grid-cols-[1fr_2fr] gap-1.5 p-2.5">
        <div className={cn(box, "h-12")} />
        <div className="space-y-1">
          <div className={cn(box, "h-2.5 w-full")} />
          <div className={cn(box, "h-2.5 w-4/5")} />
          <div className={cn(box, "h-2.5 w-3/5")} />
        </div>
      </div>
    );
  return (
    <div className="bg-accent/60 grid grid-cols-4 gap-1.5 p-2.5">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className={cn(box, "h-3")} />
      ))}
    </div>
  );
}
