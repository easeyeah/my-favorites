/**
 * background service worker —— 收件箱监听（F1.5）、右键收藏、埋点
 * MV3 约束：bookmarks 事件可唤醒 SW；所有监听注册必须包在 defineBackground 内
 * （构建期 WXT 用 mock browser 导入本模块提取 manifest，顶层 API 调用会报 not implemented）。
 */
import { browser } from "wxt/browser";
import { INBOX_FOLDER_TITLE } from "@mf/shared";
import { api, fetchWeeklyReport, getConfig, saveConfig, sendEvent } from "../src/lib/api";
import type { BookmarkDto } from "../src/lib/api";
import { decidePrivacy } from "../src/lib/privacy";
import {
  drainQueue,
  enqueueOp,
  getDeviceId,
  isMirrorMove,
  runMirrorOps,
} from "../src/lib/device";
import { getSyncInfo, runSyncTick, scheduleSyncTick, setFavoritesSync, startEventStream } from "../src/lib/sync";

const MENU_SAVE_ID = "mf-save";
const MENU_INBOX_ID = "mf-save-inbox";
const MENU_SNAPSHOT_ID = "mf-snapshot";
/** 浏览器书签栏收纳盒文件夹名（D36；与服务端 /inbox/setup 同名） */
const INBOX_TITLE = INBOX_FOLDER_TITLE;

/** 页内轻提示（原型 02：收藏完成后的页面内 toast，非弹窗）。
 * executeScript func 不可引用外部闭包 → 自包含实现；撤销经 runtime 消息回后台（token 不进页面）。 */
function toastInPage(title: string, folderName: string, bookmarkId: string, duplicate?: boolean): void {
  try {
    const old = document.getElementById("mf-save-toast");
    old?.remove();
    const el = document.createElement("div");
    el.id = "mf-save-toast";
    el.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:10px;" +
      "background:#1c1c1f;color:#f3f4f6;padding:10px 14px;border-radius:12px;font:13px/1.5 -apple-system,'PingFang SC',sans-serif;" +
      "box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:360px";
    const text = document.createElement("span");
    // 重复收藏命中既有书签：不提供「撤销」（撤销会删掉早已存在的旧收藏，超出用户直觉）
    text.innerHTML = duplicate ? `🔁 已收藏过（未重复）· <b style="color:#a5b4fc"></b>` : `✅ 已收藏到 <b style="color:#a5b4fc"></b>`;
    (text.querySelector("b") as HTMLElement).textContent = folderName;
    if (duplicate) {
      el.append(text);
      document.documentElement.append(el);
      setTimeout(() => el.remove(), 4000);
      void title;
      void bookmarkId;
      return;
    }
    const undo = document.createElement("button");
    undo.textContent = "撤销";
    undo.style.cssText =
      "border:1px solid #4b5563;background:transparent;color:#d1d5db;border-radius:8px;padding:3px 10px;cursor:pointer;font-size:12px";
    undo.onclick = () => {
      void chrome.runtime.sendMessage({ type: "undo-bookmark", bookmarkId });
      el.remove();
    };
    el.append(text, undo);
    document.documentElement.append(el);
    setTimeout(() => el.remove(), 4000);
  } catch {
    // 受限页面静默（chrome:// 等无法注入）
  }
  void title;
}

interface PageCapture {
  title: string;
  description: string | null;
  favicon: string | null;
  text: string | null;
  ogImage: string | null;
}

