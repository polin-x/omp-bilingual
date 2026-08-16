import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, patchConfig } from "./config.ts";
import type { Backend, PluginConfig } from "./types.ts";

export async function runConfigure(ctx: ExtensionContext): Promise<PluginConfig | undefined> {
  if (!ctx.hasUI) return undefined;
  const current = await loadConfig();

  const enabled = await ctx.ui.select("Bilingual", [
    { label: "on", description: "Translate English replies" },
    { label: "off", description: "Leave replies unchanged" },
  ]);
  if (enabled === undefined) return undefined;

  const backend = await pickBackend(ctx, current.backend);
  if (backend === undefined) return undefined;

  if (backend === "google") {
    const target = await ctx.ui.input("Google target language", current.target || "zh-CN");
    if (target === undefined) return undefined;
    return patchConfig({
      enabled: enabled === "on",
      backend,
      target: target.trim() || current.target,
    });
  }

  if (backend === "deepseek") {
    const apiKey = await promptSecret(ctx, "DeepSeek API key", current.deepseekApiKey);
    if (apiKey === undefined) return undefined;
    const model = await pickOrType(ctx, "DeepSeek model", current.deepseekModel, [
      { label: "deepseek-v4-flash", description: "Default, cheaper" },
      { label: "deepseek-v4-pro", description: "Stronger" },
    ]);
    if (model === undefined) return undefined;
    return patchConfig({
      enabled: enabled === "on",
      backend,
      deepseekApiKey: apiKey,
      deepseekModel: model,
    });
  }

  const apiKey = await promptSecret(ctx, "Hunyuan / TokenHub API key", current.hunyuanApiKey);
  if (apiKey === undefined) return undefined;
  const baseUrl = await pickOrType(ctx, "Hunyuan base URL", current.hunyuanBaseUrl, [
    { label: "https://api.hunyuan.cloud.tencent.com/v1", description: "Official Hunyuan" },
    { label: "https://tokenhub.tencentmaas.com/v1", description: "TokenHub CN" },
  ]);
  if (baseUrl === undefined) return undefined;
  const model = await pickOrType(ctx, "Hunyuan model", current.hunyuanModel, [
    { label: "hunyuan-turbos-latest", description: "Official default" },
    { label: "hy3", description: "TokenHub" },
  ]);
  if (model === undefined) return undefined;
  return patchConfig({
    enabled: enabled === "on",
    backend,
    hunyuanApiKey: apiKey,
    hunyuanBaseUrl: baseUrl,
    hunyuanModel: model,
  });
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
