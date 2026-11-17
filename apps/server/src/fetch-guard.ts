/**
 * 抓取网络访问策略（A1-4，2026-11-17）
 *
 * 威胁模型：书签 URL 可指向内网（SSRF 面）——云端禁止访问私网/回环/链路本地；
 * 自建端默认同样禁止（书签内网地址应由扩展就地捕获，通道A），显式开启才放行。
 * 防 DNS rebinding：解析 IP 后校验；重定向后对每一跳重新校验（手动跟随重定向）。
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

export type FetchGuardMode = "cloud" | "selfhosted_strict" | "selfhosted_allowlist";

export interface FetchGuardConfig {
  mode: FetchGuardMode;
  /** selfhosted_allowlist 模式下允许的内网网段/主机（CIDR 或精确 IP） */
  allowedCidrs?: string[];
}

/** 判定 IP 是否属于禁止范围（私网/回环/链路本地/唯一本地/组播/保留段） */
export function isForbiddenIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts as [number, number, number, number];
    if (a === 10 || a === 127) return true; // 私网A / 回环
    if (a === 0) return true; // 本网络
    if (a === 169 && b === 254) return true; // 链路本地（含元数据服务 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true; // 私网B
    if (a === 192 && b === 168) return true; // 私网C
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // 组播/保留
    return false;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true; // 链路本地
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // 唯一本地
  if (lower.startsWith("ff")) return true; // 组播
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped：按内嵌 IPv4 判定
    return isForbiddenIp(lower.replace("::ffff:", ""));
  }
  return false;
}

function ipInCidr(ip: string, cidr: string): boolean {
  try {
    if (!cidr.includes("/")) return ip === cidr;
    const [base, bitsStr] = cidr.split("/");
    const bits = Number(bitsStr);
    if (net.isIPv4(ip) && net.isIPv4(base!)) {
      const toInt = (v: string) => v.split(".").map(Number).reduce((acc, o) => (acc << 8) | o, 0) >>> 0;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return ((toInt(ip) & mask) >>> 0) === ((toInt(base!) & mask) >>> 0);
    }
    // IPv6 CIDR：按前缀位比较（128bit 两个 64 位半段）
    const ipGroups = ip.toLowerCase().split(":").map((g) => parseInt(g || "0", 16));
    const baseGroups = base!.toLowerCase().split(":").map((g) => parseInt(g || "0", 16));
    let remaining = bits;
    for (let i = 0; i < 8 && remaining > 0; i++) {
      const take = Math.min(16, remaining);
      const mask = (0xffff << (16 - take)) & 0xffff;
      if (((ipGroups[i] ?? 0) & mask) !== ((baseGroups[i] ?? 0) & mask)) return false;
      remaining -= take;
    }
    return true;
  } catch {
    return false;
  }
}

export interface GuardResult {
  allowed: boolean;
  reason:
    | "ok"
    | "scheme_forbidden" // 非 http(s)
    | "literal_ip_forbidden" // URL 字面 IP 在禁止段
    | "dns_forbidden" // DNS 解析结果在禁止段（含 rebinding 防护）
    | "not_in_allowlist"; // 自建 allowlist 模式下未命中
  detail?: string;
}

/** 校验单个目标 host（已解析地址或字面 IP） */
function checkAddresses(
  ips: string[],
  config: FetchGuardConfig,
): GuardResult {
  const allowlist = config.allowedCidrs ?? [];
  for (const ip of ips) {
    if (config.mode === "selfhosted_allowlist" && allowlist.some((c) => ipInCidr(ip, c))) {
      continue; // 显式允许的内网段
    }
    if (isForbiddenIp(ip)) {
      return {
        allowed: false,
        reason: config.mode === "selfhosted_allowlist" ? "not_in_allowlist" : "dns_forbidden",
        detail: "target resolves to forbidden network range",
      };
    }
  }
  return { allowed: true, reason: "ok" };
}

/**
 * 请求前校验：scheme + 字面 IP + DNS 解析结果。
 * DNS rebinding 防护说明：解析与实际连接仍存在窗口，完全防护需自定义 agent 固定 IP；
 * 当前实现覆盖"解析即校验"（拦截绝大多数 rebinding 场景），完全连接级固定列入后续增强。
 */
export async function guardFetchTarget(url: string, config: FetchGuardConfig): Promise<GuardResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "scheme_forbidden", detail: "invalid url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: "scheme_forbidden" };
  }
  const host = parsed.hostname.toLowerCase();

  // 字面 IP 直接判定
  if (net.isIP(host)) {
    const r = checkAddresses([host], config);
    if (!r.allowed && r.reason === "dns_forbidden") {
      return { ...r, reason: "literal_ip_forbidden" };
    }
    return r;
  }
  // 域名：DNS 解析后判定
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (records.length === 0) {
      return { allowed: false, reason: "dns_forbidden", detail: "no dns records" };
    }
    return checkAddresses(
      records.map((r) => r.address),
      config,
    );
  } catch {
    return { allowed: false, reason: "dns_forbidden", detail: "dns lookup failed" };
  }
}

/**
 * 带防护的抓取：手动跟随重定向，每一跳重新执行完整校验（scheme/IP/DNS）。
 * 任何一跳不通过 → 抛 GuardError（不发起请求）。
 */
export class GuardError extends Error {
  constructor(
    public readonly guardResult: GuardResult,
    public readonly hopUrl: string,
  ) {
    super(`fetch blocked: ${guardResult.reason} (${guardResult.detail ?? ""})`);
    this.name = "GuardError";
  }
}

export async function guardedFetch(
  url: string,
  config: FetchGuardConfig,
  init: RequestInit = {},
  opts: { maxRedirects?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const guard = await guardFetchTarget(current, config);
    if (!guard.allowed) throw new GuardError(guard, current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, {
        ...init,
        signal: controller.signal,
        redirect: "manual", // 手动跟随：每跳校验
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res; // 无目标：原样返回由调用方处理
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new GuardError({ allowed: false, reason: "scheme_forbidden", detail: "too many redirects" }, current);
}

/** 从环境构建配置：MF_FORM=cloud → 云端模式；MF_ALLOW_INTRANET_FETCH=1 → 自建显式放行 */
export function fetchGuardConfigFromEnv(): FetchGuardConfig {
  if (process.env.MF_FORM === "cloud") return { mode: "cloud" };
  if (process.env.MF_ALLOW_INTRANET_FETCH === "1") {
    const cidrs = (process.env.MF_ALLOW_INTRANET_CIDRS ?? "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { mode: "selfhosted_allowlist", allowedCidrs: cidrs };
  }
  return { mode: "selfhosted_strict" };
}
