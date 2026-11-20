# AGENTS.md — my-favorites 项目规范（AI 会话必读）

> AI 辅助开发项目。任何接手本仓库的 AI 会话先读完本文件再动手。
> 权威文档：`docs/功能文档-v0.3.8.md`（产品）、`docs/技术方案设计-v0.3.md`（技术）。
> 原型：`docs/原型/`（index.html 为 17 屏总览，目录 extension/+web/ 分端存放）。**原型已冻结，仅作历史参考**——管理台界面规范以本文件「管理台 UI 设计规范」节为准，界面改动直接改 `apps/web` 代码并用 `?mock` 演示模式验收。

## 项目一句话

把失控的浏览器书签堆，用 AI 整理成一个每天使用的个人导航主页。三种形态：官方云 SaaS ≡ 自建 Docker（NAS）≡ 纯本地扩展。

## 技术栈（已定，勿更改选型，有异议先提出讨论）

- **TS 全栈 monorepo**：pnpm + turbo
- 扩展：Manifest V3 + WXT + React + shadcn/ui + Tailwind v4
- 服务端：Hono（Node）；自建 SQLite（node:sqlite 内置驱动）/ 云端 PostgreSQL；SQL 集中在仓储层 store.ts（ORM 后置评估）
- 任务队列：自建=SQLite 进程内队列，云端=pgboss，实现同一 `JobQueue` 接口，**不引入 Redis**
- LLM：`packages/ai` 统一出口，OpenAI 兼容协议 + 供应商注册表（`providers.json` 纯数据）
- DOM 解析：linkedom + @mozilla/readability；快照：扩展端 `chrome.pageCapture.captureMHTML` 为主通道

## 仓库结构（规划）

```
apps/extension   # WXT 扩展：popup / newtab / background / offscreen（D42 起无 sidepanel）
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
3. **用户数据安全**：删除类操作永不自动执行（AI 只出建议清单）；整理采用「直接生效 + 可撤销」（D27），所有移动必须写入 `organize_version` 且撤销入口可达
4. **版权红线**：公开导航站永不展示快照内容，仅站点级元数据+摘要（且仅限 D23 显式发布集合与 D30 站点投影范围）
5. **导入不进收纳盒**：`ingest` 直接落映射目录，走两阶段整理；收纳盒只接"以后随手丢"的增量

## 管理台 UI 设计规范（2026-11-18 定稿 · 2026-11-19 D39 修订主色，违反=返工重做）

1. **视觉基调 = shadcn 结构 + 品牌靛蓝主色**（D39，母版 `assets/brand/`）：zinc 中性色不动；主色 = 中靛蓝 `#4F46E5`（主按钮/激活页签/选中态），hover 加深 `#4338CA`，焦点环靛蓝；彩色只做两类用途——品牌主色 + 语义标注：失效=红 / 疑似=琥珀 / 正常=绿的小圆点与徽章。品牌色板其余三色（#C7D2FE/#1F2937/#F4F6F9）只用于品牌物料不进控制台；不做品牌渐变、不做彩色头像块、不自创配色
2. **布局**：顶部轻导航（logo 一行、导航页签第二行）+ 居中窄栏 `max-w-[920px]` 随页面自然滚动。禁止全屏侧栏壳、悬浮窗、点阵画布、框中框、页面级内部滚动条（聊天等固定高度区可用 `.scroll-slim` 细滚动条）
3. **禁边框分层**：层次靠 shadow 与 `bg-muted` 浅底圆角条；边框仅限功能必需件（输入框 / Sheet·Dialog 浮层 / 上传虚线框 / 模板选择这类选择器）
4. **列表**：行式排版（divide 分隔），行 hover 高亮可用圆角，但**分割线必须是独立元素**（不挂在行 border 上，与圆角解耦）；行内信息位 ≤4 个
5. **页面结构**：高频路径默认露出；低频/高级操作折叠（details）或收进弹窗与二级页（hash 路由 `#tab/sub`，如版本历史、发布设置）；说明文案压成一行；主操作按钮无改动时置灰显示「已保存」类状态
6. **首页哲学**：产品自动替用户处理，不给用户派任务——首页=问候 + 自动化承诺条 + 已完成的自动动态（可撤销）+ 内容浏览 + 安静事实行；禁止待办清单（「今日建议」形态已被否）
7. **整理 = 功能点行式列表**（点了就跑，结果/过程弹窗化），不做聊天框；版本历史是二级页（唯一安全面）
8. **能力模块**：`lib/modules.ts` 注册制——core 书签库（不可关）/ inbox 收纳盒 / tidy 整理（含失效检测与查重）/ navsite 导航站 / ai AI 接入；导航页签、设置分区、首页动态随开关显隐，禁用模块路由给引导页
9. **迭代方式**：改 `apps/web` 代码 → `?mock` 演示模式（`lib/mock.ts` 网络层拦截）→ 浏览器逐页截图自检（标准：像 shadcn 官方 demo 一样干净）→ 交付；不再走原型评审

