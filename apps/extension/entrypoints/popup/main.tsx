/**
 * popup · 一键收藏 + 收纳盒管理（原型 02/06）
 *
 * 顶部标签页（窄容器统一导航语法）：
 *  ⭐ 快速收藏（默认）· 📥 收纳盒（角标=待处理数）· 🕘 历史 · ⚙️
 *  D42（2026-11-20）：AI 聊天整理（侧栏）整条下线——真用 AI 的人用外部工具，
 *  聊天入口反而招来「问东问西」与支持负担；AI 整理收敛为管理台功能点（D27 不变），
 *  歧义集中询问（D37）并入收纳盒标签。
 *
 * 快速收藏两态（D37 收口）：
 *  - 变体 A 域名缓存命中：AI 建议归位卡（目标目录 + 「✓ 收藏到这里」/ 改目录）
 *    + 「同时保存页面快照」开关（默认开）+ 备注（折叠）+ 🛡 隐私清单检查徽章
 *  - 变体 B 未命中：先落收纳盒异步分类（D27 哲学：不当场弹选择），AI 内容级分类中
 */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import {
  api,
  getConfig,
  type FolderDto,
  type InboxItemDto,
  type InboxPlacedDto,
  type SuggestDto,
  type VersionDto,
} from "../../src/lib/api";
import { BrandHeader } from "../../src/components/skeleton";
import "./popup.css";

type TabId = "save" | "inbox" | "history";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** 顶部标签页（原型 06：窄容器统一导航语法） */
function Ptabs({
  tab,
  onTab,
  inboxCount,
}: {
  tab: TabId;
  onTab: (t: TabId) => void;
  inboxCount: number;
}) {
  const item = (id: TabId, label: React.ReactNode) => (
    <button
      className={"ptab" + (tab === id ? " on" : "")}
      onClick={() => onTab(id)}
      role="tab"
      aria-selected={tab === id}
    >
      {label}
    </button>
  );
  return (
    <div className="ptabs">
      {item("save", "⭐ 快速收藏")}
      {item(
        "inbox",
        <span className="inline-flex items-center gap-1">
          📥 收纳盒
          {inboxCount > 0 && (
            <span className="rounded-full bg-neutral-900 px-1.5 text-[10px] font-bold text-white dark:bg-neutral-100 dark:text-neutral-900">
              {inboxCount}
            </span>
          )}
        </span>,
      )}
      {item("history", "🕘 历史")}
      <button className="ptab right" title="设置" onClick={() => void browser.tabs.create({ url: "options.html" })}>
        ⚙️
      </button>
    </div>
  );
}

