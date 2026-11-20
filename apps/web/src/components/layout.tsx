/**
 * 应用外壳：小而美的个人工具，不是「页面里套个 app」。
 * 顶部一条轻导航（品牌 + 横向页签 + 状态），下面是居中窄栏、随页面自然滚动——
 * 没有固定高度窗格、没有内部滚动条、没有点阵画布和悬浮卡片。
 * 路由用 location.hash：#tab?key=value，刷新/前进后退均可恢复。
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  BookMarked,
  Globe,
  House,
  Search,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { syncNotifyStyle, Toaster } from "@/components/shared";
import { CommandPalette } from "@/components/command-palette";
import { isMock } from "@/lib/mock";
import { loadModules, saveModules, type ModuleId, type ModuleState } from "@/lib/modules";
import {
  fetchers,
  probeHealth,
  type AdminConfig,
  type FolderTreeNode,
} from "@/lib/api";

export const TAB_KEYS = ["overview", "bookmarks", "inbox", "nav", "settings"] as const;
export type TabKey = (typeof TAB_KEYS)[number];

export interface Route {
  tab: TabKey;
  sub?: string; // 二级页：如 #settings/connection
  params: URLSearchParams;
}

function readRoute(): Route {
  const raw = location.hash.replace(/^#/, "");
  const [path, query = ""] = raw.split("?");
  const [name, sub] = (path ?? "").split("/");
  const tab = name as TabKey;
  return {
    tab: TAB_KEYS.includes(tab) ? tab : "overview",
    sub,
    params: new URLSearchParams(query),
  };
}

export const RouteContext = createContext<
  Route & { go: (tab: TabKey, params?: Record<string, string>, sub?: string) => void }
>({
  ...readRoute(),
  go: () => {},
});
export const useRoute = () => useContext(RouteContext);

export interface Badges {
  inbox: number;
}

interface ShellState {
  cfg: AdminConfig;
  setCfg: (c: AdminConfig) => void;
  serverInfo: { ok: boolean; form: string; version: string } | null;
  connected: boolean;
  badges: Badges;
  refreshBadges: () => void;
  modules: ModuleState;
  setModules: (m: ModuleState) => void;
}

export const ShellContext = createContext<ShellState>({
  cfg: { serverUrl: "", token: "" },
  setCfg: () => {},
  serverInfo: null,
  connected: false,
  badges: { inbox: 0 },
  refreshBadges: () => {},
  modules: loadModules(),
  setModules: () => {},
});
export const useShell = () => useContext(ShellContext);

// 收纳盒不设独立页签（昨日定案）：它是书签库内置视图，随 core 存在——
// 入口 = 书签页左树置顶「📥 收纳盒」节点（带待处理角标）+ 首页自动化动态；见 lib/modules.ts 注释。
const NAV: Array<{ key: TabKey; label: string; icon: typeof House; module?: ModuleId }> = [
  { key: "overview", label: "今天", icon: House },
  { key: "bookmarks", label: "书签", icon: BookMarked },
  { key: "nav", label: "导航站", icon: Globe, module: "navsite" },
];

export function Shell({
  cfg,
  setCfg,
  children,
}: {
  cfg: AdminConfig;
  setCfg: (c: AdminConfig) => void;
  children: ReactNode;
}) {
  const [route, setRoute] = useState<Route>(readRoute);
  const [serverInfo, setServerInfo] = useState<ShellState["serverInfo"]>(null);
  const [connected, setConnected] = useState(false);
  const [badges, setBadges] = useState<Badges>({ inbox: 0 });
  const [modules, setModulesState] = useState<ModuleState>(loadModules);
  // 全局命令面板（Ctrl/⌘+K）：全局可达的搜索，不占版面
  const [paletteOpen, setPaletteOpen] = useState(false);
  const mock = isMock();

  const setModules = useCallback((m: ModuleState) => {
    saveModules(m);
    setModulesState(m);
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Ctrl/⌘+K 呼出全局搜索（任何页可达）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = useCallback((tab: TabKey, params?: Record<string, string>, sub?: string) => {
    const p = new URLSearchParams(params ?? {});
    const target = `#${tab}${sub ? `/${sub}` : ""}${p.size > 0 ? `?${p}` : ""}`;
    if (location.hash === target) setRoute(readRoute());
    else location.hash = target;
  }, []);

  // 角标计数（导航上的活数字：收纳盒待处理）
  const refreshBadges = useCallback(() => {
    fetchers
      .folderTree(cfg)
      .then((tree: FolderTreeNode[]) => {
        const inbox = tree.find((f) => f.is_system_inbox === 1);
        setBadges({ inbox: inbox?.totalCount ?? 0 });
      })
      .catch(() => {});
  }, [cfg]);

  useEffect(() => {
    probeHealth(cfg.serverUrl).then((info) => {
      setServerInfo(info);
      setConnected(Boolean(info?.ok));
    });
  }, [cfg.serverUrl]);
  useEffect(refreshBadges, [refreshBadges]);
  // D28：boot 同步通知方式进缓存（整理成功提示按档位过滤）
  useEffect(() => {
    void syncNotifyStyle(cfg);
  }, [cfg]);

  const badgeOf = (key: TabKey): number | null => {
    if (key === "inbox") return badges.inbox > 0 ? badges.inbox : null;
    return null;
  };

  const navBtn = (key: TabKey, label: string, Icon: typeof House) => {
    const n = badgeOf(key);
    const active = route.tab === key;
    return (
      <button
        key={key}
        onClick={() => go(key)}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors",
          active
            ? "bg-primary font-medium text-primary-foreground"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        <span>{label}</span>
        {n !== null && (
          <span
            className={cn(
              "rounded-full px-1.5 text-center text-[10px] leading-4 font-bold",
              key === "inbox" ? "bg-foreground text-background" : "bg-destructive/10 text-destructive",
            )}
          >
            {n}
          </span>
        )}
      </button>
    );
  };

  const visibleNav = NAV.filter((n) => !n.module || modules[n.module]);

  return (
    <RouteContext.Provider value={{ ...route, go }}>
      <ShellContext.Provider value={{ cfg, setCfg, serverInfo, connected, badges, refreshBadges, modules, setModules }}>
        <div className="min-h-screen">
          {/* 顶部轻导航：logo 在上，导航在下 */}
          <header className="bg-background/85 sticky top-0 z-40 border-b border-border/60 backdrop-blur">
            <div className="mx-auto w-full max-w-[920px] px-5 pt-3">
              <div className="flex h-12 items-center justify-between">
                <div className="flex shrink-0 items-center">
                  <button className="flex shrink-0 items-center gap-2" onClick={() => go("overview")}>
                    {/* 品牌图形标（assets/brand/，D37）：三卡片阶梯，mark-color 透明底 */}
                    <img src="/brand/mark-color.svg" alt="" className="size-8 shrink-0" />
                    <span className="text-[14px] font-bold tracking-tight">my-favorites</span>
                  </button>
                  {mock && (
                    <span className="text-muted-foreground ml-2 rounded-full bg-muted px-1.5 py-px text-[10px]">演示</span>
                  )}
                </div>
                <span className="text-muted-foreground hidden items-center gap-1.5 text-[11px] sm:flex" title={serverInfo ? `v${serverInfo.version}` : undefined}>
                  <span className={cn("size-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-red-400")} />
                  {connected ? "已连接" : "未连接"}
                </span>
              </div>
              <nav className="mt-3 flex items-center gap-0.5 overflow-x-auto pb-4">
                {visibleNav.map(({ key, label, icon: Icon }) => navBtn(key, label, Icon))}
                <span className="flex-1" />
                <button
                  onClick={() => setPaletteOpen(true)}
                  title="全局搜索（Ctrl/⌘+K）"
                  className="text-muted-foreground hover:bg-accent/60 hover:text-foreground mr-1 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors"
                >
                  <Search className="size-3.5" /> 搜索
                  <kbd className="text-muted-foreground/60 rounded border px-1 text-[10px]">⌘K</kbd>
                </button>
                {navBtn("settings", "设置", Settings)}
              </nav>
            </div>
          </header>

          {/* 居中窄栏，自然滚动 */}
          <main className="pb-4">{children}</main>
        </div>
        <Toaster />
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} cfg={cfg} go={go} />
      </ShellContext.Provider>
    </RouteContext.Provider>
  );
}
