/**
 * A2 扩展侧基础设施（2026-11-17）：
 *  - 持久设备 ID（storage.local，首次生成）
 *  - 持久待发送操作队列（storage.local，SW 重启可恢复；A2-3）
 *  - 收件箱事件：先映射（/inbox/map）再处理（应用库 ID；A2-2）
 *  - 浏览器镜像操作执行（/browser/ops 拉取-执行-回执；A2-4 镜像模式 D20）
 *  - 监听循环保护：自己执行的移动不再触发收件箱处理（mirrorGuard）
 */
import { browser } from "wxt/browser";
import { api, getConfig, saveConfig } from "./api";

const DEVICE_ID_KEY = "mfDeviceId";
const PENDING_QUEUE_KEY = "mfPendingOps";
const MIRROR_GUARD_KEY = "mfMirrorGuard";

/** A2-1 持久设备 ID：每台设备安装唯一，永不复用其他设备的 */
export async function getDeviceId(): Promise<string> {
  const stored = (await browser.storage.local.get(DEVICE_ID_KEY))[DEVICE_ID_KEY] as string | undefined;
  if (stored) return stored;
  const id = crypto.randomUUID();
  await browser.storage.local.set({ [DEVICE_ID_KEY]: id });
  // 注册到服务端（失败不阻塞：后续请求会再注册）
  void api("/devices/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: id, label: navigator.userAgent.slice(0, 80) }),
  }).catch(() => undefined);
  return id;
}

// ---------- A2-3 持久待发送操作队列 ----------

export interface PendingOp {
  /** 幂等键：同 op+bookmark 只保留一份 */
  key: string;
  kind: "inbox_map";
  payload: { browserBookmarkId: string; url: string; title: string };
  status: "pending" | "done";
  attempts: number;
  lastError?: string;
  createdAt: number;
}

async function readQueue(): Promise<PendingOp[]> {
  return ((await browser.storage.local.get(PENDING_QUEUE_KEY))[PENDING_QUEUE_KEY] as PendingOp[] | undefined) ?? [];
}

async function writeQueue(q: PendingOp[]): Promise<void> {
  await browser.storage.local.set({ [PENDING_QUEUE_KEY]: q });
}

/** 入队（幂等：key 相同且 pending → 不重复） */
export async function enqueueOp(op: Omit<PendingOp, "status" | "attempts" | "createdAt">): Promise<void> {
  const q = await readQueue();
  if (q.some((o) => o.key === op.key && o.status === "pending")) return;
  q.push({ ...op, status: "pending", attempts: 0, createdAt: Date.now() });
  await writeQueue(q);
}

/**
 * 队列驱动：逐条执行，服务端确认成功才移除；失败保留待重试。
 * SW 重启后调用本函数即可恢复（队列在 storage.local 持久）。
 */
export async function drainQueue(): Promise<{ done: number; left: number }> {
  const deviceId = await getDeviceId();
  let done = 0;
  for (;;) {
    const q = await readQueue();
    const next = q.find((o) => o.status === "pending");
    if (!next) return { done, left: 0 };
    try {
      if (next.kind === "inbox_map") {
        await api("/inbox/map", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deviceId,
            browserBookmarkId: next.payload.browserBookmarkId,
            url: next.payload.url,
            title: next.payload.title,
          }),
        });
      }
      // 服务端确认成功 → 移除（完成即消失，重复事件被 key 幂等去重）
      await writeQueue((await readQueue()).filter((o) => o.key !== next.key));
      done++;
    } catch (err) {
      // 失败：保留 + 记录，本轮终止（离线时等下次唤醒重试）
      const q2 = await readQueue();
      await writeQueue(
        q2.map((o) =>
          o.key === next.key ? { ...o, attempts: o.attempts + 1, lastError: String(err).slice(0, 200) } : o,
        ),
      );
      return { done, left: (await readQueue()).filter((o) => o.status === "pending").length };
    }
  }
}

// ---------- A2-4 镜像操作执行（含监听循环保护） ----------

/** 镜像保护窗：自己执行的浏览器移动在窗口内不触发收件箱处理 */
async function withMirrorGuard<T>(fn: () => Promise<T>): Promise<T> {
  await browser.storage.local.set({ [MIRROR_GUARD_KEY]: Date.now() });
  try {
    return await fn();
  } finally {
    // 保留标记一小段时间（onMoved 事件异步到达）
    setTimeout(() => void browser.storage.local.remove(MIRROR_GUARD_KEY), 3000);
  }
}

export async function isMirrorMove(): Promise<boolean> {
  const t = (await browser.storage.local.get(MIRROR_GUARD_KEY))[MIRROR_GUARD_KEY] as number | undefined;
  return t !== undefined && Date.now() - t < 5000;
}

/** 镜像目录节点：与「my-favorites 同步」根平级，按应用库目录名建文件夹 */
async function ensureMirrorFolder(folderName: string): Promise<string> {
  const barChildren = await browser.bookmarks.getChildren("1");
  const prefix = "mf-整理-";
  let root = barChildren.find((n) => !n.url && n.title === "mf-整理");
  if (!root) root = await browser.bookmarks.create({ parentId: "1", title: "mf-整理" });
  void prefix;
  const children = await browser.bookmarks.getChildren(root.id);
  const existing = children.find((n) => !n.url && n.title === folderName);
  return existing?.id ?? (await browser.bookmarks.create({ parentId: root.id, title: folderName })).id;
}

/** 拉取并执行浏览器镜像操作（每条回执） */
export async function runMirrorOps(): Promise<{ executed: number; failed: number }> {
  const deviceId = await getDeviceId();
  let executed = 0;
  let failed = 0;
  let ops: Array<{
    id: number;
    op: string;
    browser_bookmark_id: string | null;
    target_browser_parent_id: string | null;
    payload: { folderName?: string } | null;
  }>;
  try {
    ops = (await api<{ ops: typeof ops }>(`/browser/ops?deviceId=${encodeURIComponent(deviceId)}`, {})).ops;
  } catch {
    return { executed: 0, failed: 0 }; // 服务端不可达：下次再试
  }
  for (const o of ops) {
    try {
      if (o.op === "move" && o.browser_bookmark_id && o.target_browser_parent_id?.startsWith("mf-folder:")) {
        const folderName = o.payload?.folderName ?? o.target_browser_parent_id.slice("mf-folder:".length);
        await withMirrorGuard(async () => {
          const targetParent = await ensureMirrorFolder(folderName);
          const node = await browser.bookmarks.get(o.browser_bookmark_id!).catch(() => []);
          if (node[0]) {
            await browser.bookmarks.move(o.browser_bookmark_id!, { parentId: targetParent });
          }
        });
      }
      await api(`/browser/ops/${o.id}/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      executed++;
    } catch (err) {
      failed++;
      void api(`/browser/ops/${o.id}/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "failed", error: String(err).slice(0, 200) }),
      }).catch(() => undefined);
    }
  }
  return { executed, failed };
}
