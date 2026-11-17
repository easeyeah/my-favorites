/**
 * background service worker —— 收件箱监听（F1.5）、右键收藏、埋点
 * MV3 约束：bookmarks 事件可唤醒 SW；所有监听注册必须包在 defineBackground 内
 * （构建期 WXT 用 mock browser 导入本模块提取 manifest，顶层 API 调用会报 not implemented）。
 */
import { browser } from "wxt/browser";
import { api, fetchWeeklyReport, getConfig, saveConfig, sendEvent } from "../src/lib/api";
import { flattenBookmarkTree, type BookmarkImportItem } from "../src/lib/import";
import type { BookmarkDto } from "../src/lib/api";
import { decidePrivacy } from "../src/lib/privacy";
import {
  drainQueue,
  enqueueOp,
  getDeviceId,
  isMirrorMove,
  runMirrorOps,
} from "../src/lib/device";

const MENU_SAVE_ID = "mf-save";
const INBOX_TITLE = "📥 自动整理";

interface PageCapture {
  title: string;
  description: string | null;
  favicon: string | null;
  text: string | null;
}

/** 在页面内执行的自包含捕获（executeScript func 不可引用外部闭包） */
function captureInPage(): PageCapture {
  const meta = (sel: string): string | null =>
    (document.querySelector(sel) as HTMLMetaElement | null)?.content ?? null;
  const description =
    meta('meta[name="description"]') ?? meta('meta[property="og:description"]');
  const favicon =
    (document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href ?? null;
  const root = document.querySelector("article") ?? document.body;
  const text = (root?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 20000);
  return { title: document.title, description, favicon, text };
}

async function saveFromTab(
  tab: chrome.tabs.Tab | undefined,
  overrideUrl?: string,
): Promise<{ saved: boolean } | null> {
  if (!tab?.id) return null;
  const url = overrideUrl ?? tab.url;
  if (!url || !/^https?:/.test(url)) return null;

  // A1-2 隐私前置校验：在读取正文【前】判定（规则未加载 → 保守禁止，仅元数据）
  const readDecision = await decidePrivacy("read_content", url);
  let capture: PageCapture | null = null;
  if (readDecision.allowed) {
    // 就地捕获（通道A：用户正在页面上，登录墙/内网/反爬全覆盖）
    try {
      const [injection] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: captureInPage,
      });
      capture = (injection?.result as PageCapture | null) ?? null;
    } catch {
      // 受限页面（chrome:// 等）：仅存元数据
    }
  }

  const created = await api<BookmarkDto>("/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, title: capture?.title || tab.title || url }),
  });
  void sendEvent("bookmark_saved");
  lastSavedBookmarkId = created.id;

  // A1-2 上传前二次校验：上传【前】判定（禁止"先上传，再由服务端补校验"）
  if (capture) {
    const uploadDecision = await decidePrivacy("upload_content", url);
    if (uploadDecision.allowed) {
      void api("/content/capture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bookmarkId: created.id,
          l2Text: capture.text,
          description: capture.description,
          faviconDataUrl: capture.favicon,
        }),
      }).catch(() => undefined);
    }
  }
  return { saved: !created.duplicate };
}

interface InboxInfo {
  serverId: string;
  extId: string;
}

/** 确保两端收件箱存在：服务器目录 + 浏览器书签栏同名文件夹 */
async function ensureInboxFolder(): Promise<InboxInfo> {
  const server = await api<{ id: string }>("/inbox/setup", { method: "POST" });
  const { inboxExtId } = await getConfig();
  if (inboxExtId) {
    const node = await browser.bookmarks.get(inboxExtId).catch(() => []);
    if (node[0]) return { serverId: server.id, extId: inboxExtId };
  }
  const created = await browser.bookmarks.create({ parentId: "1", title: INBOX_TITLE });
  await saveConfig({ inboxExtId: created.id });
  return { serverId: server.id, extId: created.id };
}

let lastSavedBookmarkId: string | null = null;

