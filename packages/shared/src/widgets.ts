/**
 * 新标签页小组件 · 数据源解析与归一化（docs/新标签页小组件方案-v0.2.md，D41）
 *
 * 零依赖纯函数：文本解析、天气码映射、城市提取——扩展端直连取数，服务端不引用。
 * 实测结论（2026-11-20 国内直连）：ipify 不通、api.ip.sb/geoip 403、
 * api.open-meteo.com 预报不通（geocoding/Cloudflare 正常）、wttr.in 可用（CORS *）。
 */

// ── 公网 IP ─────────────────────────────────────────────

export interface IpInfo {
  ip: string;
  /** 国家/地区中文名（ipip 文本首段）；cloudflare trace 为 ISO 码 */
  country?: string;
  province?: string;
  city?: string;
  isp?: string;
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** IPv4 判定（IP 卡「优先显示 IPv4」选择逻辑用，D41 走查修复） */
export const isIpv4 = (s: string): boolean => IPV4.test(s);

function isIp(s: string): boolean {
  return isIpv4(s) || (s.includes(":") && /^[0-9a-fA-F:]+$/.test(s));
}

/** 国内运营商词表（myip.ipip.net 文本尾段识别用） */
const ISP_WORDS = ["电信", "移动", "联通", "广电", "铁通", "长宽", "鹏博士", "教育网", "有线通", "中卫", "曙光"];

/**
 * 解析 myip.ipip.net 纯文本响应：
 * 「当前 IP：223.149.24.85  来自于：中国 湖南 怀化  电信」
 * 直辖市形态「中国 北京 北京  电信」→ province=city=北京。
 */
export function parseIpipText(text: string): IpInfo | null {
  const m = text.match(/当前\s*IP[：:]\s*([0-9a-fA-F:.]+)(?:\s*来自于[：:]\s*(.+))?/);
  if (!m || !isIp(m[1]!)) return null;
  const info: IpInfo = { ip: m[1]! };
  const tokens = (m[2] ?? "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return info;
  info.country = tokens.shift()!;
  const last = tokens[tokens.length - 1];
  if (last && ISP_WORDS.some((s) => last.includes(s))) info.isp = tokens.pop();
  if (tokens.length >= 2) {
    info.province = tokens[0];
    info.city = tokens[1];
  } else if (tokens.length === 1 && tokens[0] !== info.country) {
    info.city = tokens[0];
  }
  return info;
}

/** 解析 cloudflare trace：逐行 key=value，取 ip= 与 loc=（ISO 国家码） */
export function parseCloudflareTrace(text: string): IpInfo | null {
  const lines = text.split("\n");
  let ip: string | null = null;
  let loc: string | null = null;
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq);
    const v = line.slice(eq + 1).trim();
    if (k === "ip") ip = v;
    else if (k === "loc") loc = v;
  }
  if (!ip || !isIp(ip)) return null;
  return { ip, ...(loc && loc !== "XX" ? { country: loc } : {}) };
}

/** 解析纯 IP 文本响应（api.ip.sb/ip 等） */
export function parseIpPlain(text: string): IpInfo | null {
  const s = text.trim();
  return isIp(s) ? { ip: s } : null;
}

export type IpFamily = "v4" | "v6";

function dedupeIps(candidates: IpInfo[]): IpInfo[] {
  const uniq: IpInfo[] = [];
  for (const c of candidates) {
    if (c && !uniq.some((u) => u.ip === c.ip)) uniq.push(c);
  }
  return uniq;
}

/**
 * 按用户当前地址族选展示项（点击切换器逻辑，D41 v0.3.2）：
 * 目标族存在→返回之（IPv4+归属优先）；不存在→回退首个候选（去重）。
 */
export function pickIp(candidates: IpInfo[], family: IpFamily): IpInfo | null {
  const uniq = dedupeIps(candidates);
  const match = uniq.filter((i) => (family === "v6" ? !isIpv4(i.ip) : isIpv4(i.ip)));
  return match.find((i) => i.city || i.province) ?? match[0] ?? uniq[0] ?? null;
}

