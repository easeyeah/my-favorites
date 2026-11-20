import { describe, expect, it } from "vitest";
import { formatAlmanac } from "./almanac";

describe("formatAlmanac（lunar-typescript 离线计算，口径与开发时实测输出核对）", () => {
  it("2026-11-20：十月十二 · 丙午马年 · 戊戌日", () => {
    const a = formatAlmanac(new Date(2026, 10, 20));
    expect(a.lunarDate).toBe("十月十二");
    expect(a.yearGanzhi).toBe("丙午");
    expect(a.zodiac).toBe("马");
    expect(a.dayGanzhi).toBe("戊戌");
    expect(a.chong).toBe("壬辰龙");
    expect(a.jieqi).toBeNull();
    expect(a.festivals).toEqual([]);
    expect(a.yi.slice(0, 3)).toEqual(["合帐", "裁衣", "嫁娶"]);
    expect(a.ji.slice(0, 3)).toEqual(["置产", "造船", "开光"]);
  });

  it("节气日：2026-12-07 大雪", () => {
    expect(formatAlmanac(new Date(2026, 11, 7)).jieqi).toBe("大雪");
  });

  it("节日：国庆", () => {
    expect(formatAlmanac(new Date(2026, 9, 1)).festivals.join("")).toContain("国庆");
  });

  it("跨日：次日农历进一", () => {
    expect(formatAlmanac(new Date(2026, 10, 21)).lunarDate).toBe("十月十三");
  });
});
