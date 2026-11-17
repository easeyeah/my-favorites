/** 导航站生成与公开渲染（F4：4 套模板 + 页脚水印 + 密码访问） */
import type { Store } from "./store";

export interface NavItem {
  title: string;
  url: string;
  favicon: string | null;
  dead?: boolean;
  summary?: string | null;
}

export type NavTemplate = "grid" | "list" | "cards" | "home";
export const NAV_TEMPLATES: NavTemplate[] = ["grid", "list", "cards", "home"];

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
        summary: (store.getCache(b.id)?.l1_summary as string | null) ?? null,
      })),
  }));
  return { title: titleOverride ?? "我的导航", groups: groups.filter((g) => g.items.length > 0) };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const BASE_CSS = `
  :root { --bg: #f7f7f8; --card: #fff; --text: #222; --muted: #888; --border: #e5e5e8; --accent: #4f6ef7; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161618; --card: #222225; --text: #eee; --muted: #999; --border: #333; }
  }
  * { box-sizing: border-box; }
  body { margin: 0 auto; max-width: 1080px; padding: 24px; background: var(--bg); color: var(--text);
         font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  header { display: flex; gap: 12px; margin-bottom: 24px; }
  header input { flex: 1; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--border);
                 background: var(--card); color: var(--text); font-size: 15px; outline: none; }
  header button { padding: 0 20px; border-radius: 12px; border: none; background: var(--accent); color: #fff; cursor: pointer; }
  .group h2 { font-size: 15px; color: var(--muted); margin: 20px 0 10px; }
  footer { margin-top: 32px; text-align: center; color: var(--muted); font-size: 12px; }
  footer a { color: var(--muted); }
`;

