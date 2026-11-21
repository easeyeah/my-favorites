---
"@mf/server": minor
"@mf/web": minor
---

D65 · 资料库自有 AI 分类体系（2026-11-21）：用户指示「不用书签的分类，但可以参考书签的分类」——资料分类按内容语义自组织（AI 视角），不沿用浏览器目录；左树呈现方式参考书签库。落地：① 迁移 v11 `material.category`（两级路径 "一级/二级" 存储形态）；② 摘要 prompt 增产 category（同一次 LLM 调用零额外成本）+ backfillCategories 涓流回灌存量（已有 L1 摘要但缺分类为候选，≤5 条/轮，startCategoryBackfill 启动+30min 常驻，无 LLM 零开销；单条失败不阻塞、缺失即下轮重进候选）；③ 分面改分类维度（GROUP BY category，未分类 = total − Σcategories 前端推导）+ listMaterials 增 category 子树筛选（一级前缀匹配）与 uncategorized=1 口径；④ 左栏「分类」树（两层聚合+未分类兜底）替代目录树，行徽章/MCP slimRow/Markdown 导出全部换 category 维度，materials_search 增 category 参数（一级含子树）。设计判断：**标签无层级不造假树；书签目录服务于浏览器心智，资料分类按内容语义自组织——AI prompt 给推荐一级清单但允许自拟更贴切短语（自组织优于硬枚举）**。走查：server 200(+1)/E2E 36 过 1 跳 + 真库回灌实测（DeepSeek 产出「技术开发/算法与数据结构」「技术开发/实时音视频」）+ ?mock 截图（技术开发 6→前端 5 两层聚合正确）。
