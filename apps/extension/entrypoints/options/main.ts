/**
 * options 页逻辑（DOM 操作版——页面自带样式，无需 React）。
 * 与 popup/sidepanel 共享 src/lib/api 的 storage 配置。
 */
import { api, getConfig, saveConfig } from "../../src/lib/api";

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
  const raw = serverInput.value.replace(/\/$/, "");
  await saveConfig({ serverUrl: raw });
  msg(el, "测试中…");

  /** 依次尝试：原地址 → localhost 换 127.0.0.1（避开 IPv6 ::1 解析/代理 bypass 问题） */
  const candidates = [raw];
  if (raw.includes("localhost")) {
    candidates.push(raw.replace("localhost", "127.0.0.1"));
  }
  let lastErr = "";
  for (const base of candidates) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(4000) });
      const body = (await res.json()) as { ok: boolean };
      if (body.ok) {
        if (base !== raw) {
          await saveConfig({ serverUrl: base }); // 自动采用可用地址
          serverInput.value = base;
          msg(el, `✅ 连接成功（已自动切换为 ${base}）`);
        } else {
          msg(el, "✅ 连接成功");
        }
        return;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  // 全部失败：给出可行动的排查建议
  const hint =
    lastErr.includes("Failed to fetch") || lastErr.includes("NetworkError")
      ? "网络层失败。排查：① Docker 服务端是否启动（docker compose -f docker/docker-compose.dev.yml up -d）② 若使用系统代理（Clash 等），请将 localhost/127.0.0.1 加入直连规则 ③ 换 127.0.0.1:端口 试试"
      : `服务端异常：${lastErr}`;
  msg(el, `❌ ${hint}`, false);
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
    (res: { imported?: number; total?: number; skipped_duplicate?: number; error?: string } | undefined) => {
      // MV3：background 异常时回调收到 undefined + lastError
      const lastErr = (globalThis as unknown as { chrome?: { runtime?: { lastError?: { message?: string } } } }).chrome?.runtime?.lastError?.message;
      if (res?.imported !== undefined) {
        msg(el, `✅ 已导入 ${res.imported}/${res.total} 条（重复 ${res.skipped_duplicate ?? 0} 跳过）`);
      } else {
        msg(el, `❌ 导入失败：${res?.error ?? lastErr ?? "服务端未连接（先启动 Docker 并点上方「测试连接」）"}`, false);
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
