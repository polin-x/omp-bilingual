import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Backend, FallbackSlot, PluginConfig } from "./types.ts";
import { DEFAULT_CONFIG, PACKAGE_NAME } from "./types.ts";

const FILE_NAME = "omp-bilingual.json";

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
}

export function configPath(): string {
  return join(agentDir(), FILE_NAME);
}

export async function loadConfig(): Promise<PluginConfig> {
  const lock = await readJsonObject(join(homedir(), ".omp", "plugins", "omp-plugins.lock.json"));
  const lockSettings =
    lock.settings && typeof lock.settings === "object" && !Array.isArray(lock.settings)
      ? ((lock.settings as Record<string, unknown>)[PACKAGE_NAME] as unknown)
      : undefined;
  const fromLock =
    lockSettings && typeof lockSettings === "object" && !Array.isArray(lockSettings)
      ? (lockSettings as Record<string, unknown>)
      : {};
  const file = await readJsonObject(configPath());
  const merged = { ...fromLock, ...file };
  return {
    enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_CONFIG.enabled,
    backend: asBackend(merged.backend),
    fallback1: asFallback(merged.fallback1),
    fallback2: asFallback(merged.fallback2),
    target: asString(merged.target, DEFAULT_CONFIG.target),
    sourceLang: asString(merged.sourceLang, DEFAULT_CONFIG.sourceLang),
    translateThinking:
      typeof merged.translateThinking === "boolean"
        ? merged.translateThinking
        : DEFAULT_CONFIG.translateThinking,
    translateText:
      typeof merged.translateText === "boolean" ? merged.translateText : DEFAULT_CONFIG.translateText,
    reviewEnglish:
      typeof merged.reviewEnglish === "boolean" ? merged.reviewEnglish : DEFAULT_CONFIG.reviewEnglish,
    ornament: asString(merged.ornament, DEFAULT_CONFIG.ornament),
    ornamentGif: asString(merged.ornamentGif, DEFAULT_CONFIG.ornamentGif),
    thinkingDebounceMs: asDebounceMs(merged.thinkingDebounceMs),
    deepseekApiKey: asString(merged.deepseekApiKey, DEFAULT_CONFIG.deepseekApiKey),
    deepseekModel: asString(merged.deepseekModel, DEFAULT_CONFIG.deepseekModel),
    hunyuanApiKey: asString(merged.hunyuanApiKey, DEFAULT_CONFIG.hunyuanApiKey),
    hunyuanBaseUrl: asString(merged.hunyuanBaseUrl, DEFAULT_CONFIG.hunyuanBaseUrl),
    hunyuanModel: asString(merged.hunyuanModel, DEFAULT_CONFIG.hunyuanModel),
    customApiKey: asString(merged.customApiKey, DEFAULT_CONFIG.customApiKey),
    customBaseUrl: asString(merged.customBaseUrl, DEFAULT_CONFIG.customBaseUrl),
    customModel: asString(merged.customModel, DEFAULT_CONFIG.customModel),
  };
}

export async function saveConfig(next: PluginConfig): Promise<void> {
  await mkdir(agentDir(), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export async function patchConfig(partial: Partial<PluginConfig>): Promise<PluginConfig> {
  const current = await loadConfig();
  const next = { ...current, ...partial };
  await saveConfig(next);
  return next;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}


function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function asBackend(value: unknown): Backend {
  return value === "deepseek" || value === "hunyuan" || value === "google" || value === "custom"
    ? value
    : DEFAULT_CONFIG.backend;
}

function asFallback(value: unknown): FallbackSlot {
  if (value === "off" || value === "deepseek" || value === "hunyuan" || value === "google" || value === "custom") {
    return value;
  }
  return DEFAULT_CONFIG.fallback1;
}

function asDebounceMs(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.thinkingDebounceMs;
  return Math.min(30_000, Math.max(250, Math.round(n)));
}
