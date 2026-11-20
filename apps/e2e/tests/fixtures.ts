/**
 * E2E 前置：启动本地 server（node dist，临时数据目录），注册全局 fixture。
 * 服务器在 3000 端口（扩展默认配置的服务端地址）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
export const PORT = 3007; // 3000 被 VSCode 扩展宿主占用（ZCode Helper）
export const BASE = `http://127.0.0.1:${PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = path.resolve(__dirname, "../../extension/.output/chrome-mv3");

let server: ChildProcess | null = null;
const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-e2e-"));

/** 启动本地 server（在各 spec 的 beforeAll 中显式调用） */
export async function startServer(): Promise<void> {
  if (server) return;
  console.log("[fixture] startServer begin");
  // fail-fast：端口被残留进程占用时，测试页面会打到旧服务器（曾导致脏数据误判）
  // 端口占用检测用 TCP connect（不经 HTTP 层，避免代理/IPv6 干扰）
  const occupied = await new Promise<boolean>((resolve) => {
    const sock = net.connect(PORT, "127.0.0.1");
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
  if (occupied) throw new Error(`port ${PORT} already occupied by another server`);
  console.log("[fixture] spawning server");
  server = spawn("node", [path.resolve(__dirname, "../../server/dist/index.js")], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(PORT),
      NODE_ENV: "production",
      // A4-1 安全默认值：E2E 服务端按 test 语义启动（不触发生产 setup 门槛）。
      // 如需验证生产语义，单独用 MF_ENV=production 启动并走 /admin/setup 流程。
      MF_ENV: process.env.E2E_MF_ENV ?? "test",
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
    stdio: "ignore",
  });
  server.on("error", (e) => console.error("[e2e server] spawn error:", e));
  server.on("exit", (code) => {
    if (code !== null) console.error("[e2e server] exited early, code", code);
  });
  // 等待就绪
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(800) });
      if (res.ok) {
        console.log("[fixture] server ready");
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

export function stopServer(): void {
  server?.kill();
  server = null;
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // windows lock 等
  }
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
