# A4-3 pageCapture 真实兼容性探针（待真实执行）

> 状态：**仍需真实环境验证**（TASK-01 ⑥ 的结论延续）。本文档是探针执行手册，不是完成结论。
> 已完成的代码侧防御：`background.ts` 快照上传前按 base64 解码并做 MHTML 头探测，
> 服务端 `/snapshots` 上传做格式 magic 校验（`invalid_mhtml_format`）——双保险已进自动化测试。

## 为什么必须真实验证

- `chrome.pageCapture.captureMHTML` 的回调数据形态（base64 vs 明文）、权限行为、
  受限页面（chrome://、Web Store）与登录页的返回，文档与 shim 存在差异；
- mock 测试与上传接口测试**不能替代**真实捕获（开发工作单明确要求）。

## 探针步骤（Chrome 与 Edge 各一轮）

1. `pnpm --filter extension build && pnpm --filter @mf/e2e test -- --grep snapshot`
   （探针用例：`apps/e2e/tests/snapshot-probe.spec.ts`，加载真实扩展，捕获真实页面）
2. 测试矩阵：

| 场景 | 页面 | 期望 |
|---|---|---|
| 普通页 | https://example.com | MHTML 头探测通过、上传成功、/view 净化视图可渲染 |
| 中文内容页 | https://zh.wikipedia.org | quoted-printable 中文解码正确 |
| 登录墙页 | https://github.com/login | 捕获登录页 DOM（用户已登录时含敏感内容）→ 隐私规则验证 |
| 受限页 | chrome://settings | captureMHTML 报错/空 → 不记录成功 |
| 隐私域页 | 内置 *.bank 站点 | 扩展端捕获前拦截（decidePrivacy），无网络请求 |

3. 记录模板（追加到本文件下方）：

```text
浏览器/版本：
场景 / 结果（捕获返回形态、大小、view 渲染、上传状态码）：
与代码假设的差异：
需要的修正：
```

## 已知代码假设（探针要验证的点）

- 回调 `data` 为 base64 字符串（Chrome ≥117 文档口径）；
- 解码后 200 字节内能探测到 `Content-Type: multipart` 或 `MIME-Version` 头；
- 失败时回调无参（`data === undefined`）且 `lastError` 置位；
- 权限：manifest 已含 `pageCapture`（wxt.config.ts permissions）。

## 执行记录

（真实执行后追加；未执行前本节保持为空，不得预填"通过"。）
