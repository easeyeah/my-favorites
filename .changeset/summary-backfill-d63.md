---
"@mf/server": patch
---

D63 · capture 摘要兜底补扫（2026-11-21）：修正 D62 盘点误判并补齐兜底。复核推翻原判——async 模式下 `maybeSummarize` 本就 `void run()` 立即返回（`MF_SYNC_AI=1` 仅测试确定性），生产收藏响应不等 LLM；真缺口是异步规范③的兜底缺失：① fire-and-forget 在途摘要遇进程重启永久丢失；② `fail_reason='llm_unavailable'` 永不重试；③ call_model 隐私拒绝不落原因。落地：`store.bookmarksMissingSummary`（有正文 ≥40 字缺 L1；`llm_unavailable`/`stale_policy_discarded` 可重试、`privacy_*` 不重试）+ `pipeline.backfillSummaries`（≤5 条涓流踢摘要，无 LLM 配置零开销返回 0）+ `maintenance.startSummaryBackfill` 常驻（启动即跑 + 每 30 分钟，仿 D58 `startRetentionPrune` 不挂可选开关——D57 教训：自动承诺必须有兜底定时器）+ call_model 拒绝落 `failReason='privacy_call_model_denied'`。教训：**「await 了内部 void run 的函数」≠阻塞，判读阻塞先看被调方当前模式是否同步执行**。走查：server 192(+5：fire-and-forget 回归锁/补扫找回/无 LLM 零开销/隐私拒绝不重试且留痕/私密不进候选) + shared 96 + E2E 35 全绿；真实容器端到端（抹掉力扣 L1 制造候选 → 重启 → `kicked 1` → DeepSeek 重新生成且 fail_reason 清空）。
