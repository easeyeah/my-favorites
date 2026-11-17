/** TASK-02 样本库完整性自检：覆盖度、脱敏、无重复 */
import { describe, expect, it } from "vitest";
import { canonicalizeUrl } from "./url";
import { EVAL_SAMPLE_LIBRARY, toIngestJson } from "./eval-samples";

describe("样本库覆盖度（TASK-02 清单）", () => {
  const lib = EVAL_SAMPLE_LIBRARY;

  it("规模达标：分类样本 100–200 条（当前任务要求首版 100–200）", () => {
    expect(lib.classify.length).toBeGreaterThanOrEqual(100);
    expect(lib.classify.length).toBeLessThanOrEqual(200);
  });

  it("同域不同主题：github.com/bilibili.com/zhihu.com 各有≥2 个不同主题答案", () => {
    const domains = ["github.com", "bilibili.com", "zhihu.com"];
    for (const domain of domains) {
      const samples = lib.classify.filter(
        (s) => canonicalizeUrl(s.url)?.registrableDomain === domain,
      );
      expect(samples.length).toBeGreaterThanOrEqual(2);
      const catSets = samples.map((s) => s.acceptableCategories.join("|"));
      expect(new Set(catSets).size).toBeGreaterThanOrEqual(2); // 至少两种不同归类
    }
  });

  it("多级目录（≥3 级）与同名目录均有样本", () => {
    expect(lib.classify.some((s) => s.folderPath.length >= 3)).toBe(true);
    const names = lib.classify.flatMap((s) => s.folderPath);
    const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupNames.length).toBeGreaterThan(0); // 存在同名目录
  });

  it("中文、英文、超长标题、无标题样本齐全", () => {
    expect(lib.classify.some((s) => /[\u4e00-\u9fa5]/.test(s.title))).toBe(true);
    expect(lib.classify.some((s) => /^[a-zA-Z0-9 .:-]+$/.test(s.title))).toBe(true);
    expect(lib.classify.some((s) => s.title.length > 100)).toBe(true);
    expect(lib.classify.some((s) => s.title === "Untitled")).toBe(true);
  });

  it("hash 路由、业务参数、相似 URL 样本齐全", () => {
    expect(lib.classify.some((s) => s.url.includes("#/"))).toBe(true);
    expect(lib.classify.some((s) => /[?&](id|orderId)=/.test(s.url))).toBe(true);
    // 相似但不同：同 registrableDomain 同路径前缀、末段不同
    const similar = lib.classify.filter((s) => s.id.startsWith("cls-similar"));
    expect(similar.length).toBeGreaterThanOrEqual(3);
  });

  it("登录页、内网、隐私域、正文提取失败样本齐全", () => {
    expect(lib.classify.some((s) => s.notes?.includes("登录墙") || s.title.includes("登录墙"))).toBe(true);
    expect(lib.classify.some((s) => /\.(local|internal)\b/.test(s.url) || /192\.168\./.test(s.url))).toBe(true);
    expect(lib.safety.some((s) => s.kind === "privacy_domain")).toBe(true);
    expect(lib.classify.some((s) => s.notes?.includes("正文提取失败"))).toBe(true);
  });

  it("场景样本覆盖六个维度（重复事件/断网重试/SW重启/过期提案/快照恢复/手动移出）", () => {
    const dims = new Set(lib.scenario.map((s) => s.dimension));
    for (const need of [
      "duplicate_event",
      "offline_retry",
      "sw_restart",
      "stale_proposal",
      "snapshot_restore",
      "user_manual_move",
    ]) {
      expect(dims.has(need as ScenarioDim)).toBe(true);
    }
  });

  it("搜索样本记录意图与目标链接；干扰项不误吞", () => {
    expect(lib.search.length).toBeGreaterThanOrEqual(10);
    for (const s of lib.search) {
      expect(s.intent.length).toBeGreaterThan(0);
      expect(s.targetUrls.length).toBeGreaterThan(0);
    }
    expect(lib.search.some((s) => (s.mustNotMatchUrls?.length ?? 0) > 0)).toBe(true);
  });

  it("安全与一致性样本结果唯一确定（expected 非空且无多解）", () => {
    for (const s of lib.safety) {
      expect(s.expected.length).toBeGreaterThan(10);
      expect(s.expected).not.toMatch(/[?？]\s*或/); // 不允许"或"式不确定结果
    }
  });
});

