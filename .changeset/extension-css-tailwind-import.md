---
"@mf/extension": patch
---

修正四个入口样式表（popup / newtab / welcome / viewer）的 Tailwind 引入写法：去掉非标准参数 `source('../../')`（VS Code 内置 CSS 校验报「需要冒号」，构建产物经比对字节不变——Tailwind v4 默认扫描基路径即扩展包根目录 `apps/extension`）。
