/**
 * 语义能力（F7.2 语义搜索 + F3.9 大库聚类）
 * 向量存 content_cache.embedding（JSON 数组，M1 数据量级 ≤10k 用内存余弦足够）。
 * DEV-03：embedding 是模型入口——统一走隐私策略（隐私域/私密不外发），
 * 且 await 返回后重验策略再落库（等待期间规则可能变化）。
 */
import { checkPrivacy, type PrivacyRules } from "@mf/shared";
import type { Store, BookmarkRow } from "./store";
import type { LlmClient } from "@mf/ai/llm-client";

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class SemanticService {
  constructor(
    private store: Store,
    private embedClient: LlmClient | null,
    private embeddingModel: string | null,
  ) {}

  available(): boolean {
    return this.embedClient !== null && this.embeddingModel !== null;
  }

  async embed(text: string): Promise<number[] | null> {
    if (!this.embedClient || !this.embeddingModel) return null;
    try {
      return await this.embedClient.embeddings(text.slice(0, 4000), this.embeddingModel);
    } catch {
      return null;
    }
  }

  /** 服务端当前隐私规则（每次判定实时读取，不缓存旧值） */
  private currentRules(): PrivacyRules {
    const { patterns, revision } = this.store.privacyRules();
    return { patterns, revision };
  }

  /**
   * 捕获/抓取后为书签生成向量（失败静默——语义搜索是增强而非依赖）。
   * DEV-03：私密与隐私域书签不向量化（向量内容会发往 embedding 供应商）；
   * await 返回后重验——模型调用期间新加的隐私规则/私密标记同样拦截写回。
   */
  async embedBookmark(bookmarkId: string): Promise<boolean> {
    const bm = this.store.getBookmark(bookmarkId);
    if (!bm) return false;
    const decision = checkPrivacy("call_model", bm.url_raw, this.currentRules(), {
      isPrivateBookmark: bm.is_private === 1,
    });
    if (!decision.allowed) return false; // 原因码见 decision.reason（不记录 URL）
    const rulesRevBefore = this.store.privacyRevision();
    const cache = this.store.getCache(bookmarkId);
    const text =
      `${bm.title}\n${(cache?.l1_summary as string) ?? ""}\n${(cache?.l2_text as string) ?? ""}`.trim();
    if (text.length < 6) return false; // 标题本身可索引
    const vector = await this.embed(text);
    if (!vector) return false;
    // DEV-03 异步竞态：等待期间规则/私密状态变化 → 丢弃结果（不外发后的写回）
    const after = this.store.getBookmark(bookmarkId);
    if (
      !after ||
      after.is_private === 1 ||
      this.store.privacyRevision() !== rulesRevBefore ||
      !checkPrivacy("call_model", after.url_raw, this.currentRules(), {
        isPrivateBookmark: after.is_private === 1,
      }).allowed
    ) {
      return false;
    }
    // 缓存行可能不存在（仅语义索引场景）→ 先确保行存在
    this.store.upsertCache({
      bookmarkId,
      fetchedVia: "semantic_index",
    });
    this.store.db
      .prepare("UPDATE content_cache SET embedding = ? WHERE bookmark_id = ?")
      .run(JSON.stringify(vector), bookmarkId);
    return true;
  }

  /** 语义搜索：余弦相似度排序，回退到全文搜索（同一可见性边界：私密+软归档排除） */
  async search(query: string, limit = 20, opts: { includePrivate?: boolean } = {}): Promise<BookmarkRow[]> {
    if (!this.available()) return this.store.search(query, limit, opts);
    const qv = await this.embed(query);
    if (!qv) return this.store.search(query, limit, opts);

    // DEV-02：语义搜索与关键词搜索同一边界——私密（可显式开启）与软归档一律排除
    const privateCond = opts.includePrivate ? "" : " AND b.is_private = 0";
    const rows = this.store.db
      .prepare(
        `SELECT b.*, c.embedding FROM bookmarks b JOIN content_cache c ON c.bookmark_id = b.id
         WHERE c.embedding IS NOT NULL AND b.archived_into IS NULL${privateCond} LIMIT 10000`,
      )
      .all() as unknown as Array<BookmarkRow & { embedding: string }>;
    const scored = rows
      .map((r) => ({
        bookmark: r,
        score: cosine(qv, JSON.parse(r.embedding) as number[]),
      }))
      .filter((x) => x.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map((x) => x.bookmark);
  }

  /**
   * F3.9 大库聚类：pending 超过阈值时按向量 k-means-lite 分簇，
   * LLM 只做簇命名（O(√n) 次大调用替代逐条）。
   */
  cluster<T extends { id: string }>(items: T[], getVector: (item: T) => number[] | null, k?: number): Array<{ items: T[] }> | null {
    if (items.length < 50 || !this.available()) return null;
    const withVectors = items
      .map((it) => ({ item: it, v: getVector(it) }))
      .filter((x): x is { item: T; v: number[] } => x.v !== null);
    if (withVectors.length < 50) return null;

    const clusters = k ?? Math.max(3, Math.round(Math.sqrt(withVectors.length)));
    // k-means-lite：随机初始中心 + 5 轮迭代（数据量级内足够）
    const centers: number[][] = [];
    for (let i = 0; i < clusters; i++) {
      const seed = withVectors[Math.floor((i + 1) * withVectors.length / (clusters + 1))];
      if (seed) centers.push([...seed.v]);
    }
    let assignments = new Array(withVectors.length).fill(0);
    for (let iter = 0; iter < 5; iter++) {
      assignments = withVectors.map((x) => {
        let best = 0;
        let bestScore = -1;
        centers.forEach((c, ci) => {
          const score = cosine(x.v, c);
          if (score > bestScore) {
            bestScore = score;
            best = ci;
          }
        });
        return best;
      });
      // 更新中心
      for (let ci = 0; ci < centers.length; ci++) {
        const members = withVectors.filter((_, idx) => assignments[idx] === ci);
        if (members.length === 0) continue;
        const dim = members[0]!.v.length;
        const mean = new Array(dim).fill(0);
        for (const m of members) {
          for (let d = 0; d < dim; d++) {
            mean[d] = (mean[d] ?? 0) + (m.v[d] ?? 0) / members.length;
          }
        }
        centers[ci] = mean;
      }
    }
    const buckets: Array<{ items: T[] }> = Array.from({ length: centers.length }, () => ({ items: [] }));
    withVectors.forEach((x, idx) => buckets[assignments[idx] ?? 0]?.items.push(x.item));
    return buckets.filter((b) => b.items.length > 0);
  }
}
