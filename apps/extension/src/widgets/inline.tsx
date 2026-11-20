/**
 * 小组件内联渲染（D41，2026-11-20 用户反馈「卡片太俗，要和页面融为一体」；
 * v0.3.3 位置修订「别把搜索框挤开」）：不给组件加盒子——统一沉页脚信息组，
 * 自上而下 天气 → 黄历（主/辅两档字阶）→ IP → 品牌行，核心区（时钟/搜索/最常访问）位置恒定：
 * - 天气（详情收进 title，hover 可见）
 * - 黄历（农历干支主行 + 宜忌辅行）
 * - 公网 IP（双栈点击切 IPv4/IPv6 并记忆，单族点击重探）
 * 数据层（TTL 缓存/多源回退/降级）复用 fetchers.ts。
 */
import { useCallback, useEffect, useState } from "react";
import { formatAlmanac } from "@mf/shared/almanac";
import type { IpFamily, WeatherSnapshot } from "@mf/shared";
import { ipRegionLine, isIpv4, pickIp, weatherIcon } from "@mf/shared";
import {
  FRIENDLY_ERRORS,
  getIpFamilyPref,
  getIpProbe,
  getWeather,
  setIpFamilyPref,
  type IpProbe,
} from "./fetchers";

/** IP 探测结果适配进通用 hook 的 data/stale 形态（模块级常量保持引用稳定） */
const loadIp = (force?: boolean) => getIpProbe(force).then((p) => ({ data: p, stale: p.stale }));

interface WidgetState<T> {
  data: T | null;
  stale: boolean;
  error: string | null;
  loading: boolean;
}

