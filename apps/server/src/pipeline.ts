/**
 * 智能流水线：即时归位建议（F1.4）、收件箱归位（F1.5）、内容捕获与摘要（F2）
 *
 * 分类三级信号：domain_cache（命中过的域名缓存，<50ms 零成本）
 *             → 规则引擎（shared，确定性）
 *             → LLM（批量、内容级，兜底）
 * 隐私校验在任何抓取/AI 调用前强制执行（AGENTS.md 红线 2）。
 */
import {
  AUTO_MOVE_CONFIDENCE,
  canonicalizeUrl,
  checkPrivacy,
  classifyByRules,
  classifyMaterialKind,
  isPrivacyDomain,
  MATERIAL_ARTICLE_MIN_TEXT,
  type PrivacyRules,
} from "@mf/shared";
import type { LlmClient } from "@mf/ai/llm-client";
import type { Store, MaterialConversionCandidate } from "./store";
import { enqueueMirrorMoves } from "./organize";
import { fetchMaterialCover, saveCoverFile } from "./materials";
import { guardedFetch, fetchGuardConfigFromEnv, type FetchGuardConfig } from "./fetch-guard";
import { currentUserId, runAsUser } from "./tenancy";

export interface SuggestResult {
  category: string;
  confidence: number;
  source: "domain_cache" | "domain_map" | "keyword" | "none";
  folderId: string | null;
  folderPath: string[];
  privacy: boolean;
}

/** 封面抓取函数签名（fetchMaterialCover 的注入缝：测试替身用） */
export type CoverFetcher = (
  url: string,
  guard?: FetchGuardConfig,
) => Promise<{ buf: Buffer; mime: string } | null>;

/** 补抓函数签名（crawlOne 的注入缝：测试替身用——隐私判定仍在 fetch 之前，注入不放宽红线） */
export type CrawlFetcher = (
  url: string,
  guard?: FetchGuardConfig,
) => Promise<{
  ok: boolean;
  status: number;
  readBody: (max: number) => Promise<Buffer>;
  dispose: () => void;
}>;

/** D89 目录资料扫描的单条结果（SSE item 事件与最终汇总共用） */
export interface MaterialScanItem {
  id: string;
  title: string;
  url: string;
  status: "created" | "not_content" | "failed";
  /** failed 时的原始原因（cache.fail_reason / crawl 错误）；not_content 时为判定依据码 */
  reason?: string;
}

/** D89 目录资料扫描汇总：failed 即「建议丢弃」清单来源（只建议，不自动删除） */
export interface MaterialScanResult {
  total: number;
  processed: number;
  created: number;
  notContent: number;
  /** 隐私/私密跳过数（永不抓取，也不进丢弃清单） */
  skipped: number;
  failed: Array<{ id: string; title: string; url: string; reason: string }>;
  /** 本次上限之外的剩余候选条数（UI 提供「继续扫描」） */
  remaining: number;
}

/** D77：分类自检移动阈值——比归位（0.6/0.8）更保守：已归位条目搬家更打扰，
 *  只有「明显更合适」才动；且只移入现有目录，永不新建 */
const REVIEW_MOVE_CONFIDENCE = 0.85;

const CONTENT_PAGE_PROMPT =
  '判断每个网页是否值得作为「资料」收藏：文章/教程/文档/报告/深度阅读等有实质内容的页面 material=true；工具首页/导航站/登录页/搜索结果/列表页/论坛首页等内容壳 material=false。只返回 JSON：{"results":[{"index":0,"material":true}]}。';

export class Pipeline {
  constructor(
    private store: Store,
    private llmFor: (purpose: "organize" | "summarize" | "embedding") => LlmClient | null,
    private opts: {
      syncAi?: boolean;
      dataDir?: string;
      guardConfig?: FetchGuardConfig;
      /** 测试缝：默认真实出站 fetchMaterialCover（loopback 属内置隐私域，集成测试注入替身） */
      coverFetcher?: CoverFetcher;
      /** 测试缝：默认真实出站 guardedFetch（crawlOne 用；隐私判定前置不因注入放宽） */
      crawlFetcher?: CrawlFetcher;
    } = {},
  ) {}

  privacyCheck(url: string): boolean {
    return isPrivacyDomain(url, { patterns: this.store.privacyPatterns() });
  }

  /** 测试确定性开关：MF_SYNC_AI=1 时异步链路（摘要/资料库物化）在请求内等待完成 */
  get syncMode(): boolean {
    return this.opts.syncAi === true;
  }

  /** A1-1/A1-3：服务端侧统一策略判定（不信任客户端"已经检查"声明） */
  private serverRules(): PrivacyRules {
    const { patterns, revision } = this.store.privacyRules();
    return { patterns, revision };
  }

  serverDecide(
    action: "upload_content" | "call_model" | "server_fetch" | "snapshot",
    url: string,
    opts: { isPrivateBookmark?: boolean } = {},
  ) {
    return checkPrivacy(action, url, this.serverRules(), opts);
  }

  /** F1.4 即时归位：仅缓存+规则（<50ms 路径，不调 LLM） */
  suggest(url: string, title: string): SuggestResult {
    const privacy = this.privacyCheck(url);
    const parsed = canonicalizeUrl(url);
    if (!parsed) {
      return {
        category: "未分类",
        confidence: 0,
        source: "none",
        folderId: null,
        folderPath: [],
        privacy,
      };
    }
    if (privacy) {
      // 隐私域名：只存 URL，不做任何分类外推
      return {
        category: "隐私",
        confidence: 1,
        source: "none",
        folderId: null,
        folderPath: [],
        privacy,
      };
    }

    // ① domain_cache
    const cached = this.store.lookupDomain(parsed.registrableDomain);
    if (cached) {
      const folder = this.store.findFolderByName(cached);
      return {
        category: cached,
        confidence: 0.9,
        source: "domain_cache",
        folderId: folder?.id ?? null,
        folderPath: folder ? [folder.name] : [],
        privacy,
      };
    }

    // ② 规则引擎
    const rule = classifyByRules(parsed.registrableDomain, title);
    if (rule.source === "domain_map") {
      this.store.bumpDomain(parsed.registrableDomain, rule.category);
      const folder = this.store.findFolderByName(rule.category);
      return {
        category: rule.category,
        confidence: rule.confidence,
        source: "domain_map",
        folderId: folder?.id ?? null,
        folderPath: folder ? [folder.name] : [rule.category],
        privacy,
      };
    }
    return {
      category: rule.category,
      confidence: rule.confidence,
      source: rule.source,
      folderId: null,
      folderPath: [],
      privacy,
    };
  }

