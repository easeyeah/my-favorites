/**
 * 快照查看器（原型 08 · F2.4 一键快照）：链接失效后的回看出口
 *
 * 布局骨架统一（D26 配套规则）：扩展端所有「整页打开」的页面共用同一左侧主菜单壳
 * （快照查看 / 版本历史 / 书签详情 / 扩展设置），窄容器（popup/侧栏）用顶部标签页。
 *
 * 边界（红线④）：快照仅用户私有可见；公开导航站只显示「📸 有快照」状态标识，永不展示内容。
 * 渲染：GET /snapshots/:id/view 净化视图（A4-4）入 iframe（srcdoc），原页样式随原页而定。
 * 版本切换：顶部 tab（D37 收口）；时间轴对比视图 Later。
 * 入口：?bookmarkId=xxx（书签详情/周报联动）或 ?snapshotId=xxx（直接跳转）。
 */
import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, getConfig } from '../../src/lib/api'
import { BrandHeader } from '../../src/components/skeleton'
import './panel.css'

interface SnapRow {
    id: string
    created_at: string
    size: number
    via: string
}

interface BookmarkDto {
    id: string
    title: string
    url_canonical: string
    status: string
}

const NAV_ITEMS = [
    { key: 'snap', label: '📸 快照查看' },
    { key: 'settings', label: '⚙️ 扩展设置' },
] as const

function fmtSize(bytes: number): string {
    return bytes > 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function fmtTime(iso: string): string {
    return iso.slice(0, 10)
}

function Viewer() {
    const [nav, setNav] = useState<(typeof NAV_ITEMS)[number]['key']>('snap')
    const [bookmark, setBookmark] = useState<BookmarkDto | null>(null)
    const [snaps, setSnaps] = useState<SnapRow[]>([])
    const [active, setActive] = useState<string | null>(null)
    const [viewHtml, setViewHtml] = useState<string>('')
    const [error, setError] = useState('')

    const params = new URLSearchParams(location.search)
    const bookmarkId = params.get('bookmarkId') ?? ''

    const load = useCallback(() => {
        if (!bookmarkId) {
            setError('缺少书签参数（?bookmarkId=…）——从书签详情或维护报告进入')
            return
        }
        void api<BookmarkDto>(`/bookmarks/${bookmarkId}`, {})
            .then(b => {
                setBookmark({ id: b.id, title: b.title, url_canonical: b.url_canonical, status: b.status })
            })
            .catch(e => setError(String(e)))
        void api<{ snapshots: SnapRow[] }>(`/snapshots?bookmarkId=${encodeURIComponent(bookmarkId)}`, {})
            .then(r => {
                setSnaps(r.snapshots)
                setActive(r.snapshots[0]?.id ?? null)
            })
            .catch(e => setError(String(e)))
    }, [bookmarkId])

    useEffect(load, [load])

    // 净化视图拉取（HTML 响应 → iframe srcdoc；A4-4 已做脚本净化，sandbox 双保险）
    useEffect(() => {
        if (!active) return
        void (async () => {
            try {
                const { serverUrl, token } = await getConfig()
                const res = await fetch(`${serverUrl}/api/v1/snapshots/${active}/view`, {
                    headers: token ? { authorization: `Bearer ${token}` } : {},
                })
                setViewHtml(res.ok ? await res.text() : '')
            } catch {
                setViewHtml('')
            }
        })()
    }, [active])

    return (
        <main className="flex min-h-screen bg-neutral-50 dark:bg-neutral-950">
            {/* 左侧主菜单壳（与 options 同壳：整页打开的页面共用骨架） */}
            <aside className="w-52 shrink-0 border-r border-neutral-200 bg-neutral-100 p-3 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="mb-3 px-2">
                    <BrandHeader compact />
                </div>
                {NAV_ITEMS.map(n => (
                    <button
                        key={n.key}
                        onClick={() => (n.key === 'settings' ? (location.href = 'options.html') : setNav(n.key))}
                        className={
                            'mb-0.5 w-full rounded-lg px-3 py-2 text-left text-sm ' +
                            (nav === n.key
                                ? 'bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                                : 'text-neutral-600 hover:bg-white dark:text-neutral-300 dark:hover:bg-neutral-800')
                        }
                    >
                        {n.label}
                    </button>
                ))}
                {bookmark && (
                    <div className="mt-4 rounded-lg bg-white p-2.5 text-[11px] text-neutral-500 shadow-sm dark:bg-neutral-800">
                        {bookmark.title}
                        <div className="mt-1">
                            📸 {snaps.length} 个版本 · {fmtSize(snaps.reduce((n, s) => n + s.size, 0))}
                        </div>
                    </div>
                )}
                <button
                    className="mt-3 w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-500 hover:bg-white dark:hover:bg-neutral-800"
                    onClick={() => history.back()}
                >
                    ← 返回
                </button>
            </aside>

            {/* 主区 */}
            <section className="min-w-0 flex-1 p-5">
                {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950">{error}</p>}
                {bookmark && (
                    <div className="mb-4 rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                        <div className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-semibold">
                                    {bookmark.title}{' '}
                                    {bookmark.status === 'dead' && (
                                        <span className="ml-1 rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-600 dark:bg-red-950">
                                            原页已失效
                                        </span>
                                    )}
                                </div>
                                <div className="truncate font-mono text-xs text-neutral-400">
                                    {bookmark.url_canonical}
                                </div>
                            </div>
                            <a
                                className="rounded-lg border px-2.5 py-1 text-xs"
                                href={bookmark.url_canonical}
                                target="_blank"
                                rel="noreferrer"
                            >
                                🌐 尝试打开原网页
                            </a>
                        </div>
                        {snaps.length > 0 && (
                            <div className="mt-3 flex items-center gap-2">
                                {snaps.map((s, i) => (
                                    <button
                                        key={s.id}
                                        onClick={() => setActive(s.id)}
                                        className={
                                            'rounded-full px-3 py-1 text-xs ' +
                                            (active === s.id
                                                ? 'bg-neutral-900 font-semibold text-white dark:bg-neutral-100 dark:text-neutral-900'
                                                : 'border text-neutral-500')
                                        }
                                    >
                                        v{snaps.length - i} · {fmtTime(s.created_at)}
                                        {i === 0 ? '（最新）' : ''}
                                    </button>
                                ))}
                                <span className="ml-2 text-[11px] text-neutral-400">
                                    MHTML · {fmtSize(snaps.find(s => s.id === active)?.size ?? 0)} ·
                                    来源：扩展端就地捕获
                                </span>
                                <span className="ml-auto rounded bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-400 dark:bg-neutral-800">
                                    仅你可见 · 公开导航站永不展示
                                </span>
                            </div>
                        )}
                    </div>
                )}

                {snaps.length === 0 && !error && bookmark && (
                    <div className="rounded-2xl border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-400 dark:border-neutral-700">
                        该书签还没有快照——在原页可达时用 popup「📸 一键快照」补拍。
                    </div>
                )}

                {viewHtml && (
                    <div>
                        <p className="mb-1 rounded-t-lg bg-neutral-100 px-3 py-1.5 text-[11px] text-neutral-500 dark:bg-neutral-800">
                            📄 以下为快照原文 · 净化视图渲染——这一区域是「当时的原网页」，不是产品界面
                        </p>
                        <iframe
                            title="快照内容"
                            srcDoc={viewHtml}
                            className="h-[70vh] w-full rounded-b-lg border border-neutral-200 bg-white dark:border-neutral-800"
                            sandbox=""
                        />
                    </div>
                )}
            </section>
        </main>
    )
}

createRoot(document.getElementById('root')!).render(<Viewer />)
