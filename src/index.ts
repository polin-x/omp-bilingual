import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { loadTranslationCache, saveTranslationCache, translationKey } from "./cache.ts";
import { loadConfig, patchConfig } from "./config.ts";
import { runConfigure } from "./configure.ts";
import { extractSourceParagraphs, isEnglishPrompt, partitionTranslatableParagraphs } from "./extract.ts";
import { EnglishReviewView, TextCardView, ThinkingTranslationView } from "./render.ts";
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
  REVIEW_TYPE,
  type Backend,
  type BilingualDetails,
  type Pair,
  type PluginConfig,
} from "./types.ts";

export default function bilingual(pi: ExtensionAPI): void {
  pi.setLabel("Bilingual");

  const paraZh = new Map<string, string>();
  const paraFailed = new Set<string>();
  const paraBusy = new Set<string>();
  const reviews = new Map<string, EnglishReview>();
  const reviewViews: EnglishReviewView[] = [];
  const reviewViewSource = new WeakMap<EnglishReviewView, string>();
  const textViews: TextCardView[] = [];
  const textViewSource = new WeakMap<TextCardView, string>();

  pi.registerMessageRenderer(CUSTOM_TYPE, (message, _opts, theme) => {
    if (message.customType !== CUSTOM_TYPE) return undefined;
    const details = message.details;
    if (!details || typeof details !== "object" || !("backend" in details) || typeof details.backend !== "string") {
      return undefined;
    }
    const texts = bilingualTexts(details);
    const view = new TextCardView(theme, details.backend, pairsFromCache(texts));
    textViews.push(view);
    textViewSource.set(view, textsKey(texts));
    if (textViews.length > 16) textViews.shift();
    return view;
  });
  pi.registerMessageRenderer(REVIEW_TYPE, (message, _opts, theme) => {
    if (message.customType !== REVIEW_TYPE) return undefined;
    const details = message.details;
    if (!details || typeof details !== "object" || !("source" in details) || typeof details.source !== "string") {
      return undefined;
    }
    const view = new EnglishReviewView(theme);
    const fromDetails =
      "review" in details && details.review && typeof details.review === "object"
        ? (details.review as EnglishReview)
        : undefined;
    const hit = reviews.get(details.source) ?? fromDetails;
    if (hit) view.setReview(hit);
    reviewViews.push(view);
    reviewViewSource.set(view, details.source);
    if (reviewViews.length > 16) reviewViews.shift();
    return view;
  });

  pi.on("context", (event) => ({
    messages: event.messages.filter((m) => !isBilingualContextMessage(m)),
  }));

  let liveConfig: PluginConfig = DEFAULT_CONFIG;
  let configReady = false;
  const boot = (async () => {
    liveConfig = await loadConfig();
    const disk = await loadTranslationCache();
    for (const [k, zh] of disk) paraZh.set(k, zh);
    configReady = true;
  })();
  let scheduleTimer: ((fn: () => void, ms: number) => unknown) | undefined;
  let cancelTimer: ((id: unknown) => void) | undefined;
  let sessionIsIdle: (() => boolean) | undefined;
  let thinkingTimer: unknown;
  let thinkingQueued: { paras: string[]; requestRender: () => void } | undefined;
  let lastThinkingRender: (() => void) | undefined;
  let liveThinks: Array<{ view: ThinkingTranslationView; paras: string[] }> = [];
  let persistTimer: unknown;
  let ui: ExtensionUIContext | undefined;
  let pendingHarvest = { thinking: [] as string[], texts: [] as string[] };

  const keyOf = (en: string) => translationKey(en, liveConfig.target, liveConfig.backend);

  const cachedZh = (en: string) => paraZh.get(keyOf(en));

  const pairsFromCache = (texts: string[]): Pair[] => {
    const pairs: Pair[] = [];
    for (const en of texts) {
      const zh = cachedZh(en);
      if (zh) pairs.push({ en, zh, kind: "text" });
    }
    return pairs;
  };

  const paintTextCards = (texts: string[]) => {
    const pairs = pairsFromCache(texts);
    const key = textsKey(texts);
    for (const view of textViews) {
      if (textViewSource.get(view) === key) view.setPairs(pairs);
    }
    ui?.setStatus("bilingual", barStatus(liveConfig));
  };
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
      if (!isRetryableTranslateError(err)) {
        for (const p of fresh) rememberFail(p);
      }
      throw err;
    } finally {
      for (const p of fresh) paraBusy.delete(keyOf(p));
    }
  };
  const postTextCard = async (texts: string[]): Promise<void> => {
    if (!liveConfig.enabled || !liveConfig.translateText) return;
    if (texts.length === 0) return;
    if (sessionIsIdle && !sessionIsIdle()) return;
    const pairs = pairsFromCache(texts);
    await Promise.resolve(
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: "",
          display: true,
          attribution: "agent",
          details: {
            texts,
            pairs,
            backend: liveConfig.backend,
            ornament: liveConfig.ornament,
          },
        },
        { triggerTurn: false, deliverAs: "nextTurn" },
      ) as void | Promise<void>,
    );
  };

  const reviewKeyOf = (en: string) => `review\t${liveConfig.backend}\t${en}`;

  const paintReviews = (source: string, review: EnglishReview) => {
    reviews.set(source, review);
    for (const view of reviewViews) {
      if (reviewViewSource.get(view) === source) view.setReview(review);
    }
  };

  const reviewCard = (text: string) => {
    const cached = parseCachedReview(paraZh.get(reviewKeyOf(text)) ?? "");
    if (cached) paintReviews(text, cached);
    return {
      customType: REVIEW_TYPE,
      content: "",
      display: true as const,
      attribution: "agent" as const,
      details: { source: text, review: cached },
    };
  };

  const runEnglishReview = async (text: string) => {
    if (liveConfig.backend === "google") return;
    const cacheKey = reviewKeyOf(text);
    const cached = paraZh.get(cacheKey);
    if (cached) {
      const review = parseCachedReview(cached);
      if (review) {
        paintReviews(text, review);
        return;
      }
    }
    try {
      const review = await reviewEnglishPrompt(text, liveConfig);
      if (!review) return;
      paraZh.set(cacheKey, JSON.stringify(review));
      schedulePersist();
      paintReviews(text, review);
    } catch (err) {
      pi.logger.error("bilingual english review failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const applyUi = (next: ExtensionUIContext) => {
    ui = next;
    next.setStatus("bilingual", barStatus(liveConfig));
    next.setWidget("bilingual", undefined);
    next.setWidget("bilingual-review", undefined);
  };

  const queueThinkingTranslate = (paras: string[], requestRender: () => void) => {
    thinkingQueued = { paras, requestRender };
    if (!scheduleTimer) {
      void boot.then(() => {
        if (thinkingQueued) flushThinkingTranslate();
      });
      return;
    }
    if (thinkingTimer != null) {
      cancelTimer?.(thinkingTimer);
      thinkingTimer = undefined;
    }
    thinkingTimer = scheduleTimer(flushThinkingTranslate, liveConfig.thinkingDebounceMs);
  };

  pi.registerAssistantThinkingRenderer((context, theme) => {
    if (configReady && (!liveConfig.enabled || !liveConfig.translateThinking)) return undefined;
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
    if (freshClosed.length > 0) queueThinkingTranslate(freshClosed, lastThinkingRender);
    return view;
  });

  pi.on("session_start", async (_event, ctx) => {
    await boot;
    scheduleTimer = (fn, ms) => ctx.setTimeout(fn, ms);
    cancelTimer = (id) => ctx.clearTimer(id);
    sessionIsIdle = () => ctx.isIdle();
    applyUi(ctx.ui);
  });

  pi.on("before_agent_start", (event) => {
    if (!liveConfig.enabled || !liveConfig.reviewEnglish) return;
    if (liveConfig.backend === "google") return;
    const text = event.prompt.trim();
    if (!isEnglishPrompt(text)) return;
    void runEnglishReview(text);
    return { message: reviewCard(text) };
  });

  pi.on("agent_start", () => {
    pendingHarvest = { thinking: [], texts: [] };
    ui?.setWidget("bilingual", undefined);
  });

  pi.on("message_end", (event) => {
    if (!liveConfig.enabled) return;
    if (event.message.role === "user") return;
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

  pi.on("agent_end", async (event) => {
    if (event.willContinue) return;
    const { thinking, texts } = pendingHarvest;
    pendingHarvest = { thinking: [], texts: [] };
    if (texts.length > 0) await postTextCard(texts);
    const paras = [...thinking, ...texts];
    if (paras.length === 0) return;
    void translateFresh(paras, () => {
      paintTextCards(texts);
      lastThinkingRender?.();
    }).catch((err) => {
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
  { name: "custom", description: "Switch to a custom OpenAI-compatible provider" },
  { name: "update", description: "How to upgrade this plugin" },
];
async function applyCommand(args: string): Promise<PluginConfig | string> {
  const [cmd, ...rest] = args.trim().split(/\s+/);
  if (cmd === "update") {
    return [
      `installed ${PACKAGE_VERSION}`,
      "升级:",
      "  omp plugin marketplace update",
      "  omp plugin upgrade bilingual@polin-plugins",
    ].join("\n");
  }
  if (!cmd || cmd === "status" || cmd === "version") return loadConfig();
  if (cmd === "on") return patchConfig({ enabled: true });
  if (cmd === "off") return patchConfig({ enabled: false });
  if (cmd === "google" || cmd === "deepseek" || cmd === "hunyuan" || cmd === "custom") {
    return patchConfig({ backend: cmd });
  }
  if (cmd === "backend") {
    const value = rest[0];
    if (value !== "google" && value !== "deepseek" && value !== "hunyuan" && value !== "custom") {
      return "用法: /bilingual backend google|deepseek|hunyuan|custom";
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
    "  /bilingual google|deepseek|hunyuan|custom",
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
  if (config.backend === "custom") {
    return `bilingual ${PACKAGE_VERSION} ${on} · custom · ${config.target} · ${config.customModel || "no model"} · ${config.customBaseUrl || "no url"}${config.customApiKey ? "" : " · no key"} · ${think}`;
  }
  return `bilingual ${PACKAGE_VERSION} ${on} · google · ${config.sourceLang}→${config.target} · ${think}`;
}

function isBilingualContextMessage(message: { role?: string; customType?: string; content?: unknown }): boolean {
  if (message.role !== "custom") return false;
  const type = message.customType ?? "";
  return type === CUSTOM_TYPE || type === REVIEW_TYPE || type.startsWith("com.omp.bilingual");
}

function textsKey(texts: string[]): string {
  return texts.join("\n\0");
}

function bilingualTexts(details: object): string[] {
  if ("texts" in details && Array.isArray(details.texts) && details.texts.every((t) => typeof t === "string")) {
    return details.texts;
  }
  if ("pairs" in details && Array.isArray(details.pairs)) {
    const out: string[] = [];
    for (const pair of details.pairs) {
      if (pair && typeof pair === "object" && "en" in pair && typeof pair.en === "string") out.push(pair.en);
    }
    return out;
  }
  return [];
}

function isRetryableTranslateError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /HTTP (429|5\d\d)|timeout|fetch|socket|ECONN|network|aborted/i.test(msg);
}

function messageHasToolCalls(message: { content?: unknown }): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block) => {
    if (!block || typeof block !== "object" || !("type" in block)) return false;
    return block.type === "toolCall" || block.type === "tool_call";
  });
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