/** 模板主体（F4.2：grid 经典宫格 / list 极简清单 / cards 卡片瀑布流 / home 个人主页） */
function templateBody(data: { title: string; groups: Array<{ name: string; items: NavItem[] }> }, template: NavTemplate): string {
  const allItems = data.groups.flatMap((g) => g.items);

  if (template === "list") {
    return `<main id="main">${data.groups
      .map(
        (g) => `
    <section class="group"><h2>${esc(g.name)}</h2>
      <ul style="list-style:none;padding:0;margin:0">
        ${g.items
          .map(
            (it) =>
              `<li style="display:flex;justify-content:space-between;border-bottom:1px solid var(--border);padding:8px 4px">
               <a href="${esc(it.url)}" style="color:var(--text);text-decoration:none">${it.dead ? "☠ " : ""}${esc(it.title)}</a>
               <span style="color:var(--muted);font-size:12px">${esc(new URL(it.url).host)}</span></li>`,
          )
          .join("")}
      </ul>
    </section>`,
      )
      .join("\n")}</main>`;
  }

  if (template === "cards") {
    return `<main id="main">${data.groups
      .map(
        (g) => `
    <section class="group"><h2>${esc(g.name)}</h2>
      <div class="cards">
        ${g.items
          .map(
            (it) => `
        <a class="card${it.dead ? " dead" : ""}" href="${esc(it.url)}">
          <div style="display:flex;align-items:center;gap:8px"><span class="favicon">${it.favicon ? `<img src="${esc(it.favicon)}" alt="" onerror="this.remove()">` : ""}</span>
          <span class="label" style="font-weight:600">${esc(it.title)}</span></div>
          <div style="margin-top:6px;color:var(--muted);font-size:12px;min-height:16px">${esc(it.summary ?? new URL(it.url).host)}</div>
        </a>`,
          )
          .join("")}
      </div>
    </section>`,
      )
      .join("\n")}</main>
    <style>
      .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
      .cards .card { display: block; background: var(--card); border: 1px solid var(--border); border-radius: 12px;
                     padding: 14px; text-decoration: none; color: var(--text); height: 86px; overflow: hidden; transition: transform .1s; }
      .cards .card:hover { transform: translateY(-2px); }
      .cards .card.dead { opacity: .5; }
      .favicon img { width: 16px; height: 16px; border-radius: 4px; }
    </style>`;
  }

  if (template === "home") {
    const recent = [...allItems].slice(0, 8);
    return `<main id="main">
    <div style="text-align:center;margin:8px 0 24px">
      <div id="greet" style="font-size:22px;font-weight:600"></div>
      <div style="color:var(--muted);margin-top:4px">今天也始于你的收藏 ✦</div>
    </div>
    <section class="group"><h2>常用</h2>
      <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px">
        ${recent
          .map(
            (it) => `
        <a class="card" href="${esc(it.url)}" style="display:flex;align-items:center;gap:8px;padding:12px;background:var(--card);
           border:1px solid var(--border);border-radius:12px;text-decoration:none;color:var(--text)">
          <span class="favicon">${it.favicon ? `<img src="${esc(it.favicon)}" alt="" onerror="this.remove()">` : ""}</span>
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(it.title)}</span></a>`,
          )
          .join("")}
      </div>
    </section>
    ${data.groups
      .map(
        (g) => `
    <section class="group"><h2>${esc(g.name)}</h2>
      <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
        ${g.items
          .map(
            (it) => `
        <a class="card${it.dead ? " dead" : ""}" href="${esc(it.url)}" style="display:flex;align-items:center;gap:8px;padding:12px;background:var(--card);
           border:1px solid var(--border);border-radius:12px;text-decoration:none;color:var(--text)">
          <span class="favicon">${it.favicon ? `<img src="${esc(it.favicon)}" alt="" onerror="this.remove()">` : ""}</span>
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(it.title)}</span></a>`,
          )
          .join("")}
      </div>
    </section>`,
      )
      .join("\n")}
    </main>
    <script>
      const h = new Date().getHours();
      document.getElementById('greet').textContent =
        h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
    </script>`;
  }

  // grid（经典宫格，默认）
  return `<main id="main">${data.groups
    .map(
      (g) => `
    <section class="group">
      <h2>${esc(g.name)}</h2>
      <div class="grid">
        ${g.items
          .map(
            (it) => `
        <a class="card${it.dead ? " dead" : ""}" href="${esc(it.url)}" ${it.dead ? 'data-dead="1" title="原页已失效"' : ""}>
          <span class="favicon">${it.favicon ? `<img src="${esc(it.favicon)}" alt="" onerror="this.remove()">` : ""}</span>
          <span class="label">${esc(it.title)}</span>
        </a>`,
          )
          .join("")}
      </div>
    </section>`,
    )
    .join("\n")}</main>
    <style>
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
      .card { display: flex; align-items: center; gap: 8px; padding: 12px; background: var(--card);
              border: 1px solid var(--border); border-radius: 12px; text-decoration: none; color: var(--text);
              transition: transform .1s; overflow: hidden; }
      .card:hover { transform: translateY(-2px); }
      .card.dead { opacity: .5; }
      .card .favicon img { width: 18px; height: 18px; border-radius: 4px; }
      .card .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    </style>`;
}

export function renderNavHtml(
  data: { title: string; groups: Array<{ name: string; items: NavItem[] }> },
  opts: { watermark: boolean; template?: NavTemplate },
): string {
  const template = opts.template ?? "grid";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
  <header>
    <input id="q" type="search" placeholder="搜索书签或输入网址…" autofocus>
    <button onclick="go()">搜索</button>
  </header>
  ${templateBody(data, template)}
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

/** 密码访问页（F4.4） */
export function renderPasswordPage(title: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)} · 访问验证</title>
<style>${BASE_CSS}
  .box { max-width: 360px; margin: 15vh auto; background: var(--card); border: 1px solid var(--border);
         border-radius: 16px; padding: 32px; text-align: center; }
  input { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid var(--border);
          background: var(--bg); color: var(--text); margin: 16px 0; outline: none; }
  button { padding: 10px 24px; border-radius: 10px; border: none; background: var(--accent); color: #fff; cursor: pointer; }
</style></head>
<body><div class="box"><h2 style="margin:0">${esc(title)}</h2><p style="color:var(--muted)">此导航站已开启访问验证</p>
<form method="get"><input name="p" type="password" placeholder="访问密码" autofocus><button>进入</button></form>
</div>${'<footer>⚡ 由 my-favorites 生成</footer>'}</body></html>`;
}
