/**
 * D43 敏感内容旁路 集成回归（2026-11-20）
 *
 * 覆盖验收标准：
 *  1. 功能点全库标记：命中项 is_private=1 + 移入「私人收藏」+ 版本历史 + 镜像入队；
 *     撤销后私密位/目录逐项还原、pending 镜像取消；
 *  2. 批次隔离：审核拒收 → 二分定位肇因项标私密，其余正常分类，整理不再整批失败；
 *  3. 红线复查：词表命中项不进 LLM 批次（事前旁路）；非审核错误不触发隔离（不误伤）。
 *
 * 隐私约定：一律合成域名（*.example 族 + 构造词素），不引用任何真实站点。
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";
import { Store } from "./store";
import { LlmUnavailableError } from "@mf/ai/llm-client";
import type { ChatMessage, LlmClient } from "@mf/ai/llm-client";

let env: TestEnv | undefined;
afterEach(() => env?.cleanup());

/** 直接构造一条书签（与 dev-security.test.ts 同型） */
function rawBookmark(
  store: Store,
  opts: { urlRaw: string; canonical?: string; title?: string; private?: boolean },
): string {
  const id = `bm-${Math.random().toString(36).slice(2, 10)}`;
  const folder = store.ensurePath(["回归"]);
  const ts = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO bookmarks (id, folder_id, url_raw, url_canonical, title, status, added_at, pinned, is_private, created_at) VALUES (?,?,?,?,?,'normal',?,0,?,?)",
    )
    .run(
      id,
      folder.id,
      opts.urlRaw,
      opts.canonical ?? opts.urlRaw,
      opts.title ?? id,
      ts,
      opts.private ? 1 : 0,
      ts,
    );
  return id;
}

const batchUrlsOf = (messages: ChatMessage[]): string[] =>
  (JSON.parse(messages[1]?.content ?? "[]") as Array<{ url: string }>).map((x) => x.url);

