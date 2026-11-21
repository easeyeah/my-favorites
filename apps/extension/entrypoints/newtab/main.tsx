/**
 * 新标签页 · 原生式极简（D39）
 *
 * 回归浏览器默认新标签页心智：品牌标 + 时钟 + 搜索框 + 最常访问磁贴，别无他物。
 * D29 的三档密度（标准/完整档全量分组）经用户走查判定「太乱」——全量书签
 * 属于管理台/侧栏，新标签页只服务「打开就搜、顺手点最常用」两个动作。
 * 「最常访问」= 应用内点击计数（GET /bookmarks/top），冷启动为空时自然隐藏；
 * 自定义三处：常用区数量、外部搜索引擎、小组件显隐（D41：可控制的只有显示/隐藏，
 * 出厂全关；组件内联融入页面字层、统一沉在页脚信息组（天气/黄历/IP），
 * 无卡片盒子、核心区（时钟/搜索/最常访问）位置恒定，见 docs/归档/新标签页小组件方案-v0.3.md）。
 * 极简档保留小时钟与日期（D40，用户反馈：纯无时钟过于空旷）。
 */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { api, sendEvent } from "../../src/lib/api";
import { BrandHeader } from "../../src/components/skeleton";
import { AlmanacInline, IpInline, WeatherInline } from "../../src/widgets/inline";
import { WIDGET_REGISTRY } from "../../src/widgets/registry";
import "./panel.css";

interface NtpConfig {
  topCount: number; // 0=关闭；4/8/12/16
  engines: string[]; // 启用的外部搜索引擎 id（书签引擎常驻）
  widgets: string[]; // 启用的小组件 id，显示顺序恒为 registry 顺序（D41）
}

const DEFAULT_CONFIG: NtpConfig = {
  topCount: 8,
  engines: ["baidu", "bing"],
  widgets: [],
};

