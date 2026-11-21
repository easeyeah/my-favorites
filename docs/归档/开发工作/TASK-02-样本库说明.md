# TASK-02 脱敏评测样本库使用说明（2026-11-17）

> 位置：`packages/shared/src/eval-samples.ts`（代码即数据，带类型与自检）
> 自检测试：`packages/shared/src/eval-samples.test.ts`（13 项覆盖度/脱敏校验，进 `pnpm test` 套件）

## 构成

| 类别 | 数量 | 用途 |
|---|---|---|
| 分类样本 `classify` | 104 | QA-1 分类回归 / QA-2 真实模型质量抽查；每条含 `acceptableCategories`（多合理答案）与 `contentSummary`（内容信号） |
| 搜索样本 `search` | 12 | 找回评测；记录 `intent`（想找什么）、`query`、`targetUrls`、`mustNotMatchUrls`（干扰项） |
| 安全样本 `safety` | 8 | 隐私域/内网/登录页/去重身份；`expected` 唯一确定 |
| 场景样本 `scenario` | 10 | 重复事件/断网重试/SW 重启/过期提案/快照恢复/手动移出 |

## 覆盖维度（对应任务清单）

- 同域不同主题：github.com×3、bilibili.com×2、zhihu.com×2、medium.com（规则未收录域）
- 多级目录：最深 4 级（开发/前端/React/官方文档）；同名目录：`接入指南` 在两个不同父目录下
- 中文/英文/超长标题（>512 截断边界）/无标题（Untitled）
- hash 路由（`#/detail/1001` vs `1002`）、业务参数（`orderId=A-2026-001/002`）、相似 URL 三连（v2/v3/migration）
- 登录页、内网页（.local/.internal/192.168.1.10）、隐私域（.bank）、正文提取失败（SPA/结果页/期刊/法条）
- 用户固定归类优先样本（youtube.com 的学习直播→学习专注；github.com 的公司手册→工作）

## 脱敏红线（自检强制）

- 全部 URL 为 example 系合成域、保留域（.local/.internal/.bank）或知名公共站点（白名单见测试）
- 无 `user:pass@`、`token=`、`apikey=`、`sk-*` 形态；无银行卡号/手机号形态
- 知名公共站仅用其首页级/合成路径，不含真实用户内容

## 使用方式

```bash
# 单测（含样本库自检）
pnpm --filter @mf/shared test

# 导出为 ingest 批次 JSON（喂给 POST /api/v1/bookmarks/ingest）
# packages/shared 导出 toIngestJson()；server 侧直接 import { EVAL_SAMPLE_LIBRARY } from "@mf/shared"
```

- **QA-1 确定性回归**：分类/安全/场景样本驱动 vitest（mock LLM）；B3/B4-3 任务实现后应把
  `classify` 样本接入"规则版 vs 内容版"对比断言，`safety` 样本接入隐私链路测试。
- **QA-2 真实抽查**：`classify` 样本 + `toIngestJson()` 灌库后调真实模型，记录模型名/版本/成本/差异；
  不把 mock 通过写成真实分类质量达标。

## 维护

- 新增样本先跑自检（覆盖度/脱敏两条红线会拦截违规样本）。
- 分类答案变化（目录重命名等）改 `acceptableCategories`，不改历史评测记录。
