/**
 * options 页逻辑（DOM 操作版——页面自带样式，无需 React）。
 * 与 popup 共享 src/lib/api 的 storage 配置。
 * 服务与账号、浏览器同步与投递口留在本机；通知与隐私策略统一由管理台设置。
 */
import { browser } from 'wxt/browser'
import { getConfig, loginAccount, OFFICIAL_CLOUD_URL, registerAccount, saveConfig } from '../../src/lib/api'

const $ = (id: string) => document.getElementById(id) as HTMLInputElement

const msg = (el: HTMLElement, text: string, ok = true) => {
    el.textContent = text
    el.classList.toggle('ok', ok)
    el.classList.toggle('err', !ok)
}

// ---------- 服务形态（D67）：自建（默认）｜官方云；云 = 用户名 + 密码 ----------
const CLOUD_ERR: Record<string, string> = {
    invalid_password: '用户名或密码不对，再想想？',
    username_required: '请输入用户名',
    invalid_server_url: '服务地址需以 http:// 或 https:// 开头',
    username_taken: '这个用户名已被注册，换一个试试',
    invalid_username: '用户名需 3-32 位字母、数字、- 或 _',
    password_too_short_min_8: '密码至少 8 位',
    register_closed: '当前服务未开放注册，请联系系统管理员',
    account_disabled: '该账号已被停用，请联系系统管理员',
    rate_limited: '尝试过于频繁，已被限速，稍后再试',
}

/** 云端错误细节 → 可行动文案 */
const cloudErrText = (e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e)
    return CLOUD_ERR[raw] ?? `操作失败：${raw}`
}

/** 服务状态：下拉当前选中项（OFFICIAL_CLOUD_URL / 条目 url / "__add__"） */
type ServerEntry = { url: string; label: string; mode?: 'self' | 'cloud' }

let entries: ServerEntry[] = []
let currentSel = OFFICIAL_CLOUD_URL
let lastActive = OFFICIAL_CLOUD_URL

const hostOf = (u: string): string => {
    try {
        return new URL(u).host
    } catch {
        return u
    }
}

async function loadEntries(): Promise<void> {
    const cfg = await getConfig()
    entries = cfg.servers ? [...cfg.servers] : []
    // 存量迁移：已有 serverUrl 且不在列表 → 作为一条自建服务入库（零迁移感）
    if (cfg.serverUrl && cfg.serverUrl !== OFFICIAL_CLOUD_URL && !entries.some(s => s.url === cfg.serverUrl)) {
        entries.unshift({ url: cfg.serverUrl, label: hostOf(cfg.serverUrl), mode: cfg.serverMode ?? 'self' })
        await saveConfig({ servers: entries })
    }
}

function renderSelect(sel: string): void {
    const el = $('server-select') as unknown as HTMLSelectElement
    el.innerHTML = ''
    const optCloud = document.createElement('option')
    optCloud.value = OFFICIAL_CLOUD_URL
    optCloud.textContent = '官方云（默认）'
    el.appendChild(optCloud)
    for (const s of entries) {
        const o = document.createElement('option')
        o.value = s.url
        o.textContent = s.mode === 'cloud' ? `${s.label}（云）` : s.label
        el.appendChild(o)
    }
    el.value = sel
    currentSel = el.value
}

function renderPanels(): void {
    $('add-toggle').setAttribute('aria-expanded', 'false')
    ;($('panel-add') as HTMLElement).style.display = 'none'
    ;($('panel-account') as HTMLElement).style.display = ''
    ;($('server-remove') as HTMLElement).style.display = currentSel === OFFICIAL_CLOUD_URL ? 'none' : '' // 官方云内置项不可删
}