const ENGINES: Array<{ id: string; label: string; url: (q: string) => string }> = [
  { id: "bookmarks", label: "书签", url: (q) => `bookmarks:${q}` },
  { id: "baidu", label: "百度", url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}` },
  { id: "bing", label: "必应", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { id: "google", label: "Google", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
];

interface TopItem {
  id: string;
  title: string;
  url_canonical: string;
  favicon_url: string | null;
  clicks: number;
}

function loadConfig(): Promise<NtpConfig> {
  return browser.storage.local
    .get(["ntpConfig"])
    .then((s) => ({ ...DEFAULT_CONFIG, ...((s.ntpConfig as Partial<NtpConfig>) ?? {}) }));
}

function saveConfigPatch(patch: Partial<NtpConfig>): Promise<void> {
  return loadConfig().then((cfg) => browser.storage.local.set({ ntpConfig: { ...cfg, ...patch } }));
}

function Tile({
  title,
  url,
  favicon,
  onClick,
}: {
  title: string;
  url: string;
  favicon: string | null;
  onClick?: () => void;
}) {
  const letter = (title.trim()[0] ?? "?").toUpperCase();
  return (
    <a
      href={url}
      onClick={onClick}
      className="flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-center transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
    >
      {favicon ? (
        <img src={favicon} alt="" className="size-6 rounded" />
      ) : (
        <span className="flex size-6 items-center justify-center rounded bg-neutral-200 text-xs font-bold text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
          {letter}
        </span>
      )}
      <span className="w-full truncate text-xs">{title}</span>
    </a>
  );
}

function NewTab() {
  const [cfg, setCfg] = useState<NtpConfig>(DEFAULT_CONFIG);
  const [top, setTop] = useState<TopItem[]>([]);
  const [query, setQuery] = useState("");
  const [engine, setEngine] = useState("bookmarks");
  const [hits, setHits] = useState<Array<{ id: string; title: string; url_raw: string; url_canonical: string }> | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    void loadConfig().then(setCfg);
  }, []);

  const load = useCallback(() => {
    void api<{ items: TopItem[] }>("/bookmarks/top?limit=24")
      .then((r) => setTop(r.items))
      .catch(() => {
        setTop([]);
        setError("无法连接服务端（设置里检查服务端地址）");
      });
  }, []);
  useEffect(load, [load]);

  // ntp_enabled 埋点按天去重
  useEffect(() => {
    void (async () => {
      const today = new Date().toISOString().slice(0, 10);
      const last = (await browser.storage.local.get(["ntp_last"]))["ntp_last"] as string | undefined;
      if (last !== today) {
        await browser.storage.local.set({ ntp_last: today });
        void sendEvent("ntp_enabled");
      }
    })();
  }, []);

  // 时钟：15s 刷新一次足够（分钟精度）
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);

  const update = (patch: Partial<NtpConfig>) => {
    setCfg((c) => ({ ...c, ...patch }));
    void saveConfigPatch(patch);
  };

  const trackClick = (id: string) => {
    void api(`/bookmarks/${id}/click`, { method: "POST" }).catch(() => undefined);
  };

  const go = () => {
    const v = query.trim();
    if (!v) return;
    if (/^https?:\/\//.test(v)) {
      void browser.tabs.create({ url: v });
      return;
    }
    const eng = ENGINES.find((e) => e.id === engine) ?? ENGINES[0]!;
    if (eng.id !== "bookmarks") {
      void browser.tabs.create({ url: eng.url(v) });
      return;
    }
    setHits([]);
    void api<{ results: Array<{ id: string; title: string; url_raw: string; url_canonical: string }> }>(
      `/search?q=${encodeURIComponent(v)}`,
      {},
    )
      .then((r) => setHits(r.results))
      .catch(() => setError("搜索失败：无法连接服务端或未登录"));
  };

  const topTiles = cfg.topCount > 0 ? top.slice(0, cfg.topCount) : [];

  return (
    <main className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <div className="mx-auto max-w-2xl px-8 pt-24 pb-16">
        <div className="mb-4 flex justify-center">
          <BrandHeader center />
        </div>

        {/* 小时钟 + 日期（D40：极简不等于空旷）——小组件不在此占位（v0.3.3：全部下沉页脚，搜索框位置恒定） */}
        <div className="mb-9 text-center">
          <div className="text-[26px] font-light tabular-nums tracking-wide text-neutral-600 dark:text-neutral-300">
            {now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
          </div>
          <div className="mt-0.5 text-xs text-neutral-400">
            {now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}
          </div>
        </div>

        {/* 搜索 + 引擎 chips（Tab 切换） */}
        <div className={"flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-5 py-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"}>
          <span className="text-lg leading-none text-neutral-400">⌕</span>
          <input
            className="flex-1 bg-transparent text-sm outline-none"
            placeholder="搜索你的书签，或输入网址…"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go();
              if (e.key === "Tab" && !query) {
                e.preventDefault();
                const idx = ENGINES.findIndex((x) => x.id === engine);
                setEngine(ENGINES[(idx + 1) % ENGINES.length]!.id);
              }
            }}
          />
          {ENGINES.filter((e) => e.id === "bookmarks" || cfg.engines.includes(e.id)).map((e) => (
            <button
              key={e.id}
              onClick={() => setEngine(e.id)}
              className={
                "rounded-full px-2.5 py-0.5 text-[11px] transition-colors " +
                (engine === e.id
                  ? "bg-neutral-900 font-semibold text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "border border-neutral-200 text-neutral-500 hover:text-neutral-800 dark:border-neutral-700 dark:text-neutral-400")
              }
            >
              {e.label}
            </button>
          ))}
        </div>

        {error && <p className="mt-8 text-center text-sm text-red-500">{error}</p>}

        {/* 搜索结果就地展示 */}
        {hits !== null && engine === "bookmarks" && (
          <section className="mx-auto mt-6 max-w-xl">
            <h2 className="text-xs text-neutral-500">搜索结果（{hits.length}）</h2>
            <ul className="mt-2 space-y-1">
              {hits.map((h) => (
                <li key={h.id}>
                  <a className="block truncate rounded-lg border p-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800" href={h.url_raw ?? h.url_canonical} onClick={() => trackClick(h.id)}>
                    {h.title}
                  </a>
                </li>
              ))}
              {hits.length === 0 && <li className="text-sm text-neutral-400">无结果</li>}
            </ul>
          </section>
        )}

        {/* 最常访问：应用内点击计数，冷启动为空时自然隐藏 */}
        {topTiles.length > 0 && (
          <>
            <div className="mt-8 mb-2 flex items-center gap-2">
              <b className="text-xs text-neutral-600 dark:text-neutral-300">📌 最常访问</b>
              <span className="text-[11px] text-neutral-400">按实际使用自动更新</span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-1">
              {topTiles.map((t) => (
                <Tile
                  key={t.id}
                  title={t.title}
                  url={t.url_canonical}
                  favicon={t.favicon_url}
                  onClick={() => trackClick(t.id)}
                />
              ))}
            </div>
          </>
        )}

      </div>

      {/* 右下角：自定义（D42 起 AI 聊天侧栏下线，整理入口收敛管理台） */}
      <div className="fixed right-5 bottom-5 flex gap-2">
        <button
          title="自定义"
          onClick={() => setShowCustom((v) => !v)}
          className="size-10 rounded-xl border border-neutral-200 bg-white text-lg shadow-sm hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          ⚙️
        </button>
      </div>

      {/* 自定义面板（D39 两处 + D41 小组件显隐） */}
      {showCustom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6" onClick={() => setShowCustom(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-neutral-900" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <b className="text-base">自定义新标签页</b>
              <button className="text-sm text-neutral-400 hover:text-neutral-700" onClick={() => setShowCustom(false)}>✕</button>
            </div>
            <div className="text-sm">
              <div className="flex items-center gap-3 py-2">
                <span className="flex-1">常用区数量</span>
                <select className="rounded-lg border px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900" value={cfg.topCount} onChange={(e) => update({ topCount: Number(e.target.value) })}>
                  <option value={4}>显示 4 个</option>
                  <option value={8}>显示 8 个</option>
                  <option value={12}>显示 12 个</option>
                  <option value={16}>显示 16 个</option>
                  <option value={0}>关闭</option>
                </select>
              </div>
              <div className="flex items-start gap-3 py-2">
                <span className="flex-1">外部搜索引擎</span>
                <div className="flex flex-wrap justify-end gap-1">
                  {ENGINES.filter((e) => e.id !== "bookmarks").map((e) => {
                    const on = cfg.engines.includes(e.id);
                    return (
                      <button
                        key={e.id}
                        onClick={() =>
                          update({
                            engines: on ? cfg.engines.filter((x) => x !== e.id) : [...cfg.engines, e.id],
                          })
                        }
                        className={
                          "rounded-full px-2 py-0.5 text-[11px] " +
                          (on ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900" : "border border-neutral-300 text-neutral-400 dark:border-neutral-700")
                        }
                      >
                        {e.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center gap-3 py-2">
                <span className="flex-1">小组件</span>
                <div className="flex flex-wrap justify-end gap-1">
                  {WIDGET_REGISTRY.map((w) => {
                    const on = cfg.widgets.includes(w.id);
                    return (
                      <button
                        key={w.id}
                        onClick={() => {
                          const set = new Set(cfg.widgets);
                          if (on) set.delete(w.id);
                          else set.add(w.id);
                          update({ widgets: WIDGET_REGISTRY.filter((r) => set.has(r.id)).map((r) => r.id) });
                        }}
                        className={
                          "rounded-full px-2 py-0.5 text-[11px] " +
                          (on ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900" : "border border-neutral-300 text-neutral-400 dark:border-neutral-700")
                        }
                      >
                        {w.icon} {w.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex justify-end pt-2">
                <button
                  className="rounded-lg border px-2 py-1 text-xs text-neutral-500"
                  onClick={() => {
                    setCfg(DEFAULT_CONFIG);
                    void saveConfigPatch(DEFAULT_CONFIG);
                  }}
                >
                  恢复默认
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 页脚信息组（D41 v0.3.4「内容还是多」→ 四行压两行）：
          行1=黄历内容行（12px 略深）；行2=环境状态行 天气·IP（11px 更淡）；
          其余细节（干支生肖/冲煞/体感三日预报/IP 归属运营商）一律收进 hover title */}
      <footer className="pb-5 text-center">
        {cfg.widgets.includes("almanac") && (
          <div className="mb-1.5">
            <AlmanacInline />
          </div>
        )}
        {(cfg.widgets.includes("weather") || cfg.widgets.includes("ip")) && (
          <div className="mb-1.5 flex flex-wrap items-center justify-center gap-2 text-[11px] text-neutral-400">
            {cfg.widgets.includes("weather") && <WeatherInline />}
            {cfg.widgets.includes("weather") && cfg.widgets.includes("ip") && <span>·</span>}
            {cfg.widgets.includes("ip") && <IpInline />}
          </div>
        )}
        <div className="text-[11px] text-neutral-400">
          ⚡ 由 <a className="underline" href="https://github.com/easeyeah/my-favorites" target="_blank">my-favorites</a> 生成
        </div>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<NewTab />);