describe("样本库脱敏红线（不提交真实隐私正文、凭据、密钥、令牌）", () => {
  const lib = EVAL_SAMPLE_LIBRARY;
  const allText = JSON.stringify(lib);

  it("URL 不含凭据形态（user:pass@、token=、apikey=、sk- 开头键值）", () => {
    expect(allText).not.toMatch(/[a-z0-9]+:[a-z0-9]+@/i);
    expect(allText).not.toMatch(/(token|apikey|api_key|secret)=/i);
    expect(allText).not.toMatch(/sk-[a-zA-Z0-9]{16,}/);
  });

  it("摘要/标题不含真实隐私正文（银行卡号/手机号形态）", () => {
    expect(allText).not.toMatch(/\b6222\d{12,}\b/); // 银联卡号形态
    expect(allText).not.toMatch(/\b1[3-9]\d{9}\b/); // 手机号形态
  });

  it("全部为 example/example-*. 合成域或知名公共站，无真实私人域名", () => {
    const urls = [
      ...lib.classify.map((s) => s.url),
      ...lib.safety.map((s) => s.url),
    ];
    // 私人域名判定：不属于知名公共站且不属于 example 系合成域 → 列出来人工核对为空
    // 注意 registrableDomain 是“末两级”启发式：webpack.js.org→js.org、music.163.com→163.com
    // 因此白名单同时匹配 registrableDomain 与完整 host
    const PUBLIC = new Set([
      "github.com", "gitlab.com", "stackoverflow.com", "developer.mozilla.org", "mozilla.org",
      "npmjs.com", "vercel.com", "cloudflare.com", "rust-lang.org", "golang.org",
      "python.org", "nodejs.org", "figma.com", "dribbble.com", "behance.net",
      "youtube.com", "bilibili.com", "iqiyi.com", "douyin.com", "netflix.com",
      "wikipedia.org", "zhihu.com", "juejin.cn", "medium.com", "notion.so",
      "twitter.com", "x.com", "weibo.com", "reddit.com", "v2ex.com",
      "taobao.com", "jd.com", "amazon.com", "amazon.cn", "smzdm.com",
      "canva.com", "excalidraw.com", "react.dev", "kubernetes.io", "tailwindcss.com",
      "typescriptlang.org", "huggingface.co", "arxiv.org", "caniuse.com", "codepen.io",
      "coolors.co", "music.163.com", "163.com", "open.spotify.com", "spotify.com",
      "movie.douban.com", "book.douban.com", "douban.com", "weread.qq.com", "qq.com",
      "icourse163.org", "coursera.org",
      "leetcode.cn", "runoob.com", "webpack.js.org", "js.org", "vitejs.dev", "docker.com",
      "terraform.io", "prometheus.io", "grafana.com", "cnblogs.com",
      "segmentfault.com", "infoq.cn", "css-tricks.com", "web.dev", "obsidian.md",
      "imdb.com", "news.ycombinator.com", "ycombinator.com", "ruanyifeng.com", "jiqizhixin.com",
      "dianping.com", "ctrip.com", "amap.com", "stackexchange.com",
      "sqlite.org", "postgresql.org", "redis.io", "nginx.org",
    ]);
    const suspicious = urls.filter((u) => {
      const parsed = canonicalizeUrl(u);
      if (!parsed) return false;
      return !PUBLIC.has(parsed.registrableDomain) && !PUBLIC.has(parsed.domain);
    });
    // 剩余必须全部是 example 系/保留域合成样本
    for (const u of suspicious) {
      expect(u).toMatch(/example|\.local|\.internal|\.bank|192\.168\.|localhost|127\.0\.0\.1|\.cn\.work|\.gov\.cn|\.org\.cn/);
    }
  });
});

describe("toIngestJson 导出可用性", () => {
  it("导出条目与分类样本一致且可被 ingest schema 约束", async () => {
    const { ingestRequest } = await import("./index");
    const json = toIngestJson();
    expect(json.items.length).toBe(EVAL_SAMPLE_LIBRARY.classify.length);
    const parsed = ingestRequest.safeParse(json);
    expect(parsed.success).toBe(true);
  });
});

type ScenarioDim =
  | "duplicate_event"
  | "offline_retry"
  | "sw_restart"
  | "stale_proposal"
  | "snapshot_restore"
  | "user_manual_move";