/** 无显式偏好时的默认择优：IPv4+归属 > IPv4 > IPv6+归属 > 首个（IPv4 恒优先，走查反馈） */
export function bestIp(candidates: IpInfo[]): IpInfo | null {
  const uniq = dedupeIps(candidates);
  return (
    uniq.find((i) => isIpv4(i.ip) && (i.city || i.province)) ??
    uniq.find((i) => isIpv4(i.ip)) ??
    uniq.find((i) => !isIpv4(i.ip) && (i.city || i.province)) ??
    uniq[0] ??
    null
  );
}

/** IP 卡的归属地小字：「湖南 怀化 · 电信」；无归属信息则 null */
export function ipRegionLine(info: IpInfo): string | null {
  const geo = [info.province, info.city].filter(Boolean).join(" ");
  if (!geo) return null;
  return info.isp ? `${geo} · ${info.isp}` : geo;
}

/** 天气自动定位的城市名（v0.2：用户不配置城市，全靠 IP 归属地） */
export function weatherCityFromIp(info: IpInfo): string | null {
  return info.city ?? info.province ?? null;
}

// ── 天气 ────────────────────────────────────────────────

export interface WeatherNow {
  tempC: number;
  feelsC: number;
  humidity: number;
  windKph: number;
  /** 原始天气码（WWO / WMO），映射见 weatherIcon */
  code?: string;
  /** 源返回的英文描述，码表未命中时兜底 */
  desc?: string;
}

export interface WeatherDay {
  date: string;
  maxC: number;
  minC: number;
}

export interface WeatherSnapshot {
  city: string;
  /** 数据来源标识，调试与 stale 展示用 */
  source: "wttr" | "open-meteo";
  now: WeatherNow;
  days: WeatherDay[];
}

const num = (v: unknown): number => Number(v ?? 0) || 0;

/** wttr.in ?format=j1 → WeatherSnapshot */
export function normalizeWttr(json: unknown, city: string): WeatherSnapshot | null {
  const j = json as { current_condition?: Record<string, unknown>[]; weather?: { date: string; maxtempC: string; mintempC: string }[] };
  const cur = j?.current_condition?.[0];
  if (!cur) return null;
  const desc = (cur.weatherDesc as { value?: string }[] | undefined)?.[0]?.value;
  return {
    city,
    source: "wttr",
    now: {
      tempC: num(cur.temp_C),
      feelsC: num(cur.FeelsLikeC),
      humidity: num(cur.humidity),
      windKph: num(cur.windspeedKmph),
      code: cur.weatherCode != null ? String(cur.weatherCode) : undefined,
      ...(desc ? { desc } : {}),
    },
    days: (j.weather ?? []).slice(0, 3).map((d) => ({ date: d.date, maxC: num(d.maxtempC), minC: num(d.mintempC) })),
  };
}

/** Open-Meteo /v1/forecast（current + daily 三变量）→ WeatherSnapshot */
export function normalizeOpenMeteo(json: unknown, city: string): WeatherSnapshot | null {
  const j = json as { current?: Record<string, number>; daily?: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[] } };
  const c = j?.current;
  if (!c) return null;
  const d = j.daily;
  return {
    city,
    source: "open-meteo",
    now: {
      tempC: num(c.temperature_2m),
      feelsC: num(c.apparent_temperature),
      humidity: num(c.relative_humidity_2m),
      windKph: num(c.wind_speed_10m),
      code: c.weather_code != null ? String(c.weather_code) : undefined,
    },
    days: (d?.time ?? []).slice(0, 3).map((date, i) => ({ date, maxC: num(d!.temperature_2m_max[i]), minC: num(d!.temperature_2m_min[i]) })),
  };
}

