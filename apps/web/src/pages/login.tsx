/**
 * 登录 / 首启设置门（原型 09）。
 * - 登录卡：管理员密码 → POST /auth/login 换长期令牌；「记住此设备」决定令牌存 localStorage / sessionStorage
 * - 首启设置：生产语义下服务端未初始化凭据时（登录报 auth_disabled 且未认证态），提供设密码 + 引导 token 通道
 * - 演示模式：任意密码进入（mock 层接管）
 */
import { useState } from "react";
import { AlertCircle, KeyRound, ShieldCheck, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError, auth, storeToken, type AdminConfig } from "@/lib/api";
import { isMock } from "@/lib/mock";

export function LoginPage({
  cfg,
  onSaveConfig,
  onAuthed,
}: {
  cfg: AdminConfig;
  onSaveConfig: (c: AdminConfig) => void;
  onAuthed: () => void;
}) {
  const mock = isMock();
  const [serverUrl, setServerUrl] = useState(cfg.serverUrl);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // 首启设置（服务端要求部署引导凭据时展示）
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupPassword, setSetupPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [setupErr, setSetupErr] = useState("");

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setErr("");
    const next = { ...cfg, serverUrl };
    onSaveConfig(next);
    try {
      const res = await auth.login(next, password, "web-admin");
      storeToken(res.token, remember);
      onAuthed();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const msg = e instanceof ApiError ? e.message : String(e);
      if (msg === "auth_disabled") {
        setSetupOpen(true);
        setErr("服务端还没有设置管理员密码（首次启动）。完成一次初始化即可。");
      } else if (status === 429) {
        setErr("登录尝试过于频繁，已被限速（连续 5 次失败锁定 15 分钟）");
      } else if (status === 401) {
        setErr("密码不对，再想想？");
      } else {
        setErr(`登录失败：${msg}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const submitSetup = async () => {
    if (!setupPassword || setupPassword.length < 8) {
      setSetupErr("管理员密码至少 8 位");
      return;
    }
    try {
      setSetupErr("");
      await auth.setup({ ...cfg, serverUrl }, setupPassword, setupToken);
      // 设置成功 → 直接登录换正式令牌
      const res = await auth.login({ ...cfg, serverUrl }, setupPassword, "web-admin");
      storeToken(res.token, true);
      setSetupOpen(false);
      onAuthed();
    } catch (e) {
      setSetupErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="bg-muted/40 flex min-h-screen items-center justify-center p-6 text-foreground">
      <div className="w-full max-w-sm">
        <div className="bg-card rounded-2xl p-8 shadow-sm">
          <div className="mb-7 text-center">
            <img src="/brand/mark-color.svg" alt="my-favorites" className="mx-auto size-12" />
            <div className="mt-3 text-[17px] font-bold tracking-tight">my-favorites</div>
            <div className="text-muted-foreground mt-1 text-xs">把失控的书签堆，变成每天想用的导航主页</div>
          </div>

          <label className="text-muted-foreground mb-1 block text-xs">服务端地址</label>
          <Input
            className="mb-4 font-mono text-xs"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="http://nas-home.local:3000"
          />

          <label className="text-muted-foreground mb-1 block text-xs">管理员密码</label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder="••••••••••"
          />
          <label className="text-muted-foreground mt-3 flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="accent-[var(--primary)]"
            />
            记住此设备（生成本机长期令牌）
          </label>

          <Button className="mt-5 w-full rounded-lg" onClick={() => void submit()} disabled={busy || !password}>
            {busy ? <KeyRound className="animate-spin" /> : <ShieldCheck />}
            {mock ? "进入演示模式" : "登录"}
          </Button>

          {mock && (
            <p className="text-muted-foreground mt-3 rounded-lg bg-muted px-3 py-2 text-center text-[11px]">
              🎬 演示模式：任意密码即可进入，数据仅存于浏览器内存
            </p>
          )}

          {err && (
            <p className="mt-3 flex items-start gap-1.5 text-sm text-red-500">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{err}</span>
            </p>
          )}

          {!mock && <p className="text-muted-foreground mt-4 text-center text-[11px]">登录限速：连续 5 次失败将锁定 15 分钟</p>}
        </div>
      </div>

      {/* 首启设置（DEV-05：生产语义需 MF_SETUP_TOKEN 引导凭据） */}
      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>首次启动 · 设置管理员密码</DialogTitle>
            <DialogDescription>
              该服务端尚未初始化凭据。设置后即可登录管理台；扩展端连接使用登录签发的长期令牌。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-muted-foreground mb-1 block text-xs">管理员密码（≥8 位）</label>
              <Input type="password" value={setupPassword} onChange={(e) => setSetupPassword(e.target.value)} />
            </div>
            <div>
              <label className="text-muted-foreground mb-1 block text-xs">
                引导凭据 Setup Token（部署时通过 MF_SETUP_TOKEN 环境变量或 dataDir 引导文件提供；留空表示本机部署无此要求）
              </label>
              <Input className="font-mono text-xs" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} placeholder="可选" />
            </div>
            {setupErr && <p className="text-sm text-red-500">{setupErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSetupOpen(false)}>
              稍后再说
            </Button>
            <Button size="sm" onClick={() => void submitSetup()} disabled={!setupPassword}>
              完成初始化并登录
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
