/**
 * 整理能力分布：
 * - CheckupSection：失效检测（书签页「失效」标签页）——进度流 + 失效/疑似明细
 * - DupSection：重复书签（书签页「重复」标签页）——组明细 + 合并全部（D28：直接生效，7 天内版本可恢复）
 * - HistoryTrigger / HistorySection：版本历史——入口挂目录树底部重分类下方（链接态开关，移动端在目录 chips 行），
 *   点击后右栏切换为历史时间线面板（整理的唯一安全面）
 * - ReorgButton / ReorgSection：全库重分类——入口挂目录树底部（移动端在目录 chips 行），
 *   点击后右栏列表区切换为重分类面板（内容区直显，不用弹窗）
 *   D27：一次调用直接生效（act + undo），无确认流；归档/删除建议永不自动执行（红线③）。
 * - SensitiveButton / SensitiveSection：敏感内容旁路（D43）——入口挂目录树底部重分类下方，
 *   点了就跑：命中项标私密 + 移入「私人收藏」，不再外发；版本历史可整批撤销。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  Copy,
  FolderInput,
  History,
  Loader2,
  Play,
  RotateCcw,
  ShieldOff,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Btn, EmptyState, NumberedPagination, SiteIcon, hostOf, tidyNotify, timeAgo, toast } from '@/components/shared'
import { useShell } from '@/components/layout'
import { useServerChanges } from '@/lib/events'
import {
  ApiError,
  apiCall,
  fetchers,
  type DupScanReport,
  type LinkCheckReport,
  type ProposalAction,
  type VersionRow,
} from '@/lib/api'
import { isMock, mockLinkCheckStream } from '@/lib/mock'
import { consumeSse } from '@/lib/sse'
import { cn } from '@/lib/utils'

interface LinkProgress {
  total: number
  checked: number
  dead: number
  suspect: number
  normal: number
  items: Array<{ i: number; title: string; host: string; verdict: 'normal' | 'suspect' | 'dead' }>
}

/** D27 act + undo：一次调用直接生效；actions 为只读明细（事后呈现，不承担确认职责） */
interface OrganizeRunResponse {
  sessionId: string
  status: 'applied' | 'answered'
  answer: string
  actions: ProposalAction[] | null
  versionId?: string
  applied?: number
}