/** F2.4 一键快照：pageCapture 原生 MHTML → 上传（先确保书签已收藏） */
async function snapshotCurrentTab(tab: chrome.tabs.Tab | undefined): Promise<{ ok: boolean }> {
  if (!tab?.id) return { ok: false };
  const save = await saveFromTab(tab);
  if (!save) return { ok: false };
  // 收藏已存在（重复）时拿不到新建 id → 先按 URL 反查
  let bookmarkId = lastSavedBookmarkId;
  if (!bookmarkId && tab.url) {
    // 按URL 精确查重（服务端索引命中，不拉列表遍历）
    try {
      const lookup = await api<{ found: boolean; bookmark?: { id: string } }>(
        `/bookmarks/by-url?url=${encodeURIComponent(tab.url)}`,
        {},
      );
      bookmarkId = lookup.found ? (lookup.bookmark?.id ?? null) : null;
    } catch {
      bookmarkId = null;
    }
  }
  if (!bookmarkId) return { ok: false };
  // A1-2 快照前校验：隐私页面禁止 captureMHTML（读取行为本身就是敏感动作）
  const snapDecision = await decidePrivacy("snapshot", tab.url ?? "");
  if (!snapDecision.allowed) return { ok: false };
  const mhtml = await new Promise<ArrayBuffer | null>((resolve) => {
    // wxt/browser shim 未实现 pageCapture，直接用 chrome 命名空间
    const pageCapture = (globalThis as unknown as { chrome: { pageCapture: { captureMHTML: (opts: { tabId: number }, cb: (data?: string) => void) => void } } }).chrome.pageCapture;
    pageCapture.captureMHTML({ tabId: tab.id! }, (data?: string) => {
      if (!data) return resolve(null);
      // A4-3：Chrome/Edge captureMHTML 返回 base64 编码字符串（非原始 MHTML 文本）。
      // 直接 new Blob([data]) 会把 base64 字符当 UTF-8 字节存 → 文件损坏。
      // 正确路径：atob 解码为字节。若返回的已是明文 MHTML（未来规范变化），探测失败则按原文。
      try {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const head = new TextDecoder("latin1").decode(bytes.slice(0, 200));
        if (/content-type:\s*multipart|mime-version/i.test(head)) {
          resolve(bytes.buffer);
        } else {
          // 解码后不像 MHTML → 原文可能是明文（旧实现兼容）
          resolve(new Blob([data]).arrayBuffer());
        }
      } catch {
        resolve(new Blob([data]).arrayBuffer());
      }
    });
  });
  if (!mhtml) return { ok: false };
  const { uploadSnapshot, sendEvent: ev } = await import("../src/lib/api");
  await uploadSnapshot(bookmarkId, mhtml);
  void ev("snapshot_created");
  return { ok: true };
}

/** F1.7 多端同步镜像：把服务端书签镜像到浏览器「my-favorites 同步」文件夹 */
async function syncMirror(): Promise<{ added: number }> {
  const { syncCursor = 0 } = await getConfig();
  const pull = await api<{
    items: Array<{ entity: string; entity_id: string; op: string; payload: unknown }>;
    cursor: number;
  }>(`/sync/pull?cursor=${syncCursor}&device=extension`, {});
  let added = 0;
  // 找/建同步根目录
  const barChildren = await browser.bookmarks.getChildren("1");
  let root = barChildren.find((n) => !n.url && n.title === "my-favorites 同步");
  if (!root) root = await browser.bookmarks.create({ parentId: "1", title: "my-favorites 同步" });
  for (const item of pull.items) {
    if (item.entity !== "bookmark") continue;
    const payload = item.payload as { url?: string; title?: string } | null;
    if (item.op === "delete" || !payload?.url) continue;
    // 幂等：按 URL 查重
    const existing = await browser.bookmarks.search({ url: payload.url }).catch(() => []);
    if (existing.length > 0) continue;
    await browser.bookmarks.create({ parentId: root.id, title: payload.title ?? payload.url, url: payload.url });
    added++;
  }
  await saveConfig({ syncCursor: pull.cursor });
  return { added };
}

// ---------- 收件箱监听（A2 改造：持久队列 + 身份映射 + 镜像） ----------

