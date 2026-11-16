/**
 * E2E 前置：启动本地 server（node dist，临时数据目录），注册全局 fixture。
 * 服务器在 3000 端口（扩展默认配置的服务端地址）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
export const PORT = 3000;
export const BASE = `http://localhost:${PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = path.resolve(__dirname, "../../extension/.output/chrome-mv3");

let server: ChildProcess | null = null;
const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-e2e-"));

/** 启动本地 server（在各 spec 的 beforeAll 中显式调用） */
export async function startServer(): Promise<void> {
  if (server) return;
  server = spawn("node", [path.resolve(__dirname, "../../server/dist/index.js")], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(PORT),
      MF_SKIP_SERVE: undefined,
    },
    stdio: "pipe",
  });
  server.on("error", (e) => console.error("[e2e server] spawn error:", e));
  server.stderr?.on("data", (d) => console.error("[e2e server]", String(d).slice(0, 500)));
  // 等待就绪
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
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

  const pub = await fetch(`${BASE}/api/v1/nav/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "我的导航站" }),
  });
  const { slug } = (await pub.json()) as { slug: string };
  return { slug };
}
