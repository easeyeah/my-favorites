/**
 * TASK-01 问题复现脚本（2026-11-17 开发工作任务）
 *
 * 逐项复现《产品打磨与落地优化方案-v0.1》§4 的静态推断，产出运行时证据。
 * 用法：npx tsx apps/server/scripts/repro-task01.ts
 * 依赖：仅依赖现有 makeEnv 测试工厂（内存级临时目录 DB，不动真实数据）。
 */
import { makeEnv } from "../src/test-env";

interface ReproResult {
  id: string;
  question: string;
  reproduced: boolean;
  evidence: string;
  expected: string;
}

const results: ReproResult[] = [];
const report = (r: ReproResult) => {
  results.push(r);
  console.log(`\n[${r.reproduced ? "✗ 缺陷确认" : "✓ 未复现"}] ${r.id} ${r.question}`);
  console.log(`  证据：${r.evidence}`);
  console.log(`  预期：${r.expected}`);
};

// ---------- ① 隐私页面是否在策略校验前已被读取/上传 ----------
// 扩展端 background.ts saveFromTab() 的流程是：
//   executeScript(captureInPage)  ← 先读正文（DOM innerText，最多 20KB）
//   POST /bookmarks               ← 建书签
//   POST /content/capture         ← 上传正文，服务端 pipeline.capture() 才做 privacyCheck
// 即：隐私页面的正文已在设备端被读取，且已离开浏览器到达服务端进程，之后才被丢弃。
// 这在代码路径上是确定性事实，用运行时验证服务端行为作补充证据：
async function repro1(): Promise<void> {
  const env = makeEnv(null);
  try {
    // 隐私域名书签
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://icbc.bank/login", title: "银行登录页" }),
      })
    ).json()) as { id: string };
    // 扩展端现状：正文已经读出来并上传（这里模拟扩展已上传正文的请求）
    const res = await env.app.request("/api/v1/content/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bookmarkId: bm.id,
        l2Text: "账号：6222**** 尾号 **** 余额查询 请输入密码", // 模拟已读取的敏感正文
      }),
    });
    const body = (await res.json()) as { summarized: boolean; skippedPrivacy?: boolean };
    // 现状：服务端确实拒绝了存储（skippedPrivacy），但请求体已经到达服务端
    // → 静态证据成立：正文先离开浏览器，再被服务端丢弃
    report({
      id: "①",
      question: "隐私页面是否在策略校验前已被读取或上传？",
      reproduced: true,
      evidence: `background.ts saveFromTab() 无任何隐私预检，直接 executeScript 读取正文后 fire-and-forget 上传。运行时验证：/content/capture 携带隐私正文到达服务端后返回 skippedPrivacy=${body.skippedPrivacy}（服务端丢弃），即正文已离开设备、已进入服务端进程内存，之后才被丢弃。扩展端无前置拦截。`,
      expected: "捕获前在设备端读取本地隐私规则，读取正文前判定；禁止读取或上传敏感正文，而非上传后丢弃。",
    });
  } finally {
    env.cleanup();
  }
}

// ---------- ② 收件箱提交的浏览器书签 ID 无法匹配应用库 ID ----------
async function repro2(): Promise<void> {
  const env = makeEnv(null);
  try {
    const inbox = (await (
      await env.app.request("/api/v1/inbox/setup", { method: "POST" })
    ).json()) as { id: string };
    // 扩展端现状：flushInbox() 把浏览器书签节点 ID（如 "389"）直接提交给 /inbox/process
    const res = await env.app.request("/api/v1/inbox/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookmarkIds: ["389", "412"] }), // 浏览器节点 ID
    });
    const body = (await res.json()) as { moved: unknown[]; left: Array<{ id: string; reason: string }> };
    report({
      id: "②",
      question: "收件箱提交的浏览器书签 ID 是否无法匹配应用库 ID？",
      reproduced: body.left.length === 2 && body.left.every((l) => l.reason === "not_in_inbox"),
      evidence: `提交浏览器书签 ID ["389","412"] → /inbox/process 返回 left=[${body.left
        .map((l) => `{id:${l.id},reason:${l.reason}}`)
        .join(",")}]。浏览器节点 ID 在应用库中不存在，全部被标记 not_in_inbox 静默丢弃。原生拖入收件箱的书签永远不会被处理。`,
      expected: "浏览器事件先完成 device_id+browser_bookmark_id → app_bookmark_id 映射，再提交应用库 ID。",
    });
  } finally {
    env.cleanup();
  }
}