/** 挂载取数（TTL 内命中缓存不出网）+ 回前台按 TTL 校验；失败保旧数据转 stale */
function useWidgetData<T>(loader: (force?: boolean) => Promise<{ data: T; stale: boolean }>): WidgetState<T> & { reload: () => void } {
  const [state, setState] = useState<WidgetState<T>>({ data: null, stale: false, error: null, loading: true });

  const load = useCallback(
    (force: boolean) => {
      setState((s) => ({ ...s, loading: true }));
      loader(force)
        .then((r) => setState({ data: r.data, stale: r.stale, error: null, loading: false }))
        .catch((e: Error) =>
          setState((s) =>
            s.data
              ? { ...s, stale: true, error: null, loading: false }
              : { data: null, stale: false, error: FRIENDLY_ERRORS[e.message] ?? "加载失败", loading: false },
          ),
        );
    },
    [loader],
  );

  useEffect(() => {
    load(false);
    const onVis = () => {
      if (document.visibilityState === "visible") load(false);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [load]);

  return { ...state, reload: () => load(true) };
}

/** 失败态：一行内联小字 + 下划线重试（D40 教训——不静默吞错） */
function InlineError({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <span className="text-neutral-400">
      {label}
      <button className="ml-1 underline cursor-pointer hover:text-neutral-600" onClick={onRetry}>
        重试
      </button>
    </span>
  );
}

/** 天气：融进日期行——「怀化 ☀️ 14°」，体感/湿度/风/三日收进 hover */
export function WeatherInline() {
  const { data, stale, error, loading, reload } = useWidgetData<WeatherSnapshot>(getWeather);
  if (!data) {
    if (loading) return null;
    return error ? <InlineError label="天气不可用" onRetry={reload} /> : null;
  }
  const w = weatherIcon(data.now.code, data.now.desc, data.source);
  const days = data.days
    .slice(0, 3)
    .map((d, i) => `${["今", "明", "后"][i] ?? d.date.slice(5)} ${d.minC}~${d.maxC}°`)
    .join(" ");
  return (
    <span
      data-testid="widget-weather"
      title={`体感 ${data.now.feelsC}° · 湿度 ${data.now.humidity}% · 风 ${data.now.windKph}km/h${days ? ` · ${days}` : ""}${stale ? " · 数据未更新" : ""}`}
    >
      {data.city} {w.icon} {data.now.tempC}°{stale && "·未更新"}
    </span>
  );
}

/**
 * 黄历单行版（v0.3.4 走查「内容还是多」；v0.3.6 用色收束：只给「宜」「忌」二字着色）：
 * `农历十月十二  宜 合帐 裁衣  忌 置产 造船` 三段横排，整体中性灰；
 * 仅「宜」字淡绿、「忌」字淡红（与产品语义色族同构：绿正向/红负向，
 * 低饱和 80%/70% 透明度），其余内容一律不着色（用户定样）；
 * 干支生肖/冲煞/节气节日/宜忌全量收进 hover title。
 * lunar-typescript 本地算，跨日界定时重算。
 */
export function AlmanacInline() {
  const [almanac, setAlmanac] = useState(() => formatAlmanac(new Date()));
  useEffect(() => {
    let last = new Date().toDateString();
    const t = setInterval(() => {
      const now = new Date();
      if (now.toDateString() !== last) {
        last = now.toDateString();
        setAlmanac(formatAlmanac(now));
      }
    }, 30_000);
    return () => clearInterval(t);
  }, []);
  const mark = almanac.jieqi ?? almanac.festivals[0];
  return (
    <div
      data-testid="widget-almanac"
      className="flex flex-wrap items-center justify-center gap-2.5 text-xs text-neutral-500 dark:text-neutral-400"
      title={`${almanac.yearGanzhi}${almanac.zodiac}年 ${almanac.dayGanzhi}日 冲${almanac.chong}${mark ? ` · ${mark}` : ""}｜宜 ${almanac.yi.join(" ")}｜忌 ${almanac.ji.join(" ")}`}
    >
      <span>农历{almanac.lunarDate}</span>
      <span>
        <span className="text-green-600/80 dark:text-green-400/80">宜</span> {almanac.yi.slice(0, 2).join(" ")}
      </span>
      <span>
        <span className="text-red-500/70 dark:text-red-400/70">忌</span> {almanac.ji.slice(0, 2).join(" ")}
      </span>
    </div>
  );
}

/**
 * 公网 IP：页脚环境行，**默认只显示地址本体**（v0.3.4——归属/运营商收进 title）。
 * 双栈候选都在场 → 点击 = IPv4/IPv6 即时切换（偏好持久记忆，默认 IPv4）；
 * 只有单族 → 点击 = 强刷重探。彻底告别「顺序探测首成功即停 → 单族粘滞」。
 */
export function IpInline() {
  const { data, stale, error, loading, reload } = useWidgetData<IpProbe>(loadIp);
  const [family, setFamily] = useState<IpFamily>("v4");
  useEffect(() => {
    void getIpFamilyPref().then(setFamily);
  }, []);

  if (!data) {
    if (loading) return null;
    return error ? <InlineError label="IP 查询失败" onRetry={reload} /> : null;
  }
  const shown = pickIp(data.candidates, family);
  if (!shown) return null;

  const curFam: IpFamily = isIpv4(shown.ip) ? "v4" : "v6";
  const nextFam: IpFamily = curFam === "v4" ? "v6" : "v4";
  const nextAddr = data.candidates.find((i) => isIpv4(i.ip) !== (curFam === "v4"));
  const region = ipRegionLine(shown);

  const onClick = () => {
    if (nextAddr) {
      setFamily(nextFam);
      void setIpFamilyPref(nextFam);
    } else {
      reload();
    }
  };

  return (
    <button
      data-testid="widget-ip"
      className="cursor-pointer tabular-nums hover:text-neutral-600 dark:hover:text-neutral-300"
      title={`${region ?? ""}${nextAddr ? `｜点击切换 ${nextFam.toUpperCase()}：${nextAddr.ip}` : "｜点击重新查询"}`}
      onClick={onClick}
    >
      {shown.ip}
      {stale && " · 未更新"}
    </button>
  );
}
