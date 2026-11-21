---
"@mf/shared": minor
"@mf/ai": patch
"@mf/server": minor
"@mf/web": minor
---

D43 · 敏感内容自动旁路（2026-11-20）：真实库存成人类条目导致供应商内容审核**整包拒收**整理批次且错误被静默吞掉——三层工程规避（不外发、不误伤功能、不误发布）。① `packages/shared` 新增 `sensitive.ts` 敏感宿主启发式（纯数据词表 + `isSensitiveHost` + `PRIVATE_FOLDER_NAME`），整理建批前命中项不进 LLM；`OrganizeAction` 联合新增 `markPrivate`。② `packages/ai`：llm-client 非 2xx 透出供应商错误体（`providerDetail`）+ `isLlmContentModeration` 审核类识别。③ `apps/server`：`classifyPending` 审核失败二分隔离（肇因项标私密跳过，调用预算封顶防雪崩）；apply/rollback 补 markPrivate 分支（版本守卫 + 反向镜像 + 幂等）；新端点 `POST /tidy/sensitive` 全库一键旁路（单事务标私密 + 移入「私人收藏」+ 镜像入队 + 版本可撤销，零删除）。④ `apps/web`：整理页功能点行「敏感内容旁路」（点了就跑 + 结果直显 + 撤销这批）；书签库「显示私密」开关（`X-MF-Private` 请求头透传，localStorage 持久，列表/搜索/目录树一致边界）；mock 同步覆盖。走查：单测/集成 147 + shared 87 + ai 7 + E2E 21 过 1 跳。
