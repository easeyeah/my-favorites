# AGENTS.md — my-favorites 项目规范（AI 会话必读）

> AI 辅助开发项目。任何接手本仓库的 AI 会话先读完本文件再动手。
> 文档入口：[docs/README.md](docs/README.md)。权威现状文档：[`docs/产品.md`](docs/产品.md)（功能与状态）、[`docs/技术方案.md`](docs/技术方案.md)（架构/API/数据模型）、[`docs/决策记录.md`](docs/决策记录.md)（D1–D90，只追加）。**提交信息规范**：[`docs/开发规范/提交与发版规范.md`](docs/开发规范/提交与发版规范.md)（D90，代写提交前必读）。
> 原型 `docs/原型/`（17 屏 + 流程图）**已冻结，仅作历史参考，其中部分界面已被推翻（侧栏聊天、popup 页签、三档新标签页）**——界面规范以本文件「管理台 UI 设计规范」节为准，改动直接落 `apps/web` 代码并用 `?mock` 演示模式验收。

## 项目一句话

把失控的浏览器书签堆，用 AI 整理成一个每天使用的个人导航主页。**当前交付形态 = MV3 扩展 + 自建 Docker 单容器服务端（SQLite）**；官方云 SaaS 与纯本地扩展为规划形态（D15，勿把预留当已实现）。

## 技术栈（已定，勿更改选型，有异议先提出讨论）

- **TS 全栈 monorepo**：pnpm + turbo；Node ≥22
- 扩展：Manifest V3 + WXT + React 19 + Tailwind v4（options 页是原生 DOM 例外）
- 服务端：Hono（Node）；自建 **node:sqlite 内置驱动**，SQL 集中在仓储层 `store.ts`（ORM 后置到云端引 PostgreSQL 时评估）
- 队列/调度：**现状无框架**——浏览器镜像走 SQLite 表 `pending_browser_ops`，后台任务走 setInterval；📋 云端规划 pgboss/JobQueue 抽象，**不引入 Redis**
- LLM：`packages/ai` 统一出口，OpenAI 兼容协议 + `providers.json` 纯数据注册表（15 预设）；无 BYOK/env LLM 时全线降级规则引擎
- 正文提取：**无 Readability/linkedom 依赖**——扩展注入脚本取 `innerText`（2 万字截断），服务端 guardedFetch + 正则 meta/粗取正文；快照以扩展 `chrome.pageCapture.captureMHTML` 为主通道
- 向量：content_cache.embedding（JSON）+ 内存余弦 + k-means-lite 聚类，无外部向量库

## 仓库结构（实际）

```
apps/extension   # WXT 扩展，6 个 entrypoint：background / popup（单面 D46）/ newtab /
                 #   options（原生 DOM）/ welcome（4 步引导）/ viewer（快照查看器）
                 #   无 sidepanel（D42 删）、从未有 offscreen
apps/server      # Hono API + 静态托管管理台 + 公开导航站 /s/:slug 渲染（云端/自建同代码，env 区分）
apps/web         # Web 管理台（React + shadcn/ui；?mock 演示模式在 src/lib/mock.ts）
apps/e2e         # Playwright（加载未打包扩展 + 真服务端）
packages/shared  # 领域模型、zod schema、URL 规范化 v2、分类/隐私/敏感词/站点信号引擎、netscape、widgets
                 #   黄历走子路径 @mf/shared/almanac（不进服务端 bundle）
packages/ai      # providers.json + OpenAI 兼容 llm-client（审核错误识别）
docker/          # Dockerfile（dev/prod 多目标）、compose.dev.yml、compose.full.yml、llm-mock.mjs
```

不存在 `packages/ui`；三端无共享组件包（扩展内 BrandHeader 不发包）。

## 常用命令

```bash
pnpm install                     # 安装
pnpm dev                         # turbo 全量 dev
docker compose -f docker/docker-compose.dev.yml up   # 服务端必须跑在 Docker 里
docker compose -f docker/docker-compose.dev.yml --profile multi-instance up -d   # 可选第二实例 :3100（完全同形态，仅地址/数据卷不同）
pnpm --filter @mf/extension dev  # 扩展 WXT HMR（连接 http://localhost:3000）
pnpm --filter @mf/web build      # 改 web 必须重新构建（服务端从 web-dist 托管）
pnpm seed                        # 生成边界情况书签集
pnpm test                        # 单元 + 集成
pnpm --filter @mf/e2e test       # Playwright E2E（改扩展后先重新构建）
docker build --target prod -t my-favorites:ci -f docker/Dockerfile .   # 生产冒烟（<300MB / ≤250MB）
```

改 server 代码需 `docker restart my-favorites-server`（tsx watch 对 bind mount 失效，此为已知环境陷阱）。

## 硬性红线（违反=PR 不通过）

1. **NAS 资源红线**：自建容器运行内存 <300MB、镜像 ≤250MB（node:22-alpine 基线约 235MB，约束为"bundle 级增量，禁止整包 node_modules 进运行层"；server 以 esbuild bundle 交付）；SQLite 单文件；必须支持 ARM64
2. **隐私不可绕过**：隐私域名校验在 `packages/shared` 引擎内部执行（五动作：读正文/上传/调模型/服务端抓取/快照），设备端策略未加载时保守拒绝；任何抓取/AI 调用前强制校验，不是可选步骤
3. **用户数据安全**：删除类操作永不自动执行（AI 只出建议清单）；AI/自动整理采用「直接生效 + 可撤销」（D27），AI 产生的所有移动必须写入 `organize_version` 且撤销入口可达（手工拖拽/逐条 PATCH 是用户直接操作，不写版本——产品.md §10⑫ 已登记此差异）
4. **版权红线**：公开导航站永不展示快照内容，仅站点级元数据+摘要（且仅限 D23 显式发布集合；D30 文章/详情页不进公开投影）
5. **导入不进收纳盒**：`ingest` 直接落映射目录，走两阶段整理；收纳盒只接"以后随手丢"的增量

## 管理台 UI 设计规范（2026-11-18 定稿 · D39 修订主色，违反=返工重做）

