<div align="center">

# my-favorites

**AI 整理书签，生成你的个人导航主页。**

一键导入浏览器书签 → AI 按网页实际内容分类 → 生成导航站 → 设为新标签页。
死链检测、重复合并、内容快照，全部可云端托管，也**完全可自建**（Docker 单容器，NAS 友好）。

[功能文档](docs/功能文档-v0.3.md) · [技术方案](docs/技术方案设计-v0.1.md) · License: AGPL-3.0

</div>

## 功能（M1–M3 全量）

- **AI 书签整理**：收藏时即时归位（域名缓存 <50ms）+ 收件箱随手丢（自动归位，永不丢书签）+ 聊天式指定整理（diff 预览/应用/回滚）
- **内容感知**：扩展端就地捕获正文（登录墙/内网可用）、AI 摘要、服务端补漏抓取、隐私域名强制排除
- **导航站**：4 套模板（宫格/清单/瀑布流/个人主页）、随机链接分享、访问密码、新标签页直达、页脚水印
- **持续维护**：死链三级判定（保守标注不误删）、同域同名查重、每周自动任务、体检报告页
- **多端同步**：变更日志 + 游标增量拉取（扩展一键镜像到浏览器书签树）
- **语义搜索**：embedding 索引 + 余弦相似度，全文兜底
- **部署**：官方云 / **自建 Docker 单容器**（NAS 友好，内存 <300MB）/ 管理员密码鉴权 / Ollama 全离线

## 部署（自建 NAS）

```bash
# 极简（AI 走 BYOK 或官方端点）
docker compose -f docker/docker-compose.full.yml up -d
# 管理台：http://localhost:3000（apps/web 构建）；扩展加载 apps/extension/.output/chrome-mv3
```

| 环境变量 | 说明 |
|---|---|
| `ADMIN_PASSWORD` | 设置后全部 API 需登录（不设则本地无鉴权） |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_EMBEDDING_MODEL` | 任意 OpenAI 兼容端点（DeepSeek/智谱/Ollama…） |
| `MF_MAINTENANCE_INTERVAL_HOURS` | 维护任务间隔（默认关，full 部署为 168=每周） |
| `DATA_DIR` | SQLite + 快照存储目录（挂 volume） |

## 开发

```bash
pnpm install
docker compose -f docker/docker-compose.dev.yml up   # 服务端（必须跑 Docker）
pnpm --filter @mf/extension dev                      # 扩展 HMR
pnpm --filter @mf/e2e test                           # 浏览器 E2E
```

架构、数据模型、API 设计与硬性红线见 [AGENTS.md](AGENTS.md) 与技术方案文档。
