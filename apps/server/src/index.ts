import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

const app = new Hono();

app.use(logger());
// 扩展端跨源访问（MV3 发起的请求带 Origin: chrome-extension://...）
app.use(
  "/*",
  cors({
    origin: (origin) => origin,
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  }),
);

app.get("/healthz", (c) =>
  c.json({
    ok: true,
    // 形态标识：self-hosted（本镜像）与云端同一套代码，按 env 区分（技术方案 §3）
    form: process.env.MF_FORM ?? "self-hosted",
    version: process.env.npm_package_version ?? "0.0.0",
  }),
);

// M1 后续步骤挂载：ingest / bookmarks / inbox / organize / snapshots（技术方案 §5）
// import { ingest } from "./routes/ingest"; app.route("/api/v1", ingest);

export default app;

// 仅作为主进程运行时启动监听（测试导入时不启服务）
if (process.env.MF_SKIP_SERVE !== "1") {
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[my-favorites server] listening on http://localhost:${info.port}`);
  });
}
