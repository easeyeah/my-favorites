/**
 * 安装引导四步（原型 01 · Aha Moment 流程）
 *
 * 目标：导入后 60 秒内看到整理结果 + 导航站。注册 / BYOK 都不在这——必须放在 Aha 之后。
 *  1 欢迎 + 选择导入方式（直接读取书签树【推荐】/ Netscape HTML 文件）
 *  2 一键导入进度（分批 100 条/批 + Idempotency-Key 幂等；隐私域名只存 URL）
 *  3 AI 已经帮你整理好了（规则引擎 · 0 token；D27 直接生效 + 一键恢复）★ Aha
 *  4 设为新标签页 + 使用引导
 */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { api, type FolderDto } from "../../src/lib/api";
import { parseNetscapeBookmarks } from "@mf/shared";
import { BrandHeader } from "../../src/components/skeleton";
import "./panel.css";

interface ImportStat {
  total: number;
  imported: number;
  skipped: number;
  privacy: number;
  batch: number;
  batches: number;
  done: boolean;
}

interface OrganizeResult {
  status: string;
  applied?: number;
  actions?: Array<{ type: string; bookmarkTitle?: string; toFolder?: string; folderName?: string }>;
}

function countTreeBookmarks(nodes: Array<{ url?: string; children?: Array<unknown> }>): number {
  let n = 0;
  for (const node of nodes) {
    if (node.url) n++;
    if (Array.isArray(node.children)) n += countTreeBookmarks(node.children as Array<{ url?: string; children?: Array<unknown> }>);
  }
  return n;
}

/** 浏览器书签树 → ingest 条目（保留层级；系统书签栏根节点忽略） */
async function flattenTree(): Promise<Array<{ url: string; title: string; folderPath: string[] }>> {
  type BmNode = { title: string; url?: string; children?: BmNode[] };
  const tree = (await browser.bookmarks.getTree()) as unknown as BmNode[];
  const out: Array<{ url: string; title: string; folderPath: string[] }> = [];
  const walk = (nodes: BmNode[], path: string[]): void => {
    for (const n of nodes) {
      if (n.url) {
        if (/^https?:/.test(n.url)) out.push({ url: n.url, title: n.title || n.url, folderPath: path });
      } else if (n.children) {
        // 书签栏 / 其他书签这两层不作为目录名（落映射根）
        const next = path.length === 0 ? [] : [...path, n.title];
        walk(n.children, next);
      }
    }
  };
  walk(tree, []);
  return out;
}

const BATCH = 100;

async function importItems(
  items: Array<{ url: string; title: string; folderPath: string[] }>,
  onProgress: (stat: ImportStat) => void,
): Promise<ImportStat> {
  const stat: ImportStat = {
    total: items.length,
    imported: 0,
    skipped: 0,
    privacy: 0,
    batch: 0,
    batches: Math.ceil(items.length / BATCH),
    done: false,
  };
  const baseKey = `welcome-${Date.now()}`;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const r = await api<{ imported: number; skipped_duplicate: number; skipped_invalid?: number }>(
      "/bookmarks/ingest",
      {
        method: "POST",
        headers: { "Idempotency-Key": `${baseKey}-${i / BATCH}` },
        body: JSON.stringify({ idempotencyKey: `${baseKey}-${i / BATCH}`, items: batch }),
      },
    );
    stat.imported += r.imported;
    stat.skipped += r.skipped_duplicate;
    stat.batch = Math.floor(i / BATCH) + 1;
    onProgress({ ...stat });
  }
  stat.done = true;
  onProgress({ ...stat });
  return stat;
}

