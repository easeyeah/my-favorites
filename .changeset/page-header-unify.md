---
"@mf/web": minor
---

页签标题统一（2026-11-21 用户反馈「设置标题要加图标与导航站一致，书签页也没看到图标，字体大小也要统一」）：盘点发现四个页签三套口径——导航站（Globe 图标 + text-lg ✓ 基准）、书签（无图标 + text-xl）、设置（无图标 + text-lg）、资料（PageHeader 无图标 + text-xl）。统一为：**h2 = 页签同款 lucide 图标（size-4，与顶部导航串号防护：与 NAV 注册表同图标）+ text-lg font-bold，副标题 text-[13px]**。落地：shared PageHeader 加 icon 参数并统一字号；书签页 BookMarked + text-lg + 13px；设置页 SettingsIcon（lucide Settings 与页面组件同名，别名导入）+ 13px；资料页 LibraryBig。真库四页签截图核对一致。
