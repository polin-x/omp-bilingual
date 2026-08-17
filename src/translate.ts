import type { Backend, Pair, PluginConfig } from "./types.ts";
import { languageName } from "./types.ts";

const GOOGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";

export async function translateParagraphs(
  paragraphs: string[],
  config: PluginConfig,
  signal?: AbortSignal,
): Promise<Pair[]> {
  if (paragraphs.length === 0) return [];
  switch (config.backend) {
    case "google":
      return translateGoogle(paragraphs, config, signal);
    case "deepseek":
      return translateOpenAi(
        paragraphs,
        {
          apiKey: config.deepseekApiKey,
          baseUrl: "https://api.deepseek.com",
          model: config.deepseekModel,
          name: "DeepSeek",
          disableThinking: true,
          target: config.target,
        },
        signal,
      );
    case "hunyuan":
      return translateOpenAi(
        paragraphs,
        {
          apiKey: config.hunyuanApiKey,
          baseUrl: config.hunyuanBaseUrl,
          model: config.hunyuanModel,
          name: "Hunyuan",
          target: config.target,
        },
        signal,
      );
    default:
      return unreachable(config.backend);
  }
}

async function translateGoogle(paragraphs: string[], config: PluginConfig, signal?: AbortSignal): Promise<Pair[]> {
  const pairs: Pair[] = [];
  for (const en of paragraphs) {
    const { masked, tokens } = protectMarkup(en);
    const url = new URL(GOOGLE_ENDPOINT);
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", config.sourceLang || "auto");
    url.searchParams.set("tl", config.target || "zh-CN");
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", masked);
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
    const body: unknown = await res.json();
    pairs.push({ en, zh: applyTechGlossary(en, restoreMarkup(flattenGoogle(body), tokens)) });
  }
  return pairs;
}

function flattenGoogle(body: unknown): string {
  if (!Array.isArray(body) || !Array.isArray(body[0])) return "";
  const chunks: string[] = [];
  for (const part of body[0]) {
    if (Array.isArray(part) && typeof part[0] === "string") chunks.push(part[0]);
  }
  return chunks.join("").trim();
}

type OpenAiOpts = {
  apiKey: string;
  baseUrl: string;
  model: string;
  name: string;
  disableThinking?: boolean;
  target: string;
};

async function translateOpenAi(paragraphs: string[], opts: OpenAiOpts, signal?: AbortSignal): Promise<Pair[]> {
  if (!opts.apiKey) throw new Error(`${opts.name} API key missing`);
  const protectedParas = paragraphs.map((p) => protectMarkup(p));
  const numbered = protectedParas.map((p, i) => `${i + 1}. ${p.masked}`).join("\n\n");
  const res = await fetch(joinUrl(opts.baseUrl, "chat/completions"), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.1,
      ...(opts.disableThinking ? { thinking: { type: "disabled" } } : {}),
      messages: [
        {
          role: "system",
          content: systemPrompt(opts.target),
        },
        { role: "user", content: numbered },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${opts.name} HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  const zhList = parseTranslationList(content, paragraphs.length);
  const pairs: Pair[] = [];
  const n = Math.min(paragraphs.length, zhList.length);
  for (let i = 0; i < n; i++) {
    const en = paragraphs[i] ?? "";
    const zh = applyTechGlossary(en, restoreMarkup((zhList[i] ?? "").trim(), protectedParas[i]?.tokens ?? []));
    if (en && zh) pairs.push({ en, zh });
  }
  if (pairs.length === 0) throw new Error(`${opts.name} returned no usable translations`);
  return pairs;
}

function parseTranslationList(raw: string, expected: number): string[] {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const bracketStart = stripped.indexOf("[");
  const bracketEnd = stripped.lastIndexOf("]");
  const bracketed =
    bracketStart >= 0 && bracketEnd > bracketStart ? stripped.slice(bracketStart, bracketEnd + 1) : "";
  const fromJson = asStringArray(tryJson(stripped)) ?? asStringArray(tryJson(bracketed));
  if (fromJson) return fitList(fromJson, expected, stripped);
  const numbered = parseNumberedList(stripped);
  if (numbered.length > 0) return fitList(numbered, expected, stripped);
  if (expected === 1 && stripped) return [stripped];
  throw new Error("expected a JSON string array");
}

function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (value.every((x) => typeof x === "string")) return value;
  if (value.every((x) => typeof x === "string" || typeof x === "number")) {
    return value.map((x) => String(x));
  }
  return undefined;
}

function parseNumberedList(raw: string): string[] {
  const items: string[] = [];
  for (const line of raw.split(/\n+/)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^\d+[.)、]\s*(.*)$/);
    if (!match) continue;
    const text = (match[1] ?? "").trim();
    if (text) items.push(text);
  }
  return items;
}

function fitList(list: string[], expected: number, fallback: string): string[] {
  if (expected <= 0) return list;
  if (list.length === expected) return list;
  if (expected === 1) return [list.join("\n")];
  if (list.length > expected) return list.slice(0, expected);
  if (list.length === 1 && fallback) return list;
  return list;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function systemPrompt(target: string): string {
  return [
    `Translate each numbered paragraph into ${languageName(target)}.`,
    "Domain: software engineering in a coding-agent TUI (git, plugins, terminals, APIs).",
    "Prefer programmer Chinese. Read words as technical terms first, marketing second.",
    "marketplace = 插件市场 / 扩展市场, never 市场推广.",
    "push = 推送 (git/release), not 推广.",
    "commit = 提交; hook = 钩子; renderer = 渲染器; extension/plugin = 扩展/插件;",
    "card = 卡片; transcript = 会话记录; session = 会话; idle = 空闲; flush = 刷出; debounce = 去抖.",
    "Use only the text of that paragraph. Do not infer prior conversation or missing context.",
    "Do not translate code, paths, commands, identifiers, or version numbers.",
    "Return ONLY a JSON array of strings, same length and order.",
  ].join(" ");
}

function applyTechGlossary(en: string, zh: string): string {
  let out = zh;
  if (/marketplace/i.test(en)) {
    out = out.replaceAll("市场推广", "推送到插件市场");
    out = out.replaceAll("市集", "插件市场");
  }
  if (/\bpush\b/i.test(en) && out.includes("推广") && !out.includes("推送")) {
    out = out.replaceAll("推广", "推送");
  }
  return out;
}

function protectMarkup(text: string): { masked: string; tokens: string[] } {
  const tokens: string[] = [];
  const masked = text.replace(/`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__/g, (chunk) => {
    tokens.push(chunk);
    return `§${tokens.length - 1}§`;
  });
  return { masked, tokens };
}

function restoreMarkup(text: string, tokens: string[]): string {
  return text.replace(/§\s*(\d+)\s*§/g, (_all, n) => tokens[Number(n)] ?? "");
}

function unreachable(x: never): never {
  throw new Error(`unknown backend: ${String(x)}`);
}

export function describeBackend(backend: Backend): string {
  switch (backend) {
    case "google":
      return "google (free)";
    case "deepseek":
      return "deepseek";
    case "hunyuan":
      return "hunyuan";
  }
}
