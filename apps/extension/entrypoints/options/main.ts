/**
 * options 页逻辑（DOM 操作版——页面自带样式，无需 React）。
 * 与 popup/sidepanel 共享 src/lib/api 的 storage 配置。
 */
import { api, getConfig, saveConfig } from "../src/lib/api";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

const msg = (el: HTMLElement, text: string, ok = true) => {
  el.textContent = text;
  el.classList.toggle("ok", ok);
  el.classList.toggle("err", !ok);
};

const serverInput = $("server");
const pwInput = $("pw");

// 初始化
getConfig().then((cfg) => {
  serverInput.value = cfg.serverUrl;
});

$("save").addEventListener("click", async () => {
  await saveConfig({ serverUrl: serverInput.value.replace(/\/$/, "") });
  msg($("msg-connect"), "✅ 已保存");
  setTimeout(() => ($("msg-connect").textContent = ""), 2000);
});

$("test").addEventListener("click", async () => {
  const el = $("msg-connect");
  try {
    await saveConfig({ serverUrl: serverInput.value.replace(/\/$/, "") });
    const res = await fetch(`${serverInput.value}/healthz`);
    const body = (await res.json()) as { ok: boolean };
    msg(el, body.ok ? "✅ 连接成功" : "❌ 响应异常");
  } catch {
    msg(el, "❌ 无法连接（先启动 Docker 服务端）", false);
  }
});

$("login").addEventListener("click", async () => {
  const el = $("msg-auth");
  if (!pwInput.value) {
    msg(el, "服务端未启用鉴权，无需登录", true);
    return;
  }
  try {
    await saveConfig({ serverUrl: serverInput.value.replace(/\/$/, "") });
    const res = await fetch(`${serverInput.value}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: pwInput.value }),
    });
    if (!res.ok) {
      msg(el, "❌ 密码错误或服务端未启用鉴权", false);
      return;
    }
    const body = (await res.json()) as { token: string };
    await saveConfig({ token: body.token });
    msg(el, "✅ 登录成功，token 已保存");
  } catch {
    msg(el, "❌ 登录请求失败", false);
  }
});

$("import").addEventListener("click", async () => {
  const el = $("msg-data");
  msg(el, "导入中…");
  await browser.runtime.sendMessage(
    { type: "import-bookmarks" },
    (res: { imported?: number; total?: number; skipped_duplicate?: number } | undefined) => {
      if (res?.imported !== undefined) {
        msg(el, `✅ 已导入 ${res.imported}/${res.total} 条（重复 ${res.skipped_duplicate} 跳过）`);
      } else {
        msg(el, "❌ 导入失败：先连接服务端", false);
      }
    },
  );
});

$("sync").addEventListener("click", async () => {
  const el = $("msg-data");
  msg(el, "同步中…");
  await browser.runtime.sendMessage(
    { type: "sync-mirror" },
    (res: { added?: number; error?: string } | undefined) => {
      if (res?.added !== undefined) {
        msg(el, `✅ 已镜像 ${res.added} 条到浏览器「my-favorites 同步」`);
      } else {
        msg(el, `❌ 同步失败：${res?.error ?? "未知"}`, false);
      }
    },
  );
});

$("inbox").addEventListener("click", async () => {
  const el = $("msg-inbox");
  await browser.runtime.sendMessage({ type: "setup-inbox" }, () => {
    msg(el, "✅ 收件箱已创建（书签栏可见「📥 自动整理」）");
  });
});

$("refresh").addEventListener("click", async () => {
  const el = $("stats");
  try {
    const stats = await api<{ total: number; folders: number; navSites: number }>("/stats");
    el.innerHTML = `共 <b>${stats.total}</b> 条书签 · <b>${stats.folders}</b> 个目录 · <b>${stats.navSites}</b> 个导航站`;
  } catch {
    el.textContent = "未连接";
  }
});
