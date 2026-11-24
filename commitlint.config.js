export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // 中文 subject 以数字/大写字母开头（如 "M1 骨架"）会被误判，放开大小写限制
    "subject-case": [0],
    // 标题总长（含 type/scope 前缀）：本仓库历史最长 62 字符，72 留余量（D90）
    "header-max-length": [2, "always", 72],
    // 正文/页脚按中文段落写，不做列宽折行（默认 100 会把整段判错）
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    // scope 可不写；写了必须落在受控集合，避免 server/后端/api 混用（D90）
    "scope-enum": [
      2,
      "always",
      ["server", "extension", "web", "shared", "ai", "e2e", "docs", "ci", "docker", "deps", "release", "repo"],
    ],
    // type 显式声明，杜绝 update/wip/fixup 这类自由发挥（D90）
    "type-enum": [2, "always", ["feat", "fix", "refactor", "perf", "test", "docs", "build", "ci", "chore", "revert", "style"]],
  },
};
