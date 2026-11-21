/**
 * 定期维护（F5）：死链三级判定 + 查重 + 体检报告。
 * 判定策略（保守，D3）：normal（HEAD/GET 2xx-3xx）/ suspect（401/403/429/5xx/超时——仅标注）
 * / dead（DNS 失败、连接拒绝、404/410）。
 * 调度：env MF_MAINTENANCE_INTERVAL_HOURS 启用（自建 compose 默认 168=每周）；手动触发端点常驻。
 *
 * DEV-04（2026-11-18）：探测走统一 guardedFetch（IP 校验 + 连接固定 + 每跳重新校验 +
 * 超时预算），不再用原生 fetch 自动跟随重定向绕过网络守卫。
 * 判定策略（DEV-20 预备）：DNS 暂态/超时 → suspect 而非 dead（避免网络抖动批量判死）；
 * 隐私域书签不自动探测（探测行为本身会向第三方暴露该域名在册）。
 */
import type { Store, BookmarkRow } from "./store";
import {
  fetchGuardConfigFromEnv,
  guardedFetch,
  ipCoveredByAllowlist,
  type FetchGuardConfig,
} from "./fetch-guard";
import { checkPrivacy } from "@mf/shared";

export interface LinkCheckResult {
  id: string;
  url: string;
  /** 书签标题（报告快照：书签删除后仍可见当时标题） */
  title?: string;
  verdict: "normal" | "suspect" | "dead";
  detail: string;
  /** 原型 14 报告明细：📸 有快照 → 直接回看入口（失效≠丢失） */
  hasSnapshot?: boolean;
  folderName?: string | null;
  added_at?: string;
}

/** 单跳探测结果：HTTP 状态码或失败类别（可解释原因，用于报告明细） */
type ProbeOutcome = { kind: "http"; status: number } | { kind: "timeout" | "unreachable" | "blocked" };

async function probe(
  url: string,
  method: "HEAD" | "GET",
  guardConfig: FetchGuardConfig,
  timeoutMs = 8000,
): Promise<ProbeOutcome> {
  try {
    const res = await guardedFetch(
      url,
      guardConfig,
      {
        method,
        headers: { "user-agent": "my-favorites-bot/0.2 (+https://github.com/easeyeah/my-favorites)" },
      },
      { timeoutMs, maxRedirects: 5, totalTimeoutMs: timeoutMs * 2 },
    );
    const status = res.status;
    res.dispose(); // 只取状态码，立即释放连接（HEAD/GET 不需要内容时尽快回收）
    return { kind: "http", status };
  } catch (err) {
    const name = (err as Error).name;
    const msg = String(err);
    if (name === "GuardError" || msg.includes("fetch blocked")) return { kind: "blocked" };
    if (msg.includes("ENOTFOUND") || msg.includes("EAI_AGAIN") || msg.includes("ECONNREFUSED")) {
      return { kind: "unreachable" };
    }
    return { kind: "timeout" };
  }
}

/**
 * 三级判定：HEAD 先行，异常才 GET 复验（省 80% 请求成本，技术方案 §6 F5.1）。
 * 返回 verdict + detail（为什么打不开：HTTP 状态 / DNS / 连接 / 超时 / 网络策略拦截）。
 * DEV-20 保守判定：DNS 暂态与超时归 suspect（不批量判死）；404/410 才判 dead。
 */
export async function checkLink(
  url: string,
  guardConfig: FetchGuardConfig = fetchGuardConfigFromEnv(),
): Promise<{ verdict: LinkCheckResult["verdict"]; detail: string }> {
  const head = await probe(url, "HEAD", guardConfig);
  if (head.kind === "http" && head.status >= 200 && head.status < 400) {
    return { verdict: "normal", detail: `HTTP ${head.status}` };
  }

  const get = await probe(url, "GET", guardConfig);
  if (get.kind === "http") {
    if (get.status >= 200 && get.status < 400) return { verdict: "normal", detail: `HTTP ${get.status}` };
    if (get.status === 404 || get.status === 410) return { verdict: "dead", detail: `HTTP ${get.status} 页面不存在` };
    return { verdict: "suspect", detail: `HTTP ${get.status}（疑似反爬/限流/需登录，不代表失效）` };
  }
  if (get.kind === "blocked") {
    // 目标命中内网禁段等网络策略：不判死（探测被拒 ≠ 页面失效），标 suspect 留人工确认
    return { verdict: "suspect", detail: "网络策略拦截（内网/保留地址，无法自动探测）" };
  }
  if (get.kind === "unreachable") return { verdict: "dead", detail: "DNS 解析失败或连接被拒" };
  return { verdict: "suspect", detail: "超时（8s 无响应，可能被墙或限流）" };
}

export interface LinkCheckProgressItem {
  /** 序号（1 起） */
  i: number;
  id: string;
  title: string;
  /** 域名级展示（不外泄完整 URL 到前端日志面） */
  host: string;
  verdict: LinkCheckResult["verdict"];
  /** 为什么打不开：HTTP 状态 / DNS / 连接 / 超时 */
  detail: string;
}