/** D70：账号区二级切换——已登录隐藏整个表单（只留一行身份+说明），未登录才出表单 */
async function renderAccount(): Promise<void> {
    const cfg = await getConfig()
    const logged = Boolean(cfg.token)
    ;($('acct-in') as HTMLElement).style.display = logged ? '' : 'none'
    ;($('acct-out') as HTMLElement).style.display = logged ? 'none' : ''
    if (logged) {
        ;($('acct-name') as HTMLElement).textContent = cfg.accountName ?? '管理员'
    }
}

/** 选中即切换：持久化当前服务 + 换上该服务的令牌记忆（切换免重登） */
async function activate(sel: string): Promise<void> {
    const cfg = await getConfig()
    const tokens = cfg.serverTokens ?? {}
    const entry = entries.find(s => s.url === sel)
    const mode: 'self' | 'cloud' = sel === OFFICIAL_CLOUD_URL ? 'cloud' : (entry?.mode ?? 'self')
    await saveConfig({
        serverUrl: sel,
        serverMode: mode,
        activeServer: sel,
        token: tokens[sel] ?? '',
    })
    lastActive = sel
    renderPanels()
    await renderAccount()
    void refreshServerOverview()
    await paintConnStatus()
}

async function selectChanged(): Promise<void> {
    const sel = ($('server-select') as unknown as HTMLSelectElement).value
    renderSelect(sel)
    await activate(sel)
}

/** 状态行：连接探测（3s 超时）+ 登录态徽章 + 身份名 */
async function paintConnStatus(): Promise<void> {
    const cfg = await getConfig()
    const dot = $('conn-dot')
    const url = $('conn-url')
    const badge = $('conn-badge')
    const state = $('conn-state')
    state.textContent = '检测中'
    url.textContent = cfg.serverUrl || '未配置'
    url.title = cfg.serverUrl
    if (cfg.token) {
        badge.textContent = `已登录 · ${cfg.accountName ?? '管理员'}`
        badge.classList.add('ok')
    } else {
        badge.textContent = '未登录'
        badge.classList.remove('ok')
    }
    if (!cfg.serverUrl) {
        dot.classList.remove('ok')
        state.textContent = '未配置'
        return
    }
    try {
        const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(3000) })
        const body = (await res.json()) as { ok: boolean; registrationOpen?: boolean }
        const current = await getConfig()
        if (current.serverUrl !== cfg.serverUrl || current.token !== cfg.token) return
        const online = res.ok && body.ok === true
        dot.classList.toggle('ok', online)
        state.textContent = online ? '已连接' : '服务异常'
        // D73：与管理台同一注册策略；旧服务端无此字段时保持入口可见（服务端仍最终校验）。
        ;($('cloud-show-register') as HTMLElement).style.display = body.registrationOpen === false ? 'none' : ''
        if (body.registrationOpen === false) {
            ;($('cloud-register') as HTMLElement).style.display = 'none'
            ;($('cloud-login-row') as HTMLElement).style.display = ''
        }
    } catch {
        const current = await getConfig()
        if (current.serverUrl !== cfg.serverUrl || current.token !== cfg.token) return
        dot.classList.remove('ok')
        state.textContent = '连接失败'
    }
}

/** D71：待同步状态行（本机队列积压 + 失败原因 → 可见的「为什么管理台没数据」） */
async function refreshInboxPending(): Promise<void> {
    browser.runtime.sendMessage(
        { type: 'inbox-status' },
        (res: { pending: number; lastError: string | null } | undefined) => {
            const el = $('inbox-pending') as HTMLElement
            if (res && res.pending > 0) {
                el.style.display = ''
                const why =
                    res.lastError?.includes('401') || res.lastError?.includes('unauthorized')
                        ? '未登录或令牌失效'
                        : (res.lastError ?? '未知原因')
                el.textContent = `⚠ ${res.pending} 条待同步（${why}）——登录后 1 分钟内自动恢复`
            } else {
                el.style.display = 'none'
            }
        },
    )
}
void refreshInboxPending()
setInterval(() => void refreshInboxPending(), 15000)
// D71：队列/失败记录变化即时刷新（事件驱动，成功补投后警告秒级消失，不等 15s 轮询）
browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.mfPendingOps || changes.mfInboxLastError)) void refreshInboxPending()
})