/** WMO 码（Open-Meteo 0–99）→ 图标 + 中文文案 */
const WMO: Record<number, [string, string]> = {
  0: ["☀️", "晴"], 1: ["🌤️", "晴间多云"], 2: ["⛅", "多云"], 3: ["☁️", "阴"],
  45: ["🌫️", "雾"], 48: ["🌫️", "雾凇"],
  51: ["🌦️", "毛毛雨"], 53: ["🌦️", "毛毛雨"], 55: ["🌧️", "毛毛雨"],
  56: ["🌧️", "冻毛毛雨"], 57: ["🌧️", "冻毛毛雨"],
  61: ["🌧️", "小雨"], 63: ["🌧️", "中雨"], 65: ["🌧️", "大雨"],
  66: ["🌧️", "冻雨"], 67: ["🌧️", "冻雨"],
  71: ["🌨️", "小雪"], 73: ["🌨️", "中雪"], 75: ["❄️", "大雪"], 77: ["❄️", "雪粒"],
  80: ["🌦️", "阵雨"], 81: ["🌧️", "阵雨"], 82: ["⛈️", "强阵雨"],
  85: ["🌨️", "阵雪"], 86: ["❄️", "阵雪"],
  95: ["⛈️", "雷阵雨"], 96: ["⛈️", "雷阵雨伴冰雹"], 99: ["⛈️", "强雷阵雨"],
};

/** WWO 码（wttr.in weatherCode）→ 与 WMO 同一出口形态 */
const WWO: Record<number, [string, string]> = {
  113: ["☀️", "晴"], 116: ["🌤️", "晴间多云"], 119: ["☁️", "多云"], 122: ["☁️", "阴"],
  143: ["🌫️", "烟雾"], 248: ["🌫️", "雾"], 260: ["🌫️", "雾"],
  176: ["🌦️", "毛毛雨"], 263: ["🌦️", "毛毛雨"], 266: ["🌧️", "小雨"], 293: ["🌧️", "小雨"],
  296: ["🌧️", "小雨"], 299: ["🌧️", "中雨"], 302: ["🌧️", "中雨"], 305: ["🌧️", "大雨"],
  308: ["🌧️", "大雨"], 311: ["🌧️", "冻毛毛雨"], 314: ["🌧️", "冻雨"], 317: ["🌧️", "冻毛毛雨"],
  284: ["🌨️", "冻毛毛雨"], 353: ["🌦️", "小阵雨"], 356: ["🌧️", "阵雨"], 359: ["🌧️", "强阵雨"],
  362: ["🌧️", "冻阵雨"], 368: ["🌨️", "小雪"], 371: ["❄️", "暴雪"],
  320: ["🌨️", "小雪"], 323: ["🌨️", "小阵雪"], 326: ["🌨️", "小雪"], 329: ["🌨️", "中雪"],
  332: ["❄️", "中雪"], 335: ["❄️", "大雪"], 338: ["❄️", "大雪"], 350: ["❄️", "冰粒"],
  364: ["🌨️", "冻阵雪"], 367: ["🌨️", "阵雪"], 392: ["⛈️", "雷暴伴雪"], 395: ["❄️", "雷暴伴雪"],
  200: ["⛈️", "雷阵雨"], 386: ["⛈️", "雷阵雨"], 389: ["⛈️", "雷阵雨伴冰雹"],
};

/**
 * 天气码 → 图标/中文文案。先按源的码表查，未命中跨表再查
 *（码域混淆防御），仍无果用源描述兜底。
 */
export function weatherIcon(code: string | undefined, desc: string | undefined, source: WeatherSnapshot["source"]): { icon: string; label: string } {
  const n = code != null && code !== "" ? Number(code) : NaN;
  if (!Number.isNaN(n)) {
    const hit = (source === "wttr" ? WWO : WMO)[n] ?? (source === "wttr" ? WMO : WWO)[n];
    if (hit) return { icon: hit[0], label: hit[1] };
  }
  return { icon: "🌡️", label: desc ?? "未知" };
}
