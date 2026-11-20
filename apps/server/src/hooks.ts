/**
 * 集成 Hook · 出站 Webhook（D33，自建端生态）
 *
 * 定位：中立管道——收藏/整理/死链事件把结构化数据可靠送到用户自有工具（yt-dlp / n8n / Home Assistant…）。
 * 硬护栏（红线②延伸 + §9）：
 *  - 隐私域名清单命中【永不外发】（发送前逐条校验，架构级强制）；
 *  - 不内置任何下载器模板（工具用户自备、责任自负）；
 *  - 内网目标默认拦截，显式 allowlist 才放行（复用 fetch-guard SSRF 防护）；
 *  - HMAC-SHA256 签名头（X-MF-Signature: sha256=<hex>）+ 时间戳防重放；
 *  - 失败退避重试 ×3（1s/4s/9s）；产物不自动回流，需要入库走 POST /api/v1/bookmarks（入站 API）。
 */
import { createHmac } from "node:crypto";
import { isPrivacyDomain } from "@mf/shared";
import type { Store } from "./store";
import { fetchGuardConfigFromEnv, guardFetchTarget } from "./fetch-guard";

export type HookEvent = "bookmark.added" | "bookmark.organized" | "checkup.done";

export interface HookPayload {
  event: HookEvent;
  ts: string;
  /** granularity=meta：仅元数据；full：元数据+正文+分类结果（不含快照内容，红线④） */
  data: Record<string, unknown>;
}

/** 组装事件 payload（粒度由 Hook 配置；隐私命中返回 null = 永不外发） */
export function buildPayload(
  store: Store,
  event: HookEvent,
  data: Record<string, unknown>,
  granularity: "meta" | "full",
): HookPayload | null {
  if (event === "bookmark.added") {
    const url = String(data.url ?? "");
    if (isPrivacyDomain(url, { patterns: store.privacyPatterns() })) return null; // 🛡 永不外发
    const bm = data.bookmark as { title?: string; folder?: string } | undefined;
    const out: Record<string, unknown> = {
      url,
      title: bm?.title ?? data.title ?? "",
      folder: bm?.folder ?? null,
    };
    if (granularity === "full") {
      const cache = store.getCache(String(data.bookmarkId ?? ""));
      out.summary = (cache?.l1_summary as string) ?? null;
      // getCache 出口已把 l1_tags 解析为数组，此处直接取用（再 JSON.parse 会抛）
      out.tags = Array.isArray(cache?.l1_tags) ? cache.l1_tags : null;
    }
    return { event, ts: new Date().toISOString(), data: out };
  }
  // 整理完成 / 检测完成：聚合事件，不含单条 URL 正文
  return { event, ts: new Date().toISOString(), data };
}

/** 签名 + SSRF 防护 POST；失败退避重试 ×3；静默失败（Hook 永不影响主流程） */
export async function deliverHook(
  url: string,
  secret: string | null,
  payload: HookPayload,
  config = fetchGuardConfigFromEnv(),
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) {
    headers["x-mf-signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    headers["x-mf-timestamp"] = payload.ts;
  }
  // SSRF 防护：DNS 解析后逐地址校验（内网默认拦截，allowlist 显式放行）。
  // 说明：POST 目标由管理员自行配置（非用户书签），校验通过后直接请求；HMAC 保证接收方可验来源。
  const guard = await guardFetchTarget(url, config);
  if (!guard.allowed) {
    return { ok: false, error: `guard_blocked:${guard.reason}` };
  }
  let lastErr = "";
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
      lastStatus = res.status;
      if (res.ok) return { ok: true, status: res.status };
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = String(err);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, (attempt + 1) ** 2 * 1000));
  }
  return { ok: false, status: lastStatus, error: lastErr.slice(0, 200) };
}

/** 事件入口：查启用 Hook → 逐个组装/投递（异步不阻塞主流程） */
export function dispatchWebhooks(store: Store, event: HookEvent, data: Record<string, unknown>): void {
  // Hook 永不影响主流程：整体吞错，绝不让异常逃逸成 unhandled rejection
  void (async () => {
    try {
      const hooks = store.enabledHooksForEvent(event);
      for (const h of hooks) {
        const payload = buildPayload(store, event, data, h.granularity === "full" ? "full" : "meta");
        if (!payload) continue; // 隐私命中：仅本地记录（不外发）
        const hook = store.getHook(h.id);
        await deliverHook(h.url, hook?.secret ?? null, payload);
      }
    } catch (err) {
      console.warn("[hooks] dispatch failed:", String(err).slice(0, 200));
    }
  })();
}
