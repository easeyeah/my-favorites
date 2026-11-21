---
"@mf/server": patch
"@mf/web": patch
---

D60 · favicon 回填并发闸 + 服务端解析预算（2026-11-21）：用户「管理台切换目录加载书签很慢」。诊断：服务端列表 0–22ms、SQLite 2.4ms——全链路只有 /favicon 异常（单个 2–23s）；1817/2119 书签缺图标，切目录一次渲染 100 行、每行 SiteIcon 挂载即发 /favicon，HTTP/1.1 每源 6 并发连接被图标洪水占满，下一次切目录的 /bookmarks 在浏览器侧排队数秒（服务端 5ms 也发不出去）。修：① `apps/web/src/lib/favicon.ts` 全局并发闸 MAX_CONCURRENT=2（装饰资源涓流回填，连接留给数据请求；会话级 URL 缓存与失败记忆不变）；② `apps/server/src/favicon.ts` resolveFavicon 整体 12s 预算（原候选链 favicon.ico×2 → 首页 → 3 个 link 图标串行各 15s，最坏 ~90s；预算耗尽提前进入 24h host 级负缓存）。走查：server 177 全绿 + web 重建 + 容器重启 + Playwright 真服务端实测（图标在途窗口切目录 /bookmarks 36ms）+ curl 验证挂起 host 12.0s 封顶。教训：**图标类装饰请求不限流会饿死数据请求——HTTP/1.1 每源 6 连接是隐性全局资源，任何「每行一发」的回填模式都要过并发闸**。
