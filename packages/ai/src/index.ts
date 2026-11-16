/** 供应商注册表类型与访问（技术方案 §6.1）——注册表即数据，新增供应商=加一条 JSON */
import providersJson from "./providers.json";

export type ApiStyle = "openai-compatible" | "anthropic";
export type ProviderGroup = "国内" | "国际" | "本地" | "自定义";

export interface ProviderPreset {
  id: string;
  name: string;
  group: ProviderGroup;
  apiStyle: ApiStyle;
  /** null = 需用户自填（自定义/待核对接入项，见 providers.json 的 baseUrlNote） */
  baseUrl: string | null;
  baseUrlNote?: string;
  keyUrl: string | null;
  models: string[];
  supportsModelsApi: boolean;
  needsKey?: boolean;
  /** 自定义供应商模板项，选择器里单独渲染 */
  template?: boolean;
}

export const PROVIDERS = providersJson.providers as ProviderPreset[];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** 用途维度（技术方案 §6.1：整理/摘要/embedding 分别指定模型） */
export type ModelPurpose = "organize" | "summarize" | "embedding";

export interface ProviderConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string | null;
  /** purpose -> model id */
  purposeModels: Partial<Record<ModelPurpose, string>>;
  enabled: boolean;
}

/** 运行时解析顺序：按用途指定 -> 默认供应商默认模型 -> llm_unavailable */
export function resolveModel(
  configs: ProviderConfig[],
  purpose: ModelPurpose,
): { config: ProviderConfig; model: string } | null {
  for (const config of configs) {
    if (!config.enabled) continue;
    const model = config.purposeModels[purpose];
    if (model) return { config, model };
  }
  for (const config of configs) {
    if (!config.enabled) continue;
    const preset = getPreset(config.providerId);
    const model = preset?.models[0];
    if (model && purpose !== "embedding") return { config, model };
  }
  return null;
}
