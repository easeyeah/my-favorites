/**
 * D91 收纳盒自动转资料集成测试：
 *  - 视频/图片（URL 线索，无 LLM 也可）：收纳盒异步分流，不先建普通目录；
 *    隐藏行锚定唯一系统盒，资料/MCP/导出保留，发 materialize（绝非 delete）。
 *  - 文章必须以授权正文经独立内容判定，不用标题/URL布尔或字数兜底移出；
 *  - 抓取失败 → 书签保留；非收纳盒路径（无 placed 状态）不转；dismissed 资料不转；
 *  - 回滚转换版本 = 恢复书签（资料保留 + upsert change），再回滚 undo 版本重新转；
 *  - POST /materials/:id/restore 恢复；转资料态 dismiss 被 409 拦。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@mf/ai/llm-client";
import { makeEnv, type TestEnv } from "./test-env";
import { Pipeline } from "./pipeline";
import { currentUserId, runAsUser } from "./tenancy";
import { MIGRATION_V17_MATERIAL_CONVERT } from "./migrate";
import { backfillMaterials } from "./materials";
import { startMaterialConversionSweep } from "./maintenance";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};
const articleResponse = () => ({ ok: true, status: 200, readBody: async () => longArticleHtml(), dispose: () => undefined });
const postJson = (path: string, body: unknown) => env.app.request(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

let env: TestEnv;

afterEach(async () => {
  await env?.pipeline.scanIdle();
  env?.cleanup();
  env = undefined as unknown as TestEnv;
});

function fakeLlm(opts: { material: boolean; category?: string; confidence?: number }) {
  return {
    chatJson: async (messages: Array<{ role: string; content: string }>) => {
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("摘要助手")) {
        return { summary: "测试摘要", tags: ["测试"], keywords: ["test"], category: ["其他"] };
      }
      return {
        results: [
          {
            index: 0,
            category: opts.category ?? "阅读",
            confidence: opts.confidence ?? 0.95,
            material: opts.material,
          },
        ],
      };
    },
  } as unknown as LlmClient;
}

async function addInboxItem(url: string, title: string): Promise<string> {
  const inbox = (await (
    await env.app.request("/api/v1/inbox/setup", { method: "POST" })
  ).json()) as { id: string };
  const bm = (await (
    await env.app.request("/api/v1/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, title, folderId: inbox.id }),
    })
  ).json()) as { id: string };
  return bm.id;
}

async function processAndDrain(bmId: string) {
  const res = await env.app.request("/api/v1/inbox/process", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookmarkIds: [bmId] }),
  });
  const body = (await res.json()) as { moved: unknown[] };
  await env.pipeline.scanIdle();
  return body;
}

const longArticleHtml = () =>
  Buffer.from(
    `<html><body><article>${"这是一篇值得收藏的测试文章正文内容，用于验证收纳盒自动转资料链路。".repeat(12)}</article></body></html>`,
  );

describe("D91 收纳盒自动转资料", () => {
  it.each(["done", "cancelled"])("任务进入 %s 后不保留临时授权正文副本", async (state) => {
    env = makeEnv(null);
    const id = await addInboxItem("https://evidence.example.org/article", "授权正文清理");
    env.store.authorizeMaterialCandidateText(id, "临时授权正文".repeat(50));
    expect(env.store.getMaterialCandidate(id)?.authorized_text).toBeTruthy();
    env.store.setMaterialCandidateState(id, state);
    expect(env.store.getMaterialCandidate(id)?.authorized_text).toBeNull();
  });

  it("隐私规则清理同步清掉待识别正文并取消旧任务，书签本体保留", async () => {
    env = makeEnv(null);
    const url = "https://evidence.example.org/private";
    const id = await addInboxItem(url, "隐私清理候选");
    env.store.authorizeMaterialCandidateText(id, "已授权但尚未处理的正文".repeat(30));
    env.store.purgeContentForPrivacyRules((target) => target === url);
    expect(env.store.getMaterialCandidate(id)).toMatchObject({ state: "cancelled", authorized_text: null, fail_reason: "privacy_rules_changed" });
    expect(env.store.getBookmark(id)).toBeTruthy();
  });
  it("视频：物化后自动转资料——书签面全部排除、资料面可见、版本与变更日志正确", async () => {
    env = makeEnv(null); // 视频纯规则，不依赖 LLM
    const bmId = await addInboxItem("https://www.bilibili.com/video/BV1xx411c91A", "测试视频");
    const r = await processAndDrain(bmId);
    expect(r.moved.length).toBe(0); // D91：媒体不先归普通目录

    const bm = env.store.getBookmark(bmId)!;
    expect(bm.materialized_at).toBeTruthy();

    // 书签面：列表/搜索/快照/目录计数全部排除
    expect(env.store.listBookmarks({}).some((b) => b.id === bmId)).toBe(false);
    expect(env.store.search("测试视频").some((b) => b.id === bmId)).toBe(false);
    expect(env.store.syncSnapshot().bookmarks.some((b) => b.id === bmId)).toBe(false);
    const tree = env.store.folderTree(false).find((f) => f.id === bm.folder_id);
    expect(tree?.directCount ?? 0).toBe(0);

    // 资料面：正常可见且带 materialized 标志
    const matRef = env.store.getActiveMaterialByBookmark(bmId)!;
    expect(matRef).toBeTruthy();
    const mat = env.store.getMaterial(matRef.id)!;
    expect(mat.type).toBe("video");
    expect(Number(mat.materialized)).toBe(1);
    const listed = env.store.listMaterials({});
    expect(listed.some((m) => m.bookmark_id === bmId && Number(m.materialized) === 1)).toBe(true);

    // 版本：label=material_convert，动作带原目录
    const versions = env.store.listVersions();
    const convert = versions.find((v) => v.label === "material_convert")!;
    expect(convert).toBeTruthy();
    expect(convert.actionCount).toBe(1);

    // 去向历史：materialized=1 + 转换版本
    const placed = env.store.listInboxRecentPlaced().find((p) => p.bookmark_id === bmId)!;
    expect(placed.materialized).toBe(1);
    expect(placed.convert_version_id).toBe(convert.id);

    // 转换不能伪装真实删除：事件携带完整隐藏元数据与修订，供端侧安全收敛。
    const pulled = env.store.pullChanges(0, "test-device").items;
    const change = pulled.find((ch) => ch.entity === "bookmark" && ch.entity_id === bmId && ch.op === "materialize");
    expect(change).toBeTruthy();
    expect(change?.payload).toMatchObject({ id: bmId, url_raw: bm.url_raw, materialized_at: bm.materialized_at, content_revision: bm.content_revision });
    expect(pulled.some((ch) => ch.entity_id === bmId && ch.op === "delete")).toBe(false);
  });

  it("文章 material=true 且补抓成功：自动转资料", async () => {
    env = makeEnv(fakeLlm({ material: true }), false, {
      crawlFetcher: async () => ({
        ok: true,
        status: 200,
        readBody: async () => longArticleHtml(),
        dispose: () => undefined,
      }),
    });
    const bmId = await addInboxItem("https://good-reads.example.net/post/99", "一篇深度文章");
    const r = await processAndDrain(bmId);
    expect(r.moved.length).toBe(1);
    const matRef = env.store.getActiveMaterialByBookmark(bmId);
    expect(matRef).toBeTruthy();
    expect(env.store.getMaterial(matRef!.id)!.type).toBe("article");
    expect(env.store.getBookmark(bmId)!.materialized_at).toBeTruthy();
  });

  it("文章 material=false（工具首页内容壳）：书签保留不转", async () => {
    env = makeEnv(fakeLlm({ material: false }), false, {
      crawlFetcher: async () => ({
        ok: true,
        status: 200,
        readBody: async () => Buffer.from("<html>x</html>"),
        dispose: () => undefined,
      }),
    });
    const bmId = await addInboxItem("https://tool-home.example.com/", "某工具首页");
    await processAndDrain(bmId);
    expect(env.store.getActiveMaterialByBookmark(bmId)).toBeFalsy();
    expect(env.store.getBookmark(bmId)!.materialized_at).toBeFalsy();
    expect(env.store.listBookmarks({}).some((b) => b.id === bmId)).toBe(true);
  });

  it("文章补抓失败：书签保留（原因落 fail_reason，不发转换版本）", async () => {
    env = makeEnv(fakeLlm({ material: true }), false, {
      crawlFetcher: async () => ({
        ok: false,
        status: 500,
        readBody: async () => Buffer.from(""),
        dispose: () => undefined,
      }),
    });
    const bmId = await addInboxItem("https://broken-blog.example.com/post/1", "抓取失败的文章");
    await processAndDrain(bmId);
    expect(env.store.getBookmark(bmId)!.materialized_at).toBeFalsy();
    expect(String(env.store.getCache(bmId)?.fail_reason ?? "")).toContain("crawl_failed");
    expect(env.store.listVersions().some((v) => v.label === "material_convert")).toBe(false);
  });

  it("非收纳盒路径（无 placed 状态）：即使物化成功也不转", async () => {
    env = makeEnv(null);
    const folder = env.store.ensurePath(["视频"]);
    const bm = env.store.createBookmark({
      folderId: folder.id,
      urlRaw: "https://www.youtube.com/watch?v=abc12345",
      urlCanonical: "https://www.youtube.com/watch?v=abc12345",
      title: "直接收藏的视频",
    });
    await env.pipeline.materialize(bm.id); // POST /bookmarks 同款即时物化
    const converted = env.pipeline.commitMaterialConversions([bm.id]);
    expect(converted).toBe(0);
    expect(env.store.getBookmark(bm.id)!.materialized_at).toBeFalsy();
  });

  it("dismissed 资料不转换：物化核验失败 → 书签保留（store 级确定性构造）", async () => {
    env = makeEnv(null);
    const folder = env.store.ensurePath(["视频"]);
    const bm = env.store.createBookmark({
      folderId: folder.id,
      urlRaw: "https://www.youtube.com/watch?v=zzz9999",
      urlCanonical: "https://www.youtube.com/watch?v=zzz9999",
      title: "被移出的视频",
    });
    env.store.upsertInboxState(bm.id, "placed", null, "视频", 0);
    env.store.upsertMaterial({ bookmarkId: bm.id, type: "video", signals: ["YouTube"] });
    const mat = env.store.getActiveMaterialByBookmark(bm.id)!;
    expect(env.store.dismissMaterial(mat.id)).toBe(true);
    expect(env.pipeline.commitMaterialConversions([bm.id])).toBe(0);
    expect(env.store.convertToMaterial(bm.id)).toBe(false);
    expect(env.store.getBookmark(bm.id)!.materialized_at).toBeFalsy();
  });

  it("回滚转换版本：书签恢复、资料保留、发 upsert change；再回滚 undo 版本重新转", async () => {
    env = makeEnv(null);
    const bmId = await addInboxItem("https://www.bilibili.com/video/BV1xx411c92B", "可撤销视频");
    await processAndDrain(bmId);
    const convertVersion = env.store.listVersions().find((v) => v.label === "material_convert")!.id;

    // 第一次回滚：恢复为书签
    const r1 = await env.app.request(`/api/v1/organize/rollback/${convertVersion}`, { method: "POST" });
    const b1 = (await r1.json()) as { reversed: number; undoVersionId: string };
    expect(b1.reversed).toBe(1);
    expect(env.store.getBookmark(bmId)!.materialized_at).toBeFalsy();
    expect(env.store.listBookmarks({}).some((b) => b.id === bmId)).toBe(true);
    expect(env.store.syncSnapshot().bookmarks.some((b) => b.id === bmId)).toBe(true);
    expect(env.store.getActiveMaterialByBookmark(bmId)).toBeTruthy(); // 资料保留
    const pulled = env.store.pullChanges(0, "test-device").items;
    expect(
      pulled.some((ch) => ch.entity === "bookmark" && ch.entity_id === bmId && ch.op === "upsert"),
    ).toBe(true);

    // 再回滚 undo 版本：重新转资料
    const r2 = await env.app.request(`/api/v1/organize/rollback/${b1.undoVersionId}`, { method: "POST" });
    const b2 = (await r2.json()) as { reversed: number };
    expect(b2.reversed).toBe(1);
    expect(env.store.getBookmark(bmId)!.materialized_at).toBeTruthy();
    expect(env.store.listVersions().some((v) => v.label === "material_convert")).toBe(true);
  });

  it("REST：转资料态 restore 恢复；重复恢复 409；dismiss 被 409 拦，恢复后可 dismiss", async () => {
    env = makeEnv(null);
    const bmId = await addInboxItem("https://www.bilibili.com/video/BV1xx411c93C", "REST 视频");
    await processAndDrain(bmId);
    const matId = env.store.getActiveMaterialByBookmark(bmId)!.id;

    const delRes = await env.app.request(`/api/v1/materials/${matId}`, { method: "DELETE" });
    expect(delRes.status).toBe(409);
    expect(env.store.getActiveMaterialByBookmark(bmId)).toBeTruthy(); // 未被动

    const res1 = await env.app.request(`/api/v1/materials/${matId}/restore`, { method: "POST" });
    expect(res1.status).toBe(200);
    expect(env.store.getBookmark(bmId)!.materialized_at).toBeFalsy();

    const res2 = await env.app.request(`/api/v1/materials/${matId}/restore`, { method: "POST" });
    expect(res2.status).toBe(409);

    // 恢复后 = 双份并存，dismiss 资料（书签保留）恢复现状语义
    const res3 = await env.app.request(`/api/v1/materials/${matId}`, { method: "DELETE" });
    expect(res3.status).toBe(200);
    expect(env.store.getBookmark(bmId)).toBeTruthy();
  });

  it("REST：重复收藏已转资料的 URL → duplicate 带 materialized 标志，不复活书签", async () => {
    env = makeEnv(null);
    const bmId = await addInboxItem("https://www.bilibili.com/video/BV1xx411c94E", "查重视频");
    await processAndDrain(bmId);
    const res = await env.app.request("/api/v1/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.bilibili.com/video/BV1xx411c94E", title: "再收藏一次" }),
    });
    const body = (await res.json()) as { duplicate?: boolean; materialized?: boolean };
    expect(body.duplicate).toBe(true);
    expect(body.materialized).toBe(true);
    expect(env.store.getBookmark(bmId)!.materialized_at).toBeTruthy(); // 未复活
  });

  it("P0：删计数为0的原目录不能级联毁资料，原目录已删时恢复到未整理且素材仍可读", async () => {
    env = makeEnv(fakeLlm({ material: true }), true, { crawlFetcher: async () => articleResponse() });
    const id = await addInboxItem("https://integrity.example.net/post/1", "目录删除资料不丢");
    await processAndDrain(id);
    const hidden = env.store.getBookmark(id)!;
    const original = hidden.materialized_from_folder_id!;
    const materialId = env.store.getActiveMaterialByBookmark(id)!.id;
    expect(original).not.toBe(hidden.folder_id);
    expect(hidden.folder_id).toBe(env.store.inboxFolder()!.id);
    expect(env.store.folderTree(false).find((f) => f.id === original)?.directCount).toBe(0);
    expect(env.store.deleteFolderTree(original)).toEqual({ folders: 1, bookmarks: 0 });
    expect(env.store.getMaterial(materialId)?.l2_text).toContain("测试文章正文");
    expect((await env.app.request(`/api/v1/materials/${materialId}/export`)).status).toBe(200);
    const mcp = await postJson("/api/v1/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "materials_get", arguments: { id: materialId } } });
    expect(JSON.stringify(await mcp.json())).toContain("测试文章正文");
    expect((await env.app.request(`/api/v1/materials/${materialId}/restore`, { method: "POST" })).status).toBe(200);
    const restored = env.store.getBookmark(id)!;
    expect(env.store.getFolder(restored.folder_id)?.name).toBe("未整理");
    expect(restored.content_revision).toBe(hidden.content_revision! + 1);
    expect(env.store.getMaterial(materialId)?.materialized).toBe(0);
    expect(env.store.getMaterial(materialId)?.l2_text).toContain("测试文章正文");
    expect(env.pipeline.resumeMaterialCandidates()).toBe(0);
  });

  it("P0：ifInbox取消与sync删除回声不能删隐藏行，app_exists=false但再次投递保留身份", async () => {
    env = makeEnv(null);
    const id = await addInboxItem("https://www.youtube.com/watch?v=protect1", "受保护资料");
    env.store.ensureDevice("device-safe");
    env.store.upsertIdentity({ deviceId: "device-safe", browserBookmarkId: "browser-safe", appBookmarkId: id });
    await processAndDrain(id);
    const materialId = env.store.getActiveMaterialByBookmark(id)!.id;
    expect(Number(env.store.identitiesWithState("device-safe")[0]!.app_exists)).toBe(0);
    const identities = await (await env.app.request("/api/v1/browser/identities?deviceId=device-safe&browserId=browser-safe")).json() as { identities: Array<{ materialized: number; url_raw: string | null }> };
    expect(identities.identities).toHaveLength(1);
    expect(identities.identities[0]).toMatchObject({ materialized: 1, url_raw: "https://www.youtube.com/watch?v=protect1" });
    expect(env.store.identitiesWithState("unrelated-device")).toEqual([]);
    expect((await env.app.request(`/api/v1/bookmarks/${id}?ifInbox=1`, { method: "DELETE" })).status).toBe(409);
    const del = await postJson("/api/v1/sync/apply", { deviceId: "device-safe", mutations: [
      { kind: "bookmark.delete", browserId: "browser-safe", opId: "delete-echo" },
    ] });
    expect((await del.json() as { results: Array<{ status: string }> }).results[0]!.status).toBe("noop");
    expect(env.store.getMaterial(materialId)).toBeTruthy();
    expect(env.store.findAppBookmarkId("device-safe", "browser-safe")).toBeUndefined();
    const map = await postJson("/api/v1/inbox/map", { deviceId: "device-safe", browserBookmarkId: "new-browser-node",
      url: "https://www.youtube.com/watch?v=protect1", title: "重复投递" });
    expect(await map.json()).toMatchObject({ bookmarkId: id, materialized: true });
    expect(env.store.findAppBookmarkId("device-safe", "new-browser-node")).toBe(id);
    expect(env.store.listInboxWithState()).toHaveLength(0);
    expect((await (await env.app.request("/api/v1/inbox/count")).json() as { count: number }).count).toBe(0);
    // 显式手动 DELETE 仍是真删除，不改变原有用户决定语义。
    expect((await env.app.request(`/api/v1/bookmarks/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(env.store.getMaterial(materialId)).toBeUndefined();
  });

  it("P1：隐藏更新不发活upsert/move，旧同步写入只能看到隐藏冲突", async () => {
    env = makeEnv(null);
    const id = await addInboxItem("https://www.youtube.com/watch?v=hidden-update", "隐藏更新");
    await processAndDrain(id);
    const hidden = env.store.getBookmark(id)!;
    const watermark = env.store.maxChangeId();
    const other = env.store.ensurePath(["其他目录"]);
    env.store.updateBookmark(id, { title: "资料新标题", folder_id: other.id });
    expect(env.store.getBookmark(id)!.folder_id).toBe(env.store.inboxFolder()!.id);
    const changes = env.store.pullChanges(watermark, "other-device").items.filter((ch) => ch.entity_id === id);
    expect(changes.map((ch) => ch.op)).toEqual(["materialize"]);
    expect(changes[0]!.payload).toMatchObject({ content_revision: hidden.content_revision! + 1, materialized_at: hidden.materialized_at });
    env.store.upsertIdentity({ deviceId: "hidden-device", browserBookmarkId: "h1", appBookmarkId: id });
    const updated = await postJson("/api/v1/sync/apply", { deviceId: "hidden-device", mutations: [
      { kind: "bookmark.update", browserId: "h1", title: "迟到编辑" },
      { kind: "bookmark.move", browserId: "h1", appFolderId: other.id },
      { kind: "bookmark.create", browserId: "h2", url: hidden.url_raw, title: "再建", folderPath: ["不应创建"] },
    ] });
    expect((await updated.json() as { results: Array<{ status: string }> }).results.map((r) => r.status)).toEqual(["conflict", "conflict", "conflict"]);
    expect(env.store.findFolderByName("不应创建")).toBeUndefined();
    expect((await env.app.request(`/api/v1/bookmarks/${id}`)).status).toBe(404);
    expect(env.store.getBookmark(id)!.title).toBe("资料新标题");
  });

  it("P1：转换撤销需要修订、代际、版本归属全部匹配，修改隐藏资料后旧版本不能覆盖", async () => {
    env = makeEnv(null);
    const id = await addInboxItem("https://www.youtube.com/watch?v=cas-1", "CAS转换");
    await processAndDrain(id);
    const version = env.store.listVersions().find((v) => v.label === "material_convert")!;
    const duplicateVersion = env.store.saveVersion(null, env.store.getVersion(version.id)!.actions, { label: "material_convert" });
    expect(env.organize.rollback(duplicateVersion).reversed).toBe(0); // 同修订/代际，但版本不拥有转换
    env.store.updateBookmark(id, { title: "用户修改过的资料标题" });
    expect(env.organize.rollback(version.id).reversed).toBe(0);
    expect(env.store.getBookmark(id)!.materialized_at).toBeTruthy();
  });

  it("P1：恢复后用户编辑阻止redo，正常redo递增转换代际且恢复不再自动转", async () => {
    env = makeEnv(null);
    const id = await addInboxItem("https://www.youtube.com/watch?v=cas-2", "CAS恢复");
    await processAndDrain(id);
    const initial = env.store.getBookmark(id)!;
    const versionId = initial.materialized_version_id!;
    const undo = env.organize.rollback(versionId);
    const visible = env.store.getBookmark(id)!;
    expect(visible.content_revision).toBe(initial.content_revision! + 1);
    expect(env.store.getMaterialCandidate(id)?.state).toBe("cancelled");
    expect(env.pipeline.commitMaterialConversions([id])).toBe(0);
    expect(env.organize.rollback(undo.undoVersionId).reversed).toBe(1);
    const redone = env.store.getBookmark(id)!;
    expect(redone.materialized_generation).toBe(initial.materialized_generation! + 1);
    expect(redone.content_revision).toBe(visible.content_revision! + 1);
    const undoAgain = env.organize.rollback(redone.materialized_version_id!);
    env.store.updateBookmark(id, { title: "用户恢复后改名" });
    expect(env.organize.rollback(undoAgain.undoVersionId).reversed).toBe(0);
    expect(env.store.getBookmark(id)!.materialized_at).toBeNull();
  });

  it("P0：本轮抓取失败不能凭既有active资料或旧缓存伪转", async () => {
    let fetched = 0;
    env = makeEnv(fakeLlm({ material: true }), false, { crawlFetcher: async () => {
      fetched++;
      return { ok: false, status: 500, readBody: async () => Buffer.from(""), dispose: () => undefined };
    } });
    const id = await addInboxItem("https://stale-cache.example.net/post/1", "旧资料失败重试");
    env.store.upsertMaterial({ bookmarkId: id, type: "article" });
    env.store.upsertCache({ bookmarkId: id, l2Text: "旧缓存不能证明本轮抓取成功".repeat(100), fetchedVia: "server_crawl" });
    await processAndDrain(id);
    expect(fetched).toBe(1);
    expect(env.store.getBookmark(id)!.materialized_at).toBeNull();
    expect(env.store.getMaterialCandidate(id)).toMatchObject({ state: "retry" });
    expect(env.store.getMaterialCandidate(id)?.fail_reason).toContain("HTTP 500");
    expect(env.pipeline.commitMaterialConversions([id])).toBe(0);
  });

  it("P0：异步抓取期间修改URL/隐私策略，旧内容不落新实体且不转换", async () => {
    const entered = deferred(); const release = deferred();
    env = makeEnv(fakeLlm({ material: true }), false, { crawlFetcher: async () => {
      entered.resolve(); await release.promise; return articleResponse();
    } });
    const id = await addInboxItem("https://race-content.example.net/post/1", "修改URL竞态");
    await postJson("/api/v1/inbox/process", { bookmarkIds: [id] });
    await entered.promise;
    try {
      await env.app.request(`/api/v1/bookmarks/${id}`, { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://race-content.example.net/different" }) });
      env.store.addPrivacyPattern("*.race-content.example.net");
    } finally { release.resolve(); }
    await env.pipeline.scanIdle();
    expect(env.store.getBookmark(id)!.materialized_at).toBeNull();
    expect(env.store.getCache(id)?.l2_text).toBeFalsy();
    expect(env.store.getMaterialCandidate(id)).toMatchObject({ state: "cancelled", fail_reason: "stale_url_revision_or_policy" });
  });

  it("P1：撤销归位取消在途和待转换资格，补扫不能重做用户撤销", async () => {
    const entered = deferred(); const release = deferred();
    env = makeEnv(fakeLlm({ material: true }), false, { crawlFetcher: async () => {
      entered.resolve(); await release.promise; return articleResponse();
    } });
    const id = await addInboxItem("https://undo-placement.example.net/post/1", "撤销归位");
    const result = await (await postJson("/api/v1/inbox/process", { bookmarkIds: [id] })).json() as { versionId: string };
    await entered.promise;
    try { expect(env.organize.rollback(result.versionId).reversed).toBe(1); }
    finally { release.resolve(); }
    await env.pipeline.scanIdle();
    expect(env.store.getBookmark(id)!.materialized_at).toBeNull();
    expect(env.store.getMaterialCandidate(id)?.state).toBe("cancelled");
    expect(env.pipeline.resumeMaterialCandidates()).toBe(0);
  });

  it("P1：长工具页面不能用800字/标题URL猜测兜底，必须通过正文判内容", async () => {
    const prompts: string[] = [];
    const llm = { chatJson: async (messages: Array<{ role: string; content: string }>) => {
      const sys = messages[0]!.content;
      if (sys.includes("判断每个网页")) {
        prompts.push(messages[1]!.content);
        return { results: [{ index: 0, material: false }] };
      }
      if (sys.includes("摘要助手")) return { summary: "摘要", tags: [], keywords: [] };
      return { results: [{ index: 0, category: "工具", confidence: 0.95, material: true }] };
    } } as unknown as LlmClient;
    env = makeEnv(llm, false, { crawlFetcher: async () => ({ ...articleResponse(),
      readBody: async () => Buffer.from(`<html>${"这是工具首页的导航菜单和功能列表。".repeat(100)}</html>`) }) });
    const id = await addInboxItem("https://long-tool.example.net/", "看似文章的标题");
    await processAndDrain(id);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("导航菜单和功能列表");
    expect(env.store.getBookmark(id)!.materialized_at).toBeNull();
    expect(env.store.getMaterialCandidate(id)).toMatchObject({ state: "done", fail_reason: "not_content_page" });
    await postJson("/api/v1/content/capture", { bookmarkId: id, l2Text: "后续捕获也不能旁路非内容判定。".repeat(100) });
    backfillMaterials(env.store);
    expect(env.store.getActiveMaterialByBookmark(id)).toBeUndefined();
  });

  it("P1：规则归位文章也按授权正文识别，已捕获正文无须再次抓取", async () => {
    let crawled = 0;
    env = makeEnv(fakeLlm({ material: true }), false, { crawlFetcher: async () => { crawled++; return articleResponse(); } });
    const id = await addInboxItem("https://github.com/example/guide", "开发文档");
    const captureText = "已经授权上传的实质文章内容。".repeat(50);
    await postJson("/api/v1/content/capture", { bookmarkId: id, l2Text: captureText });
    const result = await processAndDrain(id);
    expect(result.moved).toHaveLength(1); // github 命中规则，不依赖归位LLM的material布尔
    expect(crawled).toBe(0);
    expect(env.store.getBookmark(id)!.materialized_at).toBeTruthy();
    expect(env.store.getMaterial(env.store.getActiveMaterialByBookmark(id)!.id)?.l2_text).toBe(captureText);
  });

  it("P1：无LLM文章不自动移出，图片直接异步分流且不建随后空目录", async () => {
    let fetched = 0;
    env = makeEnv(null, false, { crawlFetcher: async () => { fetched++; return articleResponse(); } });
    const article = await addInboxItem("https://nolllm.example.net/post/1", "无模型文章");
    await postJson("/api/v1/content/capture", { bookmarkId: article, l2Text: "长文章不能长度兜底。".repeat(200) });
    await processAndDrain(article);
    expect(env.store.getBookmark(article)!.materialized_at).toBeNull();
    expect(env.store.getMaterialCandidate(article)?.fail_reason).toBe("llm_unavailable_for_content_judgment");
    expect(fetched).toBe(0);
    const image = await addInboxItem("https://cdn.example.net/photo.png", "无模型图片");
    const result = await (await postJson("/api/v1/inbox/process", { bookmarkIds: [image] })).json() as { moved: unknown[]; queued: string[] };
    expect(result.moved).toHaveLength(0);
    expect(result.queued).toContain(image);
    await env.pipeline.scanIdle();
    expect(env.store.getBookmark(image)!.materialized_at).toBeTruthy();
    expect(env.store.listFolders().filter((f) => !f.is_system_inbox)).toHaveLength(0);
  });

  it("P1：重启实例补扫仅持久新入口；失败可重试且不会回溯历史条目", async () => {
    let fetched = 0;
    const llm = fakeLlm({ material: true });
    env = makeEnv(llm, false, { crawlFetcher: async () => {
      fetched++;
      return { ok: false, status: 502, readBody: async () => Buffer.from(""), dispose: () => undefined };
    } });
    const id = await addInboxItem("https://persistent.example.net/post/1", "持久候选");
    await processAndDrain(id);
    expect(env.store.getMaterialCandidate(id)?.state).toBe("retry");
    const oldFolder = env.store.ensurePath(["存量"]);
    const old = env.store.createBookmark({ folderId: oldFolder.id, urlRaw: "https://www.youtube.com/watch?v=old-history", urlCanonical: "https://www.youtube.com/watch?v=old-history", title: "历史视频" });
    env.store.upsertInboxState(old.id, "placed", null, "存量", 0);
    env.store.upsertMaterial({ bookmarkId: old.id, type: "video" });
    env.store.db.prepare("UPDATE material_conversion_candidate SET next_attempt_at = NULL WHERE bookmark_id = ?").run(id);
    const restarted = new Pipeline(env.store, () => llm, { dataDir: env.dataDir, coverFetcher: async () => null, crawlFetcher: async () => { fetched++; return articleResponse(); } });
    expect(restarted.resumeMaterialCandidates()).toBe(1);
    await restarted.scanIdle();
    expect(fetched).toBe(2);
    expect(env.store.getBookmark(id)!.materialized_at).toBeTruthy();
    expect(env.store.getBookmark(old.id)!.materialized_at).toBeNull();
    expect(env.store.getMaterialCandidate(old.id)).toBeUndefined();
  });

  it("P1：同书签ID跨租户分别去重，全局任务/出站抓取并发始终为1", async () => {
    const entered = deferred(); const release = deferred();
    let active = 0; let max = 0; const called: string[] = [];
    env = makeEnv(null, false, { coverFetcher: async () => {
      active++; max = Math.max(max, active); called.push(currentUserId());
      entered.resolve(); await release.promise; active--;
      return null;
    } });
    for (const uid of ["tenant-a", "tenant-b"]) {
      runAsUser(uid, () => {
        const folder = env.store.ensurePath(["普通目录"]);
        const old = env.store.createBookmark({ folderId: folder.id, urlRaw: "https://cdn.example.net/shared.png", urlCanonical: "https://cdn.example.net/shared.png", title: uid });
        env.store.db.prepare("UPDATE bookmarks SET id = 'same-bookmark' WHERE id = ?").run(old.id);
        const inbox = env.store.createFolder("📥 收纳盒", null, "user", true);
        env.store.moveBookmark("same-bookmark", inbox.id);
        env.store.registerMaterialCandidate("same-bookmark");
        env.pipeline.enqueueInboxScan([{ id: "same-bookmark" }]);
        env.pipeline.enqueueInboxScan([{ id: "same-bookmark" }]); // 同租户去重
      });
    }
    await entered.promise;
    expect(called).toHaveLength(1);
    release.resolve();
    await env.pipeline.scanIdle();
    expect(max).toBe(1);
    expect(called).toEqual(["tenant-a", "tenant-b"]);
    for (const uid of called) runAsUser(uid, () => {
      expect(env.store.getBookmark("same-bookmark")!.materialized_at).toBeTruthy();
      expect(env.store.countMaterials().total).toBe(1);
    });
  });

  it("P1：隐藏资料不入死链/crawl/陈旧/书签读取候选，摘要失败仍能由内容补扫重试", async () => {
    const llm = { chatJson: async (messages: Array<{ content: string }>) => {
      if (messages[0]!.content.includes("摘要助手")) throw new Error("summary unavailable");
      return { results: [{ index: 0, category: "阅读", confidence: 0.95, material: true }] };
    } } as unknown as LlmClient;
    env = makeEnv(llm, true, { crawlFetcher: async () => articleResponse() });
    const id = await addInboxItem("https://summary-retry.example.net/post/1", "资料摘要补扫");
    await processAndDrain(id);
    expect(env.store.getBookmark(id)!.materialized_at).toBeTruthy();
    expect(env.store.candidatesForLinkCheck(100)).toHaveLength(0);
    expect(env.store.bookmarksMissingContent(100)).toHaveLength(0);
    expect(env.store.staleStats(-1).stale).toBe(0);
    expect(env.store.countBookmarks().total).toBe(0);
    expect(env.store.bookmarksMissingSummary(100).map((b) => b.id)).toContain(id);
    expect((await env.pipeline.crawlOne(id)).reason).toBe("not_found");
  });

  it("资料列表total先筛选再分页、类型counts全库、materialized数字；历史与去向支持页码", async () => {
    env = makeEnv(null);
    const folder = env.store.ensurePath(["分页样本"]);
    for (let i = 0; i < 25; i++) {
      const bm = env.store.createBookmark({ folderId: folder.id, urlRaw: `https://paging.example.net/${i}`, urlCanonical: `https://paging.example.net/${i}`, title: `样本${i}` });
      const mat = env.store.upsertMaterial({ bookmarkId: bm.id, type: i < 15 ? "article" : "video" });
      if (i < 12) env.store.setMaterialCategory(mat.id, ["技术", "前端"]);
      env.store.upsertInboxState(bm.id, "placed", null, "分页样本", 0);
      env.store.saveVersion(null, [{ type: "test", bookmarkId: bm.id }]);
    }
    const first = await (await env.app.request("/api/v1/materials")).json() as { items: Array<{ materialized: number }>; total: number; counts: Record<string, number> };
    expect(first.items).toHaveLength(10); expect(first.total).toBe(25);
    expect(first.counts).toEqual({ total: 25, article: 15, video: 10, image: 0 });
    expect(first.items.every((m: { materialized: unknown }) => m.materialized === 0)).toBe(true);
    const filtered = await (await env.app.request("/api/v1/materials?type=article&category=技术&q=样本&limit=10&offset=10")).json() as typeof first;
    expect(filtered.total).toBe(12); expect(filtered.items).toHaveLength(2); expect(filtered.counts.total).toBe(25);
    const history = await (await env.app.request("/api/v1/organize/versions?limit=10&offset=20")).json() as { total: number; versions: unknown[] };
    expect(history.total).toBe(25); expect(history.versions).toHaveLength(5);
    const placed = await (await env.app.request("/api/v1/inbox/items?placedLimit=10&placedOffset=20")).json() as { placedTotal: number; placed: unknown[]; items: unknown[] };
    expect(placed.placedTotal).toBe(25); expect(placed.placed).toHaveLength(5); expect(placed.items).toEqual([]);
    const empty = await (await env.app.request("/api/v1/materials?type=image")).json();
    expect(empty).toMatchObject({ items: [], total: 0, counts: { total: 25 } });
  });

  it("新入口落库/变更日志/持久候选登记失败须原子回滚", () => {
    env = makeEnv(null);
    const inbox = env.store.createFolder("📥 收纳盒", null, "user", true);
    const watermark = env.store.maxChangeId();
    const registration = vi.spyOn(env.store, "registerMaterialCandidate").mockImplementationOnce(() => { throw new Error("registration interrupted"); });
    try {
      expect(() => env.store.createBookmark({ folderId: inbox.id, urlRaw: "https://atomic.example.net/", urlCanonical: "https://atomic.example.net/", title: "原子新入口" })).toThrow("registration interrupted");
    } finally { registration.mockRestore(); }
    expect(env.store.countBookmarks().total).toBe(0);
    expect(env.store.maxChangeId()).toBe(watermark);
    expect(env.store.pendingMaterialCandidates()).toEqual([]);
  });

  it("本设备身份DTO区分可见/隐藏/已物理删除，不能泄露未持有的用户副本", async () => {
    env = makeEnv(null);
    const id = await addInboxItem("https://dto.example.net/", "可见入口");
    env.store.upsertIdentity({ deviceId: "dto-device", browserBookmarkId: "dto-browser", appBookmarkId: id });
    expect(env.store.identitiesWithState("dto-device")[0]).toMatchObject({ materialized: 0, url_raw: "https://dto.example.net/" });
    expect(Number(env.store.identitiesWithState("dto-device")[0]!.app_exists)).toBe(1);
    env.store.deleteBookmark(id);
    expect(env.store.identitiesWithState("dto-device")[0]).toMatchObject({ materialized: 0, url_raw: null });
    expect(Number(env.store.identitiesWithState("dto-device")[0]!.app_exists)).toBe(0);
    expect(env.store.identitiesWithState("dto-other")).toEqual([]);
  });

  it("模型等待窗口新增隐私规则，成功返回也不能提交正文判定/转换", async () => {
    const entered = deferred(); const release = deferred();
    const llm = { chatJson: async (messages: Array<{ content: string }>) => {
      if (messages[0]!.content.includes("判断每个网页")) { entered.resolve(); await release.promise; return { results: [{ index: 0, material: true }] }; }
      return { results: [{ index: 0, category: "阅读", confidence: 0.95, material: true }] };
    } } as unknown as LlmClient;
    env = makeEnv(llm, false, { crawlFetcher: async () => articleResponse() });
    const id = await addInboxItem("https://policy-judge.example.net/article", "隐私变更前合成正文");
    await postJson("/api/v1/inbox/process", { bookmarkIds: [id] });
    await entered.promise;
    try { env.store.addPrivacyPattern("policy-judge.example.net"); }
    finally { release.resolve(); }
    await env.pipeline.scanIdle();
    expect(env.store.getBookmark(id)!.materialized_at).toBeNull();
    expect(env.store.getMaterialCandidate(id)?.state).toBe("cancelled");
    expect(env.store.getActiveMaterialByBookmark(id)).toBeUndefined();
  });

  it("模型漏判不可按长正文兜底移出，失败状态持久化可补扫", async () => {
    const llm = { chatJson: async (messages: Array<{ content: string }>) => {
      if (messages[0]!.content.includes("判断每个网页")) return { results: [{ index: 0 }] };
      return { results: [{ index: 0, category: "阅读", confidence: 0.95, material: true }] };
    } } as unknown as LlmClient;
    env = makeEnv(llm, false, { crawlFetcher: async () => ({ ...articleResponse(), readBody: async () => Buffer.from("超过800字的合成正文也不能替代模型明确判定。".repeat(100)) }) });
    const id = await addInboxItem("https://missing-verdict.example.net/article", "内容判定漏项");
    await processAndDrain(id);
    expect(env.store.getBookmark(id)!.materialized_at).toBeNull();
    expect(env.store.getMaterialCandidate(id)).toMatchObject({ state: "retry", fail_reason: "invalid_content_verdict" });
    expect(env.store.getActiveMaterialByBookmark(id)).toBeUndefined();
  });

  it("旧入口在途结果不能取消显式重新投递的新入口任务", async () => {
    const entered = deferred(); const release = deferred(); let fetched = 0;
    env = makeEnv(fakeLlm({ material: true }), false, { crawlFetcher: async () => {
      fetched++; if (fetched === 1) { entered.resolve(); await release.promise; }
      return articleResponse();
    } });
    const id = await addInboxItem("https://entry-generation.example.net/article", "入口代际");
    await postJson("/api/v1/inbox/process", { bookmarkIds: [id] });
    await entered.promise;
    const oldEntry = env.store.getMaterialCandidate(id)!.entry_id;
    try {
      env.store.clearInboxState(id);
      env.store.moveBookmark(id, env.store.inboxFolder()!.id);
      env.store.registerMaterialCandidate(id, true);
      expect(env.store.getMaterialCandidate(id)!.entry_id).not.toBe(oldEntry);
      env.pipeline.resumeMaterialCandidates();
    } finally { release.resolve(); }
    await env.pipeline.scanIdle();
    expect(fetched).toBe(2);
    expect(env.store.getBookmark(id)!.materialized_at).toBeTruthy();
    expect(env.store.getMaterialCandidate(id)?.state).toBe("done");
  });

  it("持久候选调度常驻启动即补扫且每分钟触发，不依赖可选维护开关", () => {
    vi.useFakeTimers();
    try {
      const resumeMaterialCandidates = vi.fn(() => 0);
      startMaterialConversionSweep({ resumeMaterialCandidates });
      expect(resumeMaterialCandidates).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(120_000);
      expect(resumeMaterialCandidates).toHaveBeenCalledTimes(3);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it("未发布v17的DDL可幂等重放，迁移不补登记历史候选", () => {
    env = makeEnv(null);
    MIGRATION_V17_MATERIAL_CONVERT.up(env.store.db);
    MIGRATION_V17_MATERIAL_CONVERT.up(env.store.db);
    expect(env.store.pendingMaterialCandidates()).toEqual([]);
  });
});
