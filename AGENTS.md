# AGENTS.md — my-favorites 项目规范（AI 会话必读）

> AI 辅助开发项目。任何接手本仓库的 AI 会话先读完本文件再动手。
> 权威文档：`docs/功能文档-v0.3.md`（产品）、`docs/技术方案设计-v0.1.md`（技术）。

## 项目一句话

把失控的浏览器书签堆，用 AI 整理成一个每天使用的个人导航主页。三种形态：官方云 SaaS ≡ 自建 Docker（NAS）≡ 纯本地扩展。

## 技术栈（已定，勿更改选型，有异议先提出讨论）

- **TS 全栈 monorepo**：pnpm + turbo
- 扩展：Manifest V3 + WXT + React + shadcn/ui + Tailwind v4
- 服务端：Hono（Node）；自建 SQLite(libsql) / 云端 PostgreSQL；Drizzle ORM
- 任务队列：自建=SQLite 进程内队列，云端=pgboss，实现同一 `JobQueue` 接口，**不引入 Redis**
- LLM：`packages/ai` 统一出口，OpenAI 兼容协议 + 供应商注册表（`providers.json` 纯数据）
- DOM 解析：linkedom + @mozilla/readability；快照：扩展端 `chrome.pageCapture.captureMHTML` 为主通道

## 仓库结构（规划）

```
apps/extension   # WXT 扩展：popup / sidepanel / newtab / background / offscreen
apps/server      # Hono API（云端与自建同构，env 区分形态）
apps/web         # Web 管理台 + 公开导航站渲染
packages/shared  # 领域模型、zod schema、URL 规范化、分类规则引擎（域名映射表）
packages/ai      # LLM Provider 适配、整理编排 prompt
packages/ui      # 三端共享组件（导航模板、diff 视图）
```

## 常用命令

```bash
pnpm install                     # 安装
pnpm dev                         # turbo 全量 dev
docker compose -f docker/docker-compose.dev.yml up   # 服务端必须跑在 Docker 里
pnpm --filter extension dev      # 扩展 WXT HMR（连接 http://localhost:3000）
pnpm seed                        # 生成边界情况书签集
pnpm test                        # 单元 + 集成
docker build --target prod -t my-favorites:ci -f docker/Dockerfile .   # 生产镜像 + 冒烟（内存 <300MB / 镜像 <=250MB）
```

## 硬性红线（违反=PR 不通过）

1. **NAS 资源红线**：自建容器运行内存 <300MB、镜像 ≤250MB（实测：node:22-alpine 运行时基线约 235MB，因此约束为"bundle 级增量，禁止整包 node_modules 进运行层"；server 以 esbuild bundle 交付）；SQLite 单文件；必须支持 ARM64
2. **隐私不可绕过**：隐私域名校验在 `packages/shared` 分类引擎内部执行，任何抓取/AI 调用前强制校验，不是可选步骤
3. **用户数据安全**：删除类操作永不自动执行（AI 只出建议清单）；所有整理/收件箱移动必须写入 `organize_version`（可回滚）
4. **版权红线**：公开导航站永不展示快照内容，仅元数据+摘要
5. **导入不进收件箱**：`ingest` 直接落映射目录，走两阶段整理；收件箱只接"以后随手丢"的增量

## 提交与版本

- Conventional Commits（`feat/fix/docs/chore/refactor/test/build`），CI commitlint 校验
- 功能合入随提交附 changeset；tag 格式 `<app>-vX.Y.Z`
- DB 迁移只前进不回滚；自建端迁移前自动备份
- **功能变更必须同步回写 `docs/`** 并递增文档小版本；决策记录只追加不修改

## 本地测试（Docker 优先）

服务端一律在本地 Docker 运行（开发环境即自建端形态）。LLM 三档切换只改 `LLM_BASE_URL`：`llm-mock`（默认，CI 稳定）→ 本机 Ollama → 真实端点。测试四层：单元 / API 集成 / Playwright E2E（加载未打包扩展）/ 镜像冒烟。

## 当前进度

- [x] 产品文档 v0.3、技术方案 v0.1（git 历史可查）
- [x] git 仓库 + GitHub 远端（easeyeah/my-favorites）
- [x] M1 骨架步骤 1+2：monorepo 初始化 + Docker 环境（shared/server/extension/web 四包可构建，URL 规范化 12 项单测通过）
- [ ] M1 骨架步骤 3-8：ingest/bookmarks API → 收件箱监听 → 整理会话 → 导航站 → 埋点
- [x] License：AGPL-3.0（官方全文已入库）

## 技术方案遗留核对项

- `providers.json` 中 MiniMax / 腾讯 TokenHub / 小米 MiMo 的 BaseURL 需以官方文档核实后填入
- captureMHTML 兼容性探针清单（M1 首周完成，见技术方案 §10）
