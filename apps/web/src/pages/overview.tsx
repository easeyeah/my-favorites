/**
 * 今天（首页）：不是工作台，是「产品已经替你做了什么」的安静回执。
 * 哲学：产品了解用户、自动处理（D27 收纳盒默认全自动 + 直接生效可撤销）；
 * 首页只汇报自动处理的动态（可撤销）与内容（最近添加），绝不给用户派任务。
 */
import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Skeleton, greeting, PageScroll, SiteIcon, tidyNotify, timeAgo, todayLabel, toast } from "@/components/shared";
import { useRoute, useShell } from "@/components/layout";
import { ApiError, apiCall, fetchers, type Bookmark, type HealthReport, type LinkCheckReport, type Stats, type VersionRow } from "@/lib/api";
import { cn } from "@/lib/utils";

interface FeedItem {
  key: string;
  time: string;
  text: string;
  undo?: VersionRow;
  tag?: string;
}

export function Overview() {
  const { cfg, refreshBadges } = useShell();
  const { go } = useRoute();
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [report, setReport] = useState<LinkCheckReport | null>(null);
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [recent, setRecent] = useState<Bookmark[]>([]);
  const [undoing, setUndoing] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchers.stats(cfg).then(setStats).catch(() => setStats(null));
    fetchers.healthReport(cfg).then(setHealth).catch(() => setHealth(null));
    fetchers.linkReport(cfg).then(setReport).catch(() => setReport(null));
    fetchers.versions(cfg).then((r) => setVersions(r.versions)).catch(() => setVersions([]));
    fetchers
      .bookmarks(cfg, { limit: 50 })
      .then((list) => setRecent([...list].sort((a, b) => b.added_at.localeCompare(a.added_at)).slice(0, 6)))
      .catch(() => setRecent([]));
  }, [cfg]);
  useEffect(load, [load]);

  /** 撤销某次自动整理（回滚 = 逆放 diff 生成新版本） */
  const rollback = async (v: VersionRow) => {
    setUndoing(v.id);
    try {
      const r = await apiCall<{ reversed: number }>(cfg, `/organize/rollback/${v.id}`, { method: "POST" });
      tidyNotify.ok(`已撤销 ${r.reversed} 项（生成新版本，历史未删除）`);
      load();
      refreshBadges();
    } catch (e) {
      toast.err(`撤销失败：${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setUndoing(null);
    }
  };

  const dead = health?.dead ?? 0;
  const suspect = health?.suspect ?? 0;
  const calm = dead === 0 && suspect === 0;

  // 自动动态 = 产品最近做的事（整理版本 + 体检标注），全部是「已完成」，不是待办
  const feed: FeedItem[] = [];
  for (const v of versions ?? []) {
    feed.push({
      key: v.id,
      time: timeAgo(v.created_at),
      text: `${v.kind || "整理"}，${v.actionCount} 项变更`,
      undo: v.reverted === 0 ? v : undefined,
    });
  }
  if (feed.length < 4 && dead > 0 && report) {
    feed.push({
      key: "dead",
      time: timeAgo(report.created_at),
      text: `检测发现 ${dead} 个失效链接，已标注并保留快照`,
      tag: "已标注",
    });
  }
  if (feed.length < 4 && suspect > 0 && report) {
    feed.push({
      key: "suspect",
      time: timeAgo(report.created_at),
      text: `${suspect} 条疑似失效（反爬拦截），按保守规则仅标注，不打扰你`,
      tag: "仅标注",
    });
  }
  const feedSlice = feed.slice(0, 4);

  return (
    <PageScroll>
      {/* 问候 */}
      <header className="pb-6 pt-1">
        <h1 className="text-[22px] font-bold tracking-tight">
          {greeting()} <span className="align-middle">👋</span>
        </h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          {todayLabel()}
          {stats && (
            <>
              {" · "}库里 {stats.total.toLocaleString()} 条书签
            </>
          )}
          {calm && stats ? "，一切正常 ✨" : ""}
        </p>
      </header>

      {/* 自动化承诺：产品在替你盯着，不是你在盯产品 */}
      <div className="text-muted-foreground mb-8 flex flex-wrap gap-x-6 gap-y-1.5 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="bg-emerald-500 size-1.5 rounded-full" />
          收纳盒自动归位
        </span>
        <span className="flex items-center gap-1.5">
          <span className="bg-emerald-500 size-1.5 rounded-full" />
          失效链接自动检测
        </span>
        <span className="flex items-center gap-1.5">
          <span className="bg-emerald-500 size-1.5 rounded-full" />
          隐私域名强制保护
        </span>
        <button
          className="hover:text-foreground inline-flex items-center gap-1 hover:underline"
          onClick={() => go("bookmarks")}
          title="查看与调整自动化行为"
        >
          管理 →
        </button>
      </div>

      {/* AI 动态：已经做了什么（全部可撤销），不是待办清单 */}
      <section className="mb-9">
        <h2 className="mb-1 text-sm font-semibold">最近的自动动态</h2>
        {versions === null ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-2.5">
                <Skeleton className="h-3 w-16 shrink-0" />
                <Skeleton className="h-3.5 flex-1" />
                <Skeleton className="h-4 w-14 shrink-0 rounded-full" />
              </div>
            ))}
          </div>
        ) : feedSlice.length === 0 ? (
          <p className="text-muted-foreground bg-muted/50 rounded-xl px-4 py-5 text-sm leading-relaxed">
            ✨ 一切正常。AI 会在后台自动归位收纳盒、合并重复、定期体检——每一次自动处理都会出现在这里，随时可撤销。
          </p>
        ) : (
          <ul className="divide-border/60 divide-y">
            {feedSlice.map((item) => (
              <li key={item.key} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="text-muted-foreground/60 w-16 shrink-0 text-xs">{item.time}</span>
                <span className="min-w-0 flex-1">{item.text}</span>
                {item.tag && (
                  <span className="border-border/60 text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-[10.5px]">
                    {item.tag}
                  </span>
                )}
                {item.undo && (
                  <button
                    className="text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded-md px-1.5 py-1 text-xs transition-colors"
                    disabled={undoing !== null}
                    onClick={() => void rollback(item.undo!)}
                    title="撤销这次自动处理（逆放 diff 生成新版本）"
                  >
                    <RotateCcw className={cn("size-3", undoing === item.undo.id && "animate-spin")} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 最近添加：内容浏览，不是任务 */}
      {recent.length > 0 && (
        <section className="mb-9">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-sm font-semibold">最近添加</h2>
            <button className="text-muted-foreground hover:text-foreground text-xs hover:underline" onClick={() => go("bookmarks")}>
              全部书签 →
            </button>
          </div>
          <div className="grid gap-x-10 sm:grid-cols-2">
            {recent.map((b) => (
              <button
                key={b.id}
                className="hover:bg-accent/50 flex w-full items-center gap-2.5 px-1.5 py-1.5 text-left transition-colors"
                onClick={() => go("bookmarks")}
              >
                <SiteIcon title={b.title} url={b.url_canonical} size="sm" />
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {b.is_private === 1 && <span className="mr-0.5 text-xs">🛡</span>}
                  {b.title}
                </span>
                <span className="text-muted-foreground/60 shrink-0 text-[11px]">{timeAgo(b.added_at)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* 安静的事实行 */}
      <p className="text-muted-foreground/60 text-xs">
        {stats && `${stats.total.toLocaleString()} 条书签 · ${stats.folders} 个目录`}
        {health && ` · 快照 ${health.snapshotUsageMb} MB`}
        {report && ` · 上次体检 ${report.created_at.slice(0, 10)}`}
      </p>
    </PageScroll>
  );
}
