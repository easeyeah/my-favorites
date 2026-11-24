import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { localGet, localSet } = vi.hoisted(() => ({ localGet: vi.fn(), localSet: vi.fn() }));
vi.mock("wxt/browser", () => ({
  browser: { storage: { local: { get: localGet, set: localSet } } },
}));

import { getServerNotifyStyle } from "./api";

const account = { serverUrl: "https://a.example", token: "token-a" };
const fetchMock = vi.fn<typeof fetch>();
let stored: Record<string, unknown>;

beforeEach(() => {
  stored = { ...account, notifyStyle: "silent" };
  localGet.mockReset().mockImplementation(async () => ({ ...stored }));
  localSet.mockReset().mockImplementation(async (patch: Record<string, unknown>) => {
    Object.assign(stored, patch);
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("管理台统一通知偏好", () => {
  it.each([
    { body: {}, expected: "toast" },
    { body: { notifyStyle: "toast" }, expected: "toast" },
    { body: { notifyStyle: "silent" }, expected: "silent" },
    { body: { notifyStyle: "card" }, expected: "card" },
  ])("读取服务端 $body；旧本地 silent 不覆盖服务端或默认值", async ({ body, expected }) => {
    fetchMock.mockResolvedValue(Response.json(body));

    expect(await getServerNotifyStyle(account)).toBe(expected);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://a.example/api/v1/settings/prefs");
    expect(init).toMatchObject({
      headers: { authorization: "Bearer token-a" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      priority: "low",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(stored.notifyStyle).toBe("silent"); // 不迁移/回写旧本地偏好
    expect(stored.mfNotifyPrefsLastError).toBeNull();
  });

  it("每次完成通知重新读取，不缓存旧账号或管理台修改前的值", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ notifyStyle: "silent" }))
      .mockResolvedValueOnce(Response.json({ notifyStyle: "toast" }));
    expect(await getServerNotifyStyle()).toBe("silent");
    expect(await getServerNotifyStyle()).toBe("toast");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 500])("HTTP %i 不影响整理，降级 toast 并记录脱敏原因", async (status) => {
    fetchMock.mockResolvedValue(new Response("not a preference response", { status }));

    expect(await getServerNotifyStyle()).toBe("toast");
    expect(stored.mfNotifyPrefsLastError).toEqual({ reason: `http_${status}`, at: expect.any(String) });
    expect(console.warn).toHaveBeenCalled();
  });

  it.each([
    { body: { notifyStyle: "unknown" }, reason: "invalid_notify_style" },
    { body: { notifyStyle: null }, reason: "invalid_notify_style" },
    { body: null, reason: "invalid_response" },
    { body: [], reason: "invalid_response" },
  ])("非法偏好 $body 安全降级，不消费本地 silent", async ({ body, reason }) => {
    fetchMock.mockResolvedValue(Response.json(body));
    expect(await getServerNotifyStyle()).toBe("toast");
    expect(stored.mfNotifyPrefsLastError).toMatchObject({ reason });
  });

  it("网络失败留下诊断而非抛错，且不记录令牌或原始异常", async () => {
    fetchMock.mockRejectedValue(new Error(`private failure containing ${account.token}`));
    expect(await getServerNotifyStyle()).toBe("toast");
    expect(stored.mfNotifyPrefsLastError).toMatchObject({ reason: "request_failed" });
    expect(JSON.stringify(localSet.mock.calls)).not.toContain(account.token);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(account.token);
  });

  it("非 JSON 响应安全降级并可观测", async () => {
    fetchMock.mockResolvedValue(new Response("not json"));
    expect(await getServerNotifyStyle()).toBe("toast");
    expect(stored.mfNotifyPrefsLastError).toMatchObject({ reason: "request_failed" });
  });

  it.each(["request", "body"])("3 秒整体预算覆盖 %s 阶段，不永久等待", async (stage) => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const untilAborted = (signal: AbortSignal): Promise<never> =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    fetchMock.mockImplementation(async (_url, init) => {
      const signal = init!.signal!;
      if (stage === "request") return untilAborted(signal);
      return { ok: true, json: () => untilAborted(signal) } as unknown as Response;
    });

    const result = getServerNotifyStyle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toBe("toast");
    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(3000);
    expect(stored.mfNotifyPrefsLastError).toMatchObject({ reason: "timeout" });
  });

  it.each([
    { name: "切服务", next: { serverUrl: "https://b.example", token: "token-b" } },
    { name: "同服务换号", next: { serverUrl: account.serverUrl, token: "token-b" } },
    { name: "退出", next: { serverUrl: account.serverUrl, token: "" } },
  ])("请求期间$name：地址与令牌来自同一快照，丢弃旧账号响应", async ({ next }) => {
    fetchMock.mockImplementationOnce(async () => {
      Object.assign(stored, next);
      return Response.json({ notifyStyle: "silent" });
    });

    expect(await getServerNotifyStyle(account)).toBeNull();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${account.serverUrl}/api/v1/settings/prefs`);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ authorization: `Bearer ${account.token}` });
    expect(localSet).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(Response.json({ notifyStyle: "toast" }));
    expect(await getServerNotifyStyle()).toBe("toast");
    if (next.token) {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[0]).toBe(`${next.serverUrl}/api/v1/settings/prefs`);
      expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ authorization: `Bearer ${next.token}` });
    } else {
      expect(fetchMock).toHaveBeenCalledOnce(); // 不匿名读取开发服务 owner 偏好
    }
  });

  it("整理完成前已换号：不为旧任务请求新账号偏好", async () => {
    stored.token = "token-b";
    expect(await getServerNotifyStyle(account)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("请求失败期间换号：不将 fallback 通知或诊断应用到新账号", async () => {
    fetchMock.mockImplementationOnce(async () => {
      stored.token = "token-b";
      throw new Error("offline");
    });
    expect(await getServerNotifyStyle(account)).toBeNull();
    expect(localSet).not.toHaveBeenCalled();
  });

  it("诊断写入期间切服务：返回前再次核对身份", async () => {
    fetchMock.mockResolvedValue(Response.json({ notifyStyle: "silent" }));
    localSet.mockImplementationOnce(async () => {
      stored.serverUrl = "https://b.example";
      stored.token = "token-b";
    });
    expect(await getServerNotifyStyle(account)).toBeNull();
  });

  it("未登录时不复用服务记忆的令牌，也不匿名读 owner 偏好", async () => {
    stored.token = "";
    stored.serverTokens = { [account.serverUrl]: account.token, "https://b.example": "token-b" };
    expect(await getServerNotifyStyle()).toBe("toast");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("诊断存储失败不改变服务端偏好或阻断完成通知", async () => {
    fetchMock.mockResolvedValue(Response.json({ notifyStyle: "silent" }));
    localSet.mockRejectedValue(new Error("storage unavailable"));
    expect(await getServerNotifyStyle()).toBe("silent");
    expect(console.warn).toHaveBeenCalled();
  });
});
