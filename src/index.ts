import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { loadTranslationCache, saveTranslationCache, translationKey } from "./cache.ts";
import { loadConfig, patchConfig } from "./config.ts";
import { runConfigure } from "./configure.ts";
import { extractSourceParagraphs, isEnglishPrompt, partitionTranslatableParagraphs } from "./extract.ts";
import { renderBilingualCard, renderEnglishReview, renderPairCard, ThinkingTranslationView } from "./render.ts";
import {
  describeBackend,
  looksLikeTranslation,
  reviewEnglishPrompt,
  translateParagraphs,
  type EnglishReview,
} from "./translate.ts";
import {
  CUSTOM_TYPE,
  DEFAULT_CONFIG,
  PACKAGE_VERSION,
  type Backend,
  type BilingualDetails,
  type Pair,
  type PluginConfig,
} from "./types.ts";

export default function bilingual(pi: ExtensionAPI): void {
  pi.setLabel("Bilingual");

  // Old sessions may still contain cards. Render them; we never write new ones.
  pi.registerMessageRenderer(CUSTOM_TYPE, (message, _opts, theme) => renderBilingualCard(message, theme));

  const paraZh = new Map<string, string>();
  const paraFailed = new Set<string>();
  const paraBusy = new Set<string>();
  let liveConfig: PluginConfig = DEFAULT_CONFIG;
  let scheduleTimer: ((fn: () => void, ms: number) => unknown) | undefined;
  let cancelTimer: ((id: unknown) => void) | undefined;
  let thinkingTimer: unknown;
  let thinkingQueued: { paras: string[]; requestRender: () => void } | undefined;
  let lastThinkingRender: (() => void) | undefined;
  let liveThinks: Array<{ view: ThinkingTranslationView; paras: string[] }> = [];
  let persistTimer: unknown;
  let ui: ExtensionUIContext | undefined;
  let pendingHarvest = { thinking: [] as string[], texts: [] as string[] };

  const keyOf = (en: string) => translationKey(en, liveConfig.target, liveConfig.backend);

  const cachedZh = (en: string) => paraZh.get(keyOf(en));

  const schedulePersist = () => {
    if (!scheduleTimer) return;
    if (persistTimer != null) cancelTimer?.(persistTimer);
    persistTimer = scheduleTimer(() => {
      persistTimer = undefined;
      void saveTranslationCache(paraZh).catch((err) => {
        pi.logger.error("bilingual cache save failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }, 400);
  };

  const rememberZh = (en: string, zh: string) => {
    if (!looksLikeTranslation(en, zh)) return;
    paraZh.set(keyOf(en), zh);
    if (paraZh.size > 512) {
      const first = paraZh.keys().next().value;
      if (first !== undefined) paraZh.delete(first);
    }
    schedulePersist();
  };

  const rememberFail = (en: string) => {
    paraFailed.add(keyOf(en));
    if (paraFailed.size > 64) {
      const first = paraFailed.values().next().value;
      if (first !== undefined) paraFailed.delete(first);
    }
  };

  const paintThinking = () => {
    for (const item of liveThinks) {
      const zh = item.paras.map((p) => cachedZh(p)).filter((t): t is string => Boolean(t)).join("\n\n");
      item.view.setZh(zh);
    }
    lastThinkingRender?.();
  };

  const translateFresh = async (paras: string[], requestRender?: () => void): Promise<Pair[]> => {
    const fresh = paras.filter((p) => !paraZh.has(keyOf(p)) && !paraFailed.has(keyOf(p)) && !paraBusy.has(keyOf(p)));
    if (fresh.length === 0) {
      requestRender?.();
      paintThinking();
      return [];
    }
    for (const p of fresh) paraBusy.add(keyOf(p));
    try {
      if (!liveConfig.enabled) return [];
      const pairs = await translateParagraphs(fresh, liveConfig);
      const out: Pair[] = [];
      for (const pair of pairs) {
        if (pair.zh && pair.zh !== pair.en) {
          rememberZh(pair.en, pair.zh);
          out.push(pair);
        }
      }
      paintThinking();
      requestRender?.();
      return out;
    } catch (err) {
      for (const p of fresh) rememberFail(p);
      throw err;
    } finally {
      for (const p of fresh) paraBusy.delete(keyOf(p));
    }
  };

  const flushThinkingTranslate = () => {
    thinkingTimer = undefined;
    const job = thinkingQueued;
    thinkingQueued = undefined;
    if (!job) return;
    void translateFresh(job.paras, job.requestRender).catch((err) => {
      pi.logger.error("bilingual thinking translate failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const showTextWidget = (texts: string[]) => {
    if (!ui) return;
    if (!liveConfig.enabled || !liveConfig.translateText) {
      ui.setWidget("bilingual", undefined);
      return;
    }
    const pairs: Pair[] = [];
    for (const en of texts) {
      const zh = cachedZh(en);
      if (zh) pairs.push({ en, zh, kind: "text" });
    }
    if (pairs.length === 0) {
      ui.setWidget("bilingual", undefined);
      return;
    }
    const details: BilingualDetails = {
      pairs,
      backend: liveConfig.backend,
      ornament: liveConfig.ornament,
    };
    ui.setWidget(
      "bilingual",
      (_tui, theme) => renderPairCard(details, theme) ?? { render: () => [] },
      { placement: "aboveEditor" },
    );
  };

  const reviewKeyOf = (en: string) => `review\t${liveConfig.backend}\t${en}`;

  const runEnglishReview = async (text: string) => {
    if (!ui || liveConfig.backend === "google") return;
    const cacheKey = reviewKeyOf(text);
    const cached = paraZh.get(cacheKey);
    if (cached) {
      const review = parseCachedReview(cached);
      if (review) {
        ui.setWidget("bilingual-review", (_tui, theme) => renderEnglishReview(review, theme), {
          placement: "aboveEditor",
        });
        return;
      }
    }
    try {
      const review = await reviewEnglishPrompt(text, liveConfig);
      if (!review || !ui) return;
      paraZh.set(cacheKey, JSON.stringify(review));
      schedulePersist();
      ui.setWidget("bilingual-review", (_tui, theme) => renderEnglishReview(review, theme), {
        placement: "aboveEditor",
      });
    } catch (err) {
      pi.logger.error("bilingual english review failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const applyUi = (next: ExtensionUIContext) => {
    ui = next;
    next.setStatus("bilingual", barStatus(liveConfig));
    if (!liveConfig.enabled || !liveConfig.translateText) next.setWidget("bilingual", undefined);
    if (!liveConfig.enabled || !liveConfig.reviewEnglish) next.setWidget("bilingual-review", undefined);
  };

  pi.registerAssistantThinkingRenderer((context, theme) => {
    if (!liveConfig.enabled || !liveConfig.translateThinking) return undefined;
    const { closed, open } = partitionTranslatableParagraphs(context.text);
    const paras = open ? [...closed, open] : closed;
    if (paras.length === 0) return undefined;
    lastThinkingRender = () => context.requestRender();
    const view = new ThinkingTranslationView(theme);
    liveThinks.push({ view, paras });
    if (liveThinks.length > 24) liveThinks = liveThinks.slice(-24);
    const zh = paras.map((p) => cachedZh(p)).filter((t): t is string => Boolean(t)).join("\n\n");
    if (zh) view.setZh(zh);
    const freshClosed = closed.filter(
      (p) => !paraZh.has(keyOf(p)) && !paraFailed.has(keyOf(p)) && !paraBusy.has(keyOf(p)),
    );
    if (freshClosed.length === 0 || !scheduleTimer) return view;
    thinkingQueued = { paras: freshClosed, requestRender: lastThinkingRender };
    if (thinkingTimer != null) {
      cancelTimer?.(thinkingTimer);
      thinkingTimer = undefined;
    }
    thinkingTimer = scheduleTimer(flushThinkingTranslate, liveConfig.thinkingDebounceMs);
    return view;
  });

  pi.on("session_start", async (_event, ctx) => {
    scheduleTimer = (fn, ms) => ctx.setTimeout(fn, ms);
    cancelTimer = (id) => ctx.clearTimer(id);
    liveConfig = await loadConfig();
    const disk = await loadTranslationCache();
    for (const [k, zh] of disk) paraZh.set(k, zh);
    applyUi(ctx.ui);
  });

  pi.on("agent_start", () => {
    pendingHarvest = { thinking: [], texts: [] };
    ui?.setWidget("bilingual", undefined);
  });

  pi.on("message_end", (event) => {
    if (!liveConfig.enabled) return;
    if (event.message.role === "user") {
      if (!liveConfig.reviewEnglish) return;
      const text = userPromptText(event.message);
      if (!isEnglishPrompt(text)) return;
      void runEnglishReview(text);
      return;
    }
    if (event.message.role !== "assistant") return;
    if (thinkingTimer != null) {
      cancelTimer?.(thinkingTimer);
      thinkingTimer = undefined;
    }
    flushThinkingTranslate();
    const sources = extractSourceParagraphs(event.message);
    if (liveConfig.translateThinking) {
      for (const s of sources) if (s.kind === "thinking") pendingHarvest.thinking.push(s.text);
    }
    if (liveConfig.translateText && !messageHasToolCalls(event.message)) {
      for (const s of sources) if (s.kind === "text") pendingHarvest.texts.push(s.text);
    }
    if (pendingHarvest.thinking.length > 0) {
      void translateFresh(pendingHarvest.thinking, lastThinkingRender).catch((err) => {
        pi.logger.error("bilingual thinking translate failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });

  pi.on("agent_end", (event) => {
    if (event.willContinue) return;
    const { thinking, texts } = pendingHarvest;
    pendingHarvest = { thinking: [], texts: [] };
    const paras = [...thinking, ...texts];
    if (paras.length === 0) return;
    void translateFresh(paras, lastThinkingRender)
      .then(() => {
        showTextWidget(texts);
      })
      .catch((err) => {
        pi.logger.error("bilingual translate failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
  });

  pi.registerCommand("bilingual", {
    description: "Toggle or open bilingual settings",
    getArgumentCompletions(argumentPrefix: string) {
      if (argumentPrefix.includes(" ")) return null;
      const lower = argumentPrefix.toLowerCase();
      const matches = SUBCOMMANDS.filter((s) => s.name.startsWith(lower)).map((s) => ({
        value: `${s.name} `,
        label: s.name,
        description: s.description,
      }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const first = args.trim().split(/\s+/)[0] ?? "";
      if (first === "settings" || first === "configure" || first === "config") {
        if (!ctx.hasUI) {
          ctx.ui.notify("/bilingual settings needs the TUI", "warning");
          return;
        }
        const next = await runConfigure(ctx);
        if (!next) return;
        liveConfig = next;
        applyUi(ctx.ui);
        ctx.ui.notify(statusLine(next), "info");
        return;
      }
      const next = await applyCommand(args.trim());
      if (typeof next === "string") {
        ctx.ui.notify(next, "info");
        return;
      }
      liveConfig = next;
      applyUi(ctx.ui);
      ctx.ui.notify(statusLine(next), "info");
    },
  });
}

const SUBCOMMANDS = [
  { name: "settings", description: "Open TUI settings: language, backend, key, thinking" },
  { name: "on", description: "Enable translation" },
  { name: "off", description: "Disable translation" },
  { name: "status", description: "Show backend, target, model, version" },
  { name: "version", description: "Show installed plugin version" },
  { name: "target", description: "Set target language, e.g. /bilingual target ja" },
  { name: "google", description: "Switch to free Google Translate" },
  { name: "deepseek", description: "Switch to DeepSeek (set key in settings first)" },
  { name: "hunyuan", description: "Switch to Hunyuan (set key in settings first)" },
  { name: "update", description: "How to upgrade this plugin" },
];
async function applyCommand(args: string): Promise<PluginConfig | string> {
  const [cmd = "", ...rest] = args.split(/\s+/).filter(Boolean);
  if (cmd === "update") {
    return [
      `installed ${PACKAGE_VERSION}`,
      "升级:",
      "  omp plugin marketplace update",
      "  omp plugin upgrade bilingual@polin-plugins",
    ].join("\n");
  }
  if (!cmd || cmd === "status" || cmd === "version") return statusLine(await loadConfig());
  if (cmd === "on") return patchConfig({ enabled: true });
  if (cmd === "off") return patchConfig({ enabled: false });
  if (cmd === "google" || cmd === "deepseek" || cmd === "hunyuan") {
    return patchConfig({ backend: cmd });
  }
  if (cmd === "backend") {
    const value = rest[0];
    if (value !== "google" && value !== "deepseek" && value !== "hunyuan") {
      return "用法: /bilingual backend google|deepseek|hunyuan";
    }
    return patchConfig({ backend: value satisfies Backend });
  }
  if (cmd === "target") {
    const value = rest[0];
    if (!value) return "用法: /bilingual target zh-CN|ja|en|…";
    return patchConfig({ target: value });
  }
  return [
    "用法:",
    "  /bilingual settings",
    "  /bilingual on|off|status|version|update",
    "  /bilingual target zh-CN|ja|en|…",
    "  /bilingual google|deepseek|hunyuan",
  ].join("\n");
}

function barStatus(config: PluginConfig): string {
  if (!config.enabled) return `译:off ${PACKAGE_VERSION}`;
  return `译:${describeBackend(config.backend)} ${config.target} ${PACKAGE_VERSION}`;
}

function statusLine(config: PluginConfig): string {
  const on = config.enabled ? "on" : "off";
  const think = config.translateThinking ? "thinking" : "no-thinking";
  if (config.backend === "deepseek") {
    return `bilingual ${PACKAGE_VERSION} ${on} · deepseek · ${config.target} · ${config.deepseekModel}${config.deepseekApiKey ? "" : " · no key"} · ${think}`;
  }
  if (config.backend === "hunyuan") {
    return `bilingual ${PACKAGE_VERSION} ${on} · hunyuan · ${config.target} · ${config.hunyuanModel}${config.hunyuanApiKey ? "" : " · no key"} · ${think}`;
  }
  return `bilingual ${PACKAGE_VERSION} ${on} · google · ${config.sourceLang}→${config.target} · ${think}`;
}

function messageHasToolCalls(message: { content?: unknown }): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block) => {
    if (!block || typeof block !== "object" || !("type" in block)) return false;
    return block.type === "toolCall" || block.type === "tool_call";
  });
}

function userPromptText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (!("type" in block) || !("text" in block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function parseCachedReview(raw: string): EnglishReview | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (!("ok" in parsed) || !("corrected" in parsed) || !("note" in parsed)) return undefined;
    return {
      ok: parsed.ok === true,
      corrected: typeof parsed.corrected === "string" ? parsed.corrected : "",
      better: "better" in parsed && typeof parsed.better === "string" ? parsed.better : "",
      note: typeof parsed.note === "string" ? parsed.note : "",
    };
  } catch {
    return undefined;
  }
}
