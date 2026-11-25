/** D91：未开启全量同步时，只收敛收纳盒投递口内已转资料的受管节点。
 * 候选由服务端身份与实际浏览器树共同决定，复用每分钟收纳盒 alarm，SW 重启不丢任务。
 */
import { browser } from "wxt/browser";
import { api, getConfig } from "./api";
import { getDeviceId } from "./device";
import { withBrowserExecutor } from "./executor";

interface MaterialIdentity {
  browser_bookmark_id: string;
  app_bookmark_id: string;
  materialized: 0 | 1;
  url_raw: string | null;
}

let running: Promise<number> | null = null;

export function reconcileInboxMaterials(): Promise<number> {
  if (running) return running;
  running = reconcile().catch(async (err: unknown) => {
    const reason = String(err).slice(0, 200);
    console.warn("[inbox-material] cleanup failed:", reason);
    await browser.storage.local.set({ mfInboxMaterialError: { at: Date.now(), reason } });
    return 0;
  }).finally(() => { running = null; });
  return running;
}

async function reconcile(): Promise<number> {
  const account = await getConfig();
  if (account.favoritesSync || !account.inboxExtId || !account.token) return 0;
  const children = await browser.bookmarks.getChildren(account.inboxExtId);
  if (!children.some((node) => node.url)) return 0;
  const deviceId = await getDeviceId();
  // 不在浏览器写锁中等待网络；元数据请求也有整体预算，不饿死正常书签动作。
  const { identities } = await api<{ identities: MaterialIdentity[] }>(
    `/browser/identities?deviceId=${encodeURIComponent(deviceId)}`,
    { signal: AbortSignal.timeout(5000) },
  );
  const byBrowser = new Map(identities.map((identity) => [identity.browser_bookmark_id, identity]));
  return withBrowserExecutor(async () => {
    const current = await getConfig();
    if (current.favoritesSync || current.serverUrl !== account.serverUrl || current.token !== account.token || current.inboxExtId !== account.inboxExtId) return 0;
    let removed = 0;
    for (const child of children) {
      const identity = byBrowser.get(child.id);
      if (!child.url || identity?.materialized !== 1 || child.url !== identity.url_raw) continue;
      const node = (await browser.bookmarks.get(child.id).catch((err: unknown) => {
        if (/can't find bookmark|not found|no bookmark/i.test(String(err))) return [];
        throw err;
      }))[0];
      // 用户已手动挪出投递口或改网址的节点不动，不按 URL 搜索其他副本。
      if (!node?.url || node.parentId !== account.inboxExtId || node.url !== identity.url_raw) continue;
      // 隐藏态的 ifInbox 取消回声由服务端拒绝，不开全局时间窗，以免吞掉用户紧接着的新投递。
      await browser.bookmarks.remove(node.id);
      removed++;
    }
    await browser.storage.local.set({ mfInboxMaterialError: null });
    return removed;
  });
}
