import { describe, expect, it } from "vitest";
import {
  bestIp,
  ipRegionLine,
  isIpv4,
  normalizeOpenMeteo,
  normalizeWttr,
  parseCloudflareTrace,
  parseIpPlain,
  parseIpipText,
  pickIp,
  weatherCityFromIp,
  weatherIcon,
} from "./widgets";

describe("isIpv4（IP 择优逻辑依赖）", () => {
  it("v4/v6 边界", () => {
    expect(isIpv4("223.149.24.85")).toBe(true);
    expect(isIpv4("255.255.255.255")).toBe(true);
    expect(isIpv4("256.1.1.1")).toBe(false);
    expect(isIpv4("2400:3200::1")).toBe(false);
  });
});

describe("pickIp/bestIp（v0.3.2 点击切换 IPv4/IPv6）", () => {
  const v4rich = { ip: "223.149.24.85", province: "湖南", city: "怀化", isp: "电信" };
  const v4plain = { ip: "1.2.3.4" };
  const v6 = { ip: "240e:380:cb20::1", country: "CN" };
  it("默认择优 IPv4+归属优先", () => {
    expect(bestIp([v6, v4plain, v4rich])).toBe(v4rich);
    expect(bestIp([v6, v4plain])).toBe(v4plain);
    expect(bestIp([v6])).toBe(v6);
    expect(bestIp([])).toBeNull();
  });
  it("按族切换", () => {
    expect(pickIp([v6, v4rich], "v6")).toBe(v6);
    expect(pickIp([v6, v4rich], "v4")).toBe(v4rich);
    expect(pickIp([v4plain, v4rich], "v4")).toBe(v4rich); // 同族取带归属的
  });
  it("目标族缺失回退首个（不留白）", () => {
    expect(pickIp([v6], "v4")).toBe(v6);
    expect(pickIp([v4rich], "v6")).toBe(v4rich);
    expect(pickIp([], "v4")).toBeNull();
  });
  it("按 ip 去重", () => {
    expect(pickIp([v4plain, { ...v4plain, city: "长沙" }, v4rich], "v4")).toEqual({
      ip: "223.149.24.85",
      province: "湖南",
      city: "怀化",
      isp: "电信",
    });
  });
});

describe("parseIpipText（myip.ipip.net 实测文本形态）", () => {
  it("标准省市区+运营商", () => {
    const r = parseIpipText("当前 IP：223.149.24.85  来自于：中国 湖南 怀化  电信");
    expect(r).toEqual({ ip: "223.149.24.85", country: "中国", province: "湖南", city: "怀化", isp: "电信" });
  });
  it("直辖市：省=市", () => {
    const r = parseIpipText("当前 IP：1.2.3.4 来自于：中国 北京 北京  联通");
    expect(r).toMatchObject({ province: "北京", city: "北京", isp: "联通" });
  });
  it("海外三段无运营商", () => {
    const r = parseIpipText("当前 IP：8.8.8.8  来自于：美国 加利福尼亚 洛杉矶");
    expect(r).toEqual({ ip: "8.8.8.8", country: "美国", province: "加利福尼亚", city: "洛杉矶" });
  });
  it("IPv6 + 仅 IP", () => {
    expect(parseIpipText("当前 IP：2400:3200::1 来自于：中国 广东 深圳  电信")?.ip).toBe("2400:3200::1");
    expect(parseIpipText("当前 IP：1.1.1.1")).toEqual({ ip: "1.1.1.1" });
  });
  it("垃圾输入返回 null", () => {
    for (const bad of ["", "403 Forbidden", "当前 IP：abc", "<html>"]) {
      expect(parseIpipText(bad)).toBeNull();
    }
  });
});

describe("IP 兜底源解析", () => {
  it("cloudflare trace 键值行", () => {
    const r = parseCloudflareTrace("fl=1488\nh=cloudflare.com\nip=223.149.24.85\nloc=CN\nvisitsheme=https\n");
    expect(r).toEqual({ ip: "223.149.24.85", country: "CN" });
    expect(parseCloudflareTrace("ip=XX\nloc=XX")).toBeNull();
  });
  it("纯 IP 文本", () => {
    expect(parseIpPlain("223.149.24.85\n")).toEqual({ ip: "223.149.24.85" });
    expect(parseIpPlain("<html>")).toBeNull();
  });
});

