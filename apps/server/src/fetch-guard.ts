/**
 * 抓取网络访问策略（A1-4 + DEV-04，2026-11-18）
 *
 * 威胁模型：书签 URL 可指向内网（SSRF 面）——禁止访问私网/回环/链路本地/保留段；
 * 自建端默认同样禁止（书签内网地址应由扩展就地捕获），显式 allowlist 才放行。
 *
 * DEV-04 修订（关闭 E06 的三个缺口）：
 *  1. DNS 校验与实际连接的窗口：guardFetchTarget 解析并校验后，实际请求通过
 *     PinnedFetcher 直连【已校验的 IP】（保留 Host 头与 TLS SNI），消除二次解析
 *     rebinding 窗口；多地址按序 fallback，全部为已校验地址。
 *  2. IPv6 判定完善：完整解析 "::" 压缩、IPv4-mapped（含十六进制形态）、
 *     链路本地 fe80::/10 全范围、ULA fc00::/7、组播 ff00::/8、NAT64 64:ff9b::/96；
 *     解析失败按禁止处理（保守）。不再用字符串 startswith 近似。
 *  3. 资源边界：超时覆盖 DNS/连接/响应头；读取响应体时强制字节上限（超限即中止），
 *     重定向跳立即销毁响应流；总时长预算覆盖全部跳与响应体。
 *
 * 每一跳（重定向）重新执行完整校验；跨主机重定向不继承敏感头（authorization/cookie）。
 */
import { lookup } from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export type FetchGuardMode = "cloud" | "selfhosted_strict" | "selfhosted_allowlist";

export interface FetchGuardConfig {
  mode: FetchGuardMode;
  /** selfhosted_allowlist 模式下允许的内网网段/主机（CIDR 或精确 IP） */
  allowedCidrs?: string[];
}

// ---------- IPv6 精确解析（DEV-04：不再 startswith 近似） ----------

