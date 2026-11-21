import { serve } from "@hono/node-server";
import path from "node:path";
import { buildApp, type LlmFor } from "./app";
import { openDb } from "./db";
import { Store } from "./store";
import { Pipeline } from "./pipeline";
import { OrganizeService } from "./organize";
import { SemanticService } from "./semantic";
import { MaintenanceService, startScheduler, startRetentionPrune, startSummaryBackfill, startCategoryBackfill } from "./maintenance";
import { backfillMaterials, sweepOrphanCovers } from "./materials";
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

const pipeline = new Pipeline(store, llmFor, {
  syncAi: process.env.MF_SYNC_AI === "1",
  dataDir, // D61：资料库封面落盘需要 dataDir
});

const app = buildApp({
  store,
  llmFor,
  dataDir,
  pipeline,
  organize: new OrganizeService(store, llmFor),
  semantic: new SemanticService(store, llmFor("embedding"), process.env.LLM_EMBEDDING_MODEL ?? null),
  maintenance: new MaintenanceService(store),
  adminPassword: process.env.ADMIN_PASSWORD,
});

startScheduler(
  store,
  new MaintenanceService(store),
  // 每小时收纳盒清扫兜底（原型 06）：离线堆积批量处理 + 全设备镜像入队
  new Pipeline(store, llmFor, { syncAi: process.env.MF_SYNC_AI === "1" }),
);

// D58：增长表保留裁剪（常驻，不依赖调度器开关）
startRetentionPrune(store);

// D63：L1 摘要兜底补扫（常驻——fire-and-forget 摘要遇重启/LLM 当时不可用可找回；无 LLM 零开销）
startSummaryBackfill(pipeline);
startCategoryBackfill(pipeline); // D65：资料分类回灌（涓流常驻，无 LLM 零开销）

// D61 资料库：存量一次性回灌（纯本地分类，零网络）+ 孤儿封面清理（书签删除走 FK 级联，文件无钩子）
const backfill = backfillMaterials(store);
if (backfill.created > 0) {
  console.log(`[materials] backfill created ${backfill.created} entries (scanned ${backfill.scanned})`);
}
const swept = sweepOrphanCovers(dataDir, store);
if (swept > 0) console.log(`[materials] swept ${swept} orphan cover files`);

// 仅作为主进程运行时启动监听（测试导入时不启服务）
if (process.env.MF_SKIP_SERVE !== "1") {
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[my-favorites server] listening on http://localhost:${info.port}`);
  });
}

export default app;
