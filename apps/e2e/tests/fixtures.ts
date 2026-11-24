/**
 * E2E 前置：启动本地 server（node dist，临时数据目录），注册全局 fixture。
 * 匿名实例在 3007 端口（扩展默认配置的服务端地址之外的测试口）。
 * D81 §5 批次一（D80 Tier1-B）：鉴权实例 3008 / 第二实例 3009——
 * acceptance-session/system-admin/folder-delete-sync/inbox-stuck-recovery/batch-toolbar
 * 五个 spec 原先直指 3000 真实 dev 库（测试残留污染真实数据），一律切到本 fixture。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
export const PORT = 3007; // 3000 被 VSCode 扩展宿主占用（ZCode Helper）
export const BASE = `http://127.0.0.1:${PORT}`;
/** D81：鉴权 fixture（ADMIN_PASSWORD 与旧真实实例同口径，spec 登录路径零改动） */
export const AUTH_PORT = 3008;
export const AUTH_BASE = `http://127.0.0.1:${AUTH_PORT}`;
export const SECONDARY_PORT = 3009;
export const SECONDARY_BASE = `http://127.0.0.1:${SECONDARY_PORT}`;
export const FIXTURE_ADMIN = { username: "admin", password: "123456" };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = path.resolve(__dirname, "../../extension/.output/chrome-mv3");

interface FixtureServer { proc: ChildProcess; dataDir: string }
const servers = new Map<number, FixtureServer>();

/** 启动本地 server（在各 spec 的 beforeAll 中显式调用） */
export async function startServer(): Promise<void> {
  await startFixtureOnPort(PORT, false);
}

/** D81：鉴权实例（系统管理/同步验收/收纳盒卡死等需要 401 语义的 spec） */
export async function startAuthServer(): Promise<void> {
  await startFixtureOnPort(AUTH_PORT, true);
}

/** D81：第二实例（acceptance-session 多实例同形态验收，完全同一部署形态仅地址/数据卷不同） */
export async function startSecondaryServer(): Promise<void> {
  await startFixtureOnPort(SECONDARY_PORT, true);
}

async function startFixtureOnPort(port: number, auth: boolean): Promise<void> {
  if (servers.has(port)) return;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[fixture] startServer begin (port ${port}, auth=${auth})`);
  // fail-fast：端口被残留进程占用时，测试页面会打到旧服务器（曾导致脏数据误判）
  // 端口占用检测用 TCP connect（不经 HTTP 层，避免代理/IPv6 干扰）
  const occupied = await new Promise<boolean>((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 1000);
  });
  if (occupied) throw new Error(`port ${port} already occupied by another server`);
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-e2e-"));
  console.log("[fixture] spawning server");
  const proc = spawn("node", [path.resolve(__dirname, "../../server/dist/index.js")], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      NODE_ENV: "production",
      // A4-1 安全默认值：E2E 服务端按 test 语义启动（不触发生产 setup 门槛）。
      // 如需验证生产语义，单独用 MF_ENV=production 启动并走 /admin/setup 流程。
      MF_ENV: process.env.E2E_MF_ENV ?? "test",
      // D81：鉴权实例启用 ADMIN_PASSWORD（owner 自动 provisioning → admin/123456 统一登录）
      ...(auth ? { ADMIN_PASSWORD: FIXTURE_ADMIN.password } : {}),
      // 管理台静态产物（web-dist 已移出版本库，本地 E2E 指向 web 构建产物）
      WEB_DIST_DIR: path.resolve(__dirname, "../../web/dist"),
      MF_SKIP_SERVE: undefined,
      NO_PROXY: "*",
      no_proxy: "*",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
    },
    stdio: process.env.E2E_SERVER_LOG === "1" ? "inherit" : "ignore",
  });
  let startError: Error | undefined;
  proc.on("error", (e) => {
    startError = e;
    console.error("[e2e server] spawn error:", e);
  });
  proc.on("exit", (code) => {
    startError = new Error(`fixture server ${port} exited (${code ?? "signal"})`);
    if (code !== null) console.error(`[e2e server:${port}] exited early, code`, code);
  });
  servers.set(port, { proc, dataDir });
  // 等待就绪
  for (let i = 0; i < 40; i++) {
    if (startError) throw startError;
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(800) });
      if (startError || proc.exitCode !== null || proc.signalCode !== null) throw startError ?? new Error(`fixture server ${port} stopped during startup`);
      if (res.ok) {
        console.log(`[fixture] server ready (port ${port})`);
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start (port ${port})`);
}