export class MaintenanceService {
  constructor(
    private store: Store,
    private opts: { guardConfig?: FetchGuardConfig } = {},
  ) {}

  /**
   * 死链检测（带逐条进度回调）。
   * onProgress 在每条检测完成、状态已落库后调用——SSE 端点用它实时推送。
   * onProgress 返回 false 或抛错时中止检测（客户端断开场景）。
   */
  async runLinkCheckWithProgress(
    limit: number,
    onProgress?: (item: LinkCheckProgressItem, total: number) => boolean | void,
  ): Promise<{ checked: number; results: LinkCheckResult[]; reportId: string }> {
    const candidates: BookmarkRow[] = this.store.candidatesForLinkCheck(limit);
    const guardConfig = this.opts.guardConfig ?? fetchGuardConfigFromEnv();
    const results: LinkCheckResult[] = [];
    let aborted = false;
    const rules = this.store.privacyRules();
    for (const [idx, bm] of candidates.entries()) {
      // 隐私红线：隐私域书签不自动探测（探测即向第三方发送"该域名在册"信号）。
      // 例外：部署显式 allowlist 且目标为字面内网 IP（如自建 NAS 服务）时放行——
      // 网络层守卫仍逐跳校验；域名主机不预放行（由守卫的 GuardError 归 suspect）。
      const privacy = checkPrivacy("server_fetch", bm.url_raw, rules, {
        isPrivateBookmark: bm.is_private === 1,
      });
      let explicitlyAllowed = false;
      if (!privacy.allowed) {
        try {
          explicitlyAllowed = ipCoveredByAllowlist(new URL(bm.url_raw).hostname.toLowerCase(), guardConfig);
        } catch {
          explicitlyAllowed = false;
        }
      }
      if (!privacy.allowed && !explicitlyAllowed) {
        results.push({
          id: bm.id,
          url: bm.url_raw,
          title: bm.title,
          verdict: "suspect",
          detail: `隐私策略拦截（${privacy.reason}）：不自动探测，保留人工检查`,
        });
        continue;
      }
      const { verdict, detail } = await checkLink(bm.url_raw, guardConfig);
      // 原型 14：疑似失效连续周期（连续 2 周期 → 确认候选）+ 可解释失败原因落库 + 复活检测
      let streak = bm.suspect_streak ?? 0;
      let finalDetail = detail;
      if (verdict === "suspect") {
        streak += 1;
        if (streak >= 2) finalDetail = `${detail} · 连续 ${streak} 个周期拦截（确认候选，持续观察）`;
      }
      if (verdict === "normal" && bm.status === "dead") {
        finalDetail = `${detail} · 复活检测：原页已恢复`;
      }
      this.store.updateBookmark(bm.id, {
        status: verdict,
        last_checked_at: new Date().toISOString(),
        ...(verdict === "suspect"
          ? { suspect_streak: streak, last_fail_reason: detail }
          : verdict === "dead"
            ? { suspect_streak: 0, last_fail_reason: detail }
            : { suspect_streak: 0, last_fail_reason: null }),
      });
      results.push({
        id: bm.id,
        url: bm.url_raw,
        title: bm.title,
        verdict,
        detail: finalDetail,
        hasSnapshot: this.store.hasSnapshot(bm.id),
        folderName: this.store.getFolder(bm.folder_id)?.name ?? null,
        added_at: bm.added_at,
      });
      if (onProgress) {
        let host = bm.url_raw;
        try {
          host = new URL(bm.url_raw).host;
        } catch {
          // 保底原样
        }
        const ok = onProgress(
          { i: idx + 1, id: bm.id, title: bm.title, host, verdict, detail },
          candidates.length,
        );
        if (ok === false) {
          aborted = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 300)); // 礼貌限速
    }
    const reportId = this.store.saveReport("link_check", {
      checked: results.length,
      dead: results.filter((r) => r.verdict === "dead").length,
      suspect: results.filter((r) => r.verdict === "suspect").length,
      normal: results.filter((r) => r.verdict === "normal").length,
      deadWithSnapshot: results.filter((r) => r.verdict === "dead" && r.hasSnapshot).length,
      results,
      // 原型 14：归档建议清单（D37 收口：首次引导只做分类，归档建议从周报开始给；永不自动执行）
      archiveCandidates: this.archiveCandidates(),
      ...(aborted ? { aborted: true } : {}),
    });
    return { checked: results.length, results, reportId };
  }

  async runLinkCheck(limit = 20): Promise<{ checked: number; results: LinkCheckResult[]; reportId: string }> {
    return this.runLinkCheckWithProgress(limit);
  }

  /** 归档建议（原型 04/14）：两年前收藏且非置顶——只出清单，一键归档由用户执行（红线③） */
  archiveCandidates(days = 730, limit = 50): Array<{ id: string; title: string; url_canonical: string; folder_id: string; added_at: string; hasSnapshot: boolean }> {
    return this.store.archiveCandidates(days, limit);
  }