describe("IP 卡与天气定位", () => {
  const cn = parseIpipText("当前 IP：223.149.24.85  来自于：中国 湖南 怀化  电信")!;
  it("归属地小字", () => {
    expect(ipRegionLine(cn)).toBe("湖南 怀化 · 电信");
    expect(ipRegionLine({ ip: "1.1.1.1" })).toBeNull();
  });
  it("城市提取：市→省→null", () => {
    expect(weatherCityFromIp(cn)).toBe("怀化");
    expect(weatherCityFromIp({ ip: "1.1.1.1", country: "美国", province: "California" })).toBe("California");
    expect(weatherCityFromIp({ ip: "1.1.1.1" })).toBeNull();
  });
});

describe("wttr.in j1 归一化（实测结构）", () => {
  const fixture = {
    current_condition: [
      { temp_C: "14", FeelsLikeC: "12", humidity: "47", windspeedKmph: "8", weatherCode: "113", weatherDesc: [{ value: "Sunny" }] },
    ],
    weather: [
      { date: "2026-11-20", maxtempC: "18", mintempC: "9", hourly: [] },
      { date: "2026-11-21", maxtempC: "17", mintempC: "10", hourly: [] },
    ],
  };
  it("完整归一化", () => {
    expect(normalizeWttr(fixture, "怀化")).toEqual({
      city: "怀化",
      source: "wttr",
      now: { tempC: 14, feelsC: 12, humidity: 47, windKph: 8, code: "113", desc: "Sunny" },
      days: [
        { date: "2026-11-20", maxC: 18, minC: 9 },
        { date: "2026-11-21", maxC: 17, minC: 10 },
      ],
    });
  });
  it("缺 current_condition → null", () => {
    expect(normalizeWttr({}, "怀化")).toBeNull();
    expect(normalizeWttr(null, "怀化")).toBeNull();
  });
});

describe("Open-Meteo 归一化", () => {
  const om = {
    current: { temperature_2m: 14.2, apparent_temperature: 12.8, relative_humidity_2m: 47, wind_speed_10m: 7.4, weather_code: 1 },
    daily: { time: ["2026-11-20", "2026-11-21"], weather_code: [1, 3], temperature_2m_max: [18.1, 17.2], temperature_2m_min: [9.3, 10.1] },
  };
  it("数组对齐展开", () => {
    const r = normalizeOpenMeteo(om, "成都")!;
    expect(r.source).toBe("open-meteo");
    expect(r.now.tempC).toBe(14.2);
    expect(r.days).toEqual([
      { date: "2026-11-20", maxC: 18.1, minC: 9.3 },
      { date: "2026-11-21", maxC: 17.2, minC: 10.1 },
    ]);
  });
  it("缺 current → null", () => expect(normalizeOpenMeteo({}, "成都")).toBeNull());
});

describe("天气码映射", () => {
  it("WWO 主查", () => {
    expect(weatherIcon("113", "Sunny", "wttr")).toEqual({ icon: "☀️", label: "晴" });
    expect(weatherIcon("386", "Thundery outbreaks", "wttr")).toEqual({ icon: "⛈️", label: "雷阵雨" });
  });
  it("WMO 主查 + 跨表防御", () => {
    expect(weatherIcon("95", undefined, "open-meteo")).toEqual({ icon: "⛈️", label: "雷阵雨" });
    expect(weatherIcon("113", undefined, "open-meteo").label).toBe("晴"); // 113 不在 WMO 域，跨到 WWO 表
  });
  it("未命中码 → 描述兜底；无描述 → 未知", () => {
    expect(weatherIcon("12345", "Hail", "wttr")).toEqual({ icon: "🌡️", label: "Hail" });
    expect(weatherIcon(undefined, undefined, "wttr")).toEqual({ icon: "🌡️", label: "未知" });
  });
});
