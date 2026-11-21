---
"@mf/server": minor
"@mf/extension": minor
"@mf/web": patch
---

D49 · 收藏夹双向直接同步（2026-11-20）：用户反馈 D44/D45 的「开关+按钮+神秘文件夹」形态「太复杂，没法用」——根因是 D16「单向导入 + 可选镜像」架构被逐条反向打补丁，控制面碎片化。本轮收敛为**一个总开关**：扩展设置页开「与浏览器收藏夹同步」即接管一切（增删改移序全向收敛，10 分钟告警 + 书签变动防抖 + 手动「立即同步」三触发），首次开启自动完成全量对齐（取代一键导入）。

① `apps/server`：新增 `sync-apply.ts` —— `POST /sync/apply` 落地 7 种浏览器侧变更（create 按 URL 幂等绑定/update/move/delete/folder.ensure/rename/delete），全程 `store.syncApplyDevice` 上下文使产生的变更日志带发起设备、`pullChanges` 天然排除自己（防回环）；`GET /browser/identities` 供首次对齐查孤儿映射；补齐 `updateBookmark` 的变更日志（title/pinned/is_private/status → upsert、folder_id → move）——此前改名/置顶不进日志、浏览器永远收不到。`deleteBookmark` 新增 `skipMirrorRemoveForDevice` 避免发起方回程自删。

② `apps/extension`：新增 `sync.ts` 引擎——首次对齐（浏览器→库全量推送 → 库→浏览器补位 → 孤儿清理 → 放置+按库顺序重排 → 固化基线快照/游标）+ 增量 tick（pull 逐条应用 → diff 快照推送 → 受影响目录重排 → 重存基线）。快照即合并基线，幂等可重放。大规模删除保险丝：单轮任一侧删除 >30 且 >25% → 跳过删除并挂出「确认执行」按钮（防资料重置/误清库灾难）。manifest 补 `alarms` 权限（E2E 揪出：缺权限时 SW 启动崩、全部消息无回执）。`runMirrorOps`：总开关开启时镜像 move/reorder 让位引擎（回执 cancelled superseded_by_full_sync），remove 由总开关接管（syncDeleteToBrowser 降为兼容位）。**退役四入口**：一键导入/反向同步(syncMirror)/按管理台顺序重排/同步删除开关——options ③卡收敛为「总开关+状态行+立即同步+保险丝确认」。

③ `apps/web`：删除确认弹窗文案改指「与浏览器收藏夹同步」。

④ `packages/shared`：ingest schema 不变（D44 已备好 deviceId+browserId，对齐复用它）。

走查：server 161（新增 sync-apply 6）+ shared 87 + ai 7 + E2E 22 过 1 跳（新增双向同步全链路用例：开关对齐/两侧增删改置顶序全收敛；D45 旧重排用例退役改造为引擎用例）+ 真实 dev 服务端 curl 冒烟。E2E 揪出两处真缺陷（缺 alarms 权限→SW 静默全瘫；状态行 UI 覆写竞态）均已修。教训沉淀：D44/D45 的补丁形态把架构复杂度泄漏给了用户，功能正确 ≠ 可用。