/** 事件入持久队列（A2-3：SW 重启不丢；A2-2：先映射再处理） */
async function onInboxEvent(childId: string): Promise<void> {
  const { inboxExtId } = await getConfig();
  if (!inboxExtId) return;
  const node = await browser.bookmarks.get(childId).catch(() => []);
  const bm = node[0];
  if (!bm || bm.parentId !== inboxExtId || !bm.url) return;
  // A2-5 循环保护：镜像执行引发的移动不再入队
  if (await isMirrorMove()) return;
  await enqueueOp({
    key: `inbox_map:${childId}:${bm.url}`,
    kind: "inbox_map",
    payload: { browserBookmarkId: childId, url: bm.url, title: bm.title ?? bm.url },
  });
  scheduleFlush();
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleFlush(delayMs = 1200): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushInbox(), delayMs);
}

async function flushInbox(): Promise<void> {
  // A2-2/A2-3：先把积压事件映射成应用库书签（服务端确认才出队）
  const drained = await drainQueue();
  // 映射完成后处理收件箱（应用库 ID）；带 deviceId 以生成镜像操作（A2-4）
  try {
    const deviceId = await getDeviceId();
    const inbox = await api<{ id: string }>("/inbox/setup", { method: "POST" });
    const inboxItems = await api<Array<{ id: string }>>(`/bookmarks?folderId=${inbox.id}&limit=100`, {});
    if (inboxItems.length > 0) {
      const result = await api<{
        moved: Array<{ id: string; to: string }>;
        left: Array<{ id: string; reason: string }>;
      }>("/inbox/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookmarkIds: inboxItems.map((b) => b.id), deviceId }),
      });
      if (result.moved.length > 0) {
        void sendEvent("inbox_auto_sorted", { count: result.moved.length });
        void browser.action.setBadgeText({ text: `归位${result.moved.length}` });
        setTimeout(() => void browser.action.setBadgeText({ text: "" }), 5000);
        // A2-4：立即执行镜像（把浏览器节点也移进对应目录）
        await runMirrorOps();
      }
    }
    // A2-5：无论是否有移动，顺带执行可能积压的镜像操作
    await runMirrorOps();
  } catch {
    // 服务端不可达：事件留在持久队列，等下次唤醒（A2 验收：离线不丢操作）
  }
  void drained;
}

