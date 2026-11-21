---
"@mf/server": minor
"@mf/extension": minor
---

D56 · 浏览器删目录同步修复（2026-11-21）：用户「浏览器收藏夹删了目录，管理台没同步」。真机 E2E 复现定位到两个缺陷：① **嵌套目录父残留**——旧实现把目录删除拆成「逐条 bookmark.delete + folder.delete(仅空目录可删)」，且 folder.delete 按父→子顺序推送，父目录删除时子目录还在 → deleteFolderIfEmpty 判非空 → 父目录删不掉残留（用户库是 A AI/C 硬件/C04 开发板 这类嵌套结构，删父类目必踩）；② **保险丝误伤目录级删除**——删一个含 >30 条且 >25% 的目录会触发书签保险丝，整批挂起，目录+书签都留着。修复：新增服务端 `store.deleteFolderTree`（子优先递归删「子目录+全部子书签+本目录」，事务原子，系统收纳盒拒绝，书签走 deleteBookmark 记日志+给他设备排 remove、skipMirrorRemoveForDevice 跳过发起设备）+ `/sync/apply` 新 mutation `folder.deleteTree`。引擎检测到浏览器目录删除时改发 deleteTree（只对最顶层被删目录发，子孙由服务端树删覆盖），目录内书签不再走逐条 delete；**目录级独立保险丝**（被删目录数 >3 且 >基线 50% 才视为灾难挂起，单个目录删除含嵌套/大目录一律放行）；基线剪枝移除被删子树防下轮误报。回归：E2E 新增小目录/嵌套目录/大目录(保险丝豁免) 3 例 + 服务端 deleteTree 嵌套/系统盒拒绝/多端 remove 3 例。E2E 30 过 1 跳、server 170、shared 90、ai 7、typecheck 全绿。
