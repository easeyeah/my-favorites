/**
 * OpenAI 兼容 LLM 客户端（技术方案 §6.1 运行时解析顺序）
 *
 * 零依赖：用全局 fetch。服务端注入 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL，
 * 三档切换（llm-mock / Ollama / 真实端点）只改环境变量。
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class LlmUnavailableError extends Error {
  /**
   * D43：providerDetail = 供应商错误响应体摘录（error.code/message 或纯文本前 300 字符）。
   * 非 2xx 不再只报状态码——审核类拒收要靠响应体里的机器码才能和限流/故障区分开。
   */
  constructor(
    reason: string,
    public readonly providerDetail?: string,
  ) {
    super(providerDetail ? `llm_unavailable: ${reason} | provider: ${providerDetail}` : `llm_unavailable: ${reason}`);
    this.name = "LlmUnavailableError";
  }
}

/** 供应商错误体 → 单行摘录：优先 OpenAI 兼容 envelope 的 error.code/type/message，兜底纯文本截断 */
function extractProviderDetail(raw: string): string {
  const text = raw.slice(0, 4096);
  try {
    const j = JSON.parse(text) as {
      error?: { code?: string; type?: string; message?: string } | string;
      message?: string;
    };
    const e = j?.error;
    if (typeof e === "string" && e) return e.replace(/\s+/g, " ").slice(0, 300);
    if (e && typeof e === "object") {
      const detail = [e.code, e.type, e.message].filter(Boolean).join(" ");
      if (detail) return detail.replace(/\s+/g, " ").slice(0, 300);
    }
    if (typeof j?.message === "string" && j.message) return j.message.replace(/\s+/g, " ").slice(0, 300);
  } catch {
    // 非 JSON 响应体：原样截断
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * D43：是否内容审核类拒收（区别于限流/网络/配额故障）。
 * 覆盖各家公开错误码：OpenAI content_filter、阿里/通义 data_inspection_failed、
 * 以及消息文案里高频出现的 inappropriate / moderation / policy 措辞。
 */
const MODERATION_RE =
  /data_inspection_failed|content_filter|content[_.-]policy|content[_.-]filter|inappropriate|moderat|responsible[_-]?content|safety[_-]?(block|guidelines|filter)/i;

export function isLlmContentModeration(err: unknown): boolean {
  return err instanceof LlmUnavailableError && !!err.providerDetail && MODERATION_RE.test(err.providerDetail);
}

/** 读非 2xx 响应体（截 4KB，失败静默——错误路径不再裸抛） */
async function readErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const raw = await res.text();
    const detail = extractProviderDetail(raw);
    return detail || undefined;
  } catch {
    return undefined;
  }
}

/** 凭据类请求头（大小写不敏感匹配）——重定向剥离用 */
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|x-api-key|cookie)$/i;

/**
 * DEV-04 模型端点请求：手动跟随重定向——
 *  - 最多 3 跳，跨主机或协议降级（https→http）重定向剥离凭据头（禁止把 Key 送往其他端点/明文链路）；
 *  - 信号覆盖整条链路（连接+响应头+响应体）。
 */
async function endpointFetch(
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
): Promise<Response> {
  let current = url;
  let headers = init.headers;
  const origin = new URL(url);
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(current, { ...init, headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      // 显式释放重定向响应体
      try {
        res.body?.cancel();
      } catch {
        // 忽略
      }
      if (!location) throw new LlmUnavailableError(`redirect ${res.status} without location`);
      const next = new URL(location, current);
      const cur = new URL(current);
      if (next.host !== cur.host || (origin.protocol === "https:" && next.protocol === "http:")) {
        // 跨主机 / https→http 降级：剥离全部凭据头（不依赖头名大小写）
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADER.test(k)));
      }
      current = next.toString();
      continue;
    }
    return res;
  }
  throw new LlmUnavailableError("too many redirects");
}

export class LlmClient {
  constructor(private config: LlmConfig) {}

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get model(): string {
    return this.config.model;
  }

  /** embeddings 端点（语义搜索/聚类；模型由 LLM_EMBEDDING_MODEL 或供应商配置决定） */
  async embeddings(input: string, embeddingModel?: string, timeoutMs = 30_000): Promise<number[]> {
    // AbortSignal.timeout：Node 原生类型源，规避 DOM/Node AbortSignal 双类型冲突
    try {
      const res = await endpointFetch(`${this.config.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: embeddingModel ?? "text-embedding-3-small", input }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new LlmUnavailableError(`HTTP ${res.status} embeddings`, await readErrorDetail(res));
      const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const vector = body.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new LlmUnavailableError("empty embedding");
      }
      return vector;
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw err;
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new LlmUnavailableError("timeout");
      }
      throw new LlmUnavailableError(String(err));
    }
  }

  async chat(messages: ChatMessage[], opts?: { json?: boolean; timeoutMs?: number }): Promise<string> {
    try {
      const res = await endpointFetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000),
      });
      if (!res.ok) {
        throw new LlmUnavailableError(
          `HTTP ${res.status} from ${this.config.baseUrl}`,
          await readErrorDetail(res),
        );
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new LlmUnavailableError("empty completion");
      return content;
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw err;
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new LlmUnavailableError("timeout");
      }
      throw new LlmUnavailableError(String(err));
    }
  }

  /** JSON 模式补全 → 安全解析（LLM 输出不可信） */
  async chatJson<T>(messages: ChatMessage[]): Promise<T> {
    const content = await this.chat(messages, { json: true });
    try {
      return JSON.parse(content) as T;
    } catch {
      // 容忍 markdown 代码块包裹
      const m = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
      if (m?.[1]) return JSON.parse(m[1]) as T;
      throw new LlmUnavailableError("non-json completion");
    }
  }
}

export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  if (!env.LLM_BASE_URL) return null;
  return new LlmClient({
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY ?? null,
    model: env.LLM_MODEL ?? "mock-chat",
  });
}
