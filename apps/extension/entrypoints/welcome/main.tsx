/**
 * 安装引导四步（原型 01 · Aha Moment 流程）
 *
 * 目标：导入后 60 秒内看到整理结果 + 导航站。注册 / BYOK 都不在这——必须放在 Aha 之后。
 *  1 欢迎 + 选择导入方式（直接读取书签树【推荐】/ Netscape HTML 文件）
 *  2 一键导入进度（分批 100 条/批 + 会话级幂等键：中断重试只补未完成批次）
 *  3 AI 已经帮你整理好了（规则引擎 · 0 token；D27 直接生效 + 一键恢复）★ Aha
 *  4 设为新标签页 + 使用引导
 *
 * 2026-11-23 自主评审修订（R1–R7）：
 *  - 展平复用 lib/import.ts：旧本地实现按「path 是否为空」判虚拟根，逐层命中同一条件，
 *    所有书签 folderPath 恒为 []（目录层级全丢），与第 1 步「完整保留目录结构」承诺矛盾
 *  - 两条通道统一 schema 上限截断 + addedAt 透传（一条超长标题会让整批 100 条 400）
 *  - Netscape 通道剥掉顶层虚拟根（否则会凭空建出「书签栏」目录）
 *  - 进度按 imported + skipped + invalid 计（旧实现漏算 skipped_invalid，进度到不了 100%）
 *  - 失败可重试：复用同一批条目与同一幂等键，已确认批次由服务端回放，不会重复导入
 *  - 整理失败不再沉默：第 3 步如实说「书签已导入、整理未完成」并给重试
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { parseNetscapeBookmarks } from "@mf/shared";
import { api, getConfig, type FolderDto } from "../../src/lib/api";
import { getDeviceId } from "../../src/lib/device";
import {
  flattenBookmarkTree,
  normalizeFolderPath,
  normalizeIngestItem,
  type BookmarkImportItem,
  type TreeNode,
} from "../../src/lib/import";
import { BrandHeader } from "../../src/components/skeleton";
import "./panel.css";

type ImportSource = "tree" | "file";

interface ImportStat {
  total: number;
  imported: number;
  /** 服务端 URL 查重跳过 */
  skipped: number;
  /** 服务端无法规范化（畸形 URL）跳过 */
  invalid: number;
  batch: number;
  batches: number;
}

interface OrganizeResult {
  status: string;
  applied?: number;
  actions?: Array<{ type: string; bookmarkTitle?: string; toFolder?: string; folderName?: string }>;
}

/** 一次导入尝试：重试复用同一批条目 + 同一幂等键（已确认批次由服务端回放，不重复导入） */
interface ImportAttempt {
  key: string;
  items: BookmarkImportItem[];
}

type Phase = "reading" | "uploading" | "organizing" | "done";

const BATCH = 100;
const SOURCE_LABEL: Record<ImportSource, string> = { tree: "浏览器书签树", file: "Netscape 文件" };
const processedOf = (stat: ImportStat | null): number => (stat ? stat.imported + stat.skipped + stat.invalid : 0);
/** 合并组数（organize 未执行时显示 — 而不是假的 0） */
const mergeGroupsOf = (organize: OrganizeResult | null): number =>
  organize?.actions?.filter((a) => a.type === "merge").length ?? 0;

