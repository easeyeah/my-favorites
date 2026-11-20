/**
 * 小组件取数层：通用 TTL 缓存（chrome.storage.local）+ 多源回退链。
 *
 * 端点均实测（2026-11-20 国内直连，全部 CORS `*`，零新增 host_permissions）：
 * - IP 链：myip.ipip.net（IP+归属+运营商，主）→ api.ip.sb/ip → cloudflare trace → ipify（海外兜底）
 * - 天气：城市自动取自 IP 归属地（v0.2 无用户配置）→ wttr.in（主，实测 1.5s）
 *   → Open-Meteo（备：api 域国内直连不通，仅海外/代理环境生效）
 * 出站仅城市名/IP 探测本身，永不携带书签数据（方案 §1.4 隐私口径）。
 */
import { browser } from "wxt/browser";
import type { IpFamily, IpInfo, WeatherSnapshot } from "@mf/shared";
import {
  bestIp,
  isIpv4,
  normalizeOpenMeteo,
  normalizeWttr,
  parseCloudflareTrace,
  parseIpPlain,
  parseIpipText,
  weatherCityFromIp,
} from "@mf/shared";

export const IP_TTL_MS = 24 * 60 * 60 * 1000;
export const WEATHER_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 9000;

export interface WidgetResult<T> {
  data: T;
  /** 数据落盘时间戳 */
  ts: number;
  /** 取数失败但留有旧缓存时置真：卡片显示「已过期」而非报错 */
  stale: boolean;
}

async function fetchText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const safeJson = <T>(t: string): T | null => {
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
};

type CacheRow = Record<string, { data: unknown; ts: number }>;

async function readCache(): Promise<CacheRow> {
  const s = await browser.storage.local.get(["widgetCache"]);
  return (s.widgetCache as CacheRow) ?? {};
}

async function writeCache(id: string, data: unknown): Promise<number> {
  const ts = Date.now();
  const c = await readCache();
  await browser.storage.local.set({ widgetCache: { ...c, [id]: { data, ts } } });
  return ts;
}

const IP_SOURCES: ReadonlyArray<{ url: string; parse: (t: string) => IpInfo | null }> = [
  { url: "https://myip.ipip.net", parse: parseIpipText },
  { url: "https://api.ip.sb/ip", parse: parseIpPlain },
  { url: "https://cloudflare.com/cdn-cgi/trace", parse: parseCloudflareTrace },
  { url: "https://api.ipify.org?format=json", parse: (t) => parseIpPlain(String(safeJson<{ ip?: string }>(t)?.ip ?? "")) },
];

/**
 * 并行探测，**保留全部候选地址**（D41 v0.3.2）：旧版只存单个「首选」结果——
 * 双栈网络下 IPv6 一旦成为首选并被缓存 24h，页面上就没有 IPv4 可切（粘滞）。
 * 现在 v4/v6 都进 candidates，展示项由 UI 按地址族偏好 pickIp 选取（点击即切换）。
 * fast path：「IPv4+归属」到手立即继续（不等 9s 超时的慢源），但再给 2s 收敛窗口
 * 尽量把另一族也收齐——切换器需要两个都在场。
 */
export interface IpProbe {
  candidates: IpInfo[];
  ts: number;
  stale: boolean;
}

/** 兼容 v0.3.1 缓存格式（单个 IpInfo）→ 候选数组 */
function decodeIpCache(data: unknown): IpInfo[] {
  const row = data as { candidates?: IpInfo[] } & Partial<IpInfo> | undefined;
  if (row?.candidates?.length) return row.candidates;
  if (row && typeof row.ip === "string") return [row as IpInfo];
  return [];
}

