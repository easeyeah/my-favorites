import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLlmContentModeration, LlmClient, LlmUnavailableError } from "./llm-client";
import http from "node:http";

// 本地起一个最小 mock（与 docker/llm-mock.mjs 契约一致），测客户端而非网络
let server: http.Server;
const PORT = 18099;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/chat/completions")) {
        const payload = JSON.parse(body || "{}");
        if (payload.messages?.[0]?.content === "boom") {
          res.writeHead(500).end();
          return;
        }
        // D43：模拟供应商内容审核拒收（OpenAI 兼容 envelope，带机器码）
        if (payload.messages?.[0]?.content === "moderation-boom") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "data_inspection_failed", type: "invalid_request_error", message: "Content material may contain inappropriate content" } }));
          return;
        }
        // 无 JSON envelope 的网关错误（纯文本 502 之类）
        if (payload.messages?.[0]?.content === "plain-boom") {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("Upstream blocked by content moderation policy");
          return;
        }
        const content =
          payload.response_format?.type === "json_object"
            ? '```json\n{"category":"开发"}\n```' // 模拟真实 LLM 的 markdown 包裹
            : "plain text";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
        );
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(PORT, r));
});

afterAll(async () => {
  server.close();
});

const client = new LlmClient({
  baseUrl: `http://localhost:${PORT}/v1`,
  apiKey: "test",
  model: "mock",
});

describe("LlmClient", () => {
  it("chat 返回补全内容", async () => {
    const out = await client.chat([{ role: "user", content: "hello" }]);
    expect(out).toBe("plain text");
  });

  it("chatJson 容忍 markdown 代码块包裹", async () => {
    const out = await client.chatJson<{ category: string }>([
      { role: "user", content: "hello" },
    ]);
    expect(out.category).toBe("开发");
  });

  it("HTTP 错误 → LlmUnavailableError", async () => {
    await expect(
      client.chat([{ role: "user", content: "boom" }]),
    ).rejects.toThrow(LlmUnavailableError);
  });

  it("D43：审核类 400 → 错误体带机器码，isLlmContentModeration 为真", async () => {
    const err = await client
      .chat([{ role: "user", content: "moderation-boom" }])
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as LlmUnavailableError).message).toContain("data_inspection_failed");
    expect(isLlmContentModeration(err)).toBe(true);
  });

  it("D43：纯文本网关错误也可识别审核措辞", async () => {
    const err = await client
      .chat([{ role: "user", content: "plain-boom" }])
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isLlmContentModeration(err)).toBe(true);
  });

  it("D43：普通 500 故障不算审核（不误触隔离）", async () => {
    const err = await client
      .chat([{ role: "user", content: "boom" }])
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(isLlmContentModeration(err)).toBe(false);
  });

  it("不可达端点 → LlmUnavailableError（不裸抛 fetch 错误）", async () => {
    const bad = new LlmClient({ baseUrl: "http://localhost:1/v1", apiKey: null, model: "x" });
    await expect(bad.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      LlmUnavailableError,
    );
  });
});
