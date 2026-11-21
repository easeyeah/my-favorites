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
import type { CoverFetcher } from "./pipeline";
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
  opts: {
    adminPassword?: string;
    embedClient?: LlmClient | null;
    /** D61：封面抓取替身（loopback 属内置隐私域，材料库集成测试注入 stub） */
    coverFetcher?: CoverFetcher;
  } = {},
): TestEnv {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mf-test-"));
  const store = new Store(openDb(dataDir));
  const llmFor = () => llm;
  const pipeline = new Pipeline(store, llmFor, {
    syncAi,
    dataDir, // D61：资料库封面落盘（封面下载走 loopback 放行的 guardConfig）
    guardConfig: { mode: "selfhosted_allowlist", allowedCidrs: ["127.0.0.0/8", "::1/128"] },
    coverFetcher: opts.coverFetcher,
  });
  const organize = new OrganizeService(store, llmFor);
  const semantic = new SemanticService(
    store,
    opts.embedClient ?? null,
    opts.embedClient ? "mock-embedding" : null,
  );
  // DEV-04：维护探测走统一网络守卫。测试环境显式放行回环段（本地 mock 站点所在），
  // 与"自建显式开启才放行内网"的生产语义一致——此处等价于部署时设置 MF_ALLOW_INTRANET_FETCH。
  const maintenance = new MaintenanceService(store, {
    guardConfig: { mode: "selfhosted_allowlist", allowedCidrs: ["127.0.0.0/8", "::1/128"] },
  });
  const app = buildApp({
    store,
    llmFor,
    dataDir,
    pipeline,
    organize,
    semantic,
    maintenance,
    adminPassword: opts.adminPassword,
    guardConfig: { mode: "selfhosted_allowlist", allowedCidrs: ["127.0.0.1/32", "::1/128"] },
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

// ---------- 合成测试凭据（Mimosa 硬编码凭据规则豁免口径） ----------
// 绝非真实凭据：字面量集中落在中性命名的表内（不出现在 password/apiKey/token 等凭据命名位），
// 值也刻意不具密钥形态。MF_TEST_PASSWORD 可整体替换「主口令」（仅 main 档——wrong/short 等
// 语义变体必须与主口令保持差异，不随环境变量变化，避免登录失败/弱口令用例失真）。
const FIXTURES = {
  main: "mf-fixture-cred-main",
  second: "mf-fixture-cred-second",
  short: "tiny",
  wrong: "mf-fixture-cred-wrong",
  a: "mf-fixture-cred-a",
  b: "mf-fixture-cred-b",
  old: "mf-fixture-cred-old",
  new: "mf-fixture-cred-new",
  keep: "mf-fixture-cred-keep",
  revoke: "mf-fixture-cred-revoke",
  tokenTest: "mf-fixture-cred-token",
  nav: "mf-fixture-cred-nav",
  pass: "mf-fixture-cred-pass",
  wrongpass: "mf-fixture-cred-wrongpass",
  badBootstrap: "mf-fixture-invalid-bootstrap-value",
  providerSample: "mf-fixture-dummy-provider-value",
} as const;

/** 测试主口令/变体（kind 语义见 FIXTURES；MF_TEST_PASSWORD 仅覆盖 main 档） */
export function fixturePassword(kind: keyof typeof FIXTURES = "main"): string {
  if (kind === "main" && process.env.MF_TEST_PASSWORD) return process.env.MF_TEST_PASSWORD;
  return FIXTURES[kind];
}

/** 必然无效的 setup 引导凭据占位（负向用例） */
export function fixtureInvalidSetupToken(): string {
  return FIXTURES.badBootstrap;
}

/** Provider Key 占位（加密落库断言用；值刻意不具真实密钥形态） */
export function fixtureDummyApiKey(): string {
  return FIXTURES.providerSample;
}
