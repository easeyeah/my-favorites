/**
 * D82 管理台实时更新：刷新协调器（设计文档《管理台书签实时更新》§5.1 / §6）。
 *
 * SSE 只负责门铃，数据真相走 REST。本 hook 把「通知 → 校准」收敛为一个调度器：
 *  - dirty 代数：请求开始前消费通知代数，请求期间到达的新通知不会被完成动作清掉（必补轮）；
 *  - 在途守卫：同一视图同一时刻只有一批刷新，批次结束仍 dirty 再补一批（防 SSE 叠加请求洪水）；
 *  - 阻塞补轮：编辑/弹窗/右键菜单打开时保留 dirty 不丢弃，解除阻塞立即补刷；
 *  - 合并防抖 300ms + 最大等待 1s（连续通知不会无限推迟）；
 *  - 前台恢复 / 网络恢复 → 标 dirty；页面隐藏时延后查询，恢复前台立即校准；
 *  - SSE 断线期间页面可见且在线 → 30s 低频兜底（走同一调度器），连接恢复即停；
 *  - 失败可观测：保留 dirty 与旧数据，退避重试（3s→6s→12s→24s→30s），暴露 error 供安静提示与手动重试。
 *
 * 视图/账号切换的竞态防护（epoch/abort）由页面侧负责——调度器只管「何时刷」，页面管「刷哪个视图」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getStreamStatus, subscribeChanges, subscribeMockChange } from "./events";
import { isMock } from "./mock";

const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 1000;
const FALLBACK_INTERVAL_MS = 30_000;
const RETRY_BASE_MS = 3000;
const RETRY_CAP_MS = 30_000;

export interface LiveRefreshOptions {
  /** 一次刷新批次：查询当前视图并应用（页面内部做 epoch 校验，旧响应无权写入） */
  refresh: () => Promise<void> | void;
  /** 编辑/弹窗等阻塞数据替换；阻塞期间通知保留为 dirty，解除后立即补刷 */
  blocked?: boolean;
  enabled?: boolean;
}

export interface LiveRefreshState {
  refreshing: boolean;
  /** 最近一次刷新失败原因（成功后清空）；页面据此显示安静的「更新失败，正在重试」 */
  error: string | null;
  /** 手动重试（失败提示上的入口） */
  retry: () => void;
  /** 主动标 dirty（页面侧已知数据变化时复用同一调度） */
  markDirty: () => void;
}

export function useLiveRefresh({ refresh, blocked = false, enabled = true }: LiveRefreshOptions): LiveRefreshState {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const blockedRef = useRef(blocked);
  const enabledRef = useRef(enabled);

  const notifyGen = useRef(0); // 最新通知代数
  const startedGen = useRef(0); // 最近一批刷新开始时消费的代数
  const failedRef = useRef(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelay = useRef(RETRY_BASE_MS);

  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearTimers = () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (maxTimer.current) clearTimeout(maxTimer.current);
    debounceTimer.current = null;
    maxTimer.current = null;
  };

  const tryRun = useCallback(() => {
    if (!mounted.current || !enabledRef.current || inFlight.current || blockedRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return; // 隐藏延后，前台恢复再校准
    const dirty = notifyGen.current !== startedGen.current || failedRef.current;
    if (!dirty) return;
    startedGen.current = notifyGen.current; // 请求前消费：期间到达的新通知留给补轮
    failedRef.current = false;
    inFlight.current = true;
    setRefreshing(true);
    void Promise.resolve()
      .then(() => refreshRef.current())
      .then(
        () => {
          if (!mounted.current) return;
          retryDelay.current = RETRY_BASE_MS;
          setError(null);
        },
        (e: unknown) => {
          if (!mounted.current) return;
          failedRef.current = true; // 保留 dirty，退避重试
          setError(e instanceof Error ? e.message : String(e));
        },
      )
      .finally(() => {
        inFlight.current = false;
        if (!mounted.current) return;
        setRefreshing(false);
        if (!enabledRef.current) return;
        if (failedRef.current) {
          const delay = retryDelay.current;
          retryDelay.current = Math.min(RETRY_CAP_MS, retryDelay.current * 2);
          clearTimers();
          debounceTimer.current = setTimeout(tryRun, delay);
        } else if (notifyGen.current !== startedGen.current) {
          // 批次期间又有通知 → 补一轮（短防抖合并）
          clearTimers();
          debounceTimer.current = setTimeout(tryRun, DEBOUNCE_MS);
        }
      });
  }, []);

  const markDirty = useCallback(() => {
    notifyGen.current++;
    if (!enabledRef.current) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(tryRun, DEBOUNCE_MS);
    if (!maxTimer.current) maxTimer.current = setTimeout(tryRun, MAX_WAIT_MS);
  }, [tryRun]);

  // 阻塞解除 → 立即补刷（dirty 在阻塞期间一直保留）
  useEffect(() => {
    blockedRef.current = blocked;
    if (!blocked) tryRun();
  }, [blocked, tryRun]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) clearTimers();
  }, [enabled]);

  useEffect(() => {
    mounted.current = true;
    // 门铃：真实 SSE / ?mock 模拟事件
    const unsub = isMock() ? subscribeMockChange(markDirty) : subscribeChanges(markDirty);
    // 前台恢复 / 网络恢复 → 校准（与既有在途刷新合并）
    const onVisible = () => {
      if (document.visibilityState === "visible") markDirty();
    };
    const onOnline = () => markDirty();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    // SSE 断线兜底：可见且在线时低频校准；连接正常（或 mock）时零开销
    const fallback = setInterval(() => {
      if (isMock()) return;
      const s = getStreamStatus();
      // unauthorized 交给认证处理（重登会重建连接），不做无谓重试
      if (s === "connected" || s === "idle" || s === "unauthorized") return;
      if (document.visibilityState === "visible" && navigator.onLine) markDirty();
    }, FALLBACK_INTERVAL_MS);
    return () => {
      mounted.current = false;
      unsub();
      clearTimers();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      clearInterval(fallback);
    };
  }, [markDirty]);

  const retry = useCallback(() => {
    failedRef.current = true;
    retryDelay.current = RETRY_BASE_MS;
    clearTimers();
    tryRun();
  }, [tryRun]);

  return { refreshing, error, retry, markDirty };
}
