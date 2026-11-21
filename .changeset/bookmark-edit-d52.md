---
"@mf/server": minor
"@mf/web": minor
"@mf/extension": patch
---

D52 · 书签编辑补全 + 管理台行右键菜单（2026-11-21）：用户问「书签缺编辑、可否自定义右键」。事实核查：Chromium `contextMenus` 无 `bookmark` context（Firefox 独有），原生收藏夹右键不可注入——自定义右键只能做在自家页面；而讽刺的是 D49 后浏览器原生「编辑」已能反向同步，主管理面管理台却不能改标题/URL/备注。落地：① 服务端 `PATCH /bookmarks/:id` 补 `url`（canonicalizeUrl 重算查重键、撞既有 canonical→409 `duplicate_url`、非法→400、清正文缓存保留快照、进变更日志、content_revision +1）与 `description`（截断 2000）；`updateBookmark` 日志列扩展 url_raw/description。② 同步引擎 `placeBookmark` 补 URL 跟随（库侧改 URL → 浏览器节点 `bookmarks.update({url})`）。③ 管理台：详情面板内联编辑表单（标题/URL/备注三输入 + 保存/取消，安静一行「✎ 备注 + 编辑」入口，保存提示同步语义）；列表行右键菜单（打开原页/编辑/移动…/置顶/归档/复制链接/删除——动作全复用现有 handler，手写轻量浮层零新依赖；踩坑：window mousedown 关闭先卸载菜单致 menuitem click 落脱离节点不触发，stopPropagation 修复）。④ mock PATCH 同步支持 url（含 duplicate 模拟）/description/pinned。走查：server 167（新增编辑 3 例）+ shared 87 + ai 7 + E2E 25 过 1 跳（新增 edit-ui：菜单齐全/编辑保存/409 提示）+ typecheck 全绿 + 真实容器部署。
