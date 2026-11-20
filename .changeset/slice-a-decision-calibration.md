---
"@mf/server": minor
"@mf/web": patch
"@mf/extension": patch
"@mf/shared": patch
---

切片 A · 决策校准（D26–D36 落地验收，2026-11-20）：① 整理无确认流（D27）——`POST /organize/sessions` 一次调用 = 计划 + 直接生效，返回 `status/versionId/applied/actions`（只读明细），移除 `/organize/sessions/:id/apply` 端点（404 有测试断言），web TidyPanel 与扩展 sidepanel 单调用化，sidepanel 增通知卡（撤销 + 「看看改了什么」按目录分组只读明细）；② 通知偏好三档（D28）——toast（默认）/card/silent：服务端 `GET/PATCH /settings/prefs`（管理台设置→通知偏好分区），扩展端 options 端侧选择，整理成功提示统一走 `tidyNotify`（静默档不弹）、收纳盒归位角标静默档不闪、失败提示不受档位抑制；③ 收纳盒术语（D36）——系统目录与浏览器书签栏文件夹定名「📥 收纳盒」（`INBOX_FOLDER_TITLE` 入 shared，setup 幂等改名旧「📥 自动整理」），popup/options 文案校准；④ 扩展端骨架统一——共享 BrandHeader（品牌图形标 + 产品名）接 popup（紧凑）/sidepanel（标准）/newtab（居中）/options（品牌头）；埋点新增 `organize_applied`（替代 `diff_accepted`，旧名保留兼容历史数据）
