/**
 * MCP（Model Context Protocol）端点 —— D64：资料库的 AI 一等消费面
 *
 * 定位（用户拍板）：资料管理的最终价值是「经 MCP 供 AI 工具调用」——
 * 人逛资料页是次要场景，AI（Claude/Cursor 等）通过本端点检索/读取资料才是主路径。
 *
 * 传输：Streamable HTTP 单端点 JSON 模式——POST /api/v1/mcp 收 JSON-RPC 2.0，
 * 以 application/json 应答（规范允许；GET SSE 流不支持 → 405）。无状态：不派发
 * Mcp-Session-Id，客户端每次携带完整请求。
 * 鉴权：随 /api/v1 既有 bearer 中间件（AI 客户端配置 Authorization 头，令牌走
 * 设置页登录/签发）；隐私域/私密书签在资料层即不存在，MCP 侧无需重复判定。
 *
 * 工具：
 *  - materials_search  按关键词/类型/标签检索（摘要级，不回全文）
 *  - materials_get     按 id 取详情（含已存全文，供 AI 阅读）
 *  - materials_recent  最近入库 + 类型计数
 */
import type { Context } from "hono";
import type { Store } from "./store";

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-03-26", "2025-06-18"]);
const FALLBACK_PROTOCOL_VERSION = "2025-03-26";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "materials_search",
    description:
      "检索 my-favorites 资料库（AI 自动分类的收藏内容库）。按关键词（标题/URL/摘要/全文）、内容类型（article/video/image）或 AI 标签过滤。返回标题、URL、摘要、标签、分类目录、识别信号等元数据——需要全文时用 materials_get。",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "关键词（标题/URL/摘要/全文模糊匹配），可空" },
        type: { type: "string", enum: ["article", "video", "image"], description: "内容类型过滤，可空" },
        tag: { type: "string", description: "AI 标签精确匹配（如「前端」「效率工具」），可空" },
        limit: { type: "number", description: "返回条数上限（默认 10，最大 50）" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "materials_get",
    description:
      "按 id 取单条资料详情：标题、URL、AI 摘要、标签、分类目录、识别信号，以及已存全文（文章类含正文 ≤2 万字）——供 AI 阅读原文。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "资料条目 id（materials_search 返回的 id）" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "materials_recent",
    description: "最近入库的资料列表（含类型计数：文章/视频/图片），适合「最近收藏了什么」类询问。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "返回条数上限（默认 10，最大 50）" },
      },
      additionalProperties: false,
    },
  },
];

/** 摘要级行（materials_search/recent 返回）：不含全文——全文走 get，控制 token 体量 */
function slimRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    url: r.url_canonical,
    folder: r.folder_name ?? null,
    tags: r.l1_tags ?? [],
    summary: r.l1_summary ?? null,
    signals: r.signals ?? [],
    has_full_text: (r.l2_len as number ?? 0) > 0,
    collected_at: r.created_at,
  };
}

async function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; message: string }> {
  const num = (v: unknown, dflt: number, max: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.trunc(v), 1), max) : dflt;

  if (name === "materials_search") {
    const rows = store.listMaterials({
      q: typeof args.q === "string" && args.q.trim() ? args.q.trim() : undefined,
      type: typeof args.type === "string" && ["article", "video", "image"].includes(args.type) ? args.type : undefined,
      tag: typeof args.tag === "string" && args.tag.trim() ? args.tag.trim() : undefined,
      limit: num(args.limit, 10, 50),
    });
    return { ok: true, payload: { count: rows.length, materials: rows.map(slimRow) } };
  }

  if (name === "materials_get") {
    const m = typeof args.id === "string" ? store.getMaterial(args.id) : undefined;
    if (!m) return { ok: false, message: `material not found: ${String(args.id ?? "")}` };
    return {
      ok: true,
      payload: {
        ...slimRow(m),
        full_text: typeof m.l2_text === "string" && m.l2_text.length > 0 ? m.l2_text : null,
        snapshot_count: m.snapshot_count ?? 0,
      },
    };
  }

  if (name === "materials_recent") {
    const rows = store.listMaterials({ limit: num(args.limit, 10, 50) });
    return { ok: true, payload: { counts: store.countMaterials(), materials: rows.map(slimRow) } };
  }

  return { ok: false, message: `unknown tool: ${name}` };
}

function rpcResult(id: JsonRpcRequest["id"], result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** POST /api/v1/mcp：JSON-RPC 分发（鉴权由 /api/v1 中间件前置） */
export async function handleMcpRequest(store: Store, c: Context): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as JsonRpcRequest | null;
  if (!body || typeof body.method !== "string") {
    return c.json(rpcError(null, -32600, "invalid request: JSON-RPC 2.0 body required"), 400);
  }
  const { id = null, method, params = {} } = body;

  // 通知（无 id）：不回 JSON-RPC 应答体，202 即可（Streamable HTTP 规范口径）
  if (body.id === undefined || body.id === null) {
    return new Response(null, { status: 202 });
  }

  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
      ? requested
      : FALLBACK_PROTOCOL_VERSION;
    return c.json(
      rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "my-favorites-materials", version: "0.1.0" },
        instructions:
          "my-favorites 资料库：用户收藏内容的 AI 自动分类库。先 materials_search/materials_recent 定位，再 materials_get 读取全文。",
      }),
    );
  }

  if (method === "tools/list") {
    return c.json(rpcResult(id, { tools: TOOLS }));
  }

  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const out = await callTool(store, name, args);
    if (!out.ok) {
      // 工具级失败按 MCP 惯例回 isError 结果（而非协议错误），AI 可据此调整参数
      return c.json(rpcResult(id, { content: [{ type: "text", text: out.message }], isError: true }));
    }
    return c.json(
      rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out.payload, null, 2) }] }),
    );
  }

  return c.json(rpcError(id, -32601, `method not found: ${method}`), 405);
}
