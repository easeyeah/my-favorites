/**
 * 标签/分类的展示图标（D65 视觉增强，用户「给标签加个 emoji 图标」）。
 * 展示层职责，不进数据——tags/category 原值仍供筛选与 MCP 消费。
 * 确定性映射：关键词规则优先；未命中按稳定哈希从中性图标池取一枚，
 * 同一标签恒定同一图标（跨会话不漂移，面板与行上图标必然一致）。
 */

/** 分类一级目录的推荐图标（与 D65 prompt 的推荐清单对齐） */
const CATEGORY_EMOJI: Array<[RegExp, string]> = [
  [/技术开发|开发|编程|代码/, "💻"],
  [/商业|财经|创业|增长/, "📈"],
  [/生活|居家|服务/, "🏠"],
  [/学习|教育|课程|教程/, "📚"],
  [/设计|创意|配色|灵感/, "🎨"],
  [/娱乐|影视|视频|内容/, "🎬"],
  [/工具|资源|效率|软件/, "🧰"],
  [/其他/, "📦"],
];

const KEYWORD_EMOJI: Array<[RegExp, string]> = [
  [/react/i, "⚛️"],
  [/vue/i, "💚"],
  [/rust/i, "🦀"],
  [/docker|容器|kubernetes|k8s|运维|服务器|后端|部署|数据库/i, "🐳"],
  [/python/i, "🐍"],
  [/ai|模型|大模型|llm|智能/i, "🤖"],
  [/算法|数据结构|刷题|面试/i, "🧮"],
  [/css|tailwind|样式|配色|设计|灵感/i, "🎨"],
  [/云|api|服务|网络|音视频/i, "☁️"],
  [/安全|加密|隐私/i, "🔒"],
  [/数据|统计|分析|可视化/i, "📊"],
  [/视频|电影|影音|媒体/i, "🎬"],
  [/笔记|写作|文档|卡片/i, "✍️"],
  [/周刊|资讯|新闻|日报|博客/i, "🗞️"],
  [/效率|工具|快捷|自动化/i, "⚡"],
  [/前端|javascript|typescript|html|js\b/i, "🧩"],
  [/读书|课程|学习|教程|指南|手册|方法论/i, "📚"],
  [/商业|财经|增长|创业/i, "💼"],
];

const FALLBACK_EMOJI = ["🏷️", "🔖", "📌", "🧩", "💡", "🗂️", "📎", "🔍"];

function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 分类路径的图标（按一级目录匹配；未知目录走标签规则兜底） */
export function categoryEmoji(category: string): string {
  const top = category.split("/")[0] ?? "";
  for (const [re, emoji] of CATEGORY_EMOJI) if (re.test(top)) return emoji;
  return tagEmoji(top);
}

/** 标签的图标：关键词规则优先，未命中按稳定哈希从池中取（同一标签恒定同一图标） */
export function tagEmoji(tag: string): string {
  for (const [re, emoji] of KEYWORD_EMOJI) if (re.test(tag)) return emoji;
  return FALLBACK_EMOJI[stableHash(tag) % FALLBACK_EMOJI.length] ?? "🏷️";
}
