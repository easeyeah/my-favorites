/** 测试基建：临时目录 DB + 可选 mock LLM 的 app 工厂 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "./db";
import { Store } from "./store";
import { Pipeline } from "./pipeline";
import { OrganizeService } from "./organize";
import { SemanticService } from "./semantic";
import { MaintenanceService } from "./maintenance";
import { buildApp, type AppDeps } from "./app";
import type { LlmClient } from "@mf/ai/llm-client";

// A4-1：测试进程默认显式 dev 语义（未设 MF_ENV 时不触发生产 setup 门槛）
if (!process.env.MF_ENV) process.env.MF_ENV = "test";

export interface TestEnv extends AppDeps {
  app: ReturnType<typeof buildApp>;
  cleanup: () => void;
  dataDir: string;
  store: Store;
  pipeline: Pipeline;
  organize: OrganizeService;
  semantic: SemanticService;
  maintenance: MaintenanceService;
}

export function makeEnv(
  llm: LlmClient | null = null,
  syncAi = false,
  opts: { adminPassword?: string; embedClient?: LlmClient | null } = {},
): TestEnv {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-test-"));
  const store = new Store(openDb(dataDir));
  const llmFor = () => llm;
  const pipeline = new Pipeline(store, llmFor, { syncAi });
  const organize = new OrganizeService(store, llmFor);
  const semantic = new SemanticService(
    store,
    opts.embedClient ?? null,
    opts.embedClient ? "mock-embedding" : null,
  );
  const maintenance = new MaintenanceService(store);
  const app = buildApp({
    store,
    llmFor,
    dataDir,
    pipeline,
    organize,
    semantic,
    maintenance,
    adminPassword: opts.adminPassword,
  });
  return {
    app,
    store,
    llmFor,
    pipeline,
    organize,
    semantic,
    maintenance,
    dataDir,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

export const json = (res: Response) => res.json() as Promise<never>;