async function importItems(
  items: BookmarkImportItem[],
  key: string,
  onProgress: (stat: ImportStat) => void,
  resumeFrom?: ImportStat | null,
): Promise<ImportStat> {
  // 断点续传：重试时保留已确认批次的计数与位次（服务端也按幂等键回放，双保险）
  const stat: ImportStat = resumeFrom
    ? { ...resumeFrom, total: items.length, batches: Math.ceil(items.length / BATCH) }
    : {
        total: items.length,
        imported: 0,
        skipped: 0,
        invalid: 0,
        batch: 0,
        batches: Math.ceil(items.length / BATCH),
      };
  const startIndex = Math.min(stat.batch, stat.batches) * BATCH;
  // D44：带设备 ID，服务端为 browserId 建立身份映射（管理台删除才能镜像回浏览器）
  const deviceId = await getDeviceId().catch(() => undefined);
  for (let i = startIndex; i < items.length; i += BATCH) {
    const batchKey = `${key}-${i / BATCH}`;
    const r = await api<{ imported: number; skipped_duplicate: number; skipped_invalid?: number }>("/bookmarks/ingest", {
      method: "POST",
      idempotencyKey: batchKey,
      body: JSON.stringify({ idempotencyKey: batchKey, ...(deviceId ? { deviceId } : {}), items: items.slice(i, i + BATCH) }),
    });
    stat.imported += r.imported;
    stat.skipped += r.skipped_duplicate;
    stat.invalid += r.skipped_invalid ?? 0;
    stat.batch = Math.floor(i / BATCH) + 1;
    onProgress({ ...stat });
  }
  return stat;
}

