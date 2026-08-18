import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "./config.ts";
import type { Backend } from "./types.ts";

const FILE_NAME = "omp-bilingual-cache.json";
const MAX_ENTRIES = 512;

export type Stamp = { alias: string; delayMs: number };

export function translationKey(en: string, target: string, backend: Backend): string {
  return `${backend}\t${target}\t${en}`;
}

export async function loadTranslationCache(): Promise<{
  zh: Map<string, string>;
  stamps: Map<string, Stamp>;
}> {
  const zh = new Map<string, string>();
  const stamps = new Map<string, Stamp>();
  try {
    const parsed: unknown = JSON.parse(await readFile(join(agentDir(), FILE_NAME), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { zh, stamps };
    if (!("items" in parsed) || !Array.isArray(parsed.items)) return { zh, stamps };
    for (const item of parsed.items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (!("k" in item) || !("zh" in item)) continue;
      if (typeof item.k !== "string" || !item.k || typeof item.zh !== "string" || !item.zh) continue;
      zh.set(item.k, item.zh);
      if (
        "alias" in item &&
        typeof item.alias === "string" &&
        item.alias &&
        "delayMs" in item &&
        typeof item.delayMs === "number"
      ) {
        stamps.set(item.k, { alias: item.alias, delayMs: item.delayMs });
      }
    }
  } catch {
    // missing or corrupt — start empty
  }
  return { zh, stamps };
}

export async function saveTranslationCache(
  zh: Map<string, string>,
  stamps: Map<string, Stamp> = new Map(),
): Promise<void> {
  const items: Array<{ k: string; zh: string; alias?: string; delayMs?: number }> = [];
  const overflow = zh.size > MAX_ENTRIES ? zh.size - MAX_ENTRIES : 0;
  let skipped = 0;
  for (const [k, text] of zh) {
    if (skipped < overflow) {
      skipped += 1;
      continue;
    }
    const stamp = stamps.get(k);
    items.push(stamp ? { k, zh: text, alias: stamp.alias, delayMs: stamp.delayMs } : { k, zh: text });
  }
  await mkdir(agentDir(), { recursive: true });
  await writeFile(join(agentDir(), FILE_NAME), `${JSON.stringify({ v: 2, items })}\n`, "utf8");
}