function Popup() {
  const [tab, setTab] = useState<TabId>("save");
  const [tabInfo, setTabInfo] = useState<chrome.tabs.Tab | null>(null);
  const [suggest, setSuggest] = useState<SuggestDto | null>(null);
  // false=正常；字符串=被隐私策略拦截的原因码（区分「命中清单」与「规则未加载」，不误标用户网站为隐私站）
  const [privacy, setPrivacy] = useState<false | "privacy_domain" | "private_bookmark" | "policy_not_loaded">(false);
  const privacyReason = (r: string): typeof privacy =>
    r === "privacy_domain" || r === "private_bookmark" || r === "policy_not_loaded" ? r : "policy_not_loaded";
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [folderChoice, setFolderChoice] = useState<string>("");
  const [snapshotOn, setSnapshotOn] = useState(true);
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const [inboxCount, setInboxCount] = useState(0);
  const [inboxItems, setInboxItems] = useState<InboxItemDto[]>([]);
  const [placed, setPlaced] = useState<InboxPlacedDto[]>([]);
  const [versions, setVersions] = useState<VersionDto[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");

  const flash = (t: string) => {
    setStatus(t);
    setTimeout(() => setStatus(""), 3500);
  };

  const loadInbox = useCallback(() => {
    void api<{ items: InboxItemDto[]; placed: InboxPlacedDto[]; ambiguousCount: number }>("/inbox/items", {})
      .then((r) => {
        setInboxItems(r.items);
        setPlaced(r.placed);
        setInboxCount(r.items.length);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void (async () => {
      const [t, cfg, dv] = await Promise.all([
        browser.tabs.query({ active: true, currentWindow: true }).then(([x]) => x ?? null),
        getConfig(),
        import("../../src/lib/device").then((m) => m.getDeviceId()),
      ]);
      setTabInfo(t);
      setDeviceId(dv);
      void browser.storage.local.get(["snapshotDefault"]).then((s) => setSnapshotOn(s["snapshotDefault"] !== false));
      if (t?.url && /^https?:/.test(t.url)) {
        setPrivacy(
          await decidePrivacySafe("read_content", t.url)
            .then((d) => (d.allowed ? false : privacyReason(d.reason)))
            // 判定本身出错也必须走保守侧：视为规则未加载，仅存 URL
            .catch(() => "policy_not_loaded" as const),
        );
        void api<SuggestDto>("/pipeline/suggest", {
          method: "POST",
          body: JSON.stringify({ url: t.url, title: t.title ?? "" }),
        })
          .then(setSuggest)
          .catch(() => setSuggest(null));
      }
      void api<FolderDto[]>("/folders", {}).then(setFolders).catch(() => undefined);
      loadInbox();
      refreshVersions();
    })();
  }, [loadInbox]);

  const refreshVersions = () => {
    void api<{ versions: VersionDto[] }>("/organize/versions", {})
      .then((r) => setVersions(r.versions.slice(0, 8)))
      .catch(() => undefined);
  };

  const send = (type: string, okText: string, dupText: string) => {
    setStatus("处理中…");
    void browser.runtime.sendMessage({ type }, (res: { saved: boolean } | undefined) => {
      setStatus(res?.saved ? okText : res?.saved === false ? dupText : "失败：请检查服务端设置");
      setTimeout(() => setStatus(""), 3000);
    });
  };

  /** 变体 A：收藏到 AI 建议目录（或用户改选的目录）+ 快照开关 + 备注 */
  const saveToFolder = (folderId: string) => {
    if (!folderId) return;
    setBusy(true);
    setStatus("收藏中…");
    void browser.runtime.sendMessage(
      { type: "save-current", folderId, note: note || undefined, snapshot: snapshotOn },
      (res: { saved?: boolean; folderName?: string; error?: string } | undefined) => {
        setBusy(false);
        setStatus(
          res?.error
            ? `❌ 收藏失败：${res.error.slice(0, 60)}`
            : res?.saved
              ? `✅ 已收藏到 ${res.folderName ?? "目标目录"}${snapshotOn ? " · 📸 快照已保存" : ""}`
              : res
                ? "已收藏过（未重复）"
                : "❌ 收藏失败：后台无响应（服务端不可达？）",
        );
        setTimeout(() => setStatus(""), 3500);
      },
    );
  };

  /** 手动选目录（收纳盒条目 assign；隐私条目可按域名记忆） */
  const assign = (bookmarkId: string, folderId: string, rememberDomain = false) => {
    void api("/inbox/assign", {
      method: "POST",
      body: JSON.stringify({ bookmarkId, folderId, deviceId, rememberDomain }),
    })
      .then(() => {
        flash("✅ 已归位");
        loadInbox();
      })
      .catch((err: unknown) => flash(`❌ 归位失败：${String(err).slice(0, 60)}`));
  };

  const retry = (bookmarkId: string) => {
    void api("/inbox/retry", { method: "POST", body: JSON.stringify({ bookmarkId, deviceId }) })
      .then(() => {
        flash("已重新排队处理");
        setTimeout(loadInbox, 1200);
      })
      .catch((err: unknown) => flash(`❌ 重试失败：${String(err).slice(0, 60)}`));
  };

  const sweep = () => {
    setBusy(true);
    // 带 deviceId：与后台清扫同路径，归位后浏览器「📥 收纳盒」节点同步移走（镜像）
    void api<{ moved?: unknown[] }>("/inbox/process", { method: "POST", body: JSON.stringify({ deviceId }) })
      .then(() => {
        setBusy(false);
        flash("✅ 已清扫");
        loadInbox();
      })
      .catch((err: unknown) => {
        setBusy(false);
        flash(`❌ 清扫失败：${String(err).slice(0, 60)}`);
      });
  };

  const folderOptions = folders.filter((f) => f.is_system_inbox !== 1);
  const suggestFolder = suggest?.folderId ?? "";
  const hit = suggest && suggest.source !== "none" && suggestFolder;
  const currentUrl = tabInfo?.url ?? "";

  return (
    <main className="w-[360px] pb-3">
      <div className="px-4 pt-3">
        <BrandHeader compact />
      </div>
      <Ptabs tab={tab} onTab={setTab} inboxCount={inboxCount} />

      {/* ⭐ 快速收藏 */}
      {tab === "save" && (
        <div className="px-4 pt-3">
          <div className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-700">
            <div className="flex items-start gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-neutral-200 text-sm font-bold text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                {(tabInfo?.title?.trim()[0] ?? "?").toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold">{tabInfo?.title ?? "…"}</div>
                <div className="truncate font-mono text-[11px] text-neutral-400">{hostOf(currentUrl)}</div>
              </div>
            </div>

            {!/^https?:/.test(currentUrl) ? (
              <p className="mt-3 text-xs text-neutral-400">当前页不支持收藏（chrome:// 等系统页）</p>
            ) : privacy ? (
              /* 🛡 隐私拦截：区分「命中清单/私密」与「规则未加载」，不把正常网站误标成隐私站 */
              <div className="mt-3">
                <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                  {privacy === "policy_not_loaded"
                    ? "🛡 隐私规则未同步 · 仅存 URL——连上服务端后自动恢复完整收藏"
                    : "🛡 隐私域名 · 仅存 URL——不抓内容 / 不送 AI / 不快照，请手动选目录"}
                </p>
                <div className="mt-2 flex gap-2">
                  <select className="flex-1 rounded-lg border px-2 py-1.5 text-xs dark:border-neutral-700" value={folderChoice} onChange={(e) => setFolderChoice(e.target.value)}>
                    <option value="">选择目录…</option>
                    {folderOptions.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                  <button
                    className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                    disabled={!folderChoice || busy}
                    onClick={() => void saveToFolder(folderChoice)}
                  >
                    收藏
                  </button>
                </div>
              </div>
            ) : hit ? (
              /* 变体 A · 域名缓存命中（<50ms） */
              <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-900 dark:bg-indigo-950">
                <div className="text-xs font-bold text-indigo-600 dark:text-indigo-300">✦ AI 建议归位 · 缓存命中</div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="rounded-md bg-indigo-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                    📁 {suggest!.folderPath.join(" / ") || suggest!.category}
                  </span>
                </div>
                <div className="mt-2.5 flex gap-2">
                  <button
                    className="flex-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void saveToFolder(suggestFolder)}
                  >
                    ✓ 收藏到这里
                  </button>
                  <select
                    className="w-28 rounded-lg border px-1.5 py-1 text-xs dark:border-neutral-700"
                    value={folderChoice}
                    onChange={(e) => setFolderChoice(e.target.value)}
                  >
                    <option value="">改目录…</option>
                    {folderOptions.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                  {folderChoice && (
                    <button className="rounded-lg border px-2 py-1 text-xs" disabled={busy} onClick={() => void saveToFolder(folderChoice)}>
                      确认
                    </button>
                  )}
                </div>
              </div>
            ) : (
              /* 变体 B · 未命中 → 先落收纳盒异步分类 */
              <div className="mt-3 rounded-xl bg-neutral-100 p-3 dark:bg-neutral-800">
                <div className="text-xs font-bold text-neutral-600 dark:text-neutral-300">✦ 首次见到这个域名</div>
                <p className="mt-1 text-xs text-neutral-500">
                  收藏后会先放进 <b>📥 收纳盒</b>，AI 自动读取网页内容判断归位（约几秒），歧义时才会问你。
                </p>
                <button
                  className="mt-2 w-full rounded-lg border px-3 py-1.5 text-xs"
                  onClick={() => send("save-to-inbox", "已放入收纳盒，AI 分类中…", "已收藏过")}
                >
                  先这样，以后再说
                </button>
              </div>
            )}

            {/* 快照开关（默认开）+ 备注（折叠）+ 丢收纳盒 */}
            {/^https?:/.test(currentUrl) && !privacy && (
              <>
                <label className="mt-3 flex items-center justify-between text-xs text-neutral-500">
                  同时保存页面快照（防失效回看）
                  <input
                    type="checkbox"
                    checked={snapshotOn}
                    onChange={(e) => {
                      setSnapshotOn(e.target.checked);
                      void browser.storage.local.set({ snapshotDefault: e.target.checked });
                    }}
                  />
                </label>
                {showNote ? (
                  <input
                    className="mt-2 w-full rounded-lg border px-2 py-1.5 text-xs dark:border-neutral-700"
                    placeholder="备注——为什么收藏它？"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                ) : (
                  <button className="mt-2 text-[11px] text-neutral-400 underline" onClick={() => setShowNote(true)}>
                    ＋ 添加备注
                  </button>
                )}
                <button
                  className="mt-3 w-full rounded-lg border px-3 py-1.5 text-xs"
                  onClick={() => send("save-to-inbox", "已放入收纳盒", "已收藏过")}
                >
                  📥 不想了，丢进收纳盒
                </button>
              </>
            )}

            <div className="mt-3 flex items-center justify-between text-[10px] text-neutral-400">
              <span><kbd className="rounded border px-1">Ctrl+Shift+S</kbd> 快速收藏</span>
              <span>{privacy ? "🛡 已检查隐私清单 · 命中" : "🛡 已检查隐私清单"}</span>
            </div>
          </div>
        </div>
      )}

      {/* 📥 收纳盒管理（原型 06） */}
      {tab === "inbox" && (
        <div className="px-4 pt-3 text-xs">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-neutral-500">{inboxItems.length} 条待处理</span>
            <button className="rounded-lg border px-2 py-1 disabled:opacity-50" disabled={busy} onClick={sweep}>
              立即清扫
            </button>
          </div>

          {/* 歧义集中询问（D37：攒 ≥3 条触发；D42 起从「AI 整理」标签并入本视图） */}
          {inboxItems.filter((i) => i.state === "ambiguous").length >= 3 && (
            <div className="mb-2 rounded-xl bg-amber-50 p-3 dark:bg-amber-950">
              <p className="font-semibold text-amber-700 dark:text-amber-300">
                有 {inboxItems.filter((i) => i.state === "ambiguous").length} 条歧义，帮我确认一下：
              </p>
              <ul className="mt-2 space-y-2">
                {inboxItems
                  .filter((i) => i.state === "ambiguous")
                  .map((i) => (
                    <li key={i.id}>
                      <div className="truncate font-medium">{i.title}</div>
                      <div className="mt-1 flex gap-1.5">
                        {i.suggestCategory && (
                          <button
                            className="rounded-full border px-2 py-0.5 text-[11px]"
                            onClick={() => {
                              const fid = folderOptions.find((f) => f.name === i.suggestCategory)?.id;
                              // 建议目录可能已被系统改名/删除：不拿空 id 发请求（服务端必 400）
                              if (fid) assign(i.id, fid);
                              else flash(`「${i.suggestCategory}」目录不存在，请手动选目录`);
                            }}
                          >
                            📁 {i.suggestCategory}
                          </button>
                        )}
                        <span className="rounded-full border px-2 py-0.5 text-[11px] text-neutral-400">先留在收纳盒</span>
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {inboxItems.length === 0 && placed.length === 0 && (
            <p className="py-6 text-center text-neutral-400">收纳盒是空的——随手丢进书签栏「📥 收纳盒」即可</p>
          )}

          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {inboxItems.map((it) => (
              <li key={it.id} className="py-2.5">
                <div className="truncate font-medium">{it.title}</div>
                <div className="mt-0.5 truncate text-[11px] text-neutral-400">{hostOf(it.url_canonical)}</div>
                {it.state === "pending" && (
                  <p className="mt-1 text-[11px] text-neutral-400">⏳ 等待处理（事件唤醒或每小时清扫）</p>
                )}
                {it.state === "retry" && (
                  <p className="mt-1 text-[11px] text-amber-600">
                    AI 服务暂不可用 · 已排入重试队列 · 第 {it.attempts + 1}/5 次
                  </p>
                )}
                {it.state === "ambiguous" && (
                  <p className="mt-1 text-[11px] text-amber-600">
                    歧义 · 置信 {Math.round((it.confidence ?? 0) * 100)}% —— 不强行移动，等你一下
                  </p>
                )}
                {it.state === "privacy_hold" && (
                  <p className="mt-1 text-[11px] text-red-600">🛡 隐私域名 · 仅存 URL · 需手动选目录</p>
                )}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {it.state === "retry" && (
                    <button className="rounded-md bg-neutral-900 px-2 py-1 text-[11px] text-white dark:bg-neutral-100 dark:text-neutral-900" onClick={() => retry(it.id)}>
                      立即重试
                    </button>
                  )}
                  {it.state === "ambiguous" && it.suggestCategory && (
                    <span className="text-[11px] text-neutral-400">AI 倾向「{it.suggestCategory}」</span>
                  )}
                  <select
                    className="rounded-md border px-1.5 py-1 text-[11px] dark:border-neutral-700"
                    value=""
                    onChange={(e) => e.target.value && assign(it.id, e.target.value, it.is_private === 1)}
                  >
                    <option value="">{it.is_private === 1 ? "手动选目录…" : "改目录 / 手动选…"}</option>
                    {folderOptions.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                  {it.is_private === 1 && folderOptions.length > 0 && (
                    <button
                      className="rounded-md border px-2 py-1 text-[11px]"
                      title={`按域名记忆：${hostOf(it.url_canonical)} 以后自动进「${folderOptions[0]!.name}」`}
                      onClick={() => {
                        const parsed = /^https?:/.test(it.url_canonical) ? hostOf(it.url_canonical) : "";
                        // 复用 assign（自带失败反馈），服务不可达不再静默
                        if (parsed) assign(it.id, it.domainRuleFolderId ?? folderOptions[0]!.id, true);
                      }}
                    >
                      🛡 按域名记忆
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {placed.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-[11px] font-semibold text-neutral-500">最近已自动归位（可撤销）</p>
              <ul className="space-y-1.5">
                {placed.map((p) => (
                  <li key={p.bookmark_id} className="flex items-center gap-2 rounded-lg bg-neutral-100 px-2 py-1.5 dark:bg-neutral-800">
                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                    <span className="shrink-0 text-[10px] text-neutral-400">{p.reason}</span>
                    {p.version_id && (
                      <button
                        className="shrink-0 rounded-md border px-1.5 py-0.5 text-[10px]"
                        onClick={() =>
                          void api<{ reversed: number }>(`/organize/rollback/${p.version_id}`, { method: "POST" })
                            .then((r) => {
                              flash(`↩️ 已撤销 ${r.reversed} 项`);
                              loadInbox();
                              refreshVersions();
                            })
                            .catch((err: unknown) => flash(`❌ 撤销失败：${String(err).slice(0, 60)}`))
                        }
                      >
                        撤销
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* 🕘 历史：整理版本时间线（与管理台共用版本体系） */}
      {tab === "history" && (
        <div className="px-4 pt-3 text-xs">
          <p className="mb-1.5 text-[11px] text-neutral-400">最近整理版本（撤销 = 逆放 diff 生成新版本，历史永不删除）</p>
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center gap-2 py-2">
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-neutral-800">
                  {v.id.slice(0, 8)}
                </span>
                <span className="min-w-0 flex-1 truncate text-neutral-500">
                  {v.kind === "undo" ? "撤销" : v.session_id ? "整理" : "自动归位"} · {v.actionCount} 项 · {v.created_at.slice(5, 16).replace("T", " ")}
                </span>
                {v.reverted === 0 && (
                  <button
                    className="shrink-0 rounded-md border px-1.5 py-0.5 text-[10px]"
                    onClick={() =>
                      void api<{ reversed: number }>(`/organize/rollback/${v.id}`, { method: "POST" })
                        .then((r) => {
                          flash(`↩️ 已回滚 ${r.reversed} 项`);
                          refreshVersions(); // 回滚生成新 undo 版本，列表须刷新（旧「回滚」按钮不再可点）
                        })
                        .catch((err: unknown) => flash(`❌ 回滚失败：${String(err).slice(0, 60)}`))
                    }
                  >
                    回滚
                  </button>
                )}
              </li>
            ))}
            {versions.length === 0 && <li className="py-4 text-center text-neutral-400">还没有整理记录</li>}
          </ul>
        </div>
      )}

      {status && <p className="mt-2 px-4 text-center text-xs text-emerald-600">{status}</p>}
    </main>
  );
}

// decidePrivacy 由 background/lib 导出（popup 里做本地前置判定）
async function decidePrivacySafe(action: "read_content", url: string) {
  const { decidePrivacy } = await import("../../src/lib/privacy");
  return decidePrivacy(action, url);
}

createRoot(document.getElementById("root")!).render(<Popup />);
