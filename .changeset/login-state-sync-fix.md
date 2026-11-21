---
"@mf/web": patch
---

D66 补充 · 修复 Web 登录页「点击登录没反应」（2026-11-21）：用户启用 ADMIN_PASSWORD 后点登录无反应。网络捕获定位：`POST /auth/login` **200 成功**（令牌已签发），但页面停在登录页、无错误提示——根因 = LoginPage.submit 拿到令牌后只 `storeToken()`（写 localStorage）+ `onAuthed()`（触发 probe），**未把令牌同步进 App 的 cfg state**，probe 用 `token:""` 的旧 state 探测 → 401 → 永远停在登录页。这是 Web 登录页的潜伏 bug：此前所有部署未启用过鉴权，该路径从未真实验证（D24 时代的登录验证都在扩展端 api.ts 自有存储链路）。修：login/setup 两路成功后 `onSaveConfig({...next, token: res.token})` 同步进 App state，probe 带令牌探测 → authed。教训：**「请求成功」≠「UI 状态成立」——state 与持久化层双写时，漏掉 state 同步的错误表现是静默的（无异常无提示），网络捕获是定位这类问题的第一手段**；启用鉴权是这条路径的第一次真实激活，回归时覆盖到。typecheck/build 绿 + 真库 UI 全链路实测（登录→已登录→退出→回登录页）+ E2E 35 过 1 跳。