## 提交与版本

- Conventional Commits（`feat/fix/docs/chore/refactor/test/build`），CI commitlint 校验
- 功能合入随提交附 changeset；tag 格式 `<app>-vX.Y.Z`
- DB 迁移只前进不回滚；自建端迁移前自动备份
- **功能变更必须同步回写 `docs/`** 并递增文档小版本；决策记录只追加不修改

## 本地测试（Docker 优先）

服务端一律在本地 Docker 运行（开发环境即自建端形态）。LLM 三档切换只改 `LLM_BASE_URL`：`llm-mock`（默认，CI 稳定）→ 本机 Ollama → 真实端点。测试四层：单元 / API 集成 / Playwright E2E（加载未打包扩展）/ 镜像冒烟。

## 当前进度

- [x] 产品文档 v0.3.2、技术方案 v0.3（2026-11-18 原型评审 D26–D36 回写；路线图已改「能力切片 · 持续交付」制，见功能文档 §10）
- [x] git 仓库 + GitHub 远端（easeyeah/my-favorites）
- [x] 已交付基线（原里程碑制产物，见 docs/开发报告-M1.md）：扩展五端、导入、收纳盒、聊天整理、导航站、管理台六页、迁移与备份
- [x] 原型评审完成：docs/原型/ 17 屏 + 15 张 Mermaid 图；决策 D26–D36 全部回写
- [x] 测试：74 单元/集成 + 14 Playwright E2E 全过；Docker 冒烟通过
- [x] License：AGPL-3.0（官方全文已入库）
- [x] 管理台界面重写（2026-11-18）：能力模块开关（core/收纳盒/整理/导航站/AI）、整理功能点化（吸收体检）+ 版本历史二级页、树形书签管理器（行内增改删目录 + 拖拽归位，服务端补目录重命名/删空目录端点，128 测试全过）、导航站单站点化、首页自动化动态、`?mock` 演示模式全页可跑——设计规范见上文「管理台 UI 设计规范」
- [x] 品牌视觉落地（2026-11-19，D39）：豆包产品牌包入库 `assets/brand/`（SVG 母版 5 + lockup + 规范页）、管理台主色近黑→靛蓝 #4F46E5（hover #4338CA）、header/login logo 换品牌图形标、favicon、扩展 manifest 图标补齐（16/32/48/128）——规范第 1 条已同步修订
- [x] **切片 A · 决策校准**（2026-11-20 验收，功能文档 v0.3.4）：整理一次调用直接生效 + `/apply` 端点移除（D27）、通知偏好三档 toast/card/silent（管理台服务端 prefs + 扩展 options 端侧，静默档不弹成功提示与角标；D28）、收纳盒术语与文件夹名「📥 收纳盒」幂等改名（D36）、扩展端共享 BrandHeader 骨架（popup/sidepanel/newtab/options）、BYOK 迁管理台核验通过（D35）；E2E 陈旧断言修复后 20 过 0 败，单元/集成 128 全过
- [x] **原型驱动全功能补齐**（2026-11-20 验收，功能文档 v0.3.5；以 docs/原型/ 为实现依据）：站点化分析 MVP（site_type 三类+投影端点+筛选，D30/D31）、新标签页三档密度+自定义面板（D29）、onboarding 四步引导、popup ptabs 重构+AI 建议归位+右键三菜单+快捷键+页内轻提示、收纳盒状态机管理面（assign/retry/每小时清扫/按域名记忆/歧义集中询问）、维护周报升级（周期升级/复活/归档建议/复制摘要）、扩展快照查看器页、D33 出站 Hook 真分发（HMAC+SSRF 防护）、公开站摘要两行+📸徽章+主题色/水印/自定义卡、整理偏好记忆管理；迁移 v8；单测/集成 128 + E2E 20 过 0 败
- [x] **新标签页原生极简（2026-11-20 验收，功能文档 v0.3.6）**：D40 废弃三档密度——页面固定「品牌标 + 搜索 + 最常访问」，自定义仅剩常用区数量与外部引擎 chips；同轮修复两处存量缺陷：① `GET /bookmarks/top` 被 `/bookmarks/:id` 路由截胡恒 404（「最常访问」自交付以来从未显示，前端静默吞错），路由移至 `:id` 前 + 集成回归测试；② 扩展端五页 CSS Tailwind `source("../")` 只扫 entrypoints/，共享组件类名（size-7 等）从未进产物（品牌标按 SVG 原始 512px 渲染），扫描根改 `source("../../")`；单测/集成 129 全过 + 扩展 E2E 3 过 + 真机截图自检
- [x] **新标签页小组件（D41，2026-11-20 验收，功能文档 v0.3.7）**：注册制内置组件「公网 IP / 天气 / 黄历」——用户控制面仅显示/隐藏（拍板自「组件设计」需求）；**v0.3 视觉修订：用户否卡片盒子（「太俗，要和页面融为一体」）**，内容全部内联进既有字层——天气进时钟区日期行、黄历作日期下两行小字、IP 作页脚状态行，出厂全关；同日走查修订 v0.3.1–v0.3.4：IP 多源并行探测、候选全量缓存、页脚点击=v4/v6 即时切换带记忆（根治 IPv6 粘滞）、黄历两档字阶减载、三组件统一沉页脚信息组（核心区位置恒定，搜索框不被挤开）、页脚四行压两行（次级信息一律退 hover，附加区定则「内容行 ≤1 + 状态行 ≤1」）、黄历仅「宜」「忌」二字着色（宜绿 80%/忌红 70%，农历与条目中性，newtab 唯一用色）；黄历 lunar-typescript 离线计算（子路径出口不进服务端 bundle）；天气随 IP 归属地自动定位（wttr.in 主源，Open-Meteo 预报域国内不通）；IP 四源回退浏览器直连；全端点实测 CORS `*` 零新增权限；shared 单测 73 + 扩展 E2E 4（新增黄历离线用例）+ 真机内联实数据自检；方案与实测报告 docs/新标签页小组件方案-v0.3.md
- [x] **扩展工具栏图标改造（2026-11-20，用户反馈）**：白底方块 → 透明底（母版 `assets/brand/svg/icon-extension-transparent.svg` 居中放大 1.2408×，图形宽占画布 95%，16px 下 ≈15×12 与相邻插件齐平）；品牌三色阶不变；四档 PNG 已重渲染并构建验证
- [x] **AI 聊天整理下线（D42，2026-11-20 验收，功能文档 v0.3.8）**：用户拍板「聊天功能鸡肋，真用 AI 的会用外部工具；留着招问东问问甚至被接入 AI 工具」——删除扩展 sidepanel 入口 + `sidePanel` 权限、popup「✦ AI 整理」标签（ptabs 五→四）、newtab ✦ 按钮；歧义集中询问并入 popup 收纳盒视图；服务端端点/BYOK/AI 模块开关全保留（管理台功能点同内核，D27 act+undo 不变）；顺带修复扩展存量编译缺陷（popup getConfig 漏导入等），typecheck 恢复全绿；扩展 E2E 5 过 + 构建产物 -8KB
- [ ] **切片 D · 收藏内容识别三级策略（Now）**：文章「已存全文」显性化、视频元数据收藏、图片主图保存——验收标准见功能文档 §10
- [ ] **站点化 AI 信号增强**：L1 摘要补齐后投影重建抽样校验（三类判定准确率 ≥90%）
- [ ] **模块化切片**：服务端 hono 路由按模块条件挂载、定时任务随模块启停、AI 关闭时归位降级规则引擎

## 技术方案遗留核对项

- providers.json BaseURL 核对（2026-11-18 已回写技术方案 §6.1）：MiniMax `https://api.minimaxi.com/v1` ✓ · 小米 MiMo `https://api.xiaomimimo.com/v1` ✓ · 腾讯 TokenHub **待定**——疑似订阅型网关（Token Plan 类），按既定原则倾向移出内置预设，保留需官方文档确认精确端点
- captureMHTML 兼容性探针清单（随切片 E 死链/维护工作完成，见技术方案 §10）
- 浏览器平台约束（画原型/写扩展都要遵守）：书签栏文件夹原生下拉不可定制、文件夹无角标 API——收纳盒文件夹只做投递口，管理入口 = 工具栏图标角标 → popup；contextMenus 支持 bookmark 右键
