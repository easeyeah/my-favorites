/**
 * 新标签页小组件注册表（D41 · docs/归档/新标签页小组件方案-v0.3.md）
 *
 * 与 lib/modules.ts 能力模块同构：注册即用，自定义面板开关自动出现。
 * v0.2 用户拍板「可控制的只有显示/隐藏」——无 settings 字段、无排序，
 * 卡片展示顺序 = 本数组顺序，内容固定。
 */
export type WidgetId = "ip" | "weather" | "almanac";

export const WIDGET_REGISTRY: ReadonlyArray<{ id: WidgetId; label: string; icon: string }> = [
  { id: "ip", label: "公网 IP", icon: "🌐" },
  { id: "weather", label: "天气", icon: "⛅" },
  { id: "almanac", label: "黄历", icon: "📅" },
];
