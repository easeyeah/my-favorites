/** my-favorites Web 管理台（F6.2）：概览/书签/整理/导航站/报告/设置 */
import { useCallback, useEffect, useState } from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Card as UiCard, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Copy,
  ExternalLink,
  FilePlus2,
  FolderInput,
  Globe,
  Link as LinkIcon,
  Loader2,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import "./index.css";

// ---------- API 基建 ----------
const configKey = "mf-admin-config";

interface AdminConfig {
  serverUrl: string;
  token: string;
}
function loadConfig(): AdminConfig {
  try {
    return { serverUrl: "http://127.0.0.1:3000", token: "", ...JSON.parse(localStorage.getItem(configKey) ?? "{}") };
  } catch {
    return { serverUrl: "http://127.0.0.1:3000", token: "" };
  }
}
function saveConfig(c: AdminConfig): void {
  localStorage.setItem(configKey, JSON.stringify(c));
}

async function api<T>(cfg: AdminConfig, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${cfg.serverUrl}/api/v1${path}`, {
    ...init,
    // 10 分钟兜底：维护任务（死链探测）是同步长任务，正常可达数分钟；
    // 无超时会让失败的请求永久挂起（表现为按钮永远"运行中"）
    signal: AbortSignal.timeout(10 * 60_000),
    headers: {
      "content-type": "application/json",
      ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      ...(init?.headers as Record<string, string>),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return (await res.json()) as T;
}

// ---------- 通用 UI（基于 shadcn/ui 组件的适配层，2026-11-18 起接入） ----------
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <UiCard className="gap-3 py-4">
      <CardHeader className="px-5">
        <CardTitle className="text-sm font-semibold text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-5">{children}</CardContent>
    </UiCard>
  );
}
function Stat({ num, label, bad }: { num: number | string; label: string; bad?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 text-center transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm">
      <div className={`text-3xl font-bold ${bad ? "text-red-500" : ""}`}>{num}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
/** 统一反馈条：成功/失败/进行中三态，带图标与色彩语义 */
function FeedbackBar({ msg }: { msg: { kind: "ok" | "err" | "busy"; text: string } | null }) {
  if (!msg) return null;
  const conf = {
    ok: { icon: <CheckCircle2 className="size-4 shrink-0" />, cls: "text-emerald-600 dark:text-emerald-400" },
    err: { icon: <AlertCircle className="size-4 shrink-0" />, cls: "text-red-500 dark:text-red-400" },
    busy: { icon: <Loader2 className="size-4 shrink-0 animate-spin" />, cls: "text-muted-foreground" },
  }[msg.kind];
  return (
    <p className={`mt-3 flex items-center gap-1.5 text-sm ${conf.cls}`}>
      {conf.icon}
      {msg.text}
    </p>
  );
}

/** 按钮适配层：保留管理台既有签名（primary/disabled/title），底层为 shadcn Button
 * （含 transition-all 渐变、hover 色变/阴影、active 按压缩放、focus-visible 焦点环） */
function Btn({
  children,
  onClick,
  primary,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <Button variant={primary ? "default" : "outline"} size="sm" onClick={onClick} disabled={disabled} title={title}>
      {children}
    </Button>
  );
}

interface Bookmark {
  id: string;
  title: string;
  url_canonical: string;
  status: string;
  folder_id: string;
  is_private: number;
}
interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  is_system_inbox: number;
}
interface FolderTreeNode extends Folder {
  directCount: number;
  totalCount: number;
}
interface ProposalAction {
  type: string;
  bookmarkTitle?: string;
  fromFolder?: string;
  toFolder?: string;
  mergeFrom?: string[];
  folderName?: string;
}

// ---------- 主应用 ----------
type TabKey = "overview" | "bookmarks" | "organize" | "nav" | "report" | "settings";

function Admin() {
  const [cfg, setCfg] = useState<AdminConfig>(loadConfig);
  // tab 持久化到 URL hash：刷新/前进后退都恢复当前页面（用户反馈）
  const TAB_KEYS: TabKey[] = ["overview", "bookmarks", "organize", "nav", "report", "settings"];
  const readTab = (): TabKey => {
    const h = location.hash.replace("#", "") as TabKey;
    return TAB_KEYS.includes(h) ? h : "overview";
  };
  const [tab, setTab] = useState<TabKey>(readTab);
  useEffect(() => {
    const onHash = () => setTab(readTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const switchTab = (key: TabKey) => {
    setTab(key);
    if (location.hash !== `#${key}`) history.replaceState(null, "", `#${key}`);
  };
  const [connected, setConnected] = useState(false);
  const refreshAll = useCallback(() => {
    fetch(`${cfg.serverUrl}/healthz`)
      .then((r) => r.json())
      .then((b: { ok: boolean }) => setConnected(b.ok))
      .catch(() => setConnected(false));
  }, [cfg.serverUrl]);
  useEffect(refreshAll, [refreshAll]);

  const tabs: Array<[TabKey, string]> = [
    ["overview", "概览"],
    ["bookmarks", "书签"],
    ["organize", "整理"],
    ["nav", "导航站"],
    ["report", "报告"],
    ["settings", "设置"],
  ];

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-xl font-bold">my-favorites 管理台</h1>
        <Badge variant={connected ? "success" : "destructive"} className="gap-1.5 px-3 py-1">
          <span className={`size-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`} />
          {connected ? "已连接" : "未连接"}
        </Badge>
      </header>
      <nav className="mt-4 flex gap-1">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            onClick={() => switchTab(key)}
            className={`rounded-lg px-4 py-2 text-sm transition-all duration-200 ${tab === key ? "bg-indigo-600 text-white shadow-xs" : "hover:bg-accent hover:-translate-y-px"}`}
          >
            {label}
          </button>
        ))}
      </nav>
      <main className="mt-5">
        {tab === "overview" && <Overview cfg={cfg} />}
        {tab === "bookmarks" && <Bookmarks cfg={cfg} />}
        {tab === "organize" && <Organize cfg={cfg} />}
        {tab === "nav" && <NavSites cfg={cfg} />}
        {tab === "report" && <Report cfg={cfg} />}
        {tab === "settings" && (
          <Settings
            cfg={cfg}
            onSave={(c) => {
              saveConfig(c);
              setCfg(c);
              refreshAll();
            }}
          />
        )}
      </main>
    </div>
  );
}

