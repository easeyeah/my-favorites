/**
 * 设置：一级入口列表 + 二级页面（#settings/connection 等）。
 * 首页只放入口行，具体配置都封装进二级页；安全说明并入连接页，规划中内容压成一行。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Bell, Bot, Check, ChevronRight, Cloud, Copy, Database, Download, FileUp, HardDrive, Loader2, Plug, Plus, ScrollText, ShieldCheck, Sparkles, Trash2, Upload, Webhook } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Btn, EmptyHint, PageScroll, Switch, downloadBlob, setNotifyStyle, timeAgo, toast } from "@/components/shared";
import { useRoute, useShell } from "@/components/layout";
import { PROVIDERS } from "@mf/ai";
import { MODULES } from "@/lib/modules";
import { isMock } from "@/lib/mock";
import {
  ApiError,
  apiCall,
  apiDownloadBlob,
  OFFICIAL_CLOUD_URL,
  apiPostHtml,
  auth,
  fetchers,
  rememberTokenFor,
  storeToken,
  tokenFor,
  type ProviderConfigRow,
} from "@/lib/api";

const SECTIONS: Array<{ sub: string; icon: ReactNode; title: string; desc: string; content: () => ReactNode }> = [
  { sub: "modules", icon: <Sparkles className="size-4" />, title: "功能模块", desc: "导航站 / AI 接入的开关（收纳盒与整理随书签库内置）", content: () => <ModulesCard /> },
  { sub: "notify", icon: <Bell className="size-4" />, title: "通知偏好", desc: "整理完成后怎么告诉你（D28 三档）", content: () => <NotifyCard /> },
  { sub: "organize-rules", icon: <Sparkles className="size-4" />, title: "整理偏好", desc: "AI 记住的整理规则，可查看 / 删除（原型 12）", content: () => <OrganizeRulesCard /> },
  { sub: "connection", icon: <Plug className="size-4" />, title: "连接与安全", desc: "服务端地址与登录", content: () => <ConnectionCard /> },
  { sub: "ai", icon: <Database className="size-4" />, title: "AI 模型", desc: "BYOK 供应商，驱动整理与摘要", content: () => <ProvidersCard /> },
  { sub: "mcp", icon: <Bot className="size-4" />, title: "MCP 接入", desc: "资料库对 AI 工具开放：Claude / Cursor 检索与阅读全文（D64）", content: () => <McpCard /> },
  { sub: "privacy", icon: <ShieldCheck className="size-4" />, title: "隐私保护", desc: "域名清单：不抓取、不送 AI、不出站", content: () => <PrivacyCard /> },
  { sub: "data", icon: <Download className="size-4" />, title: "数据", desc: "JSON / HTML 导入导出，随时带走", content: () => <DataCard /> },
  { sub: "webhooks", icon: <Webhook className="size-4" />, title: "集成与自动化", desc: "出站 Webhook：收藏动作触发外部工具", content: () => <WebhooksCard /> },
  { sub: "audit", icon: <ScrollText className="size-4" />, title: "操作日志", desc: "登录 / 令牌 / 配置 / 发布的审计记录（只读，D58）", content: () => <AuditCard /> },
];

export function Settings() {
  const { sub, go } = useRoute();
  const { cfg, serverInfo } = useShell();
  const active = SECTIONS.some((s) => s.sub === sub) ? (sub as string) : SECTIONS[0]!.sub;
  const activeDef = SECTIONS.find((s) => s.sub === active)!;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [active]);

  return (
    <PageScroll>
      <header className="mb-5">
        <h2 className="text-lg font-bold tracking-tight">设置</h2>
        <p className="text-muted-foreground mt-1 text-[13px]">
          {serverInfo ? `${cfg.serverUrl} · ${serverInfo.form} · v${serverInfo.version}` : cfg.serverUrl}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-[200px_1fr]">
        {/* 左：分区子导航 */}
        <aside className="hidden md:block">
          <div className="md:sticky md:top-24 space-y-0.5">
            {SECTIONS.map((s) => (
              <button
                key={s.sub}
                onClick={() => go("settings", undefined, s.sub)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                  active === s.sub ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <span className="shrink-0">{s.icon}</span>
                <span className="min-w-0 flex-1 truncate text-left">{s.title}</span>
              </button>
            ))}
          </div>
        </aside>

        {/* 移动端分区 chips */}
        <div className="flex flex-wrap items-center gap-1.5 md:hidden">
          {SECTIONS.map((s) => (
            <button
              key={s.sub}
              onClick={() => go("settings", undefined, s.sub)}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs transition-colors",
                active === s.sub ? "bg-primary font-medium text-primary-foreground" : "bg-muted/70 text-muted-foreground",
              )}
            >
              {s.title}
            </button>
          ))}
        </div>

        {/* 右：当前分区内容 */}
        <div className="min-w-0">
          <h2 className="mb-4 text-sm font-semibold">{activeDef.title}</h2>
          {activeDef.content()}
        </div>
      </div>

    </PageScroll>
  );
}

/** 设置面板内区块标题（全站统一）：text-xs font-semibold，右侧可挂动作按钮 */
function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <p className="text-xs font-semibold">{children}</p>
      {right}
    </div>
  );
}

// ---------- 功能模块 ----------

function ModulesCard() {
  const { modules, setModules } = useShell();
  return (
    <div className="text-sm">
      <ul className="divide-border/60 divide-y">
        {MODULES.map((m) => (
          <li key={m.id} className="flex items-center gap-4 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{m.title}</p>
              <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{m.desc}</p>
            </div>
            <Switch checked={modules[m.id]} onChange={(v) => setModules({ ...modules, [m.id]: v })} label={m.title} />
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-2 text-[11px]">关闭只隐藏入口、停用任务；书签库是核心，不可关闭；数据永不删除。</p>
    </div>
  );
}

// ---------- 整理偏好（原型 12：偏好记忆可见性——查看 / 删除已记忆规则） ----------

function OrganizeRulesCard() {
  const { cfg } = useShell();
  const [rules, setRules] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    apiCall<{ organizeRules?: string[] }>(cfg, "/settings/prefs")
      .then((r) => setRules(r.organizeRules ?? []))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [cfg]);

  const save = async (next: string[]) => {
    const prev = rules;
    setRules(next);
    try {
      await apiCall(cfg, "/settings/prefs", { method: "PATCH", body: JSON.stringify({ organizeRules: next }) });
    } catch (e) {
      setRules(prev);
      toast.err(`保存失败：${e instanceof ApiError ? e.message : String(e)}`);
    }
  };

  return (
    <div className="text-sm">
      <p className="text-muted-foreground mb-2 text-xs">
        这些规则会注入整理 AI（如「同一文档的多个版本共存时不合并」）——在此手动添加，长期生效。
      </p>
      <ul className="divide-border/60 divide-y">
        {rules.map((r) => (
          <li key={r} className="flex items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1 text-[13px]">{r}</span>
            <button className="text-muted-foreground hover:text-destructive text-xs" onClick={() => void save(rules.filter((x) => x !== r))}>
              删除
            </button>
          </li>
        ))}
          {loaded && rules.length === 0 && <li className="text-muted-foreground py-2.5 text-xs">还没有规则——例如添加「同一文档的不同版本永远共存，不要合并」。</li>}
      </ul>
      <div className="mt-2 flex gap-1.5">
        <Input
          className="h-8 flex-1 text-xs"
          placeholder="添加整理规则，例如：工作相关书签永远放「工作」目录"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              void save([...rules, draft.trim()]);
              setDraft("");
            }
          }}
        />
        <Btn
          className="h-8 px-3 text-xs"
          onClick={() => {
            if (!draft.trim()) return;
            void save([...rules, draft.trim()]);
            setDraft("");
          }}
        >
          添加
        </Btn>
      </div>
    </div>
  );
}

