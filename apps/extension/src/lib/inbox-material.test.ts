import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  api: vi.fn(), getConfig: vi.fn(),
  browser: { bookmarks: { getChildren: vi.fn(), get: vi.fn(), remove: vi.fn() }, storage: { local: { set: vi.fn() } } },
}));
vi.mock("wxt/browser", () => ({ browser: mocks.browser }));
vi.mock("./api", () => ({ api: mocks.api, getConfig: mocks.getConfig }));
vi.mock("./device", () => ({ getDeviceId: async () => "device" }));
vi.mock("./executor", () => ({ withBrowserExecutor: async (fn: () => Promise<unknown>) => fn() }));
import { reconcileInboxMaterials } from "./inbox-material";

const account = { favoritesSync: false, inboxExtId: "inbox", serverUrl: "https://fixture.invalid", token: "fixture-session" };
const node = { id: "node", parentId: "inbox", title: "Video", url: "https://www.bilibili.com/video/BVtest" };
const identity = { browser_bookmark_id: "node", app_bookmark_id: "app", materialized: 1, url_raw: node.url };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getConfig.mockResolvedValue({ ...account });
  mocks.browser.bookmarks.getChildren.mockResolvedValue([{ ...node }]);
  mocks.browser.bookmarks.get.mockResolvedValue([{ ...node }]);
  mocks.browser.bookmarks.remove.mockResolvedValue(undefined);
  mocks.browser.storage.local.set.mockResolvedValue(undefined);
  mocks.api.mockResolvedValue({ identities: [{ ...identity }] });
});

describe("D91 关闭全量同步时的收纳盒资料收敛", () => {
  it("只撤下盒内受管、URL一致且已转换的节点", async () => {
    expect(await reconcileInboxMaterials()).toBe(1);
    expect(mocks.browser.bookmarks.remove).toHaveBeenCalledWith("node");
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it("同步开启或未登录时不旁路引擎、不读取身份", async () => {
    mocks.getConfig.mockResolvedValue({ ...account, favoritesSync: true });
    expect(await reconcileInboxMaterials()).toBe(0);
    mocks.getConfig.mockResolvedValue({ ...account, token: null });
    expect(await reconcileInboxMaterials()).toBe(0);
    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.browser.bookmarks.remove).not.toHaveBeenCalled();
  });

  it.each([
    { identities: [] },
    { identities: [{ ...identity, materialized: 0 }] },
    { identities: [{ ...identity, url_raw: "https://different.invalid/" }] },
  ])("未绑定、仍为书签或URL不一致的条目不动：%o", async (reply) => {
    mocks.api.mockResolvedValue(reply);
    expect(await reconcileInboxMaterials()).toBe(0);
    expect(mocks.browser.bookmarks.remove).not.toHaveBeenCalled();
  });

  it("用户已移出收纳盒或编辑URL时不覆盖手动意图", async () => {
    mocks.browser.bookmarks.get.mockResolvedValue([{ ...node, parentId: "user-folder" }]);
    expect(await reconcileInboxMaterials()).toBe(0);
    mocks.browser.bookmarks.get.mockResolvedValue([{ ...node, url: "https://edited.invalid/" }]);
    expect(await reconcileInboxMaterials()).toBe(0);
    expect(mocks.browser.bookmarks.remove).not.toHaveBeenCalled();
  });

  it("请求期间切换账号，旧身份响应不修改浏览器", async () => {
    mocks.getConfig.mockResolvedValueOnce({ ...account }).mockResolvedValue({ ...account, token: "new-fixture-session" });
    expect(await reconcileInboxMaterials()).toBe(0);
    expect(mocks.browser.bookmarks.remove).not.toHaveBeenCalled();
  });

  it("失败落持久状态，后续alarm可再次从浏览器候选恢复", async () => {
    mocks.api.mockRejectedValueOnce(new Error("offline"));
    expect(await reconcileInboxMaterials()).toBe(0);
    expect(mocks.browser.storage.local.set).toHaveBeenCalledWith({ mfInboxMaterialError: expect.objectContaining({ reason: "Error: offline" }) });
    expect(await reconcileInboxMaterials()).toBe(1);
    expect(mocks.browser.storage.local.set).toHaveBeenLastCalledWith({ mfInboxMaterialError: null });
  });
});