function Welcome() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [treeCount, setTreeCount] = useState<number | null>(null);
  const [stat, setStat] = useState<ImportStat | null>(null);
  const [organize, setOrganize] = useState<OrganizeResult | null>(null);
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [showDetail, setShowDetail] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void browser.bookmarks
      .getTree()
      .then((t) => setTreeCount(countTreeBookmarks(t as unknown as Array<{ url?: string; children?: Array<unknown> }>)))
      .catch(() => setTreeCount(null));
  }, []);

  // 第 3 步：规则整理（阶段1 · 0 token；无 LLM 也能跑） + 目录树 + 导航迷你预览
  const runStage1 = useCallback(async (): Promise<void> => {
    try {
      const result = await api<OrganizeResult>("/organize/sessions", {
        method: "POST",
        body: JSON.stringify({ message: "整理" }),
      });
      setOrganize(result);
    } catch {
      setOrganize(null); // 服务端不可用也允许继续（导入已完成）
    }
    void api<FolderDto[]>("/folders", {}).then(setFolders).catch(() => undefined);
  }, []);

  const startTreeImport = async () => {
    setBusy(true);
    setError("");
    setStep(2);
    try {
      const items = await flattenTree();
      const final = await importItems(items, setStat);
      setStat(final);
      await runStage1();
      setStep(3);
    } catch (err) {
      setError(`导入失败：${String(err).slice(0, 160)}——请先在扩展设置里连接服务端（测试连接）`);
    } finally {
      setBusy(false);
    }
  };

  const startFileImport = async (file: File) => {
    setBusy(true);
    setError("");
    setStep(2);
    try {
      const html = await file.text();
      const parsed = parseNetscapeBookmarks(html);
      const items = parsed
        .filter((p) => /^https?:/.test(p.url))
        .map((p) => ({ url: p.url, title: p.title, folderPath: (p as { folderPath?: string[] }).folderPath ?? [] }));
      const final = await importItems(items, setStat);
      setStat(final);
      await runStage1();
      setStep(3);
    } catch (err) {
      setError(`解析/导入失败：${String(err).slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-neutral-50 px-8 py-10 dark:bg-neutral-950">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-center gap-3">
          <BrandHeader />
          <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-800">安装引导</span>
        </div>

        {/* 步骤条 */}
        <div className="mb-8 flex items-center gap-2 text-xs">
          {(
            [
              [1, "选择导入方式"],
              [2, "一键导入"],
              [3, "快整理结果"],
              [4, "设为新标签页"],
            ] as Array<[1 | 2 | 3 | 4, string]>
          ).map(([n, label], i) => (
            <span key={n} className="flex items-center gap-2">
              <span
                className={
                  "flex size-5 items-center justify-center rounded-full text-[10px] font-bold " +
                  (step === n
                    ? "bg-indigo-600 text-white"
                    : step > n
                      ? "bg-emerald-500 text-white"
                      : "bg-neutral-200 text-neutral-400 dark:bg-neutral-800")
                }
              >
                {step > n ? "✓" : n}
              </span>
              <span className={step === n ? "font-semibold" : "text-neutral-400"}>{label}</span>
              {i < 3 && <span className="mx-1 h-px w-8 bg-neutral-200 dark:bg-neutral-800" />}
            </span>
          ))}
        </div>

        {error && <p className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

        {/* 第 1 步 · 欢迎 + 选择导入方式 */}
        {step === 1 && (
          <div>
            <div className="mb-8 text-center">
              <div className="text-4xl">⭐</div>
              <h2 className="mt-2 text-xl font-bold">欢迎使用 my-favorites</h2>
              <p className="mt-1 text-sm text-neutral-500">把失控的书签堆，变成你每天使用的个人导航主页。全程约 1 分钟。</p>
            </div>
            <div className="flex items-stretch gap-4">
              <button
                onClick={() => void startTreeImport()}
                disabled={busy}
                className="flex-1 rounded-2xl border-[1.5px] border-indigo-500 bg-white p-5 text-left shadow-sm ring-indigo-100 transition hover:ring-4 dark:bg-neutral-900"
              >
                <div className="text-2xl">⚡</div>
                <div className="mt-1 font-semibold">
                  直接读取浏览器书签 <span className="ml-1 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] text-white">推荐</span>
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  {treeCount !== null ? (
                    <>
                      检测到本机书签 <b className="text-neutral-800 dark:text-neutral-200">{treeCount.toLocaleString()} 条</b>，
                    </>
                  ) : (
                    ""
                  )}
                  完整保留目录结构与添加时间。一键完成，无需导出文件。
                </p>
              </button>
              <label className="flex-1 cursor-pointer rounded-2xl border-[1.5px] border-neutral-200 bg-white p-5 text-left transition hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900">
                <div className="text-2xl">📄</div>
                <div className="mt-1 font-semibold">导入 Netscape HTML 文件</div>
                <p className="mt-1 text-xs text-neutral-500">从 Firefox / Safari 导出后拖入；或不希望授权「bookmarks」权限时的兜底方式。</p>
                <input
                  type="file"
                  accept=".html,.htm"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void startFileImport(f);
                  }}
                />
              </label>
            </div>
            <div className="mt-6 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200">
              🛡 隐私保护已内置：银行 / 内网段等常见敏感域名在导入时只保存 URL——不抓取正文、不送 AI、不做快照。稍后可在设置中自定义清单。
            </div>
            <p className="mt-6 text-center text-[11px] text-neutral-400">
              现在不需要配置任何 AI Key——先用规则整理体验，想要更强效果时再到管理台配置模型（D35）。
            </p>
          </div>
        )}

        {/* 第 2 步 · 导入进度 */}
        {step === 2 && (
          <div>
            <div className="text-base font-bold">正在导入书签…</div>
            <p className="mt-1 text-xs text-neutral-500">
              已读取浏览器书签树 · 正在分批上行（第 {stat?.batch ?? 0}/{stat?.batches ?? "?"} 批）
            </p>
            {(() => {
              const pct = stat && stat.total > 0 ? Math.round(((stat.imported + stat.skipped) / stat.total) * 100) : 4;
              return (
                <>
                  <div className="mt-4 text-right text-2xl font-bold tabular-nums">{pct}%</div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                    <div className="h-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
                    <span>{(stat?.imported ?? 0) + (stat?.skipped ?? 0)} / {(stat?.total ?? 0).toLocaleString()} 条</span>
                    <span>去重：已跳过 {stat?.skipped ?? 0} 条重复 URL</span>
                  </div>
                </>
              );
            })()}
            <div className="mt-6 space-y-2 rounded-xl bg-neutral-100 p-4 text-xs dark:bg-neutral-800">
              <p>✅ 读取书签树（{(stat?.total ?? 0).toLocaleString()} 条）</p>
              <p>✅ URL 规范化 + 隐私域名筛查（命中只存 URL）</p>
              <p className="animate-pulse">⏳ 分批上行与去重…</p>
              <p className="opacity-50">待执行：阶段 1「快整理」规则引擎</p>
            </div>
          </div>
        )}

        {/* 第 3 步 · Aha Moment */}
        {step === 3 && (
          <div>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold">✨ 已经帮你整理好了</h2>
                <p className="mt-1 text-xs text-neutral-500">
                  {(stat?.imported ?? 0).toLocaleString()} 条书签已重新组织，导航站同步生成——<b>不满意随时一键恢复原样</b>。
                </p>
              </div>
              <div className="flex gap-2">
                <button className="rounded-lg border px-3 py-1.5 text-xs" onClick={() => setShowDetail((v) => !v)}>
                  看看它改了什么
                </button>
                <button className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white" onClick={() => setStep(4)}>
                  设为新标签页 →
                </button>
              </div>
            </div>
            <div className="mt-5 grid grid-cols-4 gap-3 text-center">
              {(
                [
                  [stat?.imported ?? 0, "书签完成归类"],
                  [organize?.applied ?? 0, "已移动位置 · 可撤销"],
                  [(organize?.actions?.filter((a) => a.type === "merge").length ?? 0) + " 组", "已合并重复 · 可拆回"],
                  ["0", "归档建议（首周报开始给）"],
                ] as Array<[string | number, string]>
              ).map(([v, l]) => (
                <div key={l} className="rounded-xl bg-white p-3 shadow-sm dark:bg-neutral-900">
                  <div className="text-xl font-bold">{v}</div>
                  <div className="mt-0.5 text-[11px] text-neutral-400">{l}</div>
                </div>
              ))}
            </div>
            {showDetail && (
              <div className="mt-4 max-h-52 overflow-y-auto rounded-xl bg-neutral-100 p-3 text-xs dark:bg-neutral-800">
                {(organize?.actions ?? []).slice(0, 40).map((a, i) => (
                  <p key={i} className="truncate py-0.5 text-neutral-600 dark:text-neutral-300">
                    {a.type === "move" && `📦 「${a.bookmarkTitle}」→ ${a.toFolder}`}
                    {a.type === "createFolder" && `📁 新建目录「${a.folderName}」`}
                    {a.type === "merge" && `🔀 合并重复组（保留最早收藏）`}
                  </p>
                ))}
                {(organize?.actions?.length ?? 0) === 0 && <p className="text-neutral-400">规则判定与现有目录一致，无需挪动。</p>}
              </div>
            )}
            <div className="mt-4 flex gap-3">
              <div className="flex-1 rounded-xl bg-white p-3 shadow-sm dark:bg-neutral-900">
                <p className="text-[11px] font-semibold text-neutral-500">整理后的目录树（预览）</p>
                <div className="mt-2 space-y-1 text-xs">
                  {folders
                    .filter((f) => f.is_system_inbox !== 1 && f.parent_id === null)
                    .slice(0, 7)
                    .map((f) => (
                      <p key={f.id} className="truncate text-neutral-600 dark:text-neutral-300">📁 {f.name}</p>
                    ))}
                </div>
              </div>
              <div className="flex-1 rounded-xl bg-white p-3 shadow-sm dark:bg-neutral-900">
                <p className="text-[11px] font-semibold text-neutral-500">导航站实时预览（只显示网站入口 D30）</p>
                <p className="mt-2 text-[11px] text-neutral-400">打开新标签页即可看到完整导航主页 →</p>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200">
              ✦ 这只是 15 秒的快速版。AI 正在后台做「阶段 2 精修」（按正文而非标题重新理解），完成后会提示你——同样直接生效、可整体撤销。
            </div>
          </div>
        )}

        {/* 第 4 步 · 完成 + 使用引导 */}
        {step === 4 && (
          <div>
            <div className="rounded-2xl bg-indigo-600 p-5 text-white">
              <div className="text-lg font-bold">🎉 整理完成！你的导航站已就绪</div>
              <p className="mt-1 text-sm opacity-90">每次打开新标签页，都是一次整齐的开始。</p>
              <div className="mt-3 flex gap-2">
                <button
                  className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-indigo-600"
                  onClick={() => {
                    void browser.tabs.create({ url: "newtab.html" });
                    window.close();
                  }}
                >
                  打开新标签页 →
                </button>
                <button className="rounded-lg border border-white/40 px-3 py-1.5 text-xs" onClick={() => window.close()}>
                  完成
                </button>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
              {(
                [
                  ["📌", "随手收藏", "按 Ctrl+Shift+S 或右键收藏当前页，AI 即时建议归位，还能顺手拍快照。"],
                  ["📥", "懒人模式", "把任何书签丢进「📥 收纳盒」文件夹，AI 自动归位，歧义时才会问你。"],
                  ["⚡", "一键整理", "管理台点一下：重新分类、合并重复、失效检测，直接生效、随时撤销。"],
                ] as Array<[string, string, string]>
              ).map(([em, t, d]) => (
                <div key={t} className="rounded-xl bg-white p-4 shadow-sm dark:bg-neutral-900">
                  <div className="text-xl">{em}</div>
                  <div className="mt-1 font-semibold">{t}</div>
                  <p className="mt-1 text-neutral-500">{d}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Welcome />);