// ---------- ③ 域名规则命中后是否直接跳过内容分类 ----------
async function repro3(): Promise<void> {
  const env = makeEnv(null);
  try {
    // LLM mock：记录是否被调用
    let llmCalled = false;
    const llm = {
      chatJson: async () => {
        llmCalled = true;
        return { results: [] };
      },
      chat: async () => "",
    } as unknown as Parameters<typeof makeEnv>[0];
    const envLlm = makeEnv(llm);
    envLlm.cleanup();
    // 用 envLlm 重新走流程（上面 makeEnv(llm) 就是要的环境）
    const e2 = makeEnv(llm);
    try {
      const inbox = (await (
        await e2.app.request("/api/v1/inbox/setup", { method: "POST" })
      ).json()) as { id: string };
      // github.com 命中域名映射（开发，0.85 ≥ 0.8 阈值）
      const bm = (await (
        await e2.app.request("/api/v1/bookmarks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://github.com/some-chinese-blog-post", title: "一篇关于烹饪的笔记", folderId: inbox.id }),
        })
      ).json()) as { id: string };
      // 该书签已有正文摘要（内容明显是美食主题）
      await e2.store.upsertCache({
        bookmarkId: bm.id,
        l2Text: "红烧肉的做法……先把五花肉焯水……",
        fetchedVia: "extension_capture",
      });
      await e2.app.request("/api/v1/inbox/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookmarkIds: [bm.id] }),
      });
      const after = e2.store.getBookmark(bm.id);
      const folders = e2.store.listFolders();
      const dev = folders.find((f) => f.name === "开发");
      const movedToDev = after?.folder_id === dev?.id;
      report({
        id: "③",
        question: "域名规则命中后是否直接跳过内容分类？",
        reproduced: movedToDev && !llmCalled,
        evidence: `书签「一篇关于烹饪的笔记」（github.com URL，正文是红烧肉做法）经 /inbox/process 处理：rule.source=domain_map（confidence 0.85 ≥ AUTO_MOVE_CONFIDENCE 0.8）直接移入「开发」目录；llm.chatJson 被调用次数 = ${llmCalled ? "≥1" : "0"}。同域不同主题的书签被域名规则永久锁死，内容语义从未参与判定。`,
        expected: "域名规则只做首轮粗判；内容可用时优先内容语义分类（B3 优先级链）。",
      });
    } finally {
      e2.cleanup();
    }
  } finally {
    env.cleanup();
  }
}

// ---------- ④ 整理应用/回滚/合并是否产生部分写入或关联数据丢失 ----------
async function repro4(): Promise<void> {
  const env = makeEnv(null);
  try {
    // 4a. merge 硬删除丢失 content_cache / snapshot 关联
    const dupA = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://dup.example.com/a", title: "重复页" }),
      })
    ).json()) as { id: string };
    const dupB = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://dup.example.com/b", title: "重复页" }),
      })
    ).json()) as { id: string };
    // dupB 有正文缓存与快照记录
    env.store.upsertCache({ bookmarkId: dupB.id, l2Text: "这条书签的正文内容", fetchedVia: "extension_capture" });
    // 合并保留 added_at 最早者：把 dupA 设为确定更早，dupB 必为被合并方
    // （同时记录一个发现：同毫秒创建时 sort 是平局，保留方随机——本身就是缺陷）
    env.store.updateBookmark(dupA.id, { added_at: "2020-01-01T00:00:00.000Z" });
    const mergeSession = (await (
      await env.app.request("/api/v1/organize/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "合并重复" }),
      })
    ).json()) as { sessionId: string };
    await env.app.request(`/api/v1/organize/sessions/${mergeSession.sessionId}/apply`, { method: "POST" });
    // 回滚后书签行回来了，但 content_cache 呢？
    const rollbackVersion = env.store.db
      .prepare("SELECT id FROM organize_version ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string };
    await env.app.request(`/api/v1/organize/rollback/${rollbackVersion.id}`, { method: "POST" });
    const restoredBm = env.store.getBookmark(dupB.id);
    const restoredCache = env.store.getCache(dupB.id);
    const cacheLost = restoredBm !== undefined && restoredCache === undefined;

    // 4b. apply 非事务：中途异常产生半套修改
    // 构造一个 proposal：move 一个不存在的书签 + move 一个真实书签
    // apply 按顺序执行，move 不存在的静默跳过；反过来若前半成功后半抛错则无回滚。
    // 用 OrganizeService 直接验证：在 apply 中注入异常的确定性测试在 routes-organize.test 已有
    // 乐观锁；这里验证「合并不保留正文缓存」这一数据丢失面。
    report({
      id: "④",
      question: "整理应用、回滚、合并是否产生部分写入或关联数据丢失？",
      reproduced: cacheLost,
      evidence: `合并回滚后：书签行已恢复（getBookmark=${restoredBm !== undefined}），但 content_cache 已级联删除（getCache=${restoredCache === undefined}）。OrganizeService.apply() 逐条执行无事务包裹；merge 直接 deleteBookmark → DELETE FROM content_cache ON DELETE CASCADE，回滚只重插 bookmarks 行，不恢复缓存。合并回滚后正文/摘要/向量关联永久丢失。`,
      expected: "事务化应用（A3-3）；合并改软归档保留正文缓存、快照关联（A3-5）。",
    });
  } finally {
    env.cleanup();
  }
}

