/**
 * 应用壳：探活 → 鉴权探测 → 登录门 / 管理台。
 * hash 路由：#tab?key=value（概览数字卡钻取、报告→整理中心带话术等均走它）。
 * 演示模式（?mock / VITE_MOCK=1）：mock 层接管全部网络请求，无服务端直接进入。
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Shell, useRoute, useShell, type TabKey } from '@/components/layout'

import { Btn, EmptyState, PageScroll } from '@/components/shared'
import { LoginPage } from '@/pages/login'
import { Overview } from '@/pages/overview'
import { Library } from '@/pages/library'
import { Materials } from '@/pages/materials'
import { NavSites } from '@/pages/navsites'
import { Settings } from '@/pages/settings'
import { MODULES, type ModuleId } from '@/lib/modules'
import { loadConfig, probeAuthorized, probeHealth, saveServerUrl, type AdminConfig } from '@/lib/api'

type Phase = 'probe' | 'login' | 'ready' | 'offline'

export function App() {
    const [cfg, setCfgState] = useState<AdminConfig>(loadConfig)
    const [phase, setPhase] = useState<Phase>('probe')

    const setCfg = useCallback((c: AdminConfig) => {
        saveServerUrl(c.serverUrl)
        setCfgState(c)
    }, [])

    const probe = useCallback(async () => {
        const health = await probeHealth(cfg.serverUrl)
        if (!health) {
            setPhase('offline')
            return
        }
        const authz = await probeAuthorized(cfg)
        setPhase(authz === 'authed' ? 'ready' : 'login')
    }, [cfg])

    useEffect(() => {
        void probe()
    }, [probe])

    if (phase === 'probe') {
        return (
            <div className="text-muted-foreground flex min-h-screen items-center justify-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" />
                正在连接 {cfg.serverUrl} …
            </div>
        )
    }

    if (phase === 'offline') {
        return (
            <div className="text-foreground flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
                <div className="flex size-14 items-center justify-center rounded-2xl border bg-muted text-2xl shadow-sm">
                    📡
                </div>
                <div>
                    <p className="font-semibold">连不上服务端</p>
                    <p className="text-muted-foreground mx-auto mt-1.5 max-w-sm text-xs leading-relaxed">
                        确认服务端已启动（自建端：
                        <code className="font-mono">docker compose -f docker/docker-compose.dev.yml up</code>），
                        或者检查一下服务端地址。也可以先去{' '}
                        <a className="text-primary hover:underline" href="?mock">
                            演示模式
                        </a>{' '}
                        逛逛界面。
                    </p>
                </div>
                <div className="flex gap-2">
                    <button
                        className="hover:bg-accent rounded-lg border px-3 py-1.5 text-sm transition-colors"
                        onClick={() => void probe()}
                    >
                        重试
                    </button>
                    <button
                        className="bg-primary text-primary-foreground hover:bg-primary-hover rounded-lg px-3 py-1.5 text-sm transition-colors"
                        onClick={() => setPhase('login')}
                    >
                        修改连接
                    </button>
                </div>
            </div>
        )
    }

    if (phase === 'login') {
        return (
            <LoginPage
                cfg={cfg}
                onSaveConfig={setCfg}
                onAuthed={() => {
                    void probe()
                }}
            />
        )
    }

    return (
        <Shell cfg={cfg} setCfg={setCfg}>
            <RoutePages />
        </Shell>
    )
}

/** 页签 → 所属模块；模块关闭时给引导页而不是 404 */
const TAB_MODULE: Partial<Record<TabKey, ModuleId>> = {
    nav: 'navsite',
}

function RoutePages() {
    const { tab } = useRoute()
    const { modules } = useShell()
    const need = TAB_MODULE[tab]
    if (need && !modules[need]) {
        const def = MODULES.find(m => m.id === need)
        return (
            <PageScroll>
                <EmptyState
                    icon="🧩"
                    title={`「${def?.title ?? need}」模块未开启`}
                    hint="在设置 → 功能模块里打开后，这里就会出现对应内容。历史数据不会丢失。"
                    action={
                        <Btn primary onClick={() => (location.hash = '#settings')}>
                            去开启
                        </Btn>
                    }
                />
            </PageScroll>
        )
    }
    // 兜底：未注册页签（如已回滚的独立 #inbox）落回概览，杜绝白屏死路由
    return (
        <>
            {tab === 'bookmarks' && <Library />}
            {tab === 'materials' && <Materials />}
            {tab === 'nav' && <NavSites />}
            {tab === 'settings' && <Settings />}
            {(tab === 'overview' || !['bookmarks', 'materials', 'nav', 'settings'].includes(tab)) && <Overview />}
        </>
    )
}