void (async () => {
    await loadEntries()
    const cfg = await getConfig()
    const initial =
        cfg.serverUrl && (cfg.serverUrl === OFFICIAL_CLOUD_URL || entries.some(s => s.url === cfg.serverUrl))
            ? cfg.serverUrl
            : (entries[0]?.url ?? OFFICIAL_CLOUD_URL)
    renderSelect(initial)
    await activate(initial)
})()

$('server-select').addEventListener('change', () => void selectChanged())

// ---------- 添加服务端（探测 /healthz 自动判定形态） ----------
$('add-save').addEventListener('click', async () => {
    const el = $('msg-add')
    const raw = ($('add-url') as HTMLInputElement).value.trim().replace(/\/$/, '')
    if (!/^https?:\/\/[^\s/]+$/.test(raw)) {
        msg(el, '地址需以 http:// 或 https:// 开头', false)
        return
    }
    if (raw === OFFICIAL_CLOUD_URL || entries.some(s => s.url === raw)) {
        msg(el, '该服务已在列表中', false)
        return
    }
    msg(el, '探测中…')
    // 探测链沿用测试连接经验：原地址 → localhost 换 127.0.0.1（避开 IPv6 ::1 解析/代理 bypass 问题）
    const candidates = [raw]
    if (raw.includes('localhost')) candidates.push(raw.replace('localhost', '127.0.0.1'))
    let mode: 'self' | 'cloud' | null = null
    let finalUrl = raw
    let lastErr = ''
    for (const base of candidates) {
        try {
            const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(4000) })
            const body = (await res.json()) as { ok?: boolean; deployMode?: string }
            if (body.ok) {
                finalUrl = base
                mode = body.deployMode === 'cloud' ? 'cloud' : 'self'
                break
            }
            lastErr = `HTTP ${res.status}`
        } catch (err) {
            lastErr = err instanceof Error ? err.message : String(err)
        }
    }
    if (!mode) {
        msg(el, `❌ 无法连接：${lastErr}（确认服务端已启动、地址正确）`, false)
        return
    }
    const label = ($('add-label') as HTMLInputElement).value.trim() || hostOf(finalUrl)
    entries.push({ url: finalUrl, label, mode })
    await saveConfig({ servers: entries })
    msg(el, '已添加服务，请使用用户名与密码登录')
    renderSelect(finalUrl)
    await activate(finalUrl)
})

$('add-toggle').addEventListener('click', () => {
    const showing = ($('panel-add') as HTMLElement).style.display !== 'none'
    $('add-toggle').setAttribute('aria-expanded', String(!showing))
    if (showing) {
        ;($('panel-add') as HTMLElement).style.display = 'none'
        ;($('panel-account') as HTMLElement).style.display = ''
        void renderAccount()
    } else {
        ;($('panel-add') as HTMLElement).style.display = ''
        ;($('panel-account') as HTMLElement).style.display = 'none'
        msg($('msg-add'), '')
    }
})

$('add-cancel').addEventListener('click', () => {
    renderSelect(lastActive)
    void activate(lastActive)
})

// ---------- 已选服务面板：打开管理台 / 测试连接 / 登录 / 删除 ----------

// 只带页面深链，不传递令牌；管理台保持独立登录。
async function openAdmin(hash: string, el: HTMLElement): Promise<void> {
    const { serverUrl } = await getConfig()
    if (!serverUrl) {
        msg(el, '请先添加服务端地址', false)
        return
    }
    try {
        await browser.tabs.create({ url: `${serverUrl.replace(/\/$/, '')}/#${hash}` })
    } catch (err) {
        msg(el, `无法打开管理台：${err instanceof Error ? err.message : String(err)}`, false)
    }
}

$('open-admin').addEventListener('click', () => void openAdmin('overview', $('msg-connect')))

