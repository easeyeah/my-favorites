/**
 * D61 资料库集成测试：三级识别入库 → 列表/详情/封面/导出 → 隐私边界 → dismiss 不复活。
 * 说明：127.0.0.1/localhost 属内置隐私域（红线②），其内容按设计不入内容库——
 * 因此流程级测试注入 coverFetcher 替身；真实网络下载（guardedFetch + 魔数嗅探）另用
 * loopback 图片站直测 fetchMaterialCover，两条路径都覆盖。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type http from "node:http";
import { makeEnv, json, type TestEnv } from "./test-env";
import { fetchMaterialCover, saveCoverFile } from "./materials";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let imgServer: http.Server | null = null;
let imgPort = 0;
let env: TestEnv;

/** 封面替身：任何 URL 都返回 PNG 字节（尺寸 32B，供落盘/读回断言） */
const stubCover = async (): Promise<{ buf: Buffer; mime: string }> => ({ buf: PNG_MAGIC, mime: "image/png" });

const longText =
  "这是一篇用于测试的完整文章正文。".repeat(30); // > 200 字，满足「已存全文」阈值

beforeAll(async () => {
  imgServer = (await import("node:http")).createServer((req, res) => {
    if (req.url?.includes("/cover.png")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG_MAGIC);
    } else if (req.url?.includes("/huge.bin")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(64 * 1024, 1)); // 非图片字节 → 嗅探失败 → null
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => imgServer!.listen(0, "127.0.0.1", resolve));
  imgPort = (imgServer.address() as { port: number }).port;
  env = makeEnv(null, true, { coverFetcher: stubCover }); // syncAi=true：物化在请求内同步完成
});

afterAll(async () => {
  env.cleanup();
  await new Promise<void>((resolve) => imgServer?.close(() => resolve()));
});

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
  const res = await env.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // D61 消费面回归用普通目录存量样本，避免混入 D91 新收纳盒入口自动转换生命周期。
    body: JSON.stringify(path === "/api/v1/bookmarks" ? { ...(body as object), folderId: env.store.ensurePath(["存量样本"]).id } : body),
  });
  return json(res) as Promise<Record<string, unknown>>;
};

