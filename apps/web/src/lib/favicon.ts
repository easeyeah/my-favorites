/**
 * 站点图标解析器（SiteIcon 异步回填通道）
 *
 * 按 URL 记忆本会话结果：缺图书签首次遇到时调 GET /api/favicon 让服务端抓站点原始
 * favicon 并入库，此后（含其他页面同 URL）零请求直接命中。失败/隐私拦截同样缓存为
 * null（本会话不再重试；服务端另有 24h host 级负缓存）。
 *
 * 并发闸（D60）：管理台与服务端同源走 HTTP/1.1，浏览器每源仅 6 个并发连接。
 * 切目录一次渲染上百行缺图书签，若不限流，图标洪水占满全部连接槽，下一个
 * 目录的 /bookmarks 数据请求会在浏览器侧排队数秒（服务端本身 5ms）。图标是
 * 装饰资源：全局最多 2 个在途，涓流回填，把连接留给数据请求。
 */
import { apiCall, loadConfig } from "./api";

const cache = new Map<string, Promise<string | null>>();

const MAX_CONCURRENT = 2;
let active = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      active++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  active--;
  waiters.shift()?.();
}

export function resolveSiteIcon(url: string): Promise<string | null> {
  let p = cache.get(url);
  if (!p) {
    p = acquireSlot()
      .then(() =>
        apiCall<{ favicon_url: string | null }>(
          loadConfig(),
          `/favicon?url=${encodeURIComponent(url)}`,
          undefined,
          20_000,
        ),
      )
      .then((r) => r.favicon_url)
      .catch(() => null)
      .finally(releaseSlot);
    cache.set(url, p);
  }
  return p;
}
