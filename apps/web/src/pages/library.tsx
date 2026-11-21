/**
 * 书签 / 收纳盒（树形管理器）：左目录树 + 右书签列表 + 右侧详情抽屉。
 * 比浏览器默认书签管理更好用的点：目录计数与失效状态一目了然、
 * 行内新建/重命名目录、书签行直接拖到目录树归位、全文搜索、收纳盒 AI 归位。
 * 隐私条目显示「🛡 仅元数据」徽章（红线②）；删除永不自动执行（红线③）。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
    Archive,
    ArchiveRestore,
    BookMarked,
    Check,
    ChevronRight,
    Folder,
    FolderOpen,
    FolderInput,
    FolderPlus,
    Loader2,
    Pencil,
    Plus,
    Search,
    ShieldCheck,
    Sparkles,
    Trash2,
    X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
    Btn,
    EmptyState,
    PageScroll,
    SiteIcon,
    StatusBadge,
    fmtDate,
    hostOf,
    libraryAge,
    RowsSkeleton,
    toast,
} from '@/components/shared'
import { CheckupSection, DupSection, HistorySection, HistoryTrigger, ReorgButton, ReorgSection } from '@/components/TidyPanel'
import { useRoute, useShell } from '@/components/layout'
import {
    ApiError,
    apiCall,
    fetchers,
    type Bookmark,
    type BookmarkDetail,
    type FolderTreeNode,
    type LinkCheckReport,
    type InboxPlaced,
} from '@/lib/api'
import { cn } from '@/lib/utils'

const PAGE = 100

// 收纳盒显示名唯一出口（E2E inbox-label.spec 回归锁死）：数据层目录名已固化「📥 收纳盒」（D36），
// mock 演示数据为裸「收纳盒」——先剥前导图标（含历史脏数据的多层重复），再统一补恰好一个。
// 新增渲染点禁止手拼 `📥 ${name}`，一律调用本函数。
const inboxLabel = (name: string): string => `📥 ${name.replace(/^(?:\u{1F4E5}\s*)+/u, "")}`

type StatusFilter = 'all' | 'dead' | 'normal' | 'archived' | 'duplicate'
// 「正常」不设筛选：全部 vs 正常 只差那几条坏链接，而坏链接正是需要看见的（有圆点标记 + 自动化动态播报），
// 藏起来是负价值；要清理走「失效」。normal 保留在类型里（API 兼容），仅不出现筛选入口。
const STATUS_CHIPS: Array<[StatusFilter, string]> = [
    ['all', '全部'],
    ['dead', '失效'],
    ['duplicate', '重复'],
    ['archived', '已归档'],
]

// 内部枚举 → 人话（界面不裸露枚举值）
const FETCH_VIA_LABEL: Record<string, string> = {
    server_crawl: '服务端抓取',
    'server-crawl': '服务端抓取',
    extension_capture: '扩展就地捕获',
}
const fetchViaLabel = (v: string) => FETCH_VIA_LABEL[v] ?? v

export function Library() {
    const { cfg, refreshBadges } = useShell()
    const routeQ = useRoute().params.get('q') ?? ''
    const [tree, setTree] = useState<FolderTreeNode[]>([])
    const [items, setItems] = useState<Bookmark[] | null>(null)
    const [selected, setSelected] = useState<string | 'all'>('all')
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
    // 全库重分类 / 版本历史：激活时右栏列表区切换为对应面板（互斥）
    const [reorgActive, setReorgActive] = useState(false)
    const [historyActive, setHistoryActive] = useState(false)
    const activateReorg = () => {
        setReorgActive(v => !v)
        setHistoryActive(false)
    }
    const activateHistory = () => {
        setHistoryActive(v => !v)
        setReorgActive(false)
    }
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    // 展开态写 localStorage 记忆（刷新/重进恢复，见下方默认展开 effect）
    const updateExpanded = (next: Set<string>) => {
        setExpanded(next)
        localStorage.setItem('mf-tree-expanded', JSON.stringify([...next]))
    }
    const [q, setQ] = useState('')
    const [searching, setSearching] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const [detail, setDetail] = useState<BookmarkDetail | null>(null)
    const [detailId, setDetailId] = useState<string | null>(null)
    // 原型 11 详情抽屉：快照版本列表（原型 08：失效≠丢失，「失效→有出路」闭环）
    const [detailSnaps, setDetailSnaps] = useState<Array<{ id: string; created_at: string; size: number }>>([])
    const [detailLoading, setDetailLoading] = useState(false)
    const [pendingDelete, setPendingDelete] = useState<Bookmark | null>(null)
    // ---- 多选批量（框选 / 复选框 / 目录多选）----
    const [checked, setChecked] = useState<Set<string>>(new Set())
    const [multiFolders, setMultiFolders] = useState<Set<string>>(new Set())
    const [batchMoveOpen, setBatchMoveOpen] = useState(false)
    const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
    const [batchTarget, setBatchTarget] = useState('')
    const suppressRowClick = useRef(false)
    const listWrapRef = useRef<HTMLDivElement | null>(null)
    const anchorFolder = useRef<string | null>(null)
    const [addOpen, setAddOpen] = useState(false)
    // ---- D52 编辑：详情面板内联编辑表单 + 列表行右键菜单 ----
    const [editing, setEditing] = useState(false)
    const [editForm, setEditForm] = useState({ title: '', url: '', description: '' })
    const [savingEdit, setSavingEdit] = useState(false)
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; b: Bookmark } | null>(null)
    // D54：收纳盒「最近自动归位」区（去向可见 + 可撤销）
    const [placedRows, setPlacedRows] = useState<InboxPlaced[] | null>(null)

    useEffect(() => {
        if (!ctxMenu) return
        const close = () => setCtxMenu(null)
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setCtxMenu(null)
        }
        window.addEventListener('mousedown', close)
        window.addEventListener('resize', close)
        window.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('mousedown', close)
            window.removeEventListener('resize', close)
            window.removeEventListener('keydown', onKey)
        }
    }, [ctxMenu])

    // 树的行内编辑状态
    const [creating, setCreating] = useState<{ parentId: string | null } | null>(null)
    const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
    const [dragId, setDragId] = useState<string | null>(null)
    const [dropId, setDropId] = useState<string | null>(null)
    const [processing, setProcessing] = useState(false)

    // ⌘K 落地：#bookmarks?q=xxx 预填关键词并直接搜索（结果留在列表里可批量管理）
    useEffect(() => {
        if (!routeQ) return
        setQ(routeQ)
        void doSearch(routeQ)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [routeQ])

    const inboxNode = tree.find(f => f.is_system_inbox === 1)

    const loadTree = useCallback(() => {
        fetchers
            .folderTree(cfg)
            .then(setTree)
            .catch(() => setTree([]))
    }, [cfg])
    useEffect(loadTree, [loadTree])

    // 失效/疑似检测结果（列表行直接显示失败原因）
    const [linkReport, setLinkReport] = useState<LinkCheckReport | null>(null)
    const reloadFindings = useCallback(() => {
        fetchers.linkReport(cfg).then(setLinkReport).catch(() => setLinkReport(null))
    }, [cfg])
    useEffect(reloadFindings, [reloadFindings])
    useEffect(() => {
        if (!detailId) {
            setDetailSnaps([])
            return
        }
        fetchers
            .snapshots(cfg, detailId)
            .then(r => setDetailSnaps(r.snapshots))
            .catch(() => setDetailSnaps([]))
    }, [detailId, cfg])

    /** 查看快照：拉净化视图 → blob 新标签打开（带鉴权头，不能直接链接） */
    const openSnapshot = async (snapshotId: string) => {
        try {
            const res = await fetch(`${cfg.serverUrl.replace(/\/+$/, '')}/api/v1/snapshots/${snapshotId}/view`, {
                headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
            })
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { error?: string }
                toast.err(`快照打开失败：${res.status} ${err.error ?? res.statusText}`)
                return
            }
            const html = await res.text()
            const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
            window.open(url, '_blank')
            setTimeout(() => URL.revokeObjectURL(url), 60_000)
        } catch (e) {
            toast.err(`快照打开失败：${e instanceof Error ? e.message : String(e)}`)
        }
    }

    const failById = useMemo(() => {
        const m = new Map<string, { verdict: string; detail: string }>()
        for (const r of linkReport?.findings.results ?? []) m.set(r.id, { verdict: r.verdict, detail: r.detail })
        return m
    }, [linkReport])

    const archiveBookmark = async (b: Bookmark) => {
        try {
            await apiCall(cfg, `/bookmarks/${b.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) })
            toast.ok(`已归档「${b.title}」（软归档可恢复）`)
            reloadView()
        } catch (e) {
            toast.err(`归档失败：${e instanceof ApiError ? e.message : String(e)}`)
        }
    }

    // 展开态：有记忆按记忆恢复；无记忆时 ≤30 个目录全展开，更多只展开第一级
    // （防真实浏览器导入的大目录树铺满整棵树——布局上树已独立滚动，这里解决"找"的成本）
    useEffect(() => {
        if (tree.length === 0) return
        const saved = localStorage.getItem('mf-tree-expanded')
        if (saved) {
            try {
                setExpanded(new Set(JSON.parse(saved) as string[]))
            } catch {
                localStorage.removeItem('mf-tree-expanded')
            }
            return
        }
        const withKids = tree.filter(f => tree.some(x => x.parent_id === f.id))
        const ids = (tree.length > 30 ? withKids.filter(f => f.parent_id === null) : withKids).map(f => f.id)
        setExpanded(new Set(ids))
        localStorage.setItem('mf-tree-expanded', JSON.stringify(ids))
    }, [tree])

    const loadPage = useCallback(
        async (view: string | 'all', offset: number, append: boolean, status: StatusFilter) => {
            if (!append) setItems(null)
            // 「重复」是组视图（DupSection 渲染），不走书签列表
            if (status === 'duplicate') {
                setItems([])
                setHasMore(false)
                return
            }
            // 「失效」= 确认打不开 + 疑似（反爬/限流拦截，未必失效）合并成一个列表对照看
            if (status === 'dead') {
                const folderId = view === 'all' ? undefined : view
                const [deadList, suspectList] = await Promise.all([
                    fetchers.bookmarks(cfg, { folderId, status: 'dead', limit: 200 }),
                    fetchers.bookmarks(cfg, { folderId, status: 'suspect', limit: 200 }),
                ]).catch(() => [[], []] as Bookmark[][])
                setItems(prev => (append ? [...(prev ?? []), ...deadList, ...suspectList] : [...deadList, ...suspectList]))
                setHasMore(false)
                return
            }
            const batch = await fetchers
                .bookmarks(cfg, {
                    folderId: view === 'all' ? undefined : view,
                    status: status === 'all' ? undefined : status,
                    limit: PAGE,
                    offset,
                })
                .catch(() => [] as Bookmark[])
            setItems(prev => (append ? [...(prev ?? []), ...batch] : batch))
            setHasMore(batch.length === PAGE)
        },
        [cfg],
    )

    useEffect(() => {
        if (multiFolders.size >= 2) return // 多目录并集视图由下方 effect 负责
        const view = selected
        void loadPage(view, 0, false, statusFilter)
    }, [selected, statusFilter, loadPage, multiFolders])

    // 多目录并集：Ctrl/Cmd 多选 ≥2 个目录时，列表 = 各目录前 PAGE 条拼接（配合框选批量操作）
    useEffect(() => {
        if (multiFolders.size < 2) return
        setItems(null)
        setHasMore(false)
        Promise.all(
            [...multiFolders].map(id =>
                fetchers.bookmarks(cfg, {
                    folderId: id,
                    status: statusFilter === 'all' || statusFilter === 'duplicate' ? undefined : statusFilter,
                    limit: PAGE,
                }),
            ),
        )
            .then(lists => setItems(lists.flat()))
            .catch(() => setItems([]))
    }, [multiFolders, statusFilter, cfg])

    // 视图切换即清空已选（目录 / 状态 / 搜索任一变化）
    useEffect(() => {
        setChecked(new Set())
    }, [selected, statusFilter, multiFolders, searching])

    /** 按当前视图刷新：多目录并集重新拉并集，单目录走 loadPage */
    const reloadView = () => {
        if (multiFolders.size >= 2) setMultiFolders(new Set(multiFolders))
        else void loadPage(selected, 0, false, statusFilter)
        loadTree()
    }
    const selectFolder = (id: string | 'all') => {
        setSelected(id)
        setMultiFolders(new Set())
        setSearching(false)
        setQ('')
        setReorgActive(false)
        setHistoryActive(false)
        // 收纳盒视图没有失效/重复/已归档语义，进入时清掉残留状态筛选，防右上按钮被收起后无处取消
        if (inboxNode && id === inboxNode.id) setStatusFilter('all')
    }

    const doSearch = async (kw?: string) => {
        const v = (kw ?? q).trim()
        if (!v) {
            selectFolder('all')
            return
        }
        setSearching(true)
        setReorgActive(false)
        setHistoryActive(false)
        setItems(null)
        const res = await fetchers.search(cfg, v).catch(() => ({ results: [] as Bookmark[] }))
        setItems(res.results)
        setHasMore(false)
    }

    const folderMap = useMemo(() => new Map(tree.map(f => [f.id, f])), [tree])
    const folderPath = (id: string): string => {
        const parts: string[] = []
        let cur = folderMap.get(id)
        while (cur) {
            parts.unshift(cur.name)
            cur = cur.parent_id ? folderMap.get(cur.parent_id) : undefined
        }
        return parts.join(' / ') || '未整理'
    }
    const folderName = (id: string) => folderMap.get(id)?.name ?? '未整理'
    // 收纳盒节点单独置顶渲染，树里不再重复出现
    const childrenOf = (parentId: string | null) =>
        tree.filter(f => f.parent_id === parentId && f.is_system_inbox !== 1)

    // ---- 目录树多选（Ctrl/Cmd 切换、Shift 区间）----
    const flatFolderIds = useMemo(() => tree.filter(f => f.is_system_inbox !== 1).map(f => f.id), [tree])
    // 扁平目录列表（含完整路径，批量移动下拉用）
    const flatFolders = useMemo(() => {
        const byId = new Map(tree.map(f => [f.id, f]))
        return tree.map(f => {
            const parts = [f.is_system_inbox === 1 ? inboxLabel(f.name) : f.name]
            let p = f.parent_id ? byId.get(f.parent_id) : undefined
            while (p) {
                parts.unshift(p.is_system_inbox === 1 ? inboxLabel(p.name) : p.name)
                p = p.parent_id ? byId.get(p.parent_id) : undefined
            }
            return { id: f.id, path: parts.join(' / ') }
        })
    }, [tree])
    const applyMulti = (cur: Set<string>) => {
        if (cur.size <= 1) {
            setMultiFolders(new Set())
            selectFolder(cur.size === 1 ? [...cur][0]! : 'all')
        } else {
            setSelected([...cur][0]!) // selected 保持为第一个目录（兼容单选语义），视图走并集 effect
            setMultiFolders(cur)
        }
    }
    const toggleFolderMulti = (id: string, range: boolean) => {
        setSearching(false)
        setReorgActive(false)
        setHistoryActive(false)
        if (range && anchorFolder.current && flatFolderIds.includes(anchorFolder.current)) {
            const cur = multiFolders.size > 0 ? new Set(multiFolders) : selected !== 'all' ? new Set([selected]) : new Set<string>()
            const from = flatFolderIds.indexOf(anchorFolder.current)
            const to = flatFolderIds.indexOf(id)
            if (from >= 0 && to >= 0) {
                for (let k = Math.min(from, to); k <= Math.max(from, to); k++) cur.add(flatFolderIds[k]!)
                applyMulti(cur)
                return
            }
        }
        anchorFolder.current = id
        const cur = multiFolders.size > 0 ? new Set(multiFolders) : selected !== 'all' ? new Set([selected]) : new Set<string>()
        if (cur.has(id)) cur.delete(id)
        else cur.add(id)
        applyMulti(cur)
    }

    // ---- 书签多选：复选框 / 全选本页 / 批量操作（移动 / 归档 / 删除）----
    const toggleChecked = (id: string) =>
        setChecked(prev => {
            const n = new Set(prev)
            if (n.has(id)) n.delete(id)
            else n.add(id)
            return n
        })
    const allPageChecked = items !== null && items.length > 0 && items.every(b => checked.has(b.id))
    const toggleAllPage = () =>
        setChecked(prev => {
            if (items && items.length > 0 && items.every(b => prev.has(b.id))) {
                const n = new Set(prev)
                for (const b of items) n.delete(b.id)
                return n
            }
            return new Set(items?.map(b => b.id) ?? [])
        })
    /** 批量逐条 PATCH（服务端无批量端点，自建端小规模够用），失败不中断 */
    const batchPatch = async (body: Record<string, unknown>, okLabel: (n: number) => string) => {
        const ids = [...checked]
        let ok = 0
        for (const id of ids) {
            try {
                await apiCall(cfg, `/bookmarks/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
                ok++
            } catch {
                /* 单条失败不中断批量，最后统一汇报 */
            }
        }
        setChecked(new Set())
        reloadView()
        toast.ok(okLabel(ok))
    }
    const batchDelete = async () => {
        const ids = [...checked]
        let ok = 0
        for (const id of ids) {
            try {
                await apiCall(cfg, `/bookmarks/${id}`, { method: 'DELETE' })
                ok++
            } catch {
                /* 同上 */
            }
        }
        setBatchDeleteOpen(false)
        setChecked(new Set())
        reloadView()
        refreshBadges()
        toast.ok(`已删除 ${ok} 条书签`)
    }

    // ---- 框选（marquee）：行间空隙/空白处按下拖动，橡皮筋圈选行；>4px 才算框选，否则仍是普通点击。
    // 行体本身不发起框选——行是 draggable（拖到目录归位），两者抢 mousedown 会冲突（Finder 同款分工）----
    const startMarquee = (e: ReactMouseEvent) => {
        if (e.button !== 0) return
        const target = e.target as HTMLElement
        if (target.closest('[data-marquee-skip],[data-bid],a,button,input,select,textarea,[role="checkbox"],[role="button"]')) return
        e.preventDefault() // 阻断空白区文本选择/原生拖拽；行内拖拽归位不受影响（行体不走这里）
        const wrap = listWrapRef.current
        if (!wrap) return
        const sx = e.clientX
        const sy = e.clientY
        const base = new Set(e.ctrlKey || e.metaKey || e.shiftKey ? checked : [])
        let moved = false
        let lastKey = ''
        const overlay = wrap.querySelector<HTMLDivElement>('[data-marquee-overlay]')
        const prevUserSelect = document.body.style.userSelect
        const onMove = (ev: MouseEvent) => {
            if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return
            if (!moved) {
                moved = true
                suppressRowClick.current = true
                document.body.style.userSelect = 'none'
                if (overlay) overlay.style.display = 'block'
            }
            const wr = wrap.getBoundingClientRect()
            const x0 = Math.min(sx, ev.clientX) - wr.x
            const y0 = Math.min(sy, ev.clientY) - wr.y
            const x1 = Math.max(sx, ev.clientX) - wr.x
            const y1 = Math.max(sy, ev.clientY) - wr.y
            if (overlay) {
                overlay.style.left = `${x0}px`
                overlay.style.top = `${y0}px`
                overlay.style.width = `${x1 - x0}px`
                overlay.style.height = `${y1 - y0}px`
            }
            const hit = new Set(base)
            for (const el of wrap.querySelectorAll<HTMLElement>('[data-bid]')) {
                const r = el.getBoundingClientRect()
                if (r.right > wr.x + x0 && r.left < wr.x + x1 && r.bottom > wr.y + y0 && r.top < wr.y + y1)
                    hit.add(el.dataset.bid!)
            }
            const key = [...hit].sort().join(',')
            if (key !== lastKey) {
                lastKey = key
                setChecked(hit)
            }
        }
        const onUp = () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            document.body.style.userSelect = prevUserSelect
            if (overlay) overlay.style.display = 'none'
            if (moved) {
                suppressRowClick.current = true
                setTimeout(() => {
                    suppressRowClick.current = false
                }, 80)
            }
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
    }

    /** 行内展开详情：再点同一行收起，点其他行切换 */
    const openDetail = async (b: Bookmark) => {
        if (detailId === b.id) {
            setDetailId(null)
            setDetail(null)
            setEditing(false)
            return
        }
        setDetailId(b.id)
        setDetail(null)
        setEditing(false)
        setDetailLoading(true)
        const d = await fetchers.bookmarkDetail(cfg, b.id).catch(() => null)
        setDetail(d)
        setDetailLoading(false)
    }

    // ---- D52 编辑 ----
    const startEdit = (b: { title: string; url_raw: string; description: string | null }) => {
        setEditForm({ title: b.title, url: b.url_raw, description: b.description ?? '' })
        setEditing(true)
    }
    const saveEdit = async () => {
        if (!detail || savingEdit) return
        const body: Record<string, unknown> = {}
        const ttl = editForm.title.trim()
        const u = editForm.url.trim()
        if (ttl && ttl !== detail.title) body.title = ttl
        if (u && u !== detail.url_raw) body.url = u
        if (editForm.description !== (detail.description ?? '')) body.description = editForm.description
        if (Object.keys(body).length === 0) {
            setEditing(false)
            return
        }
        setSavingEdit(true)
        try {
            await apiCall(cfg, `/bookmarks/${detail.id}`, { method: 'PATCH', body: JSON.stringify(body) })
            toast.ok('已保存')
            setEditing(false)
            setDetailId(null)
            setDetail(null)
            reloadView()
            loadTree()
        } catch (e) {
            if (e instanceof ApiError && e.message.includes('duplicate_url')) {
                toast.err('该 URL 与库内其他书签查重冲突（规范化后同一条），可直接打开那条')
            } else if (e instanceof ApiError && e.message.includes('invalid_url')) {
                toast.err('URL 格式不合法')
            } else {
                toast.err(`保存失败：${e instanceof ApiError ? e.message : String(e)}`)
            }
        } finally {
            setSavingEdit(false)
        }
    }

    /** 右键菜单动作（全部复用现有单点动作，不新增状态机） */
    const ctxActions = (b: Bookmark) => [
        {
            label: '编辑',
            icon: <Pencil className="size-3.5" />,
            run: () => {
                if (detailId !== b.id) void openDetail(b)
                startEdit(b)
            },
        },
        {
            label: '移动到…',
            icon: <FolderInput className="size-3.5" />,
            run: () => {
                setChecked(new Set([b.id]))
                setBatchTarget('')
                setBatchMoveOpen(true)
            },
        },
        {
            label: b.pinned === 1 ? '取消置顶' : '置顶',
            icon: <Sparkles className="size-3.5" />,
            run: () => void patch(b.id, { pinned: b.pinned !== 1 }, b.pinned === 1 ? '已取消置顶' : '已置顶'),
        },
        b.status === 'archived'
            ? {
                label: '取消归档',
                icon: <ArchiveRestore className="size-3.5" />,
                run: () => void patch(b.id, { status: 'normal' }, '已取消归档'),
            }
            : {
                label: '归档',
                icon: <Archive className="size-3.5" />,
                run: () => void patch(b.id, { status: 'archived' }, '已归档（可恢复）'),
            },
        {
            label: '复制链接',
            icon: <Check className="size-3.5" />,
            run: () => {
                void navigator.clipboard?.writeText(b.url_canonical)
                toast.ok('已复制 URL')
            },
        },
    ]

    const patch = async (id: string, body: Record<string, unknown>, okText: string) => {
        try {
            await apiCall(cfg, `/bookmarks/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
            toast.ok(okText)
            setDetailId(null)
            setDetail(null)
            reloadView()
            loadTree()
            refreshBadges()
        } catch (e) {
            toast.err(`操作失败：${e instanceof ApiError ? e.message : String(e)}`)
        }
    }

    const remove = async (b: Bookmark) => {
        try {
            await apiCall(cfg, `/bookmarks/${b.id}`, { method: 'DELETE' })
            setPendingDelete(null)
            setDetailId(null)
            setDetail(null)
            toast.ok(`已删除「${b.title}」`)
            reloadView()
            refreshBadges()
        } catch (e) {
            toast.err(`删除失败：${e instanceof ApiError ? e.message : String(e)}`)
        }
    }

    /** 收纳盒：一键 AI 整理（只移动，不删除——红线③） */
    // ---------- 目录树操作 ----------
    const createFolder = async (name: string, parentId: string | null) => {
        if (!name.trim()) return
        try {
            await apiCall(cfg, '/folders', {
                method: 'POST',
                body: JSON.stringify({ name: name.trim(), parentId: parentId ?? undefined }),
            })
            toast.ok(`已创建目录「${name.trim()}」`)
            setCreating(null)
            loadTree()
            if (parentId) updateExpanded(new Set([...expanded, parentId]))
        } catch (e) {
            toast.err(`创建失败：${e instanceof ApiError ? e.message : String(e)}`)
        }
    }

    const renameFolder = async (id: string, name: string) => {
        if (!name.trim()) {
            setRenaming(null)
            return
        }
        try {
            const r = await apiCall<FolderTreeNode & { error?: string }>(cfg, `/folders/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ name: name.trim() }),
            })
            if (r?.error) {
                toast.err('该目录不可改名')
            } else {
                toast.ok('已重命名')
                loadTree()
            }
        } catch (e) {
            toast.err(`重命名失败：${e instanceof ApiError ? e.message : String(e)}`)
        } finally {
            setRenaming(null)
        }
    }

    const deleteFolder = async (id: string) => {
        try {
            const r = await apiCall<{ ok?: boolean; error?: string }>(cfg, `/folders/${id}`, { method: 'DELETE' })
            if (r?.error) {
                toast.err('目录非空：先移走里面的书签或子目录')
                return
            }
            toast.ok('已删除空目录')
            if (selected === id) selectFolder('all')
            loadTree()
        } catch (e) {
            toast.err(`删除失败：${e instanceof ApiError ? e.message : String(e)}`)
        }
    }

    const moveBookmark = async (id: string, folderId: string) => {
        try {
            await apiCall(cfg, `/bookmarks/${id}`, { method: 'PATCH', body: JSON.stringify({ folderId }) })
            toast.ok(`已移动到「${folderName(folderId)}」`)
            loadTree()
            void loadPage(selected, 0, false, statusFilter)
            refreshBadges()
        } catch (e) {
            toast.err(`移动失败：${e instanceof ApiError ? e.message : String(e)}`)
        }
    }

      const loadPlaced = useCallback(() => {
          fetchers
              .inboxItems(cfg)
              .then((r) => setPlacedRows(r.placed))
              .catch(() => setPlacedRows([]))
      }, [cfg])

      useEffect(() => {
          if (inboxNode && selected === inboxNode.id && !searching) loadPlaced()
      }, [selected, inboxNode, searching, loadPlaced])

      const processInbox = async (folderId: string) => {
        setProcessing(true)
        try {
            const r = await apiCall<{ moved?: number }>(cfg, '/inbox/process', { method: 'POST', body: '{}' })
            toast.ok(`已归位 ${r.moved ?? 0} 条（记入版本历史，可撤销）`)
            window.dispatchEvent(new Event('mf:versions-changed'))
            loadPlaced()
            loadTree()
            void loadPage(folderId, 0, false, statusFilter)
            refreshBadges()
        } catch (e) {
            toast.err(`归位失败：${e instanceof ApiError ? e.message : String(e)}`)
        } finally {
            setProcessing(false)
        }
    }

    const statusLabel =
        statusFilter === 'all' ? '' : ` · ${STATUS_CHIPS.find(([v]) => v === statusFilter)?.[1] ?? ''}`
    const viewLabel = reorgActive
        ? '全库重分类'
        : historyActive
          ? '版本历史'
          : searching
            ? `「${q}」的搜索结果`
            : multiFolders.size >= 2
              ? `${multiFolders.size} 个目录${statusLabel}`
              : `${selected === 'all' ? '全部书签' : folderName(selected)}${statusLabel}`
    const totalCount =
        tree.filter(f => !f.is_system_inbox && f.parent_id === null).reduce((s, f) => s + f.totalCount, 0) +
        tree.filter(f => f.is_system_inbox).reduce((s, f) => s + f.totalCount, 0)
    // 收纳盒视图：失效/重复/已归档筛选无意义，右上角换成「说明 + AI 归位」操作区
    const inboxView =
        !!inboxNode && selected === inboxNode.id && !searching && !reorgActive && !historyActive

    // ---------- 目录树渲染 ----------
    const toggle = (id: string) => {
        setExpanded(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            updateExpanded(next)
            return next
        })
    }

    const renderTree = (folder: FolderTreeNode, depth: number): React.ReactNode => {
        const kids = childrenOf(folder.id)
        const hasKids = kids.length > 0
        const isOpen = expanded.has(folder.id)
        const isDrop = dropId === folder.id && dragId !== null
        return (
            <div key={folder.id}>
                <div
                    onDragOver={e => {
                        if (!dragId) return
                        e.preventDefault()
                        setDropId(folder.id)
                    }}
                    onDragLeave={() => setDropId(t => (t === folder.id ? null : t))}
                    onDrop={e => {
                        e.preventDefault()
                        const id = dragId
                        setDropId(null)
                        setDragId(null)
                        if (id) void moveBookmark(id, folder.id)
                    }}
                    className={cn(
                        'group/tn flex items-center rounded-md',
                        isDrop && 'bg-primary/10 ring-1 ring-primary/30',
                    )}
                >
                    <button
                        className={cn(
                            'flex w-4 shrink-0 justify-center text-[10px] text-muted-foreground',
                            !hasKids && 'invisible',
                        )}
                        onClick={() => toggle(folder.id)}
                        tabIndex={-1}
                    >
                        {isOpen ? '▾' : '▸'}
                    </button>
                    {renaming?.id === folder.id ? (
                        <InlineInput
                            initial={folder.name}
                            depth={depth}
                            onCommit={name => void renameFolder(folder.id, name)}
                            onCancel={() => setRenaming(null)}
                        />
                    ) : (
                        <>
                            <button
                                className={cn(
                                    'flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-[13px] transition-colors',
                                    (selected === folder.id || multiFolders.has(folder.id)) && !searching && !reorgActive
                                        ? 'font-medium text-foreground'
                                        : 'text-muted-foreground hover:text-foreground',
                                )}
                                style={{ paddingLeft: depth * 12 }}
                                onClick={e => {
                                    if (e.ctrlKey || e.metaKey) toggleFolderMulti(folder.id, false)
                                    else if (e.shiftKey) toggleFolderMulti(folder.id, true)
                                    else selectFolder(folder.id)
                                }}
                                onDoubleClick={() =>
                                    !folder.is_system_inbox && setRenaming({ id: folder.id, name: folder.name })
                                }
                                title="点击进入 · Ctrl/Cmd+点击多选 · Shift+点击区间 · 双击重命名"
                            >
                                {isOpen ? (
                                    <FolderOpen className="size-3.5 shrink-0 text-foreground/60" />
                                ) : (
                                    <Folder className="size-3.5 shrink-0 text-foreground/60" />
                                )}
                                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                                <span className="tabular text-[11px] text-muted-foreground/50">
                                    {folder.totalCount}
                                </span>
                            </button>
                            <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/tn:opacity-100">
                                <button
                                    className="text-muted-foreground hover:text-foreground rounded p-0.5"
                                    title="新建子目录"
                                    onClick={() => {
                                        setCreating({ parentId: folder.id })
                                        updateExpanded(new Set([...expanded, folder.id]))
                                    }}
                                >
                                    <Plus className="size-3" />
                                </button>
                                {!folder.is_system_inbox && (
                                    <button
                                        className="text-muted-foreground hover:text-foreground rounded p-0.5"
                                        title="重命名（或双击目录名）"
                                        onClick={() => setRenaming({ id: folder.id, name: folder.name })}
                                    >
                                        <Pencil className="size-3" />
                                    </button>
                                )}
                                {folder.totalCount === 0 && (
                                    <button
                                        className="text-destructive rounded p-0.5"
                                        title="删除空目录"
                                        onClick={() => void deleteFolder(folder.id)}
                                    >
                                        <Trash2 className="size-3" />
                                    </button>
                                )}
                            </span>
                        </>
                    )}
                </div>
                {creating?.parentId === folder.id && (
                    <InlineInput
                        depth={depth + 1}
                        onCommit={name => void createFolder(name, folder.id)}
                        onCancel={() => setCreating(null)}
                    />
                )}
                {renaming?.id === folder.id ? null : !isOpen ? null : kids.map(k => renderTree(k, depth + 1))}
            </div>
        )
    }

    return (
        <PageScroll>
            <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight">
                        <BookMarked className="size-4" /> 书签
                    </h2>
                    <p className="text-muted-foreground mt-1 text-[13px]">
                        {viewLabel}
                        {!reorgActive && !historyActive &&
                            ` · ${
                                statusFilter === 'duplicate'
                                    ? '按重复分组'
                                    : items
                                      ? `${items.length}${hasMore ? '+' : ''} 条`
                                      : '…'
                            }`}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Btn primary onClick={() => setAddOpen(true)}>
                        <Plus /> 添加书签
                    </Btn>
                </div>
            </header>

            {/* 搜索 + 状态/类型筛选同行：搜索框靠左，筛选组靠右 */}
            <div className="mb-4 flex flex-wrap items-center justify-end gap-2.5">
                <div className="relative mr-auto">
                    <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
                    <Input
                        className="w-56 rounded-full pl-8"
                        placeholder="搜索书签…"
                        value={q}
                        onChange={e => setQ(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') void doSearch()
                        }}
                    />
                </div>
                {inboxView && inboxNode ? (
                    <div className="bg-muted/60 flex items-center gap-3 rounded-full py-1 pr-1 pl-3">
                        <p className="text-muted-foreground text-xs">
                            随手丢进来的增量。点「AI 归位」自动分拣到各目录——只移动，不删除。
                        </p>
                        <Btn
                            primary
                            className="h-6 rounded-full bg-card px-2.5 text-xs text-primary hover:bg-card hover:text-primary/80"
                            onClick={() => void processInbox(inboxNode.id)}
                            disabled={processing || !items?.length}
                        >
                            {processing ? <Loader2 className="animate-spin" /> : <Sparkles className="size-3" />} AI 归位
                        </Btn>
                    </div>
                ) : (
                    <div className="bg-muted/60 flex items-center gap-0.5 rounded-full p-1">
                        {STATUS_CHIPS.map(([value, label]) => (
                            <button
                                key={value}
                                onClick={() => {
                                    setStatusFilter(s => (s === value ? 'all' : value))
                                    setSearching(false)
                                    setReorgActive(false)
                                    setHistoryActive(false)
                                }}
                                className={cn(
                                    'rounded-full px-3 py-1 text-xs transition-all',
                                    statusFilter === value
                                        ? 'bg-card text-foreground shadow-xs font-medium'
                                        : 'text-muted-foreground hover:text-foreground',
                                )}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                )}
            </div>

      {/* 移动端目录 chips（桌面端用左侧树） */}
            <div className="relative mb-2 md:hidden">
                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2" />
                <Input
                    className="rounded-full pl-9"
                    placeholder="搜索标题 / URL，回车确认"
                    value={q}
                    onChange={e => setQ(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') void doSearch()
                    }}
                />
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-1.5 md:hidden">
                <MobileChip
                    active={selected === 'all' && !searching}
                    label="📚 全部书签"
                    onClick={() => selectFolder('all')}
                />
                {inboxNode && (
                    <MobileChip
                        active={selected === inboxNode.id && !searching}
                        label={inboxLabel(inboxNode.name)}
                        onClick={() => selectFolder(inboxNode.id)}
                    />
                )}
                {childrenOf(null).map(f => (
                    <MobileChip
                        key={f.id}
                        active={selected === f.id && !searching}
                        label={f.name}
                        onClick={() => selectFolder(f.id)}
                    />
                ))}
                <ReorgButton mobile active={reorgActive} onClick={activateReorg} />
                <HistoryTrigger mobile active={historyActive} onClick={activateHistory} />
            </div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-[230px_1fr]">
                {/* 左：目录树 */}
                <div className="hidden md:block">
                    <div className="scroll-slim md:sticky md:top-32 max-h-[calc(100vh-11rem)] overflow-y-auto pr-1">
                        <button
                            className={cn(
                                'mb-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors',
                                selected === 'all' && !searching && !reorgActive
                                    ? 'bg-accent font-medium'
                                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                            )}
                            onClick={() => selectFolder('all')}
                        >
                            <span className="truncate">📚 全部书签</span>
                            <span className="tabular ml-auto text-[11px] text-muted-foreground/60">{totalCount}</span>
                        </button>
                        {inboxNode && (
                            <button
                                className={cn(
                                    'mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors',
                                    'text-primary hover:bg-primary/5',
                                    selected === inboxNode.id && !searching && !reorgActive && 'bg-primary/10 font-medium',
                                )}
                                onClick={() => selectFolder(inboxNode.id)}
                                onDragOver={e => {
                                    if (!dragId) return
                                    e.preventDefault()
                                    setDropId(inboxNode.id)
                                }}
                                onDragLeave={() => setDropId(t => (t === inboxNode.id ? null : t))}
                                onDrop={e => {
                                    e.preventDefault()
                                    const id = dragId
                                    setDropId(null)
                                    setDragId(null)
                                    if (id) void moveBookmark(id, inboxNode.id)
                                }}
                            >
                                <span className="truncate">{inboxLabel(inboxNode.name)}</span>
                                <span className="tabular ml-auto text-[11px] opacity-70">{inboxNode.totalCount}</span>
                            </button>
                        )}
                        {childrenOf(null).map(r => renderTree(r, 0))}

                        {/* 根级新建目录 + 全库重分类：目录树底部的两个结构操作（手动 / AI） */}
                        {creating?.parentId === null ? (
                            <InlineInput
                                depth={0}
                                onCommit={name => void createFolder(name, null)}
                                onCancel={() => setCreating(null)}
                            />
                        ) : (
                            <button
                                className="text-muted-foreground hover:bg-accent/50 hover:text-foreground mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors"
                                onClick={() => setCreating({ parentId: null })}
                            >
                                <FolderPlus className="size-3.5" /> 新建目录
                            </button>
                        )}
                        <ReorgButton active={reorgActive} onClick={activateReorg} />
                        <HistoryTrigger active={historyActive} onClick={activateHistory} />
                        <p className="text-muted-foreground/50 mt-2 px-2 text-[10.5px] leading-relaxed">
                            书签行可以直接拖到目录上归位；双击目录名重命名。
                        </p>
                    </div>
                </div>

                {/* 右：书签列表（行卡，拖拽归位）；「重复」标签→重复组视图；重分类/版本历史激活→右栏整区切换为对应面板 */}
                <div className="min-w-0">
                    {historyActive ? (
                        <HistorySection
                            onClose={() => setHistoryActive(false)}
                            onApplied={() => {
                                loadTree()
                                void loadPage(selected, 0, false, statusFilter)
                            }}
                        />
                    ) : reorgActive ? (
                        <ReorgSection
                            onClose={() => setReorgActive(false)}
                            onApplied={() => {
                                loadTree()
                                void loadPage(selected, 0, false, statusFilter)
                            }}
                            onShowHistory={activateHistory}
                        />
                    ) : statusFilter === 'duplicate' ? (
                        <DupSection />
                    ) : (
                        <>
                    {statusFilter === 'dead' && (
                        <CheckupSection
                            onChecked={() => {
                                void loadPage(selected, 0, false, statusFilter)
                                reloadFindings()
                            }}
                        />
                    )}
                    {items === null ? (
                        <div className="py-2">
                            <RowsSkeleton rows={6} />
                        </div>
                    ) : items.length === 0 ? (
                        <div>
                            <EmptyState
                                icon={searching ? '🔍' : statusFilter === 'dead' ? '✨' : inboxView ? '📥' : '🌱'}
                                title={
                                    searching
                                        ? '没有找到匹配的书签'
                                        : statusFilter === 'dead'
                                          ? '没有失效链接'
                                          : inboxView
                                            ? '收纳盒是空的'
                                            : '这里还没有书签'
                                }
                                hint={
                                    searching
                                        ? '换个关键词试试，或检查一下目录 / 状态筛选'
                                        : statusFilter === 'dead'
                                          ? '能访问的都正常，打不开的还没查出——点上方「重新检测」跑一遍'
                                          : inboxView
                                            ? '丢进来的增量已全部自动归位——最近的归位记录见下方，可随时撤销'
                                            : '点右上角「添加书签」，或在浏览器里随手收藏'
                                }
                            />
                        </div>
                    ) : (
                        <div ref={listWrapRef} className="relative cursor-crosshair" onMouseDown={startMarquee}>
                            {checked.size > 0 && (
                                <div className="bg-muted/60 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl px-3 py-2">
                                    <span className="text-[13px] font-medium tabular">已选 {checked.size} 条</span>
                                    <button
                                        className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                                        onClick={toggleAllPage}
                                    >
                                        {allPageChecked ? '取消全选' : '全选本页'}
                                    </button>
                                    <span className="flex-1" />
                                    <Btn onClick={() => { setBatchTarget(''); setBatchMoveOpen(true) }}>
                                        <FolderInput /> 移动到…
                                    </Btn>
                                    <Btn onClick={() => void batchPatch({ status: 'archived' }, n => `已归档 ${n} 条（软归档可恢复）`)}>
                                        <Archive /> 归档
                                    </Btn>
                                    <button
                                        className="text-destructive hover:bg-destructive/10 flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors"
                                        onClick={() => setBatchDeleteOpen(true)}
                                    >
                                        <Trash2 className="size-3.5" /> 删除
                                    </button>
                                    <button
                                        className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                                        onClick={() => setChecked(new Set())}
                                    >
                                        取消
                                    </button>
                                </div>
                            )}
                            <div
                                data-marquee-overlay
                                className="border-primary/60 bg-primary/10 pointer-events-none absolute z-10 hidden rounded border"
                                style={{ display: 'none' }}
                            />
                            <ul className="p-1">
                                {(() => {
                                    // 「失效」视图里两类分组：确认打不开 / 疑似（反爬拦截，未必失效）
                                    const isSuspect = (b: Bookmark) =>
                                        b.status === 'suspect' || failById.get(b.id)?.verdict === 'suspect'
                                    const firstSuspect = statusFilter === 'dead' ? items.findIndex(isSuspect) : -1
                                    const firstDead = statusFilter === 'dead' ? items.findIndex(b => !isSuspect(b)) : -1
                                    // findIndex 未命中返回 -1：无疑似项时计数须归 0（否则 减 -1 得负数）
                                    const suspectCount = statusFilter === 'dead' && firstSuspect >= 0 ? items.length - firstSuspect : 0
                                    return items.map((b, i) => {
                                    const f = failById.get(b.id)
                                    const suspectRow = f?.verdict === 'suspect' || b.status === 'suspect'
                                    const showFail = f !== undefined && (b.status === 'dead' || suspectRow)
                                    return (
                                        <Fragment key={b.id}>
                                            {i === firstDead && (
                                                <li aria-hidden className="mb-1 mt-3 flex items-baseline gap-2 px-3 first:mt-0">
                                                    <span className="flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
                                                        <span className="size-1.5 rounded-full bg-red-500" /> 打不开
                                                    </span>
                                                    <span className="text-muted-foreground text-[11px]">
                                                        确认失效 · {items.length - suspectCount} 条
                                                    </span>
                                                </li>
                                            )}
                                            {i === firstSuspect && (
                                                <li aria-hidden className="mb-1 mt-5 flex items-baseline gap-2 px-3 first:mt-0">
                                                    <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                                                        <span className="size-1.5 rounded-full bg-amber-500" /> 疑似失效
                                                    </span>
                                                    <span className="text-muted-foreground text-[11px]">
                                                        被反爬 / 限流 / 登录墙挡住，未必真失效 · {suspectCount} 条
                                                    </span>
                                                </li>
                                            )}
                                            <li
                                            data-bid={b.id}
                                            draggable
                                            onDragStart={e => {
                                                e.dataTransfer.setData('text/plain', b.id)
                                                e.dataTransfer.effectAllowed = 'move'
                                                setDragId(b.id)
                                            }}
                                            onDragEnd={() => setDragId(null)}
                                            onContextMenu={e => {
                                                // D52：行右键 = 操作菜单（复用现有单点动作）
                                                if (e.ctrlKey) return
                                                e.preventDefault()
                                                setCtxMenu({ x: e.clientX, y: e.clientY, b })
                                            }}
                                            className={cn(
                                                'group hover:bg-accent/40 m-1 cursor-pointer rounded-xl px-3 py-2.5 transition-colors',
                                                checked.has(b.id) && 'bg-primary/5',
                                                // 展开时行与详情融合为一张卡：去下圆角与下边距，详情接下半段
                                                detailId === b.id && 'bg-accent/40 mb-0 rounded-b-none',
                                            )}
                                            onClick={e => {
                                                if (suppressRowClick.current) return
                                                if (e.ctrlKey || e.metaKey) {
                                                    // Ctrl/Cmd+点击行 = 加入/移出选择（详情抽屉走普通点击）
                                                    toggleChecked(b.id)
                                                    return
                                                }
                                                void openDetail(b)
                                            }}
                                        >
                                            <div className="flex items-center gap-3">
                                                <button
                                                    role="checkbox"
                                                    aria-checked={checked.has(b.id)}
                                                    title={checked.has(b.id) ? '取消选择' : '选择'}
                                                    className={cn(
                                                        'border-border/70 hover:border-foreground/40 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[5px] border transition-all',
                                                        checked.has(b.id)
                                                            ? 'border-primary bg-primary text-primary-foreground'
                                                            : 'bg-background',
                                                        checked.has(b.id) || checked.size > 0
                                                            ? 'opacity-100'
                                                            : 'opacity-0 group-hover:opacity-100',
                                                    )}
                                                    onClick={e => {
                                                        e.stopPropagation()
                                                        toggleChecked(b.id)
                                                    }}
                                                >
                                                    {checked.has(b.id) && <Check className="size-3" strokeWidth={3} />}
                                                </button>
                                                <SiteIcon title={b.title} url={b.url_canonical} size="md" />
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-1.5">
                                                        {b.is_private === 1 && (
                                                            <span
                                                                title="隐私域名：只存元数据，不抓正文 / 不送 AI / 不生成快照（红线②）"
                                                                className="shrink-0 text-xs"
                                                            >
                                                                🛡
                                                            </span>
                                                        )}
                                                        <a
                                                            href={b.url_canonical}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="truncate text-sm font-medium underline-offset-2 hover:text-primary hover:underline"
                                                            title={`${b.title}（点击打开原页，点行其余位置展开详情）`}
                                                            onClick={e => e.stopPropagation()}
                                                        >
                                                            {b.title}
                                                        </a>
                                                    </div>
                                                    <div
                                                        className={cn(
                                                            'truncate font-mono text-[11px]',
                                                            showFail
                                                                ? b.status === 'dead'
                                                                    ? 'text-red-600/90 dark:text-red-400/90'
                                                                    : 'text-amber-600/90 dark:text-amber-400/90'
                                                                : 'text-muted-foreground/80',
                                                        )}
                                                    >
                                                        {showFail && f ? f.detail : hostOf(b.url_canonical)}
                                                    </div>
                                                </div>
                                                <StatusBadge status={suspectRow ? 'suspect' : b.status} />
                                                <span
                                                    className="text-muted-foreground/60 hidden shrink-0 text-xs tabular xl:block"
                                                    title={`入库于 ${fmtDate(b.added_at)}`}
                                                >
                                                    {libraryAge(b.added_at)}
                                                </span>
                                                <div
                                                    className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                                                    onClick={e => e.stopPropagation()}
                                                >
                                                    {b.status === 'dead' && (
                                                        <button
                                                            className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg p-1.5 transition-colors"
                                                            title="归档（软归档可恢复）"
                                                            onClick={() => void archiveBookmark(b)}
                                                        >
                                                            <Archive className="size-3.5" />
                                                        </button>
                                                    )}
                                                    <button
                                                        className="text-destructive hover:bg-destructive/10 rounded-lg p-1.5 transition-colors"
                                                        title="删除（手动 · 二次确认）"
                                                        onClick={() => setPendingDelete(b)}
                                                    >
                                                        <Trash2 className="size-3.5" />
                                                    </button>
                                                </div>
                                            </div>
                                        </li>
                                        {/* 行内展开详情（替代抽屉）：点行展开/收起，嵌在选中书签下方便于对照操作 */}
                                        {detailId === b.id && (
                                            <li data-marquee-skip className="mx-1 mb-1 mt-0">
                                                <div className="bg-accent/40 animate-in fade-in slide-in-from-top-1 relative rounded-b-xl py-3.5 pr-3.5 pl-[84px] duration-200">
                                                    {/* 关闭按钮钉死右上角，不参与内容换行 */}
                                                    <button
                                                        className="text-muted-foreground hover:bg-accent hover:text-foreground absolute top-2 right-2 rounded-lg p-1 transition-colors"
                                                        title="收起"
                                                        onClick={() => {
                                                            setDetailId(null)
                                                            setDetail(null)
                                                        }}
                                                    >
                                                        <X className="size-3.5" />
                                                    </button>
                                                    {detailLoading || !detail ? (
                                                        <div className="flex items-center justify-center py-6">
                                                            <Loader2 className="text-muted-foreground animate-spin" />
                                                        </div>
                                                    ) : (
                                                        <>
                                                            {/* 一行安静事实：只放行里没有的信息，标题/图标/状态不重复；pr-7 给关闭按钮让位 */}
                                                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pr-7 text-xs">
                                                                <span className="text-muted-foreground">{folderPath(detail.folder_id)}</span>
                                                                <span className="text-muted-foreground">
                                                                    入库 {fmtDate(detail.added_at)}（{libraryAge(detail.added_at)}）
                                                                </span>
                                                                <span className="text-muted-foreground">
                                                                    上次检测 {fmtDate(detail.last_checked_at)}
                                                                </span>
                                                                {detail.cache?.fetched_via && (
                                                                    <span className="text-muted-foreground">缓存来源 {fetchViaLabel(detail.cache.fetched_via)}</span>
                                                                )}
                                                                {detail.cache?.fail_reason && (
                                                                    <span className="text-muted-foreground">正文未抓（{detail.cache.fail_reason}）</span>
                                                                )}
                                                            </div>

                                                            {/* D52 编辑区：安静一行入口，点开变三条内联输入（标题/URL/备注） */}
                                                            <div className="mt-2 max-w-[560px] pr-7">
                                                                {editing ? (
                                                                    <div className="space-y-1.5">
                                                                        <Input
                                                                            value={editForm.title}
                                                                            onChange={e => setEditForm(sf => ({ ...sf, title: e.target.value }))}
                                                                            placeholder="标题"
                                                                            className="h-8 bg-background text-[13px]"
                                                                        />
                                                                        <Input
                                                                            value={editForm.url}
                                                                            onChange={e => setEditForm(sf => ({ ...sf, url: e.target.value }))}
                                                                            placeholder="URL"
                                                                            spellCheck={false}
                                                                            className="h-8 bg-background font-mono text-[12px]"
                                                                        />
                                                                        <Input
                                                                            value={editForm.description}
                                                                            onChange={e => setEditForm(sf => ({ ...sf, description: e.target.value }))}
                                                                            placeholder="备注（可选）：为什么收藏它？"
                                                                            className="h-8 bg-background text-[13px]"
                                                                        />
                                                                        <div className="flex items-center gap-2 pt-0.5">
                                                                            <Btn primary onClick={() => void saveEdit()} disabled={savingEdit}>
                                                                                {savingEdit ? <Loader2 className="animate-spin" /> : <Check />}
                                                                                <span>保存</span>
                                                                            </Btn>
                                                                            <Btn onClick={() => setEditing(false)}>取消</Btn>
                                                                            <span className="text-muted-foreground ml-1 text-[11px]">
                                                                                改动将同步到浏览器收藏夹（若已开启双向同步）
                                                                            </span>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                    <div className="flex items-center gap-2">
                                                                        {detail.description && (
                                                                            <span className="text-muted-foreground min-w-0 flex-1 truncate text-[12px]" title={detail.description}>
                                                                                ✎ {detail.description}
                                                                            </span>
                                                                        )}
                                                                        <button
                                                                            className="text-muted-foreground hover:bg-accent/60 hover:text-foreground flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors"
                                                                            onClick={() => startEdit(detail)}
                                                                        >
                                                                            <Pencil className="size-3.5" /> 编辑
                                                                        </button>
                                                                    </div>
                                                                )}
                                                            </div>

                                                            {/* AI 摘要：有内容才显示，没有就安静；纯文本与上方元信息同列对齐 */}
                                                            {(detail.cache?.l1_summary || (detail.cache?.l1_tags ?? []).length > 0) && (
                                                                <div className="mt-2.5 space-y-2">
                                                                    {detail.cache?.l1_summary && (
                                                                        <p className="text-[13px] leading-relaxed">{detail.cache.l1_summary}</p>
                                                                    )}
                                                                    {(detail.cache?.l1_tags ?? []).length > 0 && (
                                                                        <div className="text-muted-foreground flex flex-wrap gap-x-2 gap-y-1 text-[11px]">
                                                                            {(detail.cache?.l1_tags ?? []).map(t => (
                                                                                <span key={t}>#{t}</span>
                                                                            ))}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}

                                                            {detailSnaps.length > 0 && (
                                                                <div className="mt-3">
                                                                    <p className="text-muted-foreground text-[11px] font-medium">
                                                                        快照（{detailSnaps.length} 个版本 · 失效≠丢失）
                                                                    </p>
                                                                    <div className="bg-muted/40 mt-1 rounded-lg px-2.5 py-1">
                                                                        {detailSnaps.map((sn, i) => (
                                                                            <div key={sn.id} className="flex items-center gap-2 py-1 text-[11px]">
                                                                                <span className={cn('rounded px-1 py-px font-medium', i === 0 ? 'bg-primary/10 text-primary' : 'text-muted-foreground')}>
                                                                                    {i === 0 ? '最新' : `v${detailSnaps.length - i}`}
                                                                                </span>
                                                                                <span className="text-muted-foreground flex-1 truncate">{fmtDate(sn.created_at)} · {sn.size > 1024 * 1024 ? `${(sn.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(sn.size / 1024))} KB`}</span>
                                                                                <Btn className="h-5 gap-1 px-1.5 text-[10px]" onClick={() => void openSnapshot(sn.id)}>
                                                                                    查看
                                                                                </Btn>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            )}

                                                            <div className="mt-3 flex flex-wrap items-center gap-2">
                                                                <MoveButton
                                                                    tree={tree}
                                                                    current={detail.folder_id}
                                                                    onMove={folderId =>
                                                                        void patch(detail.id, { folderId }, `已移动到「${folderName(folderId)}」`)
                                                                    }
                                                                />
                                                                {detail.status === 'archived' ? (
                                                                    <Btn onClick={() => void patch(detail.id, { status: 'normal' }, '已取消归档')}>
                                                                        <ArchiveRestore /> 取消归档
                                                                    </Btn>
                                                                ) : (
                                                                    <Btn
                                                                        onClick={() => void patch(detail.id, { status: 'archived' }, '已归档（可回滚）')}
                                                                        title="软归档：不删除，随时恢复"
                                                                    >
                                                                        <Archive /> 归档
                                                                    </Btn>
                                                                )}
                                                                <Btn
                                                                    onClick={() =>
                                                                        void patch(
                                                                            detail.id,
                                                                            { isPrivate: detail.is_private !== 1 },
                                                                            detail.is_private !== 1 ? '已设为私密' : '已取消私密',
                                                                        )
                                                                    }
                                                                    title="私密：仅隐藏显示，未做二次验证或加密（决策 D19）"
                                                                >
                                                                    <ShieldCheck /> {detail.is_private === 1 ? '取消私密' : '设为私密'}
                                                                </Btn>
                                                                <span className="flex-1" />
                                                                <button
                                                                    className="text-destructive hover:bg-destructive/10 flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors"
                                                                    onClick={() => setPendingDelete(detail)}
                                                                >
                                                                    <Trash2 className="size-3.5" /> 删除
                                                                </button>
                                                            </div>
                                                        </>
                                                    )}
                                                </div>
                                            </li>
                                        )}
                                        {i < items.length - 1 && (
                                            <li aria-hidden className="border-border/40 mx-4 border-t" />
                                        )}
                                    </Fragment>
                                    )
                                    })
                                })()}
                            </ul>
                            {hasMore && !searching && (
                                <div className="border-border/60 border-t p-2 text-center">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                            void loadPage(
                                                selected,
                                                items.length,
                                                true,
                                                statusFilter,
                                            )
                                        }
                                    >
                                        加载更多
                                    </Button>
                                </div>
                            )}

                        </div>
                    )}

                    {/* D54 最近自动归位：与列表容器平级——旧实现嵌在容器内，盒空（待处理全部归位完）
                        时 items=0 走 EmptyState 分支，历史区整块跟着消失（用户反馈「历史记录又看不到了」的根因）。
                        mx-2 = 对齐行盒缩进（与行 hover 背景左右缘齐平）；data-marquee-skip 防框选误伤 */}
                    {inboxNode && selected === inboxNode.id && !searching && placedRows && placedRows.length > 0 && (
                        <div className="bg-muted/40 mx-2 mt-3 rounded-xl px-4 py-2.5" data-marquee-skip>
                            <p className="text-muted-foreground mb-1 text-[11px] font-medium">最近自动归位</p>
                            <ul className="divide-y divide-border/40">
                                {placedRows.map((p) => (
                                    <li key={p.bookmark_id} className="flex items-center gap-2.5 py-1.5 text-[13px]">
                                        <a
                                            href={p.url_canonical}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="min-w-0 flex-1 truncate underline-offset-2 hover:text-primary hover:underline"
                                        >
                                            {p.title}
                                        </a>
                                        {p.folder_name && (
                                            <span className="shrink-0 text-xs">
                                                →「<span className="font-medium">{p.folder_name}</span>」
                                            </span>
                                        )}
                                        {p.reason && <span className="text-muted-foreground shrink-0 text-[11px]">{p.reason}</span>}
                                        {p.version_id && (
                                            <button
                                                className="text-muted-foreground hover:text-foreground shrink-0 text-[11px] underline-offset-2 hover:underline"
                                                title="归位记入版本历史，可精确撤销这一次"
                                                onClick={activateHistory}
                                            >
                                                撤销…
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                        </>
                    )}
                </div>
            </div>

            {/* 详情抽屉 */}
            {/* D52 行右键菜单：轻量浮层（shadow 分层，动作全部复用现有 handler） */}
            {ctxMenu && (
                <div
                    role="menu"
                    aria-label="书签操作"
                    className="bg-popover text-popover-foreground shadow-lg z-50 fixed min-w-[172px] rounded-xl border p-1"
                    style={{
                        left: Math.min(ctxMenu.x, window.innerWidth - 190),
                        top: Math.min(ctxMenu.y, window.innerHeight - 260),
                    }}
                    onMouseDown={e => {
                        // 阻止冒泡到 window 的关闭监听：否则菜单先卸载，menuitem 的 click 落在脱离节点上永不触发
                        e.preventDefault()
                        e.stopPropagation()
                    }}
                    onContextMenu={e => e.preventDefault()}
                >
                    <button
                        role="menuitem"
                        className="hover:bg-accent flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors"
                        onClick={() => {
                            window.open(ctxMenu.b.url_canonical, '_blank', 'noreferrer')
                            setCtxMenu(null)
                        }}
                    >
                        <ChevronRight className="text-muted-foreground size-3.5" /> 打开原页
                    </button>
                    {ctxActions(ctxMenu.b).map(a => (
                        <button
                            key={a.label}
                            role="menuitem"
                            className="hover:bg-accent flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors"
                            onClick={() => {
                                setCtxMenu(null)
                                a.run()
                            }}
                        >
                            <span className="text-muted-foreground">{a.icon}</span> {a.label}
                        </button>
                    ))}
                    <div className="border-border/50 my-1 border-t" />
                    <button
                        role="menuitem"
                        className="text-destructive hover:bg-destructive/10 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors"
                        onClick={() => {
                            setCtxMenu(null)
                            setPendingDelete(ctxMenu.b)
                        }}
                    >
                        <Trash2 className="size-3.5" /> 删除…
                    </button>
                </div>
            )}

            {/* 删除确认（不可逆操作显式二次确认；删除只由用户手动发起） */}
            <Dialog open={pendingDelete !== null} onOpenChange={open => !open && setPendingDelete(null)}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Trash2 className="text-destructive size-5" />
                            删除书签
                        </DialogTitle>
                        <DialogDescription>
                            确定删除「{pendingDelete?.title}」？该操作不可恢复，关联的正文缓存与快照将一并删除。
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Btn>取消</Btn>
                        </DialogClose>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => pendingDelete && void remove(pendingDelete)}
                        >
                            <Trash2 /> 删除
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 批量移动（框选 / 复选后） */}
            <Dialog open={batchMoveOpen} onOpenChange={setBatchMoveOpen}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>移动 {checked.size} 条到…</DialogTitle>
                        <DialogDescription>移动直接生效，并记入整理版本历史（可回滚）。</DialogDescription>
                    </DialogHeader>
                    <Select value={batchTarget} onValueChange={setBatchTarget}>
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder="选择目标目录" />
                        </SelectTrigger>
                        <SelectContent className="max-h-72">
                            {flatFolders.map(f => (
                                <SelectItem key={f.id} value={f.id}>
                                    {f.path}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Btn>取消</Btn>
                        </DialogClose>
                        <Btn
                            primary
                            disabled={!batchTarget}
                            onClick={() => {
                                setBatchMoveOpen(false)
                                void batchPatch({ folderId: batchTarget }, n => `已移动 ${n} 条`)
                            }}
                        >
                            <ChevronRight /> 移动
                        </Btn>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* 批量删除（二次确认；规范红线③：删除永不自动执行） */}
            <Dialog open={batchDeleteOpen} onOpenChange={setBatchDeleteOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Trash2 className="text-destructive size-5" />
                            删除 {checked.size} 条书签
                        </DialogTitle>
                        <DialogDescription>
                            该操作不可恢复，关联的正文缓存与快照将一并删除。只是不想被打扰的话，建议用「归档」（可恢复）。
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Btn>取消</Btn>
                        </DialogClose>
                        <Button variant="destructive" size="sm" onClick={() => void batchDelete()}>
                            <Trash2 /> 删除
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>


            <AddBookmarkDialog
                open={addOpen}
                onOpenChange={setAddOpen}
                tree={tree}
                defaultFolder={selected === 'all' ? undefined : selected}
                onDone={text => {
                    toast.ok(text)
                    void loadPage(selected, 0, false, statusFilter)
                    loadTree()
                    refreshBadges()
                }}
            />
        </PageScroll>
    )
}

/** 目录行内输入（新建 / 重命名共用）：Enter 提交、Esc 取消、失焦提交 */
function InlineInput({
    initial = '',
    depth,
    onCommit,
    onCancel,
}: {
    initial?: string
    depth: number
    onCommit: (name: string) => void
    onCancel: () => void
}) {
    const [v, setV] = useState(initial)
    const commit = () => (v.trim() ? onCommit(v.trim()) : onCancel())
    return (
        <input
            autoFocus
            value={v}
            onChange={e => setV(e.target.value)}
            onKeyDown={e => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') onCancel()
            }}
            onBlur={commit}
            className="border-border bg-card focus:ring-ring/30 my-0.5 w-full rounded-md border px-2 py-1 text-[13px] outline-none focus:ring-2"
            style={{ marginLeft: depth * 12 }}
            placeholder="目录名，回车确认"
        />
    )
}

/** 移动端目录 chip（桌面端用左侧树） */
function MobileChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className={cn(
                'rounded-full px-2.5 py-1 text-xs transition-colors',
                active
                    ? 'bg-primary font-medium text-primary-foreground'
                    : 'bg-muted/70 text-muted-foreground hover:text-foreground',
            )}
        >
            {label}
        </button>
    )
}

/** 移动到…（目录下拉 + 确认） */
function MoveButton({
    tree,
    current,
    onMove,
}: {
    tree: FolderTreeNode[]
    current: string
    onMove: (folderId: string) => void
}) {
    const [open, setOpen] = useState(false)
    const [target, setTarget] = useState<string>(current)
    const flat = useMemo(() => {
        const out: Array<{ id: string; path: string }> = []
        const byParent = new Map(tree.map(f => [f.id, f]))
        const pathOf = (f: FolderTreeNode): string => {
            const parts: string[] = [f.name]
            let p = f.parent_id ? byParent.get(f.parent_id) : undefined
            while (p) {
                parts.unshift(p.name)
                p = p.parent_id ? byParent.get(p.parent_id) : undefined
            }
            return parts.join(' / ')
        }
        for (const f of tree) {
            if (f.id !== current) out.push({ id: f.id, path: pathOf(f) })
        }
        return out
    }, [tree, current])
    return (
        <>
            <Btn onClick={() => setOpen(true)}>
                <FolderInput /> 移动到…
            </Btn>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>移动到…</DialogTitle>
                        <DialogDescription>移动直接生效，并记入整理版本历史（可回滚）。</DialogDescription>
                    </DialogHeader>
                    <Select value={target} onValueChange={setTarget}>
                        <SelectTrigger className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-72">
                            {flat.map(f => (
                                <SelectItem key={f.id} value={f.id}>
                                    {f.path}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Btn>取消</Btn>
                        </DialogClose>
                        <Btn
                            primary
                            onClick={() => {
                                setOpen(false)
                                onMove(target)
                            }}
                        >
                            <ChevronRight /> 移动
                        </Btn>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}

/** 手动添加书签（URL 必填；目录可选，缺省走规则引擎建议落位） */
function AddBookmarkDialog({
    open,
    onOpenChange,
    tree,
    defaultFolder,
    onDone,
}: {
    open: boolean
    onOpenChange: (v: boolean) => void
    tree: FolderTreeNode[]
    defaultFolder?: string
    onDone: (text: string) => void
}) {
    const { cfg } = useShell()
    const [url, setUrl] = useState('')
    const [title, setTitle] = useState('')
    const [folderId, setFolderId] = useState<string>(defaultFolder ?? 'auto')
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState('')

    useEffect(() => {
        if (open) {
            setUrl('')
            setTitle('')
            setFolderId(defaultFolder ?? 'auto')
            setErr('')
        }
    }, [open, defaultFolder])

    const submit = async () => {
        if (!url.trim() || busy) return
        setBusy(true)
        setErr('')
        try {
            const r = await apiCall<Bookmark & { duplicate?: boolean; suggest?: { folderPath: string[] } }>(
                cfg,
                '/bookmarks',
                {
                    method: 'POST',
                    body: JSON.stringify({
                        url: url.trim(),
                        title: title.trim() || undefined,
                        folderId: folderId === 'auto' ? undefined : folderId,
                    }),
                },
            )
            onOpenChange(false)
            onDone(
                r.duplicate
                    ? '该书签已经存在（按规范 URL 查重），没有重复添加'
                    : `已添加「${r.title}」${r.suggest?.folderPath?.length ? ` · 建议目录：${r.suggest.folderPath.join(' / ')}` : ''}`,
            )
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : String(e))
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>添加书签</DialogTitle>
                    <DialogDescription>按规范 URL 自动查重；不选目录时走规则引擎自动归位。</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div>
                        <label className="text-muted-foreground mb-1 block text-xs">URL *</label>
                        <Input
                            className="font-mono text-xs"
                            value={url}
                            onChange={e => setUrl(e.target.value)}
                            placeholder="https://…"
                        />
                    </div>
                    <div>
                        <label className="text-muted-foreground mb-1 block text-xs">标题</label>
                        <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="留空则使用 URL" />
                    </div>
                    <div>
                        <label className="text-muted-foreground mb-1 block text-xs">目录</label>
                        <Select value={folderId} onValueChange={setFolderId}>
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="max-h-72">
                                <SelectItem value="auto">✦ 自动建议（规则引擎）</SelectItem>
                                {tree.map(f => (
                                    <SelectItem key={f.id} value={f.id}>
                                        {f.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {err && <p className="text-sm text-red-500">{err}</p>}
                </div>
                <DialogFooter>
                    <DialogClose asChild>
                        <Btn>取消</Btn>
                    </DialogClose>
                    <Btn primary onClick={() => void submit()} disabled={!url.trim() || busy}>
                        {busy && <Loader2 className="animate-spin" />} 添加
                    </Btn>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
