import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { loadTranslationCache, saveTranslationCache, translationKey } from "./cache.ts";
import { loadConfig, patchConfig } from "./config.ts";
import { runConfigure } from "./configure.ts";
import { extractAdvisorParagraphs, extractSourceParagraphs, findLastTranslatableAssistant, isChinesePrompt, isEnglishPrompt, partitionTranslatableParagraphs } from "./extract.ts";
import { EnglishReviewView, PromptCoachView, TextCardView, TextTranslationView, ThinkingTranslationView, type ThemeLike } from "./render.ts";
import { asUpdateContentHost, contentHost, ensureTrailingView, extractAssistantText, installUpdateContentHook, removeTrailingView, themeFromModule } from "./text-attach.ts";
import { attachThinkingTranslation, uniqueParagraphs } from "./thinking-refresh.ts";
import {
  backendChain,
  coachChinesePrompt,
  describeChain,
  looksLikeTranslation,
  reviewEnglishPrompt,
  reusableCachedCoach,
  serializeCoachCache,
  translateParagraphs,
  type EnglishReview,
  type PromptCoach,
} from "./translate.ts";
import {
  CUSTOM_TYPE,
  DEFAULT_CONFIG,
  LEARN_TYPE,
  PACKAGE_VERSION,
  REVIEW_TYPE,
  type Backend,
  type BilingualDetails,
  type Pair,
  type PluginConfig,
} from "./types.ts";

function isThemeLike(value: unknown): value is ThemeLike {
  if (!value || typeof value !== "object") return false;
  if (!("fg" in value) || typeof value.fg !== "function") return false;
  if (!("bold" in value) || typeof value.bold !== "function") return false;
  if (!("italic" in value) || typeof value.italic !== "function") return false;
  return true;
}

