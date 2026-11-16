/** 测试基建：临时目录 DB + 可选 mock LLM 的 app 工厂 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "./db";
import { Store } from "./store";
import { Pipeline } from "./pipeline";
import { OrganizeService } from "./organize";
import { buildApp, type AppDeps } from "./app";
import type { LlmClient } from "@mf/ai/llm-client";

export interface TestEnv extends AppDeps {
  app: ReturnType<typeof buildApp>;
  cleanup: () => void;
  dataDir: string;
  /** 直通 store 便于断言 */
  store: Store;
  pipeline: Pipeline;
  organize: OrganizeService;
}

export function makeEnv(llm: LlmClient | null = null, syncAi = false): TestEnv {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-test-"));
  const store = new Store(openDb(dataDir));
  const pipeline = new Pipeline(store, llm, { syncAi });
  const organize = new OrganizeService(store, llm);
  const app = buildApp({ store, llm, dataDir, pipeline, organize });
  return {
    app,
    store,
    llm,
    pipeline,
    organize,
    dataDir,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

export const json = (res: Response) => res.json() as Promise<never>;