$('test').addEventListener('click', async () => {
    const el = $('msg-connect')
    const cfg = await getConfig()
    const raw = cfg.serverUrl.replace(/\/$/, '')
    msg(el, '测试中…')

    /** 依次尝试：原地址 → localhost 换 127.0.0.1（避开 IPv6 ::1 解析/代理 bypass 问题） */
    const candidates = [raw]
    if (raw.includes('localhost')) {
        candidates.push(raw.replace('localhost', '127.0.0.1'))
    }
    let lastErr = ''
    for (const base of candidates) {
        try {
            const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(4000) })
            const body = (await res.json()) as { ok: boolean }
            if (body.ok) {
                msg(el, base === raw ? `✅ 连接成功：${base}` : `✅ 连接成功（${base} 可达）`)
                void refreshServerOverview()
                await paintConnStatus()
                return
            }
            lastErr = `HTTP ${res.status}`
        } catch (err) {
            lastErr = err instanceof Error ? err.message : String(err)
        }
    }
    const hint =
        lastErr.includes('Failed to fetch') || lastErr.includes('NetworkError')
            ? '网络层失败。排查：① Docker 服务端是否启动 ② 系统代理请将本地地址加入直连 ③ 换 127.0.0.1:端口 试试'
            : `服务端异常：${lastErr}`
    msg(el, `❌ ${hint}`, false)
})

