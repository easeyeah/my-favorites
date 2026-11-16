import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import "./popup.css";

function Popup() {
  return (
    <main className="w-[320px] p-4">
      <h1 className="text-base font-semibold">my-favorites</h1>
      <p className="mt-2 text-sm text-neutral-500">
        收藏时 AI 自动归位 · 收件箱随手丢 · 导航站即起始页
      </p>
      <button
        className="mt-4 w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white"
        onClick={() => browser.tabs.create({ url: "options.html" })}
      >
        打开设置
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
