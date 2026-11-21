# TASK-01 问题复现记录（2026-11-17）

> 依据：《产品打磨与落地优化方案-v0.1》§4 的静态推断。
> 方法：`apps/server/scripts/repro-task01.ts`（可重复执行：`cd apps/server && npx tsx scripts/repro-task01.ts`），
> 基于 makeEnv 测试工厂在临时目录 DB 上运行时验证；静态代码路径分析作为补充证据。
> 验收要求遵守：未复现的问题不标记为已修复；静态推断不写成运行审计结论。

## 汇总

| # | 问题 | 结论 |
|---|---|---|
| ① | 隐私页面在策略校验前已被读取/上传 | **确认缺陷** |
| ② | 收件箱提交浏览器书签 ID 无法匹配应用库 ID | **确认缺陷** |
| ③ | 域名规则命中后直接跳过内容分类 | **确认缺陷** |
| ④ | 整理应用/回滚/合并产生部分写入或关联数据丢失 | **确认缺陷** |
| ⑤ | 新标签页断网后完全不可用 | **确认缺陷**（静态：代码无缓存路径，首屏必走 `/nav/data`） |
| ⑥ | captureMHTML 返回类型/权限/生命周期与代码假设不符 | **仍需验证**（需真实 Chrome/Edge，A4-3 探针） |
| ⑦ | 快照存储后能否重新打开 | 服务端链路**未复现问题**（回读一致）；但发现上传无 MHTML 格式校验（记为 A4-4 缺陷） |
| ⑧ | 非开发部署未认证访问 + Provider Key 泄露 | **两项均确认缺陷** |

## 逐项记录

### ① 隐私页面在策略校验前已被读取或上传

```text
环境：makeEnv 临时 DB（node:sqlite）；扩展端为静态代码路径分析
操作步骤：收藏 https://icbc.bank/login（内置隐私域名 *.bank）→ 扩展 saveFromTab() 流程
实际结果：background.ts 无任何隐私预检。顺序是 executeScript(captureInPage) 先读 DOM 正文
（innerText ≤20KB）→ POST /bookmarks → fire-and-forget POST /content/capture。
运行时验证：隐私正文随请求体到达服务端后返回 skippedPrivacy=true（服务端丢弃）。
即：正文已离开浏览器、已进入服务端进程内存，之后才被丢弃。
预期结果：捕获前读取本地隐私规则；读取正文前、上传前分别校验；敏感路径降级仅元数据
证据：repro-task01.ts repro1 输出；background.ts L44-76（captureInPage 先于一切校验）
结论：确认缺陷（对应 A1-2 改造）
```

### ② 收件箱提交的浏览器书签 ID 无法匹配应用库 ID

```text
环境：makeEnv 临时 DB
操作步骤：模拟扩展 flushInbox() 提交浏览器书签节点 ID ["389","412"] → POST /inbox/process
实际结果：返回 left=[{id:389,reason:not_in_inbox},{id:412,reason:not_in_inbox}]。
浏览器节点 ID 在应用库中不存在，静默丢弃。原生拖入收件箱的书签永远不会被整理。
预期结果：先建立 device_id+browser_bookmark_id → app_bookmark_id 映射，再提交应用库 ID
证据：repro-task01.ts repro2 输出；background.ts L171-192（ids 直接来自浏览器事件）
结论：确认缺陷（对应 A2-1/A2-2）
```

### ③ 域名规则命中后直接跳过内容分类

```text
环境：makeEnv + chatJson 计数 mock LLM
操作步骤：收件箱加入书签「一篇关于烹饪的笔记」（github.com URL，正文缓存=红烧肉做法）
→ POST /inbox/process
实际结果：rule.source=domain_map（confidence 0.85 ≥ AUTO_MOVE_CONFIDENCE 0.8）直接移入
「开发」目录；llm.chatJson 调用次数=0。内容语义从未参与判定。
预期结果：域名规则只做首轮粗判，内容可用时优先内容语义（B3）
证据：repro-task01.ts repro3 输出；pipeline.ts L218-233（domain_map 命中即 move+continue）
结论：确认缺陷（对应 B3）
```

### ④ 整理应用/回滚/合并产生部分写入或关联数据丢失

