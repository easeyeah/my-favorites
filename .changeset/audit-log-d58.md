---
"@mf/server": minor
"@mf/web": minor
---

D58 · 操作审计日志（2026-11-21）：用户问「现在的用户操作是否有日志跟踪」。盘点结论：数据变更早有记录（changes 同步游标、organize_version 版本、inbox_state 归位历史），但真缺口=①认证安全事件零持久化——登录失败/限速只在 security.ts 内存滑窗（重启即失，自建端暴露公网被爆破无感知）；②配置变更（供应商/偏好/Webhook/发布/令牌撤销）无任何痕迹；③changes/events/idempotency 三张表只增不减（NAS 单文件 SQLite 红线下的慢性隐患）。落地：① 迁移 v9 `audit_log`（kind/detail/source/created_at），`store.audit` 统一出口，红线=detail 一行人类可读摘要、绝不落密码/token 原值与摘要/apiKey；② 记录点接入：登录三态（成功/失败/限速，key 复用 clientKeyOf）、setup 完成、令牌撤销两路（列表 ID + logout）、供应商/偏好/Webhook 保存删除、导航站发布/下线；③ `GET /audit` 只读查询（limit≤500）；④ 管理台设置页新增「操作日志」只读分区（9 分区）：语义徽章（登录=绿/登录失败=红/限速=琥珀）+ 来源 + 相对时间 + 一行说明，mock 演示数据同步（DB_VERSION 6）；⑤ 保留裁剪 `startRetentionPrune`：changes 14 天（离线漏拉由 treesDiffer catch-up 兜底）/events 90 天/idempotency 7 天/audit_log 1000 条，**常驻启动+每日，不依赖 MF_MAINTENANCE_INTERVAL_HOURS 开关**（D57 教训：兜底不能挂可选开关）。走查：server 177（新增 audit 7 例：认证三态脱敏断言/令牌/配置/发布/limit 上限/裁剪幂等）+ 真实库 8→9 迁移带备份 + 端到端 curl 验证 + ?mock 截图自检。原则沉淀：**changes 表是同步游标不是审计——多端同步允许裁剪丢弃，安全审计要求可追溯，是两种需求**。