  /** 内容捕获（F2.1 通道A 上行）：隐私校验 → 截断 → 存储 → （可选）AI 摘要 → （D61）资料库识别入库 */
  async capture(input: {
    bookmarkId: string;
    l2Text?: string;
    description?: string;
    faviconDataUrl?: string;
    ogImage?: string;
    urlForPrivacyCheck: string;
  }): Promise<{ summarized: boolean; skippedPrivacy?: boolean; skipReason?: string }> {
    // A1-3 服务端纵深校验：独立判定，不信任扩展端"已检查"（扩展端校验是第一道，这是第二道）
    const bm = this.store.getBookmark(input.bookmarkId);
    const decision = checkPrivacy(
      "upload_content",
      input.urlForPrivacyCheck,
      this.serverRules(),
      { isPrivateBookmark: bm?.is_private === 1 },
    );
    if (!decision.allowed) {
      this.store.upsertCache({
        bookmarkId: input.bookmarkId,
        fetchedVia: "extension_capture",
        failReason: `privacy_${decision.reason}`,
      });
      return { summarized: false, skippedPrivacy: true, skipReason: decision.reason };
    }
    // 红线：正文截断 20KB（技术方案 §7.2）
    const l2 = input.l2Text?.slice(0, 20_000) ?? null;
    this.store.upsertCache({
      bookmarkId: input.bookmarkId,
      l2Text: l2,
      fetchedVia: "extension_capture",
    });
    if (input.description) {
      const bm = this.store.getBookmark(input.bookmarkId);
      if (bm && !bm.description) {
        this.store.updateBookmark(input.bookmarkId, { description: input.description });
      }
    }
    if (input.faviconDataUrl) {
      this.store.updateBookmark(input.bookmarkId, { favicon_url: input.faviconDataUrl });
    }
    this.store.rebaseMaterialCandidate(input.bookmarkId, bm?.content_revision ?? 1);
    if (l2) this.store.authorizeMaterialCandidateText(input.bookmarkId, l2);
    const candidate = this.store.getMaterialCandidate(input.bookmarkId);
    if (!candidate) {
      if (this.opts.syncAi) await this.materialize(input.bookmarkId, input.ogImage);
      else void this.materialize(input.bookmarkId, input.ogImage);
    }
    const summarized = await this.maybeSummarize(input.bookmarkId);
    return { summarized };
  }

  /**
   * D61 资料库入库：三级识别（shared classifyMaterialKind，纯规则）+ 条目覆盖式维护。
   *  - 文章仅在已存全文（l2_text ≥ 阈值）时显性化入库；视频/图片无条件入库（视频不下载本体）；
   *  - 隐私域名/私密书签不入内容库（与「隐私条目仅存 URL」原则一致）；
   *  - 封面下载是 server_fetch 出站动作，独立隐私判定后异步执行（不阻塞捕获链路）。
   */
  async materialize(
    bookmarkId: string,
    ogImage?: string,
    opts: { awaitCover?: boolean } = {},
  ): Promise<void> {
    const bm = this.store.getBookmark(bookmarkId);
    if (!bm || bm.archived_into) return;
    if (bm.is_private === 1 || this.privacyCheck(bm.url_raw)) return;
    const cls = classifyMaterialKind(bm.url_canonical);
    if (!cls) return;
    const cache = this.store.getCache(bookmarkId);
    const l2 = typeof cache?.l2_text === "string" ? (cache.l2_text as string) : "";
    if (cls.kind === "article" && l2.length < MATERIAL_ARTICLE_MIN_TEXT) return;
    const meta: Record<string, unknown> = {};
    if (l2) meta.textLen = l2.length;
    this.store.upsertMaterial({ bookmarkId, type: cls.kind, signals: cls.signals, meta });
    // 封面线索：图片条目 = URL 本体；视频/文章 = og:image（扩展捕获上行）
    const coverSource = cls.kind === "image" ? bm.url_raw : ogImage;
    if (coverSource) {
      // D89 目录扫描：串行链路内 await 封面，避免一批图片同时起 N 个出站请求（D60 并发闸口径）
      if (opts.awaitCover) await this.fetchCover(bookmarkId, coverSource);
      else void this.fetchCover(bookmarkId, coverSource);
    }
  }

  /** 封面下载落盘（网络执行者；server_fetch 策略判定在此前置——不信任任何上游"已检查"声明） */
  private async fetchCover(bookmarkId: string, coverUrl: string): Promise<void> {
    if (!this.opts.dataDir) return;
    const decision = checkPrivacy("server_fetch", coverUrl, this.serverRules(), {});
    if (!decision.allowed) return;
    const got = await (this.opts.coverFetcher ?? fetchMaterialCover)(coverUrl, this.opts.guardConfig);
    if (!got) return;
    const row = this.store.getMaterialByBookmark(bookmarkId);
    if (!row) return;
    const rel = saveCoverFile(this.opts.dataDir, row.id, got.buf, got.mime);
    if (rel) {
      this.store.setMaterialCover(row.id, { mime: got.mime, size: got.buf.length, url: coverUrl, relPath: rel });
    }
  }

  // ==================== D89 目录级「内容页转资料」扫描 ====================