/** 失效检测区块（失效标签页顶部）：检测按钮 + 进度流；失效/疑似明细直接看下方书签列表 */
export function CheckupSection({ onChecked }: { onChecked?: () => void }) {
  const { cfg, refreshBadges } = useShell()
  const [linkReport, setLinkReport] = useState<LinkCheckReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<LinkProgress | null>(null)

  const load = useCallback(() => {
    fetchers.linkReport(cfg).then(setLinkReport).catch(() => setLinkReport(null))
  }, [cfg])
  useEffect(load, [load])

  const dead = (linkReport?.findings.results ?? []).filter((r) => r.verdict === 'dead')
  const suspect = (linkReport?.findings.results ?? []).filter((r) => r.verdict === 'suspect')

  const emptyProgress = (): LinkProgress => ({
    total: 0,
    checked: 0,
    dead: 0,
    suspect: 0,
    normal: 0,
    items: [] as Array<{ i: number; title: string; host: string; verdict: 'normal' | 'suspect' | 'dead' }>,
  })

  const onEvent = (event: string, payload: Record<string, unknown>) => {
    if (event === 'start') {
      setProgress((p) => ({ ...(p ?? emptyProgress()), total: Number(payload.total ?? 0) }))
    } else if (event === 'item') {
      const it = payload as unknown as {
        i: number
        title: string
        host: string
        verdict: 'normal' | 'suspect' | 'dead'
        total: number
      }
      setProgress((p) => {
        const base = p ?? emptyProgress()
        return {
          total: it.total || base.total,
          checked: base.checked + 1,
          dead: base.dead + (it.verdict === 'dead' ? 1 : 0),
          suspect: base.suspect + (it.verdict === 'suspect' ? 1 : 0),
          normal: base.normal + (it.verdict === 'normal' ? 1 : 0),
          items: [it, ...base.items].slice(0, 8),
        }
      })
    } else if (event === 'done') {
      const d = payload as unknown as { checked: number; dead: number; suspect: number }
      toast.ok(
        d.dead === 0 && d.suspect === 0
          ? `检测完成：${d.checked} 条全部正常 🎉`
          : `检测完成：失效 ${d.dead}、疑似 ${d.suspect}（已在下方标注）`,
      )
      load()
      refreshBadges()
      onChecked?.()
    } else if (event === 'error') {
      throw new Error(String(payload.error ?? '检测失败'))
    }
  }

  const runCheckup = async () => {
    if (busy) return
    setBusy(true)
    setProgress(emptyProgress())
    try {
      if (isMock()) {
        for await (const ev of mockLinkCheckStream(20)) onEvent(ev.event, ev.data)
      } else {
        const res = await fetch(`${cfg.serverUrl.replace(/\/+$/, '')}/api/v1/maintenance/links/run/stream?limit=20`, {
          headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
        })
        await consumeSse(res, onEvent)
      }
    } catch (e) {
      toast.err(`检测失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // 原型 14：归档建议清单（检测报告带回；永不自动执行——一键归档由用户点，红线③）
  const archiveCandidates = linkReport?.findings.archiveCandidates ?? []
  const archiveAll = async () => {
    if (archiveCandidates.length === 0) return
    try {
      for (const c of archiveCandidates) {
        await apiCall(cfg, `/bookmarks/${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) })
      }
      tidyNotify.ok(`已归档 ${archiveCandidates.length} 条（软归档可恢复，历史不删）`)
      load()
    } catch (e) {
      toast.err(`归档失败：${e instanceof ApiError ? e.message : String(e)}`)
    }
  }
  const copySummary = () => {
    const d = linkReport?.findings
    if (!d) return
    const lines = [
      `🩺 my-favorites 维护摘要（${new Date().toLocaleDateString('zh-CN')}）`,
      `确认失效 ${d.dead} 条（${d.deadWithSnapshot ?? 0} 条有快照可回看）`,
      `疑似失效 ${d.suspect} 条（反爬拦截，仅标注）`,
      `正常 ${d.normal} 条 · 共检测 ${d.checked} 条`,
    ]
    void navigator.clipboard.writeText(lines.join('\n')).then(() => toast.ok('本周摘要已复制'))
  }

  return (
    <div className="mb-4 space-y-2 px-3">
      <div>
        <Btn className="h-7 gap-1 px-2.5 text-xs" onClick={() => void runCheckup()} disabled={busy}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />} 重新检测
        </Btn>
        {linkReport && (
          <Btn className="ml-1.5 h-7 gap-1 px-2.5 text-xs" onClick={copySummary}>
            <Copy className="size-3" /> 复制本周摘要
          </Btn>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {dead.length + suspect.length > 0
          ? `打不开 ${dead.length} 条（确认失效${(linkReport?.findings.deadWithSnapshot ?? 0) > 0 ? ` · ${linkReport?.findings.deadWithSnapshot} 条有快照可回看` : ''}）· 疑似 ${suspect.length} 条（被反爬 / 限流 / 登录墙挡住，未必真失效）——都列在下方`
          : '暂无失效记录'}
      </p>
      {busy && progress && (
        <div className="bg-accent/40 space-y-3 rounded-xl p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-sm font-medium tabular">
              {progress.checked}/{progress.total || '…'} 条已检查
            </span>
            <span className="flex gap-1.5">
              <Badge variant="success">正常 {progress.normal}</Badge>
              <Badge variant="warning">疑似 {progress.suspect}</Badge>
              <Badge variant="destructive">失效 {progress.dead}</Badge>
            </span>
          </div>
          <Progress value={progress.total > 0 ? Math.round((progress.checked / progress.total) * 100) : 0} />
          <ul className="space-y-1 text-xs">
            {progress.items.map((it) => (
              <li key={it.i} className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {it.verdict === 'dead' ? (
                    <TriangleAlert className="text-destructive inline size-3.5" />
                  ) : it.verdict === 'suspect' ? (
                    <TriangleAlert className="text-amber-500 inline size-3.5" />
                  ) : (
                    <CheckCircle2 className="text-emerald-500 inline size-3.5" />
                  )}{' '}
                  {it.title}
                </span>
                <Badge
                  variant={it.verdict === 'dead' ? 'destructive' : it.verdict === 'suspect' ? 'warning' : 'success'}
                  className="shrink-0"
                >
                  {it.verdict === 'dead' ? '失效' : it.verdict === 'suspect' ? '疑似' : '正常'}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      {archiveCandidates.length > 0 && (
        <div className="rounded-xl border border-dashed p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">🗄 归档建议清单（{archiveCandidates.length}）——两年前收藏，没有自动执行</span>
            <Btn className="h-6 gap-1 px-2 text-[11px]" onClick={() => void archiveAll()}>
              一键全部归档
            </Btn>
          </div>
          <ul className="divide-border/60 mt-1.5 divide-y">
            {archiveCandidates.slice(0, 6).map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate">
                  {c.title}
                  {c.hasSnapshot && <span className="text-primary ml-1.5 text-[10px]">📸</span>}
                </span>
                <span className="text-muted-foreground shrink-0 text-[10px]">{c.added_at.slice(0, 10)} 收藏</span>
              </li>
            ))}
          </ul>
          {archiveCandidates.length > 6 && (
            <p className="text-muted-foreground mt-1 text-[10px]">…等 {archiveCandidates.length} 条</p>
          )}
          <p className="text-muted-foreground mt-1 text-[10px]">归档 = 移入「已归档」，快照保留，随时恢复；彻底删除永远在你手里。</p>
        </div>
      )}
    </div>
  )
}

/** 重复书签区块（「重复」标签页）：组明细 + 合并全部（删除类，执行前确认） */
export function DupSection() {
  const { cfg, refreshBadges } = useShell()
  const [dupReport, setDupReport] = useState<DupScanReport | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetchers.dupReport(cfg).then(setDupReport).catch(() => setDupReport(null))
  }, [cfg])
  useEffect(load, [load])
  // D82：重复视图随门铃校准（外部删除/归档改变重复组）；失败保留旧报告，不回退加载态
  useServerChanges(() => {
    fetchers.dupReport(cfg).then(setDupReport).catch(() => {})
  })

  const groups = dupReport?.findings.suggestions ?? []

  /** 合并全部（D28：一次调用直接生效——保留最早收藏的一条，其余软归档，7 天内版本可恢复） */
  const mergeAll = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await apiCall<OrganizeRunResponse>(cfg, '/organize/sessions', {
        method: 'POST',
        body: JSON.stringify({ message: '合并重复' }),
      })
      if (r.status === 'applied') {
        tidyNotify.ok(`已合并 ${r.applied} 条重复，7 天内可在版本历史恢复`)
      } else {
        tidyNotify.ok('没有需要合并的重复书签')
      }
      load()
      refreshBadges()
      window.dispatchEvent(new Event('mf:versions-changed'))
    } catch (e) {
      toast.err(`合并失败：${e instanceof ApiError ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // 报告未返回时不闪「没有重复书签」空态
  if (dupReport === null) {
    return (
      <div className="mb-4 flex items-center justify-center py-8">
        <Loader2 className="text-muted-foreground animate-spin" />
      </div>
    )
  }

  // 无重复：整个操作区替换为统一空态（无可执行动作就不显示按钮）
  if (groups.length === 0 && !busy) {
    return (
      <div className="mb-4">
        <EmptyState icon="✨" title="没有重复书签" hint="检测出重复的书签会出现在这里" />
      </div>
    )
  }

  return (
    <div className="mb-4 space-y-2 px-3">
      <div>
        <Btn className="h-7 gap-1 px-2.5 text-xs" onClick={() => void mergeAll()} disabled={busy || groups.length === 0}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Copy className="size-3" />} 合并全部
        </Btn>
      </div>
      <p className="text-muted-foreground text-xs">
        {groups.length > 0
          ? `${groups.length} 组重复 · 保留最早收藏的一条，可在版本历史撤销`
          : '正在扫描重复书签…'}
      </p>
      {groups.length > 0 && (
        <ul className="divide-border/60 divide-y">
          {groups.map((g) => (
            <li key={g.keep} className="flex items-start gap-2.5 py-3">
              <SiteIcon title={g.title} url={g.items?.find((it) => it.isKeep)?.url} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{g.title}</div>
                <div className="text-muted-foreground/80 mt-0.5 space-y-0.5 text-[11px]">
                  {(g.items ?? [])
                    .filter((it) => !it.isKeep)
                    .map((it) => (
                      <p key={it.id} className="truncate">
                        重复副本：{it.title}（{hostOf(it.url)}）
                      </p>
                    ))}
                </div>
              </div>
              <Badge variant="warning" className="mt-0.5 shrink-0">
                重复 {g.dupes.length + 1} 条
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 版本历史入口（目录树底部，重分类下方）：链接态视觉的开关；点击后右栏切换为历史面板 */
export function HistoryTrigger({
  mobile = false,
  active = false,
  onClick,
}: {
  mobile?: boolean
  active?: boolean
  onClick: () => void
}) {
  const { cfg } = useShell()
  const [count, setCount] = useState(0)

  const load = useCallback(() => {
    fetchers.versions(cfg).then((r) => setCount(r.versions.length)).catch(() => setCount(0))
  }, [cfg])

  useEffect(() => {
    load()
    const h = () => load()
    window.addEventListener('mf:versions-changed', h)
    return () => window.removeEventListener('mf:versions-changed', h)
  }, [load])

  const title = '每次整理都记为版本，逐条撤销——整理的唯一安全面'
  return mobile ? (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'bg-muted/70 text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors',
        active && 'bg-accent font-medium text-foreground',
      )}
    >
      <History className="size-3" /> 版本历史
      {count > 0 && <span className="text-[10px] opacity-70">{count}</span>}
    </button>
  ) : (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'text-muted-foreground/60 hover:text-foreground mt-1 flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] transition-colors hover:underline',
        active && 'text-foreground font-medium',
      )}
    >
      <History className="size-3" /> 版本历史
      {count > 0 && <span className={cn(active ? 'text-muted-foreground' : 'text-muted-foreground/50')}>· {count} 条</span>}
    </button>
  )
}

/** 全库重分类入口（目录树底部/移动端目录 chips）：点击后右栏列表区切换为 ReorgSection，再点或换目录退出 */
export function ReorgButton({
  mobile = false,
  active = false,
  onClick,
}: {
  mobile?: boolean
  active?: boolean
  onClick: () => void
}) {
  const title = 'AI 重排整库目录——只移动不删除，可在版本历史整批撤销'
  return mobile ? (
    <TidyChip icon={Sparkles} label="全库重分类" title={title} onClick={onClick} />
  ) : (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'text-muted-foreground hover:bg-accent/50 hover:text-foreground mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors',
        active && 'bg-accent/60 font-medium text-foreground',
      )}
    >
      <Sparkles className="size-3.5" /> 全库重分类
    </button>
  )
}

/** 全库重分类面板（右栏内容区，替代弹窗）：跑完刷新目录树与列表；移动类直接生效可撤销（D27） */
interface ReorgResult {
  applied: number
  versionId: string
  moves: ProposalAction[]
}

export function ReorgSection({
  onClose,
  onApplied,
  onShowHistory,
}: {
  onClose: () => void
  onApplied: () => void
  onShowHistory: () => void
}) {
  const { cfg, refreshBadges } = useShell()
  const [busy, setBusy] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [result, setResult] = useState<ReorgResult | null>(null)

  const runReorg = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await apiCall<OrganizeRunResponse>(cfg, '/organize/sessions', {
        method: 'POST',
        body: JSON.stringify({ message: '整理整个库' }),
      })
      if (r.status === 'applied' && r.versionId) {
        setResult({ applied: r.applied ?? 0, versionId: r.versionId, moves: r.actions ?? [] })
        tidyNotify.ok(`已重分类 ${r.applied} 项——明细在下方`)
        onApplied()
      } else {
        // D92：未产生调整 ≠「结构很好」——以服务端按真实结果生成的说明为准（规则未命中 / 模型故障 / 范围外）。
        // 用 toast 而非 tidyNotify：这类说明属于「需要知道」，不受静默成功提示偏好影响
        toast.info(r.answer || '本次没有产生调整')
      }
      refreshBadges()
      window.dispatchEvent(new Event('mf:versions-changed'))
    } catch (e) {
      toast.err(`重分类失败：${e instanceof ApiError ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 撤销刚跑的这一批（逆放 diff 生成新版本，历史永不删除） */
  const undoBatch = async () => {
    if (!result || undoing) return
    setUndoing(true)
    try {
      const r = await apiCall<{ reversed: number }>(cfg, `/organize/rollback/${result.versionId}`, { method: 'POST' })
      // D92：reversed 是真实回执——整理后被手动改过的条目会保留，不能一律说「全部回到原目录」
      if (r.reversed > 0) tidyNotify.ok(`已撤销 ${r.reversed} 项（整理后被你改过的条目保留）`)
      else toast.info('条目已有其他改动，本次没有覆盖')
      setResult(null)
      onApplied()
      refreshBadges()
      window.dispatchEvent(new Event('mf:versions-changed'))
    } catch (e) {
      toast.err(`撤销失败：${e instanceof ApiError ? e.message : String(e)}`)
    } finally {
      setUndoing(false)
    }
  }

  // 分类结果按目标目录归拢（最直观的读法：每个目录收了哪些书签）；本批新建的目录在组头标「新建」
  const groups = useMemo(() => {
    const map = new Map<string, ProposalAction[]>()
    const created = new Set<string>()
    for (const a of result?.moves ?? []) {
      if (a.type === 'move' && a.toFolder) {
        const list = map.get(a.toFolder) ?? []
        list.push(a)
        map.set(a.toFolder, list)
      } else if (a.type === 'createFolder' && a.folderName) {
        created.add(a.folderName)
      }
    }
    return { groups: [...map.entries()], created }
  }, [result])

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold tracking-tight">全库重分类</h3>
          <p className="text-muted-foreground mt-1 max-w-xl text-sm">
            {result
                  ? '这一批的分类结果如下——目录树和书签列表已同步刷新，不满意可整批撤销。'
                  : 'AI 分析整个书签库，重新规划目录结构并批量挪动书签；移动直接生效，每一次挪动都记入版本历史，随时可整批撤销。'}
          </p>
        </div>
        <button
          onClick={onClose}
          title="返回书签列表"
          className="text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded-lg p-1.5 transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>

      {result ? (
        <>
          <div className="mt-5 space-y-5">
            {groups.groups.map(([to, list]) => (
              <div key={to}>
                <p className="text-muted-foreground mx-1 flex items-center gap-2 px-3 text-xs font-medium">
                  <FolderInput className="text-muted-foreground/70 size-4 shrink-0" />
                  移入「{to}」
                  {groups.created.has(to) && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      新建
                    </Badge>
                  )}
                  <span className="text-muted-foreground/60 text-[11px] font-normal">{list.length} 条</span>
                </p>
                <ul className="mt-2">
                  {list.map((m, i) => (
                    <Fragment key={`${m.bookmarkTitle}-${i}`}>
                      <li className="hover:bg-accent/40 mx-1 flex items-center gap-4 rounded-lg py-2.5 pr-3 pl-9 text-sm transition-colors">
                        <span className="min-w-0 flex-1 truncate font-medium">{m.bookmarkTitle}</span>
                        <span className="text-muted-foreground max-w-52 shrink-0 truncate text-[13px]">
                          原在 {m.fromFolder ?? '—'}
                        </span>
                      </li>
                      {i < list.length - 1 && <li aria-hidden className="border-border/40 mr-4 ml-10 border-t" />}
                    </Fragment>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Btn onClick={() => void undoBatch()} disabled={undoing || busy}>
              {undoing ? <Loader2 className="animate-spin" /> : <RotateCcw />} 撤销这批
            </Btn>
            <Btn primary onClick={() => void runReorg()} disabled={busy || undoing}>
              {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} 再跑一次
            </Btn>
            <p className="text-muted-foreground text-xs">
              共 <b className="text-foreground">{result.applied}</b> 项 · 全部记录在
              <button className="text-foreground hover:underline" onClick={onShowHistory}>
                版本历史
              </button>
            </p>
          </div>
        </>
      ) : (
        <>
          <ul className="mt-5 space-y-1.5">
            <li className="text-muted-foreground flex gap-2 text-[13px]">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
              只移动、不删除——任何书签都不会丢
            </li>
            <li className="text-muted-foreground flex gap-2 text-[13px]">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
              建议先完成失效检测与合并重复，让 AI 看到干净的库
            </li>
            <li className="text-muted-foreground flex gap-2 text-[13px]">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
              私密书签保持私密，不会被挪进公开目录
            </li>
          </ul>
          <div className="mt-5">
            <Btn primary onClick={() => void runReorg()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {busy ? '正在分析整理…' : '开始重分类'}
            </Btn>
          </div>
        </>
      )}
    </div>
  )
}

/** D43 敏感内容旁路入口（目录树底部、全库重分类下方）：点击后右栏切换为旁路面板 */
export function SensitiveButton({
  mobile = false,
  active = false,
  onClick,
}: {
  mobile?: boolean
  active?: boolean
  onClick: () => void
}) {
  const title = '把敏感站点书签自动标私密并移入「私人收藏」——不再外发，可整批撤销'
  return mobile ? (
    <TidyChip icon={ShieldOff} label="敏感内容旁路" title={title} onClick={onClick} />
  ) : (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'text-muted-foreground hover:bg-accent/50 hover:text-foreground mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors',
        active && 'bg-accent/60 font-medium text-foreground',
      )}
    >
      <ShieldOff className="size-3.5" /> 敏感内容旁路
    </button>
  )
}

/**
 * D43 敏感内容旁路面板（右栏内容区）：点了就跑——供应商审核整包拒收会让整理整批失败，
 * 命中项标私密 + 移入「私人收藏」后不再外发；结果直显，可整批撤销，也可在书签库开「显示私密」逐条复核。
 */
interface SensitiveResult {
  marked: number
  scanned: number
  versionId: string
}

export function SensitiveSection({
  onClose,
  onApplied,
  onShowHistory,
}: {
  onClose: () => void
  onApplied: () => void
  onShowHistory: () => void
}) {
  const { cfg, refreshBadges } = useShell()
  const [busy, setBusy] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [result, setResult] = useState<SensitiveResult | null>(null)

  const runSweep = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await apiCall<{ scanned: number; marked: number; versionId: string | null; folderName: string }>(
        cfg,
        '/tidy/sensitive',
        { method: 'POST' },
      )
      if (r.marked > 0 && r.versionId) {
        setResult({ marked: r.marked, scanned: r.scanned, versionId: r.versionId })
        tidyNotify.ok(`已标私密 ${r.marked} 条并移入「${r.folderName}」`)
        onApplied()
      } else {
        setResult(null)
        tidyNotify.ok('未发现需要旁路的敏感内容 ✅')
      }
      refreshBadges()
      window.dispatchEvent(new Event('mf:versions-changed'))
    } catch (e) {
      toast.err(`旁路失败：${e instanceof ApiError ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const undoBatch = async () => {
    if (!result || undoing) return
    setUndoing(true)
    try {
      const r = await apiCall<{ reversed: number }>(cfg, `/organize/rollback/${result.versionId}`, { method: 'POST' })
      tidyNotify.ok(`已还原 ${r.reversed} 项——私密标记与目录都回到原样`)
      setResult(null)
      onApplied()
      refreshBadges()
      window.dispatchEvent(new Event('mf:versions-changed'))
    } catch (e) {
      toast.err(`撤销失败：${e instanceof ApiError ? e.message : String(e)}`)
    } finally {
      setUndoing(false)
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold tracking-tight">敏感内容旁路</h3>
          <p className="text-muted-foreground mt-1 max-w-xl text-sm">
            {result
              ? `这一批 ${result.marked} 条已标私密并移入「私人收藏」——它们不再进入 AI 批次，随时可整批撤销。`
              : '扫描整个书签库，把敏感站点自动标私密并移入「私人收藏」——不外发给 AI、不进公开导航站；不做道德判断，只做工程规避。'}
          </p>
        </div>
        <button
          onClick={onClose}
          title="返回书签列表"
          className="text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded-lg p-1.5 transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>

      {result ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Btn onClick={() => void undoBatch()} disabled={undoing || busy}>
            {undoing ? <Loader2 className="animate-spin" /> : <RotateCcw />} 撤销这批
          </Btn>
          <Btn primary onClick={() => void runSweep()} disabled={busy || undoing}>
            {busy ? <Loader2 className="animate-spin" /> : <ShieldOff />} 再扫一次
          </Btn>
          <p className="text-muted-foreground text-xs">
            共扫描 <b className="text-foreground">{result.scanned}</b> 条 · 记录在
            <button className="text-foreground hover:underline" onClick={onShowHistory}>
              版本历史
            </button>
            ，可在书签库筛选行打开「显示私密」逐条复核
          </p>
        </div>
      ) : (
        <>
          <ul className="mt-5 space-y-1.5">
            <li className="text-muted-foreground flex gap-2 text-[13px]">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
              标私密 + 移入「私人收藏」，只移动不删除（红线③），全程可撤销
            </li>
            <li className="text-muted-foreground flex gap-2 text-[13px]">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
              旁路后这些条目不再进入 AI 批次——整理/摘要不会再被供应商审核整包拒收
            </li>
            <li className="text-muted-foreground flex gap-2 text-[13px]">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
              默认视图会隐藏私密项；在书签库筛选行打开「显示私密」即可复核与逐条还原
            </li>
          </ul>
          <div className="mt-5">
            <Btn primary onClick={() => void runSweep()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <ShieldOff />}
              {busy ? '正在扫描…' : '扫描并旁路'}
            </Btn>
          </div>
        </>
      )}
    </div>
  )
}

/** 版本历史面板（右栏内容区）：整理的唯一安全面；撤销 = 逆放 diff 生成新版本，历史永不删除（红线③） */
export function HistorySection({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const { cfg, refreshBadges } = useShell()
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const rollingBack = useRef(false)
  const pageSize = 10

  const load = useCallback(() => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    void apiCall<{ versions: VersionRow[]; total: number }>(
      cfg, `/organize/versions?limit=${pageSize}&offset=${(page - 1) * pageSize}`, { signal: controller.signal },
    ).then(r => {
      if (controller.signal.aborted) return
      setTotal(r.total)
      const last = Math.max(1, Math.ceil(r.total / pageSize))
      if (page > last) setPage(last)
      else setVersions(r.versions)
      setError('')
    }).catch(e => {
      if (!controller.signal.aborted) setError(`版本记录暂时未更新：${e instanceof Error ? e.message : String(e)}`)
    }).finally(() => {
      if (request.current === controller) setLoading(false)
    })
  }, [cfg, page])

  useEffect(() => {
    load()
    const h = () => load()
    window.addEventListener('mf:versions-changed', h)
    return () => {
      request.current?.abort()
      window.removeEventListener('mf:versions-changed', h)
    }
  }, [load])
  useServerChanges(load)

  async function rollback(v: VersionRow) {
    if (rollingBack.current) return
    rollingBack.current = true
    setBusy(true)
    try {
      const r = await apiCall<{ reversed: number; pending?: boolean }>(cfg, `/organize/rollback/${v.id}`, { method: 'POST' })
      if (r.pending) {
        // D92：任务仍在进行——已请求停止，撤销会在在途提交排空后执行（可在整理记录里查看）
        toast.info('已请求停止这次整理并撤销，稍后会在这里更新')
      } else if (r.reversed > 0) tidyNotify.ok(`已撤销 ${r.reversed} 项（生成新版本，历史永不删除）`)
      else toast.info('条目已有其他改动，本次没有覆盖')
      load()
      onApplied()
      refreshBadges()
      window.dispatchEvent(new Event('mf:versions-changed'))
    } catch (e) {
      toast.err(`撤销失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      rollingBack.current = false
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold tracking-tight">版本历史</h3>
          <p className="text-muted-foreground mt-1 max-w-xl text-sm">
            每次整理都记为一个版本；撤销 = 逆放 diff 生成新版本，历史永不删除，浏览器书签树同步回移。
          </p>
        </div>
        <button
          onClick={onClose}
          title="返回书签列表"
          className="text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded-lg p-1.5 transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>

      {error && <p className="text-muted-foreground mt-3 text-xs" role="status">{error}</p>}
      {versions.length === 0 ? (
        <p className="text-muted-foreground mt-6 text-sm">
          {loading ? '正在读取版本记录…' : error ? '记录读取失败，请稍后重试。' : '还没有整理记录——自动归位或整理后，这里就会出现记录。'}
        </p>
      ) : (
        <div className="relative mt-5 pl-4" aria-busy={loading}>
          <div className="bg-border absolute top-1 bottom-1 left-[5px] w-px" aria-hidden="true" />
          <ol className="flex flex-col gap-3">
          {versions.map((v, i) => (
            <li key={v.id} className="relative">
              <span
                aria-hidden="true"
                className={cn(
                  'border-card absolute top-2 -left-4 size-2.5 rounded-full border-2',
                  v.reverted > 0 ? 'bg-muted-foreground/40' : i === 0 && page === 1 ? 'bg-primary' : 'bg-primary/40',
                )}
              />
              <div className={cn('data-row rounded-xl px-2 py-1.5', i === 0 && page === 1 && v.reverted === 0 && 'bg-primary/5')}>
                <p className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <span className="min-w-0 flex-1 truncate">
                    {v.label === 'material_convert'
                      ? v.kind === 'undo' ? '重新收入资料库' : '自动收入资料库'
                      : v.label === 'organize_task'
                        // D92：目录整理任务的批次（整次撤销在「整理记录」里，这里也可单批撤销）
                        ? v.kind === 'undo' ? '撤销目录整理' : '目录整理' + (v.task_batch ? ` · 第 ${v.task_batch} 批` : '')
                      : v.kind === 'undo' ? '撤销操作' : v.kind === 'apply' ? '自动整理' : v.kind || '整理'}
                  </span>
                  {i === 0 && page === 1 && v.reverted === 0 && <Badge className="px-1.5 py-0">最新</Badge>}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {v.actionCount} 项 · {timeAgo(v.created_at)}
                  {v.reverted > 0 && ' · 已撤销'}
                </p>
                {v.reverted === 0 && (
                  <Btn
                    size="xs"
                    className="mt-1.5"
                    disabled={busy || loading}
                    onClick={() => void rollback(v)}
                    title="逆放这次变更（生成新版本，保留后续手动改动）"
                  >
                    {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />} 撤销这次处理
                  </Btn>
                )}
              </div>
            </li>
          ))}
          </ol>
        </div>
      )}
      <NumberedPagination page={page} total={total} pageSize={pageSize} onPageChange={setPage} disabled={loading || busy} label="版本历史分页" />
    </div>
  )
}

/** 功能按钮：圆角 pill，徽标琥珀色仅语义标注 */
function TidyChip({
  icon: Icon,
  label,
  badge,
  title,
  busy,
  disabled,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  badge?: string
  title?: string
  busy?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      className="bg-muted/60 hover:bg-accent text-foreground inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-55"
    >
      <Icon className="size-3.5" />
      {label}
      {badge && <span className="text-[10.5px] font-normal text-amber-600 dark:text-amber-400">{badge}</span>}
      {busy && <Loader2 className="size-3 animate-spin" />}
    </button>
  )
}
