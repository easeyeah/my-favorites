/**
 * D77 分类自检集成测试：自动归位条目的一次性复核。
 * 锁住核心契约：
 *  - 明显更合适的现有目录 + 高置信 → 直接生效移动（D27）+ organize_version(meta=auto_review) + 去向刷新；
 *  - 合适/低置信/新目录名 → 保持不动（永不新建目录）；
 *  - 手动归位/手动移动（PATCH/浏览器 sync）→ 状态清除，自检永不侵犯用户意图；
 *  - 一次性复核（reviewed_at）防振荡；LLM 失败不标记可重试；无 LLM 零开销；私密不送模型。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { LlmClient } from "@mf/ai/llm-client";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;

afterEach(() => {
  env?.cleanup();
  env = undefined as unknown as TestEnv;
});

function fakeLlm(opts: {
  organizeCategory: string;
  review?: { category: string; confidence: number } | Error;
  reviewCalls?: string[];
  /** 模拟 LLM 等待窗口期的用户动作（提交前重查守卫用） */
  duringReview?: () => Promise<void>;
}) {
  return {
    chatJson: async (messages: Array<{ role: string; content: string }>) => {
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      if (sys.includes("摘要助手")) return { summary: "测试摘要", tags: ["测试"], keywords: [], category: ["其他"] };
      if (sys.includes("分类复核助手")) {
        opts.reviewCalls?.push(user);
        await opts.duringReview?.();
        if (opts.review instanceof Error) throw opts.review;
        return opts.review ?? { category: "", confidence: 0.9 };
      }
      return { results: [{ index: 0, category: opts.organizeCategory, confidence: 0.95, material: false }] };
    },
  } as unknown as LlmClient;
}

const post = (path: string, body: unknown) =>
  env.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const patch = (path: string, body: unknown) =>
  env.app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** 建目录体系 + 代表书签 + 收纳盒条目并自动归位到 organizeCategory */
async function setupPlaced(organizeCategory: string, llmOpts: Parameters<typeof fakeLlm>[0]): Promise<{ bmId: string; toolsId: string; sysId: string }> {
  env = makeEnv(fakeLlm(llmOpts), true);
  const tools = (await (await post("/api/v1/folders", { name: "E01 在线工具" })).json()) as { id: string };
  const sys = (await (await post("/api/v1/folders", { name: "E07 系统" })).json()) as { id: string };
  await post("/api/v1/bookmarks", { url: "https://webtool.example.com/a", title: "在线格式转换", folderId: tools.id });
  await post("/api/v1/bookmarks", { url: "https://native.example.com/b", title: "Ventoy 启动盘工具", folderId: sys.id });
  const inbox = (await (await post("/api/v1/inbox/setup", {})).json()) as { id: string };
  const bm = (await (
    await post("/api/v1/bookmarks", { url: "https://remoteapp.example.com/app", title: "RemoteGo 远程桌面客户端", folderId: inbox.id })
  ).json()) as { id: string };
  await post("/api/v1/inbox/process", { bookmarkIds: [bm.id] });
  await env.pipeline.scanIdle();
  // D77 独立验证归位复核：模拟 D91 内容识别已完成且该客户端页面不是资料。
  env.store.setMaterialCandidateState(bm.id, "done", "not_content_page");
  const st = env.store.getInboxState(bm.id);
  expect(st?.state).toBe("placed");
  expect(st?.reason).toBe(organizeCategory);
  return { bmId: bm.id, toolsId: tools.id, sysId: sys.id };
}

