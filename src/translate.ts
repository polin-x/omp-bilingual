import type { Backend, Pair, PluginConfig } from "./types.ts";

const GOOGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";

export async function translateParagraphs(
  paragraphs: string[],
  config: PluginConfig,
  signal?: AbortSignal,
): Promise<Pair[]> {
  if (paragraphs.length === 0) return [];
  switch (config.backend) {
    case "google":
      return translateGoogle(paragraphs, config.target, signal);
    case "deepseek":
      return translateOpenAi(
        paragraphs,
        {
          apiKey: config.deepseekApiKey,
          baseUrl: "https://api.deepseek.com",
          model: config.deepseekModel,
          name: "DeepSeek",
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
        },
        signal,
      );
    default:
      return unreachable(config.backend);
  }
}

async function translateGoogle(paragraphs: string[], target: string, signal?: AbortSignal): Promise<Pair[]> {
  const pairs: Pair[] = [];
  for (const en of paragraphs) {
    const { masked, tokens } = protectMarkup(en);
    const url = new URL(GOOGLE_ENDPOINT);
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", target || "zh-CN");
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", masked);
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
    const body: unknown = await res.json();
    pairs.push({ en, zh: restoreMarkup(flattenGoogle(body), tokens) });
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
      messages: [
        {
          role: "system",
          content:
            "Translate each numbered paragraph into Simplified Chinese. " +
            "Use only the text of that paragraph. Do not infer prior conversation, user intent, or missing context. " +
            "Return ONLY a JSON array of strings, same length and order. " +
            "Do not translate code, paths, commands, or identifiers. Keep those tokens intact.",
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
  const zhList = parseJsonStringArray(content);
  if (zhList.length !== paragraphs.length) {
    throw new Error(`${opts.name} returned ${zhList.length} lines for ${paragraphs.length} paragraphs`);
  }
  const pairs: Pair[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const en = paragraphs[i] ?? "";
    const zh = restoreMarkup((zhList[i] ?? "").trim(), protectedParas[i]?.tokens ?? []);
    if (en) pairs.push({ en, zh });
  }
  return pairs;
}

function parseJsonStringArray(raw: string): string[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
    throw new Error("expected a JSON string array");
  }
  return parsed;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
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