/** 解析 IPv6 为 8 个 16 位组；支持 "::" 压缩与尾部内嵌 IPv4。失败返回 null */
export function parseIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().trim();
  if (!s.includes(":")) return null;
  // 尾部内嵌 IPv4（x:x:x:x:x:x:d.d.d.d）→ 转两个 16 位组
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    const v4 = s.slice(lastColon + 1);
    if (!net.isIPv4(v4)) return null;
    const parts = v4.split(".").map(Number) as [number, number, number, number];
    const hi = ((parts[0]! << 8) | parts[1]!) >>> 0;
    const lo = ((parts[2]! << 8) | parts[3]!) >>> 0;
    s = `${s.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null; // 至多一个 "::"
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2) {
    if (missing < 0) return null; // "::" 展开溢出
    return [...head, ...new Array(missing).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

function ipv4FromGroups(groups: number[], start: number): string {
  const hi = groups[start] ?? 0;
  const lo = groups[start + 1] ?? 0;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** 判定 IP 是否属于禁止范围（私网/回环/链路本地/ULA/组播/保留段/mapped 内嵌） */
export function isForbiddenIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8（含 0.0.0.0）
    if (a === 10) return true; // 私网 A
    if (a === 127) return true; // 回环
    if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true; // 私网 B
    if (a === 192 && b === 168) return true; // 私网 C
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // 组播/保留/广播
    return false;
  }
  const groups = parseIpv6(ip);
  if (!groups) return true; // 解析不了按禁止（保守）
  // 未指定 ::
  if (groups.every((g) => g === 0)) return true;
  // 回环 ::1
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  // IPv4-mapped ::ffff:0:0/96（含 ::ffff:c0a8:101 与 ::ffff:192.168.1.1 两形态）与 NAT64 64:ff9b::/96
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const nat64 = groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
  if (mapped || nat64) return isForbiddenIp(ipv4FromGroups(groups, 6));
  // 链路本地 fe80::/10
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  // 唯一本地 fc00::/7
  if ((groups[0]! & 0xfe00) === 0xfc00) return true;
  // 组播 ff00::/8
  if ((groups[0]! & 0xff00) === 0xff00) return true;
  return false;
}

/** DEV-04 维护场景用：字面 IP 是否命中 allowlist（用于"部署显式放行的内网探测"判定） */
export function ipCoveredByAllowlist(ipOrHost: string, config: FetchGuardConfig): boolean {
  if (config.mode !== "selfhosted_allowlist") return false;
  if (!net.isIP(ipOrHost)) return false; // 域名不做预放行（交给逐跳守卫判定）
  return (config.allowedCidrs ?? []).some((c) => ipInCidr(ipOrHost, c));
}

function ipInCidr(ip: string, cidr: string): boolean {

  try {
    if (!cidr.includes("/")) return ip === cidr;
    const slash = cidr.indexOf("/");
    const base = cidr.slice(0, slash);
    const bits = Number(cidr.slice(slash + 1));
    if (!Number.isInteger(bits) || bits < 0) return false;
    if (net.isIPv4(ip) && net.isIPv4(base)) {
      if (bits > 32) return false;
      const toInt = (v: string) =>
        v.split(".").map(Number).reduce((acc, o) => ((acc << 8) | o) >>> 0, 0) >>> 0;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return ((toInt(ip) & mask) >>> 0) === ((toInt(base) & mask) >>> 0);
    }
    if (bits > 128) return false;
    const ipG = parseIpv6(ip);
    const baseG = parseIpv6(base);
    if (!ipG || !baseG) return false;
    let remaining = bits;
    for (let i = 0; i < 8 && remaining > 0; i++) {
      const take = Math.min(16, remaining);
      const mask = (0xffff << (16 - take)) & 0xffff;
      if (((ipG[i] ?? 0) & mask) !== ((baseG[i] ?? 0) & mask)) return false;
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

function checkAddresses(ips: string[], config: FetchGuardConfig): GuardResult {
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
 * 请求前校验：scheme + 字面 IP + DNS 解析结果，并返回【已校验的地址列表】。
 * 调用方（pinnedFetch）必须直连其中地址，禁止二次解析（关闭 rebinding 窗口）。
 */
export async function guardFetchTarget(
  url: string,
  config: FetchGuardConfig,
): Promise<GuardResult & { validatedAddresses?: string[]; hostname?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "scheme_forbidden", detail: "invalid url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: "scheme_forbidden" };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // 字面 IP 直接判定
  if (net.isIP(host)) {
    const r = checkAddresses([host], config);
    if (!r.allowed && r.reason === "dns_forbidden") {
      return { ...r, reason: "literal_ip_forbidden" };
    }
    return r.allowed ? { ...r, validatedAddresses: [host], hostname: host } : r;
  }
  // 域名：DNS 解析后判定（返回全部已校验地址供连接固定）
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (records.length === 0) {
      return { allowed: false, reason: "dns_forbidden", detail: "no dns records" };
    }
    const addresses = records.map((r) => r.address);
    const r = checkAddresses(addresses, config);
    return r.allowed ? { ...r, validatedAddresses: addresses, hostname: host } : r;
  } catch {
    return { allowed: false, reason: "dns_forbidden", detail: "dns lookup failed" };
  }
}

export class GuardError extends Error {
  constructor(
    public readonly guardResult: GuardResult,
    public readonly hopUrl: string,
  ) {
    super(`fetch blocked: ${guardResult.reason} (${guardResult.detail ?? ""})`);
    this.name = "GuardError";
  }
}

export class BodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`response body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

// ---------- Pinned 响应（读取期字节上限 + 总时长预算） ----------

export interface PinnedResponse {
  status: number;
  ok: boolean;
  header(name: string): string | undefined;
  /** 读取全部响应体（强制 maxBytes 上限；超限抛 BodyTooLargeError 并中止连接） */
  readBody(maxBytes: number): Promise<Buffer>;
  /** 丢弃并关闭响应流（重定向跳不再需要 body 时必须调用） */
  dispose(): void;
}