describe("D61 资料库：识别入库与读取面", () => {
  it("文章已存全文 → 入库显性化；列表/详情/导出全链路", async () => {
    const bm = (await post("/api/v1/bookmarks", {
      url: "https://example.com/blog/long-article",
      title: "一篇长文章",
    })) as { id: string };
    const cap = await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: bm.id, l2Text: longText }),
    });
    expect(cap.status).toBe(200);

    const list = (await json(
      await env.app.request("/api/v1/materials?type=article"),
    )) as { items: Array<Record<string, unknown>>; counts: Record<string, number> };
    const item = list.items.find((i) => i.bookmark_id === bm.id);
    expect(item).toBeDefined();
    expect(item?.type).toBe("article");
    expect((item?.l2_len as number) >= 200).toBe(true);
    expect((item?.has_cover as boolean)).toBe(false);
    expect(list.counts.article).toBeGreaterThanOrEqual(1);

    const id = item!.id as string;
    const detail = (await json(await env.app.request(`/api/v1/materials/${id}`))) as Record<string, unknown>;
    expect(detail.l2_text).toBe(longText);
    expect(detail.title).toBe("一篇长文章");

    const exp = await env.app.request(`/api/v1/materials/${id}/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-type")).toContain("text/markdown");
    const md = await exp.text();
    expect(md.startsWith("---")).toBe(true);
    expect(md).toContain("一篇长文章");
    expect(md).toContain("https://example.com/blog/long-article");
    expect(md).toContain(longText.slice(0, 20));
  });

  it("未存全文的文章不入库（无内容不显性化）", async () => {
    const bm = (await post("/api/v1/bookmarks", {
      url: "https://example.com/blog/short-note",
      title: "短笔记",
    })) as { id: string };
    await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: bm.id, l2Text: "太短" }),
    });
    const list = (await json(await env.app.request("/api/v1/materials"))) as {
      items: Array<Record<string, unknown>>;
    };
    expect(list.items.find((i) => i.bookmark_id === bm.id)).toBeUndefined();
  });

  it("视频 URL 即时入库（收藏无需捕获）；未捕获封面时无封面可取", async () => {
    const bm = (await post("/api/v1/bookmarks", {
      url: "https://www.bilibili.com/video/BV1test001",
      title: "一个测试视频",
    })) as { id: string };
    const list = (await json(await env.app.request("/api/v1/materials?type=video"))) as {
      items: Array<Record<string, unknown>>;
    };
    const item = list.items.find((i) => i.bookmark_id === bm.id);
    expect(item).toBeDefined();
    expect(item?.signals).toContain("哔哩哔哩");
    const cover = await env.app.request(`/api/v1/materials/${item!.id}/cover`);
    expect(cover.status).toBe(404); // og:image 未上行，不出 404 假图
  });

  it("图片直链 → 主图落盘（stub 封面）并可读回；og:image 触发文章封面同链路", async () => {
    const bm = (await post("/api/v1/bookmarks", {
      url: "https://cdn.example.com/pic/cover.png",
      title: "一张直链图片",
    })) as { id: string };
    const list = (await json(await env.app.request("/api/v1/materials?type=image"))) as {
      items: Array<Record<string, unknown>>;
    };
    const item = list.items.find((i) => i.bookmark_id === bm.id);
    expect(item).toBeDefined();
    expect(item?.type).toBe("image");
    expect(item?.has_cover).toBe(true);
    expect(item?.cover_mime).toBe("image/png");
    expect(item?.cover_url).toContain("cover.png");

    const cover = await env.app.request(`/api/v1/materials/${item!.id}/cover`);
    expect(cover.status).toBe(200);
    expect(cover.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await cover.arrayBuffer());
    expect(buf.subarray(0, 4)).toEqual(PNG_MAGIC.subarray(0, 4));
  });

  it("回环/内网 URL 不入资料库（127.0.0.1 属内置隐私域——红线②）", async () => {
    const bm = (await post("/api/v1/bookmarks", {
      url: `http://127.0.0.1:${imgPort}/pic/cover.png`,
      title: "NAS 本机图片",
    })) as { id: string };
    const list = (await json(await env.app.request("/api/v1/materials?type=image"))) as {
      items: Array<Record<string, unknown>>;
    };
    expect(list.items.find((i) => i.bookmark_id === bm.id)).toBeUndefined();
  });

  it("fetchMaterialCover 真实网络路径：loopback 图片站下载 + 魔数嗅探 + 非图片拒绝", async () => {
    const ok = await fetchMaterialCover(`http://127.0.0.1:${imgPort}/pic/cover.png`, {
      mode: "selfhosted_allowlist",
      allowedCidrs: ["127.0.0.0/8", "::1/128"],
    });
    expect(ok?.mime).toBe("image/png");
    expect(ok?.buf.subarray(0, 4)).toEqual(PNG_MAGIC.subarray(0, 4));
    const bad = await fetchMaterialCover(`http://127.0.0.1:${imgPort}/file/huge.bin`, {
      mode: "selfhosted_allowlist",
      allowedCidrs: ["127.0.0.0/8", "::1/128"],
    });
    expect(bad).toBeNull(); // 非图片字节嗅探失败
    const save = saveCoverFile(env.dataDir, "test-material-id", PNG_MAGIC, "image/png");
    expect(save).toContain("materials");
    expect(save?.endsWith("test-material-id.png")).toBe(true);
  });

  it("隐私域名永不入库（红线②：内容库与「仅存 URL」一致）", async () => {
    await post("/api/v1/privacy/rules", { add: ["*.secret-bank.example"] });
    const bm = (await post("/api/v1/bookmarks", {
      url: `https://www.secret-bank.example/account/123.png`,
      title: "银行图片",
    })) as { id: string };
    await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: bm.id, l2Text: longText, ogImage: `http://127.0.0.1:${imgPort}/x.png` }),
    });
    const list = (await json(await env.app.request("/api/v1/materials"))) as {
      items: Array<Record<string, unknown>>;
    };
    expect(list.items.find((i) => i.bookmark_id === bm.id)).toBeUndefined();
  });

  it("私密书签不入库；og:image 下载前置 server_fetch 判定", async () => {
    const bm = (await post("/api/v1/bookmarks", {
      url: "https://www.bilibili.com/video/BVprivate1",
      title: "私密视频",
    })) as { id: string };
    await env.app.request(`/api/v1/bookmarks/${bm.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isPrivate: true }),
    });
    await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: bm.id, ogImage: `http://127.0.0.1:${imgPort}/cover.png` }),
    });
    const list = (await json(await env.app.request("/api/v1/materials?type=video"))) as {
      items: Array<Record<string, unknown>>;
    };
    expect(list.items.find((i) => i.bookmark_id === bm.id)).toBeUndefined();
  });

  it("dismiss 软删：列表消失、capture/crawl 再触发不复活、封面文件即清", async () => {
    const bm = (await post("/api/v1/bookmarks", {
      url: "https://cdn.example.com/photo/to-dismiss.png",
      title: "要移出的图片",
    })) as { id: string };
    const list = (await json(await env.app.request("/api/v1/materials?type=image"))) as {
      items: Array<Record<string, unknown>>;
    };
    const item = list.items.find((i) => i.bookmark_id === bm.id);
    expect(item).toBeDefined();
    const id = item!.id as string;
    expect((item?.has_cover as boolean)).toBe(true);

    const del = await env.app.request(`/api/v1/materials/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await env.app.request(`/api/v1/materials/${id}`, { method: "DELETE" })).status).toBe(404);

    // 再物化（等价 capture/crawl 再触发）：不复活
    await env.pipeline.materialize(bm.id);
    const after = (await json(await env.app.request("/api/v1/materials?type=image"))) as {
      items: Array<Record<string, unknown>>;
    };
    expect(after.items.find((i) => i.bookmark_id === bm.id)).toBeUndefined();

    const cover = await env.app.request(`/api/v1/materials/${id}/cover`);
    expect(cover.status).toBe(404);
  });

  it("分面统计与自有分类（D65）：category 子树筛选/未分类口径/私密不计；回灌无 LLM 零开销", async () => {
    const bm = (await post("/api/v1/bookmarks", {
      url: "https://facets.example/blog/tagged-post",
      title: "分面统计样本文章",
    })) as { id: string };
    await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: bm.id, l2Text: longText }),
    });
    env.store.upsertCache({
      bookmarkId: bm.id,
      l1Summary: "分面统计演示。",
      l1Tags: ["前端", "react"],
      keywords: [],
      fetchedVia: "extension_capture",
    });
    // AI 分类写入（模拟摘要顺带产出）
    const mat = env.store.getMaterialByBookmark(bm.id)!;
    env.store.setMaterialCategory(mat.id, ["技术开发", "前端"]);

    const facets = env.store.materialFacets(false);
    expect(facets.categories).toContainEqual({ category: "技术开发/前端", count: 1 });
    expect(facets.tags).toContainEqual({ tag: "react", count: 1 });
    expect(facets.tags).toContainEqual({ tag: "前端", count: 1 });

    // 子树筛选：点一级「技术开发」命中其子树（前缀匹配）
    const byTop = (await json(await env.app.request("/api/v1/materials?category=技术开发"))) as {
      items: Array<Record<string, unknown>>;
    };
    expect(byTop.items.some((r) => r.bookmark_id === bm.id)).toBe(true);
    const byExact = (await json(await env.app.request("/api/v1/materials?category=技术开发/前端"))) as {
      items: Array<Record<string, unknown>>;
    };
    expect(byExact.items.some((r) => r.bookmark_id === bm.id)).toBe(true);

    // 未分类口径：另一条无分类的资料
    const uncat = (await json(await env.app.request("/api/v1/materials?uncategorized=1"))) as {
      items: Array<Record<string, unknown>>;
    };
    expect(uncat.items.every((r) => r.category === null)).toBe(true);
    expect(uncat.items.some((r) => r.bookmark_id !== bm.id)).toBe(true);

    // 私密书签不打进分面（与列表口径一致）
    const priv = (await post("/api/v1/bookmarks", {
      url: "https://facets.example/blog/private-post",
      title: "私密分面样本",
    })) as { id: string };
    await env.app.request(`/api/v1/bookmarks/${priv.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isPrivate: true }),
    });
    await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkId: priv.id, l2Text: longText }),
    });
    const after = env.store.materialFacets(false);
    expect(after.categories.find((c) => c.category === "技术开发/前端")?.count).toBe(1);

    // 回灌：无 LLM 零开销；分类已存在的条目不进候选
    expect(await env.pipeline.backfillCategories(5)).toBe(0);
  });

  it("书签删除 → material 行 FK 级联消失", async () => {
    const bm = (await post("/api/v1/bookmarks", {
      url: "https://www.youtube.com/watch?v=cascade1",
      title: "将被删除的视频",
    })) as { id: string };
    const list = (await json(await env.app.request("/api/v1/materials?type=video"))) as {
      items: Array<Record<string, unknown>>;
    };
    const item = list.items.find((i) => i.bookmark_id === bm.id);
    expect(item).toBeDefined();
    await env.app.request(`/api/v1/bookmarks/${bm.id}`, { method: "DELETE" });
    const detail = await env.app.request(`/api/v1/materials/${item!.id}`);
    expect(detail.status).toBe(404);
  });
});
