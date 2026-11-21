---
"@mf/extension": minor
---

D57 · 收纳盒自动分类兜底（2026-11-21）：用户「把网页丢到收纳盒为什么不自动分类」。诊断：分类逻辑本身正常（手动 /inbox/process 能把条目 LLM 归类），真缺陷是**自动触发不可靠且无兜底**——唯一自动触发是"丢入后 1.2s 即时 flush"，其内部 catch{} 静默吞错（MV3 SW 随时被杀 / 网络抖动 / LLM 超时），一旦失败条目永远卡 pending；而 UI 承诺的"每小时自动清扫"**代码里根本不存在**（只有同步 alarm）。修复：新增**独立于同步开关**的 `mf-inbox-sweep` alarm（1min，SW 启动常驻创建），onAlarm → `maybeSweepInbox`（用服务端 /inbox/count 门控：不依赖客户端 inboxExtId 是否失配、不会误建收纳盒，count>0 才 flushInbox）；SW 启动即补扫一遍（含上次被杀时卡 pending 的条目）；保留即时 flush 作快路径。popup 文案"每小时自动清扫"改为"丢入即触发，最迟 1 分钟兜底"；顺手清掉遗留 bgMsgSeen 调试探针。回归：E2E ①丢入 github 书签零手动 2s 归位（即时路径）②用 /inbox/map 造卡 pending 条目（不经浏览器丢入、不触发即时 flush）纯靠 alarm 1min 分类（兜底路径，精准复现用户场景）+ alarm 存在断言。E2E 32 过 1 跳、server 170、shared 90、ai 7、typecheck 全绿。纯扩展端，无需重启服务端。
