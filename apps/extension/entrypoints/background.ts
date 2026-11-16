/**
 * background service worker —— 收件箱监听（F1.5）、右键收藏、埋点
 * MV3 约束：bookmarks 事件可唤醒 SW；所有监听注册必须包在 defineBackground 内
 * （构建期 WXT 用 mock browser 导入本模块提取 manifest，顶层 API 调用会报 not implemented）。
 */
import { browser } from "wxt/browser";
import { api, getConfig, saveConfig, sendEvent } from "../src/lib/api";
import type { BookmarkDto } from "../src/lib/api";

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

  // 就地捕获（通道A：用户正在页面上，登录墙/内网/反爬全覆盖）
  let capture: PageCapture | null = null;
  try {
    const [injection] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: captureInPage,
    });
    capture = (injection?.result as PageCapture | null) ?? null;
  } catch {
    // 受限页面（chrome:// 等）：仅存元数据
  }

  const created = await api<BookmarkDto>("/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, title: capture?.title || tab.title || url }),
  });
  void sendEvent("bookmark_saved");

  // 内容上行（服务端做隐私校验 + 20KB 截断；fire-and-forget）
  if (capture) {
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

// ---------- 收件箱监听（防抖聚合，长任务委托服务端） ----------
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const inboxQueue = new Set<string>();

async function queueInboxCheck(extFolderId: string, childId: string): Promise<void> {
  const node = await browser.bookmarks.get(childId).catch(() => []);
  if (node[0]?.parentId !== extFolderId) return;
  inboxQueue.add(childId);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void flushInbox(), 1200);
}

async function flushInbox(): Promise<void> {
  const ids = [...inboxQueue];
  inboxQueue.clear();
  if (ids.length === 0) return;
  try {
    const result = await api<{
      moved: Array<{ id: string; to: string }>;
      left: Array<{ id: string; reason: string }>;
    }>("/inbox/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkIds: ids }),
    });
    if (result.moved.length > 0) {
      void sendEvent("inbox_auto_sorted", { count: result.moved.length });
      void browser.action.setBadgeText({ text: `归位${result.moved.length}` });
      setTimeout(() => void browser.action.setBadgeText({ text: "" }), 5000);
    }
  } catch {
    // 服务端不可达：书签留在收件箱（永不丢书签），等待下次清扫
  }
}

export default defineBackground((): void => {
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: MENU_SAVE_ID,
      title: "收藏到 my-favorites",
      contexts: ["page", "link"],
    });
    void sendEvent("install");
  });

  // 右键收藏（activeTab 已由用户点击授予 → 可就地捕获）
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_SAVE_ID) return;
    void saveFromTab(tab, info.linkUrl ?? info.pageUrl ?? undefined);
  });

  browser.bookmarks.onCreated.addListener((_id, bookmark) => {
    void (async () => {
      const { inboxExtId } = await getConfig();
      if (inboxExtId && bookmark.parentId === inboxExtId) {
        await queueInboxCheck(inboxExtId, bookmark.id);
      }
    })();
  });

  browser.bookmarks.onMoved.addListener((id, info) => {
    void (async () => {
      const { inboxExtId } = await getConfig();
      if (inboxExtId && info.parentId === inboxExtId) {
        await queueInboxCheck(inboxExtId, id);
      }
    })();
  });

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
        }
      })();
      return true; // async sendResponse
    },
  );
});