export function stopServer(): void {
  stopFaultProxy();
  for (const [port, s] of servers) {
    s.proc.kill();
    try {
      rmSync(s.dataDir, { recursive: true, force: true });
    } catch {
      // windows lock 等
    }
    servers.delete(port);
  }
}

/** D81：鉴权 fixture 的数据目录（故障注入用——如外部裁剪 changes 模拟长离线过期游标） */
export function authServerDataDir(): string {
  const s = servers.get(AUTH_PORT);
  if (!s) throw new Error("auth fixture not started");
  return s.dataDir;
}

// ---------- D81 复核：故障注入代理（测试基建，不进生产代码） ----------
// 位于扩展与鉴权 fixture 之间（3010 → 3008），只干预 POST /api/v1/sync/apply：
//  - fail：整批 503、不转发（网络失败 / 服务端不可用）
//  - drop：转发并等上游处理完（**服务端已提交**）后对客户端回 503（响应丢失）
//  - failKind：指定 kind 的操作不转发、返回合成的 failed 回执（逐条失败不丢操作的验证）
// 用于验证出站队列：opId 复用、成功才出队、失败保留、响应丢失后重放不覆盖后续修改。
export const PROXY_PORT = 3010;
export const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;
export const fault = {
  apply: "pass" as "pass" | "fail" | "drop",
  failKind: null as string | null,
};
let proxy: http.Server | null = null;

const corsHeadersFor = (req: http.IncomingMessage): Record<string, string> => ({
  "access-control-allow-origin": String(req.headers.origin ?? "*"),
  "access-control-allow-headers": "Content-Type,Authorization,Idempotency-Key,X-MF-Private,X-MF-Device",
  "access-control-allow-methods": "GET,HEAD,PUT,POST,DELETE,PATCH",
  "content-type": "application/json",
});

