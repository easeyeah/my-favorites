export default {
  extends: ["@commitlint/config-conventional"],
  // 中文 subject 以数字/大写字母开头（如 "M1 骨架"）会被误判，放开大小写限制
  rules: { "subject-case": [0] },
};
