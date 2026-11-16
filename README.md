<div align="center">

# my-favorites

**AI 整理书签，生成你的个人导航主页。**

一键导入浏览器书签 → AI 按网页实际内容分类 → 生成导航站 → 设为新标签页。
死链检测、重复合并、内容快照，全部可云端托管，也**完全可自建**（Docker 单容器，NAS 友好）。

[功能文档](docs/功能文档-v0.3.md) · [技术方案](docs/技术方案设计-v0.1.md) · License: AGPL-3.0

</div>

> 🚧 项目处于 M1 骨架阶段，见 [技术方案附录](docs/技术方案设计-v0.1.md#附m1-骨架搭建顺序建议) 的搭建顺序。

## 开发

```bash
pnpm install
docker compose -f docker/docker-compose.dev.yml up   # 服务端（必须跑 Docker）
pnpm --filter @mf/extension dev                      # 扩展 HMR
```

架构、数据模型、API 设计与硬性红线见 [AGENTS.md](AGENTS.md) 与技术方案文档。
