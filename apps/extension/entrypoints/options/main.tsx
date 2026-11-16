import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { api, getConfig, saveConfig } from "../../src/lib/api";

function Options() {
  const [serverUrl, setServerUrl] = useState("http://localhost:3000");
  const [status, setStatus] = useState("");
  const [inboxId, setInboxId] = useState<string | null>(null);
  const [stats, setStats] = useState<{ total: number; folders: number } | null>(null);

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
        <div className="flex items-center justify-between">
          <span>服务端书签统计</span>
          <button className="text-xs underline" onClick={() => void loadStats()}>刷新</button>
        </div>
        {stats && (
          <p className="mt-2 text-neutral-600">
            共 {stats.total} 条书签 / {stats.folders} 个目录
          </p>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Options />);
