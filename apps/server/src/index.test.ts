import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("healthz", () => {
  it("根路径 /healthz（Docker HEALTHCHECK 约定）", async () => {
    env = makeEnv();
    const res = await env.app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; form: string };
    expect(body.ok).toBe(true);
    expect(body.form).toBe("self-hosted");
  });

  it("/api/v1 前缀可用", async () => {
    env = makeEnv();
    const res = await env.app.request("/api/v1/stats");
    expect(res.status).toBe(200);
  });
});
