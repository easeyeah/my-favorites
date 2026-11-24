#!/usr/bin/env node
/**
 * changeset 门禁：功能改动必须附 changeset（AGENTS.md「提交与版本」、技术方案 §12）。
 *
 * 判据（相对 base 分支的改动）：
 *  - 触达可发布代码（apps/<app>/src、apps/extension/entrypoints、packages/<pkg>/src、
 *    包清单、docker/）→ 必须新增至少一条 `.changeset/*.md`；
 *  - 仅文档 / 测试 / CI 等改动 → 不要求，直接放行。
 *
 * 逃生门：提交信息含 `[skip changeset]`。发版 PR 本身就是消费 changeset（删 md + 改包
 * 清单），不该再被要求附 changeset。
 *
 * 用法：
 *   node scripts/check-changeset.mjs                 # CI：读 GITHUB_BASE_REF
 *   node scripts/check-changeset.mjs --base main     # 本地按分支名比
 *   node scripts/check-changeset.mjs --head HEAD~3
 *   SKIP_CHANGESET_CHECK=1 node scripts/check-changeset.mjs
 */
import { execFileSync } from "node:child_process";

/** 触发「必须附 changeset」的路径：可发布产物的源码与打包入口。 */
const CODE_PATTERNS = [
  /^apps\/[^/]+\/src\//,
  /^apps\/extension\/entrypoints\//,
  /^apps\/[^/]+\/wxt\.config\.(ts|js|mjs)$/,
  /^apps\/[^/]+\/package\.json$/,
  /^packages\/[^/]+\/src\//,
  /^packages\/[^/]+\/package\.json$/,
  /^docker\//,
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

if (process.env.SKIP_CHANGESET_CHECK === "1") {
  console.log("changeset 检查：SKIP_CHANGESET_CHECK=1，跳过。");
  process.exit(0);
}

const head = flag("--head", "HEAD");
const base = flag("--base", process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");

const git = (...argv) => execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const files = (diffArgs) => git("diff", "--name-only", ...diffArgs).split("\n").filter(Boolean);

let mergeBase;
try {
  mergeBase = git("merge-base", base, head);
} catch {
  console.error(`changeset 检查：无法定位 base（${base}）——本地请先 \`git fetch origin\`。`);
  process.exit(2);
}

const changed = files(["--diff-filter=ACMR", mergeBase, head]).filter((f) => !f.startsWith(".changeset/"));

const commits = git("log", "--format=%B", `${mergeBase}..${head}`);
if (/\[skip changeset\]/i.test(commits)) {
  console.log("changeset 检查：提交信息含 [skip changeset]，跳过。");
  process.exit(0);
}

const code = changed.filter((f) => CODE_PATTERNS.some((re) => re.test(f)));
if (!code.length) {
  console.log(`changeset 检查：本次改动 ${changed.length} 个文件，未触达可发布代码，无需 changeset。`);
  process.exit(0);
}

const added = files(["--diff-filter=A", mergeBase, head, "--", ".changeset"]).filter(
  (f) => /^\.changeset\/.+\.md$/.test(f) && !/\/README\.md$/.test(f),
);

if (added.length) {
  console.log(`changeset 检查：功能改动已附 ${added.length} 条 changeset（${added.join(", ")}）。`);
  process.exit(0);
}

console.error(
  [
    "changeset 检查失败：本次改动触达可发布代码，但没有新增 changeset。",
    "",
    "  改动的代码文件（前 10 个）：",
    ...code.slice(0, 10).map((f) => `    - ${f}`),
    code.length > 10 ? `    … 共 ${code.length} 个` : "",
    "",
    "  处理方式：",
    "    1. pnpm changeset          # 选择受影响包与升级级别，写下变更说明（提交 .changeset/*.md）",
    "    2. 仅在发版/纯工程改动时才用提交信息 `[skip changeset]`",
    "",
  ]
    .filter(Boolean)
    .join("\n"),
);
process.exit(1);
