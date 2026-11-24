/**
 * D73 统一登录：自建与官方云只有服务端地址不同，不再有两套界面。
 * 留空用户名仍可使用旧单管理员密码登录；注册入口仅由实例的 registrationOpen 决定。
 */
import { useEffect, useState } from "react";
import { AlertCircle, KeyRound, ShieldCheck, UserRound } from "lucide-react";
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
import { ApiError, auth, probeHealth, storeToken, type AdminConfig } from "@/lib/api";
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
  const [serverUrl, setServerUrl] = useState(cfg.serverUrl || window.location.origin);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [registerMode, setRegisterMode] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupPassword, setSetupPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [setupErr, setSetupErr] = useState("");

  const refreshRegistrationPolicy = async (target: string) => {
    if (mock) return;
    const info = await probeHealth(target);
    if (info?.ok) setRegistrationOpen(info.registrationOpen !== false);
  };

  useEffect(() => {
    void refreshRegistrationPolicy(cfg.serverUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!registrationOpen) setRegisterMode(false);
  }, [registrationOpen]);

  const authed = (token: string, next: AdminConfig, rememberToken: boolean) => {
    storeToken(token, rememberToken, next.serverUrl);
    // 令牌必须同步进 App 的 cfg state；只写存储会让后续 probe 仍持旧 token。
    onSaveConfig({ ...next, token });
    onAuthed();
  };

  const submit = async () => {
    if (!password || busy) return;
    if (registerMode && password !== confirm) {
      setErr("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setErr("");
    const next = { ...cfg, serverUrl: serverUrl.replace(/\/$/, "") };
    onSaveConfig(next);
    try {
      if (registerMode) {
        const res = await auth.register(next, username, password, "web-admin");
        authed(res.token, next, remember);
        return;
      }
      if (username) {
        const res = await auth.loginAccount(next, username, password, "web-admin");
        authed(res.token, next, remember);
        return;
      }
      // 兼容旧版单管理员：无用户名 = owner 密码登录。
      const res = await auth.login(next, password, "web-admin");
      authed(res.token, next, remember);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const msg = e instanceof ApiError ? e.message : String(e);
      if (msg === "auth_disabled") {
        setSetupOpen(true);
        setErr("服务端还没有设置管理员密码（首次启动）。完成一次初始化即可。");
      } else if (msg === "username_taken") {
        setErr("这个用户名已被注册，换一个试试");
      } else if (msg === "invalid_username") {
        setErr("用户名需 3-32 位字母、数字、- 或 _");
      } else if (msg === "password_too_short_min_8") {
        setErr("密码至少 8 位");
      } else if (msg === "register_closed") {
        setRegistrationOpen(false);
        setErr("该服务端已关闭注册，请联系系统管理员");
      } else if (msg === "account_disabled") {
        setErr("该账号已被停用，请联系系统管理员");
      } else if (status === 429) {
        setErr("尝试过于频繁，已被限速，请稍后再试");
      } else if (status === 401) {
        setErr(username || registerMode ? "用户名或密码不对，再想想？" : "密码不对，再想想？");
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
      const target = { ...cfg, serverUrl: serverUrl.replace(/\/$/, "") };
      await auth.setup(target, setupPassword, setupToken);
      const res = await auth.login(target, setupPassword, "web-admin");
      authed(res.token, target, true);
      setSetupOpen(false);
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

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label htmlFor="login-server-url" className="text-muted-foreground mb-1 block text-xs">服务端地址</label>
            <Input
              id="login-server-url"
              type="url"
              className="mb-4 font-mono text-xs"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              onBlur={() => void refreshRegistrationPolicy(serverUrl)}
              placeholder="http://nas-home.local:3000"
              autoComplete="url"
              required
            />

            <label htmlFor="login-username" className="text-muted-foreground mb-1 block text-xs">
              {registerMode ? "用户名（3-32 位字母/数字/-/_）" : "用户名"}
            </label>
            <Input
              id="login-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              placeholder="alice"
              required={registerMode}
              aria-describedby={!registerMode ? "login-username-hint" : undefined}
            />
            {!registerMode && (
              <p id="login-username-hint" className="text-muted-foreground mb-3 mt-1 text-[11px]">
                旧版本单管理员可留空用户名，仅输入密码。
              </p>
            )}

            <label htmlFor="login-password" className="text-muted-foreground mb-1 mt-3 block text-xs">
              {registerMode ? "设置密码（≥8 位）" : "密码"}
            </label>
            <Input
              id="login-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={registerMode ? "new-password" : "current-password"}
              minLength={registerMode ? 8 : undefined}
              placeholder="••••••••••"
              required
            />
            {registerMode && (
              <>
                <label htmlFor="login-confirm-password" className="text-muted-foreground mb-1 mt-3 block text-xs">确认密码</label>
                <Input
                  id="login-confirm-password"
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  placeholder="••••••••••"
                  required
                />
              </>
            )}

            <label htmlFor="login-remember" className="text-muted-foreground mt-3 flex cursor-pointer items-center gap-2 text-xs">
              <input
                id="login-remember"
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                className="accent-[var(--primary)]"
              />
              记住此设备（生成本机长期令牌）
            </label>

            <Button className="mt-5 w-full rounded-lg" type="submit" disabled={busy || !password || (registerMode && !username)}>
              {busy ? <KeyRound className="animate-spin" /> : <ShieldCheck />}
              {mock ? "进入演示模式" : registerMode ? "注册并登录" : "登录"}
            </Button>
          </form>

          {registrationOpen ? (
            <button
              type="button"
              className="text-muted-foreground mt-3 w-full text-center text-xs hover:underline"
              onClick={() => {
                setRegisterMode((value) => !value);
                setErr("");
              }}
            >
              {registerMode ? "已有账号？返回登录" : "没有账号？注册一个"}
            </button>
          ) : (
            <p className="text-muted-foreground mt-3 text-center text-xs">当前实例未开放注册，请联系系统管理员。</p>
          )}

          {mock && (
            <p className="text-muted-foreground mt-3 rounded-lg bg-muted px-3 py-2 text-center text-[11px]">
              🎬 演示模式：任意密码即可进入，数据仅存于浏览器内存
            </p>
          )}

          {err && (
            <p role="alert" className="mt-3 flex items-start gap-1.5 text-sm text-red-500">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{err}</span>
            </p>
          )}

          {!mock && (
            <p className="text-muted-foreground mt-4 flex items-center justify-center gap-1 text-center text-[11px]">
              <UserRound className="size-3" /> 自建与官方云使用同一套账号，区别只在服务端地址
            </p>
          )}
        </div>
      </div>

      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>首次启动 · 设置管理员密码</DialogTitle>
            <DialogDescription>
              该服务端尚未初始化凭据。设置后即可登录管理台；扩展端连接使用登录签发的长期令牌。
            </DialogDescription>
          </DialogHeader>
          <form
            id="initial-admin-setup"
            onSubmit={(event) => {
              event.preventDefault();
              void submitSetup();
            }}
            className="space-y-3"
          >
            <div>
              <label htmlFor="setup-password" className="text-muted-foreground mb-1 block text-xs">管理员密码（≥8 位）</label>
              <Input
                id="setup-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={setupPassword}
                onChange={(event) => setSetupPassword(event.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="setup-token" className="text-muted-foreground mb-1 block text-xs">引导凭据 Setup Token</label>
              <Input
                id="setup-token"
                className="font-mono text-xs"
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
                placeholder="本机开发模式可留空"
                aria-describedby="setup-token-hint"
              />
              <p id="setup-token-hint" className="text-muted-foreground mt-1 text-[11px]">生产部署由 MF_SETUP_TOKEN 或 dataDir 引导文件提供。</p>
            </div>
            {setupErr && <p role="alert" className="text-sm text-red-500">{setupErr}</p>}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setSetupOpen(false)}>稍后再说</Button>
            <Button type="submit" form="initial-admin-setup" size="sm" disabled={setupPassword.length < 8}>完成初始化并登录</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
