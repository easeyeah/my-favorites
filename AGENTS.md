# AGENTS.md — my-favorites 项目规范（AI 会话必读）

> AI 辅助开发项目。任何接手本仓库的 AI 会话先读完本文件再动手。
> 文档入口：[docs/README.md](docs/README.md)。权威现状文档：[`docs/产品.md`](docs/产品.md)（功能与状态）、[`docs/技术方案.md`](docs/技术方案.md)（架构/API/数据模型）、[`docs/决策记录.md`](docs/决策记录.md)（D1–D64，只追加）。
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
2. **布局**：顶部轻导航（logo 一行、导航页签第二行）+ 居中窄栏 `max-w-[920px]` 随页面自然滚动。禁止全屏侧栏壳、悬浮窗、点阵画布、框中框、页面级内部滚动条（固定高度区可用 `.scroll-slim` 细滚动条）
3. **禁边框分层**：层次靠 shadow 与 `bg-muted` 浅底圆角条；边框仅限功能必需件（输入框 / Sheet·Dialog 浮层 / 上传虚线框 / 模板选择这类选择器）
4. **列表**：行式排版（divide 分隔），行 hover 高亮可用圆角，但**分割线必须是独立元素**（不挂在行 border 上，与圆角解耦）；行内信息位 ≤4 个
5. **页面结构**：高频路径默认露出；低频/高级操作折叠或收进弹窗/页内栏；设置二级页用 hash 路由 `#settings/<sub>`；说明文案压成一行；主操作按钮无改动时置灰显示「已保存」类状态。注意：**版本历史是书签库右栏互斥面板（不是 hash 二级页）**，导航站发布设置是页内三栏（不是二级页）
6. **首页哲学**：产品自动替用户处理，不给用户派任务——首页=问候 + 自动化承诺条 + 已完成的自动动态（可撤销）+ 内容浏览 + 安静事实行；禁止待办清单（「今日建议」形态已被否）
7. **整理 = 功能点行式列表**（点了就跑，结果区/弹窗化），不做聊天框（D42）；撤销 = 逆放 diff 生成新版本，版本历史面板是唯一安全面
8. **能力模块（现状注意落差）**：注册表 `apps/web/src/lib/modules.ts` 当前只有 **navsite / ai 两个可关开关**（localStorage，core 不可关；收纳盒与整理已并入 core）；仅 navsite 真正门控页签，ai 开关暂无行为门控，**服务端路由不感知模块、无条件全挂载**——「服务端按模块挂路由/定时任务随模块启停」是未完成的模块化切片，勿当成现状写代码或文档
9. **带前缀的显示名走唯一归一函数**：收纳盒显示名必须经 `inboxLabel()`（剥前导 emoji 再补恰好一个，兼容数据层自带「📥 收纳盒」的 D36 命名）——禁止手拼 `📥 ${name}`；回归锁 `apps/e2e/tests/inbox-label.spec.ts`（真实库断言恰一个图标）
10. **迭代方式**：改 `apps/web` 代码 → `?mock` 演示模式（`lib/mock.ts` 网络层拦截）→ 浏览器逐页截图自检（标准：像 shadcn 官方 demo 一样干净）→ 交付；不再走原型评审

## 异步与性能规范（2026-11-21 定稿 · D62，违反=返工）

