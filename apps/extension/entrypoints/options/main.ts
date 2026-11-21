/**
 * options 页逻辑（DOM 操作版——页面自带样式，无需 React）。
 * 与 popup 共享 src/lib/api 的 storage 配置。
 */
import { browser } from "wxt/browser";
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

// 打开管理台：web 管理台由服务端同源托管，地址 = 当前配置的 serverUrl（深链到概览页）
$("open-admin").addEventListener("click", async () => {
  const el = $("msg-connect");
  const { serverUrl } = await getConfig();
  if (!serverUrl) {
    msg(el, "请先填写并保存服务端地址", false);
    return;
  }
  await browser.tabs.create({ url: `${serverUrl.replace(/\/$/, "")}/#overview` });
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

// ---------- D46 收藏夹双向同步（总开关 + 立即同步 + 状态行 + 删除保险丝确认） ----------
interface SyncInfoView {
  at?: number;
  phase?: string;
  ok?: boolean;
  error?: string;
  deleteGuard?: { side: "browser" | "library"; count: number };
  stats?: Record<string, number | undefined>;
}
const syncMaster = $("sync-master");
const syncStatusLine = $("sync-status-line");
const guardRow = $("sync-guard-row");
let syncActionInFlight = false; // 开关/立即同步进行中：禁止状态刷新覆写 checkbox

function paintSyncStatus(info: SyncInfoView | undefined, on: boolean): void {
  if (!on) {
    syncStatusLine.textContent = "同步已关闭。开启后浏览器收藏夹将自动与管理台保持一致。";
    guardRow.style.display = "none";
    return;
  }
  const parts: string[] = [];
  if (info?.at) parts.push(`上次同步 ${new Date(info.at).toLocaleString()}`);
  if (info && !info.ok) parts.push(`⚠️ ${info.error ?? "上次同步失败"}`);
  const s = info?.stats ?? {};
  const detail = [
    s.pulledApplied ? `库→浏览器 ${s.pulledApplied}` : "",
    s.pushedOk ? `浏览器→库 ${s.pushedOk}` : "",
    s.createdInBrowser ? `浏览器新建 ${s.createdInBrowser}` : "",
    s.deletedBrowser ? `浏览器删除 ${s.deletedBrowser}` : "",
    s.deletedLibrary ? `库删除 ${s.deletedLibrary}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (detail) parts.push(detail);
  syncStatusLine.textContent = parts.length > 0 ? parts.join(" ｜ ") : "同步已开启，等待首次收敛…";
  if (info?.deleteGuard) {
    guardRow.style.display = "flex";
    msg(
      $("msg-sync"),
      `⚠️ 检测到 ${info.deleteGuard.count} 条${info.deleteGuard.side === "browser" ? "浏览器侧" : "库侧"}批量删除，已暂停以防误删。确认无误后点下方按钮放行。`,
      false,
    );
  } else {
    guardRow.style.display = "none";
  }
}

async function refreshSyncStatus(): Promise<void> {
  await browser.runtime.sendMessage({ type: "sync-status" }, (res: { on?: boolean; info?: SyncInfoView } | undefined) => {
    if (!syncActionInFlight) syncMaster.checked = res?.on === true;
    paintSyncStatus(res?.info, syncMaster.checked);
  });
}
void refreshSyncStatus();

syncMaster.addEventListener("change", async () => {
  const on = syncMaster.checked;
  syncActionInFlight = true;
  msg($("msg-sync"), on ? "正在全量对齐（首次可能需数十秒，请勿关闭本页）…" : "正在关闭…");
  await browser.runtime.sendMessage({ type: "sync-set", on }, (res: { info?: SyncInfoView; error?: string } | undefined) => {
    if (!res || res.error) {
      msg($("msg-sync"), `❌ ${res?.error ?? "同步服务不可达（先测试连接）"}`, false);
      syncActionInFlight = false;
      void refreshSyncStatus();
      return;
    }
    msg($("msg-sync"), on ? "✅ 已开启并完成全量对齐" : "✅ 已关闭同步（浏览器现有书签保留）");
    setTimeout(() => ($("msg-sync").textContent = ""), 3000);
    syncActionInFlight = false;
  });
  await refreshSyncStatus();
});

$("sync-now").addEventListener("click", async () => {
  syncActionInFlight = true;
  msg($("msg-sync"), "同步中…");
  await browser.runtime.sendMessage({ type: "sync-now" }, (res: { info?: SyncInfoView; error?: string } | undefined) => {
    if (!res || res.error) {
      msg($("msg-sync"), `❌ ${res?.error ?? "同步服务不可达"}`, false);
      syncActionInFlight = false;
      return;
    }
    msg($("msg-sync"), res.info?.ok === false ? `❌ ${res.info.error ?? "同步失败"}` : "✅ 同步完成");
    setTimeout(() => ($("msg-sync").textContent = ""), 3000);
    syncActionInFlight = false;
  });
  await refreshSyncStatus();
});

$("sync-confirm-delete").addEventListener("click", async () => {
  msg($("msg-sync"), "正在执行确认的批量删除…");
  await browser.runtime.sendMessage({ type: "sync-now", confirmDeletes: true }, () => undefined);
  msg($("msg-sync"), "✅ 已按确认放行删除并完成同步");
  setTimeout(() => ($("msg-sync").textContent = ""), 3000);
  await refreshSyncStatus();
});

$("inbox").addEventListener("click", async () => {
  const el = $("msg-inbox");
  await browser.runtime.sendMessage({ type: "setup-inbox" }, () => {
    msg(el, "✅ 收纳盒已创建（书签栏可见「📥 收纳盒」）");
  });
});

// ---------- 原型 07：投递口位置 / 立即清扫 ----------
const parentSel = $("inbox-parent") as unknown as HTMLSelectElement;

async function loadInboxParent(): Promise<void> {
  const { inboxParent } = await browser.storage.local.get(["inboxParent"]);
  parentSel.value = (inboxParent as string) ?? "1";
}
void loadInboxParent();

parentSel.addEventListener("change", async () => {
  await browser.storage.local.set({ inboxParent: parentSel.value });
  await browser.runtime.sendMessage({ type: "setup-inbox" }, () => {
    msg($("msg-inbox"), parentSel.value === "2" ? "✅ 已移到「其他书签」下" : "✅ 已移到书签栏");
  });
});

$("sweep").addEventListener("click", async () => {
  const el = $("msg-inbox");
  msg(el, "清扫中…");
  await browser.runtime.sendMessage({ type: "sweep-inbox" }, (res: { moved?: number } | undefined) => {
    msg(el, `✅ 已归位 ${res?.moved ?? 0} 条（可在 popup「收纳盒」查看/撤销）`);
  });
});

// ---------- 整理通知方式（D28 三档：端侧偏好） ----------
const NOTIFY_LABEL: Record<string, string> = {
  toast: "轻提示：完成后一行轻提示，几秒消失",
  card: "通知卡：展示变更摘要 + 撤销 + 只读明细",
  silent: "静默：不打扰，变更只记入版本历史",
};

function paintNotify(current: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".notify-opt")) {
    b.setAttribute("aria-pressed", String(b.dataset.style === current));
    b.title = NOTIFY_LABEL[b.dataset.style ?? ""] ?? "";
  }
}

getConfig().then((cfg) => paintNotify(cfg.notifyStyle ?? "toast"));

for (const b of document.querySelectorAll<HTMLButtonElement>(".notify-opt")) {
  b.addEventListener("click", async () => {
    const style = b.dataset.style as "toast" | "card" | "silent";
    await saveConfig({ notifyStyle: style });
    paintNotify(style);
    msg($("msg-notify"), `✅ ${NOTIFY_LABEL[style]}`);
    setTimeout(() => ($("msg-notify").textContent = ""), 2500);
  });
}

$("refresh").addEventListener("click", async () => {
  const el = $("stats");
  try {
    const stats = await api<{ total: number; folders: number; navSites: number }>("/stats");
    el.innerHTML = `共 <b>${stats.total}</b> 条书签 · <b>${stats.folders}</b> 个目录 · <b>${stats.navSites}</b> 个导航站`;
  } catch {
    el.textContent = "未连接";
  }
});

// ---------- 原型 07：关于卡（版本 / 当前模型只读） ----------
void (async () => {
  const manifest = browser.runtime.getManifest();
  const el = document.getElementById("about-version");
  if (el) el.textContent = `扩展 v${manifest.version}`;
  try {
    const rows = await api<Array<{ provider_id: string; purpose_models: Record<string, string>; enabled: number }>>(
      "/settings/providers",
      {},
    );
    const active = rows.find((r) => r.enabled === 1);
    const model = active ? active.purpose_models["organize"] ?? Object.values(active.purpose_models)[0] : null;
    const modelEl = document.getElementById("about-model");
    if (modelEl) modelEl.textContent = model ? `✦ ${model}（管理台配置 · 只读，D37）` : "未配置（规则引擎模式可用）";
  } catch {
    // 未连接：保持默认文案
  }
})();
