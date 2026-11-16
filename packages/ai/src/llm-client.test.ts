import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmClient, LlmUnavailableError } from "./llm-client";
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

  it("不可达端点 → LlmUnavailableError（不裸抛 fetch 错误）", async () => {
    const bad = new LlmClient({ baseUrl: "http://localhost:1/v1", apiKey: null, model: "x" });
    await expect(bad.chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      LlmUnavailableError,
    );
  });
});
