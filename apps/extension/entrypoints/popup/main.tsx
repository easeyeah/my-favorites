/**
 * popup · 一键收藏 + 收纳盒管理（2026-11-20 单面化定稿，替代 ptabs 标签制）
 *
 * 用户拍板：就留一个按钮 + 一个页面信息——
 *  · 顶部仅一条品牌栏（图形标 + ⚙ 设置），无页签；
 *  · 页面信息（真实站点图标 + 标题 + host）在最上；
 *  · 其他信息一律沉到下方滚动区，且「有才显示」：收纳盒待处理 / 最近自动归位（可撤销）/ 整理版本；
 *  · 唯一主按钮固定底部，颜色弱化为浅靛底深靛字（用户：原实色太强烈）；快照/备注/改目录收进按钮上方「更多」。
 * 与浏览器融合：贴边交由原生气泡裁切；定高 320×518（黄金比），切内容窗体不跳。
 *
 * 收藏语义不变（D37/D27）：A=缓存命中「收藏到「X」」；B=未命中「交给 AI 归位」先落收纳盒异步分类；
 * 隐私域名仅存 URL 手动选目录；D42 起无聊天面，歧义处理在收纳盒条目内。
 */
import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { browser } from 'wxt/browser'
import {
    api,
    getConfig,
    type FolderDto,
    type InboxItemDto,
    type InboxPlacedDto,
    type SuggestDto,
    type VersionDto,
} from '../../src/lib/api'
import './popup.css'

function hostOf(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, '')
    } catch {
        return url
    }
}

