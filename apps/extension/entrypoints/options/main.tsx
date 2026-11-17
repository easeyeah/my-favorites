import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { api, getConfig, login, saveConfig } from "../../src/lib/api";

function Options() {
  const [serverUrl, setServerUrl] = useState("http://localhost:3000");
  const [status, setStatus] = useState("");
  const [inboxId, setInboxId] = useState<string | null>(null);
  const [stats, setStats] = useState<{ total: number; folders: number } | null>(null);
  const [password, setPassword] = useState("");

  useEffect(() => {
    void getConfig().then((c) => setServerUrl(c.serverUrl));
  }, []);

  const save = async () => {
    await saveConfig({ serverUrl: serverUrl.replace(/\/$/, "") });
    setStatus("已保存");
    setTimeout(() => setStatus(""), 2000);
  };

  const testConnection = async () => {
    try {
      const { serverUrl: url } = await getConfig();
      const res = await fetch(`${url}/healthz`);
      const body = (await res.json()) as { ok: boolean };
      setStatus(body.ok ? "✅ 连接成功" : "❌ 响应异常");
    } catch {
      setStatus("❌ 无法连接，请确认服务端已启动");
    }
  };

  const setupInbox = async () => {
    await save();
    void browser.runtime.sendMessage({ type: "setup-inbox" }, (res: { extId: string } | undefined) => {
      if (res?.extId) {
        setInboxId(res.extId);
        setStatus("✅ 收件箱已创建（书签栏可见「📥 自动整理」）");
      }
    });
  };

  const loadStats = async () => {
    try {
      setStats(await api<{ total: number; folders: number }>("/stats"));
    } catch {
      setStats(null);
    }
  };

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-xl font-semibold">my-favorites 设置</h1>
      <section className="mt-6 space-y-3">
        <label className="block text-sm">服务端地址（官方云或自建 Docker）</label>
        <input
          className="w-full rounded-lg border px-3 py-2 text-sm"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
        />
        <div className="flex gap-2">
          <button className="rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white" onClick={() => void save()}>保存</button>
          <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => void testConnection()}>测试连接</button>
          <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => void setupInbox()}>创建收件箱</button>
        </div>
        {inboxId && <p className="text-xs text-neutral-500">收件箱文件夹 id：{inboxId}</p>}
        {status && <p className="text-sm text-green-600">{status}</p>}
      </section>
      <section className="mt-8 text-sm">
        <label className="block">服务端开启管理员密码？（F6.2 自建鉴权）</label>
        <div className="mt-1 flex gap-2">
          <input
            className="flex-1 rounded-lg border px-3 py-2 text-sm"
            type="password"
            placeholder="管理员密码（未启用可留空）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            className="rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white"
            onClick={() =>
              void (async () => {
                try {
                  if (!password) {
                    setStatus("已跳过登录（服务端未启用鉴权）");
                    return;
                  }
                  await login(password);
                  setStatus("✅ 登录成功，token 已保存");
                } catch {
                  setStatus("❌ 登录失败");
                }
                setTimeout(() => setStatus(""), 3000);
              })()
            }
          >
            登录
          </button>
        </div>
      </section>
      <section className="mt-8 text-sm">
        <div className="flex items-center justify-between">
          <span>服务端书签统计</span>
          <button className="text-xs underline" onClick={() => void loadStats()}>刷新</button>
        </div>
        {stats && (
          <p className="mt-2 text-neutral-600">
            共 {stats.total} 条书签 / {stats.folders} 个目录
          </p>
        )}
        <button
          className="mt-3 rounded-lg border px-3 py-2 text-sm"
          onClick={() =>
            void browser.runtime.sendMessage({ type: "sync-mirror" }, (res: { added?: number; error?: string } | undefined) => {
              setStatus(res?.added !== undefined ? `✅ 已同步 ${res.added} 条到浏览器「my-favorites 同步」` : `同步失败：${res?.error ?? "未知"}`);
              setTimeout(() => setStatus(""), 4000);
            })
          }
        >
          🔄 同步书签到浏览器（F1.7）
        </button>
        <button
          className="mt-3 rounded-lg border px-3 py-2 text-sm"
          onClick={() =>
            void browser.runtime.sendMessage(
              { type: "import-bookmarks" },
              (res: { imported?: number; total?: number; skipped_duplicate?: number; error?: string } | undefined) => {
                if (!res?.imported) {
                  setStatus(`❌ 导入失败：${res?.error ?? "未知"}`);
                } else {
                  setStatus(`✅ 已导入 ${res.imported}/${res.total} 条（重复 ${res.skipped_duplicate} 条跳过）`);
                }
                setTimeout(() => setStatus(""), 5000);
              },
            )
          }
        >
          📥 一键导入浏览器全部书签（F1.1）
        </button>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Options />);
