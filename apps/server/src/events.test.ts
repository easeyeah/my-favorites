/** D50 变更事件流：ChangeHub 广播 + GET /events/stream SSE 契约 */
import { afterEach, describe, expect, it } from "vitest";
import { ChangeHub } from "./events";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("ChangeHub", () => {
  it("订阅/退订；单订阅者异常隔离不阻断其他", () => {
    const hub = new ChangeHub();
    const got: string[] = [];
    const unsubBad = hub.subscribe(() => {
      throw new Error("boom");
    });
    const unsubGood = hub.subscribe((ev) => got.push(ev.op));
    hub.publish({ entity: "bookmark", entity_id: "x", op: "upsert", device: null });
    expect(got).toEqual(["upsert"]);
    unsubBad();
    unsubGood();
    hub.publish({ entity: "bookmark", entity_id: "y", op: "delete", device: null });
    expect(got).toEqual(["upsert"]);
    expect(hub.size).toBe(0);
  });
});

describe("GET /events/stream（D50 门铃推送）", () => {
  async function openStream(): Promise<{ res: Response; frames: () => Promise<string[]>; stop: () => void }> {
    const ac = new AbortController();
    const res = await env.app.request("/api/v1/events/stream", { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const collected: string[] = [];
    let closed = false;
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        buf += dec.decode(value, { stream: true });
        let cut = buf.indexOf("\n\n");
        while (cut >= 0) {
          collected.push(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
          cut = buf.indexOf("\n\n");
        }
      }
    })();
    void pump;
    const frames = async (): Promise<string[]> => {
      const t0 = Date.now();
      while (collected.length < 2 && Date.now() - t0 < 5000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return [...collected];
    };
    return { res, frames, stop: () => ((closed = true), ac.abort()) };
  }

  it("连接先收 hello；变更后 1 秒级收到 change；连发合并", async () => {
    env = makeEnv();
    const s = await openStream();
    expect(s.res.status).toBe(200);
    const t = setTimeout(async () => {
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://d50.example/a", title: "A" }),
      });
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://d50.example/b", title: "B" }),
      });
    }, 1500);
    const got = await s.frames();
    clearTimeout(t);
    expect(got[0]).toContain("event: hello");
    const change = got.find((f) => f.includes("event: change"));
    expect(change).toBeTruthy();
    // 两次 POST 间隔 <1s → 应被合并为 1 帧（门铃语义：合并窗口防整理批次刷屏）
    expect(got.filter((f) => f.includes("event: change")).length).toBe(1);
    s.stop();
  });

  it("无订阅者时 recordChange 不受影响；store 钩子异常被隔离", async () => {
    env = makeEnv();
    env.store.onRecorded = () => {
      throw new Error("listener boom");
    };
    const res = await env.app.request("/api/v1/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://d50.example/c", title: "C" }),
    });
    expect(res.status).toBe(201);
    const pull = (await (await env.app.request("/api/v1/sync/pull?cursor=0&device=x")).json()) as {
      items: Array<{ op: string }>;
    };
    expect(pull.items.some((i) => i.op === "upsert")).toBe(true);
  });
});
