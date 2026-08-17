import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, patchConfig } from "./config.ts";
import type { Backend, PluginConfig } from "./types.ts";
import { TARGET_LANGUAGES, languageName } from "./types.ts";

export async function runConfigure(ctx: ExtensionContext): Promise<PluginConfig | undefined> {
  if (!ctx.hasUI) return undefined;
  let cfg = await loadConfig();

  for (;;) {
    const item = await ctx.ui.select("Bilingual settings", [
      { label: "done", description: summarize(cfg) },
      { label: "enabled", description: cfg.enabled ? "on" : "off" },
      { label: "backend", description: cfg.backend },
      { label: "target", description: `${cfg.target} · ${languageName(cfg.target)}` },
      { label: "thinking", description: cfg.translateThinking ? "on" : "off" },
      { label: "text", description: cfg.translateText ? "card under reply" : "off" },
      { label: "review", description: cfg.reviewEnglish ? "check English prompts" : "off" },
      { label: "provider", description: providerHint(cfg) },
      { label: "more", description: `source ${cfg.sourceLang}` },
    ]);
    if (item === undefined) return undefined;
    if (item === "done") return patchConfig(cfg);
    const next = await editItem(ctx, cfg, item);
    if (next) cfg = next;
  }
}

async function editItem(
  ctx: ExtensionContext,
  cfg: PluginConfig,
  item: string,
): Promise<PluginConfig | undefined> {
  if (item === "enabled") {
    const v = await ctx.ui.select("Enabled", [
      { label: "on", description: "Translate English replies" },
      { label: "off", description: "Leave replies unchanged" },
    ]);
    if (v === undefined) return undefined;
    return { ...cfg, enabled: v === "on" };
  }
  if (item === "backend") {
    const backend = await pickBackend(ctx, cfg.backend);
    if (backend === undefined) return undefined;
    return { ...cfg, backend };
  }
  if (item === "target") {
    const target = await pickOrType(
      ctx,
      "Target language",
      cfg.target,
      TARGET_LANGUAGES.map((l) => ({ label: l.code, description: l.name })),
    );
    if (target === undefined) return undefined;
    return { ...cfg, target };
  }
  if (item === "thinking") {
    const v = await ctx.ui.select("Translate thinking", [
      { label: "on", description: "Show translation under thinking" },
      { label: "off", description: "Skip thinking blocks" },
    ]);
    if (v === undefined) return undefined;
    return { ...cfg, translateThinking: v === "on" };
  }
  if (item === "text") {
    const v = await ctx.ui.select("Translate reply text", [
      { label: "on", description: "Card directly under the English reply" },
      { label: "off", description: "Thinking only" },
    ]);
    if (v === undefined) return undefined;
    return { ...cfg, translateText: v === "on" };
  }
  if (item === "review") {
    const v = await ctx.ui.select("Review English prompts", [
      { label: "on", description: "Grammar and clearer phrasing after you send" },
      { label: "off", description: "Do not review prompts" },
    ]);
    if (v === undefined) return undefined;
    return { ...cfg, reviewEnglish: v === "on" };
  }
  if (item === "provider") return editProvider(ctx, cfg);
  if (item === "more") return editMore(ctx, cfg);
  return undefined;
}

