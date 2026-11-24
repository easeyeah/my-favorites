# @mf/ai

## 0.1.1

### Patch Changes

- c1f1596: DEV 安全与一致性止血（DEV-01/02/03/04/05/08/13，2026-11-18）：公开分享收口、统一可见性、隐私失效保守策略、出站网络守卫、令牌生命周期、统一整理事务内核、保守 URL 键

  - DEV-01 导航站显式发布集合：发布必须选择书签/目录范围（默认私有，空范围拒绝），撤销发布，"将公开 N 项"计数；分享密码改 POST 验证 + 8h HMAC HttpOnly 凭证（绑定 slug+revision，改密/撤销即失效），`?p=` 查询参数通道移除；匿名全库搜索 `/s/search` 封堵为 410，公开搜索仅限单站集合（`/s/:slug/search`）；PATCH 以完整配置为基线（只改标题不再丢密码/模板）；slug 改加密随机源 + 冲突重试
  - DEV-02 可见性收口：`/content/:id` 先鉴权书签对象（私密与不存在同响应 404）；旧 `/snapshots/:id` 直读封堵 410（净化查看/受控下载为唯一通道）；关键词与语义搜索默认排除私密、语义搜索补软归档过滤；导出同边界
  - DEV-03 隐私失效策略：扩展端规则缓存状态化（unknown/fresh/stale/error）——仅 fresh 允许五动作，stale 时旧规则仍用于拒绝；缓存按服务端实例隔离；embedding 入口统一走隐私策略；LLM 等待返回后提交前重验规则修订与实体状态（过期结果丢弃 `stale_policy_discarded`）；规则变更清理覆盖软归档 + 游标分页不截断 + 文件删除失败入 `pending_snapshot_deletions` 台账重试
  - DEV-04 出站网络守卫：`guardedFetch` 重写——IPv6 全形态精确判定（压缩/mapped/NAT64/fe80::/10/ULA/组播），连接固定到已校验地址（消除 DNS rebinding 窗口，保留 Host/SNI），响应体读取期字节上限 + 总时长预算，跨主机重定向剥离凭据；维护死链探测与 crawl 统一接入守卫；隐私域书签不自动探测；LLM 客户端手动跟随重定向（Key 不外送其他端点）
  - DEV-05 认证/令牌：管理员令牌只存 SHA-256 摘要（32 字节随机值，响应一次可见），新增非密 token_id + 到期 + 撤销 + last_used；列表按 ID 撤销、logout 摘要撤销；生产语义首启 setup 需部署引导凭据（MF_SETUP_TOKEN 或自动生成 dataDir/bootstrap-token.txt，一次性、原子幂等）；env/DB 两种登录模式统一限速（不信任 X-Forwarded-For，除 MF_TRUST_PROXY=1）；CORS 改来源白名单（MF_ALLOWED_ORIGINS）；密码哈希提取独立模块（消除 app↔security 循环依赖）
  - DEV-08 统一整理事务内核：move 提案携带 plannedFolderId（同名目录按 ID 区分）；提交短事务逐项重查（revision/隐私/私密/目标存在/inbox 归属），镜像操作与实体/版本同事务入队（崩溃无空窗）；apply 幂等（重试返回原版本）；撤销生成 undo 新版本（reverts_version_id）+ 反向镜像同事务入队 + 取消待执行旧操作；偏好统计只计实际采纳动作
  - DEV-13 保守 URL 键（规则 v2）：保留原 scheme、www、hash 路由、非默认端口、业务/签名参数；只删已验证纯 tracking（ref/share_token/st/si 不再全局删除）；产出 similarKey 相似键（仅供「疑似重复」建议参考，永不自动合并；建议展示面接线随后续切片）；迁移 v4 复用 shared canonicalizeUrl 以 raw 重算存量键，碰撞保留全部实体并出报告；抓取/探测地址改用原始 URL
  - Web 管理台：发布范围多选 + 未发布状态标识 + 撤销发布；设置页令牌列表/按 ID 撤销/退出登录；扩展新标签页搜索改走已鉴权 API（不再打开匿名搜索页）
  - 迁移 v4–v7：url_key_version、nav_site 发布集合表、令牌摘要化（存量明文一次性迁移）、撤销版本与清理台账

- 9fc005b: D43 · 敏感内容自动旁路（2026-11-20）：真实库存成人类条目导致供应商内容审核**整包拒收**整理批次且错误被静默吞掉——三层工程规避（不外发、不误伤功能、不误发布）。① `packages/shared` 新增 `sensitive.ts` 敏感宿主启发式（纯数据词表 + `isSensitiveHost` + `PRIVATE_FOLDER_NAME`），整理建批前命中项不进 LLM；`OrganizeAction` 联合新增 `markPrivate`。② `packages/ai`：llm-client 非 2xx 透出供应商错误体（`providerDetail`）+ `isLlmContentModeration` 审核类识别。③ `apps/server`：`classifyPending` 审核失败二分隔离（肇因项标私密跳过，调用预算封顶防雪崩）；apply/rollback 补 markPrivate 分支（版本守卫 + 反向镜像 + 幂等）；新端点 `POST /tidy/sensitive` 全库一键旁路（单事务标私密 + 移入「私人收藏」+ 镜像入队 + 版本可撤销，零删除）。④ `apps/web`：整理页功能点行「敏感内容旁路」（点了就跑 + 结果直显 + 撤销这批）；书签库「显示私密」开关（`X-MF-Private` 请求头透传，localStorage 持久，列表/搜索/目录树一致边界）；mock 同步覆盖。走查：单测/集成 147 + shared 87 + ai 7 + E2E 21 过 1 跳。
- Updated dependencies [9fc005b]
- Updated dependencies [c1f1596]
- Updated dependencies [0bd795b]
- Updated dependencies [9fc005b]
- Updated dependencies [c1f1596]
- Updated dependencies [c1f1596]
- Updated dependencies [9fc005b]
- Updated dependencies [c1f1596]
- Updated dependencies [9fc005b]
  - @mf/shared@0.2.0
