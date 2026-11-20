/** 管理台共享 UI 适配层（shadcn/ui 之上）与格式化工具 */
import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiCall, type AdminConfig } from "@/lib/api";
import { cn } from "@/lib/utils";

// ---------- 按钮 ----------

export function Btn({
  children,
  onClick,
  primary,
  danger,
  disabled,
  title,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const variant = danger ? "destructive" : primary ? "default" : "outline";
  return (
    <Button variant={variant} size="sm" onClick={onClick} disabled={disabled} title={title} className={className}>
      {children}
    </Button>
  );
}

// ---------- 分节（首页同款：小标题 + 内容，无边框无卡片） ----------

export function Card({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("mb-7", className)}>
      {title !== undefined && (
        <div className="mb-1.5 flex w-full items-center gap-2 text-sm font-semibold">
          {/* preflight 把 svg 设为 block，标题内的行内图标需恢复 inline 才与文字同行 */}
          <span className="min-w-0 flex-1 truncate [&>svg]:inline [&>svg]:translate-y-px">{title}</span>
          {right}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-xl font-bold tracking-tight">{title}</h2>
        {sub && <p className="text-muted-foreground mt-1 text-sm">{sub}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

// ---------- 问候（个人产品的首页不是「仪表盘」，是一句早安） ----------

export function greeting(): string {
  const hh = new Date().getHours();
  if (hh < 5) return "夜深了";
  if (hh < 12) return "早上好";
  if (hh < 18) return "下午好";
  return "晚上好";
}

export function todayLabel(): string {
  return new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
}

// ---------- 数字卡（全部可钻取，不是死数字——用户已反馈的需求） ----------

export function Stat({
  num,
  label,
  bad,
  warn,
  onClick,
  hint,
}: {
  num: number | string;
  label: string;
  bad?: boolean;
  warn?: boolean;
  onClick?: () => void;
  hint?: string;
}) {
  const clickable = Boolean(onClick);
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => clickable && e.key === "Enter" && onClick?.()}
      title={hint}
      className={cn("tabular py-2 outline-none transition-opacity", clickable && "cursor-pointer hover:opacity-70")}
    >
      <div className={cn("text-xl font-semibold", bad && "text-red-500", warn && "text-amber-500")}>{num}</div>
      <div className="text-muted-foreground mt-0.5 text-xs">{label}</div>
    </div>
  );
}

// ---------- 反馈条（行内 busy 提示；完成/失败用 toast） ----------

export type Msg = { kind: "ok" | "err" | "busy"; text: string } | null;

export function FeedbackBar({ msg }: { msg: Msg }) {
  if (!msg) return null;
  const conf = {
    ok: { icon: <CheckCircle2 className="size-4 shrink-0" />, cls: "text-emerald-600 dark:text-emerald-400" },
    err: { icon: <AlertCircle className="size-4 shrink-0" />, cls: "text-red-500 dark:text-red-400" },
    busy: { icon: <Loader2 className="size-4 shrink-0 animate-spin" />, cls: "text-muted-foreground" },
  }[msg.kind];
  return <p className={cn("mt-3 flex items-center gap-1.5 text-sm", conf.cls)}>{conf.icon}{msg.text}</p>;
}

// ---------- Toast（全局右下角，替代散落各页的行内结果条） ----------

type ToastKind = "ok" | "err" | "info";
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

let toastItems: ToastItem[] = [];
let toastListeners: Array<(items: ToastItem[]) => void> = [];
let toastSeq = 1;

function pushToast(kind: ToastKind, text: string) {
  const item: ToastItem = { id: toastSeq++, kind, text };
  toastItems = [...toastItems, item];
  toastListeners.forEach((l) => l(toastItems));
  window.setTimeout(() => {
    toastItems = toastItems.filter((x) => x.id !== item.id);
    toastListeners.forEach((l) => l(toastItems));
  }, 3800);
}

export const toast = {
  ok: (text: string) => pushToast("ok", text),
  err: (text: string) => pushToast("err", text),
  info: (text: string) => pushToast("info", text),
};

// ---------- 整理通知方式（D28 三档：toast 轻提示（默认）/ card 通知卡 / silent 静默仅版本记录） ----------
// 管理台侧偏好存服务端 prefs；boot 时同步进内存缓存，整理成功提示统一走 tidyNotify（静默档不弹）。

export type NotifyStyle = "toast" | "card" | "silent";

let notifyStyleCache: NotifyStyle = "toast";

/** 更新内存中的通知方式（设置页保存后同步调用） */
export function setNotifyStyle(style: NotifyStyle): void {
  notifyStyleCache = style;
}

/** boot 时从服务端拉取通知方式进缓存（失败保持默认，不打扰主流程） */
export async function syncNotifyStyle(cfg: AdminConfig): Promise<void> {
  try {
    const r = await apiCall<{ notifyStyle?: NotifyStyle }>(cfg, "/settings/prefs");
    notifyStyleCache = r.notifyStyle ?? "toast";
  } catch {
    // 未连接/mock 下保持默认
  }
}

/**
 * 整理结果通知（D28）：成功提示按档位过滤（silent 不打扰，版本历史仍是记录）；
 * 失败提示永远展示——错误不属于「通知方式」可静默的范围。
 */
export const tidyNotify = {
  ok: (text: string) => {
    if (notifyStyleCache !== "silent") toast.ok(text);
  },
  err: (text: string) => toast.err(text),
};

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>(toastItems);
  useEffect(() => {
    toastListeners.push(setItems);
    return () => {
      toastListeners = toastListeners.filter((l) => l !== setItems);
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-80 flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className="bg-popover pointer-events-auto flex items-start gap-2 rounded-xl border p-3 text-sm shadow-lg animate-in slide-in-from-bottom-2 fade-in"
        >
          {t.kind === "ok" ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          ) : t.kind === "err" ? (
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
          ) : (
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 leading-relaxed">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- 书签状态（轻量：圆点 + 文字，替代重底色徽章） ----------

const STATUS_META: Record<string, { label: string; dot: string; text: string }> = {
  dead: { label: "失效", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  suspect: { label: "疑似", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
  normal: { label: "正常", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  archived: { label: "已归档", dot: "bg-zinc-400", text: "text-muted-foreground" },
};

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status];
  if (!meta) return <Badge variant="outline">{status}</Badge>;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs", meta.text)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}

// ---------- 站点图标（favicon 优先，失败回退中性字母块） ----------

export function LetterAvatar({ title, url, size = "md" }: { title: string; url?: string; size?: "sm" | "md" | "lg" }) {
  const letter = (title.trim()[0] ?? "?").toUpperCase();
  const cls = { sm: "size-7 text-[10px] rounded-md", md: "size-8 text-xs rounded-lg", lg: "size-9 text-sm rounded-lg" }[size];
  return (
    <span
      className={cn("bg-muted text-muted-foreground flex shrink-0 items-center justify-center font-bold", cls)}
      aria-hidden
    >
      {letter}
    </span>
  );
}

export function SiteIcon({ title, url, size = "md" }: { title: string; url?: string; size?: "sm" | "md" | "lg" }) {
  // "loading" 超过 2.5s（离线/外网受限）也回退字母块，不留空框
  const [phase, setPhase] = useState<"loading" | "ok" | "fail">("loading");
  const cls = { sm: "size-7 rounded-md", md: "size-8 rounded-lg", lg: "size-9 rounded-lg" }[size];
  const host = url ? hostOf(url) : "";
  const src = host ? `https://icons.duckduckgo.com/ip3/${host}.ico` : "";
  useEffect(() => {
    setPhase("loading");
    if (!src) return;
    const t = window.setTimeout(() => setPhase((p) => (p === "loading" ? "fail" : p)), 2500);
    return () => window.clearTimeout(t);
  }, [src]);
  if (!src || phase === "fail") return <LetterAvatar title={title} url={url} size={size} />;
  return (
    <span className={cn("bg-card flex shrink-0 items-center justify-center overflow-hidden border border-border/60", cls)} aria-hidden>
      <img
        src={src}
        alt=""
        className={cn("size-[60%] object-contain transition-opacity", phase === "ok" ? "opacity-100" : "opacity-0")}
        loading="lazy"
        onLoad={() => setPhase("ok")}
        onError={() => setPhase("fail")}
      />
    </span>
  );
}

// ---------- 空态 / 骨架 ----------

/** 区块内行级空态：设置页卡片等无图标场景，与 EmptyState 的说明文字同一字号 */
export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground py-8 text-center text-xs">{children}</p>;
}

/** 页面容器：居中窄栏，随页面自然滚动（无内部滚动条） */
export function PageScroll({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[920px] px-5 pt-6 pb-16", className)}>{children}</div>;
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  // 全站唯一的页面级空态样式：克制的图标 + medium 标题 + 弱化说明，居中大留白
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-14 text-center">
      {icon && <div className="mb-1 text-2xl opacity-80">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="text-muted-foreground max-w-sm text-xs leading-relaxed">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-muted", className)} />;
}

// ---------- 开关（功能模块等布尔设置用） ----------

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        checked ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-card shadow-xs transition-all",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  // 复刻书签行结构：mx-1+px-3 与行内容左缘对齐，右侧预留时长列
  return (
    <div className="space-y-1 p-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="mx-1 flex items-center gap-3 rounded-xl px-3 py-2.5">
          <Skeleton className="size-4 shrink-0 rounded-[5px]" />
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-2.5 w-1/4" />
          </div>
          <Skeleton className="h-3 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

// ---------- 格式化 ----------

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

/** 入库时长：今天 / N 天 / N 周 / N 个月 / N 年（列表与详情展示、后续入库新旧分析共用） */
export function libraryAge(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const days = Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
  if (days === 0) return "今天";
  if (days < 7) return `${days} 天`;
  if (days < 30) return `${Math.floor(days / 7)} 周`;
  if (days < 365) return `${Math.floor(days / 30)} 个月`;
  const years = (days / 365).toFixed(1).replace(/\.0$/, "");
  return `${years} 年`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} 天前`;
  return iso.slice(0, 10);
}

/** ISO 周数（体检报告「第 N 周」用） */
export function isoWeek(iso: string): number {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return 0;
  const target = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
}

/** 触发浏览器下载 blob */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
