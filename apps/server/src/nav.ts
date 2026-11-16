/** 导航站生成与公开渲染（F4.1 宫格模板 + F4.2 页脚水印） */
import type { Store } from "./store";

export interface NavItem {
  title: string;
  url: string;
  favicon: string | null;
  dead?: boolean;
}

export function navData(
  store: Store,
  titleOverride?: string,
): { title: string; groups: Array<{ name: string; items: NavItem[] }> } {
  const folders = store.listFolders().filter((f) => !f.is_system_inbox);
  const groups = folders.map((f) => ({
    name: f.name,
    items: store
      .listBookmarks({ folderId: f.id, limit: 200 })
      .filter((b) => b.status !== "archived")
      .map((b) => ({
        title: b.title,
        url: b.url_raw,
        favicon: b.favicon_url,
        dead: b.status === "dead",
      })),
  }));
  return { title: titleOverride ?? "我的导航", groups: groups.filter((g) => g.items.length > 0) };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderNavHtml(
  data: { title: string; groups: Array<{ name: string; items: NavItem[] }> },
  opts: { watermark: boolean },
): string {
  const groups = data.groups
    .map(
      (g) => `
    <section class="group">
      <h2>${esc(g.name)}</h2>
      <div class="grid">
        ${g.items
          .map(
            (it) => `
        <a class="card${it.dead ? " dead" : ""}" href="${esc(it.url)}" ${
              it.dead ? 'data-dead="1" title="原页已失效"' : ""
            }>
          <span class="favicon">${it.favicon ? `<img src="${esc(it.favicon)}" alt="" onerror="this.remove()">` : ""}</span>
          <span class="label">${esc(it.title)}</span>
        </a>`,
          )
          .join("")}
      </div>
    </section>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)}</title>
<style>
  :root { --bg: #f7f7f8; --card: #fff; --text: #222; --muted: #888; --border: #e5e5e8; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161618; --card: #222225; --text: #eee; --muted: #999; --border: #333; }
  }
  * { box-sizing: border-box; }
  body { margin: 0 auto; max-width: 1080px; padding: 24px; background: var(--bg); color: var(--text);
         font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  header { display: flex; gap: 12px; margin-bottom: 24px; }
  header input { flex: 1; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--border);
                 background: var(--card); color: var(--text); font-size: 15px; outline: none; }
  header button { padding: 0 20px; border-radius: 12px; border: none; background: #4f6ef7; color: #fff; cursor: pointer; }
  .group h2 { font-size: 15px; color: var(--muted); margin: 20px 0 10px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .card { display: flex; align-items: center; gap: 8px; padding: 12px; background: var(--card);
          border: 1px solid var(--border); border-radius: 12px; text-decoration: none; color: var(--text);
          transition: transform .1s; overflow: hidden; }
  .card:hover { transform: translateY(-2px); }
  .card.dead { opacity: .5; }
  .card .favicon img { width: 18px; height: 18px; border-radius: 4px; }
  .card .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  footer { margin-top: 32px; text-align: center; color: var(--muted); font-size: 12px; }
  footer a { color: var(--muted); }
</style>
</head>
<body>
  <header>
    <input id="q" type="search" placeholder="搜索书签或输入网址…" autofocus>
    <button onclick="go()">搜索</button>
  </header>
  <main id="main">${groups}</main>
  ${opts.watermark ? '<footer>⚡ 由 <a href="https://github.com/easeyeah/my-favorites">my-favorites</a> 生成</footer>' : ""}
  <script>
    function go() {
      const v = document.getElementById('q').value.trim();
      if (!v) return;
      if (/^https?:\\/\\//.test(v)) { location.href = v; return; }
      location.href = '/s/search?q=' + encodeURIComponent(v);
    }
    document.getElementById('q').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  </script>
</body>
</html>`;
}