1. **视觉基调 = shadcn 结构 + 品牌靛蓝主色**（D39，母版 `assets/brand/`）：zinc 中性色不动；主色 = 中靛蓝 `#4F46E5`（主按钮/激活页签/选中态），hover 加深 `#4338CA`，焦点环靛蓝；彩色只做两类用途——品牌主色 + 语义标注：失效=红 / 疑似=琥珀 / 正常=绿的小圆点与徽章。品牌色板其余三色（#C7D2FE/#1F2937/#F4F6F9）只用于品牌物料不进控制台；不做品牌渐变、不做彩色头像块、不自创配色
2. **布局**：顶部轻导航（logo 一行、导航页签第二行）+ 居中窄栏 `max-w-[920px]` 随页面自然滚动。禁止全屏侧栏壳、悬浮窗、点阵画布、框中框、页面级内部滚动条（固定高度区可用 `.scroll-slim` 细滚动条）。**页签标题统一口径**：h2 = 页签同款 lucide 图标（size-4）+ `text-lg font-bold`，副标题 `text-[13px]`——与导航站基准一致（PageHeader 用 icon 参数），不得出现无图标/text-xl/串号图标
3. **禁边框分层**：层次靠 shadow 与 `bg-muted` 浅底圆角条；边框仅限功能必需件（输入框 / Sheet·Dialog 浮层 / 上传虚线框 / 模板选择这类选择器）
4. **表格与列表（强制）**：所有数据表格与行式数据列表必须具备整行 hover / focus-within 浅底高亮（复用 `.data-row`，真实 table 数据行有全局兜底），不得遗漏只读行；高亮不代表整行可点击，无动作不加 pointer。**行内及分页按钮统一小号 `size="xs"`（h-7、text-xs，图标约 14px），图标按钮也不得超过 28px；顶部工具栏/弹窗按钮保持原尺寸**，形成层级辨识。分割线必须是独立元素（不挂在圆角行 border 上，与圆角解耦）；行内信息位 ≤4 个
5. **页面结构**：高频路径默认露出；低频/高级操作折叠或收进弹窗/页内栏；设置二级页用 hash 路由 `#settings/<sub>`；说明文案压成一行；主操作按钮无改动时置灰显示「已保存」类状态。注意：**版本历史是书签库右栏互斥面板（不是 hash 二级页）**，导航站发布设置是页内三栏（不是二级页）
6. **首页哲学**：产品自动替用户处理，不给用户派任务——首页=问候 + 自动化承诺条 + 已完成的自动动态（可撤销）+ 内容浏览 + 安静事实行；禁止待办清单（「今日建议」形态已被否）
7. **整理 = 功能点行式列表**（点了就跑，结果区/弹窗化），不做聊天框（D42）；撤销 = 逆放 diff 生成新版本，版本历史面板是唯一安全面
8. **能力模块（现状注意落差）**：注册表 `apps/web/src/lib/modules.ts` 当前只有 **navsite / ai 两个可关开关**（localStorage，core 不可关；收纳盒与整理已并入 core）；仅 navsite 真正门控页签，ai 开关暂无行为门控，**服务端路由不感知模块、无条件全挂载**——「服务端按模块挂路由/定时任务随模块启停」是未完成的模块化切片，勿当成现状写代码或文档
9. **带前缀的显示名走唯一归一函数**：收纳盒显示名必须经 `inboxLabel()`（剥前导 emoji 再补恰好一个，兼容数据层自带「📥 收纳盒」的 D36 命名）——禁止手拼 `📥 ${name}`；回归锁 `apps/e2e/tests/inbox-label.spec.ts`（真实库断言恰一个图标）
10. **迭代方式**：改 `apps/web` 代码 → `?mock` 演示模式（`lib/mock.ts` 网络层拦截）→ 浏览器逐页截图自检（标准：像 shadcn 官方 demo 一样干净）→ 交付；不再走原型评审

## 异步与性能规范（2026-11-21 定稿 · D62，违反=返工）
### 管理表格补充规范（强制）

- 所有管理功能的数据表格及行式数据列表必须支持**页码分页**：统一复用 `NumberedPagination`，显示总条数、当前页/总页数、上一页、可点击页码、下一页；当前页品牌色高亮，大量页码采用首尾 + 当前页窗口 + 省略号，不得只给上下页或以无限滚动/加载更多替代。
- 默认每页 10 条；操作日志等密集只读数据可 25 条。筛选条件变化回第一页，增删后校准合法页码；边界禁用翻页，加载中禁重复请求，页码按钮带 `aria-current="page"`。新功能与改动到的旧管理列表必须遵守，存量未统一的列表应在后续改动时迁移，不得声称已全量改造。
- 所有数据行必须整行悬停/键盘焦点高亮；行内按钮及分页按钮（上一页/页码/下一页）统一用 `size="xs"`（28px、text-xs），顶部/弹窗操作保持原尺寸，独立分割线不与圆角行耦合。


1. **判据一句话**：某任务慢了或失败了，用户当次操作的目的是否仍达成？仍达成=非核心（装饰：图标/封面；增强：摘要/向量化；后台：探测/清扫/回填），不达成=核心（列表/详情/编辑/收藏落库/同步收敛/鉴权）。非核心任务**不得阻塞核心路径**
2. **非核心任务三件套，缺一即返工**：① 异步——不 await 在核心请求路径里，触发即返回（进度可查或结果可迟到）；② 限流——全局并发闸（前端参照 `lib/favicon.ts` 信号量 ≤2，服务端出站抓取同理），禁止「每行一发」无上限并发——HTTP/1.1 每源仅 6 连接，装饰洪水会饿死数据请求（D60 真凶）；③ 失败可观测——禁止静默 catch（D40/D57 教训），失败原因落库（fail_reason/负缓存/状态表）或挂兜底定时器，自动类动作保留可撤销
3. **豁免**：用户显式发起且有进度反馈的长任务（AI 整理、死链探测）允许同步等待，但必须可中止（参照 `/maintenance/links/run/stream` SSE 进度流模式，断开即停）
4. **出站抓取必带整体预算**：多候选串行链（favicon.ico→首页→link）必须设单次解析总 deadline（参照 D60 favicon 12s），不允许多个 15s 级超时无上限串联；一律 guardedFetch + 隐私判定前置（红线②不因异步豁免）
5. **排障顺序**：用户报「XX 慢」先看 `docker logs my-favorites-server` 每请求耗时分布（Hono logger 自带 ms）——服务端快而体感慢 = 查浏览器侧连接占用/渲染，别优化错层

## 提交与版本

