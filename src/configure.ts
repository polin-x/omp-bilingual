import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, patchConfig } from "./config.ts";
import type { Backend, CustomLlm, FallbackSlot, PluginConfig } from "./types.ts";
import { TARGET_LANGUAGES, languageName } from "./types.ts";
import { describeChain } from "./translate.ts";

export async function runConfigure(ctx: ExtensionContext): Promise<PluginConfig | undefined> {
  if (!ctx.hasUI) return undefined;
  let cfg = await loadConfig();

  for (;;) {
    const item = await ctx.ui.select("Bilingual settings", [
      { label: "done", description: summarize(cfg) },
      { label: "enabled", description: cfg.enabled ? "on" : "off" },
      { label: "backend", description: backendLabel(cfg) },
      { label: "fallback1", description: fallbackLabel(cfg, cfg.fallback1) },
      { label: "fallback2", description: fallbackLabel(cfg, cfg.fallback2) },
      { label: "target", description: `${cfg.target} · ${languageName(cfg.target)}` },
      { label: "thinking", description: cfg.translateThinking ? "on" : "off" },
      { label: "text", description: cfg.translateText ? "card under reply" : "off" },
      { label: "review", description: cfg.reviewEnglish ? "check English prompts" : "off" },
      { label: "learn", description: cfg.learnEnglish ? "Chinese prompts → English + memory tips" : "off" },
      { label: "provider", description: providerHint(cfg) },
      { label: "customs", description: customsHint(cfg) },
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
  if (item === "fallback1") {
    const fallback1 = await pickFallback(ctx, "First fallback", cfg.fallback1);
    if (fallback1 === undefined) return undefined;
    return { ...cfg, fallback1 };
  }
  if (item === "fallback2") {
    const fallback2 = await pickFallback(ctx, "Second fallback", cfg.fallback2);
    if (fallback2 === undefined) return undefined;
    return { ...cfg, fallback2 };
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
  if (item === "learn") {
    const v = await ctx.ui.select("Learn English from Chinese prompts", [
      { label: "on", description: "Show English + memory tips after a Chinese question" },
      { label: "off", description: "Do not coach Chinese prompts" },
    ]);
    if (v === undefined) return undefined;
    return { ...cfg, learnEnglish: v === "on" };
  }
  if (item === "provider") return editProvider(ctx, cfg);
  if (item === "customs") return editCustoms(ctx, cfg);
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
  if (cfg.backend === "custom") return editCustoms(ctx, cfg);
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
  return `${on} · ${describeChain(cfg)} · ${cfg.target} · ${think}`;
}

function customNames(cfg: PluginConfig): string {
  const names = cfg.customs.map((c) => c.alias.trim() || c.model || "custom");
  return names.length > 0 ? names.join("|") : "custom";
}

function backendLabel(cfg: PluginConfig): string {
  if (cfg.backend === "custom") return customNames(cfg);
  return cfg.backend;
}

function fallbackLabel(cfg: PluginConfig, slot: FallbackSlot): string {
  if (slot === "off") return "off";
  if (slot === "custom") return customNames(cfg);
  return slot;
}

function customsHint(cfg: PluginConfig): string {
  if (cfg.customs.length === 0) return "none · race fastest";
  return `${cfg.customs.length} · ${customNames(cfg)}`;
}

function customLine(c: CustomLlm): string {
  const alias = c.alias.trim() || "custom";
  const model = c.model || "no model";
  const url = c.baseUrl || "no url";
  const key = c.apiKey ? maskSecret(c.apiKey) : "no key";
  return `${alias} · ${model} · ${url} · ${key}`;
}

function providerHint(cfg: PluginConfig): string {
  if (cfg.backend === "google") return "no key";
  if (cfg.backend === "deepseek") {
    return `${cfg.deepseekModel}${cfg.deepseekApiKey ? ` · ${maskSecret(cfg.deepseekApiKey)}` : " · no key"}`;
  }
  if (cfg.backend === "custom") return customsHint(cfg);
  return `${cfg.hunyuanModel} · ${cfg.hunyuanBaseUrl}${cfg.hunyuanApiKey ? ` · ${maskSecret(cfg.hunyuanApiKey)}` : " · no key"}`;
}

async function editCustoms(ctx: ExtensionContext, cfg: PluginConfig): Promise<PluginConfig | undefined> {
  let customs = cfg.customs.slice();
  for (;;) {
    const item = await ctx.ui.select("Custom LLMs · race fastest", [
      { label: "back", description: customs.length === 0 ? "none" : `${customs.length} racers` },
      { label: "add", description: "OpenAI-compatible URL + key" },
      ...customs.map((c, i) => ({
        label: `edit ${i + 1}`,
        description: customLine(c),
      })),
      ...customs.map((c, i) => ({
        label: `remove ${i + 1}`,
        description: c.alias.trim() || c.model || "custom",
      })),
    ]);
    if (item === undefined) return undefined;
    if (item === "back") return { ...cfg, customs };
    if (item === "add") {
      const llm = await editCustomLlm(ctx, { alias: "", apiKey: "", baseUrl: "", model: "" });
      if (llm) customs = [...customs, llm];
      continue;
    }
    const editMatch = /^edit (\d+)$/.exec(item);
    if (editMatch) {
      const i = Number(editMatch[1]) - 1;
      const current = customs[i];
      if (!current) continue;
      const llm = await editCustomLlm(ctx, current);
      if (llm) customs = customs.map((c, idx) => (idx === i ? llm : c));
      continue;
    }
    const removeMatch = /^remove (\d+)$/.exec(item);
    if (removeMatch) {
      const i = Number(removeMatch[1]) - 1;
      customs = customs.filter((_, idx) => idx !== i);
    }
  }
}

async function editCustomLlm(ctx: ExtensionContext, current: CustomLlm): Promise<CustomLlm | undefined> {
  const aliasRaw = await ctx.ui.input("Custom alias", current.alias || "e.g. b.ai");
  if (aliasRaw === undefined) return undefined;
  const alias = aliasRaw.trim() || current.alias;
  const apiKey = await promptSecret(ctx, "Custom API key", current.apiKey);
  if (apiKey === undefined) return undefined;
  const baseUrl = await pickOrType(ctx, "Custom base URL", current.baseUrl, [
    { label: "https://api.openai.com/v1", description: "OpenAI" },
    { label: "https://openrouter.ai/api/v1", description: "OpenRouter" },
  ]);
  if (baseUrl === undefined) return undefined;
  const model = await pickOrType(ctx, "Custom model", current.model, [
    { label: "gpt-4o-mini", description: "OpenAI cheap" },
    { label: "gpt-4o", description: "OpenAI" },
  ]);
  if (model === undefined) return undefined;
  return { alias, apiKey, baseUrl, model };
}

export function maskSecret(value: string): string {
  const t = value.trim();
  if (!t) return "";
  if (t.length <= 8) return `${t.slice(0, 2)}***${t.slice(-1)}`;
  return `${t.slice(0, 4)}***${t.slice(-4)}`;
}

async function pickBackend(ctx: ExtensionContext, current: Backend): Promise<Backend | undefined> {
  const label = await ctx.ui.select("Translation backend", [
    { label: "google", description: current === "google" ? "Current · free, no key" : "Free, no key" },
    { label: "deepseek", description: current === "deepseek" ? "Current · needs API key" : "Needs API key" },
    { label: "hunyuan", description: current === "hunyuan" ? "Current · needs API key" : "Needs API key" },
    { label: "custom", description: current === "custom" ? "Current · OpenAI-compatible" : "OpenAI-compatible URL + key" },
  ]);
  if (label === "google" || label === "deepseek" || label === "hunyuan" || label === "custom") return label;
  return undefined;
}

async function pickFallback(
  ctx: ExtensionContext,
  title: string,
  current: FallbackSlot,
): Promise<FallbackSlot | undefined> {
  const label = await ctx.ui.select(title, [
    { label: "off", description: current === "off" ? "Current · unused" : "Do not fall back" },
    { label: "google", description: current === "google" ? "Current · free, no key" : "Free, no key" },
    { label: "deepseek", description: current === "deepseek" ? "Current · needs API key" : "Needs API key" },
    { label: "hunyuan", description: current === "hunyuan" ? "Current · needs API key" : "Needs API key" },
    { label: "custom", description: current === "custom" ? "Current · OpenAI-compatible" : "OpenAI-compatible URL + key" },
  ]);
  if (label === "off" || label === "google" || label === "deepseek" || label === "hunyuan" || label === "custom") {
    return label;
  }
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
    { label: "custom", description: current ? `now: ${current}` : "Type a value" },
  ]);
  if (label === undefined) return undefined;
  if (label !== "custom") return label;
  const typed = await ctx.ui.input(current ? `${title} [${current}]` : title, current);
  if (typed === undefined) return undefined;
  return typed.trim() || current;
}

async function promptSecret(
  ctx: ExtensionContext,
  title: string,
  current: string,
): Promise<string | undefined> {
  const masked = current ? maskSecret(current) : "";
  const typed = await ctx.ui.input(masked ? `${title} [${masked}]` : title, masked || "paste key");
  if (typed === undefined) return undefined;
  const trimmed = typed.trim();
  if (!trimmed || trimmed === masked) return current;
  return trimmed;
}
