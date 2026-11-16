import { serve } from "@hono/node-server";
import path from "node:path";
import { buildApp } from "./app";
import { openDb } from "./db";
import { Store } from "./store";
import { Pipeline } from "./pipeline";
import { OrganizeService } from "./organize";
import { llmFromEnv } from "@mf/ai/llm-client";

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

const store = new Store(openDb(dataDir));
const llm = llmFromEnv();
const app = buildApp({
  store,
  llm,
  dataDir,
  pipeline: new Pipeline(store, llm, { syncAi: process.env.MF_SYNC_AI === "1" }),
  organize: new OrganizeService(store, llm),
});

// 仅作为主进程运行时启动监听（测试导入时不启服务）
if (process.env.MF_SKIP_SERVE !== "1") {
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[my-favorites server] listening on http://localhost:${info.port}`);
  });
}

export default app;
