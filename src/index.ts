import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, patchConfig } from "./config.ts";
import { runConfigure } from "./configure.ts";
import { extractSourceParagraphs, partitionTranslatableParagraphs } from "./extract.ts";
import { renderBilingualCard, ThinkingTranslationView } from "./render.ts";
import { describeBackend, translateParagraphs } from "./translate.ts";
import { CUSTOM_TYPE, DEFAULT_CONFIG, PACKAGE_VERSION, type Backend, type Pair, type PluginConfig } from "./types.ts";

export default function bilingual(pi: ExtensionAPI): void {
  pi.setLabel("Bilingual");

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
  let sessionIsIdle: (() => boolean) | undefined;
  let pendingTextCard: { pairs: Pair[]; backend: Backend } | undefined;

  const rememberZh = (en: string, zh: string) => {
    paraZh.set(en, zh);
    if (paraZh.size > 128) {
      const first = paraZh.keys().next().value;
      if (first !== undefined) paraZh.delete(first);
    }
  };

  const rememberFail = (en: string) => {
    paraFailed.add(en);
    if (paraFailed.size > 64) {
      const first = paraFailed.values().next().value;
      if (first !== undefined) paraFailed.delete(first);
    }
  };

  const translateFresh = async (paras: string[], requestRender?: () => void): Promise<Pair[]> => {
    const fresh = paras.filter((p) => !paraZh.has(p) && !paraFailed.has(p) && !paraBusy.has(p));
    if (fresh.length === 0) return [];
    for (const p of fresh) paraBusy.add(p);
    try {
      const config = await loadConfig();
      if (!config.enabled) return [];
      const pairs = await translateParagraphs(fresh, config);
      const out: Pair[] = [];
      for (const pair of pairs) {
        if (pair.zh && pair.zh !== pair.en) {
          rememberZh(pair.en, pair.zh);
          out.push(pair);
        }
      }
      requestRender?.();
      return out;
    } catch (err) {
      for (const p of fresh) rememberFail(p);
      throw err;
    } finally {
      for (const p of fresh) paraBusy.delete(p);
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

  const postTextCard = () => {
    const card = pendingTextCard;
    pendingTextCard = undefined;
    if (!card || card.pairs.length === 0) return;
    pi.sendMessage(
      {
        customType: CUSTOM_TYPE,
        content: card.pairs.map((p) => p.zh).join("\n\n"),
        display: true,
        attribution: "agent",
        details: { pairs: card.pairs, backend: card.backend },
      },
      { triggerTurn: false },
    );
  };

  const scheduleTextCard = () => {
    const tick = () => {
      if (!pendingTextCard) return;
      if (!sessionIsIdle || sessionIsIdle()) {
        postTextCard();
        return;
      }
      if (scheduleTimer) scheduleTimer(tick, 150);
      else postTextCard();
    };
    tick();
  };

  pi.registerAssistantThinkingRenderer((context, theme) => {
    if (!liveConfig.enabled || !liveConfig.translateThinking) return undefined;
    const { closed, open } = partitionTranslatableParagraphs(context.text);
    const paras = open ? [...closed, open] : closed;
    if (paras.length === 0) return undefined;
    lastThinkingRender = () => context.requestRender();
    const view = new ThinkingTranslationView(theme);
    const zh = paras.map((p) => paraZh.get(p)).filter((t): t is string => Boolean(t)).join("\n\n");
    if (zh) view.setZh(zh);
    if (!paras.some((p) => !paraZh.has(p) && !paraFailed.has(p) && !paraBusy.has(p))) return view;
    if (!scheduleTimer) return view;
    thinkingQueued = { paras, requestRender: lastThinkingRender };
    if (thinkingTimer != null) {
      cancelTimer?.(thinkingTimer);
      thinkingTimer = undefined;
    }
    thinkingTimer = scheduleTimer(flushThinkingTranslate, liveConfig.thinkingDebounceMs);
    return view;
  });

  pi.on("context", (event) => ({
    messages: event.messages.filter((m) => !(m.role === "custom" && m.customType === CUSTOM_TYPE)),
  }));

  pi.on("session_start", async (_event, ctx) => {
    scheduleTimer = (fn, ms) => ctx.setTimeout(fn, ms);
    cancelTimer = (id) => ctx.clearTimer(id);
    liveConfig = await loadConfig();
    sessionIsIdle = () => ctx.isIdle();
    ctx.ui.setStatus("bilingual", barStatus(liveConfig));
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    if (thinkingTimer != null) {
      cancelTimer?.(thinkingTimer);
      thinkingTimer = undefined;
    }
    flushThinkingTranslate();
    lastThinkingRender?.();
    if (!liveConfig.enabled || !liveConfig.translateText) return;
    if (messageHasToolCalls(event.message)) return;
    const texts = extractSourceParagraphs(event.message)
      .filter((s) => s.kind === "text")
      .map((s) => s.text);
    if (texts.length === 0) return;
    try {
      await translateFresh(texts);
    } catch (err) {
      pi.logger.error("bilingual text translate failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    const pairs: Pair[] = [];
    for (const en of texts) {
      const zh = paraZh.get(en);
      if (zh) pairs.push({ en, zh, kind: "text" });
    }
    if (pairs.length === 0) return;
    pendingTextCard = { pairs, backend: liveConfig.backend };
    scheduleTextCard();
  });

  pi.on("agent_end", () => {
    scheduleTextCard();
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
        ctx.ui.setStatus("bilingual", barStatus(next));
        ctx.ui.notify(statusLine(next), "info");
        return;
      }
      const next = await applyCommand(args.trim());
      if (typeof next === "string") {
        ctx.ui.notify(next, "info");
        return;
      }
      liveConfig = next;
      ctx.ui.setStatus("bilingual", barStatus(next));
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

