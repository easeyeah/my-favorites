/**
 * 能力模块注册表（架构级内置插件）。
 * core 书签库不可关；navsite 导航站 / ai AI 接入 可开关。整理能力（失效检测/查重/重分类）已并入书签库 core。收纳盒是书签库内置视图，随 core 存在。
 * 开关只控制能力显隐与入口，数据永不删除（迁移只前进）。
 * 服务端按同一契约条件挂载路由与定时任务（切片 2）；当前 mock 环境下开关持久化在 localStorage。
 */
export type ModuleId = "navsite" | "ai";

export interface ModuleDef {
  id: ModuleId;
  title: string;
  desc: string;
  defaultEnabled: boolean;
}

export const MODULES: ModuleDef[] = [
  { id: "navsite", title: "导航站", desc: "把收藏变成一个可以分享出去的导航主页", defaultEnabled: true },
  { id: "ai", title: "AI 接入", desc: "BYOK 供应商，驱动归位/摘要/重分类；关闭时归位降级为规则引擎", defaultEnabled: true },
];

export type ModuleState = Record<ModuleId, boolean>;

const KEY = "mf-modules";

export function loadModules(): ModuleState {
  const def = Object.fromEntries(MODULES.map((m) => [m.id, m.defaultEnabled])) as ModuleState;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<ModuleState>;
    return { ...def, ...saved };
  } catch {
    return def;
  }
}

export function saveModules(state: ModuleState): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}