describe("D77 分类自检", () => {
  it("高置信明显更合适 → 自动移动 + auto_review 版本 + 去向刷新 + 一次性标记", async () => {
    const { bmId, sysId } = await setupPlaced("E01 在线工具", {
      organizeCategory: "E01 在线工具",
      review: { category: "E07 系统", confidence: 0.9 },
    });
    const r = await env.pipeline.reviewPlacement(bmId);
    expect(r).toBe("moved");
    expect(env.store.getBookmark(bmId)?.folder_id).toBe(sysId);
    const st = env.store.getInboxState(bmId)!;
    expect(st.reason).toBe("E07 系统"); // D54 去向面板展示新目录
    expect(st.reviewed_at).toBeTruthy();
    const versions = env.store.listVersions();
    const v = versions
      .map((x) => env.store.getVersion(x.id))
      .find((x) => (x?.actions as Array<{ meta?: string }>)?.some((a) => a.meta === "auto_review"));
    expect(v).toBeTruthy();
    expect((v!.actions as Array<{ toFolderId?: string }>)[0]!.toFolderId).toBe(sysId);
    // 一次性：再复核直接跳过（防振荡）
    expect(await env.pipeline.reviewPlacement(bmId)).toBe("skipped");
  });

  it("复核 prompt 带目录样本与当前目录；内容证据（摘要/标签）随送", async () => {
    const reviewCalls: string[] = [];
    const { bmId } = await setupPlaced("E01 在线工具", {
      organizeCategory: "E01 在线工具",
      review: { category: "", confidence: 0.9 },
      reviewCalls,
    });
    // 直接种摘要缓存（模拟捕获完成；不走 maybeSummarize 以免其自检钩子与本用例抢跑）
    env.store.upsertCache({ bookmarkId: bmId, l1Summary: "测试摘要", l1Tags: ["测试"], fetchedVia: "extension_capture" });
    reviewCalls.length = 0;
    await env.pipeline.reviewPlacement(bmId);
    expect(reviewCalls.length).toBe(1);
    const payload = JSON.parse(reviewCalls[0]!) as { currentFolder?: string; summary?: string; tags?: string };
    expect(payload.currentFolder).toBe("E01 在线工具");
    expect(payload.summary).toBe("测试摘要");
    expect(payload.tags).toBe("测试");
  });

  it("当前目录合适（category 空）→ 保持 + 标记，不移动", async () => {
    const { bmId, toolsId } = await setupPlaced("E01 在线工具", {
      organizeCategory: "E01 在线工具",
      review: { category: "", confidence: 0.95 },
    });
    expect(await env.pipeline.reviewPlacement(bmId)).toBe("kept");
    expect(env.store.getBookmark(bmId)?.folder_id).toBe(toolsId);
    expect(env.store.getInboxState(bmId)?.reviewed_at).toBeTruthy();
  });

  it("低置信（<0.85）→ 保持不动", async () => {
    const { bmId, toolsId } = await setupPlaced("E01 在线工具", {
      organizeCategory: "E01 在线工具",
      review: { category: "E07 系统", confidence: 0.7 },
    });
    expect(await env.pipeline.reviewPlacement(bmId)).toBe("kept");
    expect(env.store.getBookmark(bmId)?.folder_id).toBe(toolsId);
  });

  it("建议新目录名 → 保持不动，永不新建目录", async () => {
    const { bmId, toolsId } = await setupPlaced("E01 在线工具", {
      organizeCategory: "E01 在线工具",
      review: { category: "远程控制", confidence: 0.95 },
    });
    expect(await env.pipeline.reviewPlacement(bmId)).toBe("kept");
    expect(env.store.getBookmark(bmId)?.folder_id).toBe(toolsId);
    expect(env.store.listFolders().some((f) => f.name === "远程控制")).toBe(false);
  });

  it("手动归位（/inbox/assign）→ 状态清除，自检跳过且零 LLM 调用", async () => {
    const reviewCalls: string[] = [];
    const { bmId, sysId } = await setupPlaced("E01 在线工具", {
      organizeCategory: "E01 在线工具",
      review: { category: "E07 系统", confidence: 0.95 },
      reviewCalls,
    });
    await post("/api/v1/inbox/assign", { bookmarkId: bmId, folderId: sysId });
    expect(env.store.getInboxState(bmId)).toBeUndefined();
    expect(await env.pipeline.reviewPlacement(bmId)).toBe("skipped");
    expect(reviewCalls.length).toBe(0);
  });

  it("手动 PATCH 改目录 → 退出自检；同目录 PATCH 不误清", async () => {
    const { bmId, toolsId, sysId } = await setupPlaced("E01 在线工具", {
      organizeCategory: "E01 在线工具",
      review: { category: "E07 系统", confidence: 0.95 },
    });
    await patch(`/api/v1/bookmarks/${bmId}`, { folderId: toolsId }); // 同目录（编辑表单常带）
    expect(env.store.getInboxState(bmId)?.state).toBe("placed"); // 不误清
    await patch(`/api/v1/bookmarks/${bmId}`, { folderId: sysId }); // 真移动
    expect(env.store.getInboxState(bmId)).toBeUndefined();
    expect(await env.pipeline.reviewPlacement(bmId)).toBe("skipped");
  });

  it("LLM 失败 → 不标记，patrol 下轮重试", async () => {
    const { bmId } = await setupPlaced("E01 在线工具", {
      organizeCategory: "E01 在线工具",
      review: new Error("llm down"),
    });
    expect(await env.pipeline.reviewPlacement(bmId)).toBe("failed");
    expect(env.store.getInboxState(bmId)?.reviewed_at).toBeFalsy();
    expect(env.store.classificationReviewCandidates(10)).toContain(bmId);
  });

  it("私密书签 → 不送模型，终结标记", async () => {
    const reviewCalls: string[] = [];
    const { bmId } = await setupPlaced("E01 在线工具", {
      organizeCategory: "E01 在线工具",
      review: { category: "E07 系统", confidence: 0.95 },
      reviewCalls,
    });
    await patch(`/api/v1/bookmarks/${bmId}`, { isPrivate: true });
    expect(await env.pipeline.reviewPlacement(bmId)).toBe("skipped");
    expect(reviewCalls.length).toBe(0);
    expect(env.store.getInboxState(bmId)?.reviewed_at).toBeTruthy();
  });

  it("patrol 涓流：候选=未复核自动归位；复核后不再候选；无 LLM 零开销", async () => {
    const { bmId } = await setupPlaced("E01 在线工具", {
      organizeCategory: "E01 在线工具",
      review: { category: "", confidence: 0.9 },
    });
    expect(env.store.classificationReviewCandidates(10)).toContain(bmId);
    expect(await env.pipeline.backfillPlacementReviews(10)).toBe(1);
    expect(env.store.classificationReviewCandidates(10)).not.toContain(bmId);
    expect(await env.pipeline.backfillPlacementReviews(10)).toBe(0);
    // 无 LLM 环境：零调用零开销
    env.cleanup();
    env = makeEnv(null, true);
    expect(await env.pipeline.backfillPlacementReviews(10)).toBe(0);
  });

  it("LLM 等待窗口期用户改了书签（revision 变化）→ 复核作废不移动", async () => {
    const { bmId, toolsId } = await setupPlaced("E01 在线工具", {
      organizeCategory: "E01 在线工具",
      review: { category: "E07 系统", confidence: 0.95 },
      duringReview: async () => {
        await patch(`/api/v1/bookmarks/${bmId}`, { title: "用户改过的标题" }); // bump revision，不清状态
      },
    });
    expect(await env.pipeline.reviewPlacement(bmId)).toBe("skipped");
    expect(env.store.getBookmark(bmId)?.folder_id).toBe(toolsId);
    expect(env.store.getInboxState(bmId)?.reviewed_at).toBeFalsy(); // 作废不标记，下轮再看
  });
});