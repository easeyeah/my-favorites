// llm-mock —— 可脚本化的 OpenAI 兼容 mock（技术方案 §8.1）
// 日常开发与 CI 用：零 token 成本、结果确定。支持 /v1/chat/completions（含 SSE 流）与 /v1/models
import http from "node:http";

const PORT = 8080;

/** 确定性分类 mock：按域名关键词返回固定分类，便于断言 */
function mockClassify(messages) {
  const content = messages.map((m) => String(m.content)).join("\n");
  if (/github|gitlab/i.test(content)) return { category: "开发", confidence: 0.95 };
  if (/bilibili|youtube/i.test(content)) return { category: "视频", confidence: 0.9 };
  if (/bank/i.test(content)) return { category: "财务", confidence: 0.92 };
  return { category: "未分类", confidence: 0.4 };
}

function sse(res, id, model, content) {
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      choices: [{ delta, finish_reason: finish }],
    })}\n\n`;
  res.write(chunk({ role: "assistant" }));
  res.write(chunk({ content }));
  res.write(chunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          data: [
            { id: "mock-chat", object: "model" },
            { id: "mock-embedding", object: "model" },
          ],
        }),
      );
    }
    if (url.pathname.endsWith("/chat/completions")) {
      const payload = body ? JSON.parse(body) : {};
      const messages = payload.messages ?? [];
      const result = mockClassify(messages);
      const content = `MOCK::${JSON.stringify(result)}`;
      const id = `mock-${Date.now()}`;
      if (payload.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return sse(res, id, "mock-chat", content);
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          model: "mock-chat",
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      );
    }
    if (url.pathname.endsWith("/embeddings")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          data: [{ embedding: new Array(8).fill(0.1), object: "embedding" }],
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
      );
    }
    res.writeHead(404).end();
  });
});

server.listen(PORT, () => console.log(`[llm-mock] on http://localhost:${PORT}/v1`));
