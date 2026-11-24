---
"@mf/web": minor
"@mf/server": minor
---

书签目录右键管理（D89）：目录树补右键菜单（新建/重命名/搬家/AI 重新整理/提取资料/删除确认）；新增 `POST /organize/folder` 目录级重整理（子树限定、可撤销、可在该目录下建子目录）；新增 `GET /materials/scan/stream` 目录内容页转资料（SSE 逐条进度、断开即停、抓取失败进「建议丢弃」清单，归档/删除均用户确认）；正常书签状态改为 favicon 左上角绿点（移除行尾「正常」文字）。
