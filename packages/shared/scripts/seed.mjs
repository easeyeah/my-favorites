// 种子数据：含边界情况的书签集（技术方案 §8.1）
// 用法：pnpm seed —— 生成 JSON 供 ingest 接口与导入流程测试
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const now = Date.now();
const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();

const bookmarks = [
  // 重复 URL（规范化后一致 → 查重应跳过其一）
  { url: "https://github.com/microsoft/vscode?utm_source=news", title: "VS Code", folderPath: ["开发", "编辑器"], addedAt: daysAgo(300) },
  { url: "http://www.github.com/microsoft/vscode/", title: "VS Code（重复）", folderPath: ["开发"], addedAt: daysAgo(299) },
  // 隐私域名（导入即只存 URL）
  { url: "https://icbc.bank/login", title: "银行登录", folderPath: ["财务"], addedAt: daysAgo(200) },
  // 疑似死链（示例域名）
  { url: "https://very-old-blog.example.com/2019/post", title: "旧博客", folderPath: ["阅读"], addedAt: daysAgo(900) },
  // 开发类样本（域名规则应命中）
  { url: "https://docs.rust-lang.org/book/", title: "The Rust Book", folderPath: ["学习"], addedAt: daysAgo(120) },
  { url: "https://developer.mozilla.org/zh-CN/docs/Web", title: "MDN Web Docs", folderPath: ["开发"], addedAt: daysAgo(60) },
  // 视频类
  { url: "https://www.bilibili.com/video/BV1xx411c79H", title: "教程视频", folderPath: ["娱乐"], addedAt: daysAgo(30) },
  // 超长标题边界
  { url: "https://example.com/long", title: "超长标题".repeat(60), folderPath: [], addedAt: daysAgo(10) },
  // 收件箱待分类（无 folderPath）
  { url: "https://tailwindcss.com/docs", title: "Tailwind CSS", folderPath: [], addedAt: daysAgo(1) },
];

const out = {
  idempotencyKey: "seed-00000001",
  items: bookmarks,
};

mkdirSync(path.resolve(import.meta.dirname, "../../../apps/server/seed"), { recursive: true });
const file = path.resolve(import.meta.dirname, "../../../apps/server/seed/seed-bookmarks.json");
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`✅ ${bookmarks.length} 条种子书签已生成：${file}`);