describe("D43 敏感内容旁路功能点", () => {
  it("全库标记 → 私密+移入私人收藏+版本+镜像入队；撤销全还原", async () => {
    env = makeEnv(null);
    const s1 = rawBookmark(env.store, { urlRaw: "https://pornmix.example/a" });
    const s2 = rawBookmark(env.store, { urlRaw: "https://xxxvids.example" });
    const s3 = rawBookmark(env.store, { urlRaw: "https://clip.example.xxx" });
    const normal = rawBookmark(env.store, { urlRaw: "https://normalblog.example" });
    const alreadyPrivate = rawBookmark(env.store, {
      urlRaw: "https://sextoys.example",
      private: true,
    });
    const origin = env.store.getBookmark(normal)!.folder_id;
    env.store.upsertIdentity({ deviceId: "dev-1", browserBookmarkId: "bb-s1", appBookmarkId: s1 });

    const res = await env.app.request("/api/v1/tidy/sensitive", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scanned: number;
      marked: number;
      versionId: string;
      folderName: string;
    };
    expect(body.marked).toBe(3); // 已私密的不再计入
    expect(body.folderName).toBe("私人收藏");

    const privateFolder = env.store.findFolderByName("私人收藏")!;
    for (const id of [s1, s2, s3]) {
      const bm = env.store.getBookmark(id)!;
      expect(bm.is_private).toBe(1);
      expect(bm.folder_id).toBe(privateFolder.id);
    }
    // 未命中/已私密项不动
    expect(env.store.getBookmark(normal)!.folder_id).toBe(origin);
    expect(env.store.getBookmark(alreadyPrivate)!.folder_id).toBe(origin);

    // 浏览器镜像入队（s1 有身份映射）
    const ops = env.store.db
      .prepare("SELECT * FROM pending_browser_ops WHERE browser_bookmark_id = 'bb-s1' AND status = 'pending'")
      .all() as Array<{ target_browser_parent_id: string }>;
    expect(ops.some((o) => o.target_browser_parent_id === "mf-folder:私人收藏")).toBe(true);

    // 幂等：再跑一次零增量、不产生新版本
    const again = (await (
      await env.app.request("/api/v1/tidy/sensitive", { method: "POST" })
    ).json()) as { marked: number; versionId: string | null };
    expect(again.marked).toBe(0);
    expect(again.versionId).toBeNull();

    // 撤销：私密位/目录还原 + 空私人收藏回收 + 镜像改道回原目录
    const rb = await env.app.request(`/api/v1/organize/rollback/${body.versionId}`, { method: "POST" });
    expect(rb.status).toBe(200);
    const rbBody = (await rb.json()) as { reversed: number; skipped: unknown[] };
    expect(rbBody.skipped).toEqual([]);
    for (const id of [s1, s2, s3]) {
      const bm = env.store.getBookmark(id)!;
      expect(bm.is_private).toBe(0);
      expect(bm.folder_id).toBe(origin);
    }
    expect(env.store.findFolderByName("私人收藏")).toBeUndefined(); // 空目录随撤销回收
    const opsAfter = env.store.db
      .prepare("SELECT * FROM pending_browser_ops WHERE browser_bookmark_id = 'bb-s1' AND status = 'pending'")
      .all() as Array<{ target_browser_parent_id: string }>;
    // 旧「移入私人收藏」镜像已取消，只剩回原目录的反向镜像
    expect(opsAfter.every((o) => o.target_browser_parent_id !== "mf-folder:私人收藏")).toBe(true);
    expect(opsAfter.some((o) => o.target_browser_parent_id.startsWith("mf-folder:"))).toBe(true);
  });

  it("事前旁路：词表命中项绝不进 LLM 批次", async () => {
    const seen: string[] = [];
    const llm = {
      chatJson: async (messages: ChatMessage[]) => {
        seen.push(...batchUrlsOf(messages));
        return { results: [] };
      },
    } as unknown as LlmClient;
    env = makeEnv(llm, true);
    rawBookmark(env.store, { urlRaw: "https://hentai-draw.example" });
    rawBookmark(env.store, { urlRaw: "https://readit.example" });

    const res = await env.app.request("/api/v1/organize/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "整理整个库" }),
    });
    expect(res.status).toBe(201);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((u) => u.includes("hentai"))).toBe(false);
    expect(seen.some((u) => u.includes("readit"))).toBe(true);
  });

  it("审核拒收 → 二分隔离：仅肇因项标私密，其余正常分类归位", async () => {
    const llm = {
      chatJson: async (messages: ChatMessage[]) => {
        const items = JSON.parse(messages[1]?.content ?? "[]") as Array<{
          index: number;
          title: string;
          url: string;
        }>;
        if (items.some((i) => i.title.includes("☠"))) {
          // 模拟供应商整包拒收（带机器码的 400）
          throw new LlmUnavailableError("HTTP 400 from test", "data_inspection_failed ContentPolicyViolation");
        }
        return { results: items.map((i) => ({ index: i.index, category: "阅读清单", confidence: 0.9 })) };
      },
    } as unknown as LlmClient;
    env = makeEnv(llm, true);
    const poison = rawBookmark(env.store, { urlRaw: "https://cleanurl.example", title: "☠ 毒丸标题" });
    const ok1 = rawBookmark(env.store, { urlRaw: "https://a1.example", title: "正常一" });
    const ok2 = rawBookmark(env.store, { urlRaw: "https://a2.example", title: "正常二" });
    const ok3 = rawBookmark(env.store, { urlRaw: "https://a3.example", title: "正常三" });

    const res = await env.app.request("/api/v1/organize/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "整理整个库" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      answer: string;
      applied: number;
      versionId: string;
    };
    expect(body.status).toBe("applied");
    expect(body.answer).toContain("已自动标私密");

    // 肇因项：标私密 + 进私人收藏
    const poisonBm = env.store.getBookmark(poison)!;
    expect(poisonBm.is_private).toBe(1);
    expect(env.store.findFolderByName("私人收藏")?.id).toBe(poisonBm.folder_id);
    // 其余正常归位到 LLM 给的目录，且未被标私密
    const reading = env.store.findFolderByName("阅读清单")!;
    for (const id of [ok1, ok2, ok3]) {
      const bm = env.store.getBookmark(id)!;
      expect(bm.folder_id).toBe(reading.id);
      expect(bm.is_private).toBe(0);
    }

    // 撤销这批：毒丸也还原为未私密（隔离动作全程可逆）
    const rb = (await (
      await env.app.request(`/api/v1/organize/rollback/${body.versionId}`, { method: "POST" })
    ).json()) as { reversed: number; skipped: unknown[] };
    expect(rb.skipped).toEqual([]);
    const restored = env.store.getBookmark(poison)!;
    expect(restored.is_private).toBe(0);
  });

  it("非审核错误（故障/限流）不触发隔离——不误伤任何条目", async () => {
    const llm = {
      chatJson: async () => {
        throw new LlmUnavailableError("HTTP 429 from test", "rate_limit_exceeded");
      },
    } as unknown as LlmClient;
    env = makeEnv(llm, true);
    const bm = rawBookmark(env.store, { urlRaw: "https://a1.example", title: "正常一" });
    const res = await env.app.request("/api/v1/organize/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "整理整个库" }),
    });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("answered"); // 无动作产生
    const row = env.store.getBookmark(bm)!;
    expect(row.is_private).toBe(0);
  });
});
