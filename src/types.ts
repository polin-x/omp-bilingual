export const CUSTOM_TYPE = "com.omp.bilingual";
export const PACKAGE_NAME = "omp-bilingual";
export const PACKAGE_VERSION = "0.1.8";

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
  sourceLang: string;
  translateThinking: boolean;
  thinkingDebounceMs: number;
  deepseekApiKey: string;
  deepseekModel: string;
  hunyuanApiKey: string;
  hunyuanBaseUrl: string;
  hunyuanModel: string;
};

export const TARGET_LANGUAGES: Array<{ code: string; name: string }> = [
  { code: "zh-CN", name: "Simplified Chinese" },
  { code: "zh-TW", name: "Traditional Chinese" },
  { code: "en", name: "English" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "es", name: "Spanish" },
  { code: "pt", name: "Portuguese" },
  { code: "ru", name: "Russian" },
  { code: "vi", name: "Vietnamese" },
  { code: "th", name: "Thai" },
  { code: "id", name: "Indonesian" },
  { code: "ar", name: "Arabic" },
];

export function languageName(code: string): string {
  const hit = TARGET_LANGUAGES.find((l) => l.code.toLowerCase() === code.trim().toLowerCase());
  return hit?.name ?? (code.trim() || "Simplified Chinese");
}

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  backend: "google",
  target: "zh-CN",
  sourceLang: "auto",
  translateThinking: true,
  thinkingDebounceMs: 2000,
  deepseekApiKey: "",
  deepseekModel: "deepseek-v4-flash",
  hunyuanApiKey: "",
  hunyuanBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
  hunyuanModel: "hunyuan-turbos-latest",
};