function Popup() {
    const [tabInfo, setTabInfo] = useState<chrome.tabs.Tab | null>(null)
    const [suggest, setSuggest] = useState<SuggestDto | null>(null)
    // false=正常；字符串=被隐私策略拦截的原因码（区分「命中清单」与「规则未加载」，不误标用户网站为隐私站）
    const [privacy, setPrivacy] = useState<false | 'privacy_domain' | 'private_bookmark' | 'policy_not_loaded'>(false)
    const privacyReason = (r: string): typeof privacy =>
        r === 'privacy_domain' || r === 'private_bookmark' || r === 'policy_not_loaded' ? r : 'policy_not_loaded'
    const [folders, setFolders] = useState<FolderDto[]>([])
    const [folderChoice, setFolderChoice] = useState<string>('')
    // 站点图标加载失败（内网页/坏链接）时回退首字母色块
    const [iconOk, setIconOk] = useState(true)
    const [snapshotOn, setSnapshotOn] = useState(true)
    const [note, setNote] = useState('')
    const [status, setStatus] = useState('')
    const [busy, setBusy] = useState(false)

    const [inboxItems, setInboxItems] = useState<InboxItemDto[]>([])
    const [placed, setPlaced] = useState<InboxPlacedDto[]>([])
    const [versions, setVersions] = useState<VersionDto[]>([])
    const [deviceId, setDeviceId] = useState<string>('')

    const flash = (t: string) => {
        setStatus(t)
        setTimeout(() => setStatus(''), 3500)
    }

    const loadInbox = useCallback(() => {
        void api<{ items: InboxItemDto[]; placed: InboxPlacedDto[]; ambiguousCount: number }>('/inbox/items', {})
            .then(r => {
                setInboxItems(r.items)
                setPlaced(r.placed)
            })
            .catch(() => undefined)
    }, [])

    useEffect(() => {
        void (async () => {
            const [t, cfg, dv] = await Promise.all([
                browser.tabs.query({ active: true, currentWindow: true }).then(([x]) => x ?? null),
                getConfig(),
                import('../../src/lib/device').then(m => m.getDeviceId()),
            ])
            setTabInfo(t)
            setIconOk(true)
            setDeviceId(dv)
            void browser.storage.local.get(['snapshotDefault']).then(s => setSnapshotOn(s['snapshotDefault'] !== false))
            if (t?.url && /^https?:/.test(t.url)) {
                setPrivacy(
                    await decidePrivacySafe('read_content', t.url)
                        .then(d => (d.allowed ? false : privacyReason(d.reason)))
                        // 判定本身出错也必须走保守侧：视为规则未加载，仅存 URL
                        .catch(() => 'policy_not_loaded' as const),
                )
                void api<SuggestDto>('/pipeline/suggest', {
                    method: 'POST',
                    body: JSON.stringify({ url: t.url, title: t.title ?? '' }),
                })
                    .then(setSuggest)
                    .catch(() => setSuggest(null))
            }
            void api<FolderDto[]>('/folders', {})
                .then(setFolders)
                .catch(() => undefined)
            loadInbox()
            refreshVersions()
        })()
    }, [loadInbox])

    const refreshVersions = () => {
        void api<{ versions: VersionDto[] }>('/organize/versions', {})
            .then(r => setVersions(r.versions.slice(0, 8)))
            .catch(() => undefined)
    }

    const send = (type: string, okText: string, dupText: string) => {
        setStatus('处理中…')
        void browser.runtime.sendMessage({ type }, (res: { saved: boolean } | undefined) => {
            setStatus(res?.saved ? okText : res?.saved === false ? dupText : '失败：请检查服务端设置')
            setTimeout(() => setStatus(''), 3000)
        })
    }

    /** 变体 A：收藏到 AI 建议目录（或用户改选的目录）+ 快照开关 + 备注 */
    const saveToFolder = (folderId: string) => {
        if (!folderId) return
        setBusy(true)
        setStatus('收藏中…')
        void browser.runtime.sendMessage(
            { type: 'save-current', folderId, note: note || undefined, snapshot: snapshotOn },
            (res: { saved?: boolean; folderName?: string; error?: string } | undefined) => {
                setBusy(false)
                setStatus(
                    res?.error
                        ? `❌ 收藏失败：${res.error.slice(0, 60)}`
                        : res?.saved
                          ? `✅ 已收藏到 ${res.folderName ?? '目标目录'}${snapshotOn ? ' · 📸 快照已保存' : ''}`
                          : res
                            ? '已收藏过（未重复）'
                            : '❌ 收藏失败：后台无响应（服务端不可达？）',
                )
                setTimeout(() => setStatus(''), 3500)
            },
        )
    }

    /** 手动选目录（收纳盒条目 assign；隐私条目可按域名记忆） */
    const assign = (bookmarkId: string, folderId: string, rememberDomain = false) => {
        void api('/inbox/assign', {
            method: 'POST',
            body: JSON.stringify({ bookmarkId, folderId, deviceId, rememberDomain }),
        })
            .then(() => {
                flash('✅ 已归位')
                loadInbox()
            })
            .catch((err: unknown) => flash(`❌ 归位失败：${String(err).slice(0, 60)}`))
    }

    const retry = (bookmarkId: string) => {
        void api('/inbox/retry', { method: 'POST', body: JSON.stringify({ bookmarkId, deviceId }) })
            .then(() => {
                flash('已重新排队处理')
                setTimeout(loadInbox, 1200)
            })
            .catch((err: unknown) => flash(`❌ 重试失败：${String(err).slice(0, 60)}`))
    }

    const rollback = (versionId: string, word: string) => {
        void api<{ reversed: number }>(`/organize/rollback/${versionId}`, { method: 'POST' })
            .then(r => {
                flash(`↩️ ${word} ${r.reversed} 项`)
                loadInbox()
                refreshVersions()
            })
            .catch((err: unknown) => flash(`❌ ${word}失败：${String(err).slice(0, 60)}`))
    }

    const folderOptions = folders.filter(f => f.is_system_inbox !== 1)
    const suggestFolder = suggest?.folderId ?? ''
    const hit = suggest && suggest.source !== 'none' && suggestFolder
    const currentUrl = tabInfo?.url ?? ''
    const savable = /^https?:/.test(currentUrl)
    // 唯一主按钮的目标与文案：手动改选 > AI 建议 > 无（走收纳盒异步）
    const targetId = folderChoice || (hit ? suggestFolder : '')
    const targetName =
        folders.find(f => f.id === folderChoice)?.name ??
        (hit ? suggest!.folderPath.join(' / ') || suggest!.category : '')

    return (
        <main className="flex h-[518px] w-[320px] flex-col pb-3">
            {/* 顶栏：品牌标 + 设置（页签制已取消） */}
            <header className="flex shrink-0 items-center px-4 pb-1 pt-3">
                <img src="/brand/mark-color.svg" alt="" aria-hidden draggable={false} className="size-5 shrink-0" />
                <h1 className="sr-only">my-favorites</h1>
                <button
                    className="ml-auto rounded-md px-1.5 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
                    title="设置"
                    onClick={() => void browser.tabs.create({ url: 'options.html' })}
                >
                    ⚙
                </button>
            </header>

            {/* 页面信息 */}
            <section className="shrink-0 px-4 pt-1">
                <div className="flex items-start gap-2.5">
                    {tabInfo?.favIconUrl && iconOk ? (
                        /* 站点真实图标（tabs 权限下 Tab.favIconUrl 现成可得） */
                        <img
                            src={tabInfo.favIconUrl}
                            alt=""
                            draggable={false}
                            onError={() => setIconOk(false)}
                            className="size-8 shrink-0 rounded-lg bg-neutral-100 object-contain p-1 dark:bg-neutral-800"
                        />
                    ) : (
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-sm font-bold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300">
                            {(tabInfo?.title?.trim()[0] ?? '?').toUpperCase()}
                        </span>
                    )}
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold">{tabInfo?.title ?? '…'}</div>
                        <div className="truncate font-mono text-[11px] text-neutral-400">{hostOf(currentUrl)}</div>
                    </div>
                </div>
                {privacy ? (
                    <p className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-[11px] text-red-700 dark:bg-red-950 dark:text-red-300">
                        🛡{' '}
                        {privacy === 'policy_not_loaded'
                            ? '隐私规则未同步 · 仅存 URL'
                            : '隐私域名 · 仅存 URL，手动选目录'}
                    </p>
                ) : (
                    !savable && (
                        <p className="mt-2 text-[11px] text-neutral-400">当前页不支持收藏（chrome:// 等系统页）</p>
                    )
                )}
            </section>

            {/* 其他信息沉底：有才显示 */}
            <div className="scroll-slim mt-3 flex-1 overflow-y-auto px-4">
                {inboxItems.length > 0 && (
                    <section className="mb-3">
                        <p className="mb-1 text-[11px] text-neutral-400">
                            收纳盒 · {inboxItems.length} 条 · AI 自动归位，拿不准才问你
                        </p>
                        <ul className="divide-y divide-neutral-100 text-xs dark:divide-neutral-800">
                            {inboxItems.map(it => (
                                <li key={it.id} className="py-2">
                                    <div className="truncate font-medium">{it.title}</div>
                                    <div className="mt-0.5 truncate text-[11px] text-neutral-400">
                                        {hostOf(it.url_canonical)}
                                    </div>
                                    {it.state === 'pending' && (
                                        <p className="mt-1 text-[11px] text-neutral-400">
                                            ⏳ AI 自动归位中（丢入即触发，最迟 1 分钟兜底）
                                        </p>
                                    )}
                                    {it.state === 'retry' && (
                                        <p className="mt-1 flex items-center gap-2 text-[11px] text-amber-600">
                                            暂不可用 · 第 {it.attempts + 1}/5 次
                                            <button
                                                className="rounded-md bg-neutral-100 px-1.5 py-0.5 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                                                onClick={() => retry(it.id)}
                                            >
                                                重试
                                            </button>
                                        </p>
                                    )}
                                    {it.state === 'ambiguous' && (
                                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                            {it.suggestCategory && (
                                                <span className="text-[11px] text-amber-600">
                                                    AI 倾向「{it.suggestCategory}」
                                                </span>
                                            )}
                                            <select
                                                className="rounded-md border px-1.5 py-1 text-[11px] dark:border-neutral-700"
                                                value=""
                                                onChange={e =>
                                                    e.target.value && assign(it.id, e.target.value, it.is_private === 1)
                                                }
                                            >
                                                <option value="">选目录归位…</option>
                                                {folderOptions.map(f => (
                                                    <option key={f.id} value={f.id}>
                                                        {f.name}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    )}
                                    {it.state === 'privacy_hold' && (
                                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                            <span className="text-[11px] text-red-600">🛡 仅存 URL</span>
                                            <select
                                                className="rounded-md border px-1.5 py-1 text-[11px] dark:border-neutral-700"
                                                value=""
                                                onChange={e => e.target.value && assign(it.id, e.target.value, true)}
                                            >
                                                <option value="">手动选目录…</option>
                                                {folderOptions.map(f => (
                                                    <option key={f.id} value={f.id}>
                                                        {f.name}
                                                    </option>
                                                ))}
                                            </select>
                                            {folderOptions.length > 0 && (
                                                <button
                                                    className="rounded-md bg-neutral-100 px-1.5 py-1 text-[11px] hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                                                    title={`按域名记忆：${hostOf(it.url_canonical)} 以后自动进「${folderOptions[0]!.name}」`}
                                                    onClick={() =>
                                                        assign(
                                                            it.id,
                                                            it.domainRuleFolderId ?? folderOptions[0]!.id,
                                                            true,
                                                        )
                                                    }
                                                >
                                                    按域名记忆
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {placed.length > 0 && (
                    <section className="mb-3">
                        <p className="mb-1 text-[11px] text-neutral-400">最近自动归位</p>
                        <ul className="space-y-1 text-xs">
                            {placed.map(p => (
                                <li
                                    key={p.bookmark_id}
                                    className="flex items-center gap-2 rounded-lg bg-neutral-100 px-2 py-1.5 dark:bg-neutral-800"
                                    title={p.reason ?? undefined}
                                >
                                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                                    {p.folder_name && (
                                        <span className="shrink-0 text-[10px] text-neutral-500 dark:text-neutral-300">
                                            →「{p.folder_name}」
                                        </span>
                                    )}
                                    <span className="shrink-0 text-[10px] text-neutral-400">{p.reason}</span>
                                    {p.version_id && (
                                        <button
                                            className="shrink-0 rounded-md bg-white px-1.5 py-0.5 text-[10px] hover:bg-neutral-50 dark:bg-neutral-600 dark:hover:bg-neutral-500"
                                            onClick={() => rollback(p.version_id!, '已撤销')}
                                        >
                                            撤销
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {versions.length > 0 && (
                    <section className="mb-3">
                        <p className="mb-1 text-[11px] text-neutral-400">整理版本（历史永不删除，可回滚）</p>
                        <ul className="space-y-1 text-[11px] text-neutral-500">
                            {versions.slice(0, 3).map(v => (
                                <li key={v.id} className="flex items-center gap-2">
                                    <span className="min-w-0 flex-1 truncate">
                                        {v.kind === 'undo' ? '撤销' : v.session_id ? '整理' : '自动归位'} ·{' '}
                                        {v.actionCount} 项 · {v.created_at.slice(5, 16).replace('T', ' ')}
                                    </span>
                                    {v.reverted === 0 && (
                                        <button
                                            className="shrink-0 rounded-md px-1.5 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                                            onClick={() => rollback(v.id, '已回滚')}
                                        >
                                            回滚
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {inboxItems.length === 0 && placed.length === 0 && versions.length === 0 && (
                    <p className="pt-4 text-center text-[11px] text-neutral-400">一切就绪——收藏后 AI 在后台自动整理</p>
                )}
            </div>

            {/* 底部固定：唯一主按钮（弱化为浅靛底深靛字）+ 低频「更多」 */}
            <footer className="shrink-0 px-4 pt-2">
                {status && <p className="mb-1.5 text-center text-xs text-emerald-600">{status}</p>}
                {privacy && savable && (
                    <select
                        className="mb-2 w-full rounded-lg border px-2 py-1.5 text-xs dark:border-neutral-700"
                        value={folderChoice}
                        onChange={e => setFolderChoice(e.target.value)}
                    >
                        <option value="">选择目录…</option>
                        {folderOptions.map(f => (
                            <option key={f.id} value={f.id}>
                                {f.name}
                            </option>
                        ))}
                    </select>
                )}
                {savable && !privacy && (
                    <details className="mb-2 text-xs text-neutral-500">
                        <summary className="list-none cursor-pointer text-[11px] text-neutral-400 [&::-webkit-details-marker]:hidden">
                            更多 · 快照{snapshotOn ? '开' : '关'}
                            {note ? ' · 已写备注' : ''}
                            {hit ? ' · 可改目录' : ''}
                        </summary>
                        {hit && (
                            <select
                                className="mb-2 w-full rounded-lg border px-2 py-1.5 text-xs dark:border-neutral-700"
                                value={folderChoice}
                                onChange={e => setFolderChoice(e.target.value)}
                            >
                                <option value="">收藏目录：跟随 AI 建议「{targetName}」</option>
                                {folderOptions.map(f => (
                                    <option key={f.id} value={f.id}>
                                        改存「{f.name}」
                                    </option>
                                ))}
                            </select>
                        )}
                        <label className="flex items-center justify-between">
                            同时保存页面快照（防失效回看）
                            <input
                                type="checkbox"
                                checked={snapshotOn}
                                onChange={e => {
                                    setSnapshotOn(e.target.checked)
                                    void browser.storage.local.set({ snapshotDefault: e.target.checked })
                                }}
                            />
                        </label>
                        <input
                            className="mt-2 w-full rounded-lg border px-2 py-1.5 text-xs dark:border-neutral-700"
                            placeholder="备注——为什么收藏它？"
                            value={note}
                            onChange={e => setNote(e.target.value)}
                        />
                        {hit && (
                            <button
                                className="mt-2 w-full rounded-lg bg-neutral-100 px-3 py-1.5 text-xs hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                                onClick={() => send('save-to-inbox', '已放入收纳盒', '已收藏过')}
                            >
                                不想了，先丢收纳盒
                            </button>
                        )}
                        {/* 管理台入口（低频折叠区）：深度整理/版本/发布都在管理台，深链到概览 */}
                        <a
                            className="mt-2 block cursor-pointer text-center text-[11px] text-neutral-400 hover:text-indigo-600 dark:hover:text-indigo-400"
                            onClick={() => {
                                void getConfig().then(c =>
                                    browser.tabs.create({ url: `${c.serverUrl.replace(/\/$/, '')}/#overview` }),
                                )
                                window.close()
                            }}
                        >
                            打开管理台 ↗
                        </a>
                    </details>
                )}
                <button
                    className="w-full rounded-lg bg-indigo-100 px-3 py-2.5 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-200 disabled:opacity-40 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:bg-indigo-900"
                    disabled={!savable || busy || (privacy !== false && !folderChoice)}
                    title={hit ? `AI 建议 · 缓存命中：${targetName}` : 'AI 将读取页面自动分类，拿不准才会问你'}
                    onClick={() =>
                        targetId
                            ? void saveToFolder(targetId)
                            : send('save-to-inbox', '已放入收纳盒，AI 分类中…', '已收藏过')
                    }
                >
                    {busy
                        ? '收藏中…'
                        : !savable
                          ? '✓ 收藏（此页不支持）'
                          : privacy !== false
                            ? '✓ 收藏'
                            : targetId
                              ? `✓ 收藏到「${targetName}」`
                              : '✓ 收藏，交给 AI 归位'}
                </button>
            </footer>
        </main>
    )
}

// decidePrivacy 由 background/lib 导出（popup 里做本地前置判定）
async function decidePrivacySafe(action: 'read_content', url: string) {
    const { decidePrivacy } = await import('../../src/lib/privacy')
    return decidePrivacy(action, url)
}

createRoot(document.getElementById('root')!).render(<Popup />)
