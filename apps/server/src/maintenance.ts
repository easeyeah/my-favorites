/**
 * 定期维护（F5）：死链三级判定 + 查重 + 体检报告。
 * 判定策略（保守，D3）：normal（HEAD/GET 2xx-3xx）/ suspect（401/403/429/5xx/超时——仅标注）
 * / dead（DNS 失败、连接拒绝、404/410）。
 * 调度：env MF_MAINTENANCE_INTERVAL_HOURS 启用（自建 compose 默认 168=每周）；手动触发端点常驻。
 */
import type { Store, BookmarkRow } from "./store";

export interface LinkCheckResult {
  id: string;
  url: string;
  verdict: "normal" | "suspect" | "dead";
  detail: string;
}

async function probe(url: string, method: "HEAD" | "GET", timeoutMs = 8000): Promise<number | "timeout" | "unreachable"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "my-favorites-bot/0.2 (+https://github.com/easeyeah/my-favorites)" },
    });
    return res.status;
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED") {
      return "unreachable";
    }
    return "timeout";
  } finally {
    clearTimeout(timer);
  }
}

/** 三级判定：HEAD 先行，异常才 GET 复验（省 80% 请求成本，技术方案 §6 F5.1） */
export async function checkLink(url: string): Promise<LinkCheckResult["verdict"]> {
  // 自建场景允许收藏内网地址（通道A特性），探测策略一致
  const head = await probe(url, "HEAD");
  if (typeof head === "number" && head >= 200 && head < 400) return "normal";

  const get = await probe(url, "GET");
  if (typeof get === "number") {
    if (get >= 200 && get < 400) return "normal";
    if (get === 404 || get === 410) return "dead";
    return "suspect"; // 401/403/429/5xx：疑似反爬/限流，仅标注
  }
  if (get === "unreachable") return "dead";
  return "suspect"; // 超时：疑似失效，仅标注
}

export class MaintenanceService {
  constructor(private store: Store) {}

  async runLinkCheck(limit = 20): Promise<{ checked: number; results: LinkCheckResult[]; reportId: string }> {
    const candidates: BookmarkRow[] = this.store.candidatesForLinkCheck(limit);
    const results: LinkCheckResult[] = [];
    for (const bm of candidates) {
      const verdict = await checkLink(bm.url_canonical);
      this.store.updateBookmark(bm.id, {
        status: verdict,
        last_checked_at: new Date().toISOString(),
      });
      results.push({ id: bm.id, url: bm.url_canonical, verdict, detail: "" });
      await new Promise((r) => setTimeout(r, 300)); // 礼貌限速
    }
    const reportId = this.store.saveReport("link_check", {
      checked: results.length,
      dead: results.filter((r) => r.verdict === "dead").length,
      suspect: results.filter((r) => r.verdict === "suspect").length,
      normal: results.filter((r) => r.verdict === "normal").length,
      results,
    });
    return { checked: results.length, results, reportId };
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

  /** 体检报告（获客钩子 + 周报数据源） */
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

/** 进程内调度器（自建端 compose 通过 env 启用；默认关闭便于测试） */
export function startScheduler(store: Store, maintenance: MaintenanceService): void {
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
}
