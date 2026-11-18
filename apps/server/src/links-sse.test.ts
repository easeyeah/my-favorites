/** F5 死链检测 SSE 进度流：逐条推送 / 完成 / 断开中止 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

/** 解析 SSE 文本流为帧（event:\n data:\n 空行分帧） */
function parseSse(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of raw.split("\n\n")) {
    const event = block.match(/^event:\s*(\S+)/m)?.[1];
    const dataLines = block.split("\n").filter((l) => l.startsWith("data:"));
    if (!event || dataLines.length === 0) continue;
    frames.push({
      event,
      data: JSON.parse(dataLines.map((l) => l.slice(5).trimStart()).join("\n")) as Record<string, unknown>,
    });
  }
  return frames;
}

describe("GET /maintenance/links/run/stream（SSE 进度流）", () => {
  it("逐条推送 item 事件（含域名级 host 与判定），结束推送 done", async () => {
    env = makeEnv(null);
    // 本地"正常站"（真实监听 → normal）+ 不可达端口（ECONNREFUSED → dead）
    const okServer = http.createServer((_q, r) => {
      r.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => okServer.listen(31802, r));
    await env.app.request("/api/v1/bookmarks/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "sse-link-check-01",
        items: [
          { url: "http://127.0.0.1:31802/alive", title: "可达页", folderPath: [] },
          { url: "http://127.0.0.1:59997/dead", title: "死链页", folderPath: [] },
        ],
      }),
    });
    const res = await env.app.request("/api/v1/maintenance/links/run/stream?limit=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const raw = await res.text(); // 流完成后关闭，text() 返回全量
    const frames = parseSse(raw);

    const events = frames.map((f) => f.event);
    expect(events[0]).toBe("start");
    expect(frames[0]?.data.total).toBe(2);
    expect(events.filter((e) => e === "item")).toHaveLength(2);
    expect(events.at(-1)).toBe("done");

    const items = frames.filter((f) => f.event === "item");
    for (const it of items) {
      expect(typeof it.data.i).toBe("number");
      // 域名级展示（host[:port]，不含路径与参数）
      expect(String(it.data.host)).toMatch(/^[\w.-]+(:\d+)?$/);
      expect(["normal", "suspect", "dead"]).toContain(it.data.verdict);
    }
    const byTitle = (title: string) =>
      items.find((f) => f.data.title === title)?.data.verdict as string | undefined;
    expect(byTitle("可达页")).toBe("normal");
    expect(byTitle("死链页")).toBe("dead");
    const done = frames.at(-1)?.data as { checked: number; reportId: string; dead: number };
    expect(done.checked).toBe(2);
    expect(done.dead).toBe(1);
    expect(done.reportId).toBeTruthy();
    // 书签状态已随每条落库
    expect(env.store.countBookmarks().dead).toBeGreaterThanOrEqual(1);
    okServer.close();
  });

  it("onProgress 返回 false（客户端断开）→ 停止后续探测且已检条目照常写报告", async () => {
    env = makeEnv(null);
    await env.app.request("/api/v1/bookmarks/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "sse-link-check-02",
        items: [
          { url: "http://127.0.0.1:1/a", title: "A", folderPath: [] },
          { url: "http://127.0.0.1:1/b", title: "B", folderPath: [] },
          { url: "http://127.0.0.1:1/c", title: "C", folderPath: [] },
        ],
      }),
    });
    // 直接调用服务层模拟第一条后断开
    let seen = 0;
    const result = await env.maintenance.runLinkCheckWithProgress(3, () => {
      seen++;
      return seen >= 1 ? false : true; // 第一条后中止
    });
    expect(seen).toBe(1);
    expect(result.checked).toBe(1); // 只检查了第一条
    expect(result.results).toHaveLength(1);
  });

  it("POST /maintenance/links/run 保持兼容（JSON 同步语义不变）", async () => {
    env = makeEnv(null);
    await env.app.request("/api/v1/bookmarks/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "sse-link-check-03",
        items: [{ url: "http://127.0.0.1:1/x", title: "X", folderPath: [] }],
      }),
    });
    const res = await env.app.request("/api/v1/maintenance/links/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    });
    const body = (await res.json()) as { checked: number; results: unknown[]; reportId: string };
    expect(res.status).toBe(200);
    expect(body.checked).toBe(1);
    expect(body.reportId).toBeTruthy();
  });
});