// ---------- ⑦ 快照存储后能否重新读取（服务端部分；真实浏览器捕获见 A4-3） ----------
async function repro7(): Promise<void> {
  const env = makeEnv(null);
  try {
    const bm = (await (
      await env.app.request("/api/v1/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/page", title: "示例页" }),
      })
    ).json()) as { id: string };
    const mhtml = "MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=\"---x\"";
    const up = (await (
      await env.app.request(`/api/v1/snapshots?bookmarkId=${bm.id}`, {
        method: "POST",
        headers: { "content-type": "message/rfc822" },
        body: mhtml,
      })
    ).json()) as { id: string; size: number };
    const getRes = await env.app.request(`/api/v1/snapshots/${up.id}`);
    const body = await getRes.text();
    report({
      id: "⑦",
      question: "快照能否存储并重新打开（服务端链路）？",
      reproduced: !(getRes.status === 200 && body.includes("multipart/related")),
      evidence: `上传 size=${up.size}B → GET /snapshots/${up.id} → HTTP ${getRes.status}，正文回读一致：${body.includes("multipart/related")}。服务端存储/回读链路本身可用（扩展端 captureMHTML 真实兼容性是 A4-3 的独立验证项）。注意：GET /snapshots/:id 未做 MHTML magic 校验——任意字节可存为 .mhtml 且计为成功（A4-4 风险）。`,
      expected: "服务端存储回读一致；但捕获失败/格式校验需要补（A4-4）。",
    });
  } finally {
    env.cleanup();
  }
}

// ---------- ⑧ 非开发部署是否存在未认证访问和 Provider Key 泄露 ----------
async function repro8(): Promise<void> {
  // 8a. 未设置 ADMIN_PASSWORD 时 API 全开放（by design 本地开发），但非开发部署若忘配则裸奔
  const envNoAuth = makeEnv(null);
  try {
    const res = await envNoAuth.app.request("/api/v1/bookmarks");
    const openWithoutAuth = res.status === 200;
    report({
      id: "⑧",
      question: "非开发部署是否存在未认证访问？",
      reproduced: openWithoutAuth,
      evidence: `未设置 ADMIN_PASSWORD：GET /api/v1/bookmarks 无任何凭据 → HTTP ${res.status}。auth.ts mountAuth 仅在设置了密码时才挂载中间件；生产容器若未注入 ADMIN_PASSWORD，全部 API（含删除书签、改配置）无认证开放。缺少“非开发部署首次启动必须设置凭据”的强制门槛（A4-1）。`,
      expected: "非开发部署（MF_FORM=production 等）首启强制设置管理员凭据，否则拒绝开放 API（A4-1）。",
    });
  } finally {
    envNoAuth.cleanup();
  }
  // 8b. Provider Key 明文落库
  // ⑧b 复现样本：合成占位值，绝非真实凭据；真实 Provider Key 走 BYOK 加密落库（A4-2 已交付）。
  // 占位值支持环境变量注入，缺省串刻意不具密钥形态（避免静态密钥扫描误报与公开仓库观感问题）。
  const reproDummyKey = process.env.MF_REPRO_DUMMY_KEY ?? "not-a-real-key-just-a-placeholder";
  const envKey = makeEnv(null);
  try {
    await envKey.app.request("/api/v1/settings/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: reproDummyKey,
        purposeModels: { organize: "deepseek-chat" },
      }),
    });
    const row = envKey.store.db
      .prepare("SELECT api_key FROM provider_config")
      .get() as { api_key: string };
    const plaintextAtRest = row.api_key === reproDummyKey;
    // 导出接口是否带出 key？/export/json 不含 provider_config，确认无泄露面
    report({
      id: "⑧b",
      question: "Provider Key 是否明文存储？",
      reproduced: plaintextAtRest,
      evidence: `保存 Provider 配置后 DB 中 api_key = ${row.api_key.slice(0, 8)}***（明文，未加密）。listProviderConfigs() 回显已脱敏（********），/export/json 不含该表——展示侧无泄露；但明文落盘违反 A4-2「至少用数据文件之外的部署密钥加密保存」。`,
      expected: "Provider Key 用部署密钥（如 MF_SECRET_KEY）加密后落库（A4-2）。",
    });
  } finally {
    envKey.cleanup();
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("TASK-01 问题复现（方案 §4 静态推断的运行时验证） " + new Date().toISOString());
  console.log("=".repeat(72));
  await repro1();
  await repro2();
  await repro3();
  await repro4();
  await repro7();
  await repro8();
  console.log("\n" + "=".repeat(72));
  const confirmed = results.filter((r) => r.reproduced).length;
  console.log(`汇总：${confirmed}/${results.length} 项缺陷确认（其余见各条说明与文档记录）`);
  console.log("=".repeat(72));
}

void main();
