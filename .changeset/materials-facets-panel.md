---
"@mf/server": minor
"@mf/web": minor
---

资料库左侧双维度分面面板（D64 增强，2026-11-21）：用户要求左侧做标签树——标签之间无层级，不造假树；改用与数据结构同形的**双维度面板**：①「分类」树 = 目录体系（真层级），按资料子树聚合计数、无资料分支剪枝，点选 = 子树 IN 筛选（server folderId 支持逗号分隔多目录）；②「AI 标签」频次榜 = 平铺维度，json_each 展开 l1_tags 逐元素计数（json_valid 防御坏 JSON）频次排序 ≤60，点选 = 精确筛选。与顶部类型 chips/关键词检索四维正交可叠加。新增 GET /materials/facets 分面统计端点（口径与列表一致：active/非软归档/非私密随 X-MF-Private）。server 200(+1)/E2E 36 过 1 跳 + 真库截图（B 开发 2 → B02 后端 1 → ASP.NET 1 层级聚合正确）。
