/** A2 身份映射与持久重试验收：幂等映射 / 重复事件 / 待执行操作 / 镜像入队 */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./test-env";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("A2-1/A2-2 /inbox/map 身份映射", () => {
  it("浏览器事件 → 映射入库 → 返回应用库 ID；重复事件同 ID 不重复建", async () => {
    env = makeEnv(null);
    // 同一浏览器书签事件重复提交三次
    const responses = [] as Array<{ bookmarkId: string; duplicate: boolean }>;
    for (let i = 0; i < 3; i++) {
      const r = (await (
        await env.app.request("/api/v1/inbox/map", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deviceId: "device-aaa-001",
            browserBookmarkId: "browser-node-42",
            url: "https://example-a2.com/article",
            title: "文章",
          }),
        })
      ).json()) as { bookmarkId: string; duplicate: boolean };
      responses.push(r);
    }
    // 幂等：三个 ID 相同，只建了一条书签
    expect(new Set(responses.map((r) => r.bookmarkId)).size).toBe(1);
    const list = env.store.listBookmarks({ limit: 100 });
    expect(list.filter((b) => b.url_canonical.includes("example-a2")).length).toBe(1);
  });

  it("扩展已收藏过的 URL → 映射到既有书签（不新建）", async () => {
    env = makeEnv(null);
    const existing = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://dup-a2.com/page", title: "已有" }),
      })
    ).json()) as { id: string };
    const mapped = (await (
      await env.app.request("/api/v1/inbox/map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: "device-bbb-002",
          browserBookmarkId: "browser-node-7",
          url: "https://dup-a2.com/page",
          title: "浏览器侧同名",
        }),
      })
    ).json()) as { bookmarkId: string; duplicate: boolean };
    expect(mapped.bookmarkId).toBe(existing.id);
    expect(mapped.duplicate).toBe(true);
  });

  it("同 URL 不同浏览器（多设备）→ 各自映射到同一应用库书签", async () => {
    env = makeEnv(null);
    const r1 = (await (
      await env.app.request("/api/v1/inbox/map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "device-1", browserBookmarkId: "n1", url: "https://multi-a2.com/x", title: "x" }),
      })
    ).json()) as { bookmarkId: string };
    const r2 = (await (
      await env.app.request("/api/v1/inbox/map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "device-2", browserBookmarkId: "n99", url: "https://multi-a2.com/x", title: "x" }),
      })
    ).json()) as { bookmarkId: string };
    expect(r1.bookmarkId).toBe(r2.bookmarkId);
    expect(env.store.identitiesForApp(r1.bookmarkId)).toHaveLength(2);
  });
});

describe("A2 收件箱全链路：映射 → 处理 → 镜像操作入队", () => {
  it("原生拖入（映射后 process）→ 应用库归位 + 浏览器镜像操作生成", async () => {
    env = makeEnv(null);
    await env.app.request("/api/v1/inbox/setup", { method: "POST" });
    // 浏览器事件（模拟扩展 flushInbox 的 drain）
    const mapped = (await (
      await env.app.request("/api/v1/inbox/map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: "device-mirror-1",
          browserBookmarkId: "node-100",
          url: "https://github.com/mirror/repo",
          title: "镜像测试仓库",
        }),
      })
    ).json()) as { bookmarkId: string };

    // 处理收件箱（带 deviceId → 生成镜像操作）
    const processed = (await (
      await env.app.request("/api/v1/inbox/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookmarkIds: [mapped.bookmarkId], deviceId: "device-mirror-1" }),
      })
    ).json()) as { moved: Array<{ id: string; to: string }>; versionId: string | null };

    expect(processed.moved).toHaveLength(1);
    expect(processed.moved[0]?.to).toBe("开发");
    expect(processed.versionId).toBeTruthy(); // 可回滚

    // 镜像操作已入队（浏览器节点移动）
    const ops = (await (
      await env.app.request("/api/v1/browser/ops?deviceId=device-mirror-1")
    ).json()) as { ops: Array<{ id: number; op: string; browser_bookmark_id: string | null; target_browser_parent_id: string | null }> };
    expect(ops.ops).toHaveLength(1);
    expect(ops.ops[0]?.op).toBe("move");
    expect(ops.ops[0]?.browser_bookmark_id).toBe("node-100");
    expect(ops.ops[0]?.target_browser_parent_id).toBe("mf-folder:开发");

    // 回执 done → 不再下发
    await env.app.request(`/api/v1/browser/ops/${ops.ops[0]!.id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    const after = (await (
      await env.app.request("/api/v1/browser/ops?deviceId=device-mirror-1")
    ).json()) as { ops: unknown[] };
    expect(after.ops).toHaveLength(0);
  });

  it("重复处理同一收件箱事件 → 不产生重复镜像操作（幂等入队）", async () => {
    env = makeEnv(null);
    await env.app.request("/api/v1/inbox/setup", { method: "POST" });
    const mapped = (await (
      await env.app.request("/api/v1/inbox/map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: "device-dup-op",
          browserBookmarkId: "node-200",
          url: "https://figma.com/file/dup",
          title: "设计文件",
        }),
      })
    ).json()) as { bookmarkId: string };
    for (let i = 0; i < 3; i++) {
      await env.app.request("/api/v1/inbox/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookmarkIds: [mapped.bookmarkId], deviceId: "device-dup-op" }),
      });
    }
    const ops = (await (
      await env.app.request("/api/v1/browser/ops?deviceId=device-dup-op")
    ).json()) as { ops: unknown[] };
    expect(ops.ops.length).toBeLessThanOrEqual(1); // 幂等：不因重复事件堆操作
  });

  it("D78 已归位条目再丢入投递口 → 库条目移回收纳盒重走流水线（不弹回节点）", async () => {
    env = makeEnv(null);
    await env.app.request("/api/v1/inbox/setup", { method: "POST" });
    const payload = {
      deviceId: "device-redrop",
      browserBookmarkId: "node-redrop",
      url: "https://github.com/redrop/repo",
      title: "再投递测试",
    };
    const mapped = (await (
      await env.app.request("/api/v1/inbox/map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
    ).json()) as { bookmarkId: string };
    await env.app.request("/api/v1/inbox/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkIds: [mapped.bookmarkId], deviceId: "device-redrop" }),
    });
    const inboxId = env.store.inboxFolder()!.id;
    expect(env.store.getBookmark(mapped.bookmarkId)?.folder_id).not.toBe(inboxId); // 已归位（github 规则→开发）
    env.store.markClassificationReviewed(mapped.bookmarkId); // 假设已复核（D77）

    // 用户把同一节点再次丢入投递口（onInboxEvent → flush → map）
    await env.app.request("/api/v1/inbox/map", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const after = env.store.getBookmark(mapped.bookmarkId);
    expect(after?.folder_id).toBe(inboxId); // ★ 旧实现：留在原目录 + 补「移出」镜像把节点弹回
    const st = env.store.getInboxState(mapped.bookmarkId);
    expect(st?.state).toBe("pending"); // 重走流水线
    expect(st?.reviewed_at).toBeNull(); // 新一轮生命周期 → 复核标记清零（D77/D78）
  });
});