  /**
   * 目录资料扫描（用户显式发起、可中止）：把目录（默认含子目录）内的内容型书签
   * 抓正文入资料库，失败条目进「建议丢弃」清单（只出建议，不自动删除——红线③）。
   *
   * 单条流程：隐私/私密 → skipped（永不抓取）；视频/图片 → 直接物化；
   * 文章候选 → crawlOne 补抓（失败 → failed + 原因落 cache.fail_reason），
   * 正文 ≥ MATERIAL_ARTICLE_MIN_TEXT 后按批判定「是否内容型页面」（无 LLM 时按
   * 正文 ≥ 800 字规则兜底），是 → 物化，否 → not_content（书签保持不动）。
   *
   * D62：串行抓取（天然并发闸 ≤1）、单次上限 limit、断开即停（onItem 返回 false）、
   * 每条结果实时回调（SSE 逐条进度）。
   */
  async scanFolderForMaterials(
    folderId: string,
    opts: {
      includeSubfolders?: boolean;
      limit?: number;
      onItem?: (item: MaterialScanItem, done: number, total: number) => boolean | void;
    } = {},
  ): Promise<MaterialScanResult> {
    const folder = this.store.getFolder(folderId);
    if (!folder || folder.is_system_inbox === 1) throw new Error("folder_not_found");
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 30), 1), 60);
    const ids = opts.includeSubfolders === false ? [folderId] : this.store.folderSubtreeIds(folderId);
    const rows = this.store.listBookmarks({ folderIds: ids, limit: 100_000 });

    let skipped = 0;
    const candidates: typeof rows = [];
    for (const bm of rows) {
      // 已归档条目是用户主动收起的，不抓取也不计入隐私跳过
      if (bm.status === "archived") continue;
      // 隐私/私密永不抓取，也不进丢弃清单（不是「失败」，红线②）
      if (bm.is_private === 1 || this.privacyCheck(bm.url_raw)) {
        skipped += 1;
        continue;
      }
      // 已有资料条目：无需再扫（dismissed 是用户显式移出——不复活，也不反复抓）
      if (this.store.getMaterialByBookmark(bm.id)) continue;
      candidates.push(bm);
    }
    const take = candidates.slice(0, limit);
    const result: MaterialScanResult = {
      total: take.length,
      processed: 0,
      created: 0,
      notContent: 0,
      skipped,
      failed: [],
      remaining: 0,
    };

    let aborted = false;
    const report = (item: MaterialScanItem): boolean => {
      result.processed += 1;
      if (item.status === "created") result.created += 1;
      else if (item.status === "not_content") result.notContent += 1;
      else if (item.status === "failed")
        result.failed.push({
          id: item.id,
          title: item.title,
          url: item.url,
          reason: item.reason ?? "unknown",
        });
      if (opts.onItem?.(item, result.processed, result.total) === false) aborted = true;
      return !aborted;
    };

    // 已抓到足够正文的文章候选，统一批量判定（避免每条一发 LLM）
    const pendingJudge: Array<{ id: string; title: string; url: string; text: string }> = [];
    for (const bm of take) {
      if (aborted) break;
      const cls = classifyMaterialKind(bm.url_canonical);
      const base = { id: bm.id, title: bm.title, url: bm.url_canonical };
      if (!cls) {
        // 非 http/解析失败：明确不是资料，书签保持不动
        if (!report({ ...base, status: "not_content", reason: "invalid_url" })) break;
        continue;
      }
      if (cls.kind === "video" || cls.kind === "image") {
        await this.materialize(bm.id, undefined, { awaitCover: true });
        const made = this.store.getActiveMaterialByBookmark(bm.id);
        if (!report({ ...base, status: made ? "created" : "not_content" })) break;
        continue;
      }
      // article：已有全文（扩展就地捕获）则跳过抓取，否则服务端补抓
      const cache = this.store.getCache(bm.id);
      let text = typeof cache?.l2_text === "string" ? cache.l2_text : "";
      if (text.length < MATERIAL_ARTICLE_MIN_TEXT) {
        const crawled = await this.crawlOne(bm.id, { skipMaterialize: true });
        if (!crawled.ok) {
          const after = this.store.getCache(bm.id);
          const reason =
            typeof after?.fail_reason === "string"
              ? after.fail_reason
              : crawled.detail ?? crawled.reason ?? "crawl_failed";
          if (!report({ ...base, status: "failed", reason })) break;
          continue;
        }
        const after = this.store.getCache(bm.id);
        text = typeof after?.l2_text === "string" ? after.l2_text : "";
      }
      if (text.length < MATERIAL_ARTICLE_MIN_TEXT) {
        if (!report({ ...base, status: "not_content", reason: "content_too_thin" })) break;
        continue;
      }
      pendingJudge.push({ ...base, text });
    }

    if (!aborted && pendingJudge.length > 0) {
      await this.judgeAndMaterialize(pendingJudge, report);
    }

    result.remaining = Math.max(0, candidates.length - result.processed);
    return result;
  }

  /**
   * 内容型页面批量判定（≤10 条/次，只送标题/URL/正文前 400 字控制 token）。
   * 无 LLM 或调用失败：规则兜底（正文 ≥ 800 字视为内容页）——不因判定失败丢掉用户启动的任务。
   */
  private async judgeAndMaterialize(
    items: Array<{ id: string; title: string; url: string; text: string }>,
    report: (item: MaterialScanItem) => boolean,
  ): Promise<void> {
    const llm = this.llmFor("summarize");
    for (let i = 0; i < items.length; i += 10) {
      const chunk = items.slice(i, i + 10);
      let verdicts: boolean[];
      if (llm) {
        try {
          const out = await llm.chatJson<{
            results: Array<{ index: number; material: boolean }>;
          }>([
            {
              role: "system",
              content: CONTENT_PAGE_PROMPT,
            },
            {
              role: "user",
              content: JSON.stringify(
                chunk.map((it, idx) => ({
                  index: idx,
                  title: it.title,
                  url: it.url,
                  excerpt: it.text.slice(0, 400),
                })),
              ),
            },
          ]);
          const map = new Map<number, boolean>();
          for (const r of out.results ?? []) map.set(r.index, r.material === true);
          // 模型漏判的项按规则兜底，不默认丢为「非内容页」
          verdicts = chunk.map((it, idx) => map.get(idx) ?? it.text.length >= 800);
        } catch (err) {
          console.warn("[material-scan] judge failed:", String(err).slice(0, 120));
          verdicts = chunk.map((it) => it.text.length >= 800);
        }
      } else {
        verdicts = chunk.map((it) => it.text.length >= 800);
      }
      for (let idx = 0; idx < chunk.length; idx++) {
        const it = chunk[idx]!;
        if (verdicts[idx]) {
          await this.materialize(it.id, undefined, { awaitCover: true });
          const made = this.store.getActiveMaterialByBookmark(it.id);
          if (!report({
            id: it.id,
            title: it.title,
            url: it.url,
            status: made ? "created" : "not_content",
          }))
            return;
        } else if (
          !report({ id: it.id, title: it.title, url: it.url, status: "not_content", reason: "not_content_page" })
        ) {
          return;
        }
      }
    }
  }

  // ==================== D70 收纳盒「书签/资料」自动分流 ====================

  /**
   * 服务端补抓单条（guardedFetch 500KB/25s 预算 → l2_text → 摘要 → 资料物化）。
   * /crawl/run 路由与收纳盒资料扫描共用；隐私/网络守卫在本方法内独立判定（不信任上游声明）。
   */
  async crawlOne(
    bookmarkId: string,
    opts: {
      skipMaterialize?: boolean;
      skipSummary?: boolean;
      expected?: MaterialConversionCandidate;
      /** D92：整理任务取证用——不补写书签描述（会递增修订，破坏任务的 await 前基线） */
      skipMeta?: boolean;
    } = {},
  ): Promise<{ ok: boolean; reason?: string; detail?: string; text?: string }> {
    const bm = this.store.getBookmark(bookmarkId);
    if (!bm || bm.materialized_at) return { ok: false, reason: "not_found" };
    if (opts.expected && !this.store.materialCandidateMatches(opts.expected)) return { ok: false, reason: "stale_candidate" };
    // A1-3 服务端纵深校验：隐私域/私密书签禁止抓取
    const decision = this.serverDecide("server_fetch", bm.url_raw, {
      isPrivateBookmark: bm.is_private === 1,
    });
    if (!decision.allowed) {
      this.store.upsertCache({
        bookmarkId,
        fetchedVia: "server_crawl",
        failReason: `privacy_${decision.reason}`,
      });
      return { ok: false, reason: "privacy", detail: `privacy_${decision.reason}` };
    }
    try {
      const guardConfig = this.opts.guardConfig ?? fetchGuardConfigFromEnv();
      // 抓取地址用原始 URL（canonical 只是查重键）；连接固定 + 字节上限（DEV-04/13）
      const res = this.opts.crawlFetcher
        ? await this.opts.crawlFetcher(bm.url_raw, guardConfig)
        : await guardedFetch(
            bm.url_raw,
            guardConfig,
            { headers: { "user-agent": "my-favorites-bot/0.1 (+https://github.com/easeyeah/my-favorites)" } },
            { maxBytes: 500_000, timeoutMs: 10_000, totalTimeoutMs: 25_000 },
          );
      if (!res.ok) {
        res.dispose();
        throw new Error(`HTTP ${res.status}`);
      }
      const html = (await res.readBody(500_000)).toString("utf8");
      const description =
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1];
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 20_000);
      if (opts.expected && !this.store.materialCandidateMatches(opts.expected)) return { ok: false, reason: "stale_candidate" };
      // 即使显式 crawl，也不能把异步旧 URL 的正文写进已被修改的实体。
      const after = this.store.getBookmark(bookmarkId);
      if (!after || after.url_raw !== bm.url_raw || after.content_revision !== bm.content_revision ||
          !this.serverDecide("server_fetch", after.url_raw, { isPrivateBookmark: after.is_private === 1 }).allowed) {
        return { ok: false, reason: "stale_candidate" };
      }
      this.store.upsertCache({ bookmarkId, l2Text: text || null, fetchedVia: "server_crawl" });
      // D92：整理任务取证不补写描述——描述写入会递增 content_revision，任务自己的 await 前基线会被误判为冲突
      if (!opts.expected && !opts.skipMeta && description && !bm.description) {
        this.store.updateBookmark(bookmarkId, { description: description.slice(0, 500) });
      }
      if (!opts.skipSummary) await this.maybeSummarize(bookmarkId);
      // D89 目录资料扫描：内容型页面判定由调用方完成后再物化（crawl 本身不等于资料）
      if (!opts.skipMaterialize) await this.materialize(bookmarkId);
      return { ok: true, text };
    } catch (err) {
      if (!this.store.getBookmark(bookmarkId) || (opts.expected && !this.store.materialCandidateMatches(opts.expected))) {
        return { ok: false, reason: "stale_candidate" };
      }
      // D62 规范③失败可观测：原因落 cache.failReason（带 crawl_failed: 前缀，补扫可解释）
      const detail = String(err).slice(0, 120);
      this.store.upsertCache({
        bookmarkId,
        fetchedVia: "server_crawl",
        failReason: `crawl_failed:${detail}`,
      });
      return { ok: false, reason: "crawl_failed", detail };
    }
  }

  /** D91：跨 Pipeline / 跨用户共用串行闸；数据库候选才是任务真相，内存队列仅唤醒。 */
  private static scanQueue: Promise<void> = Promise.resolve();
  private static readonly scanEnqueued = new Set<string>();

  enqueueInboxScan(jobs: Array<{ id: string; kind?: "materialize" | "crawl" }>): void {
    const uid = currentUserId();
    for (const { id } of jobs) {
      const cand = this.store.getMaterialCandidate(id);
      if (!cand || !["pending", "retry", "ready"].includes(cand.state) ||
          (cand.next_attempt_at && cand.next_attempt_at > new Date().toISOString())) continue;
      const key = `${uid}:${id}:${cand.entry_id}`;
      if (Pipeline.scanEnqueued.has(key)) continue;
      Pipeline.scanEnqueued.add(key);
      Pipeline.scanQueue = Pipeline.scanQueue.then(() => runAsUser(uid, async () => {
        try {
          await this.scanOne(cand);
        } catch (err) {
          const fresh = this.store.getMaterialCandidate(id);
          if (fresh?.entry_id === cand.entry_id && ["pending", "retry", "ready"].includes(fresh.state)) {
            this.setCandidateState(cand, "retry", `scan_failed:${String(err).slice(0, 160)}`);
          }
          console.warn("[inbox-scan] failed:", String(err).slice(0, 160));
        }
      })).finally(() => Pipeline.scanEnqueued.delete(key)).catch((err) => {
        // 最外层防止单个租户库异常毒化全局 Promise 链，其持久候选仍留待补扫。
        console.error("[inbox-scan] queue failed:", String(err).slice(0, 160));
      });
    }
  }

  /** 启动/定时补扫仅消费已登记的新入口，不遍历历史书签/资料，ready 也可跨重启提交。 */
  resumeMaterialCandidates(limit = 10): number {
    const candidates = this.store.pendingMaterialCandidates(limit);
    this.enqueueInboxScan(candidates.map((c) => ({ id: c.bookmark_id })));
    return candidates.length;
  }

  /** 必须有同一入口、同一URL/revision/策略下的成功证据。active material 本身不是证据。 */
  commitMaterialConversions(ids: string[]): number {
    const db = this.store.db;
    db.exec("SAVEPOINT mf_material_convert");
    try {
      const actions: unknown[] = [];
      const converted: string[] = [];
      for (const id of new Set(ids)) {
        const r = this.store.convertToMaterial(id);
        if (!r) continue;
        const after = this.store.getBookmark(id)!;
        actions.push({ type: "convertToMaterial", bookmarkId: id, fromFolderId: r.folderId,
          revisionAfter: after.content_revision, materializedGeneration: after.materialized_generation });
        converted.push(id);
      }
      if (actions.length > 0) {
        const versionId = this.store.saveVersion(null, actions, { label: "material_convert" });
        for (const id of converted) this.store.setMaterialVersion(id, versionId);
      }
      db.exec("RELEASE mf_material_convert");
      return converted.length;
    } catch (err) {
      db.exec("ROLLBACK TO mf_material_convert");
      db.exec("RELEASE mf_material_convert");
      throw err;
    }
  }

  /** 测试等待全局串行任务排空，不访问任何真实实例。 */
  scanIdle(): Promise<void> {
    return Pipeline.scanQueue;
  }

  /** 旧入口的异步结果不能取消新入口；系统归位/捕获重绑修订时，过期任务改为下轮重试。 */
  private setCandidateState(cand: MaterialConversionCandidate, state: string, reason: string | null = null, kind?: string): void {
    const fresh = this.store.getMaterialCandidate(cand.bookmark_id);
    if (!fresh || fresh.entry_id !== cand.entry_id || fresh.state === "cancelled" ||
        (fresh.state === "done" && state !== "done")) return;
    if (state === "cancelled" && fresh.content_revision !== cand.content_revision && this.store.materialCandidateMatches(fresh)) {
      state = "retry";
      reason = "stale_task_rebased";
    }
    this.store.setMaterialCandidateState(cand.bookmark_id, state, reason, kind);
  }

  private async scanOne(enqueued: MaterialConversionCandidate): Promise<void> {
    const id = enqueued.bookmark_id;
    const cand = this.store.getMaterialCandidate(id);
    if (!cand || cand.entry_id !== enqueued.entry_id || !["pending", "retry", "ready"].includes(cand.state)) return;
    if (!this.store.materialCandidateMatches(cand)) {
      this.setCandidateState(cand, "cancelled", "stale_url_revision_or_policy");
      return;
    }
    if (cand.state === "ready") {
      if (this.commitMaterialConversions([id]) === 0) this.setCandidateState(cand, "cancelled", "evidence_no_longer_valid");
      return;
    }
    const bm = this.store.getBookmark(id)!;
    const cls = classifyMaterialKind(bm.url_canonical);
    if (!cls) {
      this.setCandidateState(cand, "done", "invalid_url");
      return;
    }
    const existing = this.store.getMaterialByBookmark(id);
    if (existing && !this.store.getActiveMaterialByBookmark(id)) {
      this.setCandidateState(cand, "cancelled", "material_dismissed");
      return;
    }
    let text = cand.authorized_text ?? "";
    if (cls.kind === "article") {
      const llm = this.llmFor("summarize");
      if (!llm) {
        this.setCandidateState(cand, "retry", "llm_unavailable_for_content_judgment");
        return; // 自动移出绝不使用 800 字规则兜底
      }
      if (!this.serverDecide("call_model", bm.url_raw, { isPrivateBookmark: bm.is_private === 1 }).allowed) {
        this.setCandidateState(cand, "cancelled", "privacy_call_model_denied");
        return;
      }
      if (text.length < MATERIAL_ARTICLE_MIN_TEXT) {
        const crawled = await this.crawlOne(id, { skipMaterialize: true, skipSummary: true, expected: cand });
        if (!crawled.ok) {
          if (this.store.materialCandidateMatches(cand)) {
            this.setCandidateState(cand, "retry", crawled.detail ?? crawled.reason ?? "crawl_failed");
          } else this.setCandidateState(cand, "cancelled", "stale_url_revision_or_policy");
          return;
        }
        text = crawled.text ?? "";
      }
      if (!this.store.materialCandidateMatches(cand)) {
        this.setCandidateState(cand, "cancelled", "stale_url_revision_or_policy");
        return;
      }
      if (text.length < MATERIAL_ARTICLE_MIN_TEXT) {
        this.setCandidateState(cand, "done", "content_too_thin");
        return;
      }
      const out = await llm.chatJson<{ results?: Array<{ index: number; material: boolean }> }>([
        { role: "system", content: CONTENT_PAGE_PROMPT },
        { role: "user", content: JSON.stringify([{ index: 0, title: bm.title, url: bm.url_canonical, excerpt: text.slice(0, 400) }]) },
      ]);
      if (!this.store.materialCandidateMatches(cand)) {
        this.setCandidateState(cand, "cancelled", "stale_url_revision_or_policy");
        return;
      }
      const verdict = out.results?.find((r) => r.index === 0)?.material;
      if (typeof verdict !== "boolean") {
        this.setCandidateState(cand, "retry", "invalid_content_verdict");
        return;
      }
      if (!verdict) {
        this.setCandidateState(cand, "done", "not_content_page");
        return;
      }
    }
    // 短事务内再次校验并同时写资料+证据+隐藏+版本；任何失败无半转换。
    const db = this.store.db;
    db.exec("SAVEPOINT mf_material_evidence");
    try {
      if (!this.store.materialCandidateMatches(cand)) {
        db.exec("RELEASE mf_material_evidence");
        return;
      }
      if (this.store.getMaterialByBookmark(id) && !this.store.getActiveMaterialByBookmark(id)) {
        this.setCandidateState(cand, "cancelled", "material_dismissed");
        db.exec("RELEASE mf_material_evidence");
        return;
      }
      this.store.upsertMaterial({ bookmarkId: id, type: cls.kind, signals: cls.signals,
        meta: text ? { textLen: text.length } : {} });
      this.setCandidateState(cand, "ready", null, cls.kind);
      this.commitMaterialConversions([id]);
      db.exec("RELEASE mf_material_evidence");
    } catch (err) {
      db.exec("ROLLBACK TO mf_material_evidence");
      db.exec("RELEASE mf_material_evidence");
      throw err;
    }
    // 装饰/摘要迟到不影响转换；仍在同一个全局串行任务中限流，失败留 cache/candidate 痕迹。
    if (cls.kind === "image") {
      try {
        await this.fetchCover(id, bm.url_raw);
        if (!this.store.getMaterial(this.store.getActiveMaterialByBookmark(id)!.id)?.has_cover) {
          this.setCandidateState(cand, "done", "cover_unavailable");
        }
      } catch (err) {
        this.setCandidateState(cand, "done", `cover_failed:${String(err).slice(0, 120)}`);
      }
    }
    await this.maybeSummarize(id, true);
  }

  /** F2.3 AI 摘要：有 LLM 且有正文时生成 L1；syncAi 模式供测试确定性 */
  async maybeSummarize(bookmarkId: string, awaitRun = false): Promise<boolean> {
    const cache = this.store.getCache(bookmarkId);
    const l2 = (cache?.l2_text as string | null) ?? "";
    const llm = this.llmFor("summarize");
    if (!llm || !l2 || l2.length < 40) return false;
    const bm = this.store.getBookmark(bookmarkId);
    if (!bm) return false;
    // A1-3：调用模型前独立判定 call_model（隐私域/私密书签不外发内容）
    if (!this.serverDecide("call_model", bm.url_raw, { isPrivateBookmark: bm.is_private === 1 }).allowed) {
      // D63：拒绝也留痕（异步规范③失败可观测；privacy_* 前缀被补扫排除，不会反复重试）
      this.store.upsertCache({ bookmarkId, fetchedVia: "extension_capture", failReason: "privacy_call_model_denied" });
      return false;
    }
    // DEV-03：记录提交前的规则修订与实体修订（LLM 等待期间可能变化）
    const rulesRevBefore = this.store.privacyRevision();
    const contentRevBefore = bm.content_revision ?? 1;
    const privateBefore = bm.is_private;

    const run = async () => {
      try {
        // D65 标签收敛：注入已有标签库（频次 Top40），引导复用而非自由造词——
        // 自由生成会让标签总量随收藏线性爆炸（几百个 count=1 的长尾不可浏览）
        const knownTags = this.store
          .materialFacets(false)
          .tags.slice(0, 40)
          .map((t) => t.tag);
        const out = await llm.chatJson<{
          summary: string;
          tags: string[];
          keywords: string[];
          category?: string[];
        }>([
          {
            role: "system",
            content:
              "你是网页摘要助手。根据正文生成：summary（≤80字中文摘要）、tags（2-4 个较通用的标签——优先复用已有标签库中的词（如适用），避免版本号/页面名等一次性词语）、keywords（关键词数组）、category（资料的两级分类路径数组，如[\"技术开发\",\"前端\"]——一级从[技术开发,商业财经,生活服务,学习教育,创意设计,娱乐内容,工具资源,其他]中选最贴切的（可自拟更准确的短语），二级可省略）。只返回 JSON。",
          },
          {
            role: "user",
            content: `标题：${bm.title}\nURL：${bm.url_canonical}\n已有标签库（优先复用，如适用）：${knownTags.join("、") || "（暂无）"}\n正文：${l2.slice(0, 4000)}`,
          },
        ]);
        // DEV-03：响应完成后提交前重读策略与状态——过期结果丢弃并给原因码
        const after = this.store.getBookmark(bookmarkId);
        if (
          !after ||
          after.is_private !== privateBefore ||
          (after.content_revision ?? 1) !== contentRevBefore ||
          this.store.privacyRevision() !== rulesRevBefore ||
          !this.serverDecide("call_model", after.url_raw, { isPrivateBookmark: after.is_private === 1 }).allowed
        ) {
          this.store.upsertCache({
            bookmarkId,
            fetchedVia: "extension_capture",
            failReason: "stale_policy_discarded",
          });
          return false;
        }
        this.store.upsertCache({
          bookmarkId,
          l1Summary: String(out.summary ?? "").slice(0, 200),
          l1Tags: Array.isArray(out.tags) ? out.tags.slice(0, 5).map(String) : [],
          keywords: Array.isArray(out.keywords) ? out.keywords.slice(0, 10).map(String) : [],
          fetchedVia: "extension_capture",
        });
        // D65：同一次 LLM 调用顺带产出资料分类路径（零额外成本），写入资料条目
        const mat = this.store.getMaterialByBookmark(bookmarkId);
        if (mat && Array.isArray(out.category)) {
          const path = out.category.filter((s) => typeof s === "string" && s.trim()).slice(0, 2);
          if (path.length > 0) this.store.setMaterialCategory(mat.id, path.map(String));
        }
        // D77：内容证据刚到位 → 复核自动归位去向（fire-and-forget 不阻塞摘要；
        // 非自动归位条目内部即跳过零开销；patrol 定时器兜底，D62/D63）
        void this.reviewPlacement(bookmarkId).catch((err: unknown) =>
          console.warn("[placement-review] hook failed:", String(err).slice(0, 120)),
        );
        return true;
      } catch {
        this.store.upsertCache({
          bookmarkId,
          fetchedVia: "extension_capture",
          failReason: "llm_unavailable",
        });
        return false;
      }
    };

    if (this.opts.syncAi || awaitRun) return await run();
    void run();
    return false;
  }

  /**
   * D63 L1 摘要兜底补扫：摘要本就 fire-and-forget（async 模式 void run 不阻塞捕获），
   * 进程重启丢在途、LLM 当时不可用都会让摘要永久缺失——常驻补扫涓流找回。
   * 无 LLM 配置时零开销跳过；隐私/失败原因由 maybeSummarize 内部现行策略判定兜底。
   */
  backfillSummaries(limit = 5): number {
    if (!this.llmFor("summarize")) return 0; // 无 LLM：零开销（规则引擎形态全靠 manual，无摘要承诺）
    const rows = this.store.bookmarksMissingSummary(limit);
    for (const row of rows) {
      // maybeSummarize 内部 catch 已落 fail_reason；此处 .catch 仅防极端异常冒泡（不静默，留日志）
      void this.maybeSummarize(row.id).catch((err: unknown) => {
        console.warn("[summary-backfill] retry failed:", String(err).slice(0, 120));
      });
    }
    return rows.length;
  }

  /**
   * D65 分类回灌：已有 L1 摘要但缺分类的资料条目，涓流补分类（≤limit 条/轮；无 LLM 零开销）。
   * 只用摘要/标签做分类（不送全文，控制 token）；单条失败不阻塞本轮——category 仍缺失会
   * 在下一轮重新进入候选（materialsMissingCategory 口径）。
   */
  async backfillCategories(limit = 5): Promise<number> {
    const llm = this.llmFor("summarize");
    if (!llm) return 0;
    const candidates = this.store.materialsMissingCategory(limit);
    let done = 0;
    for (const cand of candidates) {
      const cache = this.store.getCache(cand.bookmark_id);
      const summary = typeof cache?.l1_summary === "string" ? (cache.l1_summary as string) : "";
      const tags = Array.isArray(cache?.l1_tags) ? (cache!.l1_tags as string[]).join("、") : "";
      if (!summary) continue;
      const bm = this.store.getBookmark(cand.bookmark_id);
      if (!bm) continue;
      try {
        const out = await llm.chatJson<{ category?: string[] }>([
          {
            role: "system",
            content:
              '你是资料分类助手。根据标题/摘要/标签输出两级分类路径 category（如["技术开发","前端"]）。一级从[技术开发,商业财经,生活服务,学习教育,创意设计,娱乐内容,工具资源,其他]中选最贴切的（可自拟更准确的短语）；二级可省略。只返回 JSON。',
          },
          { role: "user", content: `标题：${bm.title}\n摘要：${summary}\n标签：${tags}` },
        ]);
        const path = Array.isArray(out.category)
          ? out.category.filter((s) => typeof s === "string" && s.trim()).slice(0, 2)
          : [];
        if (path.length > 0) {
          this.store.setMaterialCategory(cand.id, path.map(String));
          done += 1;
        }
      } catch (err) {
        console.warn("[category-backfill] classify failed:", String(err).slice(0, 120));
      }
    }
    return done;
  }

  /** D76/D77：分类 prompt 的目录上下文——完整路径 + 代表书签（每目录 3 条）。
   *  旧实现只给扁平目录名，模型凭字面猜语义（「在线工具」吞掉原生远控客户端）；
   *  按内容证据归纳收录范围，不硬编码分类规则（样本永远比规则新鲜，D65 自组织同源） */
  private folderContextForPrompt(): { context: string; names: string[]; pathOf: (id: string) => string } {
    const folderRows = this.store.listFolders().filter((f) => !f.is_system_inbox);
    const samples = this.store.folderSampleTitles(3);
    const byId = new Map(folderRows.map((f) => [f.id, f] as const));
    const pathCache = new Map<string, string>();
    const pathOf = (id: string): string => {
      const hit = pathCache.get(id);
      if (hit !== undefined) return hit;
      const f = byId.get(id);
      const p = !f ? "" : f.parent_id && byId.has(f.parent_id) ? `${pathOf(f.parent_id)}/${f.name}` : f.name;
      pathCache.set(id, p);
      return p;
    };
    const context = folderRows
      .map((f) => `${pathOf(f.id)}：${(samples.get(f.id) ?? []).map((t) => t.slice(0, 40)).join("、") || "（空目录）"}`)
      .join("\n");
    return { context, names: folderRows.map((f) => f.name), pathOf };
  }

  /**
   * D77 分类自检：复核单条「自动归位」条目的去向（用户不必拿着错分类来找人）。
   * 资格 = inbox_state placed（手动归位/移动会清状态 → 用户意图神圣不可侵犯）；
   * 证据 = L1 摘要/标签（有则送）+ 目录样本（D76）+ 当前目录；仅当存在「明显更合适的
   * 现有目录」且 confidence ≥ REVIEW_MOVE_CONFIDENCE 才直接生效移动（D27），写 organize_version
   * 可撤销 + 归位去向刷新（D54 面板可见）；合适/不确定 → 保持。kept/moved 均标记 reviewed
   * （一次性防振荡）；LLM 失败不标记，下轮 patrol 重试（D62 失败可观测）。
   */
  async reviewPlacement(bookmarkId: string): Promise<"moved" | "kept" | "skipped" | "failed"> {
    const llm = this.llmFor("organize");
    if (!llm) return "skipped";
    const bm = this.store.getBookmark(bookmarkId);
    const st = this.store.getInboxState(bookmarkId);
    if (!bm || !st || st.state !== "placed" || st.reviewed_at) return "skipped";
    if (bm.materialized_at) return "skipped"; // D91：已转资料（书签面实体），不再参与目录复核
    const candidate = this.store.getMaterialCandidate(bookmarkId);
    if (candidate && ["pending", "retry", "ready"].includes(candidate.state)) return "skipped";
    const inbox = this.store.inboxFolder();
    if (inbox && bm.folder_id === inbox.id) return "skipped"; // 仍在箱内归收纳盒管线
    if (bm.is_private === 1 || this.privacyCheck(bm.url_raw)) {
      this.store.markClassificationReviewed(bookmarkId); // 隐私终结：永不送模型，也不占 patrol 名额
      return "skipped";
    }
    const { context, names, pathOf } = this.folderContextForPrompt();
    const currentName = this.store.getFolder(bm.folder_id)?.name ?? "";
    const cache = this.store.getCache(bookmarkId);
    const summary = typeof cache?.l1_summary === "string" ? (cache!.l1_summary as string) : "";
    const tags = Array.isArray(cache?.l1_tags) ? (cache!.l1_tags as string[]).join("、") : "";
    const rulesRevBefore = this.store.privacyRevision();
    const revBefore = bm.content_revision ?? 1;
    let out: { category?: string; confidence?: number };
    try {
      out = await llm.chatJson<{ category?: string; confidence?: number }>([
        {
          role: "system",
          content:
            '你是书签分类复核助手。现有目录（格式「路径：代表书签」——按代表书签归纳各目录的实际收录范围，不要仅凭目录名字面猜测）：\n' +
            context +
            '\n任务：复核这条书签的当前目录是否合适。仅当存在明显更合适的「现有目录」时输出其目录名（路径最后一段）；当前目录合适或无法确定时 category 输出空字符串。禁止建议新目录。只返回 JSON：{"category":"...","confidence":0.0}，confidence∈[0,1]。',
        },
        {
          role: "user",
          content: JSON.stringify({
            title: bm.title,
            url: bm.url_canonical,
            currentFolder: pathOf(bm.folder_id),
            summary: summary || undefined,
            tags: tags || undefined,
          }),
        },
      ]);
    } catch (err) {
      console.warn("[placement-review] llm failed:", String(err).slice(0, 120));
      return "failed";
    }
    const category = String(out.category ?? "").trim();
    const confidence = out.confidence ?? 0;
    const targetName =
      category && names.includes(category) && category !== currentName && confidence >= REVIEW_MOVE_CONFIDENCE
        ? category
        : null;
    // 短事务重查（与流水线阶段 B 同源）：等待期间用户可能已手动移动/改隐私
    const db = this.store.db;
    db.exec("BEGIN");
    try {
      const fresh = this.store.getBookmark(bookmarkId);
      const freshState = this.store.getInboxState(bookmarkId);
      if (
        !fresh ||
        !freshState ||
        freshState.state !== "placed" ||
        (fresh.content_revision ?? 1) !== revBefore ||
        this.store.privacyRevision() !== rulesRevBefore ||
        fresh.is_private === 1 ||
        fresh.materialized_at || // D91：等待期间已转资料 → 不再移动
        this.privacyCheck(fresh.url_raw)
      ) {
        db.exec("ROLLBACK");
        return "skipped";
      }
      let result: "moved" | "kept" = "kept";
      if (targetName) {
        const target = this.store.listFolders().find((f) => f.name === targetName && !f.is_system_inbox);
        if (target && target.id !== fresh.folder_id) {
          const before = this.store.moveBookmark(bookmarkId, target.id);
          if (before) {
            const versionId = this.store.saveVersion(null, [
              {
                type: "move",
                bookmarkId,
                fromFolderId: before.folder_id,
                toFolderId: target.id,
                revisionAfter: this.store.getBookmark(bookmarkId)?.content_revision ?? 1,
                meta: "auto_review",
              },
            ]);
            enqueueMirrorMoves(this.store, bookmarkId, target.id);
            this.store.upsertInboxState(bookmarkId, "placed", confidence, target.name, 0);
            this.store.setInboxStateVersion(bookmarkId, versionId);
            result = "moved";
          }
        }
      }
      if (result === "kept") {
        // 保持也刷新去向展示（D54 面板读 reason）——顺带自愈历史移动留下的过期 reason
        this.store.upsertInboxState(bookmarkId, "placed", confidence || null, currentName, 0);
      }
      this.store.markClassificationReviewed(bookmarkId);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** D77 patrol 回灌：未复核的自动归位条目涓流复核（≤limit 条/轮，串行；无 LLM 零开销）。
   *  覆盖摘要缺失条目与旧 prompt 时代归位的存量（D63 常驻兜底模式） */
  async backfillPlacementReviews(limit = 10): Promise<number> {
    if (!this.llmFor("organize")) return 0;
    const candidates = this.store.classificationReviewCandidates(limit);
    let done = 0;
    for (const id of candidates) {
      const r = await this.reviewPlacement(id);
      if (r === "moved" || r === "kept") done++;
    }
    return done;
  }

  /**
   * F1.5 收件箱流水线（DEV-08 统一提交内核版）：
   *  - 阶段一（规则，短事务）：每项事务内重查（inbox 归属/隐私/私密），移动 + 镜像入队 +
   *    版本记录同事务提交；任意异常整批回滚（无半提交）；
   *  - 阶段二（LLM，事务外计算）：等待期间用户可能已改动/加隐私规则——提交短事务逐项重查，
   *    过期项丢弃并给原因码，再写第二个版本；
   *  - deviceId 提供时，镜像操作在各事务内直接入队（崩溃无「已提交但无镜像」空窗）。
   */
  async processInbox(
    bookmarkIds: string[],
    inboxFolderId: string,
    opts: { deviceId?: string } = {},
  ): Promise<{
    moved: Array<{ id: string; to: string; source: string }>;
    left: Array<{ id: string; reason: string }>;
    versionId: string | null;
    /** 异步识别已排队（尚非成功），不能计入 moved 或成功通知。 */
    queued: string[];
  }> {
    const moved: Array<{ id: string; to: string; source: string }> = [];
    const left: Array<{ id: string; reason: string }> = [];
    const pending: Array<{ id: string; title: string; url: string }> = [];
    const queued: string[] = [];
    const mediaJobs: Array<{ id: string }> = [];
    const db = this.store.db;

    // ---------- 阶段一：规则移动（单短事务，含镜像 + 版本） ----------
    const versionActionsA: unknown[] = [];
    let firstVersionId: string | null = null;
    db.exec("BEGIN");
    try {
      for (const id of bookmarkIds) {
        const bm = this.store.getBookmark(id);
        if (!bm || bm.materialized_at || bm.folder_id !== inboxFolderId) {
          left.push({ id, reason: "not_in_inbox" });
          continue;
        }
        if (bm.is_private === 1 || this.privacyCheck(bm.url_raw)) {
          left.push({ id, reason: "privacy_domain" });
          // 原型 06：隐私条目仅存 URL，手动选目录（支持按域名记忆本地规则）
          this.store.upsertInboxState(id, "privacy_hold", null, "privacy_domain", 0);
          continue;
        }
        const candidate = this.store.getMaterialCandidate(id);
        if (candidate && ["pending", "retry", "ready"].includes(candidate.state)) {
          queued.push(id);
          const kind = classifyMaterialKind(bm.url_canonical)?.kind;
          if (kind === "video" || kind === "image") {
            mediaJobs.push({ id });
            this.store.upsertInboxState(id, "classifying", null, "material_pending", 0);
            continue; // 媒体不先建普通目录，也不等待普通目录 LLM 分类。
          }
        }
        const parsed = canonicalizeUrl(bm.url_canonical);
        const rule = parsed
          ? classifyByRules(parsed.registrableDomain, bm.title)
          : { category: "未分类", confidence: 0.3, source: "none" as const };

        if (rule.source === "domain_map" && rule.confidence >= AUTO_MOVE_CONFIDENCE) {
          const target = this.ensureCategoryFolder(rule.category);
          const before = this.store.moveBookmark(id, target.id);
          if (before) this.store.rebaseMaterialCandidate(id, before.content_revision ?? 1);
          this.store.bumpDomain(parsed!.registrableDomain, rule.category);
          if (before) {
            versionActionsA.push({
              type: "move",
              bookmarkId: id,
              fromFolderId: before.folder_id,
              toFolderId: target.id,
              revisionAfter: this.store.getBookmark(id)?.content_revision ?? 1,
              meta: "inbox_rule",
            });
            enqueueMirrorMoves(this.store, id, target.id, opts.deviceId);
            moved.push({ id, to: target.name, source: "rule" });
          }
          continue;
        }
        pending.push({ id, title: bm.title, url: bm.url_canonical });
      }
      const versionIdA =
        versionActionsA.length > 0 ? this.store.saveVersion(null, versionActionsA) : null;
      firstVersionId = versionIdA;
      db.exec("COMMIT");
      // 收纳盒条目状态机（原型 06）：规则归位 → placed（带版本，撤销/改目录入口用）
      for (const m of moved.filter((x) => x.source === "rule")) {
        this.store.upsertInboxState(m.id, "placed", null, m.to, 0);
        if (versionIdA) this.store.setInboxStateVersion(m.id, versionIdA);
      }
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    this.enqueueInboxScan(mediaJobs);
    const llm = this.llmFor("organize");
    // 无 LLM：pending 项明确标注原因留在收件箱（永不丢书签）；重试计数 +1，超限转人工（ambiguous）
    if (!llm) {
      for (const p of pending) {
        left.push({ id: p.id, reason: "no_llm" });
        this.bumpRetryState(p.id, "no_llm");
      }
      this.enqueueInboxScan(queued.map((id) => ({ id })));
      return { moved, left, versionId: firstVersionId, queued };
    }

    // ---------- 阶段二：LLM 批量精修（事务外计算；仅尚未被移走/改动的项） ----------
    let secondVersionId: string | null = null;
    const createdThisBatch = new Set<string>(); // D71：本批新建的目录（后续同类目视作已知，不重复过门槛）
    if (pending.length > 0) {
      const rulesRevBefore = this.store.privacyRevision();
      const baseRevisions = new Map(pending.map((p) => [p.id, this.store.getBookmark(p.id)?.content_revision ?? 1]));
      // D76：目录上下文 = 完整路径 + 代表书签（按内容归纳语义，不凭名字字面猜）
      const { context: folderContext, names: folderNames } = this.folderContextForPrompt();
      try {
        const prefs = this.store.topCategories();
        const out = await llm.chatJson<{
          results: Array<{ index: number; category: string; confidence: number; material?: boolean }>;
        }>([
          {
            role: "system",
            content:
              '你是书签分类助手。现有目录（格式「路径：代表书签」——按代表书签归纳各目录的实际收录范围，不要仅凭目录名字面猜测；category 填目录名，即路径最后一段）：\n' +
              folderContext +
              (prefs.length > 0 ? `\n用户常用目录（优先参考）：${JSON.stringify(prefs)}` : "") +
              '\n为每条书签选择最合适的目录：优先使用现有目录；仅当确实没有合适目录时才建议新目录，且新目录名必须通用宽泛（如「视频」「开发」，禁止具体项目名/一次性词语）。只返回 JSON：{"results":[{"index":0,"category":"...","confidence":0.0}]}，confidence∈[0,1]。',
          },
          {
            role: "user",
            content: JSON.stringify(
              pending.map((p, i) => ({ index: i, title: p.title, url: p.url })),
            ),
          },
        ]);
        // 提交短事务：逐项重查（仍在 inbox / revision 未变 / 隐私规则未变 / 非私密）
        const versionActionsB: unknown[] = [];
        const movedB: Array<{ id: string; to: string; source: string }> = [];
        db.exec("BEGIN");
        try {
          for (const r of out.results ?? []) {
            const item = pending[r.index];
            if (!item) continue;
            if (!((r.confidence ?? 0) >= 0.6 && r.category && r.category !== "未分类")) {
              left.push({ id: item.id, reason: "low_confidence" });
              // D37：歧义阈值 80% 起步（AUTO_MOVE_CONFIDENCE）——低于 0.6 直接歧义滞留，0.6–0.8 之间
              // 由 /inbox/process 调用方决定（本流水线保守：不足 0.8 不强移，标歧义）
              this.store.upsertInboxState(item.id, "ambiguous", r.confidence ?? null, "low_confidence", 0);
              continue;
            }
            // D71 新目录创建门槛：现有目录 ≥0.6 即归位；要「新建目录」必须 ≥AUTO_MOVE_CONFIDENCE(0.8)——
            // 不足则歧义滞留（popup 内联询问）。「宁可问一下，也不悄悄长出新目录」：
            // AI 建的新目录经双向同步会出现在浏览器书签栏，静默增殖最伤信任（D55 同族教训）。
            const knownFolders = new Set([...folderNames, ...createdThisBatch]);
            if (!knownFolders.has(r.category) && (r.confidence ?? 0) < AUTO_MOVE_CONFIDENCE) {
              left.push({ id: item.id, reason: "new_folder_low_confidence" });
              this.store.upsertInboxState(item.id, "ambiguous", r.confidence ?? null, "new_folder", 0);
              continue;
            }
            const bm = this.store.getBookmark(item.id);
            if (!bm || bm.folder_id !== inboxFolderId) {
              left.push({ id: item.id, reason: "stale_moved_by_user" });
              continue;
            }
            if ((bm.content_revision ?? 1) !== (baseRevisions.get(item.id) ?? 1)) {
              left.push({ id: item.id, reason: "stale_modified_by_user" });
              continue;
            }
            if (bm.is_private === 1 || this.store.privacyRevision() !== rulesRevBefore || this.privacyCheck(bm.url_raw)) {
              left.push({ id: item.id, reason: "stale_policy" });
              continue;
            }
            const target = this.ensureCategoryFolder(r.category);
            createdThisBatch.add(r.category); // D71：登记本批新目录
            const before = this.store.moveBookmark(item.id, target.id);
            if (before) {
              this.store.rebaseMaterialCandidate(item.id, before.content_revision ?? 1);
              versionActionsB.push({
                type: "move",
                bookmarkId: item.id,
                fromFolderId: before.folder_id,
                toFolderId: target.id,
                revisionAfter: this.store.getBookmark(item.id)?.content_revision ?? 1,
                meta: "inbox_llm",
              });
              enqueueMirrorMoves(this.store, item.id, target.id, opts.deviceId);
              movedB.push({ id: item.id, to: target.name, source: "llm" });
            }
          }
          secondVersionId =
            versionActionsB.length > 0 ? this.store.saveVersion(null, versionActionsB) : null;
          db.exec("COMMIT");
          moved.push(...movedB); // 提交成功才对外报告移动（回滚不虚报）
          for (const m of movedB) {
            this.store.upsertInboxState(m.id, "placed", null, m.to, 0);
            if (secondVersionId) this.store.setInboxStateVersion(m.id, secondVersionId);
          }
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      } catch (err) {
        // LLM 不可用或提交异常：pending 项留在收件箱（原因码可解释；不丢书签）
        if (String(err).includes("llm_unavailable") || String(err).includes("LlmUnavailableError")) {
          for (const p of pending) left.push({ id: p.id, reason: "llm_unavailable" });
        } else {
          for (const p of pending) left.push({ id: p.id, reason: "commit_failed" });
        }
        for (const p of pending) this.bumpRetryState(p.id, "llm_unavailable");
      }
    }

    // 新入口均识别实际正文（包括规则归位的文章），不以 title/URL 的 material 布尔作为移出证据。
    this.enqueueInboxScan(queued.map((id) => ({ id })));

    return { moved, left, versionId: firstVersionId ?? secondVersionId, queued };
  }

  /** 重试状态：attempts+1；达到 5 次（原型 06「第 n/5 次」）转人工 = ambiguous 滞留 */
  private bumpRetryState(bookmarkId: string, reason: string): void {
    const prev = this.store.getInboxState(bookmarkId);
    const attempts = (prev?.attempts ?? 0) + 1;
    if (attempts >= 5) {
      this.store.upsertInboxState(bookmarkId, "ambiguous", null, `retry_exhausted:${reason}`, attempts);
    } else {
      this.store.upsertInboxState(bookmarkId, "retry", null, reason, attempts);
    }
  }

  ensureCategoryFolder(name: string): { id: string; name: string } {
    const existing = this.store.findFolderByName(name);
    if (existing && !existing.is_system_inbox) {
      return { id: existing.id, name: existing.name };
    }
    const created = this.store.createFolder(name, null, "ai_created");
    return { id: created.id, name: created.name };
  }
}
