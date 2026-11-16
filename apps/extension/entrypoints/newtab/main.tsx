import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { api, getConfig, sendEvent, type NavDataDto } from "../../src/lib/api";
import "./panel.css";

function NewTab() {
  const [data, setData] = useState<NavDataDto | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [serverUrl, setServerUrl] = useState("http://localhost:3000");

  useEffect(() => {
    // ntp_enabled 埋点按天去重
    void (async () => {
      const today = new Date().toISOString().slice(0, 10);
      const last = (await browser.storage.local.get(["ntp_last"]))["ntp_last"] as string | undefined;
      if (last !== today) {
        await browser.storage.local.set({ ntp_last: today });
        void sendEvent("ntp_enabled");
      }
    })();
    void api<NavDataDto>("/nav/data")
      .then(setData)
      .then(() => getConfig().then((c) => setServerUrl(c.serverUrl)))
      .catch(() => setError("无法连接服务端（设置里检查服务端地址）"));
  }, []);

  const go = () => {
    const v = query.trim();
    if (!v) return;
    if (/^https?:\/\//.test(v)) void browser.tabs.create({ url: v });
    // 必须跳服务端公开页（相对路径会解析到扩展内部 chrome-extension://）
    else void browser.tabs.create({ url: `${serverUrl}/s/search?q=${encodeURIComponent(v)}` });
  };

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-center text-2xl font-semibold">{data?.title ?? "我的导航"}</h1>
      <div className="mx-auto mt-6 flex max-w-xl gap-2">
        <input
          className="flex-1 rounded-xl border px-4 py-3 text-sm outline-none"
          placeholder="搜索书签或输入网址…"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
        <button className="rounded-xl bg-indigo-500 px-6 text-white" onClick={go}>搜索</button>
      </div>
      {error && <p className="mt-8 text-center text-sm text-red-500">{error}</p>}
      {data?.groups.map((group) => (
        <section key={group.name} className="mt-8">
          <h2 className="text-sm text-neutral-500">{group.name}</h2>
          <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
            {group.items.map((item) => (
              <a
                key={item.url}
                href={item.url}
                className={"flex items-center gap-2 rounded-xl border p-3 text-sm hover:-translate-y-0.5 hover:shadow" + (item.dead ? " opacity-50" : "")}
                title={item.dead ? "原页已失效" : undefined}
              >
                {item.favicon && <img className="h-4 w-4 rounded" src={item.favicon} alt="" />}
                <span className="truncate">{item.title}</span>
              </a>
            ))}
          </div>
        </section>
      ))}
      <footer className="mt-12 text-center text-xs text-neutral-400">
        ⚡ 由 <a className="underline" href="https://github.com/easeyeah/my-favorites" target="_blank">my-favorites</a> 生成
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<NewTab />);
