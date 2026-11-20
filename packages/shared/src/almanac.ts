/**
 * 黄历本地计算（D41 切片 W1）——lunar-typescript（MIT，无依赖）离线产出，
 * 零网络、零隐私成本，断网可用。
 *
 * ⚠️ 仅经 `@mf/shared/almanac` 子路径出口，不进 index.ts：
 * 服务端 bundle（NAS 内存/镜像红线）不应拖入 448KB 的黄历数据表。
 */
import { Solar } from "lunar-typescript";

export interface AlmanacInfo {
  /** 如「十月十二」 */
  lunarDate: string;
  /** 丙午年（干支纪年） */
  yearGanzhi: string;
  /** 马（年生肖） */
  zodiac: string;
  /** 戊戌日（干支纪日） */
  dayGanzhi: string;
  /** 宜（前 5 项） */
  yi: string[];
  /** 忌（前 5 项） */
  ji: string[];
  /** 如「壬辰龙」（日冲） */
  chong: string;
  /** 当日恰为节气日则有值，如「大雪」 */
  jieqi: string | null;
  /** 公历+农历节日合并，如「立冬前日」类无则空 */
  festivals: string[];
}

export function formatAlmanac(date: Date = new Date()): AlmanacInfo {
  const solar = Solar.fromDate(date);
  const lunar = solar.getLunar();
  return {
    lunarDate: `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
    yearGanzhi: lunar.getYearInGanZhi(),
    zodiac: lunar.getYearShengXiao(),
    dayGanzhi: lunar.getDayInGanZhi(),
    yi: lunar.getDayYi().slice(0, 5),
    ji: lunar.getDayJi().slice(0, 5),
    chong: lunar.getDayChongDesc().replace(/[()（）]/g, ""),
    jieqi: lunar.getJieQi() || null,
    festivals: [...solar.getFestivals(), ...lunar.getFestivals()],
  };
}
