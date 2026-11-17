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
  constructor(reason: string) {
    super(`llm_unavailable: ${reason}`);
    this.name = "LlmUnavailableError";
  }
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
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: embeddingModel ?? "text-embedding-3-small", input }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new LlmUnavailableError(`HTTP ${res.status} embeddings`);
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
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
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
        throw new LlmUnavailableError(`HTTP ${res.status} from ${this.config.baseUrl}`);
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