- Conventional Commits 强约束（D90：type/scope 受控、标题 ≤72、破坏性改动写 BREAKING CHANGE），本地 husky 与 CI 双层校验
- **提交信息规范（D90，细则 [`docs/开发规范/提交与发版规范.md`](docs/开发规范/提交与发版规范.md)，违反=返工）**：
  - 标题 `type(scope): 摘要`：type 取 11 种受控值（feat/fix/refactor/perf/test/docs/build/ci/chore/revert/style）、scope 取 12 个受控值（server/extension/web/shared/ai/e2e/docs/ci/docker/deps/release/repo，可省略）；摘要写结果与动机、≤72 字符（含前缀）、不加句号、D 编号放尾部
  - 正文三段（动机 / 关键实现 2–5 条 / 验证与影响）；破坏性改动必须写 `BREAKING CHANGE:` 页脚（DB 迁移、API·配置不兼容、扩展权限变更）
  - 一个提交一件事：跨端功能按端拆 2–3 条（同一 D 编号），禁止「功能 + 全仓格式化 + 依赖升级 + 文档」混提，禁止跨切片大合流（无法单独 revert、对不上 changeset）
  - 门禁：本地 `husky commit-msg` 拦格式；CI 全范围校验（PR 比 `merge-base origin/<base>`，push 比 `before..after`，多提交一并查）
- **changeset（`@changesets/cli`，版本与 CHANGELOG 单一来源）**：
  - 功能合入随提交附 changeset：`pnpm changeset` 选包与升级级别、写变更说明，生成 `.changeset/*.md` 一并提交；`.changeset/config.json` 与 md 必须入库（发版输入，不是本地产物）
  - CI 门禁 `pnpm check:changeset`（`scripts/check-changeset.mjs`）：PR 触达 `apps/*/src`、`apps/extension/entrypoints`、`packages/*/src`、包清单或 `docker/` 时必须新增 changeset；纯文档/测试/CI 改动放行。发版 PR 用提交信息 `[skip changeset]` 声明
  - 发版：`pnpm run version`（消费全部 md，升 `package.json` 版本并生成各包 `CHANGELOG.md`）→ 提交 → 按规范打 tag `<app>-vX.Y.Z`（CI 监听 `server-v*` / `extension-v*` / `web-v*`）
  - 服务端版本号单一来源 = `apps/server/package.json`（`src/version.ts` 构建期内联，`MF_VERSION` env 可覆盖）；`@mf/e2e` 不参与发版（config `ignore`）
- DB 迁移只前进不回滚（`apps/server/src/migrate.ts`，当前 v16）；自建端仅在有待应用迁移前自动 VACUUM 备份（无定时备份）
- **功能变更必须回写活文档**：改 `docs/产品.md` / `docs/技术方案.md`（不再递增文档版本号）；新决策追加 `docs/决策记录.md` 下一编号；半成品标 🚧 并登记进产品.md「已知实现差异」一节（D48）

## 本地测试（Docker 优先）

服务端一律在本地 Docker 运行（开发环境即自建端形态）。LLM 三档切换只改 `LLM_BASE_URL`：`llm-mock`（默认，CI 稳定）→ 本机 Ollama → 真实端点。测试四层：shared/ai 单测 / server API 集成（vitest）/ Playwright E2E（加载未打包扩展）/ 镜像冒烟。走查以「真实数据 + 真机/浏览器截图」为准——静默 catch 曾让 /bookmarks/top 与 popup suggest 两处功能长期失效（D40、产品.md §10①）。

## 当前进度（详细来龙去脉见 docs/决策记录.md）

