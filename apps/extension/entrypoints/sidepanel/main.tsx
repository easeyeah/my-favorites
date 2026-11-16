import { useState } from "react";
import { createRoot } from "react-dom/client";
import { api, sendEvent, type OrganizeSessionDto } from "../../src/lib/api";
import "./panel.css";

interface ChatItem {
  role: "user" | "assistant";
  text: string;
  session?: OrganizeSessionDto;
}

function Sidepanel() {
  const [items, setItems] = useState<ChatItem[]>([
    {
      role: "assistant",
      text: '我是你的书签整理助手。试试：「整理」、「合并重复」，或「整理 开发 文件夹」。',
    },
  ]);
  const [input, setInput] = useState("");
  const [lastVersionId, setLastVersionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setItems((it) => [...it, { role: "user", text: message }]);
    try {
      const session = await api<OrganizeSessionDto>("/organize/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      void sendEvent("stage1_result_viewed", { proposed: session.status === "proposed" });
      setItems((it) => [...it, { role: "assistant", text: session.answer, session }]);
    } catch (err) {
      setItems((it) => [
        ...it,
        { role: "assistant", text: `请求失败：${String(err)}（请检查服务端）` },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (sessionId: string) => {
    try {
      const res = await api<{ versionId: string; applied: number }>(
        `/organize/sessions/${sessionId}/apply`,
        { method: "POST" },
      );
      setLastVersionId(res.versionId);
      void sendEvent("diff_accepted", { applied: res.applied });
      setItems((it) => [
        ...it,
        { role: "assistant", text: `✅ 已应用 ${res.applied} 项变更（版本 ${res.versionId.slice(0, 8)}…），可回滚。` },
      ]);
    } catch (err) {
      setItems((it) => [...it, { role: "assistant", text: `应用失败：${String(err)}` }]);
    }
  };

  const rollback = async () => {
    if (!lastVersionId) return;
    try {
      const res = await api<{ reversed: number }>(`/organize/rollback/${lastVersionId}`, {
        method: "POST",
      });
      setLastVersionId(null);
      setItems((it) => [...it, { role: "assistant", text: `↩️ 已回滚 ${res.reversed} 项变更。` }]);
    } catch (err) {
      setItems((it) => [...it, { role: "assistant", text: `回滚失败：${String(err)}` }]);
    }
  };

  return (
    <main className="flex h-screen flex-col p-4">
      <div className="flex-1 space-y-3 overflow-y-auto">
        {items.map((item, i) => (
          <div key={i}>
            <div
              className={
                item.role === "user"
                  ? "ml-auto max-w-[85%] rounded-xl bg-blue-600 px-3 py-2 text-sm text-white"
                  : "max-w-[85%] rounded-xl bg-neutral-100 px-3 py-2 text-sm"
              }
            >
              {item.text}
            </div>
            {item.session?.proposal && item.session.proposal.length > 0 && (
              <div className="mt-2 max-w-[95%] rounded-xl border p-3 text-xs">
                <p className="font-semibold">变更预览（diff）——确认后应用：</p>
                <ul className="mt-2 space-y-1">
                  {item.session.proposal.map((p, j) => (
                    <li key={j} className="text-neutral-700">
                      {p.type === "move" && `📦 「${p.bookmarkTitle}」：${p.fromFolder} → ${p.toFolder}`}
                      {p.type === "merge" && `🔗 合并 ${p.mergeFrom?.length ?? 0} 条重复到「${p.bookmarkTitle}」`}
                      {p.type === "createFolder" && `📁 新建目录「${p.folderName}」`}
                    </li>
                  ))}
                </ul>
                <button
                  className="mt-3 rounded-lg bg-green-600 px-3 py-1.5 text-white"
                  onClick={() => void apply(item.session!.sessionId)}
                >
                  应用变更
                </button>
              </div>
            )}
          </div>
        ))}
        {busy && <p className="text-xs text-neutral-400">思考中…</p>}
      </div>
      {lastVersionId && (
        <button className="mt-2 rounded-lg border px-3 py-1.5 text-xs" onClick={() => void rollback()}>
          ↩️ 回滚上次整理
        </button>
      )}
      <div className="mt-3 flex gap-2">
        <input
          className="flex-1 rounded-lg border px-3 py-2 text-sm"
          placeholder="告诉我要怎么整理…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
        />
        <button className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white" onClick={() => void send()}>
          发送
        </button>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Sidepanel />);