```text
环境：makeEnv 临时 DB
操作步骤：两条同域同名书签（被合并方有正文缓存）→ 合并重复提案 → apply → rollback
实际结果：回滚后 bookmarks 行已恢复，但 content_cache 已被 ON DELETE CASCADE 级联删除，
getCache=undefined。OrganizeService.apply() 逐条执行无事务包裹；merge 走 deleteBookmark
硬删除。正文/摘要/向量关联永久丢失。
附带发现：同毫秒 added_at 的重复组排序是平局，合并保留方不确定（本轮脚本已用显式
added_at 消除不确定性，缺陷本身记入 A3-2 范围）。
预期结果：事务化应用（A3-3）；合并改软归档（A3-5）
证据：repro-task01.ts repro4 输出；organize.ts L275-284、store.ts L212-219
结论：确认缺陷
```

### ⑤ 新标签页断网后完全不可用

```text
环境：静态代码路径分析（E2E 离线场景待 B1 实现后补运行时验证）
操作步骤：断网状态打开新标签页
实际结果：newtab/main.tsx 首屏 useEffect 直接 api("/nav/data")，无任何本地缓存读取路径；
失败后仅渲染 error 文案。已收藏的导航入口完全不可用。
预期结果：本地保存最后有效导航数据，首屏先读缓存再后台刷新（B1）
证据：newtab/main.tsx L23-27（无 storage 读取分支）
结论：确认缺陷（静态；对应 B1）
```

### ⑥ captureMHTML 真实返回类型/权限/生命周期

```text
环境：需真实 Chrome/Edge 浏览器
操作步骤：（待执行）普通页/登录页/失败页分别调用 chrome.pageCapture.captureMHTML
实际结果：代码假设返回 string 并 new Blob([data]).arrayBuffer()。wxt/browser shim 未实现
pageCapture，代码已直接用 chrome 命名空间。真实返回类型（Chrome ≥117 为 string/base64?）、
权限要求、生命周期未在真实浏览器验证。
预期结果：A4-3 完成真实兼容性探针后再定论
证据：background.ts L118-125；技术方案 §10 遗留核对项
结论：仍需验证（A4-3 探针任务内闭环，mock 测试不替代）
```

### ⑦ 快照存储并重新打开（服务端链路）

```text
环境：makeEnv 临时 DB
操作步骤：上传 67B MHTML → GET /snapshots/:id
实际结果：HTTP 200，正文回读一致。服务端存储/回读链路本身可用。
附带发现：POST /snapshots 未做 MHTML 格式校验（任意字节可存为 .mhtml 且计为成功）；
GET /snapshots/:id 无认证检查时的行为取决于 ADMIN_PASSWORD（见⑧）。
预期结果：捕获失败或文件不完整时不能记录为成功（A4-4）
证据：repro-task01.ts repro7 输出；app.ts L613-652
结论：服务端链路未复现问题；格式校验缺失记为 A4-4 缺陷
```

### ⑧ 非开发部署未认证访问 + Provider Key 泄露

```text
环境：makeEnv（不设 ADMIN_PASSWORD / 设 ADMIN_PASSWORD 两种）
操作步骤 a：无凭据 GET /api/v1/bookmarks
实际结果 a：HTTP 200。auth.ts mountAuth 仅在设置密码时挂载；生产容器漏配 ADMIN_PASSWORD
则全部 API（含删除、配置）裸奔。无"非开发部署首启强制设置凭据"门槛。
操作步骤 b：POST /settings/providers 保存 apiKey → 查 DB
实际结果 b：api_key 明文落库（sk-real-***）。listProviderConfigs() 回显已脱敏、
/export/json 不含该表——展示面无泄露；但明文落盘违反 A4-2。
预期结果：A4-1 强制凭据门槛；A4-2 部署密钥加密落库
证据：repro-task01.ts repro8 输出；auth.ts L31-40；store.ts L580-595
结论：两项均确认缺陷
```

## 复现脚本维护说明

- 脚本位置：`apps/server/scripts/repro-task01.ts`，可用 `npx tsx` 直接运行，不进 vitest 套件（它输出人读报告，断言职责归正式测试）。
- 本记录的缺陷将在对应任务（A1/A2/A3/A4/B1/B3）修复后，由该任务的自动化测试取代复现脚本作为回归防线。
