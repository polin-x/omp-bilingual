import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "./config.ts";
import type { Backend } from "./types.ts";

const FILE_NAME = "omp-bilingual-cache.json";
const MAX_ENTRIES = 512;

export function translationKey(en: string, target: string, backend: Backend): string {
  return `${backend}\t${target}\t${en}`;
}

export async function loadTranslationCache(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const parsed: unknown = JSON.parse(await readFile(join(agentDir(), FILE_NAME), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    if (!("items" in parsed) || !Array.isArray(parsed.items)) return out;
    for (const item of parsed.items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (!("k" in item) || !("zh" in item)) continue;
      if (typeof item.k === "string" && item.k && typeof item.zh === "string" && item.zh) {
        out.set(item.k, item.zh);
      }
    }
  } catch {
    // missing or corrupt — start empty
  }
  return out;
}

export async function saveTranslationCache(map: Map<string, string>): Promise<void> {
  const items: Array<{ k: string; zh: string }> = [];
  const overflow = map.size > MAX_ENTRIES ? map.size - MAX_ENTRIES : 0;
  let skipped = 0;
  for (const [k, zh] of map) {
    if (skipped < overflow) {
      skipped += 1;
      continue;
    }
    items.push({ k, zh });
  }
  await mkdir(agentDir(), { recursive: true });
  await writeFile(join(agentDir(), FILE_NAME), `${JSON.stringify({ v: 1, items })}\n`, "utf8");
}