/** 在页面内执行的自包含捕获（executeScript func 不可引用外部闭包） */
function captureInPage(): PageCapture {
  const meta = (sel: string): string | null =>
    (document.querySelector(sel) as HTMLMetaElement | null)?.content ?? null;
  const description =
    meta('meta[name="description"]') ?? meta('meta[property="og:description"]');
  const favicon =
    (document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href ?? null;
  // D61 资料库：og:image 作为视频封面/文章封面/图片主图线索（绝对 URL 上行，服务端 server_fetch 落盘）
  const ogRaw = meta('meta[property="og:image"]') ?? meta('meta[name="twitter:image"]');
  let ogImage: string | null = null;
  if (ogRaw) {
    try {
      ogImage = new URL(ogRaw, location.href).toString();
    } catch {
      ogImage = null;
    }
  }
  const root = document.querySelector("article") ?? document.body;
  const text = (root?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 20000);
  return { title: document.title, description, favicon, text, ogImage };
}

async function saveFromTab(
  tab: chrome.tabs.Tab | undefined,
  overrideUrl?: string,
  opts: { folderId?: string; note?: string; snapshot?: boolean } = {},
): Promise<{ saved: boolean; bookmarkId?: string; folderName?: string } | null> {
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

  const created = await api<BookmarkDto & { suggest?: { folderPath?: string[] } }>("/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url,
      title: capture?.title || tab.title || url,
      ...(opts.folderId ? { folderId: opts.folderId } : {}),
      ...(opts.note ? { description: opts.note } : {}),
    }),
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
          ...(capture.ogImage ? { ogImage: capture.ogImage } : {}),
        }),
      }).catch(() => undefined);
    }
  }

  // 原型 02：收藏完成后的页内轻提示（含撤销）
  const folderName = opts.folderId
    ? (await api<Array<{ id: string; name: string }>>("/folders", {}).catch(() => [])).find((f) => f.id === opts.folderId)?.name ?? "收藏夹"
    : (created as { suggest?: { folderPath?: string[] } }).suggest?.folderPath?.join(" / ") ?? "智能归类";
  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: toastInPage,
      args: [created.title, folderName, created.id, Boolean(created.duplicate)],
    });
  } catch {
    // 受限页面静默
  }

  // 原型 02 变体 A：「同时保存页面快照」开关（默认开）
  if (opts.snapshot) {
    void snapshotById(tab, created.id).catch(() => undefined);
  }

  return { saved: !created.duplicate, bookmarkId: created.id, folderName };
}

interface InboxInfo {
  serverId: string;
  extId: string;
}

/** 确保两端收纳盒存在：服务器目录 + 浏览器同名文件夹（D36 改名 + 原型 07 位置可调：书签栏/其他书签） */
async function ensureInboxFolder(): Promise<InboxInfo> {
  const server = await api<{ id: string }>("/inbox/setup", { method: "POST" });
  const { inboxExtId, inboxParent } = await getConfig();
  const parentId = inboxParent === "2" ? "2" : "1";
  if (inboxExtId) {
    const node = await browser.bookmarks.get(inboxExtId).catch(() => []);
    if (node[0]) {
      // D36：老安装的「📥 自动整理」在下次 setup 时改名为「📥 收纳盒」
      if (node[0].title !== INBOX_TITLE) {
        await browser.bookmarks.update(inboxExtId, { title: INBOX_TITLE }).catch(() => undefined);
      }
      // 原型 07：投递口位置切换（书签栏 ↔ 其他书签）
      if (node[0].parentId !== parentId) {
        await browser.bookmarks.move(inboxExtId, { parentId }).catch(() => undefined);
      }
      return { serverId: server.id, extId: inboxExtId };
    }
  }
  const created = await browser.bookmarks.create({ parentId, title: INBOX_TITLE });
  await saveConfig({ inboxExtId: created.id });
  return { serverId: server.id, extId: created.id };
}

let lastSavedBookmarkId: string | null = null;

