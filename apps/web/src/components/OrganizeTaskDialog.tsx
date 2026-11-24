/**
 * D92 目录整理任务对话框（《书签目录自动整理重设计》§4）
 *
 * 一次目录整理 = 一个可追踪的任务：这里呈现真实阶段、真实计数与逐条去向。
 *  - 关闭/Esc = 收起（任务继续），只有「停止整理」才停止；收起后可从目录树底部「整理记录」找回；
 *  - 进行中：阶段说明 + 已检查/归位/转资料计数 + 已落库的最近完成（不以定时器伪造进度）；
 *  - 终态：书签移动 / 转资料 / 保持 / 跳过 / 失败分页明细，目录与资料分类变化，继续剩余、重试失败、整次撤销；
 *  - 零变更先给解释（规则降级 / 证据不足 / 失败），不展示空白成功页。
 *
 * 数据真相走 REST（useOrganizeTask：task 门铃 + 进行中低频轮询）；对话框自身持续更新，
 * 不受 D82 编辑/弹窗阻塞补轮的影响。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  BookMarked,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  History,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  Square,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Btn, NumberedPagination, toast } from "@/components/shared";
import { useRoute, useShell } from "@/components/layout";
import { subscribeMockTask, subscribeTasks } from "@/lib/events";
import { isMock } from "@/lib/mock";
import { cn } from "@/lib/utils";
import {
  ApiError,
  fetchers,
  type AdminConfig,
  type OrganizeTask,
  type OrganizeTaskCategory,
  type OrganizeTaskFolder,
  type OrganizeTaskItem,
} from "@/lib/api";
import {
  DECISION_LABEL,
  RESULT_TABS,
  elapsedLabel,
  isTaskActive,
  taskHeadline,
  taskReasonLabel,
  undoSummary,
  useOrganizeTask,
  type TaskTone,
} from "@/lib/organize-task";

/** 对话框入口：从某个目录发起 / 查看某个任务 / 整理记录列表 */
export type OrganizeTaskTarget =
  | { mode: "start"; folderId: string; folderName: string; requestId: string }
  | { mode: "task"; taskId: string }
  | { mode: "list" }
  | null;

const PAGE_SIZE = 10;

const TONE_DOT: Record<TaskTone, string> = {
  busy: "bg-primary",
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  danger: "bg-red-500",
};

const FOLDER_STATE: Record<string, string> = { planned: "拟新建", created: "新建", reused: "复用", unapplied: "未应用" };
const CATEGORY_STATE: Record<string, string> = { planned: "拟使用", new: "新建分类", reused: "复用分类", unapplied: "未应用" };

function taskStatusLabel(t: OrganizeTask): string {
  if (t.undo_status === "pending" || t.undo_status === "running") return "撤销中";
  if (t.undo_status === "completed") return "已撤销";
  if (t.undo_status === "partial") return "部分撤销";
  if (t.status === "queued") return "排队中";
  if (t.status === "running") return "整理中";
  if (t.status === "stopping") return "停止中";
  if (t.status === "stopped") return "已停止";
  if (t.status === "failed") return "失败";
  if (t.status === "completed_with_issues") return t.mode === "rule_only" ? "按规则整理" : "需留意";
  return "已完成";
}