function Overview({ cfg }: { cfg: AdminConfig }) {
  const [stats, setStats] = useState<{ total: number; dead: number; suspect: number; folders: number; navSites: number } | null>(null);
  const [report, setReport] = useState<{ dead: number; duplicates: number; stale: number } | null>(null);
  useEffect(() => {
    api<typeof stats>(cfg, "/stats").then(setStats).catch(() => setStats(null));
    api<typeof report>(cfg, "/health-report").then(setReport).catch(() => setReport(null));
  }, [cfg]);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat num={stats?.total ?? "–"} label="书签总数" />
      <Stat num={stats?.folders ?? "–"} label="目录数" />
      <Stat num={stats?.dead ?? "–"} label="死链" bad={(stats?.dead ?? 0) > 0} />
      <Stat num={report?.duplicates ?? "–"} label="重复组" bad={(report?.duplicates ?? 0) > 0} />
      <div className="col-span-2 md:col-span-4">
        <Card title="快捷入口">
          <div className="flex flex-wrap gap-2">
            <Btn primary onClick={() => window.open(`${cfg.serverUrl}/health-report`, "_blank")}>
              <BarChart3 /> 体检报告页
            </Btn>
            <Btn onClick={() => api(cfg, "/crawl/run", { method: "POST", body: "{}" })}>
              <Globe /> 立即补漏抓取
            </Btn>
            <Btn onClick={() => api(cfg, "/maintenance/links/run", { method: "POST", body: "{}" })}>
              <LinkIcon /> 立即死链检测
            </Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Bookmarks({ cfg }: { cfg: AdminConfig }) {
  const [items, setItems] = useState<Bookmark[]>([]);
  const [folders, setFolders] = useState<FolderTreeNode[]>([]);
  const [selected, setSelected] = useState<string | "all">("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Bookmark | null>(null);
  const PAGE = 100;

  const loadTree = useCallback(() => {
    // 目录树 + 计数：服务端聚合（GROUP BY），上万书签也是一次轻查询
    api<FolderTreeNode[]>(cfg, "/folders/tree").then(setFolders).catch(() => setFolders([]));
  }, [cfg]);

  /** 按需分页拉取当前视图（目录 or 全部）——不拉全量 */
  const loadPage = useCallback(
    async (view: string | "all", offset: number, append: boolean): Promise<void> => {
      const query =
        view === "all"
          ? `limit=${PAGE}&offset=${offset}`
          : `folderId=${encodeURIComponent(view)}&limit=${PAGE}&offset=${offset}`;
      try {
        const batch = await api<Bookmark[]>(cfg, `/bookmarks?${query}`);
        setItems((prev) => (append ? [...prev, ...batch] : batch));
        setHasMore(batch.length === PAGE);
      } catch {
        if (!append) setItems([]);
        setHasMore(false);
      }
    },
    [cfg],
  );

  const selectFolder = (id: string | "all") => {
    setSelected(id);
    setSearching(false);
    void loadPage(id, 0, false);
  };

  // 初始：树 + 全部第一页
  useEffect(() => {
    loadTree();
    void loadPage("all", 0, false);
  }, [loadTree, loadPage]);

  const folderName = (id: string) => folders.find((f) => f.id === id)?.name ?? "未整理";
  const childrenOf = (parentId: string | null) =>
    folders.filter((f) => f.parent_id === parentId && !f.is_system_inbox);

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doSearch = async () => {
    if (!q.trim()) {
      selectFolder("all");
      return;
    }
    setSearching(true);
    const res = await api<{ results: Bookmark[] }>(cfg, `/search?q=${encodeURIComponent(q)}`);
    setItems(res.results);
    setHasMore(false);
  };

  const visible = items;

  const renderNode = (folder: FolderTreeNode, depth: number): React.ReactNode => {
    const kids = childrenOf(folder.id);
    const isCollapsed = collapsed.has(folder.id);
    const descendantCount = folder.totalCount; // 服务端聚合（含子孙）
    return (
      <div key={folder.id}>
        <div
          className={`flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 hover:bg-accent ${selected === folder.id && !searching ? "bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-950" : ""}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => selectFolder(folder.id)}
        >
          {kids.length > 0 ? (
            <button
              className="w-4 shrink-0 text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                toggle(folder.id);
              }}
            >
              {isCollapsed ? "▸" : "▾"}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <span className="truncate">{folder.name}</span>
          <span className="ml-auto text-xs text-muted-foreground">{descendantCount}</span>
        </div>
        {!isCollapsed && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  const roots = childrenOf(null);
  const totalCount = folders
    .filter((f) => !f.is_system_inbox && f.parent_id === null)
    .reduce((sum, f) => sum + f.totalCount, 0);

  const remove = (b: Bookmark) => {
    void api(cfg, `/bookmarks/${b.id}`, { method: "DELETE" }).then(() => {
      setPendingDelete(null);
      loadTree();
      if (searching) void doSearch();
      else void loadPage(selected, 0, false);
    });
  };

  return (
    <Card title={`书签管理（${visible.length} 条${hasMore ? "+" : ""}${searching ? " · 搜索结果" : selected === "all" ? " · 全部" : ` · ${folderName(selected)}`}）`}>
      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="搜索书签 / 正文（回车）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={() => void doSearch()}
          />
        </div>
        <Btn onClick={() => void doSearch()}>
          <Search /> 搜索
        </Btn>
        <Btn onClick={() => selectFolder("all")}>全部</Btn>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[240px_1fr]">
        {/* 左：目录树（计数来自服务端聚合） */}
        <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-border p-2">
          <div
            className={`flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 hover:bg-accent ${selected === "all" && !searching ? "bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-950" : ""}`}
            onClick={() => selectFolder("all")}
          >
            <span className="w-4 shrink-0" />
            <span>全部书签</span>
            <span className="ml-auto text-xs text-muted-foreground">{totalCount}</span>
          </div>
          {roots.map((r) => renderNode(r, 0))}
        </div>
        {/* 右：当前视图书签（按需分页） */}
        <div className="max-h-[60vh] overflow-y-auto">
          {visible.map((b) => (
            <div key={b.id} className="flex items-center gap-3 border-b border-border py-2.5 last:border-0">
              <a className="min-w-0 flex-1 truncate text-sm hover:underline" href={b.url_canonical} target="_blank" rel="noreferrer" title={b.title}>
                {b.is_private ? (
                  <span title="实验性：仅隐藏显示，未做二次验证或加密（决策 D19）">🔒</span>
                ) : null}
                {b.title}
              </a>
              {(searching || selected === "all") && (
                <span className="shrink-0 text-xs text-muted-foreground">{folderName(b.folder_id)}</span>
              )}
              {b.status !== "normal" && (
                <Badge variant={b.status === "dead" ? "destructive" : "warning"} className="shrink-0">
                  {b.status === "dead" ? "死链" : "疑似"}
                </Badge>
              )}
              <button
                className="text-destructive hover:text-destructive/80 shrink-0 rounded p-1 transition-colors hover:bg-red-50 dark:hover:bg-red-950"
                title="删除书签"
                onClick={() => setPendingDelete(b)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          {visible.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {searching ? "无搜索结果" : "该目录下暂无书签"}
            </p>
          )}
          {hasMore && !searching && (
            <div className="py-3 text-center">
              <Btn onClick={() => void loadPage(selected, items.length, true)}>加载更多</Btn>
            </div>
          )}
        </div>
      </div>

      {/* 删除确认（对话框替代原生 confirm：不可逆操作显式二次确认） */}
      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="text-destructive size-5" />
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
            <Button variant="destructive" size="sm" onClick={() => pendingDelete && remove(pendingDelete)}>
              <Trash2 /> 删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Organize({ cfg }: { cfg: AdminConfig }) {
  const [message, setMessage] = useState("");
  const [answer, setAnswer] = useState("");
  const [proposal, setProposal] = useState<ProposalAction[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);

  const send = async () => {
    if (!message.trim()) return;
    const res = await api<{ sessionId: string; answer: string; proposal: ProposalAction[] | null }>(cfg, "/organize/sessions", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    setAnswer(res.answer);
    setProposal(res.proposal);
    setSessionId(res.sessionId);
    setMessage("");
  };
  const apply = async () => {
    if (!sessionId) return;
    const res = await api<{ versionId: string; applied: number }>(cfg, `/organize/sessions/${sessionId}/apply`, { method: "POST" });
    setVersionId(res.versionId);
    setAnswer(`✅ 已应用 ${res.applied} 项变更（版本 ${res.versionId.slice(0, 8)}…）`);
    setProposal(null);
  };
  const rollback = async () => {
    if (!versionId) return;
    const res = await api<{ reversed: number }>(cfg, `/organize/rollback/${versionId}`, { method: "POST" });
    setAnswer(`↩️ 已回滚 ${res.reversed} 项`);
    setVersionId(null);
  };

  return (
    <Card title="AI 聊天整理">
      <div className="bg-accent/40 flex min-h-16 items-start gap-2 rounded-lg p-3 text-sm">
        <Sparkles className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <span>{answer || "输入指令，例如：「整理」「合并重复」「整理 开发 文件夹」"}</span>
      </div>
      {proposal && proposal.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg border border-border p-3 text-xs">
          {proposal.map((a, i) => (
            <li key={i} className="flex items-center gap-1.5">
              {a.type === "move" && (
                <>
                  <FolderInput className="text-muted-foreground size-3.5 shrink-0" />
                  「{a.bookmarkTitle}」{a.fromFolder} → {a.toFolder}
                </>
              )}
              {a.type === "merge" && (
                <>
                  <Copy className="text-muted-foreground size-3.5 shrink-0" />
                  合并 {a.mergeFrom?.length ?? 0} 条到「{a.bookmarkTitle}」
                </>
              )}
              {a.type === "createFolder" && (
                <>
                  <FilePlus2 className="text-muted-foreground size-3.5 shrink-0" />
                  新建「{a.folderName}」
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {proposal && proposal.length > 0 && (
        <div className="mt-2">
          <Btn primary onClick={() => void apply()}>
            <ShieldCheck /> 应用变更
          </Btn>
        </div>
      )}
      {versionId && (
        <div className="mt-2">
          <Btn onClick={() => void rollback()}>
            <RotateCcw /> 回滚上次整理
          </Btn>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Input
          value={message}
          placeholder="告诉我要怎么整理…"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={() => void send()}
        />
        <Btn primary onClick={() => void send()}>
          <Send /> 发送
        </Btn>
      </div>
    </Card>
  );
}

function NavSites({ cfg }: { cfg: AdminConfig }) {
  const [sites, setSites] = useState<Array<{ slug: string; title: string; template: string }>>([]);
  const [title, setTitle] = useState("我的导航站");
  const [template, setTemplate] = useState("grid");
  const [password, setPassword] = useState("");
  const load = useCallback(() => {
    api<Array<{ slug: string; title: string; template: string }>>(cfg, "/nav/sites").then(setSites).catch(() => setSites([]));
  }, [cfg]);
  useEffect(load, [load]);

  const publish = async () => {
    await api(cfg, "/nav/publish", {
      method: "POST",
      body: JSON.stringify({ title, template, password: password || undefined }),
    });
    load();
  };
  const changeTemplate = async (slug: string, tpl: string) => {
    await api(cfg, `/nav/sites/${slug}`, { method: "PATCH", body: JSON.stringify({ template: tpl }) });
    load();
  };

  const TEMPLATE_LABELS: Record<string, string> = {
    grid: "经典宫格",
    list: "极简清单",
    cards: "卡片瀑布流",
    home: "个人主页",
  };

  return (
    <Card title="导航站（4 套模板）">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-48">
          <label className="text-muted-foreground mb-1 block text-xs">标题</label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="w-36">
          <label className="text-muted-foreground mb-1 block text-xs">模板</label>
          <Select value={template} onValueChange={setTemplate}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(TEMPLATE_LABELS).map(([v, label]) => (
                <SelectItem key={v} value={v}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-44">
          <label className="text-muted-foreground mb-1 block text-xs">访问密码（可选）</label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <Btn primary onClick={() => void publish()}>
          <Globe /> 发布
        </Btn>
      </div>
      <ul className="mt-4 space-y-2 text-sm">
        {sites.map((s) => (
          <li key={s.slug} className="hover:border-border/80 flex items-center justify-between rounded-lg border border-border p-3 transition-colors">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">「{s.title}」</span>
              <Badge variant="secondary">{TEMPLATE_LABELS[s.template] ?? s.template}</Badge>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <Select value={s.template} onValueChange={(v) => void changeTemplate(s.slug, v)}>
                <SelectTrigger size="sm" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TEMPLATE_LABELS).map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <a
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors hover:underline"
                href={`${cfg.serverUrl}/s/${s.slug}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="size-3.5" /> 打开
              </a>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Report({ cfg }: { cfg: AdminConfig }) {
  const [linkReport, setLinkReport] = useState<{ findings: { dead: number; suspect: number; normal: number; checked: number }; created_at: string } | null>(null);
  const [dupReport, setDupReport] = useState<{ findings: { groups: number; suggestions: Array<{ title: string }> } } | null>(null);
  const [running, setRunning] = useState<"links" | "dups" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "busy"; text: string } | null>(null);
  const [progress, setProgress] = useState<{
    total: number;
    checked: number;
    dead: number;
    suspect: number;
    normal: number;
    items: Array<{ i: number; title: string; host: string; verdict: "normal" | "suspect" | "dead" }>;
  } | null>(null);
  const load = useCallback(() => {
    api<typeof linkReport>(cfg, "/maintenance/report/latest?type=link_check").then(setLinkReport).catch(() => setLinkReport(null));
    api<typeof dupReport>(cfg, "/maintenance/report/latest?type=duplicate_scan").then(setDupReport).catch(() => setDupReport(null));
  }, [cfg]);
  useEffect(load, [load]);

  /** 运行维护任务：按钮即时反馈 + 错误可见（此前 void 吞错，点了像没反应） */
  const runTask = async (kind: "links" | "dups") => {
    if (running) return; // 防连点叠加任务
    setRunning(kind);
    if (kind === "links") {
      await runLinkCheckStream();
      return;
    }
    setMsg({ kind: "busy", text: "查重扫描运行中…" });
    try {
      await api(cfg, "/maintenance/duplicates/run", { method: "POST" });
      setMsg({ kind: "ok", text: "✅ 任务完成，报告已刷新" });
      load();
    } catch (err) {
      setMsg({ kind: "err", text: `❌ 任务失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setRunning(null);
    }
  };

  /**
   * 死链检测（SSE 流式）：逐条接收进度，实时渲染进度条与明细。
   * 服务端每检查完一条推送一条；浏览器关闭页面/组件卸载时 fetch 中断，
   * 服务端检测到 stream.aborted 即停止后续探测。
   */
  const runLinkCheckStream = async () => {
    setProgress({ total: 0, checked: 0, dead: 0, suspect: 0, normal: 0, items: [] });
    setMsg({ kind: "busy", text: "死链检测运行中——逐条探测外部链接…" });
    try {
      const res = await fetch(`${cfg.serverUrl}/api/v1/maintenance/links/run/stream?limit=20`, {
        headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}（鉴权失败或服务端异常）`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE 帧以空行分帧：event:xxx\ndata:{...}\n\n
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLines = frame.split("\n").filter((l) => l.startsWith("data:"));
          if (dataLines.length === 0) continue;
          const event = frame.match(/^event:\s*(\S+)/m)?.[1];
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(dataLines.map((l) => l.slice(5).replace(/^ /, "")).join("\n")) as Record<string, unknown>;
          } catch {
            continue; // 半帧/坏帧丢弃，等下一帧
          }
          if (event === "start") {
            setProgress((p) => ({ ...(p ?? emptyProgress()), total: Number(payload.total ?? 0) }));
          } else if (event === "item") {
            const it = payload as unknown as { i: number; title: string; host: string; verdict: "normal" | "suspect" | "dead"; total: number };
            setProgress((p) => {
              const base = p ?? emptyProgress();
              return {
                total: it.total || base.total,
                checked: base.checked + 1,
                dead: base.dead + (it.verdict === "dead" ? 1 : 0),
                suspect: base.suspect + (it.verdict === "suspect" ? 1 : 0),
                normal: base.normal + (it.verdict === "normal" ? 1 : 0),
                items: [it, ...base.items].slice(0, 8), // 最近 8 条
              };
            });
          } else if (event === "done") {
            const d = payload as unknown as { checked: number; dead: number; suspect: number; normal: number };
            setMsg({ kind: "ok", text: `✅ 检测完成：共 ${d.checked} 条，死链 ${d.dead}、疑似 ${d.suspect}、正常 ${d.normal}` });
            load();
          } else if (event === "error") {
            throw new Error(String(payload.error ?? "服务端检测失败"));
          }
        }
      }
    } catch (err) {
      setMsg({ kind: "err", text: `❌ 死链检测失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setRunning(null);
    }
  };

  const emptyProgress = () => ({ total: 0, checked: 0, dead: 0, suspect: 0, normal: 0, items: [] as Array<{ i: number; title: string; host: string; verdict: "normal" | "suspect" | "dead" }> });

  return (
    <div className="space-y-4">
      <Card title="维护任务">
        <div className="flex flex-wrap items-center gap-2">
          <Btn
            primary
            disabled={running !== null}
            onClick={() => void runTask("links")}
            title="对最久未检查的书签做连通性探测（HTTP HEAD/GET），逐条实时显示进度"
          >
            {running === "links" ? <Loader2 className="animate-spin" /> : <LinkIcon />}
            {running === "links" ? "检测运行中…" : "运行死链检测"}
          </Btn>
          <Btn disabled={running !== null} onClick={() => void runTask("dups")}>
            {running === "dups" ? <Loader2 className="animate-spin" /> : <Copy />}
            {running === "dups" ? "扫描运行中…" : "运行查重扫描"}
          </Btn>
          <Btn onClick={() => window.open(`${cfg.serverUrl}/health-report`, "_blank")}>
            <BarChart3 /> 体检报告页
          </Btn>
        </div>
        <FeedbackBar msg={msg} />
        {running === "links" && progress && (
          <div className="bg-accent/30 mt-4 space-y-3 rounded-xl border border-border p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                {progress.checked}/{progress.total || "…"} 条已检查
              </span>
              <span className="flex gap-2">
                <Badge variant="success">正常 {progress.normal}</Badge>
                <Badge variant="warning">疑似 {progress.suspect}</Badge>
                <Badge variant="destructive">死链 {progress.dead}</Badge>
              </span>
            </div>
            <Progress value={progress.total > 0 ? Math.round((progress.checked / progress.total) * 100) : 0} />
            {progress.items.length > 0 && (
              <ul className="space-y-1 text-xs">
                {progress.items.map((it) => (
                  <li key={it.i} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {it.verdict === "dead" ? (
                        <TriangleAlert className="text-destructive inline size-3.5" />
                      ) : it.verdict === "suspect" ? (
                        <TriangleAlert className="text-amber-500 inline size-3.5" />
                      ) : (
                        <CheckCircle2 className="text-emerald-500 inline size-3.5" />
                      )}{" "}
                      {it.title}
                      <span className="text-muted-foreground ml-1">({it.host})</span>
                    </span>
                    <Badge
                      variant={it.verdict === "dead" ? "destructive" : it.verdict === "suspect" ? "warning" : "success"}
                      className="shrink-0"
                    >
                      {it.verdict === "dead" ? "死链" : it.verdict === "suspect" ? "疑似" : "正常"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2 className="size-3 animate-spin" />
              每条探测含超时重试与礼貌间隔，关闭本页面即中止检测
            </p>
          </div>
        )}
      </Card>
      <Card title="死链周报">
        {linkReport ? (
          <p className="text-sm">
            {linkReport.created_at.slice(0, 10)} 检查 {linkReport.findings.checked} 条：死链 {linkReport.findings.dead}、疑似 {linkReport.findings.suspect}、正常 {linkReport.findings.normal}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">尚未运行过检测</p>
        )}
      </Card>
      <Card title="重复组">
        {dupReport ? (
          <p className="text-sm">
            发现 {dupReport.findings.groups} 组重复（{dupReport.findings.suggestions.slice(0, 5).map((s) => s.title).join("、")}）
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">尚未扫描</p>
        )}
      </Card>
    </div>
  );
}

function Settings({ cfg, onSave }: { cfg: AdminConfig; onSave: (c: AdminConfig) => void }) {
  const [serverUrl, setServerUrl] = useState(cfg.serverUrl);
  const [token, setToken] = useState(cfg.token);
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");

  const login = async () => {
    try {
      const res = await fetch(`${serverUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { token: string };
      setToken(body.token);
      setMsg("✅ 登录成功");
    } catch {
      setMsg("❌ 登录失败（服务端未启用鉴权或密码错误）");
    }
    setTimeout(() => setMsg(""), 3000);
  };

  return (
    <Card title="连接设置">
      <div className="space-y-3 text-sm">
        <label className="block">服务端地址（官方云 / 自建 NAS Docker）</label>
        <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
        <label className="block">管理员密码登录（启用鉴权的服务端）</label>
        <div className="flex gap-2">
          <Input
            className="flex-1"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void login()}
          />
          <Btn onClick={() => void login()}>
            <ShieldCheck /> 登录
          </Btn>
        </div>
        <label className="text-muted-foreground block text-xs">Token（登录后自动填充）</label>
        <Input className="font-mono text-xs" value={token} onChange={(e) => setToken(e.target.value)} />
        <div>
          <Btn primary onClick={() => onSave({ serverUrl, token })}>
            保存并连接
          </Btn>
        </div>
        {msg && (
          <p className={`flex items-center gap-1.5 ${msg.startsWith("✅") ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`}>
            {msg.startsWith("✅") ? <CheckCircle2 className="size-4" /> : <AlertCircle className="size-4" />}
            {msg.replace(/^[✅❌]\s*/, "")}
          </p>
        )}
      </div>
    </Card>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Admin />
  </StrictMode>,
);
