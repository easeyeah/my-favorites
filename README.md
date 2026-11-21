<div align="center">

# my-favorites

**AI 整理书签，生成你的个人导航主页。**

一键导入浏览器书签 → 规则引擎即时归位、AI 内容级精修 → 生成可分享的导航站 → 设为新标签页。
死链检测、重复合并、页面快照、收纳盒自动归位，**完全可自建**（Docker 单容器，NAS 友好，内存 <300MB）。

[产品说明](docs/产品.md) · [技术方案](docs/技术方案.md) · [决策记录](docs/决策记录.md) · License: AGPL-3.0

</div>

## 功能

- **一键导入与收藏**：扩展直接读浏览器书签树（保留目录结构），也支持 Netscape HTML / JSON 导入；工具栏 popup、右键菜单、Ctrl/⌘+Shift+S 一键收藏，扩展端就地捕获正文（登录墙/内网可用）
- **📥 收纳盒自动归位**：书签随手丢进收纳盒文件夹，规则引擎即时分类、AI 内容级精修，浏览器节点真实镜像移动，置信不足留盒内联处理，永不丢书签
- **AI 整理（功能点，非聊天）**：全库重分类、合并重复、敏感内容旁路——点了就跑、直接生效、随时一键撤销（版本化回滚）；AI 可完全关闭并降级纯规则引擎
- **BYOK**：管理台内置 15 个供应商预设（DeepSeek/智谱/百炼/Kimi/火山/OpenAI/Ollama…），支持测试连接、在线拉取模型、按整理/摘要/向量三用途分配；Key 加密落库，扩展不持 Key；也可接本机 Ollama 全离线
- **导航站**：4 套模板（宫格/清单/瀑布流/个人主页），显式选择发布集合、随机私有链接、访问密码、主题色/水印/自定义卡片；公开页只含元数据与摘要，永不展示快照内容
- **新标签页**：品牌标 + 搜索（书签引擎 + 外部引擎）+ 最常访问；可选内置小组件（公网 IP / 天气 / 黄历，出厂全关、页脚内联）
- **持续维护**：死链三级判定（确认失效/疑似反爬/正常，保守标注不误删）、同域同名查重与合并建议、SSE 检测进度、归档建议永不自动执行
- **内容快照**：一键 MHTML 快照（pageCapture），失效后可经净化查看器回看
- **搜索**：全文 + 语义（embedding 余弦）双模式，⌘K 命令面板
- **浏览器镜像**：归位移动、按管理台顺序重排、可选同步删除（默认关），管理台与收藏夹不再越用越漂
- **隐私**：隐私域名五动作强制校验（读/传/AI/抓取/快照）、出站 SSRF 守卫、Webhook 隐私命中永不外发、敏感内容自动旁路不进 AI 批次

> 功能的最新实现状态（✅ 已交付 / 🚧 半成品 / 📋 规划中）以 [docs/产品.md](docs/产品.md) 为准。官方云 SaaS 与纯本地无服务端模式为规划形态，当前交付的是「扩展 + 自建 Docker」。

## 部署（自建 NAS）

```bash
# 方式一：全离线（服务端 + 本机 Ollama）
docker compose -f docker/docker-compose.full.yml up -d

# 方式二：开发/演示（含 LLM mock，无需任何 Key）
docker compose -f docker/docker-compose.dev.yml up
```

- 管理台：http://localhost:3000 （生产镜像内已构建 Web 控制台）
- 扩展：`pnpm --filter @mf/extension build` 后在 `chrome://extensions` 加载 `apps/extension/.output/chrome-mv3`
- 首启：生产语义下需设置管理员密码（引导凭据取 `MF_SETUP_TOKEN` 或 `/data/bootstrap-token.txt`，一次性）；也可直接设 `ADMIN_PASSWORD`

| 环境变量 | 说明 |
|---|---|
| `ADMIN_PASSWORD` | 设置后全部 API 用此密码登录（不设则走首启 setup 引导） |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_EMBEDDING_MODEL` | 任意 OpenAI 兼容端点；不配置则 AI 降级纯规则引擎（BYOK 在管理台设置里配置，优先于 env） |
| `MF_SECRET_KEY` | 生产语义必填（≥16 字符），BYOK API Key 的加密主密钥 |
| `MF_MAINTENANCE_INTERVAL_HOURS` | 死链/查重定时任务与收纳盒兜底清扫间隔；默认 0=关，full 部署为 168（每周） |
| `DATA_DIR` | SQLite + 快照 + 备份目录（挂 volume），默认 `./data` |
| `MF_ALLOWED_ORIGINS` | 跨域来源白名单（NAS 域名/扩展 ID，逗号分隔） |
| `PORT` | 监听端口，默认 3000 |

完整变量表见 [docs/技术方案.md](docs/技术方案.md) §10。

## 开发

```bash
pnpm install
docker compose -f docker/docker-compose.dev.yml up   # 服务端（必须跑 Docker，默认接 llm-mock）
pnpm --filter @mf/extension dev                      # 扩展 HMR（连 http://localhost:3000）
pnpm --filter @mf/web build                          # 改管理台后重新构建
pnpm test                                            # 单测 + API 集成
pnpm --filter @mf/e2e test                           # Playwright（加载未打包扩展）
```

管理台支持 `?mock` 演示模式（内存数据层，无需服务端，登录页任意密码可进）。

## 文档

- [docs/产品.md](docs/产品.md) — 功能现状与路线图（代码反向同步的活文档）
- [docs/技术方案.md](docs/技术方案.md) — 架构、数据模型、API 全量清单、安全、部署
- [docs/决策记录.md](docs/决策记录.md) — D1–D48 决策日志
- [AGENTS.md](AGENTS.md) — AI 会话工作规则（红线 / UI 规范 / 当前进度）
- [docs/归档/](docs/归档/README.md) — 历史版本文档（只读考古）