export function OrganizeTaskDialog({
  target,
  onOpenChange,
  onTask,
  onChanged,
  onOpenFolder,
  onOpenCategory,
  onShowHistory,
  onRestart,
}: {
  target: OrganizeTaskTarget;
  onOpenChange: (next: OrganizeTaskTarget) => void;
  /** 详情任务快照变化（页面据此判断是否仍有进行中的任务） */
  onTask: (task: OrganizeTask) => void;
  /** 任务从进行中落定（含撤销完成）后通知页面刷新树/列表/角标 */
  onChanged: () => void;
  onOpenFolder: (folderId: string) => void;
  onOpenCategory: (categoryPath: string) => void;
  onShowHistory: () => void;
  /** 基于最新状态新开一次整理（旧任务已撤销/快照过期时，不能沿原方案继续） */
  onRestart: (folderId: string) => void;
}) {
  const { cfg } = useShell();
  const [detail, setDetail] = useState<{ taskId: string; viaList: boolean } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const create = useCallback(
    async (folderId: string, requestId: string) => {
      setStartError(null);
      try {
        const r = await fetchers.organizeTaskCreate(cfg, folderId, requestId);
        // 已有进行中的整理：服务端回它而不并行——如实说明，不假装新任务已开始
        setNotice(r.existing ? "已有进行中的整理，先为你打开它；等它结束或停止后再整理这个目录" : null);
        setDetail({ taskId: r.task.id, viaList: false });
      } catch (e) {
        setStartError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      }
    },
    [cfg],
  );

  // 入口变化时重置内部视图（关闭后再次打开不残留上一个任务）
  useEffect(() => {
    if (!target) return;
    setStartError(null);
    setNotice(null);
    if (target.mode === "start") {
      setDetail(null);
      void create(target.folderId, target.requestId);
    } else if (target.mode === "task") {
      setDetail({ taskId: target.taskId, viaList: false });
    } else {
      setDetail(null);
    }
  }, [target, create]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onOpenChange(null); }}>
      <DialogContent className="sm:max-w-2xl" data-organize-task>
        {target?.mode === "list" && !detail ? (
          <TaskList
            cfg={cfg}
            onPick={(taskId) => setDetail({ taskId, viaList: true })}
            onClose={() => onOpenChange(null)}
          />
        ) : detail ? (
          <TaskDetail
            cfg={cfg}
            taskId={detail.taskId}
            notice={notice}
            onChanged={onChanged}
            onTask={onTask}
            onClose={() => onOpenChange(null)}
            onOpenFolder={onOpenFolder}
            onOpenCategory={onOpenCategory}
            onShowHistory={onShowHistory}
            onRestart={onRestart}
            onBack={detail.viaList ? () => { setDetail(null); setNotice(null); } : undefined}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="text-primary size-4" /> 整理「{target?.mode === "start" ? target.folderName : ""}」
              </DialogTitle>
              <DialogDescription>
                来源：该目录及其子目录的全部收藏；去向：目录内的书签分类，或你的资料分类。关闭后任务继续。
              </DialogDescription>
            </DialogHeader>
            <div className="bg-muted/50 rounded-xl px-4 py-6 text-center" role="status" aria-live="polite">
              {startError ? (
                <>
                  <p className="text-[13px] text-red-500">任务未能创建：{startError}</p>
                  <div className="mt-3 flex justify-center gap-2">
                    {target?.mode === "start" && <Btn onClick={() => void create(target.folderId, target.requestId)}>重试</Btn>}
                    <Btn onClick={() => onOpenChange(null)}>关闭</Btn>
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground flex items-center justify-center gap-2 text-[13px]">
                  <Loader2 className="text-primary size-3.5 animate-spin" /> 正在创建整理任务…
                </p>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ==================== 任务详情 ====================

function TaskDetail({
  cfg,
  taskId,
  notice,
  onChanged,
  onTask,
  onClose,
  onOpenFolder,
  onOpenCategory,
  onShowHistory,
  onRestart,
  onBack,
}: {
  cfg: AdminConfig;
  taskId: string;
  notice: string | null;
  onChanged: () => void;
  onTask: (task: OrganizeTask) => void;
  /** 收起（任务继续）——Esc/关闭按钮同义；停止另有按钮 */
  onClose: () => void;
  onOpenFolder: (folderId: string) => void;
  onOpenCategory: (categoryPath: string) => void;
  onShowHistory: () => void;
  onRestart: (folderId: string) => void;
  onBack?: () => void;
}) {
  const { task, error, refresh } = useOrganizeTask(cfg, taskId);
  const { go } = useRoute();
  const active = isTaskActive(task);
  const [busy, setBusy] = useState<"stop" | "continue" | "retry" | "undo" | null>(null);
  const [tab, setTab] = useState("moved");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<OrganizeTaskItem[] | null>(null);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [protectedCount, setProtectedCount] = useState(0);
  const [folders, setFolders] = useState<OrganizeTaskFolder[] | null>(null);
  const [categories, setCategories] = useState<OrganizeTaskCategory[] | null>(null);
  const [showFolders, setShowFolders] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const status = task?.status ?? "";
  const undoStatus = task?.undo_status ?? "none";
  const revision = task?.revision ?? -1;

  // 从进行中落定（含撤销完成）只通知页面一次
  const prevRef = useRef<string>("");
  useEffect(() => {
    if (!task) return;
    onTask(task);
    const sig = `${task.status}|${task.undo_status}`;
    const prev = prevRef.current;
    prevRef.current = sig;
    if (!prev) return; // 首次快照：页面已有数据，不需要刷新
    const [prevStatus, prevUndo] = prev.split("|") as [string, string];
    const wasActive =
      ["queued", "running", "stopping"].includes(prevStatus) || ["pending", "running"].includes(prevUndo);
    const undoJustSettled = ["pending", "running"].includes(prevUndo) && !["pending", "running"].includes(task.undo_status);
    // 任务落定或撤销完成：书签已回到原位、目录可能被回收——页面需要刷新树/列表/角标
    if ((wasActive && !isTaskActive(task)) || undoJustSettled) {
      window.dispatchEvent(new Event("mf:versions-changed"));
      onChanged();
    }
  }, [status, undoStatus, task, onChanged, onTask]);

  // 秒表：进行中每秒走；终态停在结束时刻
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  // 明细：页签/页码/任务推进（revision）变化时重查
  useEffect(() => {
    if (!task) return;
    const controller = new AbortController();
    setItems(null);
    fetchers
      .organizeTaskItems(cfg, taskId, { result: tab, offset: (page - 1) * PAGE_SIZE }, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        setItems(r.items);
        setItemsTotal(r.total);
        setProtectedCount(r.protectedCount);
        const last = Math.max(1, Math.ceil(r.total / PAGE_SIZE));
        if (page > last) setPage(last);
      })
      .catch(() => {
        /* 保留旧页；任务门铃/轮询会再次触发 */
      });
    return () => controller.abort();
  }, [cfg, taskId, tab, page, revision, Boolean(task)]);

  // 目录/资料分类变化：任务落定后读取一次（落定后不再变化）
  useEffect(() => {
    if (!task || active) return;
    const controller = new AbortController();
    fetchers.organizeTaskFolders(cfg, taskId, controller.signal).then((r) => { if (!controller.signal.aborted) setFolders(r.folders); }).catch(() => undefined);
    fetchers.organizeTaskCategories(cfg, taskId, controller.signal).then((r) => { if (!controller.signal.aborted) setCategories(r.categories); }).catch(() => undefined);
    return () => controller.abort();
  }, [cfg, taskId, active, Boolean(task)]);

  const act = async (kind: "stop" | "continue" | "retry" | "undo") => {
    if (busy) return;
    setBusy(kind);
    try {
      if (kind === "stop") {
        await fetchers.organizeTaskStop(cfg, taskId);
        toast.info("已请求停止：当前批次收尾后不再提交新的调整");
      } else if (kind === "continue") {
        const r = await fetchers.organizeTaskContinue(cfg, taskId, "remaining");
        toast.info(`继续整理剩余 ${r.reopened} 条`);
      } else if (kind === "retry") {
        const r = await fetchers.organizeTaskContinue(cfg, taskId, "failed");
        toast.info(`重试 ${r.reopened} 条失败项`);
      } else {
        await fetchers.organizeTaskUndo(cfg, taskId);
        toast.info(active ? "已请求撤销：先停止并排空在途提交，再按批次逆序恢复" : "正在撤销这次整理…");
      }
      await refresh();
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : `操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (!task) {
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="text-primary size-4" /> 整理任务
          </DialogTitle>
        </DialogHeader>
        <div className="bg-muted/50 rounded-xl px-4 py-6 text-center" role="status">
          {error ? (
            <p className="text-[13px] text-red-500">任务暂时读不到：{error}</p>
          ) : (
            <p className="text-muted-foreground flex items-center justify-center gap-2 text-[13px]">
              <Loader2 className="text-primary size-3.5 animate-spin" /> 正在读取任务…
            </p>
          )}
        </div>
      </>
    );
  }

  const headline = taskHeadline(task);
  const pct = task.total > 0 ? Math.round((task.checked / task.total) * 100) : 0;
  const changed = task.moved + task.converted;
  const tabs = RESULT_TABS.map((t) => ({ ...t, count: countOf(task, t.key) }));
  const canStop = ["queued", "running"].includes(task.status) && !["pending", "running"].includes(undoStatus);
  const canContinue = !active && task.can_continue && undoStatus === "none" && task.remaining > 0;
  const canRetry = !active && task.can_continue && undoStatus === "none" && task.failed > 0;
  const canUndo = changed > 0 && undoStatus !== "completed" && !active;
  // 旧任务已撤销或快照过期：只能基于最新状态重新整理
  const canRestart = !active && (["completed", "partial"].includes(undoStatus) || !task.can_continue);
  const undoText = undoSummary(task);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              aria-label="返回整理记录"
              className="text-muted-foreground hover:bg-accent hover:text-foreground rounded p-1 transition-colors"
            >
              <ArrowLeft className="size-4" />
            </button>
          )}
          <Sparkles className="text-primary size-4" />
          <span className="min-w-0 flex-1 truncate">整理「{task.folder_name}」</span>
          <Badge variant="outline" className="shrink-0 font-normal">{taskStatusLabel(task)}</Badge>
        </DialogTitle>
        <DialogDescription>
          来源：该目录及其子目录 · 去向：目录内的书签分类 / 你的资料分类。关闭后任务继续，可从「整理记录」找回。
        </DialogDescription>
      </DialogHeader>

      {notice && active && (
        <p className="bg-muted/60 rounded-lg px-3 py-2 text-xs" role="note">{notice}</p>
      )}

      {/* 正文区固定高度内滚动：标题与操作栏常驻，目录/资料分类同时展开也不把对话框顶出视口 */}
      <div className="scroll-slim max-h-[min(58vh,560px)] space-y-3 overflow-y-auto pr-1">
        {/* 状态块：真实阶段 + 真实计数 */}
        <div className="bg-muted/50 rounded-xl px-4 py-3" role="status" aria-live="polite" data-task-status={task.status}>
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
              {active ? (
                <Loader2 className="text-primary size-3.5 shrink-0 animate-spin" />
              ) : (
                <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", TONE_DOT[headline.tone])} />
              )}
              <span className="min-w-0 truncate">{headline.text}</span>
            </span>
            <span className="text-muted-foreground shrink-0 text-xs tabular">
              {task.checked} / {task.total} · {elapsedLabel(task.started_at ?? task.created_at, task.finished_at, nowMs)}
            </span>
          </div>
          <Progress value={active ? Math.max(2, pct) : pct} className="mt-2 h-1.5" aria-label="检查进度" />
          <p className="text-muted-foreground mt-2 text-xs tabular">
            已检查 {task.checked}/{task.total} · 书签归位 {task.moved} · 转资料 {task.converted} · 保持 {task.unchanged} · 跳过 {task.skipped}
            {task.failed > 0 && <span className="text-red-500"> · 失败 {task.failed}</span>}
            {task.remaining > 0 && !active && <span> · 剩余 {task.remaining}</span>}
          </p>
          {task.protected_count > 0 && (
            <p className="text-muted-foreground/70 mt-1 text-[11px]">另有 {task.protected_count} 条私密或隐私条目未参与（不送模型、不移动）</p>
          )}
          {task.topics.length > 0 && (
            <p className="text-muted-foreground mt-1 text-[11px]">
              归纳出的主题：{task.topics.map((t) => (
                <span key={t} className="bg-card mx-0.5 inline-block rounded px-1.5 py-0.5">{t}</span>
              ))}
            </p>
          )}
          {task.planned_new_folders > 0 && (
            <p className="text-muted-foreground mt-1 text-[11px]">
              目录方案：拟新建 {task.planned_new_folders} 个{task.created_folders > 0 ? `（已创建 ${task.created_folders} 个）` : ""}
              {task.reused_folders > 0 ? ` · 复用现有 ${task.reused_folders} 个` : ""}
            </p>
          )}
          {task.planned_categories > 0 && (
            <p className="text-muted-foreground mt-1 text-[11px]">
              资料分类：{task.planned_categories} 个{task.new_categories + task.reused_categories > 0 ? `（新建 ${task.new_categories} · 复用 ${task.reused_categories}）` : ""}
            </p>
          )}
          {task.mode === "rule_only" && (
            <p className="text-muted-foreground mt-1 text-[11px]">
              未配置整理模型：本次只按本地规则归位，没有做 AI 主题发现、新目录规划和资料分流。
            </p>
          )}
        </div>

        {error && (
          <p className="text-xs text-amber-600 dark:text-amber-400" role="alert">
            状态暂时未更新：{error}
            <button className="ml-2 underline-offset-2 hover:underline" onClick={() => void refresh()}>重试</button>
          </p>
        )}

        {undoText && (
          <p className="bg-muted/60 rounded-lg px-3 py-2 text-xs" data-task-undo>
            {undoText}
          </p>
        )}

          {/* 结果区；进行中为「最近完成」预留高度——首批结果出现时操作栏不位移（停止按钮不能在用户伸手时跳走） */}
          {active ? (
            <section aria-label="最近完成" className="min-h-[148px]">
              <h4 className="text-muted-foreground mb-1.5 text-xs font-medium">最近完成</h4>
              <RecentResults cfg={cfg} taskId={taskId} revision={revision} />
            </section>
          ) : changed === 0 ? (
          <ZeroChangeExplainer cfg={cfg} taskId={taskId} task={task} onOpenSettings={() => go("settings", undefined, "ai")} />
        ) : (
          <>
              <div className="bg-muted/60 flex w-fit flex-wrap items-center gap-0.5 rounded-full p-1" role="tablist" aria-label="整理结果">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => { setTab(t.key); setPage(1); }}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs transition-all",
                    tab === t.key ? "bg-card text-foreground shadow-xs font-medium" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label} {t.count}
                </button>
              ))}
            </div>
            <ItemRows
              items={items}
              total={itemsTotal}
              protectedCount={protectedCount}
              page={page}
              tab={tab}
              onPage={setPage}
            />
          </>
        )}

        {/* 结构变化：目录 / 资料分类 */}
        {!active && (task.planned_new_folders + task.reused_folders > 0 || task.planned_categories > 0) && (
          <div className="space-y-1">
            {task.planned_new_folders + task.reused_folders > 0 && (
              <div className="rounded-xl">
                <button
                  className="data-row flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px]"
                  aria-expanded={showFolders}
                  onClick={() => setShowFolders((v) => !v)}
                >
                  {showFolders ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  <FolderOpen className="size-3.5" /> 目录变化
                  <span className="text-muted-foreground text-xs">
                    新建 {task.created_folders} · 复用 {task.reused_folders}
                  </span>
                </button>
                {showFolders && <FolderRows folders={folders} onOpen={onOpenFolder} />}
              </div>
            )}
            {task.planned_categories > 0 && (
              <div className="rounded-xl">
                <button
                  className="data-row flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px]"
                  aria-expanded={showCategories}
                  onClick={() => setShowCategories((v) => !v)}
                >
                  {showCategories ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  <BookMarked className="size-3.5" /> 资料分类
                  <span className="text-muted-foreground text-xs">
                    新建 {task.new_categories} · 复用 {task.reused_categories}
                  </span>
                </button>
                {showCategories && <CategoryRows categories={categories} onOpen={onOpenCategory} />}
              </div>
            )}
            <p className="text-muted-foreground px-2 text-[11px]">
              被迁空的旧目录会保留，不会自动删除；可在目录树里自行处理。
            </p>
          </div>
        )}
      </div>

      <DialogFooter className="flex-wrap gap-2 sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {canStop && (
            <Btn size="xs" disabled={busy !== null} onClick={() => void act("stop")} title="停止后不再提交新的调整；已提交的结果保留且可撤销">
              {busy === "stop" ? <Loader2 className="animate-spin" /> : <Square />} 停止整理
            </Btn>
          )}
          {task.status === "stopping" && <span className="text-muted-foreground text-xs">正在停止，等待当前批次收尾…</span>}
          {canContinue && (
            <Btn size="xs" disabled={busy !== null} onClick={() => void act("continue")} title={`继续处理剩余 ${task.remaining} 条`}>
              {busy === "continue" ? <Loader2 className="animate-spin" /> : <Play />} 继续剩余
            </Btn>
          )}
          {canRetry && (
            <Btn size="xs" disabled={busy !== null} onClick={() => void act("retry")} title={`重试 ${task.failed} 条失败项`}>
              {busy === "retry" ? <Loader2 className="animate-spin" /> : <Play />} 重试失败项
            </Btn>
          )}
          <Btn size="xs" onClick={onShowHistory} title="在版本历史里查看这次整理的批次">
            <History /> 版本历史
          </Btn>
        </div>
        <div className="flex items-center gap-2">
          {canUndo && (
            <Btn
              size="xs"
              disabled={busy !== null}
              onClick={() => void act("undo")}
              title={undoStatus === "none" ? "恢复这次整理的书签归位与转换；资料与正文保留" : "继续未完成的撤销"}
            >
              {busy === "undo" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              {undoStatus === "none" ? "撤销本次整理" : "继续撤销"}
            </Btn>
          )}
          {canRestart && (
            <Btn size="xs" onClick={() => onRestart(task.folder_id)} title="基于最新状态新开一次整理">
              <Sparkles /> 重新整理
            </Btn>
          )}
          <Btn size="xs" onClick={onClose} title={active ? "收起后任务继续，可从目录树底部「整理记录」找回" : undefined}>
            {active ? "收起，继续浏览" : "关闭"}
          </Btn>
        </div>
      </DialogFooter>
    </>
  );
}

function countOf(t: OrganizeTask, key: string): number {
  switch (key) {
    case "moved": return t.moved;
    case "converted": return t.converted;
    case "unchanged": return t.unchanged;
    case "skipped": return t.skipped;
    case "failed": return t.failed;
    default: return 0;
  }
}

/** 进行中的「最近完成」：只列已落库的归位与转资料（最多 5 条） */
function RecentResults({ cfg, taskId, revision }: { cfg: AdminConfig; taskId: string; revision: number }) {
  const [items, setItems] = useState<OrganizeTaskItem[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetchers
      .organizeTaskItems(cfg, taskId, { result: "changed", offset: 0 }, controller.signal)
      .then((r) => { if (!controller.signal.aborted) setItems(r.items.slice(0, 5)); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [cfg, taskId, revision]);
  if (items.length === 0) return <p className="text-muted-foreground px-2 text-xs">还没有已落库的调整——方案确定后才会开始移动。</p>;
  return (
    <ul className="space-y-0.5">
      {items.map((it) => (
        <li key={it.id} className="data-row flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]">
          <span className="min-w-0 flex-1 truncate">{it.title}</span>
          <span className="text-muted-foreground max-w-[55%] truncate text-xs">{it.to_path}</span>
          <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[11px] font-normal">
            {DECISION_LABEL[it.decision]}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function ItemRows({
  items, total, protectedCount, page, tab, onPage,
}: {
  items: OrganizeTaskItem[] | null; total: number; protectedCount: number; page: number; tab: string; onPage: (p: number) => void;
}) {
  if (items === null) {
    return <p className="text-muted-foreground px-2 py-3 text-xs">正在读取明细…</p>;
  }
  if (items.length === 0 && protectedCount === 0) {
    return <p className="text-muted-foreground px-2 py-3 text-xs">这一类没有条目。</p>;
  }
  return (
    <div>
      {protectedCount > 0 && (
        <p className="text-muted-foreground px-2 pt-1 text-[11px]">另有 {protectedCount} 条受保护条目不展示明细（私密/隐私）。</p>
      )}
      <ul className="scroll-slim max-h-64 space-y-0.5 overflow-y-auto">
        {items.map((it) => (
          <li key={it.id} className="data-row flex items-start gap-2 rounded-lg px-2 py-1.5 text-[13px]">
            <span className="min-w-0 flex-1 truncate" title={it.title ?? undefined}>{it.title}</span>
            <span className="text-muted-foreground line-clamp-2 max-w-[58%] text-right text-xs">
              {it.decision === "moved" || it.decision === "converted" ? (
                <>
                  {it.from_path}
                  <span aria-hidden="true"> → </span>
                  <span className="text-foreground">{it.to_path}</span>
                </>
              ) : (
                <>
                  {taskReasonLabel(it.reason)}
                  {it.retryable && <span className="ml-1 text-[11px] opacity-70">（可重试）</span>}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      <NumberedPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={onPage} label="整理结果分页" />
      {tab === "failed" && items.some((it) => it.retryable) && (
        <p className="text-muted-foreground px-2 text-[11px]">可重试的失败项（模型超时、抓取失败等）能用「重试失败项」再跑一次。</p>
      )}
    </div>
  );
}

function FolderRows({ folders, onOpen }: { folders: OrganizeTaskFolder[] | null; onOpen: (folderId: string) => void }) {
  if (!folders) return <p className="text-muted-foreground px-4 py-1 text-xs">正在读取…</p>;
  return (
    <ul className="scroll-slim mb-1 max-h-52 space-y-0.5 overflow-y-auto px-1">
      {folders.map((f) => (
        <li key={f.key} className="data-row flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]">
          <FolderOpen className="text-muted-foreground size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{f.path}</span>
          <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[11px] font-normal">{FOLDER_STATE[f.state] ?? f.state}</Badge>
          <span className="text-muted-foreground shrink-0 text-xs tabular">
            {f.actual_count > 0 ? `承接 ${f.actual_count}` : f.planned_count > 0 ? `计划 ${f.planned_count}` : "未承接"}
          </span>
          {f.folder_id && (
            <Button variant="ghost" size="xs" onClick={() => onOpen(f.folder_id!)}>打开</Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function CategoryRows({ categories, onOpen }: { categories: OrganizeTaskCategory[] | null; onOpen: (path: string) => void }) {
  if (!categories) return <p className="text-muted-foreground px-4 py-1 text-xs">正在读取…</p>;
  return (
    <ul className="scroll-slim mb-1 max-h-52 space-y-0.5 overflow-y-auto px-1">
      {categories.map((c) => (
        <li key={c.path} className="data-row flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]">
          <BookMarked className="text-muted-foreground size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{c.path.split("/").join(" / ")}</span>
          <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[11px] font-normal">{CATEGORY_STATE[c.state] ?? c.state}</Badge>
          <span className="text-muted-foreground shrink-0 text-xs tabular">
            {c.actual_count > 0 ? `${c.actual_count} 条` : c.planned_count > 0 ? `计划 ${c.planned_count}` : "无"}
          </span>
          <Button variant="ghost" size="xs" onClick={() => onOpen(c.path)}>查看</Button>
        </li>
      ))}
    </ul>
  );
}

/** 零变更：先解释为什么没有调整，再给对应的下一步 */
function ZeroChangeExplainer({
  cfg, taskId, task, onOpenSettings,
}: { cfg: AdminConfig; taskId: string; task: OrganizeTask; onOpenSettings: () => void }) {
  const [reasons, setReasons] = useState<Array<[string, number]> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetchers.organizeTaskItems(cfg, taskId, { result: "unchanged", offset: 0 }, controller.signal),
      fetchers.organizeTaskItems(cfg, taskId, { result: "failed", offset: 0 }, controller.signal),
      fetchers.organizeTaskItems(cfg, taskId, { result: "skipped", offset: 0 }, controller.signal),
    ])
      .then(([keep, fail, skip]) => {
        if (controller.signal.aborted) return;
        const map = new Map<string, number>();
        for (const it of [...keep.items, ...fail.items, ...skip.items]) {
          const label = taskReasonLabel(it.reason);
          map.set(label, (map.get(label) ?? 0) + 1);
        }
        if (skip.protectedCount > 0) map.set("受保护的私密/隐私条目", skip.protectedCount);
        setReasons([...map].sort((a, b) => b[1] - a[1]));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [cfg, taskId, task.revision]);
  return (
    <section aria-label="为什么没有调整" className="bg-muted/40 rounded-xl px-4 py-3" data-zero-change>
      {task.mode === "rule_only" && (
        <p className="text-[13px]">
          未配置整理模型，所以这次只检查了本地规则，没有做 AI 主题发现、新目录规划和资料分流。
          <button className="text-primary ml-1 underline-offset-2 hover:underline" onClick={onOpenSettings}>配置 AI 模型</button>
        </p>
      )}
      {reasons === null ? (
        <p className="text-muted-foreground text-xs">正在汇总原因…</p>
      ) : reasons.length === 0 ? (
        <p className="text-muted-foreground text-xs">{task.summary}</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {reasons.map(([label, count]) => (
            <li key={label} className="text-muted-foreground flex items-center justify-between gap-3 text-xs">
              <span className="truncate">{label}</span>
              <span className="shrink-0 tabular">{count} 条</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ==================== 目录树底部入口 ====================

/**
 * 常驻入口：活动任务状态行（收起/刷新后仍能看到它在跑）+「整理记录」。
 * 任务从进行中落定时通知页面刷新（与对话框各自独立：对话框关着也要刷新）。
 */
export function OrganizeTaskEntry({
  activeTaskId,
  onView,
  onList,
  onChanged,
  onSettled,
}: {
  activeTaskId: string | null;
  onView: () => void;
  onList: () => void;
  onChanged: () => void;
  onSettled: () => void;
}) {
  const { cfg } = useShell();
  const { task } = useOrganizeTask(cfg, activeTaskId);
  const prevRef = useRef("");
  useEffect(() => {
    if (!task) return;
    const sig = `${task.status}|${task.undo_status}`;
    const prev = prevRef.current;
    prevRef.current = sig;
    if (!prev) return;
    const [prevStatus, prevUndo] = prev.split("|") as [string, string];
    const wasActive =
      ["queued", "running", "stopping"].includes(prevStatus) || ["pending", "running"].includes(prevUndo);
    const undoJustSettled = ["pending", "running"].includes(prevUndo) && !["pending", "running"].includes(task.undo_status);
    if ((wasActive && !isTaskActive(task)) || undoJustSettled) {
      window.dispatchEvent(new Event("mf:versions-changed"));
      onChanged();
      onSettled();
    }
  }, [task?.status, task?.undo_status, onChanged, onSettled]);
  return (
    <>
      {task && isTaskActive(task) && (
        <button
          onClick={onView}
          data-organize-active
          className="text-primary mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-primary/5"
        >
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="min-w-0 flex-1 truncate">
            正在整理「{task.folder_name}」· {task.checked}/{task.total}
          </span>
          <span className="shrink-0 underline-offset-2 hover:underline">查看</span>
        </button>
      )}
      <button
        onClick={onList}
        data-organize-records
        title="最近 20 次目录整理的记录（只查看结果，不会重新执行）"
        className="text-muted-foreground/60 hover:text-foreground mt-1 flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] transition-colors hover:underline"
      >
        <History className="size-3" /> 整理记录
      </button>
    </>
  );
}

// ==================== 整理记录 ====================

function TaskList({
  cfg, onPick, onClose,
}: { cfg: AdminConfig; onPick: (taskId: string) => void; onClose: () => void }) {
  const [tasks, setTasks] = useState<OrganizeTask[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    fetchers
      .organizeTasks(cfg, (page - 1) * PAGE_SIZE)
      .then((r) => {
        if (mine !== seq.current) return;
        setTasks(r.tasks);
        setTotal(r.total);
        setError(null);
        const last = Math.max(1, Math.ceil(r.total / PAGE_SIZE));
        if (page > last) setPage(last);
      })
      .catch((e) => { if (mine === seq.current) setError(e instanceof Error ? e.message : String(e)); });
  }, [cfg, page]);

  useEffect(() => {
    setTasks(null);
    load();
    // 任一任务有变化都重查列表（活动任务会推进）
    const unsub = isMock() ? subscribeMockTask(load) : subscribeTasks(load);
    return () => unsub();
  }, [load]);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <History className="text-primary size-4" /> 整理记录
        </DialogTitle>
        <DialogDescription>
          最近 20 次目录整理的记录。点击某条只查看结果，不会重新执行。
        </DialogDescription>
      </DialogHeader>
      {error && <p className="text-xs text-red-500" role="alert">记录暂时未更新：{error}</p>}
      {tasks === null ? (
        <p className="text-muted-foreground py-6 text-center text-xs">正在读取…</p>
      ) : tasks.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-muted-foreground text-[13px]">还没有整理记录</p>
          <p className="text-muted-foreground/70 mt-1 text-xs">打开一个目录，点「整理此目录」就会开始第一次整理。</p>
        </div>
      ) : (
        <ul className="space-y-0.5">
          {tasks.map((t) => {
            const h = taskHeadline(t);
            return (
              <li key={t.id}>
                <button
                  className="data-row flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-[13px]"
                  onClick={() => onPick(t.id)}
                >
                  <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", TONE_DOT[h.tone])} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{t.folder_name}</span>
                      <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[11px] font-normal">{taskStatusLabel(t)}</Badge>
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">{h.text}</span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular">
                    {t.moved + t.converted > 0 ? `调整 ${t.moved + t.converted} / ${t.total}` : `${t.total} 条`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <NumberedPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} disabled={tasks === null} label="整理记录分页" />
      <DialogFooter>
        <Btn size="sm" onClick={onClose}>关闭</Btn>
      </DialogFooter>
    </>
  );
}
