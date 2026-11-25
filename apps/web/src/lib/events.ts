/**
 * D81 §5 批次二 + D82 实时更新：管理台订阅 /events/stream。
 *
 * 门铃语义与服务端 ChangeHub 一致——只推「有事发生」，数据真相仍走 REST 刷新。
 * 单连接共享（Shell 挂载期间一条 SSE），页面经 useServerChanges / useLiveRefresh 订阅合并刷新；
 * 首次连接成功与每次重连成功都通知补刷（覆盖「首次查询与订阅建立之间漏变更」窗口）；
 * 断线退避重连，连接状态经 useStreamStatus 可观测（断线期间页面侧低频兜底校准）。?mock 短路。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { apiUrl, type AdminConfig } from "./api";
import { isMock } from "./mock";

type Listener = () => void;
const listeners = new Set<Listener>();
let abort: AbortController | null = null;
let running = false;
let currentKey = "";

// ---------- 连接状态（可观测：断线兜底 / 失败提示的依据） ----------

export type StreamStatus = "idle" | "connecting" | "connected" | "disconnected" | "unauthorized" | "mock";
let status: StreamStatus = isMock() ? "mock" : "idle";
const statusListeners = new Set<Listener>();

function setStatus(s: StreamStatus): void {
  if (status === s) return;
  status = s;
  for (const fn of [...statusListeners]) {
    try {
      fn();
    } catch {
      /* 单订阅者异常隔离 */
    }
  }
}

export function getStreamStatus(): StreamStatus {
  return status;
}

/** SSE 连接状态订阅（Shell 状态点 / 页面断线兜底用） */
export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(
    (fn) => {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    () => status,
  );
}

function notify(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* 单订阅者异常隔离 */
    }
  }
}

// ---------- D92 整理任务门铃 ----------
// 书签变更门铃不是任务进度（模型等待/失败/零动作/停止都没有书签变更）：
// 服务端另推 event:task，只带 taskId；任务快照仍走 REST。不为每个任务单独占连接。

type TaskListener = (taskId: string) => void;
const taskListeners = new Set<TaskListener>();

/** 订阅任务状态门铃；返回退订函数。?mock 下订阅 mock 层派发的 mf:mock-task */
export function subscribeTasks(fn: TaskListener): () => void {
  taskListeners.add(fn);
  return () => taskListeners.delete(fn);
}

function notifyTasks(taskId: string): void {
  for (const fn of [...taskListeners]) {
    try {
      fn(taskId);
    } catch {
      /* 单订阅者异常隔离 */
    }
  }
}

const MOCK_TASK_EVENT = "mf:mock-task";

/** mock 层任务状态推进后调用（detail.taskId） */
export function emitMockTask(taskId: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MOCK_TASK_EVENT, { detail: { taskId } }));
}

/** 演示态订阅任务门铃（与 subscribeTasks 同口径） */
export function subscribeMockTask(fn: TaskListener): () => void {
  const handler = (e: Event): void => fn(String((e as CustomEvent<{ taskId?: string }>).detail?.taskId ?? ""));
  window.addEventListener(MOCK_TASK_EVENT, handler);
  return () => window.removeEventListener(MOCK_TASK_EVENT, handler);
}

/** 页面订阅原始门铃（合并/调度由订阅方负责）；返回退订函数 */
export function subscribeChanges(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function loop(cfg: AdminConfig, signal: AbortSignal): Promise<void> {
  let backoff = 3000;
  while (!signal.aborted) {
    setStatus("connecting");
    try {
      const res = await fetch(apiUrl(cfg, "/api/v1/events/stream"), {
        headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
        signal,
      });
      if (res.status === 401 || res.status === 403) {
        // 鉴权失败交给现有认证处理（重登/换令牌会重建连接），不高频重连
        setStatus("unauthorized");
        backoff = 30_000;
        throw new Error(`sse http ${res.status}`);
      }
      if (!res.ok || !res.body) throw new Error(`sse http ${res.status}`);
      backoff = 3000;
      setStatus("connected");
      // 首连与重连一律补刷：首连覆盖「首次查询 → 订阅建立」间隙；重连覆盖断线期间错过的门铃
      notify();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let cut = buf.indexOf("\n\n");
          while (cut >= 0) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            if (frame.includes("event: change")) notify();
            if (frame.includes("event: task")) {
              // data 行是 {"taskIds":["…"]}；解析失败不致命——页面侧有低频轮询兜底
              const data = frame
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("");
              try {
                const ids = (JSON.parse(data) as { taskIds?: string[] }).taskIds ?? [];
                for (const id of ids) notifyTasks(id);
              } catch {
                /* 忽略坏帧 */
              }
            }
            cut = buf.indexOf("\n\n");
          }
        }
    } catch {
      /* 断线走退避重连 */
    }
    if (signal.aborted) return;
    setStatus("disconnected");
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(60_000, backoff * 2);
  }
}

/** Shell 调用：按 cfg 幂等启动/切换 SSE 连接（token/serverUrl 变化即重连） */
export function startEventStream(cfg: AdminConfig): void {
  if (isMock()) return; // 演示模式无服务端，短路
  const key = `${cfg.serverUrl}|${cfg.token}`;
  if (running && currentKey === key) return;
  stopEventStream();
  running = true;
  currentKey = key;
  const ac = new AbortController();
  abort = ac;
  void loop(cfg, ac.signal).finally(() => {
    if (abort === ac) {
      abort = null;
      running = false;
      setStatus("idle");
    }
  });
}

export function stopEventStream(): void {
  abort?.abort();
  abort = null;
  running = false;
}

/**
 * 轻量订阅（首页统计/资料列表/角标等单发查询面）：合并防抖 400ms + 最大等待 1s
 * （连续门铃不会无限推迟刷新）。需要阻塞补轮/在途守卫/失败重试的重页面用 useLiveRefresh。
 * ?mock 下订阅模拟事件（mock 层变更后派发 mf:mock-change），演示态同样实时。
 */
export function useServerChanges(onChange: () => void, enabled = true): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (timer) clearTimeout(timer);
      if (maxTimer) clearTimeout(maxTimer);
      timer = null;
      maxTimer = null;
      ref.current();
    };
    const fn = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, 400);
      if (!maxTimer) maxTimer = setTimeout(fire, 1000);
    };
    const unsub = isMock() ? subscribeMockChange(fn) : subscribeChanges(fn);
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      if (maxTimer) clearTimeout(maxTimer);
    };
  }, [enabled]);
}

// ---------- ?mock 模拟门铃 ----------

const MOCK_CHANGE_EVENT = "mf:mock-change";

/** mock 层数据变更后调用：演示态页面与真实 SSE 同口径收到「有事发生」 */
export function emitMockChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(MOCK_CHANGE_EVENT));
}

export function subscribeMockChange(fn: Listener): () => void {
  window.addEventListener(MOCK_CHANGE_EVENT, fn);
  return () => window.removeEventListener(MOCK_CHANGE_EVENT, fn);
}