  /** 查重（F5.2）：同域同名分组 → 合并建议清单（不自动删除，红线 3） */
  runDuplicateScan(): { groups: number; reportId: string; suggestions: Array<{ keep: string; dupes: string[]; title: string }> } {
    const groups = this.store.duplicateGroups();
    const suggestions = groups.map((g) => {
      const sorted = [...g.items].sort((a, b) => a.added_at.localeCompare(b.added_at));
      const keep = sorted[0]!;
      return {
        keep: keep.id,
        title: keep.title,
        dupes: sorted.slice(1).map((d) => d.id),
      };
    });
    const reportId = this.store.saveReport("duplicate_scan", { groups: suggestions.length, suggestions });
    return { groups: suggestions.length, reportId, suggestions };
  }

  /** 体检报告（管理台概览数据源；公开 HTML 落地页已按 D21 移除） */
  healthReport(): {
    dead: number;
    suspect: number;
    duplicates: number;
    stale: number;
    oldestBookmark: string | null;
    snapshotUsageMb: number;
  } {
    const counts = this.store.countBookmarks();
    const dupes = this.store.duplicateGroups();
    const stale = this.store.staleStats();
    return {
      dead: counts.dead,
      suspect: counts.suspect,
      duplicates: dupes.length,
      stale: stale.stale,
      oldestBookmark: stale.oldestCheck,
      snapshotUsageMb: Math.round((this.store.snapshotUsageBytes() / 1024 / 1024) * 10) / 10,
    };
  }
}

/**
 * D58：增长表保留裁剪（常驻，不依赖 MF_MAINTENANCE_INTERVAL_HOURS——
 * 未设 env 的部署同样不能让 changes/events/idempotency 无限增长）。
 * 启动即跑一次 + 每日一次；幂等可重跑。
 */
export function startRetentionPrune(store: Store): void {
  const prune = (): void => {
    try {
      const r = store.pruneRetention();
      const total = r.changes + r.events + r.idempotency + r.audit;
      if (total > 0) console.log(`[retention] pruned ${total} rows (${JSON.stringify(r)})`);
    } catch (err) {
      console.error("[retention] prune failed:", String(err));
    }
  };
  prune();
  setInterval(prune, 86400_000);
}

/**
 * D63：L1 摘要兜底补扫（常驻，不依赖 MF_MAINTENANCE_INTERVAL_HOURS——
 * capture 摘要本就 fire-and-forget（async 模式 void run 不阻塞捕获响应），
 * 进程重启丢在途、LLM 当时不可用都会让摘要永久缺失；D57 教训：自动承诺必须有兜底）。
 * 启动即跑一次 + 每 30 分钟一次；每次最多 5 条（涓流，不与整理抢 LLM 配额）；
 * 无 LLM 配置时 backfillSummaries 返回 0（零网络零开销）。
 */
export function startSummaryBackfill(pipeline: { backfillSummaries(limit?: number): number }): void {
  const kick = (): void => {
    try {
      const kicked = pipeline.backfillSummaries(5);
      if (kicked > 0) console.log(`[summary-backfill] kicked ${kicked} summaries`);
    } catch (err) {
      console.error("[summary-backfill] sweep failed:", String(err));
    }
  };
  kick();
  setInterval(kick, 1800_000);
}

/** 进程内调度器（自建端 compose 通过 env 启用；默认关闭便于测试） */
export function startScheduler(store: Store, maintenance: MaintenanceService, pipeline?: { processInbox(bookmarkIds: string[], inboxFolderId: string, opts?: { deviceId?: string }): Promise<unknown> }): void {
  const hours = Number(process.env.MF_MAINTENANCE_INTERVAL_HOURS ?? 0);
  if (hours <= 0) return;
  const run = async () => {
    try {
      await maintenance.runLinkCheck(30);
      maintenance.runDuplicateScan();
    } catch (err) {
      console.error("[maintenance] scheduled run failed:", String(err));
    }
  };
  setInterval(() => void run(), hours * 3600_000);
  console.log(`[maintenance] scheduler on, every ${hours}h`);

  // 每小时定时清扫兜底（原型 06）：离线期间堆积的收纳盒书签批量处理
  // （浏览器事件 + 定时兜底双保险；无 deviceId = 为全部已注册设备入队镜像）
  if (pipeline) {
    const sweep = async (): Promise<void> => {
      try {
        const inbox = store.inboxFolder();
        if (!inbox) return;
        const ids = store
          .listInboxWithState()
          .filter((i) => i.state === "pending" || i.state === "retry")
          .map((i) => i.id);
        if (ids.length > 0) {
          await pipeline.processInbox(ids, inbox.id, {});
          console.log(`[inbox] sweep processed ${ids.length}`);
        }
      } catch (err) {
        console.error("[inbox] sweep failed:", String(err));
      }
    };
    setInterval(() => void sweep(), 3600_000);
    console.log("[inbox] hourly sweep on");
  }
}
