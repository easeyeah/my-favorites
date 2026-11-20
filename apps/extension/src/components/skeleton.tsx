/**
 * 扩展端共享骨架（切片 A：全屏页/popup 骨架统一）。
 * 品牌图形标（三卡片阶梯）+ 产品名一行头：popup 紧凑档、全屏页标准档。
 * 品牌规则见 assets/brand/README.md：不换色、不加渐变/阴影/描边。
 */
export function BrandHeader({
  title = "my-favorites",
  compact = false,
  center = false,
}: {
  /** 标题文案（新标签页传导航站名；popup 用产品名） */
  title?: string;
  /** 紧凑档：popup 高度预算小 */
  compact?: boolean;
  /** 居中档：新标签页首屏 */
  center?: boolean;
}) {
  const mark = (
    <img
      src="/brand/mark-color.svg"
      alt=""
      aria-hidden
      draggable={false}
      className={(compact ? "size-5" : "size-7") + " shrink-0"}
    />
  );
  if (center) {
    return (
      <div className="flex flex-col items-center gap-2">
        {mark}
        <h1 className={(compact ? "text-lg" : "text-2xl") + " font-semibold tracking-tight"}>{title}</h1>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {mark}
      <h1 className={(compact ? "text-base" : "text-lg") + " font-semibold tracking-tight"}>{title}</h1>
    </div>
  );
}