export async function startFaultProxy(): Promise<void> {
  if (proxy) return;
  proxy = http.createServer((req, res) => {
    const isApply = (req.url ?? "").startsWith("/api/v1/sync/apply") && req.method === "POST";
    if (isApply && fault.apply === "fail") {
      req.resume();
      res.writeHead(503, corsHeadersFor(req));
      res.end(JSON.stringify({ error: "injected_failure" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      let synthetic: Array<{ index: number; result: unknown }> = [];
      if (isApply && fault.failKind) {
        try {
          const parsed = JSON.parse(body.toString("utf8")) as { mutations?: unknown[] };
          const keep: unknown[] = [];
          (parsed.mutations ?? []).forEach((m, i) => {
            if ((m as { kind?: string })?.kind === fault.failKind) {
              synthetic.push({ index: i, result: { kind: fault.failKind, status: "failed", error: "injected_failed" } });
            } else keep.push(m);
          });
          if (synthetic.length > 0) body = Buffer.from(JSON.stringify({ ...parsed, mutations: keep }));
        } catch {
          /* 非 JSON 请求体：原样转发 */
        }
      }
      const forward = () => {
        // 请求头：修正 content-length（failKind 改写体后必须同步，否则上游死等剩余字节）；
        // connection: close + agent:false —— 不复用 keep-alive 连接，避免 SSE 长连与短请求混用连接池死锁
        const fwdHeaders: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${AUTH_PORT}`, connection: "close" };
        if (!["GET", "HEAD"].includes(req.method ?? "GET")) fwdHeaders["content-length"] = String(body.length);
        else delete fwdHeaders["content-length"];
        const upstream = http.request(
          { host: "127.0.0.1", port: AUTH_PORT, method: req.method, path: req.url, headers: fwdHeaders, agent: false },
          (up) => {
            if (isApply && fault.apply === "drop") {
              // 上游已处理完（已提交）→ 丢弃响应：对客户端回 503
              up.resume();
              up.on("end", () => {
                res.writeHead(503, corsHeadersFor(req));
                res.end(JSON.stringify({ error: "injected_response_dropped" }));
              });
              return;
            }
            // 响应头：去掉逐跳头，交由 Node 按实际写出重算（合成体 / 管道都安全）
            const outHeaders = { ...up.headers };
            delete outHeaders["content-length"];
            delete outHeaders["transfer-encoding"];
            delete outHeaders["connection"];
            delete outHeaders["keep-alive"];
            if (synthetic.length === 0) {
              res.writeHead(up.statusCode ?? 502, outHeaders);
              up.pipe(res);
              return;
            }
            const parts: Buffer[] = [];
            up.on("data", (c: Buffer) => parts.push(c));
            up.on("end", () => {
              let out: Buffer;
              try {
                const json = JSON.parse(Buffer.concat(parts).toString("utf8")) as { results: unknown[] };
                for (const s of synthetic.sort((a, b) => b.index - a.index)) json.results.splice(s.index, 0, s.result);
                out = Buffer.from(JSON.stringify(json));
              } catch {
                out = Buffer.concat(parts);
              }
              res.writeHead(up.statusCode ?? 502, { ...outHeaders, "content-type": "application/json", "content-length": String(out.length) });
              res.end(out);
            });
          },
        );
        upstream.setTimeout(30_000, () => {
          upstream.destroy(new Error("proxy upstream timeout"));
        });
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502, corsHeadersFor(req));
          res.end(JSON.stringify({ error: "proxy_upstream_unreachable" }));
        });
        if (["GET", "HEAD"].includes(req.method ?? "GET")) upstream.end();
        else upstream.end(body);
      };
      if (isApply && synthetic.length > 0) {
        // 全部被合成的批次不必转发
        try {
          const parsed = JSON.parse(body.toString("utf8")) as { mutations?: unknown[] };
          if ((parsed.mutations ?? []).length === 0) {
            const results: unknown[] = [];
            for (const s of synthetic.sort((a, b) => a.index - b.index)) results.push(s.result);
            res.writeHead(200, corsHeadersFor(req));
            res.end(JSON.stringify({ results, cursor: 0 }));
            return;
          }
        } catch {
          /* 走转发 */
        }
      }
      forward();
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy!.once("error", reject);
    proxy!.listen(PROXY_PORT, "127.0.0.1", () => resolve());
  });
}

export function stopFaultProxy(): void {
  proxy?.close();
  proxy = null;
  fault.apply = "pass";
  fault.failKind = null;
}

/** D81：把扩展 options 页指向 fixture 服务端（storage 直写 + reload，免 UI 添加服务流程）。
 *  时序要点：options boot IIFE（loadEntries→activate）是一条 read-modify-write 链，
 *  写入落在链中间会被 activate(旧值) 覆写——前后各等 boot 落定，且连 servers 列表一起写。 */
export async function pointExtensionTo(page: import("@playwright/test").Page, base: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.evaluate((url) => {
    const host = new URL(url).host;
    return browser.storage.local.set({
      serverUrl: url,
      activeServer: url,
      servers: [{ url, label: host, mode: "self" }],
    });
  }, base);
  await page.reload();
  await page.waitForLoadState();
  await page.waitForTimeout(400);
}

/** 通过 API 预置数据 */
export async function seedViaApi(): Promise<{ slug: string }> {
  const ingest = await fetch(`${BASE}/api/v1/bookmarks/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "e2e-seed-0001",
      items: [
        { url: "https://github.com/easeyeah", title: "GitHub 主页", folderPath: ["开发"] },
        { url: "https://developer.mozilla.org/zh-CN/", title: "MDN 文档", folderPath: ["开发"] },
        { url: "https://bilibili.com", title: "哔哩哔哩", folderPath: ["娱乐"] },
      ],
    }),
  });
  if (!ingest.ok) throw new Error("seed ingest failed");

  // D23 显式发布集合：发布必须带范围（全部非系统目录）
  const folders = (await (await fetch(`${BASE}/api/v1/folders`)).json()) as Array<{
    id: string;
    is_system_inbox: number;
  }>;
  const folderIds = folders.filter((f) => f.is_system_inbox !== 1).map((f) => f.id);

  const pub = await fetch(`${BASE}/api/v1/nav/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "我的导航站", folderIds }),
  });
  if (!pub.ok) throw new Error(`seed publish failed: HTTP ${pub.status}`);
  const { slug } = (await pub.json()) as { slug: string };
  return { slug };
}
