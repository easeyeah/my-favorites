/**
 * 站点原始图标获取（favicon 回填，2026-11-20）
 *
 * 背景：管理台此前依赖第三方图标服务（icons.duckduckgo.com），国内网络不可达，
 * 全部回退字母块。本模块改为直接取站点自己的图标：
 *  1. `https://{host}/favicon.ico`（不成再试 http 源站）；
 *  2. 失败则抓首页 HTML 解析 `<link rel="icon|shortcut icon|apple-touch-icon">` 定位真实图标地址。
 * 成功后转 data URL 持久化到 `bookmarks.favicon_url`（与扩展快照捕获通道同一字段，一次获取永久缓存）。
 *
 * 红线合规：
 *  - 隐私域名校验（server_fetch）由调用方端点在执行前强制，本模块只是网络执行者；
 *  - 全部出站走 guardedFetch（SSRF 守卫 + 连接固定 + 字节上限）。
 * 进程内做 host 级负缓存与在途去重，避免每页加载都重试不可达站点。
 */
import { fetchGuardConfigFromEnv, guardedFetch, type FetchGuardConfig } from "./fetch-guard";

/** 图标字节上限：容纳多分辨率 .ico（实测 DeepSeek 205KB）；data URL ≈ 1.37×，防 DB 无限膨胀 */
const MAX_ICON_BYTES = 256 * 1024;
/** 首页读取上限：只需覆盖 <head> 的 link 区；超限视为无图标线索（流已销毁，不重试） */
const MAX_HTML_BYTES = 512 * 1024;
/** host 级负缓存 TTL：站点没图标/不可达，24h 内不再重试 */
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * 单次解析整体预算（D60）：候选链是 favicon.ico×2 → 首页 → 最多 3 个 link 图标，
 * 串行最坏 ~90s；预算耗尽即放弃并进负缓存——装饰资源不值得拖垮同源连接池。
 */
const TOTAL_BUDGET_MS = 12_000;

const UA = "my-favorites-bot/0.1 (+https://github.com/easeyeah/my-favorites)";

const negativeCache = new Map<string, number>(); // host → 失败时间戳
const inflight = new Map<string, Promise<string | null>>(); // host → 在途解析

/** 按魔数嗅探图标 MIME；返回 null = 不是可识别的图片（如 404 页伪装 200） */
export function sniffImageMime(buf: Buffer, contentType: string | undefined): string | null {
  const ct = (contentType ?? "").toLowerCase();
  if (buf.length < 8) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return "image/x-icon";
  if (
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  if (buf.subarray(0, 2).toString("latin1") === "BM") return "image/bmp";
  // SVG：以文本特征或声明头判定（favicon 场景 svg 内容必然是标记文本）
  if (ct.includes("svg")) return "image/svg+xml";
  const head = buf.subarray(0, 256).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

/** 从首页 HTML 提取候选图标地址（按 rel 优先级）；纯正则不引解析器，与 /crawl 同风格 */
export function extractIconHrefs(html: string, base: string): string[] {
  const out: Array<{ url: string; rank: number }> = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /rel\s*=\s*["']?([^"'\s>][^"'>]*)["']?/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    // icon 优先，其次 shortcut icon，再 apple-touch-icon / mask-icon；同类保持文档序
    let rank = -1;
    if (/\bapple-touch-icon\b/.test(rel)) rank = 1;
    else if (/\bmask-icon\b/.test(rel)) rank = 2;
    else if (/\bshortcut icon\b|\bicon\b/.test(rel)) rank = 0;
    if (rank < 0) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || href.startsWith("data:")) continue;
    try {
      out.push({ url: new URL(href, base).toString(), rank });
    } catch {
      /* 坏 href 跳过 */
    }
  }
  return out
    .sort((a, b) => a.rank - b.rank) // 稳定排序：同 rank 保文档序
    .map((x) => x.url);
}

async function fetchIconBytes(url: string, guard: FetchGuardConfig, remainingMs: number): Promise<string | null> {
  if (remainingMs <= 500) return null; // 预算耗尽：不值得为装饰资源再开一次出站请求
  const res = await guardedFetch(url, guard, { headers: { "user-agent": UA } }, {
    maxBytes: MAX_ICON_BYTES,
    timeoutMs: Math.min(8000, remainingMs),
    totalTimeoutMs: Math.min(15000, remainingMs),
  });
  if (!res.ok) {
    res.dispose();
    return null;
  }
  const buf = await res.readBody(MAX_ICON_BYTES);
  const mime = sniffImageMime(buf, res.header("content-type"));
  if (!mime) return null;
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** 解析站点原始图标（不含隐私判定——由调用端点前置）；失败/不可达返回 null 并进负缓存 */
export async function resolveFavicon(
  pageUrl: string,
  guardConfig: FetchGuardConfig = fetchGuardConfigFromEnv(),
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.host;
  const failedAt = negativeCache.get(host);
  if (failedAt && Date.now() - failedAt < NEGATIVE_TTL_MS) return null;

  const running = inflight.get(host);
  if (running) return running;

  const task = (async (): Promise<string | null> => {
    const origin = `${parsed.protocol}//${host}`;
    const deadline = Date.now() + TOTAL_BUDGET_MS;
    const remaining = () => deadline - Date.now();
    // 1) 传统根路径 favicon.ico：先页面同协议，再对侧协议补一次
    for (const candidate of [`${origin}/favicon.ico`, `${parsed.protocol === "https:" ? "http:" : "https:"}//${host}/favicon.ico`]) {
      try {
        const icon = await fetchIconBytes(candidate, guardConfig, remaining());
        if (icon) return icon;
      } catch {
        /* 下一个候选 */
      }
    }
    // 2) 首页 <link rel="icon"> 解析
    try {
      const res = remaining() > 500
        ? await guardedFetch(origin, guardConfig, { headers: { "user-agent": UA } }, {
            maxBytes: MAX_HTML_BYTES,
            timeoutMs: Math.min(8000, remaining()),
            totalTimeoutMs: Math.min(15000, remaining()),
          })
        : null;
      if (res?.ok) {
        const html = (await res.readBody(MAX_HTML_BYTES)).toString("utf8");
        for (const href of extractIconHrefs(html, origin).slice(0, 3)) {
          try {
            const icon = await fetchIconBytes(href, guardConfig, remaining());
            if (icon) return icon;
          } catch {
            /* 下一个候选 */
          }
        }
      } else {
        res?.dispose();
      }
    } catch {
      /* 站点不可达 */
    }
    negativeCache.set(host, Date.now());
    return null;
  })();

  inflight.set(host, task);
  try {
    return await task;
  } finally {
    inflight.delete(host);
  }
}

/** 测试用：清空进程内缓存 */
export function resetFaviconCaches(): void {
  negativeCache.clear();
  inflight.clear();
}
