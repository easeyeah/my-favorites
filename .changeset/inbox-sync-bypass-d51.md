---
"@mf/extension": patch
---

D51 · 收纳盒不参与同步 + 重复文件夹自愈（2026-11-21）：用户实机发现书签栏出现 **3 个重复「📥 收纳盒」**。根因是 D49 引擎的组合缺陷：walkBrowser 按设计跳过收纳盒子树（投递口归收纳盒管线），但库→浏览器放置（placeBookmark/ensureBrowserFolder）没有对应豁免——引擎在 folderIdByPath 里永远找不到收纳盒，每轮对齐/tick 都新建一个同名文件夹并把库内收纳盒条目搬进去。修复三层：① 引擎整体绕开系统收纳盒——FolderIndex 携带 `inboxFolderId`（is_system_inbox=1），align 补位/放置/重排与 tick 的 upsert/move 应用全部跳过该目录（placeBookmark 内再加一道兜底）；② 存量自愈 `mergeDuplicateInboxFolders`：书签栏根下多个「📥 收纳盒」时保留正主（config.inboxExtId，缺省第一个），其余内书签按 URL 去重后移回、移空删壳（子文件夹不递归不硬删），align 与每次 tick 末尾自动执行——用户重载扩展后无需任何手动清理；③ E2E 回归「收纳盒不参与同步」：setup-inbox + 库内塞待归位条目 + 全量对齐 → 断言书签栏有且仅有一个收纳盒、条目未被放置。走查：E2E 24 过 1 跳（新增 1）+ server 164 + shared 87 + ai 7 + typecheck 全绿。纯扩展端修复，服务端零改动。
