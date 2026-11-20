---
"@mf/extension": minor
---

AI 聊天整理整体下线（D42，2026-11-20 用户拍板：聊天功能鸡肋——真用 AI 的直接用外部 AI 工具整理，不用的用不上；对话入口招「问东问西」支持负担，且有被当通用 AI 网关接入的风险）：① 删除 `entrypoints/sidepanel/`（聊天整理侧栏页）与 manifest `sidePanel` 权限；② popup「✦ AI 整理」标签移除（ptabs 五→四：⭐快速收藏 / 📥收纳盒 / 🕘历史 / ⚙️），歧义集中询问（D37 ≥3 条触发）并入收纳盒视图顶部（逐条 AI 倾向一键归位 + 「先留在收纳盒」）；③ 新标签页右下角 ✦ 侧栏按钮移除，仅留 ⚙️ 自定义；④ 服务端零改动——`/organize/sessions` 等端点与 D27 act+undo 内核原样保留（管理台功能点共用），BYOK / AI 模块开关不变（整理管线照常调 LLM）；⑤ 顺带修复扩展端存量编译缺陷：popup 漏 import `getConfig`、冗余 import 与本地定义冲突的 `decidePrivacySafe`、Ptabs label 类型（React.ReactNode）、welcome 书签树递归类型（`BmNode`）——扩展 typecheck 恢复全绿；⑥ 验证：扩展构建产物 858→851KB（sidepanel 分包移除），E2E 5 过 0 败（popup 断言改「AI 整理 tab 计数为 0」），真机四标签 popup + newtab 无 ✦ 截图自检；文档回写功能文档 v0.3.8（D42 决策行 + F3 重写「聊天整理→功能点整理」+ 定位/竞品/架构图/附录同步）