export default defineBackground((): void => {
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: MENU_SAVE_ID,
      title: "收藏到 my-favorites",
      contexts: ["page", "link"],
    });
    void sendEvent("install");
    // A1-2：安装即拉取隐私规则（服务端不可达时 loadLocalPrivacyRules 内置兜底）
    void (async () => {
      const { syncPrivacyRules } = await import("../src/lib/privacy");
      await syncPrivacyRules();
    })();
  });

  // F5.5 周报角标（留存钩子④）：每日首次启动 SW 时检查一次
  void (async () => {
    // A1-2：每日首启刷新隐私规则（修订版本同步）
    const { syncPrivacyRules } = await import("../src/lib/privacy");
    await syncPrivacyRules();
    const today = new Date().toISOString().slice(0, 10);
    const { reportReadDate } = await getConfig();
    if (reportReadDate === today) return;
    const report = await fetchWeeklyReport();
    if (report && (report.findings.dead ?? 0) + (report.findings.suspect ?? 0) > 0) {
      await saveConfig({ reportReadDate: today });
      void browser.action.setBadgeText({
        text: `周报:${report.findings.dead ?? 0}死${report.findings.suspect ?? 0}疑`,
      });
      setTimeout(() => void browser.action.setBadgeText({ text: "" }), 10_000);
      void sendEvent("weekly_report_clicked", { via: "badge" });
    }
  })();

  // 右键收藏（activeTab 已由用户点击授予 → 可就地捕获）
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_SAVE_ID) return;
    void saveFromTab(tab, info.linkUrl ?? info.pageUrl ?? undefined);
  });

  browser.bookmarks.onCreated.addListener((_id, bookmark) => {
    void (async () => {
      if (await isMirrorMove()) return; // A2-5：镜像执行不触发处理
      const { inboxExtId } = await getConfig();
      if (inboxExtId && bookmark.parentId === inboxExtId) {
        await onInboxEvent(bookmark.id);
      }
    })();
  });

  browser.bookmarks.onMoved.addListener((id, info) => {
    void (async () => {
      if (await isMirrorMove()) return; // A2-5：镜像移动不触发处理（监听循环保护）
      const { inboxExtId } = await getConfig();
      if (inboxExtId && info.parentId === inboxExtId) {
        await onInboxEvent(id);
      }
      // A2-5：用户手动把书签移出镜像目录 → 记录用户手动归类（不自动移回）
      // 当前实现不处理移出场景的自动重排（用户手动优先），仅确保不误处理
    })();
  });

  // A2-3：SW 每次启动恢复持久队列 + 镜像操作（内存队列丢失 ≠ 操作丢失）
  void (async () => {
    const drainResult = await drainQueue();
    if (drainResult.left === 0 && drainResult.done > 0) {
      scheduleFlush(0); // 恢复了积压事件 → 立即处理
    }
    await runMirrorOps();
  })();

  // ---------- 消息路由（popup/options → background） ----------
  browser.runtime.onMessage.addListener(
    (msg: { type: string } & Record<string, unknown>, _sender, sendResponse) => {
      void (async () => {
        if (msg.type === "save-current") {
          const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
          sendResponse((await saveFromTab(tab)) ?? { saved: false });
        } else if (msg.type === "save-to-inbox") {
          const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
          if (!tab?.url) return sendResponse({ saved: false });
          const inbox = await ensureInboxFolder();
          const created = await api<BookmarkDto>("/bookmarks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              url: tab.url,
              title: tab.title ?? tab.url,
              folderId: inbox.serverId,
            }),
          });
          // 浏览器侧同步放入收件箱文件夹 → 触发流水线
          const { inboxExtId } = await getConfig();
          if (inboxExtId) {
            await browser.bookmarks.create({
              parentId: inboxExtId,
              title: created.title,
              url: created.url_canonical,
            });
          }
          void sendEvent("bookmark_saved");
          sendResponse({ saved: !created.duplicate });
        } else if (msg.type === "setup-inbox") {
          sendResponse(await ensureInboxFolder());
        } else if (msg.type === "import-bookmarks") {
          try {
            const tree = await browser.bookmarks.getTree();
            const items = flattenBookmarkTree(
              tree as unknown as Parameters<typeof flattenBookmarkTree>[0],
            );
            if (items.length === 0) {
              sendResponse({ imported: 0, total: 0, skipped_duplicate: 0, error: "浏览器书签树为空" });
              return;
            }
            // 服务端 zod 限单批 ≤100 条 → 分批提交（幂等键每批独立）
            const baseKey = `browser-tree-${Date.now()}`;
            const BATCH = 100;
            let imported = 0;
            let skipped = 0;
            let invalid = 0;
            for (let i = 0; i < items.length; i += BATCH) {
              const batch = items.slice(i, i + BATCH);
              const result = await api<{
                imported: number;
                skipped_duplicate: number;
                skipped_invalid?: number;
              }>("/bookmarks/ingest", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "Idempotency-Key": `${baseKey}-${i / BATCH}`,
                },
                body: JSON.stringify({ idempotencyKey: `${baseKey}-${i / BATCH}`, items: batch as BookmarkImportItem[] }),
              });
              imported += result.imported;
              skipped += result.skipped_duplicate;
              invalid += result.skipped_invalid ?? 0;
            }
            void sendEvent("import_completed", { imported, total: items.length });
            sendResponse({
              imported,
              total: items.length,
              skipped_duplicate: skipped,
              skipped_invalid: invalid,
            });
          } catch (err) {
            // 服务端不可达/鉴权失败等：必须回传错误，否则 UI 永远卡在"导入中…"
            sendResponse({ error: String(err).slice(0, 200) });
          }
        } else if (msg.type === "snapshot-current") {
          const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
          sendResponse(await snapshotCurrentTab(tab));
        } else if (msg.type === "sync-mirror") {
          try {
            sendResponse(await syncMirror());
          } catch (err) {
            sendResponse({ error: String(err) });
          }
        }
      })();
      return true; // async sendResponse
    },
  );
});
