import { describe, expect, it } from "vitest";

// 最小集成测试：healthz 契约稳定（Docker 内全量集成测试同款起点）
describe("server", () => {
  it("GET /healthz 返回形态与版本", async () => {
    const app = (await import("./index")).default;
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; form: string; version: string };
    expect(body.ok).toBe(true);
    expect(body.form).toBe("self-hosted");
  });
});
