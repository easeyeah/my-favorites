/**
 * D92 目录整理任务：状态/原因的人话映射 + 任务快照订阅钩子。
 *
 * 数据真相走 REST——SSE 的 task 门铃只负责「有变化」；进行中另有低频轮询兜底（断流/门铃丢失），
 * 页面回到前台时校准，任务进入终态即停。不为每个任务单独占连接。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchers, type AdminConfig, type OrganizeTask } from "@/lib/api";
import { subscribeMockTask, subscribeTasks } from "@/lib/events";
import { isMock } from "@/lib/mock";

/** 进行中（含撤销进行中）：需要继续观察 */
export function isTaskActive(t: OrganizeTask | null | undefined): boolean {
  return (
    !!t &&
    (["queued", "running", "stopping"].includes(t.status) || ["pending", "running"].includes(t.undo_status))
  );
}

const REASON_LABEL: Record<string, string> = {
  topic_match: "主题匹配",
  domain_rule: "域名规则",
  content_page: "有实质正文的内容页",
  already_placed: "已在合适位置",
  insufficient_evidence: "证据不足，保留原位",
  rule_unmatched: "规则未命中",
  rule_target_not_in_scope: "规则指向的目录不在此目录内",
  ambiguous_target: "有多个同名目录，未贸然选择",
  modified_during_task: "整理期间已被修改，未覆盖",
  moved_during_task: "整理期间已被移动，未覆盖",
  archived_during_task: "整理期间已归档",
  deleted_during_task: "书签已被删除",
  converted_elsewhere: "已被其他操作转为资料",
  privacy_changed: "隐私规则变化，已保护",
  target_unavailable: "目标目录不可用",
  not_moved: "未能写入",
  material_dismissed: "此前已移出资料库，未复活",
  model_error: "模型处理失败",
  model_output_incomplete: "模型未返回该条判断",
  invalid_model_output: "模型返回无效",
  category_invalid: "未能给出有效的资料分类",
  content_rejected_by_model: "供应商内容审核拒收",
  not_planned: "未形成判断",
  bookmark_unavailable: "书签不可用",
  modified_after_apply: "整理后已被修改，保留",
  bookmark_deleted: "书签已删除",
  target_folder_missing: "原目录已不存在",
  converted_to_material: "已转为资料，未移动",
  already_restored_by_user: "已由你恢复，未重复处理",
  convert_no_longer_eligible: "已不再适合转资料",
  folder_modified_by_user: "目录已被修改，保留",
  folder_in_use: "目录已有内容，保留",
};

/** 原因码 → 人话（界面不裸露枚举值） */
export function taskReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "";
  if (reason.startsWith("crawl_failed")) {
    const detail = reason.slice("crawl_failed:".length).replace(/^Error:\s*/, "").slice(0, 60);
    if (/HTTP 404/.test(detail)) return "正文抓取失败：页面打不开（404）";
    if (/HTTP 403/.test(detail)) return "正文抓取失败：访问被拒绝（403）";
    if (/timeout|timed out/i.test(detail)) return "正文抓取失败：抓取超时";
    return detail ? `正文抓取失败：${detail}` : "正文抓取失败";
  }
  return REASON_LABEL[reason] ?? reason;
}

export const DECISION_LABEL: Record<string, string> = {
  moved: "书签移动",
  converted: "转资料",
  keep: "保持",
  skip: "跳过",
  fail: "失败",
};

/** 结果页签：值即服务端 result 参数 */
export const RESULT_TABS: Array<{ key: string; label: string }> = [
  { key: "moved", label: "书签移动" },
  { key: "converted", label: "转资料" },
  { key: "unchanged", label: "保持" },
  { key: "skipped", label: "跳过" },
  { key: "failed", label: "失败" },
];

export type TaskTone = "busy" | "ok" | "warn" | "danger";