export default function bilingual(pi: ExtensionAPI): Promise<void> {
  pi.setLabel("Bilingual");

  const paraZh = new Map<string, string>();
  const paraFailed = new Set<string>();
  const paraBusy = new Set<string>();
  const stamps = new Map<string, { alias: string; delayMs: number }>();
  const reviews = new Map<string, EnglishReview>();
  const reviewViews: EnglishReviewView[] = [];
  const reviewViewSource = new WeakMap<EnglishReviewView, string>();
  const reviewBusy = new Set<string>();
  const coaches = new Map<string, PromptCoach>();
  const coachViews: PromptCoachView[] = [];
  const coachViewSource = new WeakMap<PromptCoachView, string>();
  const coachBusy = new Set<string>();
  const textViews: TextCardView[] = [];
  const textViewSource = new WeakMap<TextCardView, string>();

  pi.registerMessageRenderer(CUSTOM_TYPE, (message, _opts, theme) => {
    if (message.customType !== CUSTOM_TYPE) return undefined;
    const details = message.details;
    if (!details || typeof details !== "object" || !("backend" in details) || typeof details.backend !== "string") {
      return undefined;
    }
    const texts = bilingualTexts(details);
    const kind = "kind" in details && details.kind === "advisor" ? "advisor" : "text";
    const chain =
      "chain" in details && typeof details.chain === "string" && details.chain ? details.chain : details.backend;
    const view = new TextCardView(theme, chain, pairsFromCache(texts, kind));
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
    const cached = parseCachedReview(paraZh.get(reviewKeyOf(details.source)) ?? "");
    const hit = reviews.get(details.source) ?? fromDetails ?? cached;
    if (hit) view.setReview(hit);
    reviewViews.push(view);
    reviewViewSource.set(view, details.source);
    if (reviewViews.length > 16) reviewViews.shift();
    return view;
  });
  pi.registerMessageRenderer(LEARN_TYPE, (message, _opts, theme) => {
    if (message.customType !== LEARN_TYPE) return undefined;
    const details = message.details;
    if (!details || typeof details !== "object" || !("source" in details) || typeof details.source !== "string") {
      return undefined;
    }
    const view = new PromptCoachView(theme);
    const fromDetails =
      "coach" in details && details.coach && typeof details.coach === "object"
        ? (details.coach as PromptCoach)
        : undefined;
    const cached = reusableCachedCoach(paraZh.get(learnKeyOf(details.source)) ?? "");
    const hit = coaches.get(details.source) ?? fromDetails ?? cached;
    if (hit) view.setCoach(hit);
    coachViews.push(view);
    coachViewSource.set(view, details.source);
    if (coachViews.length > 16) coachViews.shift();
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
    for (const [k, text] of disk.zh) paraZh.set(k, text);
    for (const [k, stamp] of disk.stamps) stamps.set(k, stamp);
    pi.setLabel(pluginLabel(liveConfig));
    configReady = true;
  })();
  let scheduleTimer: ((fn: () => void, ms: number) => unknown) | undefined;
  let cancelTimer: ((id: unknown) => void) | undefined;
  let sessionIsIdle: (() => boolean) | undefined;
  let thinkingTimer: unknown;
  let idlePostTimers = new Set<unknown>();
  let cardEpoch = 0;
  let thinkingQueued: { paras: string[]; requestRender: () => void } | undefined;
  let textQueued: { paras: string[]; requestRender: () => void } | undefined;
  let textTimer: unknown;
  let textInlineInstalled = false;
  let inlineTheme: ThemeLike | undefined;
  const lastTextRenders: Array<() => void> = [];
  const textRefreshByView = new WeakMap<TextTranslationView, () => void>();
  const lastThinkingRenders: Array<() => void> = [];
  const thinkingRefreshByView = new WeakMap<ThinkingTranslationView, () => void>();


  let persistTimer: unknown;
  let ui: ExtensionUIContext | undefined;
  let pendingHarvest = { thinking: [] as string[], texts: [] as string[], advisors: [] as string[], thinks: [] as string[] };

  const keyOf = (en: string) => translationKey(en, liveConfig.target, liveConfig.backend);

  const cachedZh = (en: string) => paraZh.get(keyOf(en));

  const pairsFromCache = (texts: string[], kind: Pair["kind"] = "text"): Pair[] => {
    const pairs: Pair[] = [];
    for (const en of texts) {
      const zh = cachedZh(en);
      if (zh) pairs.push({ en, zh, kind });
    }
    return attachStamp(pairs, texts);
  };

  const stampFor = (texts: string[]) => {
    for (let i = texts.length - 1; i >= 0; i--) {
      const hit = stamps.get(keyOf(texts[i]!));
      if (hit) return hit;
    }
    return undefined;
  };

  const attachStamp = (pairs: Pair[], texts: string[]): Pair[] => {
    const stamp = stampFor(texts);
    const last = pairs[pairs.length - 1];
    if (!stamp || !last) return pairs;
    return [...pairs.slice(0, -1), { ...last, alias: stamp.alias, delayMs: stamp.delayMs }];
  };

  const rememberStamp = (en: string, alias: string, delayMs: number) => {
    stamps.set(keyOf(en), { alias, delayMs });
    if (stamps.size > 64) {
      const first = stamps.keys().next().value;
      if (first !== undefined) stamps.delete(first);
    }
  };

  const paintTextCards = (texts: string[], kind: Pair["kind"] = "text") => {
    const pairs = pairsFromCache(texts, kind);
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
      void saveTranslationCache(paraZh, stamps).catch((err) => {
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
      const first = [...paraZh.keys()].find((k) => !k.startsWith("review\t"));
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


  const translateFresh = async (paras: string[], requestRender?: () => void): Promise<Pair[]> => {
    const fresh = paras.filter((p) => !paraZh.has(keyOf(p)) && !paraFailed.has(keyOf(p)) && !paraBusy.has(keyOf(p)));
    if (fresh.length === 0) {
      requestRender?.();
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
          if (pair.alias !== undefined && typeof pair.delayMs === "number") {
            rememberStamp(pair.en, pair.alias, pair.delayMs);
          }
          out.push(pair);
        }
      }
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
  const whenIdle = (fn: () => void) => {
    const epoch = cardEpoch;
    const run = () => {
      if (epoch !== cardEpoch) return;
      fn();
    };
    if (!sessionIsIdle || sessionIsIdle()) {
      run();
      return;
    }
    if (!scheduleTimer) {
      run();
      return;
    }
    let id: unknown;
    const tick = () => {
      idlePostTimers.delete(id);
      if (epoch !== cardEpoch) return;
      if (!sessionIsIdle || sessionIsIdle()) {
        run();
        return;
      }
      id = scheduleTimer?.(tick, 32);
      idlePostTimers.add(id);
    };
    id = scheduleTimer(tick, 32);
    idlePostTimers.add(id);
  };

  const postTextCard = (texts: string[], kind: Pair["kind"] = "text") => {
    if (!liveConfig.enabled) return;
    const allowed = kind === "think" || kind === "thinking" ? liveConfig.translateThinking : liveConfig.translateText;
    if (!allowed) return;
    if (texts.length === 0) return;

    whenIdle(() => {
      const pairs = pairsFromCache(texts, kind);
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: "",
          display: true,
          attribution: "agent",
          details: {
            texts,
            pairs,
            kind,
            backend: liveConfig.backend,
            chain: describeChain(liveConfig),
            ornament: liveConfig.ornament,
          },
        },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
    });
  };

  const reviewKeyOf = (en: string) => `review\t${liveConfig.backend}\t${en}`;

  const paintReviews = (source: string, review: EnglishReview) => {
    reviews.set(source, review);
    for (const view of reviewViews) {
      if (reviewViewSource.get(view) === source) view.setReview(review);
    }
    ui?.setStatus("bilingual", barStatus(liveConfig));
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
    if (!backendChain(liveConfig).some((b) => b !== "google")) return;
    if (reviewBusy.has(text)) return;
    const cacheKey = reviewKeyOf(text);
    const cached = paraZh.get(cacheKey);
    if (cached) {
      const review = parseCachedReview(cached);
      if (review) {
        paintReviews(text, review);
        return;
      }
    }
    reviewBusy.add(text);
    try {
      const review = await reviewEnglishPrompt(text, liveConfig);
      if (!review) return;
      paraZh.set(cacheKey, JSON.stringify(review));
      void saveTranslationCache(paraZh, stamps).catch((err) => {
        pi.logger.error("bilingual cache save failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
      paintReviews(text, review);
    } catch (err) {
      pi.logger.error("bilingual english review failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      reviewBusy.delete(text);
    }
  };

  const learnKeyOf = (zh: string) => `learn\t${liveConfig.backend}\t${zh}`;

  const paintCoaches = (source: string, coach: PromptCoach) => {
    coaches.set(source, coach);
    for (const view of coachViews) {
      if (coachViewSource.get(view) === source) view.setCoach(coach);
    }
    ui?.setStatus("bilingual", barStatus(liveConfig));
  };

  const learnCard = (text: string) => {
    const cached = reusableCachedCoach(paraZh.get(learnKeyOf(text)) ?? "");
    if (cached) paintCoaches(text, cached);
    return {
      customType: LEARN_TYPE,
      content: "",
      display: true as const,
      attribution: "agent" as const,
      details: { source: text, coach: cached },
    };
  };

  const runPromptCoach = async (text: string) => {
    if (coachBusy.has(text)) return;
    const cacheKey = learnKeyOf(text);
    const cached = paraZh.get(cacheKey);
    if (cached) {
      const coach = reusableCachedCoach(cached);
      if (coach) {
        paintCoaches(text, coach);
        return;
      }
    }
    coachBusy.add(text);
    try {
      const coach = await coachChinesePrompt(text, liveConfig);
      if (!coach) return;
      const stored = serializeCoachCache(coach);
      if (stored) {
        paraZh.set(cacheKey, stored);
        void saveTranslationCache(paraZh, stamps).catch((err) => {
          pi.logger.error("bilingual cache save failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
      paintCoaches(text, coach);
    } catch (err) {
      pi.logger.error("bilingual chinese prompt coach failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      coachBusy.delete(text);
    }
  };

  const applyUi = (next: ExtensionUIContext) => {
    ui = next;
    pi.setLabel(pluginLabel(liveConfig));
    next.setStatus("bilingual", barStatus(liveConfig));
    next.setWidget("bilingual", undefined);
    next.setWidget("bilingual-review", undefined);
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

  const paintInlineText = () => {
    for (const refresh of lastTextRenders) refresh();
    ui?.setStatus("bilingual", barStatus(liveConfig));
  };

  const flushTextTranslate = () => {
    textTimer = undefined;
    const job = textQueued;
    textQueued = undefined;
    if (!job) return;
    void translateFresh(job.paras, job.requestRender).catch((err) => {
      pi.logger.error("bilingual text translate failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const queueTextTranslate = (paras: string[], requestRender: () => void) => {
    textQueued = { paras, requestRender };
    if (!scheduleTimer) {
      void boot.then(() => {
        if (textQueued) flushTextTranslate();
      });
      return;
    }
    if (textTimer != null) {
      cancelTimer?.(textTimer);
      textTimer = undefined;
    }
    textTimer = scheduleTimer(flushTextTranslate, liveConfig.thinkingDebounceMs);
  };

  const rememberTextRefresh = (view: TextTranslationView, refresh: () => void) => {
    const prev = textRefreshByView.get(view);
    if (prev) {
      const idx = lastTextRenders.indexOf(prev);
      if (idx >= 0) lastTextRenders[idx] = refresh;
    } else {
      lastTextRenders.push(refresh);
      if (lastTextRenders.length > 16) lastTextRenders.shift();
    }
    textRefreshByView.set(view, refresh);
  };

  const paintThinking = () => {
    for (const refresh of lastThinkingRenders) refresh();
    ui?.setStatus("bilingual", barStatus(liveConfig));
  };

  const rememberThinkingRefresh = (view: ThinkingTranslationView, refresh: () => void) => {
    const prev = thinkingRefreshByView.get(view);
    if (prev) {
      const idx = lastThinkingRenders.indexOf(prev);
      if (idx >= 0) lastThinkingRenders[idx] = refresh;
    } else {
      lastThinkingRenders.push(refresh);
      if (lastThinkingRenders.length > 16) lastThinkingRenders.shift();
    }
    thinkingRefreshByView.set(view, refresh);
  };


  const isTextView = (child: unknown): child is TextTranslationView => child instanceof TextTranslationView;

  const bindTextView = (view: TextTranslationView, text: string, requestRender: () => void): boolean => {
    const { closed, open } = partitionTranslatableParagraphs(text);
    const paras = uniqueParagraphs(open ? [...closed, open] : closed);
    if (paras.length === 0) return false;
    const refresh = bindThinkingRefresh({
      view,
      paras,
      cachedZh,
      stampFor,
      requestRender,
    });
    rememberTextRefresh(view, refresh);
    const zh = joinCachedZh(paras, cachedZh);
    if (zh) view.setZh(zh, stampFor(paras));
    const freshClosed = uniqueParagraphs(closed).filter(
      (p) => !paraZh.has(keyOf(p)) && !paraFailed.has(keyOf(p)) && !paraBusy.has(keyOf(p)),
    );
    if (freshClosed.length > 0) queueTextTranslate(freshClosed, refresh);
    return true;
  };

  const attachInlineText = (host: object, message: object, theme: ThemeLike) => {
    if (configReady && (!liveConfig.enabled || !liveConfig.translateText)) return;
    const container = contentHost(host);
    if (!container) return;
    const text = extractAssistantText(message);
    if (!text) {
      removeTrailingView(container, isTextView);
      return;
    }
    const view = ensureTrailingView(container, isTextView, () => new TextTranslationView(theme));
    if (!bindTextView(view, text, paintInlineText)) removeTrailingView(container, isTextView);
  };

  const installInlineText = async () => {
    type HostApi = ExtensionAPI & {
      registerAssistantTextRenderer?: (
        renderer: (context: { text: string; requestRender: () => void }, theme: ThemeLike) => TextTranslationView | undefined,
      ) => void;
    };
    const hostApi = pi as HostApi;
    if (typeof hostApi.registerAssistantTextRenderer === "function") {
      hostApi.registerAssistantTextRenderer((context, theme) => {
        inlineTheme = theme;
        if (configReady && (!liveConfig.enabled || !liveConfig.translateText)) return undefined;
        const view = new TextTranslationView(theme);
        if (!bindTextView(view, context.text, context.requestRender)) return undefined;
        return view;
      });
      textInlineInstalled = true;
      return;
    }
    try {
      // Compiled omp may omit host subpaths; fall back to end-of-turn cards.
      const ctor = asUpdateContentHost(await import("@oh-my-pi/pi-coding-agent/modes/components/assistant-message"));
      if (!ctor) return;
      const loadedTheme = themeFromModule(await import("@oh-my-pi/pi-coding-agent/modes/theme/theme"));
      installUpdateContentHook(ctor, (host, message) => {
        const theme = inlineTheme ?? (isThemeLike(loadedTheme) ? loadedTheme : undefined);
        if (!theme) return;
        attachInlineText(host, message, theme);
      });
      textInlineInstalled = true;
    } catch (err) {
      pi.logger.error("bilingual text hook unavailable", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  pi.registerAssistantThinkingRenderer((context, theme) => {
    inlineTheme = theme;
    if (configReady && (!liveConfig.enabled || !liveConfig.translateThinking)) return undefined;
    const attached = attachThinkingTranslation({
      text: context.text,
      createView: () => new ThinkingTranslationView(theme),
      cachedZh,
      stampFor,
      requestRender: () => context.requestRender(),
    });
    if (!attached) return undefined;
    rememberThinkingRefresh(attached.view, attached.refresh);
    const freshClosed = attached.closed.filter(
      (p) => !paraZh.has(keyOf(p)) && !paraFailed.has(keyOf(p)) && !paraBusy.has(keyOf(p)),
    );
    if (freshClosed.length > 0) queueThinkingTranslate(freshClosed, paintThinking);
    return attached.view;
  });


  const harvestExisting = (
    entries: ReadonlyArray<{ type?: string; message?: { role?: string; content?: unknown; customType?: string } }>,
  ) => {
    if (!liveConfig.enabled) return;
    const hit = findLastTranslatableAssistant(entries, isBilingualContextMessage);
    if (!hit) return;
    const texts = liveConfig.translateText ? hit.texts : [];
    const thinking = liveConfig.translateThinking ? hit.thinking : [];
    if (!textInlineInstalled && !hit.alreadyCarded && texts.length > 0) postTextCard(texts);
    const paras = [...thinking, ...texts];
    if (paras.length === 0) return;
    void translateFresh(paras, () => {
      if (!textInlineInstalled) paintTextCards(texts);
      paintInlineText();
      paintThinking();
    }).catch((err) => {
      pi.logger.error("bilingual existing translate failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  };


  pi.on("session_start", async (_event, ctx) => {
    await boot;
    scheduleTimer = (fn, ms) => ctx.setTimeout(fn, ms);
    cancelTimer = (id) => ctx.clearTimer(id);
    sessionIsIdle = () => ctx.isIdle();
    applyUi(ctx.ui);
    harvestExisting(ctx.sessionManager.getEntries());
  });

  pi.on("before_agent_start", (event) => {
    if (!liveConfig.enabled) return;
    const text = event.prompt.trim();
    if (liveConfig.learnEnglish && isChinesePrompt(text)) {
      void runPromptCoach(text);
      return { message: learnCard(text) };
    }
    if (liveConfig.reviewEnglish && isEnglishPrompt(text) && backendChain(liveConfig).some((b) => b !== "google")) {
      void runEnglishReview(text);
      return { message: reviewCard(text) };
    }
  });

  pi.on("agent_start", () => {
    cardEpoch += 1;
    for (const id of idlePostTimers) cancelTimer?.(id);
    idlePostTimers.clear();
    ui?.setWidget("bilingual", undefined);
  });

  pi.on("message_end", (event) => {
    if (!liveConfig.enabled) return;
    const customType = "customType" in event.message ? event.message.customType : undefined;
    if (event.message.role === "custom" && customType === "advisor") {
      if (!liveConfig.translateText) return;
      const texts = extractAdvisorParagraphs(event.message);
      if (texts.length === 0) return;
      const idle = !sessionIsIdle || sessionIsIdle();
      if (idle) postTextCard(texts, "advisor");
      else pendingHarvest.advisors.push(...texts);
      void translateFresh(texts, () => paintTextCards(texts, "advisor")).catch((err) => {
        pi.logger.error("bilingual advisor translate failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }
    if (event.message.role === "user") return;
    if (event.message.role !== "assistant") return;
    if (thinkingTimer != null) {
      cancelTimer?.(thinkingTimer);
      thinkingTimer = undefined;
    }
    flushThinkingTranslate();
    if (textTimer != null) {
      cancelTimer?.(textTimer);
      textTimer = undefined;
    }
    flushTextTranslate();
    const sources = extractSourceParagraphs(event.message);
    if (liveConfig.translateThinking) {
      for (const s of sources) if (s.kind === "thinking") pendingHarvest.thinking.push(s.text);
      const thinks = uniqueParagraphs(sources.filter((s) => s.kind === "think").map((s) => s.text));
      if (thinks.length > 0) {
        const idle = !sessionIsIdle || sessionIsIdle();
        if (idle) postTextCard(thinks, "think");
        else pendingHarvest.thinks.push(...thinks);
        void translateFresh(thinks, () => paintTextCards(thinks, "think")).catch((err) => {
          pi.logger.error("bilingual think-tool translate failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
    if (liveConfig.translateText) {
      for (const s of sources) if (s.kind === "text") pendingHarvest.texts.push(s.text);
    }
    if (pendingHarvest.thinking.length > 0) {
      void translateFresh(pendingHarvest.thinking, paintThinking).catch((err) => {
        pi.logger.error("bilingual thinking translate failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (pendingHarvest.texts.length > 0) {
      void translateFresh(pendingHarvest.texts, paintInlineText).catch((err) => {
        pi.logger.error("bilingual text translate failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }

  });

  pi.on("agent_end", (event) => {
    if (event.willContinue) return;
    const { thinking, texts, advisors, thinks } = pendingHarvest;
    pendingHarvest = { thinking: [], texts: [], advisors: [], thinks: [] };
    if (advisors.length > 0) postTextCard(advisors, "advisor");
    if (thinks.length > 0) postTextCard(uniqueParagraphs(thinks), "think");
    if (!textInlineInstalled && texts.length > 0) postTextCard(texts);
    const paras = [...thinking, ...texts, ...advisors, ...thinks];
    if (paras.length === 0) return;
    void translateFresh(paras, () => {
      if (advisors.length > 0) paintTextCards(advisors, "advisor");
      if (thinks.length > 0) paintTextCards(uniqueParagraphs(thinks), "think");
      if (!textInlineInstalled) paintTextCards(texts);
      paintInlineText();
      paintThinking();
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

  return installInlineText();
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

function pluginLabel(config: PluginConfig): string {
  if (!config.enabled) return "Bilingual";
  return `Bilingual · ${describeChain(config)}`;
}

function barStatus(config: PluginConfig): string {
  if (!config.enabled) return `译:off ${PACKAGE_VERSION}`;
  return `译:${describeChain(config)} ${config.target} ${PACKAGE_VERSION}`;
}

function statusLine(config: PluginConfig): string {
  const on = config.enabled ? "on" : "off";
  const think = config.translateThinking ? "thinking" : "no-thinking";
  return `bilingual ${PACKAGE_VERSION} ${on} · ${describeChain(config)} · ${config.target} · ${think}`;
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