async function editProvider(ctx: ExtensionContext, cfg: PluginConfig): Promise<PluginConfig | undefined> {
  if (cfg.backend === "google") {
    ctx.ui.notify("Google needs no API key", "info");
    return cfg;
  }
  if (cfg.backend === "deepseek") {
    const apiKey = await promptSecret(ctx, "DeepSeek API key", cfg.deepseekApiKey);
    if (apiKey === undefined) return undefined;
    const model = await pickOrType(ctx, "DeepSeek model", cfg.deepseekModel, [
      { label: "deepseek-v4-flash", description: "Default, cheaper" },
      { label: "deepseek-v4-pro", description: "Stronger" },
    ]);
    if (model === undefined) return undefined;
    return { ...cfg, deepseekApiKey: apiKey, deepseekModel: model };
  }
  const apiKey = await promptSecret(ctx, "Hunyuan / TokenHub API key", cfg.hunyuanApiKey);
  if (apiKey === undefined) return undefined;
  const baseUrl = await pickOrType(ctx, "Hunyuan base URL", cfg.hunyuanBaseUrl, [
    { label: "https://api.hunyuan.cloud.tencent.com/v1", description: "Official Hunyuan" },
    { label: "https://tokenhub.tencentmaas.com/v1", description: "TokenHub CN" },
  ]);
  if (baseUrl === undefined) return undefined;
  const model = await pickOrType(ctx, "Hunyuan model", cfg.hunyuanModel, [
    { label: "hunyuan-turbos-latest", description: "Official default" },
    { label: "hy3", description: "TokenHub" },
  ]);
  if (model === undefined) return undefined;
  return { ...cfg, hunyuanApiKey: apiKey, hunyuanBaseUrl: baseUrl, hunyuanModel: model };
}

async function editMore(ctx: ExtensionContext, cfg: PluginConfig): Promise<PluginConfig | undefined> {
  const item = await ctx.ui.select("More", [
    { label: "back", description: "Return" },
    { label: "source", description: cfg.sourceLang },
  ]);
  if (item === undefined || item === "back") return undefined;
  const sourceLang = await pickOrType(ctx, "Source language", cfg.sourceLang, [
    { label: "auto", description: "Detect" },
    { label: "en", description: "English" },
    { label: "zh-CN", description: "Simplified Chinese" },
    { label: "ja", description: "Japanese" },
    { label: "ko", description: "Korean" },
  ]);
  if (sourceLang === undefined) return undefined;
  return { ...cfg, sourceLang };
}

function summarize(cfg: PluginConfig): string {
  const on = cfg.enabled ? "on" : "off";
  const think = cfg.translateThinking ? "thinking" : "no-thinking";
  return `${on} · ${cfg.backend} · ${cfg.target} · ${think}`;
}

function providerHint(cfg: PluginConfig): string {
  if (cfg.backend === "google") return "no key";
  if (cfg.backend === "deepseek") {
    return `${cfg.deepseekModel}${cfg.deepseekApiKey ? "" : " · no key"}`;
  }
  return `${cfg.hunyuanModel}${cfg.hunyuanApiKey ? "" : " · no key"}`;
}

async function pickBackend(ctx: ExtensionContext, current: Backend): Promise<Backend | undefined> {
  const label = await ctx.ui.select("Translation backend", [
    { label: "google", description: current === "google" ? "Current · free, no key" : "Free, no key" },
    { label: "deepseek", description: current === "deepseek" ? "Current · needs API key" : "Needs API key" },
    { label: "hunyuan", description: current === "hunyuan" ? "Current · needs API key" : "Needs API key" },
  ]);
  if (label === "google" || label === "deepseek" || label === "hunyuan") return label;
  return undefined;
}

async function pickOrType(
  ctx: ExtensionContext,
  title: string,
  current: string,
  presets: Array<{ label: string; description: string }>,
): Promise<string | undefined> {
  const label = await ctx.ui.select(title, [
    ...presets.map((p) => ({
      label: p.label,
      description: p.label === current ? `Current · ${p.description}` : p.description,
    })),
    { label: "custom", description: current ? `Current: ${current}` : "Type a value" },
  ]);
  if (label === undefined) return undefined;
  if (label !== "custom") return label;
  const typed = await ctx.ui.input(title, current);
  if (typed === undefined) return undefined;
  return typed.trim() || current;
}

async function promptSecret(
  ctx: ExtensionContext,
  title: string,
  current: string,
): Promise<string | undefined> {
  const typed = await ctx.ui.input(title, current ? "leave empty to keep current" : "paste key");
  if (typed === undefined) return undefined;
  const trimmed = typed.trim();
  return trimmed || current;
}