export async function getIpProbe(force = false): Promise<IpProbe> {
  const cached = await readCache();
  const hit = cached["ip"];
  if (!force && hit && Date.now() - hit.ts < IP_TTL_MS) {
    const cands = decodeIpCache(hit.data);
    if (cands.length) return { candidates: cands, ts: hit.ts, stale: false };
  }
  const got: (IpInfo | null)[] = new Array(IP_SOURCES.length).fill(null);
  let bestReady: (() => void) | undefined;
  const early = new Promise<void>((r) => (bestReady = r));
  const proms = IP_SOURCES.map(async (src, i) => {
    try {
      const info = src.parse(await fetchText(src.url));
      got[i] = info;
      if (info && isIpv4(info.ip) && (info.city || info.province)) bestReady!();
    } catch {
      /* 单源失败忽略 */
    }
  });
  const all = Promise.allSettled(proms);
  await Promise.race([early, all]);
  // fast path 已触发：再给慢源 2s 收敛窗口（收齐另一族地址），超时不等
  await Promise.race([all, new Promise<void>((r) => setTimeout(r, 2000))]);
  const infos = got.filter((v): v is IpInfo => v !== null);
  if (infos.length) {
    return { candidates: infos, ts: await writeCache("ip", { candidates: infos }), stale: false };
  }
  const staleCands = hit ? decodeIpCache(hit.data) : [];
  if (staleCands.length) return { candidates: staleCands, ts: hit!.ts, stale: true };
  throw new Error("ip_unreachable");
}

/** 天气：先借 IP 归属地定城市；双源回退；失败降级旧缓存 stale */
export async function getWeather(force = false): Promise<WidgetResult<WeatherSnapshot>> {
  const cached = await readCache();
  const hit = cached["weather"];
  if (!force && hit && Date.now() - hit.ts < WEATHER_TTL_MS) {
    return { data: hit.data as WeatherSnapshot, ts: hit.ts, stale: false };
  }
  let city: string | null = null;
  try {
    const best = bestIp((await getIpProbe()).candidates);
    if (best) city = weatherCityFromIp(best);
  } catch {
    /* 定位失败，尝试沿用缓存城市 */
  }
  if (!city && hit) city = (hit.data as WeatherSnapshot).city;
  if (!city) throw new Error("weather_no_city");

  // 主源 wttr.in（实测国内直连可用，中文城市名 OK）
  try {
    const snap = normalizeWttr(safeJson(await fetchText(`https://wttr.in/${encodeURIComponent(city)}?format=j1`)), city);
    if (snap) return { data: snap, ts: await writeCache("weather", snap), stale: false };
  } catch {
    /* 换备源 */
  }
  // 备源 Open-Meteo（预报域国内直连不通，海外/代理环境才生效）
  try {
    const geo = safeJson<{ results?: Array<{ latitude: number; longitude: number }> }>(
      await fetchText(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`),
    );
    const g = geo?.results?.[0];
    if (g) {
      const fc = await fetchText(
        `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}` +
          `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code` +
          `&daily=temperature_2m_max,temperature_2m_min&forecast_days=3&timezone=auto`,
      );
      const snap = normalizeOpenMeteo(safeJson(fc), city);
      if (snap) return { data: snap, ts: await writeCache("weather", snap), stale: false };
    }
  } catch {
    /* 双源皆挂 */
  }
  if (hit) return { data: hit.data as WeatherSnapshot, ts: hit.ts, stale: true };
  throw new Error("weather_unreachable");
}

export const FRIENDLY_ERRORS: Record<string, string> = {
  ip_unreachable: "网络不可用",
  weather_no_city: "未能定位城市",
  weather_unreachable: "天气服务不可用",
};

/** IP 展示地址族偏好（页脚点击切换的持久记忆，非设置项——不占配置面） */
export async function getIpFamilyPref(): Promise<IpFamily> {
  const s = await browser.storage.local.get(["widgetPrefs"]);
  return (s.widgetPrefs as { ip?: IpFamily } | undefined)?.ip === "v6" ? "v6" : "v4";
}

export async function setIpFamilyPref(family: IpFamily): Promise<void> {
  const s = await browser.storage.local.get(["widgetPrefs"]);
  const prefs = (s.widgetPrefs as Record<string, unknown> | undefined) ?? {};
  await browser.storage.local.set({ widgetPrefs: { ...prefs, ip: family } });
}