// D70 切换账号：撤销当前令牌（服务端）+ 清本机记忆 → 回到登录表单
$('acct-switch').addEventListener('click', async () => {
    const cfg = await getConfig()
    try {
        await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/auth/logout`, {
            method: 'POST',
            headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
        })
    } catch {
        /* 离线也照常清本机 */
    }
    const tokens = { ...(cfg.serverTokens ?? {}) }
    delete tokens[cfg.serverUrl]
    await saveConfig({ token: '', serverTokens: tokens })
    await renderAccount()
    void refreshServerOverview()
    await paintConnStatus()
})

$('server-remove').addEventListener('click', async () => {
    const entry = entries.find(s => s.url === currentSel)
    const label = entry?.label ?? hostOf(currentSel)
    if (!window.confirm(`删除已保存的服务「${label}」？（只从列表移除并清除本机令牌，服务端数据不受影响）`)) return
    entries = entries.filter(s => s.url !== currentSel)
    const cfg = await getConfig()
    const tokens = { ...(cfg.serverTokens ?? {}) }
    delete tokens[currentSel]
    await saveConfig({
        servers: entries,
        serverTokens: tokens,
        serverUrl: OFFICIAL_CLOUD_URL,
        serverMode: 'cloud',
        activeServer: OFFICIAL_CLOUD_URL,
        token: tokens[OFFICIAL_CLOUD_URL] ?? '',
    })
    renderSelect(OFFICIAL_CLOUD_URL)
    await activate(OFFICIAL_CLOUD_URL)
})

// ---------- D68 统一账号表单（一切服务通用：用户名+密码；注册切换） ----------
$('cloud-show-register').addEventListener('click', () => {
    ;($('cloud-register') as HTMLElement).style.display = ''
    ;($('cloud-login-row') as HTMLElement).style.display = 'none'
    msg($('msg-cloud'), '')
})
$('cloud-back-login').addEventListener('click', () => {
    ;($('cloud-register') as HTMLElement).style.display = 'none'
    ;($('cloud-login-row') as HTMLElement).style.display = ''
    msg($('msg-cloud'), '')
})

$('cloud-login').addEventListener('click', async () => {
    const el = $('msg-cloud')
    const username = ($('cloud-user') as HTMLInputElement).value.trim()
    const password = ($('cloud-pw') as HTMLInputElement).value
    if (!username || !password) {
        msg(el, '请填写用户名与密码', false)
        return
    }
    msg(el, '登录中…')
    try {
        const r = await loginAccount(username, password)
        const cfg0 = await getConfig()
        await saveConfig({ serverTokens: { ...(cfg0.serverTokens ?? {}), [cfg0.serverUrl]: r.token } })
        await renderAccount() // D70：登录成功 → 表单整体隐藏，只留一行身份
        void refreshInboxPending()
        void refreshServerOverview()
        await paintConnStatus()
    } catch (e) {
        msg(el, `❌ ${cloudErrText(e)}`, false)
    }
})

$('cloud-register-btn').addEventListener('click', async () => {
    const el = $('msg-cloud')
    const username = ($('cloud-user') as HTMLInputElement).value.trim()
    const password = ($('cloud-pw') as HTMLInputElement).value
    const confirmPw = ($('cloud-pw2') as HTMLInputElement).value
    if (!username || !password) {
        msg(el, '请填写用户名与密码', false)
        return
    }
    if (password !== confirmPw) {
        msg(el, '两次输入的密码不一致', false)
        return
    }
    msg(el, '注册中…')
    try {
        const r = await registerAccount(username, password)
        const cfg0 = await getConfig()
        await saveConfig({ serverTokens: { ...(cfg0.serverTokens ?? {}), [cfg0.serverUrl]: r.token } })
        await renderAccount()
        void refreshServerOverview()
        await paintConnStatus()
    } catch (e) {
        msg(el, `❌ ${cloudErrText(e)}`, false)
    }
})

// ---------- D46 收藏夹双向同步（总开关 + 立即同步 + 状态行 + 删除保险丝确认） ----------
interface SyncInfoView {
    at?: number
    phase?: string
    ok?: boolean
    /** ok 正常 / retrying 重试中（拉取重试或出站待发送）/ pending_confirm 删除待确认 / error 失败或存在被拒绝的操作 */
    state?: 'ok' | 'retrying' | 'pending_confirm' | 'error'
    error?: string
    retryCount?: number
    /** 出站队列：已落盘待发送 / 待重试的操作数（opId 不变，成功回执才出队） */
    outboxCount?: number
    /** 被服务端终态拒绝的操作数（不会自愈，需看原因） */
    rejectedCount?: number
    /** 本轮按约定策略（库侧现值优先）处理的真实并发冲突数 */
    conflicts?: number
    pendingDeleteCount?: number
    deleteGuard?: { side: 'browser' | 'library'; count: number }
    stats?: Record<string, number | undefined>
    alignMs?: number
}
const syncMaster = $('sync-master')
const syncStatusLine = $('sync-status-line')
const guardRow = $('sync-guard-row')
let syncActionInFlight = false // 开关/立即同步进行中：禁止状态刷新覆写 checkbox

/** 单次同步结果的一句话结论（各处提示共用，避免「无论成败都说成功」） */
function syncOutcomeText(info: SyncInfoView | undefined): string {
    if (!info) return '✅ 同步完成'
    if (info.state === 'pending_confirm') return `⏸ 同步完成，${info.pendingDeleteCount ?? 0} 条删除等待你确认`
    if (info.state === 'retrying') {
        const n = (info.retryCount ?? 0) + (info.outboxCount ?? 0)
        return `🔄 同步完成，${n} 条变更尚未送达（将自动重试${info.error ? `：${info.error.slice(0, 60)}` : ''}）`
    }
    if (info.state === 'error') return `❌ ${info.error ?? '同步失败'}`
    return '✅ 同步完成'
}

function paintSyncStatus(info: SyncInfoView | undefined, on: boolean): void {
    if (!on) {
        syncStatusLine.textContent = '同步已关闭。开启后浏览器收藏夹将自动与管理台保持一致。'
        guardRow.style.display = 'none'
        return
    }
    const parts: string[] = []
    if (info?.at) parts.push(`上次同步 ${new Date(info.at).toLocaleString()}`)
    // 状态机如实呈现：待确认 / 重试中 / 被拒绝 / 失败，都不停留在「成功」假象上
    if (info?.state === 'pending_confirm') {
        parts.push(`⏸ ${info.pendingDeleteCount ?? 0} 条删除待确认`)
    } else if (info?.state === 'retrying') {
        const n = (info.retryCount ?? 0) + (info.outboxCount ?? 0)
        parts.push(`🔄 ${n} 条变更待重试${info.error ? `（${info.error.slice(0, 60)}）` : ''}`)
    } else if (info?.state === 'error' || (info && !info.ok && info.error !== 'sync_off')) {
        parts.push(`❌ ${info.error ?? '同步失败'}（被拒绝的操作不会自动重试，请检查后重新修改）`)
    }
    if ((info?.rejectedCount ?? 0) > 0 && info?.state !== 'error') parts.push(`⛔ ${info!.rejectedCount} 条操作被拒绝`)
    if ((info?.conflicts ?? 0) > 0) parts.push(`⚠ ${info!.conflicts} 处并发修改以管理台为准`)
    const s = info?.stats ?? {}
    const detail = [
        s.pulledApplied ? `库→浏览器 ${s.pulledApplied}` : '',
        s.pushedOk ? `浏览器→库 ${s.pushedOk}` : '',
        s.createdInBrowser ? `浏览器新建 ${s.createdInBrowser}` : '',
        s.deletedBrowser ? `浏览器删除 ${s.deletedBrowser}` : '',
        s.deletedLibrary ? `库删除 ${s.deletedLibrary}` : '',
    ]
        .filter(Boolean)
        .join(' · ')
    if (detail) parts.push(detail)
    if (info?.phase === 'align' && info.alignMs) parts.push(`对齐耗时 ${(info.alignMs / 1000).toFixed(1)}s`)
    syncStatusLine.textContent = parts.length > 0 ? parts.join(' ｜ ') : '同步已开启，等待首次收敛…'
    if (info?.deleteGuard || info?.state === 'pending_confirm') {
        guardRow.style.display = 'flex'
        const count = info?.deleteGuard?.count ?? info?.pendingDeleteCount ?? 0
        const side = info?.deleteGuard?.side === 'browser' ? '浏览器侧' : '库侧'
        msg($('msg-sync'), `⚠️ 检测到 ${count} 条${side}批量删除，已暂停以防误删。确认无误后点下方按钮放行。`, false)
    } else {
        guardRow.style.display = 'none'
    }
}

async function refreshSyncStatus(): Promise<void> {
    await browser.runtime.sendMessage(
        { type: 'sync-status' },
        (res: { on?: boolean; info?: SyncInfoView } | undefined) => {
            if (!syncActionInFlight) syncMaster.checked = res?.on === true
            paintSyncStatus(res?.info, syncMaster.checked)
        },
    )
}
void refreshSyncStatus()

syncMaster.addEventListener('change', async () => {
    const on = syncMaster.checked
    syncActionInFlight = true
    msg($('msg-sync'), on ? '正在全量对齐（首次可能需数十秒，请勿关闭本页）…' : '正在关闭…')
    // sendMessage 带回调时返回 undefined（非 Promise）——await 会立即 resolve，
    // 状态刷新必须放回调内（响应到达后），否则读到旧 SyncInfo
    await browser.runtime.sendMessage(
        { type: 'sync-set', on },
        (res: { info?: SyncInfoView; error?: string } | undefined) => {
            if (!res || res.error) {
                msg($('msg-sync'), `❌ ${res?.error ?? '同步服务不可达（先测试连接）'}`, false)
                syncActionInFlight = false
                void refreshSyncStatus()
                return
            }
            // 开启动作：收敛正常 → 明确「已开启并完成全量对齐」（含「同步完成」，兼容既有轮询断言）；
            // 未完全收敛 → 如实带出待重试/待确认
            const onText =
                res.info?.state === 'retrying' || res.info?.state === 'pending_confirm' || res.info?.state === 'error'
                    ? `已开启，${syncOutcomeText(res.info)}`
                    : '✅ 已开启并完成全量对齐，同步完成'
            msg($('msg-sync'), on ? onText : '✅ 已关闭同步（浏览器现有书签保留）')
            setTimeout(() => ($('msg-sync').textContent = ''), on ? 8000 : 3000)
            syncActionInFlight = false
            void refreshSyncStatus()
        },
    )
})

$('sync-now').addEventListener('click', () => {
    syncActionInFlight = true
    msg($('msg-sync'), '同步中…')
    void browser.runtime.sendMessage(
        { type: 'sync-now' },
        (res: { info?: SyncInfoView; error?: string } | undefined) => {
            if (!res || res.error) {
                msg($('msg-sync'), `❌ ${res?.error ?? '同步服务不可达'}`, false)
                syncActionInFlight = false
                void refreshSyncStatus()
                return
            }
            msg($('msg-sync'), syncOutcomeText(res.info))
            setTimeout(() => ($('msg-sync').textContent = ''), 6000)
            syncActionInFlight = false
            void refreshSyncStatus()
        },
    )
})

$('sync-confirm-delete').addEventListener('click', () => {
    msg($('msg-sync'), '正在执行确认的批量删除…')
    // 按确认范围执行：结果如实反馈——未完成的删除留在出站队列自动重试，不谎报「已放行」
    void browser.runtime.sendMessage(
        { type: 'sync-now', confirmDeletes: true },
        (res: { info?: SyncInfoView; error?: string } | undefined) => {
            if (!res || res.error) {
                msg($('msg-sync'), `❌ ${res?.error ?? '同步服务不可达，删除未执行'}`, false)
            } else {
                const info = res.info
                if (info?.state === 'retrying')
                    msg(
                        $('msg-sync'),
                        `🔄 已按确认范围提交删除，${(info.retryCount ?? 0) + (info.outboxCount ?? 0)} 条尚未完成（将自动重试）`,
                    )
                else if (info?.state === 'pending_confirm')
                    msg($('msg-sync'), `⏸ 已执行确认的删除，仍有 ${info.pendingDeleteCount ?? 0} 条待确认`)
                else if (info?.state === 'error') msg($('msg-sync'), `❌ ${info.error ?? '部分删除未完成'}`, false)
                else msg($('msg-sync'), '✅ 已按确认范围删除并完成同步')
            }
            setTimeout(() => ($('msg-sync').textContent = ''), 6000)
            void refreshSyncStatus()
        },
    )
})

$('inbox').addEventListener('click', async () => {
    const el = $('msg-inbox')
    await browser.runtime.sendMessage({ type: 'setup-inbox' }, () => {
        msg(el, '✅ 收纳盒已创建（书签栏可见「📥 收纳盒」）')
    })
})

// ---------- 原型 07：投递口位置 / 立即清扫 ----------
const parentSel = $('inbox-parent') as unknown as HTMLSelectElement

async function loadInboxParent(): Promise<void> {
    const { inboxParent } = await browser.storage.local.get(['inboxParent'])
    parentSel.value = (inboxParent as string) ?? '1'
}
void loadInboxParent()

parentSel.addEventListener('change', async () => {
    await browser.storage.local.set({ inboxParent: parentSel.value })
    await browser.runtime.sendMessage({ type: 'setup-inbox' }, () => {
        msg($('msg-inbox'), parentSel.value === '2' ? '✅ 已移到「其他书签」下' : '✅ 已移到书签栏')
    })
})

$('sweep').addEventListener('click', async () => {
    const el = $('msg-inbox')
    msg(el, '清扫中…')
    await browser.runtime.sendMessage({ type: 'sweep-inbox' }, (res: { moved?: number } | undefined) => {
        msg(el, `✅ 已归位 ${res?.moved ?? 0} 条（可在 popup「收纳盒」查看/撤销）`)
    })
})

// ---------- 管理台统一设置入口 ----------
$('open-notification-settings').addEventListener('click', () => void openAdmin('settings/notify', $('msg-settings')))
$('open-privacy-settings').addEventListener('click', () => void openAdmin('settings/privacy', $('msg-settings')))

// ---------- 自动概览：与连接探测并行，切服务/账号取消旧请求，失败可见 ----------
let overviewGeneration = 0
let overviewController: AbortController | undefined

async function refreshServerOverview(): Promise<void> {
    const generation = ++overviewGeneration
    overviewController?.abort()
    const controller = new AbortController()
    overviewController = controller
    const statsEl = $('stats')
    const modelEl = $('about-model')
    const refresh = $('refresh')
    const showStatsMessage = (text: string) => {
        const hint = document.createElement('p')
        hint.className = 'stats-message'
        hint.textContent = text
        statsEl.replaceChildren(hint)
    }
    refresh.disabled = true
    statsEl.setAttribute('aria-busy', 'true')
    showStatsMessage('正在加载概览…')
    modelEl.textContent = '正在加载…'

    try {
        const cfg = await getConfig()
        if (generation !== overviewGeneration) return
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
        const headers = cfg.token ? { Authorization: `Bearer ${cfg.token}` } : undefined
        // 同一次配置快照绑定地址与令牌，避免切服期间把旧令牌发往新服务。
        const read = async <T>(pathname: string): Promise<T> => {
            const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/api/v1${pathname}`, { headers, signal })
            if (!res.ok)
                throw new Error(
                    res.status === 401 || res.status === 403 ? '请先登录或重新登录' : `服务端返回 HTTP ${res.status}`,
                )
            return (await res.json()) as T
        }
        await Promise.all([
            (async () => {
                try {
                    const stats = await read<{ total: number; folders: number; navSites: number }>('/stats')
                    if (generation !== overviewGeneration) return
                    const items = [
                        ['书签', stats.total],
                        ['目录', stats.folders],
                        ['导航站', stats.navSites],
                    ] as const
                    statsEl.replaceChildren(
                        ...items.map(([label, value]) => {
                            const item = document.createElement('dl')
                            const term = document.createElement('dt')
                            const count = document.createElement('dd')
                            term.textContent = label
                            count.textContent = String(value)
                            item.append(term, count)
                            return item
                        }),
                    )
                } catch (err) {
                    if (generation !== overviewGeneration) return
                    showStatsMessage(
                        `概览加载失败：${err instanceof Error ? err.message : String(err)}。可点击刷新重试。`,
                    )
                } finally {
                    if (generation === overviewGeneration) statsEl.setAttribute('aria-busy', 'false')
                }
            })(),
            (async () => {
                try {
                    const rows =
                        await read<Array<{ purpose_models: Record<string, string>; enabled: number }>>(
                            '/settings/providers',
                        )
                    if (generation !== overviewGeneration) return
                    const active = rows.find(r => r.enabled === 1)
                    const model = active
                        ? (active.purpose_models['organize'] ?? Object.values(active.purpose_models)[0])
                        : null
                    modelEl.textContent = model ?? '未配置，使用规则引擎'
                } catch (err) {
                    if (generation !== overviewGeneration) return
                    modelEl.textContent = `暂不可用：${err instanceof Error ? err.message : String(err)}`
                }
            })(),
        ])
    } catch (err) {
        if (generation !== overviewGeneration) return
        const reason = err instanceof Error ? err.message : String(err)
        showStatsMessage(`概览加载失败：${reason}`)
        modelEl.textContent = `暂不可用：${reason}`
    } finally {
        if (generation === overviewGeneration) {
            refresh.disabled = false
            statsEl.setAttribute('aria-busy', 'false')
        }
    }
}

$('refresh').addEventListener('click', () => void refreshServerOverview())
$('about-version').textContent = `扩展 v${browser.runtime.getManifest().version}`
