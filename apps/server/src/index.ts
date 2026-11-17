import { serve } from "@hono/node-server";
import path from "node:path";
import { buildApp, type LlmFor } from "./app";
import { openDb } from "./db";
import { Store } from "./store";
import { Pipeline } from "./pipeline";
import { OrganizeService } from "./organize";
import { SemanticService } from "./semantic";
import { MaintenanceService, startScheduler } from "./maintenance";
import { LlmClient, llmFromEnv } from "@mf/ai/llm-client";

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

const store = new Store(openDb(dataDir));

// LLM 解析顺序（技术方案 §6.1）：供应商配置（BYOK）→ 环境变量 → null
const envLlm = llmFromEnv();
const llmFor: LlmFor = (purpose) => {
  for (const c of store.enabledProviderConfigs()) {
    const model = c.purpose_models[purpose];
    if (model) {
      return new LlmClient({ baseUrl: c.base_url, apiKey: c.api_key, model });
    }
  }
  if (purpose === "embedding") {
    const model = process.env.LLM_EMBEDDING_MODEL;
    if (!model || !envLlm) return null;
    return new LlmClient({
      baseUrl: envLlm.baseUrl,
      apiKey: process.env.LLM_API_KEY ?? null,
      model,
    });
  }
  return envLlm;
};

const app = buildApp({
  store,
  llmFor,
  dataDir,
  pipeline: new Pipeline(store, llmFor, { syncAi: process.env.MF_SYNC_AI === "1" }),
  organize: new OrganizeService(store, llmFor),
  semantic: new SemanticService(store, llmFor("embedding"), process.env.LLM_EMBEDDING_MODEL ?? null),
  maintenance: new MaintenanceService(store),
  adminPassword: process.env.ADMIN_PASSWORD,
});

startScheduler(store, new MaintenanceService(store));

// 仅作为主进程运行时启动监听（测试导入时不启服务）
if (process.env.MF_SKIP_SERVE !== "1") {
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[my-favorites server] listening on http://localhost:${info.port}`);
  });
}

export default app;
