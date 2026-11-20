---
"@mf/server": patch
"@mf/extension": minor
---

新标签页回归原生式极简（D40，2026-11-20）：① 扩展 newtab 废弃 D29 三档密度（极简/标准/完整预设、时钟问候、分组导航、资料站沉底、失效卡选项全删），页面固定「品牌标 + 搜索框 + 最常访问」，自定义仅剩常用区数量（4/8/12/16/关闭）与外部搜索引擎 chips；② 修复 `GET /bookmarks/top` 路由顺序 bug——注册在 `/bookmarks/:id` 之后被截胡恒 404，「最常访问」磁贴自 D29 交付以来从未显示（前端 .catch 静默吞错），路由移至 `:id` 之前 + 集成回归测试（server 129 测试全过）；③ 修复扩展端 Tailwind 扫描根——五页 CSS `source("../")` 只扫 entrypoints/，共享组件（BrandHeader 等 src/components）类名从未进产物 CSS，标准档品牌标按 SVG 原始 512px 渲染，扫描根改 `source("../../")`
