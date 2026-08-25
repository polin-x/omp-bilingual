export const CUSTOM_TYPE = "com.omp.bilingual";
export const REVIEW_TYPE = "com.omp.bilingual.review";
export const LEARN_TYPE = "com.omp.bilingual.learn";
export const PACKAGE_NAME = "omp-bilingual";
export const PACKAGE_VERSION = "0.1.66";

export type ReviewDetails = {
  source: string;
};

export type LearnDetails = {
  source: string;
};

export type Backend = "google" | "deepseek" | "hunyuan" | "custom";
export type FallbackSlot = Backend | "off";

export type CustomLlm = {
  alias: string;
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type Pair = {
  en: string;
  zh: string;
  kind?: "text" | "thinking" | "advisor";
  alias?: string;
  delayMs?: number;
};

export function translationSuffix(alias?: string, delayMs?: number): string {
  if (!alias || typeof delayMs !== "number") return "";
  return ` · ${alias} ${delayMs}ms`;
}

export type BilingualDetails = {
  pairs?: Pair[];
  texts?: string[];
  backend: Backend;
  chain?: string;
  ornament?: string;
  kind?: Pair["kind"];
};

export type PluginConfig = {
  enabled: boolean;
  backend: Backend;
  fallback1: FallbackSlot;
  fallback2: FallbackSlot;
  target: string;
  sourceLang: string;
  translateThinking: boolean;
  translateText: boolean;
  reviewEnglish: boolean;
  learnEnglish: boolean;
  ornament: string;
  ornamentGif: string;
  thinkingDebounceMs: number;
  deepseekApiKey: string;
  deepseekModel: string;
  hunyuanApiKey: string;
  hunyuanBaseUrl: string;
  hunyuanModel: string;
  customs: CustomLlm[];
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

export type OrnamentSpec = {
  id: string;
  name: string;
  frames: string[];
};

export const ORNAMENT_PRESETS: OrnamentSpec[] = [
  { id: "bar", name: "bar", frames: ["│"] },
  { id: "globe", name: "globe", frames: ["🌍", "🌎", "🌏"] },
  { id: "shinchan", name: "shinchan", frames: ["小新", "小☆", "☆新", "小新"] },
  { id: "lulu", name: "lulu", frames: ["✧🧡", "+🧡", "×🧡", "+🧡"] },
  { id: "file", name: "file", frames: ["│"] },
  { id: "gif", name: "gif", frames: ["│"] },
];
export function resolveOrnament(value: string): OrnamentSpec {
  const raw = value.trim() || "globe";
  const id = raw === "capybara" ? "lulu" : raw;
  const hit = ORNAMENT_PRESETS.find((p) => p.id === id);
  if (hit) return hit;
  return { id: "custom", name: id, frames: [id] };
}

export function ornamentFrame(value: string, atMs = Date.now()): string {
  const spec = resolveOrnament(value);
  return spec.frames[Math.floor(atMs / 220) % spec.frames.length] ?? spec.frames[0] ?? "│";
}

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  backend: "google",
  fallback1: "off",
  fallback2: "off",
  target: "zh-CN",
  sourceLang: "auto",
  translateThinking: true,
  translateText: true,
  reviewEnglish: true,
  learnEnglish: true,
  ornament: "globe",
  ornamentGif: "",
  thinkingDebounceMs: 2000,
  deepseekApiKey: "",
  deepseekModel: "deepseek-v4-flash",
  hunyuanApiKey: "",
  hunyuanBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
  hunyuanModel: "hunyuan-turbos-latest",
  customs: [],
};
