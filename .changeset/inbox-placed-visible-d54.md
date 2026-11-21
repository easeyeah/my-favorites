---
"@mf/server": minor
"@mf/web": minor
"@mf/extension": minor
---

D54 · 收纳盒归位去向可见（2026-11-21）：用户反馈「收藏到收纳盒后，不知道 AI 把它自动分到了哪里」——归位历史数据一直在记（inbox_state placed + version_id，红线③要求），但 web 管理台从未消费（/inbox/items 的 placed 字段返回了没人看，mock 还置空），popup 有区块却不显示**目标目录名**（服务端 placed 查询根本没带 folder_name）。修复：① 服务端 `listInboxRecentPlaced` JOIN folders 返回 `folder_name`（测试补断言：归位后 /inbox/items placed 含目标目录与 version_id）。② popup「最近自动归位」行加 `→「目录」`（reason 收进 title hover）。③ web 收纳盒视图新增「最近自动归位」区：标题 →「目标目录」+ 分类理由 + 时间 + 「撤销…」直达版本历史面板；选中收纳盒即加载，AI 归位后即时刷新；mock 同步演示数据。**位置按用户反馈定为待处理列表下方**（先看正事，历史垫后；data-marquee-skip 防框选误触）。附带修正 D53 基线语义缺口（tick 失败回归揪出）：基线 = 上一基线 ∪ 本轮成功推送的浏览器事实 ± 引擎动作——否则「本轮新增→下轮删除」序列会丢删除；保险丝挂起的删除保留在基线中反复检出直到确认。验证：server 167 + shared 87 + typecheck 全绿 + **E2E 26 过 1 跳**（含 D46 全链路重跑）+ 真实服务端 gitlab→「开发」归位链路 curl 走通 + ?mock 渲染自检。
