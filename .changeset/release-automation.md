---
"@mf/server": patch
---

发版自动化接线（changesets 从「只写不消费」转为闭环）：根脚本 `pnpm changeset` / `pnpm run version` / `pnpm changeset:status` / `pnpm check:changeset`；CI 新增 changeset 门禁 `scripts/check-changeset.mjs`——PR 触达 `apps/*/src`、`apps/extension/entrypoints`、`packages/*/src`、包清单或 `docker/` 时必须新增 changeset，纯文档/测试/CI 改动放行，发版 PR 用提交信息 `[skip changeset]` 逃生；服务端版本号改为单一来源 `apps/server/package.json`（新增 `src/version.ts` 构建期内联，`MF_VERSION` env 仍可覆盖），healthz 与 MCP serverInfo 不再各自写死 `"0.1.0"`。