function Welcome() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [phase, setPhase] = useState<Phase>("reading");
  const [treeCount, setTreeCount] = useState<number | null>(null);
  const [stat, setStat] = useState<ImportStat | null>(null);
  const [organize, setOrganize] = useState<OrganizeResult | null>(null);
  const [organizeError, setOrganizeError] = useState("");
  const [folders, setFolders] = useState<FolderDto[]>([]);
  /** 目录预览是否还在加载：空列表 ≠ 暂无目录（第 3 步先到、预览后到） */
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [error, setError] = useState("");
  /** 第 4 步跳转失败提示（打开新标签页 / 管理台） */
  const [linkError, setLinkError] = useState("");
  const [busy, setBusy] = useState(false);
  /** 当前导入通道（state 而非从 attemptRef 派生：渲染期读 ref 不纯，且成功后 ref 会被清空） */
  const [source, setSource] = useState<ImportSource>("tree");
  /** 当前导入尝试（ref 而非 state：重试要复用同一份条目与幂等键，不该因它触发额外渲染） */
  const attemptRef = useRef<ImportAttempt | null>(null);
  /** 已确认进度（重试续传用：ref 保证回调里读到最新值，不受 useCallback 闭包快照影响） */
  const statRef = useRef<ImportStat | null>(null);
  const applyStat = useCallback((next: ImportStat): void => {
    statRef.current = next;
    setStat(next);
  }, []);

  /** 同步互斥锁：busy 是 state，同一帧内连点两次都会读到 false → 起两次导入（URL 查重只能兜底，不该靠它） */
  const busyRef = useRef(false);
  const lock = useCallback((): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  }, []);
  const unlock = useCallback((): void => {
    busyRef.current = false;
    setBusy(false);
  }, []);

  // 第 1 步条数：直接复用展平逻辑，与真正上行的条目同一口径（旧实现另写一套递归计数，口径会漂）
  useEffect(() => {
    void browser.bookmarks
      .getTree()
      .then((tree) => setTreeCount(flattenBookmarkTree(tree as unknown as TreeNode[]).length))
      .catch(() => setTreeCount(null));
  }, []);

  const loadFolders = useCallback(async (): Promise<void> => {
    setFoldersLoading(true);
    try {
      setFolders(await api<FolderDto[]>("/folders", {}));
    } catch {
      // 目录预览是附加信息：失败不影响「书签已导入」这个主结论
    } finally {
      setFoldersLoading(false);
    }
  }, []);

  /** 第 3 步：规则整理（阶段 1 · 0 token，无 LLM 也能跑）。失败不阻塞——书签已安全入库 */
  const stage1Ref = useRef(false);
  const runStage1 = useCallback(async (): Promise<void> => {
    if (stage1Ref.current) return; // 「再试一次」连点：同一时刻只跑一轮
    stage1Ref.current = true;
    setPhase("organizing");
    setOrganizeError("");
    try {
      setOrganize(
        await api<OrganizeResult>("/organize/sessions", { method: "POST", body: JSON.stringify({ message: "整理" }) }),
      );
    } catch (err) {
      setOrganize(null);
      setOrganizeError(String(err).slice(0, 160));
    } finally {
      stage1Ref.current = false;
      setPhase("done");
      // D62：目录预览是装饰信息，不得阻塞 Aha 页——不 await（失败也已在 loadFolders 内吞掉）
      void loadFolders();
    }
  }, [loadFolders]);

  /** 上行一次尝试（首跑与重试同一条路径：同 items + 同幂等键 ⇒ 已确认批次不会被重复导入） */
  const runAttempt = useCallback(async (): Promise<void> => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    setError("");
    setPhase("uploading");
    try {
      const final = await importItems(attempt.items, attempt.key, applyStat, statRef.current);
      statRef.current = final;
      attemptRef.current = null; // 全部批次已确认：下次点击是全新导入（URL 查重仍兜底）
      await runStage1();
      setStep(3);
    } catch (err) {
      // 停在第 2 步：进度、重试入口与 attempt 全部保留
      setPhase("uploading");
      setError(String(err).slice(0, 200));
    }
  }, [applyStat, runStage1]);

  /** 重试入口：只有它自己加锁（首跑由 startImport 持锁，runAttempt 再加锁会把自己挡掉） */
  const retryAttempt = useCallback((): void => {
    if (!lock()) return;
    void runAttempt().finally(unlock);
  }, [lock, runAttempt, unlock]);

  const startImport = async (src: ImportSource, load: () => Promise<BookmarkImportItem[]>): Promise<void> => {
    if (!lock()) return;
    setError("");
    setLinkError("");
    statRef.current = null;
    setStat(null);
    setOrganize(null);
    setOrganizeError("");
    setShowDetail(false);
    setPhase("reading");
    let reading = true;
    try {
      const items = await load();
      if (items.length === 0) {
        // 空态：留在第 1 步说清楚，而不是把用户送进 0 条的第 2 / 3 步
        setError(
          src === "tree"
            ? "本机没有可导入的书签（只导入 http/https 链接）"
            : "文件里没有可导入的书签（只导入 http/https 链接）",
        );
        return;
      }
      setSource(src);
      attemptRef.current = {
        key: `welcome-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        items,
      };
      setStep(2);
      reading = false;
      await runAttempt();
    } catch (err) {
      // runAttempt 内部已吞掉上行错误并停在第 2 步；走到这里主要是读取失败（权限/解析）
      setError(`${reading ? "读取失败" : "导入失败"}：${String(err).slice(0, 160)}`);
    } finally {
      unlock();
    }
  };

  const startTreeImport = (): void => {
    void startImport("tree", async () =>
      flattenBookmarkTree((await browser.bookmarks.getTree()) as unknown as TreeNode[]),
    );
  };

  const startFileImport = (file: File): void => {
    void startImport("file", async () => {
      const parsed = parseNetscapeBookmarks(await file.text());
      // 文件通道的 folderPath 自带「书签栏」等虚拟根：剥掉后与树通道结果一致
      return parsed
        .filter((p) => /^https?:/i.test(p.url))
        .map((p) => normalizeIngestItem({ ...p, folderPath: normalizeFolderPath(p.folderPath) }));
    });
  };

  const backToStep1 = (): void => {
    if (busyRef.current) return; // 上传中不离场：晚到的回执会写到已经离开的那一页上
    attemptRef.current = null; // 丢弃未完成尝试：已入库部分由 URL 查重挡住，不会重复
    statRef.current = null;
    setStep(1);
    setStat(null);
    setPhase("reading");
    setError("");
  };

  const done = processedOf(stat);
  const pct = stat && stat.total > 0 ? Math.min(100, Math.round((done / stat.total) * 100)) : 0;
  const uploading = phase === "uploading" && !error;
  const uploadDone = phase === "organizing" || phase === "done";
  const organizeOk = organize !== null;
  const topFolders = folders.filter((f) => f.is_system_inbox !== 1 && f.parent_id === null).slice(0, 7);

  return (
    <main className="min-h-screen bg-neutral-50 px-8 py-10 dark:bg-neutral-950">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-center gap-3">
          <BrandHeader />
          <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-800">
            安装引导
          </span>
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

        {/* 第 1 步的错误（空书签 / 读取失败）：第 2 步的错误在进度区内就地展示 */}
        {error && step === 1 && (
          <p className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>
        )}

        {/* 第 1 步 · 欢迎 + 选择导入方式 */}
        {step === 1 && (
          <div>
            <div className="mb-8 text-center">
              <div className="text-4xl">⭐</div>
              <h2 className="mt-2 text-xl font-bold">欢迎使用 my-favorites</h2>
              <p className="mt-1 text-sm text-neutral-500">
                把失控的书签堆，变成你每天使用的个人导航主页。全程约 1 分钟。
              </p>
            </div>
            <div className="flex items-stretch gap-4">
              <button
                onClick={startTreeImport}
                disabled={busy}
                className="flex-1 rounded-2xl border-[1.5px] border-indigo-500 bg-white p-5 text-left shadow-sm ring-indigo-100 transition hover:ring-4 disabled:opacity-60 dark:bg-neutral-900"
              >
                <div className="text-2xl">⚡</div>
                <div className="mt-1 font-semibold">
                  直接读取浏览器书签{" "}
                  <span className="ml-1 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] text-white">推荐</span>
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  {treeCount !== null ? (
                    <>
                      检测到本机可导入{" "}
                      <b className="text-neutral-800 dark:text-neutral-200">{treeCount.toLocaleString()} 条</b>，
                    </>
                  ) : (
                    ""
                  )}
                  完整保留目录结构与添加时间。一键完成，无需导出文件。
                </p>
              </button>
              <label
                className={
                  "flex-1 cursor-pointer rounded-2xl border-[1.5px] border-neutral-200 bg-white p-5 text-left transition hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 " +
                  (busy ? "pointer-events-none opacity-60" : "")
                }
              >
                <div className="text-2xl">📄</div>
                <div className="mt-1 font-semibold">导入 Netscape HTML 文件</div>
                <p className="mt-1 text-xs text-neutral-500">
                  从 Firefox / Safari 导出后拖入；或不希望授权「bookmarks」权限时的兜底方式。
                </p>
                <input
                  type="file"
                  accept=".html,.htm"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = ""; // 允许重新选择同一个文件（失败后重试）
                    if (f) startFileImport(f);
                  }}
                />
              </label>
            </div>
            <div className="mt-6 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200">
              🛡 隐私保护已内置：银行 / 内网段等常见敏感域名在导入时只保存 URL——不抓取正文、不送 AI、不做快照。
              稍后可在设置中自定义清单。
            </div>
            <p className="mt-6 text-center text-[11px] text-neutral-400">
              现在不需要配置任何 AI Key——先用规则整理体验，想要更强效果时再到管理台配置模型（D35）。
            </p>
          </div>
        )}
        {/* 第 2 步 · 导入进度（失败就地重试，不丢进度） */}
        {step === 2 && (
          <div>
            <div className="text-base font-bold">{error ? "导入中断" : "正在导入书签…"}</div>
            <p className="mt-1 text-xs text-neutral-500">
              {error
                ? "已成功上行的批次不会重复，重试只补未完成的部分。"
                : `已读取${SOURCE_LABEL[source]} · 正在分批上行（第 ${stat?.batch ?? 0}/${stat?.batches ?? "?"} 批）`}
            </p>

            {error ? (
              <div className="mt-4 rounded-xl bg-red-50 p-3 text-red-700 dark:bg-red-950 dark:text-red-300">
                <p className="text-xs break-words">{error}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    onClick={retryAttempt}
                    disabled={busy}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    重试
                  </button>
                  <button
                    onClick={backToStep1}
                    disabled={busy}
                    className="rounded-lg border border-red-300 px-3 py-1.5 text-xs disabled:opacity-50 dark:border-red-800"
                  >
                    返回上一步
                  </button>
                  <button
                    onClick={() => void browser.runtime.openOptionsPage()}
                    className="rounded-lg border border-red-300 px-3 py-1.5 text-xs dark:border-red-800"
                  >
                    打开扩展设置
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="mt-4 text-right text-2xl font-bold tabular-nums">{pct}%</div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                  <div className="h-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
                  <span>
                    {done} / {(stat?.total ?? 0).toLocaleString()} 条
                  </span>
                  <span>
                    已跳过重复 {stat?.skipped ?? 0} 条
                    {stat?.invalid ? ` · 无效 URL ${stat.invalid} 条` : ""}
                  </span>
                </div>
              </>
            )}

            <div className="mt-6 space-y-2 rounded-xl bg-neutral-100 p-4 text-xs dark:bg-neutral-800">
              <p>
                ✅ 读取{SOURCE_LABEL[source]}（{(stat?.total ?? 0).toLocaleString()} 条）
              </p>
              <p className={uploading ? "animate-pulse" : ""}>
                {uploadDone
                  ? `✅ 分批上行与去重（跳过重复 ${stat?.skipped ?? 0} 条${
                      stat?.invalid ? ` · 无效 URL ${stat.invalid} 条` : ""
                    }）`
                  : error
                    ? "⚠ 上行中断（进度已保留，可重试）"
                    : `⏳ 分批上行与去重（第 ${stat?.batch ?? 0}/${stat?.batches ?? "?"} 批）`}
              </p>
              <p className={phase === "organizing" ? "animate-pulse" : ""}>
                {phase === "organizing"
                  ? "⏳ 阶段 1「快整理」规则引擎运行中…"
                  : phase === "done"
                    ? organizeError
                      ? "⚠ 规则整理未完成（书签已导入，可稍后重试）"
                      : "✅ 阶段 1「快整理」规则引擎已完成"
                    : "待执行：阶段 1「快整理」规则引擎"}
              </p>
            </div>
          </div>
        )}
        {/* 第 3 步 · Aha Moment（整理失败也如实呈现：书签已入库） */}
        {step === 3 && (
          <div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">{organizeOk ? "✨ 已经帮你整理好了" : "📚 书签已经导入完成"}</h2>
                <p className="mt-1 text-xs text-neutral-500">
                  {(stat?.imported ?? 0).toLocaleString()} 条书签已入库，
                  {organizeOk ? "规则引擎按目录与标题重新组织，导航站同步生成——" : "整理服务暂时没响应——"}
                  <b>{organizeOk ? "不满意随时一键恢复原样" : "书签已安全保存，稍后可在管理台整理"}</b>。
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button className="rounded-lg border px-3 py-1.5 text-xs" onClick={() => setShowDetail((v) => !v)}>
                  看看它改了什么
                </button>
                <button
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white"
                  onClick={() => setStep(4)}
                >
                  设为新标签页 →
                </button>
              </div>
            </div>

            {phase === "organizing" && (
              <div className="mt-3 rounded-xl bg-indigo-50 p-3 text-xs text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">
                ⏳ 正在重新执行规则整理…
              </div>
            )}

            {organizeError && phase !== "organizing" && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                <span className="min-w-0 flex-1 truncate">规则整理未完成：{organizeError}</span>
                <button
                  className="shrink-0 rounded-lg border border-amber-400 px-2.5 py-1"
                  onClick={() => void runStage1()}
                >
                  再试一次
                </button>
              </div>
            )}

            <div className="mt-5 grid grid-cols-4 gap-3 text-center">
              {(
                [
                  [stat?.imported ?? 0, "书签已导入"],
                  [organizeOk ? (organize?.applied ?? 0) : "—", "已移动位置 · 可撤销"],
                  [organizeOk ? `${mergeGroupsOf(organize)} 组` : "—", "已合并重复 · 可拆回"],
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
                  <p key={`${a.type}-${i}`} className="truncate py-0.5 text-neutral-600 dark:text-neutral-300">
                    {a.type === "move" && `📦 「${a.bookmarkTitle}」→ ${a.toFolder}`}
                    {a.type === "createFolder" && `📁 新建目录「${a.folderName}」`}
                    {a.type === "merge" && "🔀 合并重复组（保留最早收藏）"}
                    {a.type === "markPrivate" && "🔒 已标记为私密（不送 AI、不做快照）"}
                    {a.type === "rename" && `✏️ 重命名「${a.bookmarkTitle ?? ""}」`}
                    {!["move", "createFolder", "merge", "markPrivate", "rename"].includes(a.type) &&
                      `🔧 其他调整（${a.type}）`}
                  </p>
                ))}
                {(organize?.actions?.length ?? 0) === 0 && (
                  <p className="text-neutral-400">
                    {organizeOk ? "规则判定与现有目录一致，无需挪动。" : "本次没有整理明细（整理未执行）。"}
                  </p>
                )}
              </div>
            )}

            <div className="mt-4 flex gap-3">
              <div className="flex-1 rounded-xl bg-white p-3 shadow-sm dark:bg-neutral-900">
                <p className="text-[11px] font-semibold text-neutral-500">整理后的目录树（预览）</p>
                <div className="mt-2 space-y-1 text-xs">
                  {topFolders.map((f) => (
                    <p key={f.id} className="truncate text-neutral-600 dark:text-neutral-300">
                      📁 {f.name}
                    </p>
                  ))}
                  {topFolders.length === 0 && (
                    <p className="text-neutral-400">{foldersLoading ? "（加载中…）" : "（暂无目录）"}</p>
                  )}
                </div>
              </div>
              <div className="flex-1 rounded-xl bg-white p-3 shadow-sm dark:bg-neutral-900">
                <p className="text-[11px] font-semibold text-neutral-500">导航站实时预览（只显示网站入口 D30）</p>
                <p className="mt-2 text-[11px] text-neutral-400">打开新标签页即可看到完整导航主页 →</p>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200">
              ✦ 这只是 15 秒的规则速整理。配好模型后，管理台的「整理」会用正文语义重做一遍——同样直接生效、可整体撤销。
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
                    // 先等开页成功再关本页：立刻 window.close() 会中断未完成的 promise（点了没反应）
                    setLinkError("");
                    void browser.tabs
                      .create({ url: "newtab.html" })
                      .then(() => window.close())
                      .catch(() => setLinkError("打开新标签页失败，请稍后手动打开。"));
                  }}
                >
                  打开新标签页 →
                </button>
                <button
                  className="rounded-lg border border-white/40 px-3 py-1.5 text-xs"
                  onClick={() => {
                    setLinkError("");
                    void getConfig()
                      .then((c) => browser.tabs.create({ url: `${c.serverUrl.replace(/\/+$/, "")}/#overview` }))
                      .then(() => window.close())
                      .catch(() => setLinkError("打开管理台失败，请检查扩展设置里的服务端地址。"));
                  }}
                >
                  打开管理台
                </button>
                <button
                  className="rounded-lg border border-white/40 px-3 py-1.5 text-xs"
                  onClick={() => window.close()}
                >
                  完成
                </button>
              </div>
              {linkError && <p className="mt-2 text-[11px] text-white/90">{linkError}</p>}
            </div>
            {/* D49/D50：双向同步是主路径，最后一步给一行入口（低频说明不占卡片位） */}
            <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-neutral-100 px-4 py-3 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              <span className="min-w-0 flex-1">
                想让书签和浏览器收藏夹保持一致？打开「与浏览器收藏夹同步」即双向自动收敛。
              </span>
              <button
                className="shrink-0 rounded-lg border px-2.5 py-1"
                onClick={() => void browser.runtime.openOptionsPage()}
              >
                去设置
              </button>
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