- [x] 已交付基线：导入双通道、收纳盒两阶段流水线、整理 act+undo 与版本内核、导航站（4 模板/显式发布集合/密码）、管理台四页签+设置八分区、迁移 v1–v8 与迁移前备份、Docker 冒烟、AGPL-3.0、GitHub 远端（easeyeah/my-favorites）
- [x] 安全可信基础（D14–D25）：隐私五动作引擎、SSRF 出站守卫、令牌摘要/首启 setup/限速、BYOK Key 加密、保守 URL 键、统一事务内核、可见性边界
- [x] 原型评审与品牌（D26–D39）：管理台重写、品牌靛蓝、功能点化整理、树形书签管理、单站点导航站、?mock 演示模式
- [x] 原型驱动补齐与后续修订（D29–D45）：onboarding 四步、右键三菜单+快捷键+页内轻提示、收纳盒状态机、D33 出站 Hook、快照查看器、整理偏好；D40 新标签页极简（废弃三档）；D41 页脚小组件（IP/天气/黄历，出厂全关）；D42 AI 聊天下线；D43 敏感内容旁路；D44 受控镜像删除；D45 浏览器重排
- [x] 2026-11-20：D46 popup 单面化（取消 ptabs，歧义条目内内联）、D47 原始 favicon 抓取端点、扩展透明底图标、**D48 文档治理（活文档+归档，本文档同步重写）**
- [x] **收藏夹双向直接同步（D49，2026-11-20）**：用户「太复杂没法用」→ D44/D45 补丁形态收敛为单一总开关「与浏览器收藏夹同步」（默认关）；开启即全量对齐 + 10min/事件双向收敛（增删改移序全同步、冲突后发生效、/sync/apply 幂等落库带发起设备防回环、基线快照即合并点）+ 大规模删除保险丝；退役四入口（导入/反向同步/重排/同步删除开关），manifest 补 alarms 权限。server 161（新增 6）+ E2E 22（新增双向同步全链路，揪出 alarms 权限缺失与 UI 覆写竞态并修）
- [x] **动作即同步（D50，2026-11-20）**：用户「有动作就触发，没人等 10 分钟」——服务端 ChangeHub + /events/stream SSE 门铃（只推『有事发生』、1s 合并、20s 心跳）+ Store.onRecorded 钩子；扩展 fetch 流式消费 3s 防抖触发 tick，兜底告警 10min→1min、书签事件防抖 45s→8s；任一侧动作秒级收敛。server 164（+3）+ E2E 23 过 1 跳（新增零手动收敛真机用例 9.6s）+ 真实服务端冒烟 1.5s
- [x] **收纳盒同步豁免与重复壳自愈（D51，2026-11-21）**：用户实机 3 个重复「📥 收纳盒」——D49 引擎读侧跳过收纳盒子树但写侧（放置）没豁免，每轮新建同名壳。修复：inboxFolderId 全链路豁免 + mergeDuplicateInboxFolders 存量自愈（align/tick 自动跑）；E2E 24 过 1 跳（新增回归）
- [x] **书签编辑补全 + 行右键菜单（D52，2026-11-21）**：PATCH 补 url（canonical 重算/撞库 409/正文缓存作废/进日志）+ description；同步引擎库侧改 URL 浏览器节点跟随；管理台详情内联编辑表单（标题/URL/备注）+ 列表行右键菜单（七项动作全复用）；原生收藏夹右键平台不可定制已实锤并写入约束。server 167(+3) + E2E 25(+1)
- [x] **同步基线竞态修复（D53，2026-11-21）**：用户「浏览器删了库没删」——tick 结尾重扫覆盖基线吞掉运行窗口期的删除；改基线为增量维护（引擎动作登记 base）+ treesDiffer catch-up 补轮，align 同修；E2E 新增零手动删除收敛用例（5.5s）
- [x] **收纳盒归位去向可见（D54，2026-11-21）**：用户「不知道 AI 把书签分到哪」——归位历史一直在记但 web 从不消费：placed JOIN folders 带 folder_name；popup 归位行显示 →「目录」；web 收纳盒视图新增「最近自动归位」区（去向+理由+时间+撤销直达版本历史）；附带修正 D53 基线语义（本轮成功推送并入基线，防「新增→删除」序列丢删除）。server 167 + E2E 26 过 1 跳 + ?mock 自检
- [x] **虚拟顶层穿透修复（D55，2026-11-21）**：用户书签栏凭空多出重复目录——walkBrowser 把 Edge 第一层虚拟节点（收藏夹栏/链接）当真实文件夹入路径，双侧建「收藏夹栏/xxx」重复树（库侧 81 目录，已拆除合并、书签零丢失）。shared 固化虚拟名集合（仅第一层判定），walk 第一层无条件穿透，prune 清虚拟名空壳；E2E 双侧断言禁现虚拟根目录（headless 树结构与真实浏览器不同是盲区根源）
- [x] **浏览器删目录同步（D56，2026-11-21）**：用户「删了目录管理台没同步」——真机复现定位嵌套目录父残留（仅空目录可删+父→子顺序）与保险丝误伤目录级删除。新增 store.deleteFolderTree 子优先树删 + /sync/apply folder.deleteTree；引擎对最顶层被删目录发树删、目录级独立保险丝、基线剪枝。E2E 小/嵌套/大目录 3 例 + 服务端 3 例；E2E 30 过 1 跳、server 170
- [x] **收纳盒自动分类兜底（D57，2026-11-21）**：用户「丢进收纳盒不自动分类」——分类逻辑正常，真缺陷是即时 flush 静默失败且无兜底（UI 承诺的每小时清扫不存在）。新增独立 mf-inbox-sweep alarm（1min）+ maybeSweepInbox（/inbox/count 门控）+ 启动补扫；popup 文案改「丢入即触发，最迟 1 分钟兜底」。E2E 即时 2s + 兜底 alarm 分类卡 pending 条目 1min 双路径；E2E 32 过 1 跳、server 170
- [x] **操作审计日志（D58，2026-11-21）**：用户「用户操作是否有日志跟踪」——变更有账（changes/organize_version/inbox_state）但认证安全事件零持久化（登录失败/限速只在内存滑窗）、配置变更无痕迹、三张增长表只增不减。迁移 v9 audit_log（认证三态/setup/令牌撤销/供应商·偏好·Webhook/发布下线；红线=绝不落密码与令牌）+ GET /audit + 设置页「操作日志」只读分区（9 分区）+ startRetentionPrune 保留裁剪（changes 14d/events 90d/idempotency 7d/audit 1000 条，常驻不依赖调度开关）。server 177(+7)；changes 表是同步游标不是审计，两种需求不可混用
- [x] **收纳盒视图工具栏定制（D59，2026-11-21）**：用户「进入收纳盒时把右上角标签改成那段说明，收纳盒没有失效/重复这些功能」——全部/失效/重复/已归档 chips 对收纳盒语义不成立（盒内只有待归位增量、只移动不删除）。改（apps/web library.tsx，纯前端零 API）：inboxView 时右上角筛选组整组替换为「说明 + AI 归位」操作区，列表上方独立说明块移除，selectFolder 进收纳盒时重置 statusFilter 防残留态无处取消。原则：**控件只在语义成立的上下文出现**。?mock 双视图自检 + inbox-label E2E
- [x] **favicon 回填并发闸（D60，2026-11-21）**：用户「管理台切换目录加载书签很慢」——服务端列表 0–22ms 无辜，真凶=缺图书签（1817/2119）每行挂载即发 /favicon（单个 2–23s），HTTP/1.1 每源 6 连接被图标洪水占满，下次切目录的 /bookmarks 在浏览器排队数秒。修：web lib/favicon.ts 全局并发闸 ≤2 在途（装饰资源涓流）+ server resolveFavicon 整体 12s 预算（原串行候选链最坏 ~90s）。教训：**每行一发的回填模式必须过并发闸，否则饿死数据请求**。Playwright 真服务端实测切目录 36ms + server 177 全绿
- [x] **资料库（D61，2026-11-21）**：用户调研语雀/Notion/flomo 等 API 后拍板「资料沉淀本体自建，笔记应用降级为导出适配器」——shared classifyMaterialKind 三级识别（文章仅已存全文≥200 字显性化/视频仅元数据不下载本体/图片主图落盘）+ 迁移 v10 material（bookmark_id UNIQUE 覆盖式 upsert，正文摘要引用 content_cache 不复制）+ og:image 扩展捕获封面（server_fetch 隐私判定前置，落 DATA_DIR/materials/）+ 管理台第五页签「资料」卡片流（类型筛选/全文检索/详情阅读/导出 Markdown/移出=软删不复活书签不动）+ 启动一次性存量回灌（纯本地零网络）。隐私域/私密/回环（127.0.0.1 属内置隐私域）永不入库——测试注 coverFetcher 缝不放宽红线。语义：入库是内容识别非书签移动，不写 organize_version。shared 96/server 187(+10)/E2E 36 过 1 跳(+3) + ?mock 自检
- [x] **异步与性能规范（D62，2026-11-21）**：四条规范定稿入上文专节（核心路径同步直返；非核心任务异步+并发闸+失败可观测三件套；出站串行链整体 deadline；隐私/Guard 不因异步豁免）——该节此前误标 D61，编号让位资料库后补登决策记录
- [x] **capture 摘要兜底补扫（D63，2026-11-21）**：修正 D62 盘点误判——async 模式 maybeSummarize 本就 `void run()` 不阻塞收藏响应，真缺口=无兜底（fire-and-forget 遇重启永久丢失、llm_unavailable 永不重试、call_model 拒绝不留痕）。修：bookmarksMissingSummary + backfillSummaries（≤5 条涓流、无 LLM 零开销）+ startSummaryBackfill 常驻（启动+30min，仿 D58 不挂可选开关）+ 隐私拒绝落 privacy_call_model_denied。教训：**「await 了内部 void run 的函数」≠阻塞，判读阻塞先看被调方当前模式是否同步执行**。server 192(+5) 全绿 + 真实容器端到端（抹 L1→重启→kicked 1→DeepSeek 找回）
- [x] **资料库消费面重定位（D64，2026-11-21）**：用户拍板「资料页列表即可不做阅读效果、分类标签一定要做好、最终价值是经 MCP 供 AI 工具调用」。三件：① 资料页行式列表（砍卡片流/阅读浮层/封面流），行 = 标题+已存全文+📸 / 分类标签行（目录徽章主色语义 + AI 标签 ≤5）+ 行内操作；类型 chips 带计数。② **MCP 端点 `POST /api/v1/mcp`**（Streamable HTTP JSON 模式，JSON-RPC initialize/notifications/tools.list/tools.call，无状态；三工具 materials_search 摘要级 / materials_get 含全文 / materials_recent 带计数；鉴权随 /api/v1 bearer）——AI 客户端（Claude/Cursor 自定义连接器）配地址+令牌即用。③ listMaterials 增 tag/folderId（逗号分隔子树 IN）筛选。后续增强：**左侧双维度分面面板**——「分类」树（目录体系、子树聚合计数、无资料分支剪枝）+「AI 标签」频次榜（json_each 展开 l1_tags），点选即筛选、四维正交叠加；GET /materials/facets 分面统计（json_valid 防御坏 JSON）。教训：**AI 是一等消费者时，元数据完备+行式列表优先于阅读体验；分类的「厉害感」靠目录+AI 标签两层外显；标签无层级不造假树——树给真层级的目录维度，频次榜给平铺的标签维度**。server 200(+8)/E2E 36 过 1 跳 + 真库端到端（全文 4552 字返回）+ 截图自检
- [x] **资料库自有 AI 分类体系（D65，2026-11-21）**：用户「不用书签的分类，但可以参考书签的分类」——资料分类按内容语义自组织，不沿用浏览器目录；左树呈现方式参考书签库（层级缩进+计数+点选）。迁移 v11 material.category（两级路径随摘要同一次 LLM 调用产出，零额外成本）+ backfillCategories 涓流回灌存量（startCategoryBackfill 启动+30min，单条失败不阻塞缺失即下轮重进候选）+ 左栏「分类」树（两层聚合+未分类兜底）替代目录树 + 行徽章/MCP/导出全部换 category 维度 + category 子树筛选（一级前缀匹配）。设计判断：**书签目录服务于浏览器心智，资料分类按内容语义自组织——AI prompt 给推荐一级清单但允许自拟更贴切短语（自组织优于硬枚举）**。server 200(+1)/E2E 36 过 1 跳 + 真库回灌实测（DeepSeek 产出「技术开发/算法与数据结构」等）+ 截图自检
- [x] **资料页简化：只保留分类维度（D66，2026-11-21）**：用户「分类和标签放在一起还是感觉太复杂了，就保留分类吧」——左栏标签榜/行上标签徽章/标签筛选全部移除，UI 剩余维度 = 分类（AI 两级树）+ 类型 chips + 关键词检索；标签退回数据层（仍生成、仍进 MCP tag 参数与导出，供 AI 检索；生成端复用引导保留防爆炸）。教训：**维度给谁用要想清楚——标签对 AI 是检索面（MCP 参数），对人则是噪音源；双维度并存只该出现在 AI 侧**。server 200/E2E 36 过 1 跳 + 真库截图（左栏仅分类树）
- [x] **标签/分类确定性 emoji 图标（2026-11-21）**：用户「给标签加个图标视觉更好」——lib/tag-emoji.ts 关键词规则优先 + 稳定哈希兜底（同一标签恒定同一图标）；展示层职责不进数据（tags/category 原值与 MCP 消费不受影响）；应用位 = 左栏分类树/行上分类徽章
- [x] **MCP 介绍页迁移（2026-11-21）**：用户反馈资料页底部 MCP 提示行「太碍眼」——移入设置页新增「MCP 接入」分区（子导航项，端点复制/三工具说明/接入步骤/复制配置示例/隐私说明一行），资料页回归纯内容。教训：**功能提示不该占据浏览面——入口引导放设置分区，浏览面保持内容**
- [x] **收纳盒空态历史可见性修复（2026-11-21）**：用户「历史记录又看不到了」——D54「最近自动归位」区嵌在书签列表容器（items 三元 else 分支）内，盒清空（pending=0/placed=5）时整块随 EmptyState 消失。修：历史区提升为列表容器兄弟块 + 盒空文案语义化（「收纳盒是空的——增量已全部归位，记录见下方可撤销」）。教训：**功能块要审容器祖先的「列表非空」类隐性门槛；自动化功能清空输入态后要再走查一遍**
- [x] **管理台入口补齐（2026-11-21）**：用户反馈 options（书签配置页）无管理台入口。三处：options 连接分区「打开管理台」按钮 / popup「更多」折叠区链接 / welcome 第 4 步次级按钮，深链 `serverUrl/#overview`；options-ui E2E 补断言
- [x] **双服务形态：连接收敛插件 + 云端用户名账号（D67，2026-11-21）**：用户拍板「本地部署与云服务两种方式，连接配置应在插件设置页而非管理台」。三端分工重划——插件 options「服务」分区 = 连接与账号唯一入口（形态双卡 自建/官方云 + 状态行 + 自建地址/密码 + 云用户名/密码/注册）；管理台「连接与安全」退役 →「账号与安全」（改密码 + 令牌列表/撤销 UI 补齐 §10⑥ + 退出）；登录页按 healthz deployMode 自适应。服务端 `DEPLOY_MODE=self|cloud`：cloud = 用户名注册/登录（/auth/register + 双模式 login）+ /auth/password + /auth/me + healthz 上报；**多租户隔离 = 每用户独立 SQLite 文件**（DATA_DIR/users/<id>/）+ AsyncLocalStorage 上下文 + Store db 解析器（仓储层 SQL 零改写，自建恒主库行为不变）；registry.ts 集中跨用户共享面（users/令牌/部署级设置/认证审计/public_slugs）落主库，迁移 v12；SSE 按 user 过滤、后台任务逐用户库、/s/:slug 经 slug 索引路由属主库。教训：**「连接」是发起方（扩展）的配置，「身份与凭据」才是托管面（管理台）的配置；SQLite 多租户用文件边界优于全仓储加 owner 过滤**。server 208（200 回归零改动 + 8 云形态）/E2E 36 过 1 跳/真容器 cloud 端到端/?mock 与 options 双面板截图自检
- [x] **统一登录：自托管=官方云同一套账号（D68，2026-11-22）**：用户拍板「共用一个登录功能，唯一区别是服务器地址；自托管也支持多用户，不需要两套部署」。服务端：注册/用户名登录解除 cloud 门控（全部署开放，MF_REGISTER_OPEN 可关）；setup 门槛=生产+无管理员+无注册用户（注册即解除）；**owner 自动 provisioning**（旧单管理员部署启动时自动配 username=admin/旧管理员密码的账号，统一表单直接登录既有数据；只建一次不覆盖）；旧 {password} 无用户名登录保留兼容；owner 改密双写 users+admin_password_hash；dev 开放模式补「有令牌建上下文」中间件（曾漏=隔离失效）；healthz deployMode 恒 unified；DEPLOY_MODE 退役。客户端：web 登录页恒用户名表单（留空=旧密码兼容/演示模式），扩展 options 双面板合并统一账号表单。教训：**两套部署的本质成本是概念分叉渗进每层；兼容钥匙=旧路径保留+owner 身份绑定既有数据，而非迁移**。server 214 全绿/E2E 35 过 1 跳/真机 3000 admin 登录见 2116 条原数据+自托管注册隔离
- [x] **统一部署 + 系统管理（D73，2026-11-22）**：用户复盘后再次拍板「云服务与 NAS 没有功能区别，登录/部署都不要两套，最终差异只是自己部署或直接使用云服务」——推翻 D69 登录页分治，管理台恒为「服务端地址+用户名密码+按开关显示注册」单页；首个账号/既有 owner 为 admin，迁移 v13 users.role/disabled_at；管理员专属「系统管理」分区：开放注册持久化开关、添加用户、角色调整、停用/恢复（保留数据+撤令牌）、重置密码（撤全部令牌）、按用户完整 JSON 导出（不含任何凭据）；普通用户另有自己的 /export/user 完整导出。compose 第二实例改纯 multi-instance 副本，MF_FORM 不再改变 SSRF。新测试还揪出 dev 坏令牌降级 owner 越权并修复（无令牌才允许本机匿名）。server 227 全绿 + 完整 Playwright E2E 44 过 1 跳（含系统管理真浏览器：注册开关/添加/停用恢复/导出/普通用户无权；最终扩展与系统管理冒烟再 2 过）+ ?mock 与统一登录截图自检
- [x] **书签多选批量操作条顶替状态 chips（D74，2026-11-23）**：用户「多选后工具栏放到状态筛选的位置，列表不要往下挪；多选时状态筛选没有意义」——checked.size>0 时顶行筛选胶囊整组替换为批量操作胶囊（已选/全选本页/移动/归档/删除/取消），原列表上方那条移除；同日追加与搜索框同高 h-9、按钮 h-7（主操作尺寸跟表单控件走，只读 chips 维持小号），列表 y 不变；D59「控件只在语义成立的上下文出现」再实例。web typecheck/build + batch-toolbar E2E 位移断言 + edit-ui/inbox-label 回归 + 截图自检
- [x] **同步基线目录全量登记（D75，2026-11-23）**：用户「浏览器删了『开发』『视频』目录，管理台没同步」——『视频』已收敛，『开发』永久残留：根因=基线只增量登记引擎自建目录与书签，**对齐后用户新建目录 / resortFolder 补建目录从不入 base.folders**，删除 diff 看不见。修：tick 基线目录=旧基线∪开局 walk（保留旧项使保险丝/失败下轮续检出）+ resortFolder 带 base + 被删目录路径反查兜底 + **剪枝从推送时移到树删成功回执时**（失败不丢删除）+ noop 出基线免空重试。教训：增量基线必须覆盖检测依赖的全部实体类型；D56 三例都在对齐前建目录从未暴露此洞。新增 D75 E2E（回退核心修复验证确实红）+ 同步全组 8 过 + D73 目录删除回归 + typecheck/build 绿
- [x] **整理归类 prompt 补目录语义上下文（D76，2026-11-23）**：用户「Sill/Tomaco 是远程控制软件，分到在线工具合适吗」——不合适（原生远控客户端≠浏览器直开的 Web 应用）。根因=organize prompt 只给扁平目录名+标题/URL，LLM 凭名字字面猜语义。修：prompt 给「目录完整路径：代表书签」（folderSampleTitles 每目录置顶→新入库 3 条，排除归档，空目录标注）+ 归纳指引；category 契约不变（目录名=路径末段）。不硬编码分类规则（样本比规则新鲜，D65 同源）。数据侧用户拍板新建 E08 远程控制移入两条（写 organize_version 可撤销）。教训：LLM 消费用户目录体系要给「内容证据」非仅「名字标签」。organize-prompt-context 2 例 + server 229 全绿 + 真实 DeepSeek 端到端（RustDesk 探针→E08，700ms 自清理）
- [x] **分类自检（D77，2026-11-23）**：用户「有没有办法自动处理，而不是我拿着问题来找你」——D76 只管未来归位，已归位的错了仍要人发现。pipeline.reviewPlacement：摘要生成即复核（fire-and-forget）+ 常驻 patrol（启动+30min ≤10 条/轮，D63 模式）；资格=inbox_state placed（assign/PATCH 改目录/sync move 三处清状态→**手动意图神圣**）；目录样本+摘要/标签+当前目录为证据，仅现有目录且置信≥0.85 才移动（D27 直接生效+auto_review 版本可撤销+去向刷新 D54）；reviewed_at 一次性防振荡（迁移 v14），失败不标记下轮重试，私密不送模型，永不新建目录，无 LLM 零开销。零新 UI。教训：自动化闭环=处理+自检+去向可查+可撤销；自动的边界是用户意图。classification-review 11 例 + server 240 全绿 + 真实库首轮 patrol 复核 12 条存量零误移动（Sill/Tomaco 过期 reason 自愈）
- [x] **收纳盒入口双向收敛（D78，2026-11-23）**：用户「收纳盒浏览器和管理台依然不同步」——D51 豁免区三处缺口：pull 跳过移入盒（管理台入盒浏览器不跟随）、推送基线 diff 把入盒判删（**数据丢失洞**）、/inbox/map 把再投递的已归位条目弹回。修：convergeInboxEntries（tick+align，按库盒名单收敛节点进投递口，ensureInboxSlot 防重复壳，历史分叉自愈）+ 删除候选核验节点真消失 + /inbox/map 再投递=移回盒 pending 重分类（废弹回镜像）+ pending 清 reviewed_at。D51 语义更新：盒内条目不进普通目录但投递口必须可见。教训：读侧豁免必须配写侧收敛，豁免区没有收敛主人就是分叉区。D78 E2E + 同步/收纳盒全组 11 过 + server 241 绿
- [x] **同步全链路评审加固（D79，2026-11-23）**：用户「同步问题常发，代码还是架构问题？完整评估自主迭代」。写路径×收敛矩阵枚举 9 处缺口全修：P0 move 载荷 url 字段错致游标永久卡死（+逐条隔离可观测）/ 盒内删除僵尸复活（ifInbox 守卫取消）；P1 create 绑定忽略浏览器目录 / 重开 align 复活关闭期删除（先 tick 后 align）/ 多端改名建重复目录（fMap 反查）/ 收敛 limit=100 饥饿（分页）；P2 folderDeletes 误删同名（映射优先）/ D72 收敛 O(身份总数)→O(盒内)；回归揪出 ensurePath 悬空父根目录重复。架构结论：核心模型健全不重写，病灶=豁免区无收敛主人+三写者交接面+层间隐式契约；已知限制登记（reparent/同名/重复节点/14d 游标）；逃生门=关再开同步全量收敛。sync-hardening 4 例 + D79 E2E 2 例 + 受影响 spec 14 过 + server 245 绿
- [x] **安装引导导入通道归一（D88，2026-11-23）**：用户要求对 welcome 四步引导做全量评审与修订。评审揪出五类缺陷并全修：**① 目录层级全丢（P0）**——页内自抄展平按「path 是否为空」判虚拟根，而 path 在书签栏一层仍为 `[]`，逐层命中同一条件 ⇒ 所有书签 `folderPath` 恒为 `[]`（推荐通道导入后目录结构整体丢失，与「完整保留目录结构」文案矛盾）；改复用此前**无人引用的事实死代码** `lib/import.ts`（D55 只跳第一层虚拟根，第 2 层同名目录如「链接」保留）。**② 超限字段炸整批（P0）**——无截断时一条 >512 字符标题或 >16 层目录让该批 100 条整体 400；抽 `normalizeIngestItem`（200/256/16）+ `normalizeFolderPath`（剥文件通道自带「书签栏」虚拟根）。**③ addedAt 丢失**——`dateAdded` 与 Netscape `addedAt` 取得到却没上行；补透传（毫秒兼容秒级）。**④ 进度不可信**——`privacy` 死字段 + `skipped_invalid` 未计入 ⇒ 到不了 100%，「✅ 隐私筛查」首批返回前就打勾；改按 `imported+skipped+invalid` 计、状态行由 phase 驱动。**⑤ 失败无退路**——补「重试 / 返回上一步 / 打开扩展设置」，重试复用同批条目 + 同一幂等键（服务端回放已确认批次不重复导入）；零条空态留在第 1 步；整理失败如实说「书签已导入、整理未完成」+ 再试一次；第 3 步指标改 `organize.applied` 口径；第 4 步补 D49/D50 同步入口一行。验收：extension typecheck 绿 + 单测 56（新增 `import.test.ts` 9 例）/ 新增 `onboarding-import.spec.ts` **回退核心修复验证确实红（父目录不存在）→ 恢复后绿** / popup-import·import-fix 回归绿。教训：**同一件事有两份实现时，没人引用那份不腐化、被复制进页面的才会——先查现成实现再写；导入边界值必须客户端先截断，否则一条脏数据放大成整批失败；进度分母要覆盖服务端全部终态**。见决策记录 D88、技术方案 §8-3。复核补丁 R8（同日）：Aha 页不再被目录预览阻塞（D62）· 第 4 步跳转先开页再关页 · `source` state 化 · `busyRef` 同帧互斥 · 整理重试单飞且可见 · 未知 action 不再渲染空行

