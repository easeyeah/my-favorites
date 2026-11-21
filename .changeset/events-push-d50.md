---
"@mf/server": minor
"@mf/extension": minor
---

D50 · 动作即同步（事件驱动收敛，2026-11-20）：D49 双向同步的「库→浏览器」方向此前只有周期拉取（10 分钟告警）/手动立即同步/浏览器侧事件三个触发点——用户拍板「有动作就触发，没人有耐心等 10 分钟」。① `apps/server`：新增 `events.ts` ChangeHub（进程内广播，单实例形态无需中间件）；`Store.onRecorded` 钩子（变更日志落库后广播，异常隔离绝不伤主路径）；`GET /api/v1/events/stream` SSE 门铃路由——**只推「有事发生，来拉」不推数据**（真相仍是 changes 表 + 游标增量，丢事件不丢正确性），1 秒合并窗口防整理批次刷屏，20 秒心跳保活（兼给 MV3 SW 续命）。② `apps/extension`：`sync.ts` 事件流循环（fetch 流式解析 SSE、Authorization 头带 token、指数退避 5s→60s 重连、AbortController 随开关启停）；收到 change 帧 3 秒防抖触发 tick；兜底告警 10 分钟 → **1 分钟**；浏览器侧书签事件防抖 45s → **8s**。收敛时延：任一侧动作 → 另一侧 **秒级**（SSE 在线）/ ≤1 分钟（SW 休眠兜底）。走查：server 164（新增 events 3：订阅隔离/hello+change+合并窗口/钩子异常隔离）+ shared 87 + ai 7 + E2E **23 过 1 跳**（新增「动作即同步」真机用例：管理台 POST 后零手动、9.6s 浏览器自动收敛）+ 真实 dev 服务端 curl 冒烟（1.5s 收到 change）+ typecheck 全绿。