/** 就地捕获当前标签页 MHTML（A4-3 base64 解码；隐私校验由调用方完成） */
async function captureTabMhtml(tabId: number): Promise<ArrayBuffer | null> {
  return new Promise<ArrayBuffer | null>((resolve) => {
    // wxt/browser shim 未实现 pageCapture，直接用 chrome 命名空间
    const pageCapture = (globalThis as unknown as { chrome: { pageCapture: { captureMHTML: (opts: { tabId: number }, cb: (data?: string) => void) => void } } }).chrome.pageCapture;
    pageCapture.captureMHTML({ tabId }, (data?: string) => {
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
}

/** 对已收藏书签就地快照（popup 快照开关 / 右键菜单） */
async function snapshotById(tab: chrome.tabs.Tab | undefined, bookmarkId: string): Promise<boolean> {
  if (!tab?.id) return false;
  // A1-2 快照前校验：隐私页面禁止 captureMHTML（读取行为本身就是敏感动作）
  const snapDecision = await decidePrivacy("snapshot", tab.url ?? "");
  if (!snapDecision.allowed) return false;
  const mhtml = await captureTabMhtml(tab.id);
  if (!mhtml) return false;
  const { uploadSnapshot, sendEvent: ev } = await import("../src/lib/api");
  await uploadSnapshot(bookmarkId, mhtml);
  void ev("snapshot_created");
  return true;
}

/** F2.4 一键快照：pageCapture 原生 MHTML → 上传（先确保书签已收藏） */
async function snapshotCurrentTab(tab: chrome.tabs.Tab | undefined): Promise<{ ok: boolean }> {
  if (!tab?.id) return { ok: false };
  const save = await saveFromTab(tab);
  if (!save) return { ok: false };
  // 收藏已存在（重复）时拿不到新建 id → 先按 URL 反查
  let bookmarkId = save.bookmarkId ?? lastSavedBookmarkId;
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
  const ok = await snapshotById(tab, bookmarkId);
  return { ok };
}

// D46：F1.7「my-favorites 同步」单向补拷已退役——由收藏夹双向直接同步引擎（src/lib/sync.ts）取代。

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
    const { notifyStyle } = await getConfig();
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
        // D28：静默档不打扰——角标提示也不弹（版本记录仍在）
        if ((notifyStyle ?? "toast") !== "silent") {
          void browser.action.setBadgeText({ text: `归位${result.moved.length}` });
          setTimeout(() => void browser.action.setBadgeText({ text: "" }), 5000);
        }
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

/**
 * D57：收纳盒定时清扫兜底。即时 flush（丢入后 1.2s）可能因 MV3 SW 被杀 / 网络抖动 /
 * LLM 超时而静默失败，条目卡 pending；此函数由独立 alarm 周期调用，确保最终一定分类。
 * 用服务端 /inbox/count 门控（不依赖客户端 inboxExtId 是否失配、不会误建收纳盒）。
 */
async function maybeSweepInbox(): Promise<void> {
  try {
    const { count } = await api<{ count: number }>("/inbox/count", {});
    if (count > 0) await flushInbox();
  } catch {
    // 服务端不可达：下个周期再试
  }
}

export default defineBackground((): void => {
  browser.runtime.onInstalled.addListener((details) => {
    // 原型 02：右键菜单三条入口（收藏 / 收纳盒 / 快照）
    browser.contextMenus.create({
      id: MENU_SAVE_ID,
      title: "⭐ 收藏到 my-favorites…",
      contexts: ["page", "link"],
    });
    browser.contextMenus.create({
      id: MENU_INBOX_ID,
      title: "📥 收藏到收纳盒（不想分类）",
      contexts: ["page", "link"],
    });
    browser.contextMenus.create({
      id: MENU_SNAPSHOT_ID,
      title: "📸 给当前页拍快照",
      contexts: ["page"],
    });
    void sendEvent("install");
    // A1-2：安装即拉取隐私规则（服务端不可达时保留本地缓存；unknown/stale 一律保守拒绝敏感动作）
    void (async () => {
      const { syncPrivacyRules } = await import("../src/lib/privacy");
      await syncPrivacyRules();
    })();
    // 原型 01：安装引导（每设备一次；Aha 流程 = 导入 → 快整理 → 设为新标签页）
    if (details.reason === "install") {
      void (async () => {
        const { onboarded } = await browser.storage.local.get(["onboarded"]);
        if (!onboarded) {
          await browser.storage.local.set({ onboarded: true });
          void browser.tabs.create({ url: "welcome.html" });
        }
      })();
    }
  });

  // 原型 02：Ctrl+Shift+S / Cmd+Shift+S 快速收藏
  browser.commands?.onCommand.addListener((command) => {
    if (command !== "quick-save") return;
    void (async () => {
      try {
        const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
        await saveFromTab(tab);
      } catch (err) {
        // 离线/服务不可达：角标闪错提示（无页内权限时轻提示注入会失败，角标是唯一可达反馈）
        console.warn("[bg] quick-save failed:", String(err));
        void browser.action
          .setBadgeText({ text: "×" })
          .then(() => setTimeout(() => void browser.action.setBadgeText({ text: "" }), 4000));
      }
    })();
  });

  // F5.5 周报角标（留存钩子④）：每日首次启动 SW 时检查一次
  void (async () => {
    // A1-2：每日首启刷新隐私规则（修订版本同步）
    const { syncPrivacyRules } = await import("../src/lib/privacy");
    await syncPrivacyRules().catch(() => undefined); // 服务不可达：保留本地缓存按超期判定，不让 SW 抛未处理拒绝
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
    if (info.menuItemId === MENU_SAVE_ID) {
      void saveFromTab(tab, info.linkUrl ?? info.pageUrl ?? undefined);
    } else if (info.menuItemId === MENU_INBOX_ID) {
      void (async () => {
        try {
        const target = info.linkUrl ?? info.pageUrl ?? tab?.url;
        if (!target || !/^https?:/.test(target)) return;
        const inbox = await ensureInboxFolder();
        const created = await api<BookmarkDto>("/bookmarks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: target, title: tab?.title ?? target, folderId: inbox.serverId }),
        });
        const { inboxExtId } = await getConfig();
        if (inboxExtId) {
          await browser.bookmarks
            .create({ parentId: inboxExtId, title: created.title, url: created.url_canonical })
            .catch(() => undefined);
        }
        void sendEvent("bookmark_saved");
        if (tab?.id) {
          await browser.scripting
            .executeScript({
              target: { tabId: tab.id },
              func: toastInPage,
              args: [created.title, "收纳盒（AI 自动归类）", created.id, Boolean(created.duplicate)],
            })
            .catch(() => undefined);
        }
        } catch (err) {
          console.warn("[bg] inbox save failed:", String(err));
        }
      })();
    } else if (info.menuItemId === MENU_SNAPSHOT_ID) {
      void snapshotCurrentTab(tab);
    }
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

  // D46：书签任何变动（增删改移动）→ 防抖触发双向同步 tick（关闭时 runSyncTick 自动空转）
  const touchSync = () => void scheduleSyncTick();
  browser.bookmarks.onCreated.addListener(touchSync);
  browser.bookmarks.onMoved.addListener(touchSync);
  browser.bookmarks.onRemoved.addListener(touchSync);
  browser.bookmarks.onChanged.addListener(touchSync);

  // D46：同步周期收敛；D57：收纳盒定时清扫兜底（独立于同步开关）
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "mf-sync-tick") void runSyncTick().catch(() => undefined);
    if (alarm.name === "mf-inbox-sweep") void maybeSweepInbox();
  });

  // A2-3：SW 每次启动恢复持久队列 + 镜像操作（内存队列丢失 ≠ 操作丢失）
  void (async () => {
    const drainResult = await drainQueue();
    if (drainResult.left === 0 && drainResult.done > 0) {
      scheduleFlush(0); // 恢复了积压事件 → 立即处理
    }
    await runMirrorOps();
    // D57：收纳盒定时清扫兜底 alarm（独立于同步开关，常驻）。即时 flush 失败时靠它兜底，
    // 避免「丢入收纳盒却永远卡 pending」。启动即补扫一遍已配置的收纳盒。
    if (!(await browser.alarms.get("mf-inbox-sweep"))) {
      await browser.alarms.create("mf-inbox-sweep", { periodInMinutes: 1 });
    }
    void maybeSweepInbox(); // 启动即补扫一遍（含上次 SW 被杀时卡 pending 的条目）
    // D46/D50：开关开着但告警/SSE 循环丢了（SW 重启、浏览器重启）→ 补挂 + 重连 + 延迟补一轮
    const { favoritesSync } = await getConfig();
    if (favoritesSync) {
      if (!(await browser.alarms.get("mf-sync-tick"))) {
        await browser.alarms.create("mf-sync-tick", { periodInMinutes: 1 });
      }
      startEventStream();
      scheduleSyncTick(15_000);
    }
  })();

  // ---------- 消息路由（popup/options → background） ----------
  browser.runtime.onMessage.addListener(
    (msg: { type: string } & Record<string, unknown>, _sender, sendResponse) => {
      void (async () => {
        // 兜底：任何分支抛错（服务不可达等）必须回包，否则 popup 卡在"进行中"且 SW 未处理拒绝反复重启
        try {
        if (msg.type === "save-current") {
          const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
          // 原型 02 变体 A：popup 指定目录 + 备注 + 快照开关
          const opts = msg as { folderId?: string; note?: string; snapshot?: boolean };
          sendResponse(
            (await saveFromTab(tab, undefined, {
              folderId: opts.folderId,
              note: opts.note,
              snapshot: opts.snapshot,
            })) ?? { saved: false },
          );
        } else if (msg.type === "undo-bookmark") {
          // 页内轻提示「撤销」：删除刚收藏的书签（用户手动动作，非 AI 代删——红线③不受影响）
          const bookmarkId = (msg as { bookmarkId?: string }).bookmarkId;
          if (!bookmarkId) return sendResponse({ ok: false });
          try {
            await api(`/bookmarks/${bookmarkId}`, { method: "DELETE" });
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
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
        } else if (msg.type === "sweep-inbox") {
          // 原型 07「立即清扫」：手动触发整箱归位 + 镜像同步（与 D57 定时清扫同路径）
          try {
            const deviceId = await getDeviceId();
            const inbox = await ensureInboxFolder();
            const items = await api<Array<{ id: string }>>(`/bookmarks?folderId=${inbox.serverId}&limit=200`, {});
            const result =
              items.length > 0
                ? await api<{ moved: Array<{ id: string }> }>("/inbox/process", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ bookmarkIds: items.map((b) => b.id), deviceId }),
                  })
                : { moved: [] };
            await runMirrorOps();
            if (result.moved.length > 0) {
              void sendEvent("inbox_auto_sorted", { count: result.moved.length, via: "manual_sweep" });
            }
            sendResponse({ moved: result.moved.length });
          } catch (err) {
            sendResponse({ moved: 0, error: String(err) });
          }
        } else if (msg.type === "sync-set") {
          // D46 总开关：开 = 立即全量对齐；关 = 停止引擎（浏览器数据保留）
          try {
            const info = await setFavoritesSync(msg.on === true);
            sendResponse({ info });
          } catch (err) {
            sendResponse({ error: String(err).slice(0, 200) });
          }
        } else if (msg.type === "sync-now") {
          try {
            const info = await runSyncTick({ confirmDeletes: msg.confirmDeletes === true });
            sendResponse({ info });
          } catch (err) {
            sendResponse({ error: String(err).slice(0, 200) });
          }
        } else if (msg.type === "sync-status") {
          const { favoritesSync } = await getConfig();
          sendResponse({ on: favoritesSync === true, info: await getSyncInfo() });
        } else if (msg.type === "snapshot-current") {
          const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
          sendResponse(await snapshotCurrentTab(tab));
        }
        } catch (err) {
          // 兜底回包：任何未捕获异常都回 {error}，popup 不再卡死、SW 不产生未处理拒绝
          sendResponse({ error: String(err).slice(0, 200) });
        }
      })();
      return true; // async sendResponse
    },
  );
});
