/** D73：统一部署的系统管理——注册策略、用户角色/状态与单用户数据导出。 */
import { useCallback, useEffect, useState } from "react";
import { Download, KeyRound, Loader2, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Btn, EmptyHint, NumberedPagination, Switch, downloadBlob, timeAgo, toast } from "@/components/shared";
import { useShell } from "@/components/layout";
import { ApiError, fetchers, type SystemUser } from "@/lib/api";

function errorText(error: unknown): string {
  const code = error instanceof ApiError ? error.message : String(error);
  const known: Record<string, string> = {
    admin_required: "只有系统管理员可以执行此操作",
    username_taken: "这个用户名已存在",
    invalid_username: "用户名需 3-32 位字母、数字、- 或 _",
    password_too_short_min_8: "密码至少 8 位",
    owner_immutable: "owner 是系统保留管理员，不能停用或降级",
    cannot_disable_or_demote_self: "不能停用或降级当前登录的自己",
    last_admin_required: "系统至少需要保留一位可用管理员",
    owner_password_use_account_settings: "owner 密码请在「账号与安全」中修改",
  };
  return known[code] ?? code;
}

export function SystemAdminCard() {
  const { cfg, currentUser } = useShell();
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [userPage, setUserPage] = useState(1);
  const pageSize = 10;
  const currentPage = Math.min(userPage, Math.max(1, Math.ceil(users.length / pageSize)));
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [registrationSaving, setRegistrationSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [manageTarget, setManageTarget] = useState<SystemUser | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "user">("user");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await fetchers.system(cfg);
      setUsers([...result.users]);
      setRegistrationOpen(result.registrationOpen);
    } catch (error) {
      toast.err(`系统信息加载失败：${errorText(error)}`);
    } finally {
      setLoaded(true);
    }
  }, [cfg]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeRegistration = async (open: boolean) => {
    if (registrationSaving) return;
    const previous = registrationOpen;
    setRegistrationOpen(open);
    setRegistrationSaving(true);
    try {
      await fetchers.setRegistrationOpen(cfg, open);
      toast.ok(open ? "已开放注册，登录页会显示注册入口" : "已关闭注册，现有用户登录不受影响");
    } catch (error) {
      setRegistrationOpen(previous);
      toast.err(`保存失败：${errorText(error)}`);
    } finally {
      setRegistrationSaving(false);
    }
  };

  const createUser = async () => {
    if (!newUsername || !newPassword || addBusy) return;
    setAddBusy(true);
    setAddError("");
    try {
      const result = await fetchers.createUser(cfg, {
        username: newUsername,
        password: newPassword,
        role: newRole,
      });
      setUsers((current) => [...current, result.user]);
      setUserPage(Math.ceil((users.length + 1) / pageSize));
      setAddOpen(false);
      setNewUsername("");
      setNewPassword("");
      setNewRole("user");
      toast.ok(`已创建 ${result.user.username}，可将账号密码交给使用者`);
    } catch (error) {
      setAddError(errorText(error));
    } finally {
      setAddBusy(false);
    }
  };

  const updateUser = async (
    user: SystemUser,
    input: { disabled?: boolean; role?: "admin" | "user"; newPassword?: string },
  ): Promise<boolean> => {
    setBusyId(user.id);
    try {
      const result = await fetchers.updateUser(cfg, user.id, input);
      setUsers((current) => current.map((item) => (item.id === user.id ? result.user : item)));
      setManageTarget(null);
      toast.ok(
        input.newPassword
          ? `已重置 ${user.username} 的密码，该账号所有旧登录态已失效`
          : input.disabled === true
            ? `已停用 ${user.username}，数据保留且旧登录态已失效`
            : input.disabled === false
              ? `已恢复 ${user.username}，可重新登录`
              : `已更新 ${user.username} 的角色`,
      );
      return true;
    } catch (error) {
      toast.err(`保存失败：${errorText(error)}`);
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const exportUser = async (user: SystemUser) => {
    setExportingId(user.id);
    try {
      const blob = await fetchers.exportUser(cfg, user.id);
      downloadBlob(blob, `my-favorites-${user.username}-${new Date().toISOString().slice(0, 10)}.json`);
      toast.ok(`已导出 ${user.username} 的数据（不含密码、令牌与 API Key）`);
    } catch (error) {
      toast.err(`导出失败：${errorText(error)}`);
    } finally {
      setExportingId(null);
    }
  };

  return (
    <div className="space-y-7 text-sm">
      <section>
        <div className="flex items-center gap-4 rounded-xl bg-muted/40 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="font-medium">允许新用户注册</p>
            <p className="text-muted-foreground mt-0.5 text-xs">关闭后登录页隐藏注册入口；现有用户与数据不受影响。</p>
          </div>
          <Switch
            checked={registrationOpen}
            onChange={(value) => void changeRegistration(value)}
            label="允许新用户注册"
            disabled={registrationSaving}
          />
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold">用户与权限</p>
            <p className="text-muted-foreground mt-0.5 text-[11px]">共 {users.length} 位用户；每人使用独立数据空间。</p>
          </div>
          <Btn
            onClick={() => {
              setAddError("");
              setAddOpen(true);
            }}
          >
            <Plus /> 添加用户
          </Btn>
        </div>

        {!loaded ? (
          <div className="text-muted-foreground flex items-center gap-2 py-5 text-xs">
            <Loader2 className="size-3.5 animate-spin" /> 正在读取用户…
          </div>
        ) : users.length === 0 ? (
          <EmptyHint>还没有账号，点击「添加用户」创建第一位用户。</EmptyHint>
        ) : (
          <ul aria-label="用户与权限列表">
            {users.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((user, index) => (
              <li key={user.id}>
                {index > 0 && <div className="bg-border/60 h-px" aria-hidden="true" />}
              <div className="data-row flex flex-wrap items-center gap-2 px-2 py-2.5 sm:flex-nowrap">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                    <span className="truncate">{user.username}</span>
                    <Badge variant="muted" size="xs">
                      {user.role === "admin" ? "管理员" : "普通用户"}
                    </Badge>
                    {user.disabled_at && <Badge variant="destructive-soft" size="xs">已停用</Badge>}
                  </p>
                  <p className="text-muted-foreground mt-0.5 truncate text-[11px]">
                    {user.display_name ? `${user.display_name} · ` : ""}加入于 {timeAgo(user.created_at)}
                    {user.id === currentUser?.userId ? " · 当前账号" : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Btn
                    size="xs"
                    disabled={exportingId === user.id}
                    onClick={() => void exportUser(user)}
                    title="导出该用户的完整内容，不含任何凭据"
                  >
                    {exportingId === user.id ? <Loader2 className="animate-spin" /> : <Download />} 导出
                  </Btn>
                  <Btn size="xs" onClick={() => setManageTarget(user)}>管理</Btn>
                </div>
              </div>
              </li>
            ))}
          </ul>
        )}
        {loaded && <NumberedPagination label="用户列表分页" page={currentPage} total={users.length} pageSize={pageSize} onPageChange={setUserPage} />}
        <p className="text-muted-foreground mt-3 text-[11px] leading-relaxed">
          停用只撤销访问，不删除书签与资料；导出包含私密内容，不含凭据与快照/封面二进制附件，请妥善保管文件。
        </p>
      </section>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>添加用户</DialogTitle>
            <DialogDescription>管理员直接创建账号，不签发或展示登录令牌。</DialogDescription>
          </DialogHeader>
          <form
            id="add-system-user"
            onSubmit={(event) => {
              event.preventDefault();
              void createUser();
            }}
            className="space-y-3"
          >
            <div>
              <label htmlFor="new-user-name" className="mb-1 block text-xs">用户名</label>
              <Input
                id="new-user-name"
                value={newUsername}
                onChange={(event) => setNewUsername(event.target.value)}
                autoComplete="off"
                placeholder="3-32 位字母/数字/-/_"
                required
              />
            </div>
            <div>
              <label htmlFor="new-user-password" className="mb-1 block text-xs">初始密码</label>
              <Input
                id="new-user-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>
            <div>
              <label htmlFor="new-user-role" className="mb-1 block text-xs">角色</label>
              <Select value={newRole} onValueChange={(value) => setNewRole(value as "admin" | "user")}>
                <SelectTrigger id="new-user-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">普通用户（默认）</SelectItem>
                  <SelectItem value="admin">系统管理员</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {addError && <p role="alert" className="text-destructive text-xs">{addError}</p>}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(false)}>取消</Button>
            <Button type="submit" form="add-system-user" size="sm" disabled={addBusy || !newUsername || newPassword.length < 8}>
              {addBusy ? <Loader2 className="animate-spin" /> : <Plus />} 创建用户
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {manageTarget && (
        <ManageUserDialog
          key={manageTarget.id}
          user={manageTarget}
          currentUserId={currentUser?.userId}
          busy={busyId === manageTarget.id}
          onClose={() => setManageTarget(null)}
          onSave={(input) => updateUser(manageTarget, input)}
        />
      )}
    </div>
  );
}

function ManageUserDialog({
  user,
  currentUserId,
  busy,
  onClose,
  onSave,
}: {
  user: SystemUser;
  currentUserId?: string;
  busy: boolean;
  onClose: () => void;
  onSave: (input: { disabled?: boolean; role?: "admin" | "user"; newPassword?: string }) => Promise<boolean>;
}) {
  const [role, setRole] = useState(user.role);
  const [disabled, setDisabled] = useState(Boolean(user.disabled_at));
  const [password, setPassword] = useState("");
  const protectedIdentity = user.id === "self" || user.id === currentUserId;
  const owner = user.id === "self";
  const changed = role !== user.role || disabled !== Boolean(user.disabled_at) || Boolean(password);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>管理 {user.username}</DialogTitle>
          <DialogDescription>角色即时生效；停用或重置密码会撤销该账号的全部登录态。</DialogDescription>
        </DialogHeader>
        <form
          id="manage-system-user"
          onSubmit={(event) => {
            event.preventDefault();
            if (!changed || busy) return;
            void onSave({
              ...(role !== user.role ? { role } : {}),
              ...(disabled !== Boolean(user.disabled_at) ? { disabled } : {}),
              ...(password ? { newPassword: password } : {}),
            });
          }}
          className="space-y-5"
        >
          <div>
            <label htmlFor="manage-user-role" className="mb-1 block text-xs">角色</label>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as "admin" | "user")}
              disabled={protectedIdentity}
            >
              <SelectTrigger id="manage-user-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="user">普通用户</SelectItem>
                <SelectItem value="admin">系统管理员</SelectItem>
              </SelectContent>
            </Select>
            {protectedIdentity && <p className="text-muted-foreground mt-1 text-[11px]">不能降级 owner 或当前登录账号。</p>}
          </div>

          <div className="flex items-center gap-4 rounded-lg bg-muted/40 px-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">停用此账号</p>
              <p className="text-muted-foreground mt-0.5 text-[11px]">保留全部数据，可随时恢复。</p>
            </div>
            <Switch checked={disabled} onChange={setDisabled} label={`停用 ${user.username}`} disabled={protectedIdentity} />
          </div>

          <div>
            <label htmlFor="reset-user-password" className="mb-1 flex items-center gap-1.5 text-xs">
              <KeyRound className="size-3.5" /> 重置密码（可选）
            </label>
            <Input
              id="reset-user-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              placeholder={owner ? "owner 请在账号与安全中修改" : "留空则不修改；填写时至少 8 位"}
              disabled={owner}
            />
          </div>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button type="submit" form="manage-system-user" size="sm" disabled={!changed || busy || (password.length > 0 && password.length < 8)}>
            {busy ? <Loader2 className="animate-spin" /> : null} 保存更改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
