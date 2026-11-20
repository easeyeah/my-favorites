---
"@mf/server": minor
"@mf/web": minor
"@mf/extension": minor
"@mf/shared": minor
---

原型驱动全功能补齐（2026-11-20，以 docs/原型/ 17 屏为实现依据）：① 站点化分析 MVP（D30/D31）——shared `classifySiteSignal` 规则信号 + L1 摘要 AI 信号叠加、迁移 v8（site_type/suspect_streak/last_fail_reason/nav_site.config/hook/inbox_state/bookmark_click）、投影端点与书签库站点类型/有快照筛选、导航位只放站点级入口；② 新标签页三档密度（D29）——极简/标准/完整 + 逐项开关 + 搜索引擎 chips（Tab 切换）+ 最常访问点击计数 + 首次使用提示；③ 扩展端 onboarding 四步引导（welcome）、popup ptabs 五标签重构（AI 建议归位两态/快照开关/备注/隐私徽章）、右键三菜单、Ctrl+Shift+S 快捷键、收藏页内轻提示（可撤销）、收纳盒面板状态机（歧义 chips/隐私按域名记忆/重试/清扫/归位历史）；④ 服务端收纳盒状态机（inbox_state + items/assign/retry + 每小时清扫全设备镜像）；⑤ 维护周报升级（suspect 连续周期/复活检测/失败原因/📸 有快照/归档建议一键归档/复制摘要）+ 扩展快照查看器页（版本 tabs + 净化视图）；⑥ D33 出站 Hook 真分发（HMAC-SHA256 + guardFetchTarget SSRF 防护 + 退避重试 ×3 + 测试端点，隐私命中永不外发）；⑦ 公开导航站 L1 摘要两行卡 + 📸 有快照徽章 + 主题色/水印/自定义卡（nav_site.config）；⑧ 整理偏好记忆管理（organize_rules 注入整理 LLM prompt + 设置分区）；⑨ 收纳盒定位纠偏：回滚误增设的独立页签与无效 inbox 模块 gating，保持「书签库内置视图」原定案（左树置顶 + 首页动态；⑩ 全局搜索：书签页搜索框上移左树上方（原型 11）+ Ctrl/⌘K 命令面板（全文/语义搜索 + 页签跳转，components/command-palette.tsx）