1. **判据一句话**：某任务慢了或失败了，用户当次操作的目的是否仍达成？仍达成=非核心（装饰：图标/封面；增强：摘要/向量化；后台：探测/清扫/回填），不达成=核心（列表/详情/编辑/收藏落库/同步收敛/鉴权）。非核心任务**不得阻塞核心路径**
2. **非核心任务三件套，缺一即返工**：① 异步——不 await 在核心请求路径里，触发即返回（进度可查或结果可迟到）；② 限流——全局并发闸（前端参照 `lib/favicon.ts` 信号量 ≤2，服务端出站抓取同理），禁止「每行一发」无上限并发——HTTP/1.1 每源仅 6 连接，装饰洪水会饿死数据请求（D60 真凶）；③ 失败可观测——禁止静默 catch（D40/D57 教训），失败原因落库（fail_reason/负缓存/状态表）或挂兜底定时器，自动类动作保留可撤销
3. **豁免**：用户显式发起且有进度反馈的长任务（AI 整理、死链探测）允许同步等待，但必须可中止（参照 `/maintenance/links/run/stream` SSE 进度流模式，断开即停）
4. **出站抓取必带整体预算**：多候选串行链（favicon.ico→首页→link）必须设单次解析总 deadline（参照 D60 favicon 12s），不允许多个 15s 级超时无上限串联；一律 guardedFetch + 隐私判定前置（红线②不因异步豁免）
5. **排障顺序**：用户报「XX 慢」先看 `docker logs my-favorites-server` 每请求耗时分布（Hono logger 自带 ms）——服务端快而体感慢 = 查浏览器侧连接占用/渲染，别优化错层

## 提交与版本

- Conventional Commits（`feat/fix/docs/chore/refactor/test/build`），CI commitlint 校验
- 功能合入随提交附 changeset；tag 格式 `<app>-vX.Y.Z`
- DB 迁移只前进不回滚（`apps/server/src/migrate.ts`，当前 v10）；自建端仅在有待应用迁移前自动 VACUUM 备份（无定时备份）
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
- [x] **收纳盒空态历史可见性修复（2026-11-21）**：用户「历史记录又看不到了」——D54「最近自动归位」区嵌在书签列表容器（items 三元 else 分支）内，盒清空（pending=0/placed=5）时整块随 EmptyState 消失。修：历史区提升为列表容器兄弟块 + 盒空文案语义化（「收纳盒是空的——增量已全部归位，记录见下方可撤销」）。教训：**功能块要审容器祖先的「列表非空」类隐性门槛；自动化功能清空输入态后要再走查一遍**
- [x] **管理台入口补齐（2026-11-21）**：用户反馈 options（书签配置页）无管理台入口。三处：options 连接分区「打开管理台」按钮 / popup「更多」折叠区链接 / welcome 第 4 步次级按钮，深链 `serverUrl/#overview`；options-ui E2E 补断言
- [ ] **资料库后手（D61 延伸）**：视频作者/时长元数据捕获；/crawl/run 补管理台入口或清理；笔记应用导出适配器（Notion 优先，Obsidian 目录落盘次之）
- [ ] **站点化信号与入口补齐**：L1 摘要补齐后投影重建抽检（三类准确率 ≥90%）+ 为已有后端补管理台 UI（当前 F4.7 后端完整但零入口）
- [ ] **模块化切片**：服务端按模块条件挂路由、定时任务随模块启停、AI 关闭时归位降级规则引擎
- [ ] **已知差异清理**：popup `/pipeline/suggest` 404 错配（建议最先修）、通知 card 档补 UI 或砍档、"周报"正名、清扫默认策略、令牌管理 UI、provider BaseURL 核实、/crawl/run 死端点清理（D62）——完整清单见产品.md §10

## 技术核对遗留项

- providers.json：**MiniMax / 小米 MiMo / 腾讯 TokenHub 的 baseUrl 当前为 null（TODO_VERIFY）**，添加时不预填——2026-11-18 曾核实填入、后又退回待核实，以文件为准；腾讯疑似订阅型网关倾向移出；Anthropic 预设 apiStyle=anthropic 但 llm-client 对话未适配其协议（拉模型列表已兼容），选用前需补适配
- captureMHTML 兼容性探针清单（`docs/归档/开发工作/A4-3-pageCapture探针.md`，真实 Chrome/Edge 矩阵回填；E2E 探针 RUN_REAL_PROBE=1）
- 浏览器平台约束（写扩展必须遵守）：书签栏文件夹原生下拉不可定制、文件夹无角标 API——收纳盒文件夹只做投递口，管理入口 = 工具栏图标角标 → popup；contextMenus 支持 page/link 右键但不支持 bookmark 树右键（书签的自定义右键只能在管理台页面内做，D52 行右键菜单即此定位）
