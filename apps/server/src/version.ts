/**
 * 服务端版本号唯一来源：包清单 `apps/server/package.json`（发版时由 `pnpm run version` 更新）。
 *
 * - 构建期 esbuild 直接把 JSON 内联进 bundle（生产运行层只有 dist/index.js，无 package.json 可读）；
 * - `MF_VERSION` env 仍可覆盖（技术方案 §10.1，容器/灰度自报版本用）；
 * - 刻意不写死字面量：版本号在两处各写一份必然漂移（healthz 与 MCP serverInfo 曾各写 "0.1.0"）。
 */
import pkg from "../package.json" with { type: "json" };

export const SERVER_VERSION: string = process.env.MF_VERSION ?? pkg.version;
