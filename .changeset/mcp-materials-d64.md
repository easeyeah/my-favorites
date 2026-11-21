---
"@mf/server": minor
"@mf/web": minor
---

D64 · 资料库消费面重定位（2026-11-21）：用户拍板「资料页列表即可不做阅读效果、分类标签一定要做好、最终价值是经 MCP 供 AI 工具调用——AI 才是一等消费者」。三件落地：① **MCP 端点 `POST /api/v1/mcp`**：Streamable HTTP 单端点 JSON 模式（JSON-RPC 2.0：initialize 协议协商 2025-03-26/2025-06-18、通知 202、tools.list、tools.call；GET SSE 不支持回 405；无状态不派 Mcp-Session-Id），三工具 materials_search（关键词/类型/标签检索，摘要级控制 token 体量）/ materials_get（详情含已存全文供 AI 阅读原文）/ materials_recent（最近+类型计数）；鉴权随 /api/v1 既有 bearer 中间件（Claude/Cursor 等自定义连接器配 Authorization 头即用）；工具级失败回 isError 结果而非协议错误；② 资料页重写为**行式列表**（砍卡片流/阅读浮层/封面流）：类型 chips 带计数、行 = 标题+已存全文徽章+📸+分类标签行（目录徽章主色语义=AI 分类结果，AI 标签灰底 ≤5）+ 行内操作（打开原页/导出 Markdown/移出资料库），底部 MCP 提示行；③ listMaterials 增 tag 筛选（l1_tags JSON 引号定界 LIKE 防子串误命中）。隐私域/私密条目在资料层不存在，MCP 侧零暴露。走查：server 199(+7 MCP)/E2E 36 过 1 跳（列表断言重写）+ 真库端到端（initialize/tools.list/recent/get 全文 4552 字）+ ?mock/真库截图自检。
