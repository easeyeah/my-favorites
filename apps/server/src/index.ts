import { serve } from "@hono/node-server";
import path from "node:path";
import { buildApp, type LlmFor } from "./app";
import { openDb } from "./db";
import { Store } from "./store";
import { Registry } from "./registry";
import { UserDbManager, currentUserId, runAsUser } from "./tenancy";
import { Pipeline } from "./pipeline";
import { OrganizeService } from "./organize";
import { OrganizeTaskService } from "./organize-task";
import { SemanticService } from "./semantic";
import { MaintenanceService, startScheduler, startRetentionPrune, startSummaryBackfill, startCategoryBackfill, startClassificationReview, startMaterialConversionSweep } from "./maintenance";
import { backfillMaterials, sweepOrphanCovers } from "./materials";
import { LlmClient, llmFromEnv } from "@mf/ai/llm-client";

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

// D68 统一装配：一切部署同一套——用户名登录 + 多用户隔离（owner 'self' 恒主库，
// 其余用户各自 SQLite 文件）；DEPLOY_MODE 分叉退役（env 仍被接受但不再改变行为）。
const mainDb = openDb(dataDir);
const userDbs = new UserDbManager(dataDir, mainDb);
userDbs.startReaper(); // D67：闲置用户库连接回收（打开句柄数 ≈ 活跃用户数，非注册用户数）
const store = new Store(() => userDbs.dbFor(currentUserId()));
const registry = new Registry(mainDb);
registry.ensureOwnerAccount(process.env.ADMIN_PASSWORD);

// LLM 解析顺序（技术方案 §6.1）：供应商配置（BYOK）→ 环境变量 → null。
// enabledProviderConfigs 经请求上下文解析——云端取当前用户的 BYOK，自建主库不变。
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

const organize = new OrganizeService(store, llmFor);
// D92：目录整理任务——持久任务 + 分批提交 + 整次撤销；后台恢复按注册用户逐库执行
const organizeTasks = new OrganizeTaskService(store, llmFor, pipeline, organize, () => registry.listUserIds());

const app = buildApp({
  store,
  llmFor,
  dataDir,
  pipeline,
  organize,
  organizeTasks,
  semantic: new SemanticService(store, llmFor("embedding"), process.env.LLM_EMBEDDING_MODEL ?? null),
  maintenance: new MaintenanceService(store),
  adminPassword: process.env.ADMIN_PASSWORD,
  registry,
  userDbs,
});

// D92：启动即恢复中断的整理任务/撤销（任务真相在库里，进程重启不丢），之后每分钟巡检失联 worker
organizeTasks.startResumer();

startScheduler(
  store,
  new MaintenanceService(store),
  // 每小时收纳盒清扫兜底（原型 06）：离线堆积批量处理 + 全设备镜像入队
  pipeline,
  registry,
);

// D58：增长表保留裁剪（常驻，不依赖调度器开关）；D67 云端逐用户库执行
startRetentionPrune(store, registry);

// D63：L1 摘要兜底补扫（常驻——fire-and-forget 摘要遇重启/LLM 当时不可用可找回；无 LLM 零开销）
startSummaryBackfill(pipeline, registry);
startCategoryBackfill(pipeline, registry); // D65：资料分类回灌（涓流常驻，无 LLM 零开销）
startClassificationReview(pipeline, registry); // D77：分类自检 patrol（自动归位一次性复核，无 LLM 零开销）
startMaterialConversionSweep(pipeline, registry); // D91：新收纳盒入口持久候选，启动恢复+每分钟补扫

// D61 资料库：存量一次性回灌（纯本地分类，零网络）+ 孤儿封面清理（书签删除走 FK 级联，文件无钩子）
// D67：云端逐用户库回灌
for (const uid of registry.listUserIds()) {
  runAsUser(uid, () => {
    const backfill = backfillMaterials(store);
    if (backfill.created > 0) {
      console.log(`[materials] backfill created ${backfill.created} entries (scanned ${backfill.scanned})`);
    }
    const swept = sweepOrphanCovers(dataDir, store);
    if (swept > 0) console.log(`[materials] swept ${swept} orphan cover files`);
  });
}

// 仅作为主进程运行时启动监听（测试导入时不启服务）
if (process.env.MF_SKIP_SERVE !== "1") {
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[my-favorites server] listening on http://localhost:${info.port}`);
  });
}

export default app;