interface PinnedRequestOpts {
  method: "HEAD" | "GET";
  headers: Record<string, string>;
  /** 每跳连接+响应头预算（ms） */
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * 直连已校验 IP 的请求（保留 Host 头 + TLS SNI；多地址按序 fallback）。
 * 必须先经 guardFetchTarget 校验，地址列表原样传入——本函数不解析 DNS。
 */
function pinnedRequest(
  hopUrl: string,
  validatedAddresses: string[],
  hostname: string,
  opts: PinnedRequestOpts,
): Promise<PinnedResponse> {
  const parsed = new URL(hopUrl);
  const isTls = parsed.protocol === "https:";
  const port = parsed.port ? Number(parsed.port) : isTls ? 443 : 80;
  const path = `${parsed.pathname}${parsed.search}`;

  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    let lastError = "all validated addresses failed";
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const tryAddress = (idx: number): void => {
      if (idx >= validatedAddresses.length) {
        // 保留底层错误（ECONNREFUSED 等）——死链判定依赖可解释原因
        finish(() => reject(new Error(lastError)));
        return;
      }
      const address = validatedAddresses[idx]!;
      const transport = isTls ? https : http;
      const req = transport.request(
        {
          // 连接固定到已校验地址（消除二次解析 rebinding 窗口）
          host: address,
          port,
          path,
          method: opts.method,
          headers: { ...opts.headers, host: parsed.host }, // Host 保持原始主机名
          servername: isTls && net.isIP(hostname) === 0 ? hostname : undefined, // TLS SNI
          timeout: opts.timeoutMs, // 连接+空闲超时
        },
        (res) => {
          const response: PinnedResponse = {
            status: res.statusCode ?? 0,
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400,
            // node:http 的 headers 多数为 string（仅 set-cookie 等为数组），统一取首个值
            header: (name: string) => {
              const v = res.headers[name.toLowerCase()];
              return Array.isArray(v) ? v[0] : v;
            },
            readBody: (maxBytes: number) =>
              new Promise<Buffer>((res2, rej2) => {
                const chunks: Buffer[] = [];
                let total = 0;
                let done = false;
                const abort = (err: Error): void => {
                  if (done) return;
                  done = true;
                  res.destroy();
                  rej2(err);
                };
                res.on("data", (chunk: Buffer) => {
                  total += chunk.length;
                  if (total > maxBytes) {
                    abort(new BodyTooLargeError(maxBytes));
                    return;
                  }
                  chunks.push(chunk);
                });
                res.on("end", () => {
                  if (done) return;
                  done = true;
                  res2(Buffer.concat(chunks));
                });
                res.on("error", (err) => abort(err));
              }),
            dispose: () => {
              res.destroy();
            },
          };
          finish(() => resolve(response));
          // 拿到响应头后取消连接超时（读体由调用方预算控制）
          req.setTimeout(0);
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error("connect/headers timeout"));
      });
      req.on("error", (err) => {
        // 连接级失败 → 换下一个已校验地址（全部失败才报错，保留底层原因）
        if (!settled) {
          lastError = String((err as Error).message ?? err).slice(0, 200);
          tryAddress(idx + 1);
        }
      });
      req.end();
    };

    if (opts.signal) {
      opts.signal.addEventListener(
        "abort",
        () => finish(() => reject(new Error("aborted"))),
        { once: true },
      );
    }
    tryAddress(0);
  });
}

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "x-api-key", "proxy-authorization"]);

/**
 * 带防护的抓取：手动跟随重定向，每一跳重新执行完整校验并固定到该跳的已校验地址。
 * - 跨主机重定向剥离敏感头（authorization/cookie 等）；
 * - 重定向跳立即 dispose（不读体不悬挂）；
 * - maxBytes 在读取时强制；totalTimeoutMs 覆盖全部跳与读取。
 */
export async function guardedFetch(
  url: string,
  config: FetchGuardConfig,
  init: { headers?: Record<string, string>; method?: "HEAD" | "GET" } = {},
  opts: {
    maxRedirects?: number;
    timeoutMs?: number;
    maxBytes?: number;
    totalTimeoutMs?: number;
  } = {},
): Promise<PinnedResponse> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const totalTimeoutMs = opts.totalTimeoutMs ?? 30_000;
  const deadline = Date.now() + totalTimeoutMs;
  const method = init.method ?? "GET";
  const initHeaders = init.headers ?? {};
  let current = url;
  const originalHost = new URL(url).host; // 凭据只属于最初请求的端点

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("total timeout exceeded");
    }
    const guard = await guardFetchTarget(current, config);
    if (!guard.allowed || !guard.validatedAddresses || !guard.hostname) {
      throw new GuardError(guard, current);
    }
    // 跨主机重定向：不继承敏感头（避免 Key/凭据被重定向带往其他端点）
    const headers: Record<string, string> = { ...initHeaders };
    if (hop > 0 && new URL(current).host !== originalHost) {
      for (const h of Object.keys(headers)) {
        if (SENSITIVE_HEADERS.has(h.toLowerCase())) delete headers[h];
      }
    }
    const res: PinnedResponse = await pinnedRequest(current, guard.validatedAddresses, guard.hostname, {
      method,
      headers,
      timeoutMs: Math.min(timeoutMs, remaining),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.header("location");
      res.dispose(); // 重定向跳不读体，立即释放连接
      if (!location) throw new Error(`redirect ${res.status} without location`);
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new GuardError(
    { allowed: false, reason: "scheme_forbidden", detail: "too many redirects" },
    current,
  );
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