// ---------- 通知偏好（D28 三档：管理台侧；扩展端在其 options 端侧自行设置） ----------

type NotifyStyle = "toast" | "card" | "silent";

const NOTIFY_OPTIONS: Array<{ key: NotifyStyle; title: string; desc: string }> = [
  { key: "toast", title: "轻提示", desc: "完成后右下角一条轻提示，几秒自动消失（默认）" },
  { key: "card", title: "通知卡", desc: "在原地展示变更摘要卡，含撤销与「看看改了什么」明细" },
  { key: "silent", title: "静默", desc: "不打扰——变更只记入版本历史，随时可去版本历史撤销" },
];

function NotifyCard() {
  const { cfg } = useShell();
  const [style, setStyle] = useState<NotifyStyle>("toast");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiCall<{ notifyStyle?: NotifyStyle }>(cfg, "/settings/prefs")
      .then((r) => setStyle(r.notifyStyle ?? "toast"))
      .catch(() => undefined);
  }, [cfg]);

  const pick = async (key: NotifyStyle) => {
    if (key === style || saving) return;
    const prev = style;
    setStyle(key); // 乐观更新，失败回退
    setSaving(true);
    try {
      await apiCall(cfg, "/settings/prefs", { method: "PATCH", body: JSON.stringify({ notifyStyle: key }) });
      setNotifyStyle(key); // 同步内存缓存，整理提示立即按新档位生效
    } catch (e) {
      setStyle(prev);
      toast.err(`保存失败：${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="text-sm">
      <ul className="divide-border/60 divide-y">
        {NOTIFY_OPTIONS.map((o) => (
          <li key={o.key}>
            <button
              onClick={() => void pick(o.key)}
              className={cn(
                "flex w-full items-center gap-4 py-3.5 text-left transition-colors",
                style === o.key ? "" : "hover:bg-accent/40 rounded-lg",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {o.title}
                  {o.key === "toast" && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
                      默认
                    </Badge>
                  )}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{o.desc}</p>
              </div>
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border",
                  style === o.key ? "border-primary bg-primary text-primary-foreground" : "border-input",
                )}
              >
                {style === o.key && <Check className="size-3" />}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-2 text-[11px]">
        每次整理都会完成并记入版本历史（可撤销）；这里只决定「怎么告诉你」。扩展端的通知方式在扩展设置里单独调整。
      </p>
    </div>
  );
}

// ---------- 连接与令牌 ----------

function ConnectionCard() {
  const { cfg, setCfg, serverInfo, refreshBadges, connected } = useShell();
  const [serverType, setServerType] = useState<'cloud' | 'self'>(
    cfg.serverUrl === OFFICIAL_CLOUD_URL ? 'cloud' : 'self',
  )
  const [selfUrl, setSelfUrl] = useState(cfg.serverUrl === OFFICIAL_CLOUD_URL ? '' : cfg.serverUrl)
  const [password, setPassword] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [urlErr, setUrlErr] = useState('')
  const [pwdErr, setPwdErr] = useState('')

  /** 服务端地址格式校验（空值只在提交时拦，输入中不打扰） */
  const validateUrl = (silentOnEmpty = true): boolean => {
    const v = selfUrl.trim()
    if (!v) {
      if (!silentOnEmpty) setUrlErr('请填写服务端地址')
      return silentOnEmpty
    }
    if (!/^https?:\/\/[^\s/]+/.test(v)) {
      setUrlErr('地址需以 http:// 或 https:// 开头（如 http://nas-home.local:3000）')
      return false
    }
    setUrlErr('')
    return true
  }

  /** 连接 = 记住地址 + 设为当前；填了密码就顺带登录换令牌 */
  const connect = async () => {
    setPwdErr('')
    if (serverType === 'self' && !validateUrl(false)) return
    const url = serverType === 'cloud' ? OFFICIAL_CLOUD_URL : selfUrl.trim().replace(/\/+$/, '')
    setConnecting(true)
    try {
      if (!password) {
        setCfg({ serverUrl: url, token: tokenFor(url) })
        toast.ok(serverType === 'cloud' ? '已连接官方云（未登录）' : `已连接 ${url}（未登录）`)
        return
      }
      const res = await auth.login({ serverUrl: url, token: '' }, password, 'web-admin')
      storeToken(res.token, true, url)
      rememberTokenFor(url, res.token)
      setCfg({ serverUrl: url, token: res.token })
      toast.ok('已连接并登录')
      setPassword('')
      refreshBadges()
    } catch (e) {
      const m = e instanceof ApiError ? e.message : String(e)
      setPwdErr(m === 'rate_limited' ? '失败次数过多，已限速 15 分钟，稍后再试' : `登录失败：${m}`)
    } finally {
      setConnecting(false)
    }
  }

  const logout = async () => {
    try {
      await apiCall(cfg, '/auth/logout', { method: 'POST' })
    } catch {
      /* 离线也照常清除本地 */
    }
    rememberTokenFor(cfg.serverUrl, '')
    storeToken('', true)
    setCfg({ serverUrl: cfg.serverUrl, token: '' })
    toast.ok('已退出登录')
  }

  const activeUrl = serverType === 'cloud' ? OFFICIAL_CLOUD_URL : selfUrl.trim().replace(/\/+$/, '')

  return (
    <div className="space-y-6 text-sm">
      {/* 当前连接状态条 */}
      <div className="bg-muted/40 flex items-center gap-2 rounded-xl p-4 text-sm">
        <span className={cn('size-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-red-400')} />
        <span className="font-medium">{cfg.serverUrl}</span>
        {cfg.token ? (
          <Badge variant="success">已登录</Badge>
        ) : (
          <Badge variant="secondary">未登录</Badge>
        )}
        {serverInfo && <span className="text-muted-foreground text-xs">{serverInfo.form} · v{serverInfo.version}</span>}
        {cfg.token && (
          <button className="text-destructive ml-auto text-xs hover:underline" onClick={() => void logout()}>
            退出登录
          </button>
        )}
      </div>

      {/* 接入方式：官方云 / 自建 */}
      <div className="space-y-1">
        <SectionTitle>接入方式</SectionTitle>
        <div className="grid grid-cols-2 gap-2.5">
          <TypeCard
            active={serverType === 'cloud'}
            icon={<Cloud className="size-4" />}
            title="官方云服务"
            desc="无需部署，开箱即用"
            onClick={() => setServerType('cloud')}
          />
          <TypeCard
            active={serverType === 'self'}
            icon={<HardDrive className="size-4" />}
            title="自建 / NAS"
            desc="数据完全在自己手里"
            onClick={() => setServerType('self')}
          />
        </div>
        {serverType === 'self' && (
          <div className="space-y-1.5 pt-1">
            <label className="text-muted-foreground block text-xs">服务端地址</label>
            <Input
              className="font-mono text-xs"
              aria-invalid={!!urlErr}
              value={selfUrl}
              onChange={(e) => {
                setSelfUrl(e.target.value)
                if (urlErr) setUrlErr('')
              }}
              onBlur={() => validateUrl(true)}
              placeholder="http://nas-home.local:3000"
            />
            {urlErr ? (
              <p className="text-destructive text-[11px]">{urlErr}</p>
            ) : (
              <p className="text-muted-foreground text-[11px]">支持 NAS / 局域网 / 公网自建地址</p>
            )}
          </div>
        )}
      </div>

      {/* 登录 */}
      <div>
        <SectionTitle>登录</SectionTitle>
        <label className="text-muted-foreground block text-xs">管理员密码</label>
        <Input
          className="mt-1.5 w-72"
          type="password"
          aria-invalid={!!pwdErr}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
            if (pwdErr) setPwdErr('')
          }}
          onKeyDown={(e) => e.key === 'Enter' && void connect()}
          placeholder="••••••••"
        />
        {pwdErr && <p className="text-destructive mt-1.5 text-[11px]">{pwdErr}</p>}
        <div className="mt-3">
          <Btn primary onClick={() => void connect()} disabled={connecting}>
            {connecting ? <Loader2 className="animate-spin" /> : <ShieldCheck />} 连接
          </Btn>
        </div>
        <p className="text-muted-foreground mt-3 text-[11px]">
          连接成功后本设备自动记住登录；首次使用先在服务端完成管理员密码初始化
        </p>
      </div>

      {/* 已保存的服务端：只在真的存在其他可切换项时才出现 */}
    </div>
  );
}

/** 接入方式选择卡 */
function TypeCard({
  active,
  icon,
  title,
  desc,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  title: string
  desc: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-xl p-3 text-left transition-colors',
        active ? 'bg-primary/5 ring-1 ring-primary/40' : 'bg-muted/40 hover:bg-accent/50',
      )}
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </p>
      <p className="text-muted-foreground mt-0.5 text-xs">{desc}</p>
    </button>
  );
}
// ---------- AI 供应商（BYOK · D31） ----------

const PURPOSES: Array<{ key: "organize" | "summarize" | "embedding"; label: string; short: string; desc: string; hint?: string }> = [
  { key: "organize", label: "整理用途（分类 / 改名 / 合并建议）", short: "整理", desc: "自动归类、整理内容时调用" },
  { key: "summarize", label: "摘要 / 标签（L1）", short: "摘要 / 标签", desc: "生成内容摘要、自动打标签" },
  { key: "embedding", label: "Embedding（聚类 / 语义检索前置）", short: "Embedding", desc: "语义检索所需的向量编码", hint: "⚠️ 必须用专门的 embedding 模型，不能复用对话模型" },
];

/** 供应商标识色：已知品牌给固定色相，其余按 id 哈希 */
const PROVIDER_HUES: Record<string, number> = {
  deepseek: 215,
  zhipu: 262,
  zai: 285,
  aliyun: 205,
  kimi: 320,
  minimax: 345,
  volcano: 15,
  tencent: 240,
  xiaomi: 355,
  openai: 168,
  anthropic: 25,
  ollama: 95,
};

function providerHue(id: string): number {
  if (PROVIDER_HUES[id] !== undefined) return PROVIDER_HUES[id];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

// 已抓取官方 logo 的供应商（assets/web public/providers/，Dashscope 质量不达标 + 自定义走字母块兜底）
const PROVIDER_LOGO: Record<string, string> = {
  deepseek: '/providers/deepseek.png',
  bigmodel: '/providers/bigmodel.png',
  zai: '/providers/zai.svg',
  'moonshot-cn': '/providers/moonshot.png',
  'moonshot-intl': '/providers/moonshot.png',
  minimax: '/providers/minimax.png',
  'volcengine-ark': '/providers/volcengine.svg',
  'tencent-tokenhub': '/providers/tencent.png',
  'xiaomi-mimo': '/providers/mimo.png',
  openai: '/providers/openai.png',
  anthropic: '/providers/anthropic.png',
  ollama: '/providers/ollama.png',
}

function ProviderTile({ id, name, size = "sm" }: { id: string; name?: string; size?: "sm" | "md" }) {
  const logo = PROVIDER_LOGO[id]
  const letter = (name ?? id).trim()[0]?.toUpperCase() ?? "?"
  const hue = providerHue(id)
  const cls = size === "md" ? "size-8 rounded-lg text-xs" : "size-5 rounded text-[9px]"
  // 有官方 logo：白底圆角块 + 原始比例居中（各厂商 logo 风格差异大，统一容器统一留白）
  if (logo) {
    return (
      <span
        className={cn("border-border/60 bg-background inline-flex shrink-0 items-center justify-center overflow-hidden", cls, size === "md" ? "p-1" : "p-0.5")}
        aria-hidden
      >
        <img src={logo} alt="" className="size-full object-contain" draggable={false} loading="lazy" />
      </span>
    )
  }
  // 无 logo（自定义/未收录）：字母色块兜底
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center font-bold text-white", cls)}
      style={{ background: `hsl(${hue} 42% 46%)` }}
      aria-hidden
    >
      {letter}
    </span>
  );
}

function ProvidersCard() {
  const { cfg } = useShell();
  const [rows, setRows] = useState<ProviderConfigRow[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderConfigRow | null>(null);
  const [presetId, setPresetId] = useState<string>("deepseek");
  const [baseUrl, setBaseUrl] = useState(PROVIDERS.find((p) => p.id === "deepseek")?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const preset = PROVIDERS.find((p) => p.id === presetId);

  const load = useCallback(() => {
    fetchers.providers(cfg).then(setRows).catch(() => setRows([]));
  }, [cfg]);
  useEffect(load, [load]);

  const pickPreset = (id: string) => {
    setPresetId(id);
    const p = PROVIDERS.find((x) => x.id === id);
    if (p?.baseUrl) setBaseUrl(p.baseUrl);
  };

  const startEdit = (r: ProviderConfigRow) => {
    setEditing(r);
    setFormOpen(true);
    setPresetId(r.provider_id);
    setBaseUrl(r.base_url);
    setApiKey(""); // 不回显明文（A4-2）；留空=保持原 Key
    setModels(r.purpose_models ?? {});
  };

  const newItem = () => {
    setEditing(null);
    setFormOpen(false);
    setPresetId("deepseek");
    setBaseUrl(PROVIDERS.find((p) => p.id === "deepseek")?.baseUrl ?? "");
    setApiKey("");
    setModels({});
  };

  const test = async () => {
    if (!baseUrl) return;
    try {
      const r = await apiCall<{ ok: boolean; sample?: string; error?: string }>(cfg, "/settings/providers/test", {
        method: "POST",
        body: JSON.stringify({ baseUrl, apiKey: apiKey || undefined, model: models.organize ?? preset?.models[0] }),
      });
      if (r.ok) toast.ok(`连接通过${r.sample ? ` · 回复样例：${r.sample.slice(0, 40)}` : ""}`);
      else toast.err(`连接失败：${r.error ?? "未知错误"}`);
    } catch (e) {
      toast.err(`测试失败：${e instanceof ApiError ? e.message : String(e)}`);
    }
  };

  const save = async () => {
    if (!baseUrl) return;
    setBusy(true);
    try {
      await apiCall(cfg, "/settings/providers", {
        method: "POST",
        body: JSON.stringify({
          id: editing?.id,
          providerId: presetId,
          baseUrl,
          apiKey: apiKey || null, // null=服务端 COALESCE 保持原 Key
          purposeModels: models,
          enabled: true,
        }),
      });
      toast.ok(editing ? "供应商已更新" : "供应商已添加（Key 加密保存，仅服务端使用）");
      newItem();
      load();
    } catch (e) {
      const m = e instanceof ApiError ? e.message : String(e);
      toast.err(
        m.includes("MF_SECRET_KEY")
          ? "保存失败：需要先在部署环境设置 MF_SECRET_KEY（≥16 字符）才能加密保存 Provider Key"
          : `保存失败：${m}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const providerName = (id: string) => PROVIDERS.find((p) => p.id === id)?.name ?? id;

  // 在线模型列表：按供应商行自动拉取（GET /settings/providers/:id/models，Key 在服务端解密使用）
  const [liveModels, setLiveModels] = useState<Record<string, { models?: string[]; error?: string }>>({})
  const loadLiveModels = useCallback(
    (rowId: string) => {
      apiCall<{ models: string[] }>(cfg, `/settings/providers/${rowId}/models`)
        .then((r) => setLiveModels((prev) => ({ ...prev, [rowId]: { models: r.models } })))
        .catch((e) =>
          setLiveModels((prev) => ({
            ...prev,
            [rowId]: { error: e instanceof ApiError ? e.message : String(e) },
          })),
        )
    },
    [cfg],
  )
  useEffect(() => {
    for (const r of rows) {
      if (r.enabled && liveModels[r.id] === undefined) loadLiveModels(r.id)
    }
  }, [rows, liveModels, loadLiveModels])

  /** 用途 → 当前承担的「供应商 · 模型」 */
  const ownerOf = (
    key: "organize" | "summarize" | "embedding",
  ): { rowId: string; providerId: string; model: string; label: string } | null => {
    for (const r of rows) {
      const model = r.purpose_models?.[key];
      if (r.enabled && model) return { rowId: r.id, providerId: r.provider_id, model, label: `${providerName(r.provider_id)} · ${model}` };
    }
    return null;
  };

  /** 切换用途归属：改写对应供应商的 purpose_models 并整包保存（即时生效） */
  const assignPurpose = async (key: "organize" | "summarize" | "embedding", model: string) => {
    const owner = ownerOf(key);
    const row = owner ? rows.find((r) => r.id === owner.rowId) : undefined;
    if (!owner || !row) return;
    const purposeModels = { ...(row.purpose_models ?? {}), [key]: model };
    try {
      await apiCall(cfg, "/settings/providers", {
        method: "POST",
        body: JSON.stringify({
          id: row.id,
          providerId: row.provider_id,
          baseUrl: row.base_url,
          apiKey: null,
          purposeModels,
          enabled: true,
        }),
      });
      toast.ok("用途分配已更新，即时生效");
      load();
    } catch (e) {
      toast.err(`保存失败：${e instanceof ApiError ? e.message : String(e)}`);
    }
  };

  // 用途分配的输入草稿（onChange 更新、失焦/回车提交；未编辑时显示已保存值）
  const [purposeDraft, setPurposeDraft] = useState<Record<string, string>>({})
  const purposeOptionsFor = (ownerRowId: string, providerId: string) =>
    [...new Set([...(PROVIDERS.find((p) => p.id === providerId)?.models ?? []), ...(liveModels[ownerRowId]?.models ?? [])])].sort()

  return (
    <div className="text-sm">
      {/* 供应商 */}
      <section>
        <SectionTitle
          right={
            !formOpen && (
              <Btn
                onClick={() => {
                  newItem();
                  setFormOpen(true);
                }}
              >
                <Plus /> 添加供应商
              </Btn>
            )
          }
        >
          供应商
        </SectionTitle>
        {rows.length === 0 && !formOpen ? (
          <EmptyHint>还没有供应商——点「添加供应商」，从下拉里挑一家即可</EmptyHint>
        ) : (
          <ul className="divide-border/60 divide-y">
            {rows.map((r) => (
              <li
                key={r.id}
                className={cn(
                  'flex items-center gap-3 rounded-lg py-3.5 transition-colors',
                  r.enabled ? 'bg-accent/40 px-3 -mx-3' : 'px-1',
                )}
              >
                <ProviderTile id={r.provider_id} name={providerName(r.provider_id)} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-[13px] font-semibold">
                    {providerName(r.provider_id)}
                    <Badge variant={r.enabled ? "success" : "outline"} className="shrink-0">{r.enabled ? "启用" : "停用"}</Badge>
                    {r.has_key && <span className="text-muted-foreground text-xs font-normal">· Key 已存</span>}
                  </p>
                  <p className="text-muted-foreground truncate font-mono text-[11px]">{r.base_url}</p>
                  {Object.keys(r.purpose_models ?? {}).length > 0 && (
                    <p className="text-muted-foreground truncate text-[11px]">
                      {Object.entries(r.purpose_models).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                    </p>
                  )}
                </div>
                <Btn onClick={() => startEdit(r)}>编辑</Btn>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground mt-3 text-[11px] leading-relaxed">
          AI 请求只发往你填写的地址；隐私域名永不送 AI。Key 加密保存，仅服务端使用。
        </p>
      </section>

      <div aria-hidden className="border-border/50 my-7 border-t" />

      {/* 用途分配：默认显示的核心设置 */}
      <section>
        <SectionTitle>用途分配</SectionTitle>
        <p className="text-muted-foreground text-[13px]">同一供应商可承担多个用途；切换即时生效。</p>
        <ul className="divide-border/60 mt-2 divide-y">
          {PURPOSES.map((pu) => {
            const owner = ownerOf(pu.key);
            const model = purposeDraft[pu.key] !== undefined ? purposeDraft[pu.key] : owner?.model ?? "";
            const options = owner ? purposeOptionsFor(owner.rowId, owner.providerId) : [];
            const commit = () => {
              const v = (purposeDraft[pu.key] ?? "").trim();
              setPurposeDraft((prev) => {
                const next = { ...prev };
                delete next[pu.key];
                return next;
              });
              if (owner && v && v !== owner.model) void assignPurpose(pu.key, v);
            };
            return (
              <li key={pu.key} className="flex items-center justify-between gap-6 py-3.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{pu.short}</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">{pu.desc}</p>
                  {pu.hint && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{pu.hint}</p>}
                </div>
                <div className="w-64 shrink-0">
                  <Input
                    list={`purpose-models-${pu.key}`}
                    className="h-8 font-mono text-xs"
                    placeholder={owner ? "选择或输入模型 id" : "先在上方启用供应商"}
                    disabled={!owner}
                    value={model}
                    onChange={(e) => setPurposeDraft((prev) => ({ ...prev, [pu.key]: e.target.value }))}
                    onBlur={commit}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                  <datalist id={`purpose-models-${pu.key}`}>
                    {options.map((o) => (
                      <option key={o} value={o} />
                    ))}
                  </datalist>
                  <p className="text-muted-foreground mt-0.5 text-[11px]">
                    {owner ? `供应商：${providerName(owner.providerId)}` : "未分配"}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 添加 / 编辑凭据弹窗 */}
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editing ? "编辑供应商" : "添加供应商"}</DialogTitle>
              <DialogDescription>选择内置预设后 BaseURL 自动带出；保存后在「用途分配」里指定各用途使用的模型。</DialogDescription>
            </DialogHeader>
            <div className="space-y-3.5">
              <div className="space-y-1">
                <label className="text-muted-foreground block text-xs">供应商</label>
                <Select value={presetId} onValueChange={pickPreset}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择内置供应商" />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.filter((p) => !p.template).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="flex items-center gap-2">
                          <ProviderTile id={p.id} name={p.name} size="sm" />
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground block text-xs">BaseURL</label>
                <Input
                  className="font-mono text-xs"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={preset?.baseUrlNote ?? "https://api.example.com/v1"}
                />
                {preset?.keyUrl && (
                  <a className="text-muted-foreground inline-block text-[11px] hover:underline" href={preset.keyUrl} target="_blank" rel="noreferrer">
                    ↗ 前往获取 API Key（{preset.name}）
                  </a>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground block text-xs">
                  API Key{editing?.has_key ? "（已保存 · 留空保持不变）" : ""}
                </label>
                <Input className="w-72 font-mono text-xs" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
              </div>
              <Btn onClick={() => void test()} disabled={!baseUrl}>
                <Plug /> 测试连接
              </Btn>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Btn onClick={newItem}>取消</Btn>
              </DialogClose>
              <Btn primary onClick={() => void save()} disabled={busy || !baseUrl}>
                {busy && <Loader2 className="animate-spin" />}
                {editing ? "更新" : "保存"}
              </Btn>
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </div>
  );
}

// ---------- 隐私域名清单 ----------

interface WebhookRow {
  id: string
  url: string
  events: string[]
  enabled: boolean
}

const WEBHOOK_EVENTS: Array<{ key: string; label: string }> = [
  { key: 'bookmark.added', label: '新增收藏' },
  { key: 'bookmark.organized', label: '自动收纳' },
  { key: 'checkup.done', label: '检测完成' },
]

function WebhooksCard() {
  const { cfg } = useShell()
  const [rows, setRows] = useState<WebhookRow[] | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [urlErr, setUrlErr] = useState('')
  const [events, setEvents] = useState<string[]>(['bookmark.added'])
  const [eventsErr, setEventsErr] = useState('')
  const [adding, setAdding] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)

  const load = useCallback(() => {
    apiCall<{ webhooks: WebhookRow[] }>(cfg, '/settings/webhooks')
      .then((r) => setRows(r.webhooks))
      .catch(() => setRows([]))
  }, [cfg])
  useEffect(load, [load])

  const resetForm = () => {
    setUrl('')
    setUrlErr('')
    setEvents(['bookmark.added'])
    setEventsErr('')
  }

  const add = async () => {
    const v = url.trim()
    if (!v) {
      setUrlErr('请填写接收地址')
      return
    }
    if (!/^https?:\/\/\S+/.test(v)) {
      setUrlErr('地址需以 http:// 或 https:// 开头')
      return
    }
    if (events.length === 0) {
      setEventsErr('至少订阅一种事件')
      return
    }
    setAdding(true)
    try {
      await apiCall(cfg, '/settings/webhooks', {
        method: 'POST',
        body: JSON.stringify({ url: v, events }),
      })
      toast.ok('Webhook 已添加，可点「测试」验证连通')
      setAddOpen(false)
      resetForm()
      load()
    } catch (e) {
      toast.err(`添加失败：${e instanceof ApiError ? e.message : String(e)}`)
    } finally {
      setAdding(false)
    }
  }

  const toggle = async (wh: WebhookRow) => {
    try {
      await apiCall(cfg, `/settings/webhooks/${wh.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !wh.enabled }),
      })
      load()
    } catch (e) {
      toast.err(`操作失败：${e instanceof ApiError ? e.message : String(e)}`)
    }
  }

  const testOne = async (wh: WebhookRow) => {
    setTesting(wh.id)
    try {
      const r = await apiCall<{ ok: boolean; error?: string }>(cfg, `/settings/webhooks/${wh.id}/test`, {
        method: 'POST',
      })
      if (r.ok) toast.ok('测试事件已发送')
      else toast.err(`发送失败：${r.error ?? '未知错误'}`)
    } catch (e) {
      toast.err(`发送失败：${e instanceof ApiError ? e.message : String(e)}`)
    } finally {
      setTesting(null)
    }
  }

  const remove = async (id: string) => {
    try {
      await apiCall(cfg, `/settings/webhooks/${id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      toast.err(`删除失败：${e instanceof ApiError ? e.message : String(e)}`)
    }
  }

  return (
    <div className="text-sm">
      <SectionTitle
        right={
          <Btn
            onClick={() => {
              resetForm()
              setAddOpen(true)
            }}
          >
            <Plus /> 添加 Webhook
          </Btn>
        }
      >
        事件通知
      </SectionTitle>
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        收藏动作发生时，向这些地址推送事件通知。隐私域名永不外发；内网地址默认拦截。
      </p>

      <ul className="mt-3 space-y-3">
        {(rows ?? []).map((wh) => (
          <li key={wh.id} className="bg-muted/40 rounded-xl p-3">
            <div className="flex items-center gap-2">
              <Switch checked={wh.enabled} onChange={() => void toggle(wh)} label={wh.url} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{wh.url}</span>
              <Btn onClick={() => void testOne(wh)} disabled={testing === wh.id}>测试</Btn>
              <button
                className="text-destructive hover:bg-destructive/10 rounded-lg p-1.5 transition-colors"
                title="删除"
                onClick={() => void remove(wh.id)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1 pl-11">
              {wh.events.map((ev) => (
                <Badge key={ev} variant="outline" className="font-normal">{ev}</Badge>
              ))}
            </div>
          </li>
        ))}
      </ul>

      {/* 添加 Webhook（弹窗新增，表单不常驻页面） */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open) {
            setAddOpen(false)
            resetForm()
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>添加 Webhook</DialogTitle>
            <DialogDescription>
              事件发生时向该地址推送一条 POST JSON；至少订阅一种事件。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-muted-foreground block text-xs">接收地址</label>
              <Input
                className="font-mono text-xs"
                aria-invalid={!!urlErr}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value)
                  if (urlErr) setUrlErr('')
                }}
                onKeyDown={(e) => e.key === 'Enter' && void add()}
                placeholder="https://你的工具.example.com/hook"
              />
              {urlErr && <p className="text-destructive text-[11px]">{urlErr}</p>}
            </div>
            <div className="space-y-1.5">
              <label className="text-muted-foreground block text-xs">订阅事件</label>
              <div className="flex flex-wrap items-center gap-1.5">
                {WEBHOOK_EVENTS.map((ev) => (
                  <button
                    key={ev.key}
                    onClick={() => {
                      const next = events.includes(ev.key) ? events.filter((x) => x !== ev.key) : [...events, ev.key]
                      setEvents(next)
                      if (eventsErr && next.length > 0) setEventsErr('')
                    }}
                    className={cn(
                      'rounded-full px-2.5 py-1 text-xs transition-colors',
                      events.includes(ev.key) ? 'bg-primary font-medium text-primary-foreground' : 'bg-muted/70 text-muted-foreground',
                    )}
                  >
                    {ev.label}
                  </button>
                ))}
              </div>
              {eventsErr && <p className="text-destructive text-[11px]">{eventsErr}</p>}
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Btn>取消</Btn>
            </DialogClose>
            <Btn primary onClick={() => void add()} disabled={adding}>
              {adding && <Loader2 className="animate-spin" />} 添加
            </Btn>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- 存储用量面板 ----------

interface StorageInfo {
  sqliteMb: number
  snapshotsMb: number
  iconsMb: number
  backupsMb: number
  totalMb: number
}

function StorageCard() {
  const { cfg } = useShell()
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [active, setActive] = useState<number | null>(null)

  useEffect(() => {
    apiCall<StorageInfo>(cfg, '/stats/storage').then(setInfo).catch(() => setInfo(null))
  }, [cfg])

  if (!info) return null
  const rows: Array<{ label: string; mb: number }> = [
    { label: 'SQLite 数据库', mb: info.sqliteMb },
    { label: '快照', mb: info.snapshotsMb },
    { label: '图标缓存', mb: info.iconsMb },
    { label: '备份', mb: info.backupsMb },
  ]
  const total = Math.max(info.totalMb, 0.1)
  // 环形饼图分片（SVG circle + dasharray；品牌靛蓝系实色阶梯。
  // slice/dot 两套字面类名必须成对写全——图例色点若用 replace 从 stroke 类名派生 bg 类名，
  // 派生串不在源码里，Tailwind 扫描器不会生成该工具类，色块会变成透明）
  // 主色透明度阶梯（规范第 1 条：品牌色板其余三色不进控制台，indigo-300 ≈ #C7D2FE 违规——改 primary 透明度分档）
  const SEG_SHADES: Array<{ slice: string; dot: string }> = [
    { slice: 'stroke-primary', dot: 'bg-primary' },
    { slice: 'stroke-primary/70', dot: 'bg-primary/70' },
    { slice: 'stroke-primary/45', dot: 'bg-primary/45' },
    { slice: 'stroke-primary/20', dot: 'bg-primary/20' },
  ]
  const R = 40
  const CIRC = 2 * Math.PI * R
  let acc = 0
  // 色深按占比排名分配（面积越大颜色越深），图例色块随行联动
  const rankOf = new Map(
    rows
      .map((r, i) => ({ i, frac: Math.min(r.mb / total, 1) }))
      .sort((a, b) => b.frac - a.frac)
      .map((o, rank) => [o.i, rank]),
  )
  const segs = rows.map((r, i) => {
    const frac = Math.min(r.mb / total, 1)
    const seg = { ...r, frac, offset: acc, shade: SEG_SHADES[rankOf.get(i)!]!['slice'], dot: SEG_SHADES[rankOf.get(i)!]!['dot'] }
    acc += frac
    return seg
  })
  const cur = active !== null ? segs[active] : null
  return (
    <div className="text-sm">
      <div aria-hidden className="border-border/50 my-7 border-t" />
      <SectionTitle>存储用量</SectionTitle>
      <div className="flex flex-col items-center gap-6 sm:flex-row">
        <div className="relative size-36 shrink-0 animate-in fade-in zoom-in-95 duration-300">
          <svg viewBox="0 0 100 100" className="-rotate-90 size-full" role="img" aria-label="存储用量占比">
            <circle cx="50" cy="50" r={R} fill="none" strokeWidth="18" className="stroke-muted" />
            {segs.map((s, i) =>
              s.frac > 0.001 ? (
                <circle
                  key={s.label}
                  cx="50"
                  cy="50"
                  r={R}
                  fill="none"
                  strokeWidth={active === i ? 20 : 18}
                  strokeDasharray={`${(s.frac * CIRC).toFixed(2)} ${CIRC.toFixed(2)}`}
                  strokeDashoffset={(-s.offset * CIRC).toFixed(2)}
                  className={`${s.shade} cursor-pointer`}
                  style={{
                    opacity: active === null || active === i ? 1 : 0.35,
                    transition: 'stroke-width .18s ease, opacity .18s ease',
                  }}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                  onClick={() => setActive((a) => (a === i ? null : i))}
                />
              ) : null,
            )}
          </svg>
          {/* 环心读数：悬停/点选分片时显示该项统计值，平时显示合计 */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-5 text-center">
            {cur ? (
              <div key={cur.label} className="animate-in fade-in duration-150">
                <span className="text-sm font-semibold tabular">{cur.mb.toFixed(1)} MB</span>
                <span className="text-muted-foreground mt-0.5 block text-[10px] leading-snug">
                  {Math.round((cur.mb / total) * 100)}% · {cur.label}
                </span>
              </div>
            ) : (
              <>
                <span className="text-sm font-semibold tabular">{info.totalMb} MB</span>
                <span className="text-muted-foreground text-[10px]">合计</span>
              </>
            )}
          </div>
        </div>
        <ul className="w-full min-w-0 flex-1 space-y-2.5">
          {segs.map((s, i) => (
            <li
              key={s.label}
              className={`-mx-1.5 flex cursor-default items-center gap-2.5 rounded-md px-1.5 py-0.5 transition-colors ${active === i ? 'bg-muted' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onClick={() => setActive((a) => (a === i ? null : i))}
            >
              <span className={`size-2.5 shrink-0 rounded-sm ${s.dot}`} />
              <span className={`min-w-0 flex-1 truncate text-xs ${active === i ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>{s.label}</span>
              <span className="text-muted-foreground text-[11px]">
                {s.mb.toFixed(1)} MB · {Math.round((s.mb / total) * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-muted-foreground mt-3 text-[11px]">
        快照存于自建数据目录，不设上限；备份保留 14 份。
      </p>
    </div>
  );
}

// ---------- 隐私域名清单 ----------

function PrivacyCard() {
  const { cfg, refreshBadges } = useShell();
  const [patterns, setPatterns] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchers.privacyRules(cfg).then((r) => setPatterns(r.patterns)).catch(() => setPatterns([]));
  }, [cfg]);
  useEffect(load, [load]);

  const update = async (body: { add?: string[]; remove?: string[] }, okText: (purged: { bookmarks: number; snapshots: number } | null) => string) => {
    try {
      const r = await apiCall<{ patterns: string[]; purged: { bookmarks: number; snapshots: number } | null }>(
        cfg,
        "/privacy/rules",
        { method: "POST", body: JSON.stringify(body) },
      );
      setPatterns(r.patterns);
      toast.ok(okText(r.purged));
      refreshBadges();
    } catch (e) {
      toast.err(`操作失败：${e instanceof ApiError ? e.message : String(e)}`);
    }
  };

  const add = () => {
    if (!input.trim()) return;
    void update({ add: [input.trim()] }, () => `已添加 ${input.trim()}`);
    setInput("");
  };

  return (
    <div className="text-sm">
      <SectionTitle>域名清单</SectionTitle>
      <div className="mb-3 flex gap-1.5">
        <Input
          className="h-8 flex-1 text-xs"
          value={input}
          placeholder="*.example.com 或 example.com，回车添加"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <Btn onClick={add}>
          <Plus /> 添加
        </Btn>
      </div>
      {patterns.length === 0 ? (
        <EmptyHint>清单为空（默认内置清单未加载？）</EmptyHint>
      ) : (
        <div className="divide-border/60 max-h-96 divide-y overflow-y-auto">
          {patterns.map((p) => (
            <div key={p} className="flex items-center gap-2 px-1 py-2.5 text-[13px]">
              <code className="flex-1 truncate font-mono text-xs">{p}</code>
              <button
                className="text-destructive shrink-0 rounded p-1 hover:underline"
                title="从清单移除（若为内置规则，服务端会保留）"
                onClick={() => setRemoveTarget(p)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
        清单内的站点：只存 URL · 不抓正文 · 不送 AI · 不生成快照 · 不出现在公开导航站。
      </p>

      {/* 移除确认：规则变化默认清理存量内容（A1-5），必须让用户知情 */}
      <Dialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>移除隐私规则「{removeTarget}」？</DialogTitle>
            <DialogDescription>
              移除后，匹配该规则的站点将<b>不再受隐私保护</b>（可被抓取 / 送 AI / 生成快照 / 出现在公开导航站）。
              同时默认会清理这些站点的存量正文、摘要与快照（已发送给第三方的数据无法追回）。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Btn>取消</Btn>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const t = removeTarget;
                setRemoveTarget(null);
                if (t)
                  void update({ remove: [t] }, (purged) =>
                    purged ? `已移除并清理存量：书签内容 ${purged.bookmarks} 条 · 快照 ${purged.snapshots} 个` : "已移除该规则",
                  );
              }}
            >
              <Trash2 /> 移除并清理存量
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- 数据（导入 / 导出） ----------

function DataCard() {
  const { cfg } = useShell();
  const [importOpen, setImportOpen] = useState(false);

  const exportJson = async () => {
    try {
      const blob = await apiDownloadBlob(cfg, "/export/json");
      downloadBlob(blob, `my-favorites-export-${new Date().toISOString().slice(0, 10)}.json`);
      toast.ok("JSON 全量备份已下载（云端 ↔ 自建迁移走同一格式）");
    } catch (e) {
      toast.err(`导出失败：${e instanceof ApiError ? e.message : String(e)}`);
    }
  };
  const exportHtml = async () => {
    try {
      const blob = await apiDownloadBlob(cfg, "/export/html");
      downloadBlob(blob, "bookmarks.html");
      toast.ok("Netscape HTML 已下载（浏览器可直接再导入）");
    } catch (e) {
      toast.err(`导出失败：${e instanceof ApiError ? e.message : String(e)}`);
    }
  };

  const importJson = async (file: File) => {
    try {
      const body = JSON.parse(await file.text()) as unknown;
      const r = await apiCall<{ restored: number; skipped: number }>(cfg, "/import/json", {
        method: "POST",
        body: JSON.stringify(body),
      });
      toast.ok(`导入完成：恢复 ${r.restored} 条 · 跳过 ${r.skipped} 条（已存在/不合法）`);
    } catch (e) {
      toast.err(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const importHtml = async (file: File) => {
    try {
      const r = (await apiPostHtml(cfg, "/bookmarks/ingest/html", await file.text())) as {
        imported?: number;
        skipped_duplicate?: number;
      };
      toast.ok(`导入完成：${r.imported ?? 0} 条 · 重复跳过 ${r.skipped_duplicate ?? 0} 条（按规范 URL 幂等去重）`);
    } catch (e) {
      toast.err(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="text-sm">
      <StorageCard />
      <div aria-hidden className="border-border/50 my-7 border-t" />
      <div>
        <SectionTitle>导出</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={() => void exportJson()}>
            <Download /> 导出 JSON
          </Btn>
          <Btn onClick={() => void exportHtml()}>
            <Download /> 导出 HTML
          </Btn>
        </div>
        <p className="text-muted-foreground mt-2.5 text-xs leading-relaxed">
          数据随时可以完整带走：JSON 全量备份用于云端 ↔ 自建迁移；Netscape HTML 可直接导入任何浏览器。
        </p>
      </div>
      <div aria-hidden className="border-border/50 my-7 border-t" />
      <div>
        <SectionTitle>导入</SectionTitle>
        <Btn onClick={() => setImportOpen(true)}>
          <Upload /> 导入书签…
        </Btn>
        <p className="text-muted-foreground mt-2.5 text-xs leading-relaxed">
          支持本工具的 JSON 备份或浏览器的 Netscape HTML；按 URL 去重，直接归入对应目录（不进收纳盒）。
        </p>
      </div>
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onJson={importJson} onHtml={importHtml} />
    </div>
  );
}

function ImportDialog({
  open,
  onOpenChange,
  onJson,
  onHtml,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onJson: (f: File) => void;
  onHtml: (f: File) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>导入书签</DialogTitle>
          <DialogDescription>
            支持本工具导出的 JSON 全量备份，或浏览器导出的 Netscape HTML。
            导入按 URL 去重、直接归入对应目录（不进收纳盒）。
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3">
          <label className="hover:bg-accent/40 flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-sm transition-colors">
            <FileUp className="text-muted-foreground size-6" />
            选择 JSON 备份文件
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  onJson(f);
                  onOpenChange(false);
                }
              }}
            />
          </label>
          <label className="hover:bg-accent/40 flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-sm transition-colors">
            <FileUp className="text-muted-foreground size-6" />
            选择 Netscape HTML（浏览器书签导出）
            <input
              type="file"
              accept=".html,.htm,text/html"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  onHtml(f);
                  onOpenChange(false);
                }
              }}
            />
          </label>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Btn>关闭</Btn>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 操作日志（D58：审计只读视图，服务端保留最近 1000 条） ----------

interface AuditEvent {
  id: number;
  kind: string;
  detail: string | null;
  source: string | null;
  created_at: string;
}

/** kind → 徽章文案 + 语义色（失效=红 / 限速=琥珀 / 正常=绿，规范同状态点） */
const AUDIT_KINDS: Record<string, { label: string; badge: "destructive" | "warning" | "success" | "secondary" | "outline" }> = {
  "auth.login": { label: "登录", badge: "success" },
  "auth.failed": { label: "登录失败", badge: "destructive" },
  "auth.rate_limited": { label: "限速", badge: "warning" },
  "setup.done": { label: "初始化", badge: "secondary" },
  "token.revoked": { label: "令牌", badge: "secondary" },
  "provider.saved": { label: "AI 配置", badge: "outline" },
  "settings.changed": { label: "偏好", badge: "outline" },
  "webhook.saved": { label: "Webhook", badge: "outline" },
  "webhook.removed": { label: "Webhook", badge: "outline" },
  "nav.published": { label: "发布", badge: "outline" },
  "nav.unpublished": { label: "下线", badge: "outline" },
};

function AuditCard() {
  const { cfg } = useShell();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);

  const load = useCallback(() => {
    apiCall<{ events: AuditEvent[] }>(cfg, "/audit?limit=200")
      .then((r) => setEvents(r.events))
      .catch(() => setEvents([]));
  }, [cfg]);

  useEffect(load, [load]);

  return (
    <div className="text-sm">
      <SectionTitle
        right={
          <Btn onClick={load} disabled={events === null}>
            刷新
          </Btn>
        }
      >
        最近动作 · 只读
      </SectionTitle>
      {events === null ? (
        <EmptyHint>加载中…</EmptyHint>
      ) : events.length === 0 ? (
        <EmptyHint>暂无记录</EmptyHint>
      ) : (
        <ul className="divide-border/60 divide-y">
          {events.map((e) => {
            const k = AUDIT_KINDS[e.kind] ?? { label: e.kind, badge: "outline" as const };
            return (
              <li key={e.id} className="flex items-center gap-3 py-2.5">
                <Badge variant={k.badge} className="w-[64px] shrink-0 justify-center px-1.5 py-0 text-[10px] font-normal">
                  {k.label}
                </Badge>
                <span className="min-w-0 flex-1 truncate" title={e.detail ?? undefined}>
                  {e.detail ?? e.kind}
                </span>
                <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">{e.source ?? ""}</span>
                <time
                  className="text-muted-foreground w-[76px] shrink-0 text-right text-xs"
                  title={e.created_at}
                  dateTime={e.created_at}
                >
                  {timeAgo(e.created_at)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-muted-foreground mt-2 text-[11px]">
        服务端记录登录、令牌、配置与发布动作；不含书签内容，绝不落密码与令牌，保留最近 1000 条。
      </p>
    </div>
  );
}

/** D64 MCP 接入介绍：资料库对 AI 工具开放（端点 + 三工具 + 鉴权说明 + 连接器配置步骤） */
function McpCard() {
  const { cfg } = useShell();
  const endpoint = `${cfg.serverUrl.replace(/\/$/, "")}/api/v1/mcp`;
  // 已登录时示例直接带真实令牌（自建单管理员场景，免手工替换）；未登录用占位符并指路
  const token = cfg.token ?? "";
  const example = JSON.stringify(
    { url: endpoint, headers: token ? { Authorization: `Bearer ${token}` } : {} },
    null,
    2,
  );
  const copy = (text: string, label: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.ok(token ? `${label}已复制（含令牌，请妥善保管）` : `${label}已复制`))
      .catch(() => toast.err("复制失败"));
  };
  const tools: Array<{ name: string; desc: string }> = [
    { name: "materials_search", desc: "关键词 / AI 分类 / 类型 / 标签检索（返回摘要级元数据）" },
    { name: "materials_get", desc: "按 id 读取详情，含已存全文——AI 可直接阅读原文" },
    { name: "materials_recent", desc: "最近入库 + 类型计数（「最近收藏了什么」类询问）" },
  ];
  return (
    <div className="space-y-5">
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        资料库对 AI 工具开放：Claude、Cursor 等通过 MCP（Model Context
        Protocol）直接检索收藏、阅读已存全文。AI 是资料库的一等消费者。
      </p>

      <div>
        <SectionTitle>端点</SectionTitle>
        <div className="bg-muted/60 flex items-center gap-2 rounded-xl px-3 py-2.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{endpoint}</code>
          <Button variant="ghost" size="sm" onClick={() => copy(endpoint, "端点地址")}>
            <Copy className="size-3.5" /> 复制
          </Button>
        </div>
      </div>

      <div>
        <SectionTitle>可用工具</SectionTitle>
        <ul className="divide-y divide-border/40">
          {tools.map((t) => (
            <li key={t.name} className="py-2 text-[13px]">
              <code className="font-mono font-medium">{t.name}</code>
              <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{t.desc}</p>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <SectionTitle>鉴权</SectionTitle>
        <div className="bg-muted/60 rounded-xl px-3 py-2.5 text-[13px] leading-relaxed">
          {token ? (
            <p>
              无需单独的 API Key——MCP 与管理台登录同源，使用
              <code className="font-mono"> Authorization: Bearer &lt;令牌&gt;</code>
              （下方配置示例已包含当前登录令牌，含敏感信息请妥善保管、不要外发）。
            </p>
          ) : (
            <>
              <p>
                服务端设置了管理员密码（或已完成首启设置）时，MCP 需要 Bearer
                令牌——与管理台登录同源，无需单独的 API Key。先到「连接与安全」登录签发令牌，再复制下方示例并替换
                <code className="font-mono"> &lt;令牌&gt;</code> 占位符。
              </p>
              <p className="text-muted-foreground mt-1.5">
                服务端未设置密码（纯内网本地使用）时无需鉴权，直接连接；公网暴露务必设置密码。
              </p>
            </>
          )}
        </div>
      </div>

      <div>
        <SectionTitle>接入步骤（Claude / Cursor）</SectionTitle>
        <ol className="text-muted-foreground list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed">
          <li>复制下方接入配置示例（或端点地址）。</li>
          <li>在客户端的 MCP 连接器（自定义连接器 / mcpServers）里粘贴为 URL。</li>
          <li>
            {token
              ? "示例已包含当前登录令牌，粘贴即用。"
              : "添加请求头 Authorization: Bearer <令牌>（按「鉴权」指引签发/替换）。"}
          </li>
        </ol>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => copy(example, "接入配置")}>
          复制接入配置示例
        </Button>
      </div>

      <p className="text-muted-foreground text-[11px]">
        隐私说明：隐私域名与私密书签在资料层不存在，MCP 侧天然零暴露。
      </p>
    </div>
  );
}
