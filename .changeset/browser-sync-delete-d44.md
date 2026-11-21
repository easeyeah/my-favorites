---
"@mf/shared": minor
"@mf/server": minor
"@mf/extension": minor
"@mf/web": patch
---

D44 · 受控镜像删除（2026-11-20）：管理台删除书签原本只作用于应用库，浏览器收藏夹不动（D16「不承诺双向同步」的直接后果，用户实际使用中产生「为什么没同步」的困惑）。本次改为「默认关、开了才镜像」的受控删除回写。① `packages/shared`：`bookmarkIngestItem` 新增可选 `browserId`，`ingestRequest` 新增可选 `deviceId`。② `apps/server`：`/bookmarks/ingest` 带 `deviceId`+`browserId` 时建立 A2-1 身份映射（重复 URL 回填到既有书签，老客户端不带字段行为不变）；`Store.deleteBookmark` 对**有身份映射**的书签按身份入队 `pending_browser_ops op='remove'`（幂等，无映射不动浏览器）；`/browser/ops/:id/result` 回执仅对 pending 生效并返回 404（防乱序/重复回执误终结）。③ `apps/extension`：`runMirrorOps` 新增 remove 分支——端侧开关 `syncDeleteToBrowser`（默认关）关闭时回执 `cancelled(sync_delete_disabled)` 显式终结（不留 pending，避免日后开启「补删」历史删除）；开启时仅删书签叶子节点、节点已不存在视为成功，mirrorGuard 防循环。导入通道（welcome 向导 + options 一键导入）携带 `deviceId`+`browserId` 建映射；options 页新增开关。④ `apps/web`：单条/批量删除确认弹窗补一行「浏览器收藏夹不受影响，除非在扩展里开了『同步删除到浏览器』」。验证：server 集成新增 5 用例（映射/回填/无映射/回执终结/老客户端兼容），全量 152 + shared 87 + ai 7 过；真实 dev 服务端 curl 端到端（ingest→delete→pending remove→cancelled 回执→不再下发）；E2E 21 过 1 跳；typecheck 全绿；?mock 弹窗 DOM 自检。