/** 顶部一句话：进行中给阶段说明，终态给服务端按计数生成的结论 */
export function taskHeadline(t: OrganizeTask | null): { tone: TaskTone; text: string } {
  if (!t) return { tone: "busy", text: "正在读取任务…" };
  if (t.undo_status === "running" || t.undo_status === "pending") {
    return { tone: "busy", text: "正在撤销这次整理…" };
  }
  if (t.status === "queued") return { tone: "busy", text: "已受理，即将开始" };
  if (t.status === "stopping") return { tone: "busy", text: "正在停止，等待当前批次收尾" };
  if (t.status === "running") return { tone: "busy", text: t.phase_note || "正在整理" };
  if (t.status === "failed") return { tone: "danger", text: t.summary || t.error || "任务未能继续" };
  if (t.status === "stopped") return { tone: "warn", text: t.summary || "已停止" };
  if (t.status === "completed_with_issues") return { tone: "warn", text: t.summary || "检查完成，部分条目需要留意" };
  return { tone: "ok", text: t.summary || "检查完成" };
}

/** 撤销结论：恢复与保留分开说，资料保留明示 */
export function undoSummary(t: OrganizeTask | null): string | null {
  if (!t || t.undo_status === "none") return null;
  if (t.undo_status === "pending" || t.undo_status === "running") return "正在撤销：先停止并排空在途提交，再按批次逆序恢复";
  if (t.undo_status === "failed") return "撤销未能完成，可再次点击撤销继续";
  const restored = `已恢复 ${t.undo_restored} 条`;
  const kept = t.undo_kept > 0 ? `，${t.undo_kept} 条因后续改动保留` : "";
  const cats = t.undo_categories > 0 ? `，${t.undo_categories} 条资料分类回到原值` : "";
  const folders = t.undo_folders > 0 ? `，回收 ${t.undo_folders} 个空目录` : "";
  const rest = t.undo_status === "partial" && t.undo_kept === 0 ? "；仍有未撤销的批次" : "";
  return `${restored}${kept}${cats}${folders}${rest}。资料与正文均保留，不会被删除`;
}

/** 秒表：从开始（或创建）到结束（或现在） */
export function elapsedLabel(start: string | null, end: string | null, nowMs: number): string {
  if (!start) return "00:00";
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : nowMs;
  const sec = Math.max(0, Math.floor((to - from) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export interface OrganizeTaskSnapshot {
  task: OrganizeTask | null;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * 订阅一个任务的快照。切任务/切账号/卸载时作废在途响应；旧 revision 的响应不覆盖新状态。
 */
export function useOrganizeTask(cfg: AdminConfig, taskId: string | null): OrganizeTaskSnapshot {
  const [task, setTask] = useState<OrganizeTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<OrganizeTask | null>(null);
  latest.current = task;
  const inFlight = useRef(false);
  const keyRef = useRef(`${cfg.serverUrl}|${cfg.token}|${taskId ?? ""}`);
  keyRef.current = `${cfg.serverUrl}|${cfg.token}|${taskId ?? ""}`;

  const load = useCallback(async () => {
    if (!taskId || inFlight.current) return;
    const key = keyRef.current;
    inFlight.current = true;
    try {
      const r = await fetchers.organizeTask(cfg, taskId);
      // 账号/服务端/任务已切换：旧响应无权写入
      if (keyRef.current !== key) return;
      setError(null);
      setTask((prev) => (prev && prev.id === r.task.id && prev.revision === r.task.revision ? prev : r.task));
    } catch (e) {
      if (keyRef.current !== key) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
    }
  }, [cfg, taskId]);

  useEffect(() => {
    setTask(null);
    setError(null);
    if (!taskId) return;
    let disposed = false;
    const refresh = (): void => {
      if (!disposed) void load();
    };
    refresh();
    const unsub = isMock()
      ? subscribeMockTask((id) => {
          if (id === taskId) refresh();
        })
      : subscribeTasks((id) => {
          if (id === taskId) refresh();
        });
    // 低频兜底：只在进行中轮询（断流/门铃丢失也能收敛），终态即停
    const timer = setInterval(() => {
      if (isTaskActive(latest.current)) refresh();
    }, 5000);
    const onVisible = (): void => {
      if (document.visibilityState === "visible" && isTaskActive(latest.current)) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      unsub();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [taskId, load]);

  return { task, error, refresh: load };
}
