import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import "./popup.css";

function Popup() {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    void browser.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t ?? null));
  }, []);

  const send = (type: string, okText: string, dupText: string) => {
    setStatus("处理中…");
    void browser.runtime.sendMessage({ type }, (res: { saved: boolean } | undefined) => {
      setStatus(res?.saved ? okText : res?.saved === false ? dupText : "失败：请检查服务端设置");
      setTimeout(() => setStatus(""), 3000);
    });
  };

  return (
    <main className="w-[300px] p-4">
      <h1 className="text-base font-semibold">my-favorites</h1>
      <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{tab?.title ?? "…"}</p>
      <div className="mt-3 space-y-2">
        <button
          className="w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white"
          onClick={() => send("save-current", "已收藏（AI 已归位）", "已收藏过（未重复）")}
        >
          ★ 收藏（AI 自动归位）
        </button>
        <button
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          onClick={() => send("save-to-inbox", "已放入收件箱", "已收藏过")}
        >
          📥 丢进收件箱
        </button>
        <button
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          onClick={() => void browser.sidePanel.open({ windowId: browser.windows.WINDOW_ID_CURRENT })}
        >
          💬 聊天整理
        </button>
        <a className="block text-center text-xs text-neutral-500 underline" href="options.html" target="_blank">
          设置
        </a>
      </div>
      {status && <p className="mt-2 text-center text-xs text-green-600">{status}</p>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
