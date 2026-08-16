export const CUSTOM_TYPE = "com.omp.bilingual";
export const PACKAGE_NAME = "omp-bilingual";

export type Backend = "google" | "deepseek" | "hunyuan";

export type Pair = {
  en: string;
  zh: string;
  kind?: "text" | "thinking";
};

export type BilingualDetails = {
  pairs: Pair[];
  backend: Backend;
};

export type PluginConfig = {
  enabled: boolean;
  backend: Backend;
  target: string;
  deepseekApiKey: string;
  deepseekModel: string;
  hunyuanApiKey: string;
  hunyuanBaseUrl: string;
  hunyuanModel: string;
};

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  backend: "google",
  target: "zh-CN",
  deepseekApiKey: "",
  deepseekModel: "deepseek-v4-flash",
  hunyuanApiKey: "",
  hunyuanBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
  hunyuanModel: "hunyuan-turbos-latest",
};
