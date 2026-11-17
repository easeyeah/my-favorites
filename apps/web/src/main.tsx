/** my-favorites Web 管理台（F6.2）：概览/书签/整理/导航站/报告/设置 */
import { useCallback, useEffect, useState } from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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
    headers: {
      "content-type": "application/json",
      ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      ...(init?.headers as Record<string, string>),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return (await res.json()) as T;
}

// ---------- 通用 UI ----------
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">{title}</h2>
      {children}
    </div>
  );
}
function Stat({ num, label, bad }: { num: number | string; label: string; bad?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 text-center">
      <div className={`text-3xl font-bold ${bad ? "text-red-500" : ""}`}>{num}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
function Btn({ children, onClick, primary }: { children: React.ReactNode; onClick?: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={
        primary
          ? "rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
          : "rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent"
      }
    >
      {children}
    </button>
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
  const [tab, setTab] = useState<TabKey>("overview");
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
        <span className={`rounded-full px-3 py-1 text-xs ${connected ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"}`}>
          {connected ? "已连接" : "未连接"}
        </span>
      </header>
      <nav className="mt-4 flex gap-1">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-lg px-4 py-2 text-sm ${tab === key ? "bg-indigo-600 text-white" : "hover:bg-accent"}`}
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
              📊 体检报告页
            </Btn>
            <Btn onClick={() => api(cfg, "/crawl/run", { method: "POST", body: "{}" })}>🕷️ 立即补漏抓取</Btn>
            <Btn onClick={() => api(cfg, "/maintenance/links/run", { method: "POST", body: "{}" })}>🔗 立即死链检测</Btn>
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
          className={`flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-sm hover:bg-accent ${selected === folder.id && !searching ? "bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-950" : ""}`}
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
    if (!confirm(`删除「${b.title}」？`)) return;
    void api(cfg, `/bookmarks/${b.id}`, { method: "DELETE" }).then(() => {
      loadTree();
      if (searching) void doSearch();
      else void loadPage(selected, 0, false);
    });
  };

  return (
    <Card title={`书签管理（${visible.length} 条${hasMore ? "+" : ""}${searching ? " · 搜索结果" : selected === "all" ? " · 全部" : ` · ${folderName(selected)}`}）`}>
      <div className="mb-3 flex gap-2">
        <input
          className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"
          placeholder="搜索书签 / 正文（回车）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={() => void doSearch()}
        />
        <Btn onClick={() => void doSearch()}>搜索</Btn>
        <Btn onClick={() => selectFolder("all")}>全部</Btn>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[240px_1fr]">
        {/* 左：目录树（计数来自服务端聚合） */}
        <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-border p-2">
          <div
            className={`flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-sm hover:bg-accent ${selected === "all" && !searching ? "bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-950" : ""}`}
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
                {b.is_private ? "🔒 " : ""}{b.title}
              </a>
              {(searching || selected === "all") && (
                <span className="shrink-0 text-xs text-muted-foreground">{folderName(b.folder_id)}</span>
              )}
              {b.status !== "normal" && (
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${b.status === "dead" ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300" : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300"}`}>
                  {b.status === "dead" ? "死链" : "疑似"}
                </span>
              )}
              <button className="shrink-0 text-xs text-red-500 hover:underline" onClick={() => remove(b)}>
                删除
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
      <div className="min-h-16 rounded-lg bg-accent/40 p-3 text-sm">{answer || "输入指令，例如：「整理」「合并重复」「整理 开发 文件夹」"}</div>
      {proposal && proposal.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg border border-border p-3 text-xs">
          {proposal.map((a, i) => (
            <li key={i}>
              {a.type === "move" && `📦 「${a.bookmarkTitle}」${a.fromFolder} → ${a.toFolder}`}
              {a.type === "merge" && `🔗 合并 ${a.mergeFrom?.length ?? 0} 条到「${a.bookmarkTitle}」`}
              {a.type === "createFolder" && `📁 新建「${a.folderName}」`}
            </li>
          ))}
        </ul>
      )}
      {proposal && proposal.length > 0 && (
        <div className="mt-2">
          <Btn primary onClick={() => void apply()}>应用变更</Btn>
        </div>
      )}
      {versionId && (
        <div className="mt-2">
          <Btn onClick={() => void rollback()}>↩️ 回滚上次整理</Btn>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <input
          className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"
          value={message}
          placeholder="告诉我要怎么整理…"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={() => void send()}
        />
        <Btn primary onClick={() => void send()}>发送</Btn>
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

  return (
    <Card title="导航站（4 套模板）">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs text-muted-foreground">标题</label>
          <input className="rounded-lg border border-border bg-card px-3 py-2 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground">模板</label>
          <select className="rounded-lg border border-border bg-card px-3 py-2 text-sm" value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="grid">经典宫格</option>
            <option value="list">极简清单</option>
            <option value="cards">卡片瀑布流</option>
            <option value="home">个人主页</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground">访问密码（可选）</label>
          <input className="rounded-lg border border-border bg-card px-3 py-2 text-sm" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <Btn primary onClick={() => void publish()}>发布</Btn>
      </div>
      <ul className="mt-4 space-y-2 text-sm">
        {sites.map((s) => (
          <li key={s.slug} className="flex items-center justify-between rounded-lg border border-border p-3">
            <span>
              「{s.title}」<span className="text-xs text-muted-foreground">模板：{s.template}</span>
            </span>
            <span className="flex items-center gap-2">
              <select className="rounded border border-border bg-card px-2 py-1 text-xs" value={s.template} onChange={(e) => void changeTemplate(s.slug, e.target.value)}>
                <option value="grid">宫格</option>
                <option value="list">清单</option>
                <option value="cards">瀑布流</option>
                <option value="home">主页</option>
              </select>
              <a className="text-xs underline" href={`${cfg.serverUrl}/s/${s.slug}`} target="_blank" rel="noreferrer">
                打开
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
  const load = useCallback(() => {
    api<typeof linkReport>(cfg, "/maintenance/report/latest?type=link_check").then(setLinkReport).catch(() => setLinkReport(null));
    api<typeof dupReport>(cfg, "/maintenance/report/latest?type=duplicate_scan").then(setDupReport).catch(() => setDupReport(null));
  }, [cfg]);
  useEffect(load, [load]);

  return (
    <div className="space-y-4">
      <Card title="维护任务">
        <div className="flex flex-wrap gap-2">
          <Btn primary onClick={() => void api(cfg, "/maintenance/links/run", { method: "POST", body: "{}" }).then(load)}>
            🔗 运行死链检测
          </Btn>
          <Btn onClick={() => void api(cfg, "/maintenance/duplicates/run", { method: "POST" }).then(load)}>🔗 运行查重扫描</Btn>
          <Btn onClick={() => window.open(`${cfg.serverUrl}/health-report`, "_blank")}>📊 体检报告页</Btn>
        </div>
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
        <input className="w-full rounded-lg border border-border bg-card px-3 py-2" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
        <label className="block">管理员密码登录（启用鉴权的服务端）</label>
        <div className="flex gap-2">
          <input className="flex-1 rounded-lg border border-border bg-card px-3 py-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Btn onClick={() => void login()}>登录</Btn>
        </div>
        <label className="block text-xs text-muted-foreground">Token（登录后自动填充）</label>
        <input className="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs" value={token} onChange={(e) => setToken(e.target.value)} />
        <Btn primary onClick={() => onSave({ serverUrl, token })}>保存并连接</Btn>
        {msg && <p className="text-green-600">{msg}</p>}
      </div>
    </Card>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Admin />
  </StrictMode>,
);