- [x] **书签目录右键管理 + 目录级重整理 + 内容页转资料 + 正常角标（D89，2026-11-24）**：用户四条需求（目录右键 / 目录内 AI 重整理 / 内容页自动转资料且**提取失败要建议丢弃** / **正常书签左上角角标更简洁**）。设计文档 `docs/功能设计文档/书签目录右键管理与内容转资料.md` 先落地，再按文档实现并 review。**A 目录右键**：沿用 D52 手写浮层（零新依赖），真实目录七项（打开/新建子目录/重命名/移动到…复用 D81 弹窗/AI 重新整理此目录/提取资料/删除目录…），收纳盒行仅「打开 / AI 归位」；删除全目录可删 + 二次确认（文案给出连带书签数，服务端仍 D73 树删）；开合计入 D82 blocked。**B 目录重整理** `POST /organize/folder`：`folderSubtreeIds` + `listBookmarks({folderIds})` 子树范围、**目标限定子树内**、AI 新目录经 `createFolder.parentFolderId` 挂在该目录下（apply 同父 find-or-create + 继承 parent.root），复用 session/apply/rollback 与 D76 上下文，版本可整批撤销；永不跨出子树/不删除。**C 内容转资料** `GET /materials/scan/stream`（SSE）：串行抓取 ≤1、逐条 item、断流即停、单次 30（1–60，done 回 remaining）；视频/图片直接物化，文章候选 `crawlOne({skipMaterialize:true})` 补抓后按批判定内容型页面（≤10 条/次，前 400 字；无 LLM 按 ≥800 字兜底），否 → not_content（书签不动）；**抓取失败 → done.failed → UI「建议丢弃」（默认全选，归档推荐 / 删除二次确认，永不自动删除）**；隐私/私密跳过且永不抓取。**D 正常角标**：移除行尾「正常」文字，favicon 左上角绿点；失效/疑似/已归档徽章不变。设计判断：目录级操作必须就地；抓取成功≠资料（否则工具页灌满资料库）；失败≠该删但值得被看见；状态噪音收敛到异常侧。验收：server 300 全绿（`dir-organize-scan.test.ts` 6 例）/ web typecheck+build / ?mock 截图走查（菜单/重整理/扫描进度与丢清单/删除确认/绿点）。**复核整改（同日 code review）**：P1 目录级 `ensureFolder`/apply 深层同名目录重复创建（改按子树任意深度复用现有目录）+ 补回归；P2 死 `sessionId`/`subtreeIds.includes` O(n²)/归档排除回归；P3 D83→D89 注释、`pathOf` 环守卫、扫描停止态文案与 remaining 估算、`moveFolderTo` 拦 mock error、SSE 抽 `lib/sse.ts` 共用、`folderIds` 截断 warn。整改后 server 302 全绿。见决策记录 D89、技术方案 §5.3/§5.4/§8-6h
- [ ] **资料库后手（D61 延伸）**：视频作者/时长元数据捕获；/crawl/run 补管理台入口或清理；笔记应用导出适配器（Notion 优先，Obsidian 目录落盘次之）
- [ ] **站点化信号与入口补齐**：L1 摘要补齐后投影重建抽检（三类准确率 ≥90%）+ 为已有后端补管理台 UI（当前 F4.7 后端完整但零入口）
- [ ] **模块化切片**：服务端按模块条件挂路由、定时任务随模块启停、AI 关闭时归位降级规则引擎
- [ ] **已知差异清理**：popup `/pipeline/suggest` 404 错配（建议最先修）、通知 card 档补 UI 或砍档、"周报"正名、清扫默认策略、令牌管理 UI、provider BaseURL 核实、/crawl/run 死端点清理（D62）——完整清单见产品.md §10
- [x] **同步架构评审整改三批次（D81，2026-11-23）**：用户提交《同步架构评审-v0.1》要求按评审优化迭代并对照验证。三批次全落地——**一（不漏不假成功）**：pull 失败事件持久重试队列（应用成功或已入队才推进游标）+ 保险丝挂起删除持久队列（确认后仍能执行）+ 浏览器写成功才更新基线 + SyncInfo 状态机 options 可见 + E2E 隔离（5 spec 切 fixture 3008/3009，不再污染真实库）；**二（补齐目标能力）**：迁移 v15 folder_identity + folders.root 根映射 + folder.create/move（空目录与 reparent 双向同步）+ PATCH /folders parentId + 管理台订阅 /events/stream 实时刷新（编辑守卫/?mock 短路）+ 目录树搬家 UI；**三（长期一致性）**：/sync/snapshot 读事务水位 + pull 带 minAvailableId/generation 四类过期判定 → reset_required → recover（先保留本地意图再按库重建，游标取开局水位）+ opId 回执幂等 + baseRevision 冲突返回现值 + 统一浏览器写入执行器 + 已同步设备停发镜像 ops（mirrorGuard 时间窗退役）+ bookmark.update url 语义（消灭孤儿与 align 复活）。P2：resortFolder 分页/非 http 节点 unbind 出基线。揪出 options sendMessage 带回调返回 undefined 致状态刷新读旧值（刷新移入回调）+ fixture 无 LLM 暴露 processInbox 早退跳过 D70 资料分流既有 bug（buildScanJobs 两路径共用）。server 259（+14）/E2E folder-structure-sync 3 例（目录结构矩阵/保险丝闭环/changes 清空故障注入恢复）+ 隔离 5 spec 回归。详见技术方案 §6/§6d、决策记录 D81。**复核整改（对照《同步整改复核清单-D81》R01–R07，不新增编号）**：7 项缺口修复——推送改持久出站队列（lib/sync-plan.ts 契约：opId 终身不变、发送前落盘、成功/终态才出队、失败复用原 opId）；书签基线仅成功回执后推进、目录以每轮 /folders 派生库态（含 rev）为确认依据；绑定既有书签以移动后最终记录为准、目标目录身份优先；moveFolder 父与根同一移动+跨根更新子树 root（v16 folders.rev）；回执带实体+修订、createBookmark 载荷带 content_revision、改标题+移目录合并提交、baseRevision 固定绑定生成时+修订单调；recover 全量保留本地意图、失败不清队列；setFavoritesSync 有基线只 tick 不再二次 fresh（避免清空未决出站操作）；tick/recover 共用删除计划+保险丝。另修故障注入代理 content-length/keep-alive、options 开启文案。验收：服务端 269/扩展契约 23/E2E 复核 7 全绿，修复前对照服务端 10/10、E2E 6/7 确实失败。详见复核清单 §4 交付记录
- [x] **管理台书签实时更新（D82，2026-11-23）**：用户提交《管理台书签实时更新》设计文档（docs/功能设计文档/，已交付）要求按文档开发并自主 review 迭代。D81 SSE 裸链路之上补齐完整交互与恢复闭环，三层守卫——**调度层** `lib/live-refresh.ts` useLiveRefresh：dirty 代数（请求前消费、期间新通知必补轮）+ 在途单批 + 阻塞补轮（编辑/弹窗/右键菜单保留 dirty、关闭即刷）+ 防抖 300ms/最大等待 1s + 前台/网络恢复校准 + 断线 30s 兜底 + 失败退避重试与安静提示；**连接层** events.ts：首连/重连均补刷 + useStreamStatus 可观测 + 401/403 退避 30s + ?mock 模拟门铃（mf:mock-change + __mfMockSimulate）；**页面层** library.tsx：后台无闪烁刷新（保留旧列表与多页窗口、单页上限 1000 顺序分页）+ 目录被删回退最近存活祖先（联合视图剔除失效目录）+ 搜索/失效/重复/联合各自校准 + 竞态双闸 epoch/abort 与 listGen（追加加载代数失效重取 ≤3 轮）+ 编辑草稿保护（外部删除禁保存可复制/外部修改显式覆盖确认，**存在性校验独立订阅不受阻塞**）+ 多选清理 + 滚动锚点 + closeDetail 统一清理编辑态。实测服务端提交→呈现 0.6–1.2s（P95≤2s）、4 连增合并 1 次列表请求。E2E live-refresh.spec 5 例 + edit-ui/batch-toolbar/inbox-label/materials 回归共 11 全绿 + ?mock 四场景自检。review 揪出 6 处自主修复（联合回退优先级/联合失效分支/冲突检查困在阻塞批次/同视图竞态/追加静默丢弃/editing 残留永久阻塞）。详见技术方案 §8 6e、决策记录 D82

## 技术核对遗留项

- providers.json：**MiniMax / 小米 MiMo / 腾讯 TokenHub 的 baseUrl 当前为 null（TODO_VERIFY）**，添加时不预填——2026-11-18 曾核实填入、后又退回待核实，以文件为准；腾讯疑似订阅型网关倾向移出；Anthropic 预设 apiStyle=anthropic 但 llm-client 对话未适配其协议（拉模型列表已兼容），选用前需补适配
- captureMHTML 兼容性探针清单（`docs/归档/开发工作/A4-3-pageCapture探针.md`，真实 Chrome/Edge 矩阵回填；E2E 探针 RUN_REAL_PROBE=1）
- 浏览器平台约束（写扩展必须遵守）：书签栏文件夹原生下拉不可定制、文件夹无角标 API——收纳盒文件夹只做投递口，管理入口 = 工具栏图标角标 → popup；contextMenus 支持 page/link 右键但不支持 bookmark 树右键（书签的自定义右键只能在管理台页面内做，D52 行右键菜单即此定位）
