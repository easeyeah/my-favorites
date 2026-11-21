---
"@mf/shared": minor
"@mf/server": minor
"@mf/web": minor
"@mf/extension": minor
---

D61 · 资料库（2026-11-21）：用户调研语雀/Notion/flomo 等笔记工具开放 API 想接入资料整理，结论「资料沉淀本体自建，笔记应用降级为导出适配器」（语雀令牌需会员且 API 文档转 Lake 后禁 API 再改、Notion 需手动连接集成、flomo 锁 Pro、印象笔记 EDAM 弃用）。切片 D 升级为「资料库」交付：① shared `classifyMaterialKind` 纯规则三级识别（图片直链扩展名→image、视频站 host+路径守卫→video、其余 article 兜底；文章仅已存全文 ≥200 字显性化）；② 迁移 v10 `material` 表（bookmark_id UNIQUE 覆盖式 upsert，正文/摘要引用 content_cache 不复制——删规则连带清理自然生效），启动一次性存量回灌（纯本地零网络，prefs 记完成位）；③ 入库挂点 = /content/capture（og:image 随行）/收藏创建（视频图片凭 URL 即时入库）/crawl/run（抓到即入库），封面经 server_fetch 隐私判定前置后 guardedFetch 下载落盘 DATA_DIR/materials/（2MB 上限+魔数嗅探，视频不下载本体沿 D32 四重否决）；④ `/materials` 列表（类型筛选/全文检索/counts）/详情（l2 全文引用）/封面（nosniff+路径纵深校验）/Markdown 导出（front-matter+摘要+正文+原文）/dismiss（软删防 capture/crawl 复活，书签本体不动，封面文件即清）；⑤ 管理台第五页签「资料」卡片流（类型徽章/「已存全文」/📸 快照徽章/来源·目录/详情阅读浮层），mock 演示数据同步（DB_VERSION 7）；⑥ 扩展 captureInPage 补 og:image 绝对化上行。语义边界：入库是内容识别非书签移动，不写 organize_version；隐私域名/私密书签/回环（127.0.0.1 属内置隐私域）永不入库——集成测试注 coverFetcher 缝不放宽红线。走查：shared 96（+6）/server 187（+10）/E2E 36 过 1 跳（+3）/?mock 截图自检。附 D62：异步与性能规范四条补登决策记录（AGENTS.md 专节此前误标 D61，编号让位资料库）。
