import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, patchConfig } from "./config.ts";
import { runConfigure } from "./configure.ts";
import { partitionTranslatableParagraphs } from "./extract.ts";
import { renderBilingualCard, ThinkingTranslationView } from "./render.ts";
import { describeBackend, translateParagraphs } from "./translate.ts";
import { CUSTOM_TYPE, PACKAGE_VERSION, type Backend, type Pair, type PluginConfig } from "./types.ts";

export default function bilingual(pi: ExtensionAPI): void {
  pi.setLabel("Bilingual");

  pi.registerMessageRenderer(CUSTOM_TYPE, (message, _opts, theme) => renderBilingualCard(message, theme));

  const paraZh = new Map<string, string>();
  const paraFailed = new Set<string>();
  const paraBusy = new Set<string>();
  const THINKING_DEBOUNCE_MS = 2000;
  let scheduleTimer: ((fn: () => void, ms: number) => unknown) | undefined;
  let cancelTimer: ((id: unknown) => void) | undefined;
  let thinkingTimer: unknown;
  let thinkingQueued: { paras: string[]; requestRender: () => void } | undefined;
  let lastThinkingRender: (() => void) | undefined;

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

  pi.registerAssistantThinkingRenderer((context, theme) => {
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
    thinkingTimer = scheduleTimer(flushThinkingTranslate, THINKING_DEBOUNCE_MS);
    return view;
  });

  pi.on("context", (event) => ({
    messages: event.messages.filter((m) => !(m.role === "custom" && m.customType === CUSTOM_TYPE)),
  }));

  pi.on("session_start", async (_event, ctx) => {
    scheduleTimer = (fn, ms) => ctx.setTimeout(fn, ms);
    cancelTimer = (id) => ctx.clearTimer(id);
    const config = await loadConfig();
    ctx.ui.setStatus("bilingual", barStatus(config));
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    if (thinkingTimer != null) {
      cancelTimer?.(thinkingTimer);
      thinkingTimer = undefined;
    }
    flushThinkingTranslate();
    lastThinkingRender?.();
  });

  pi.registerCommand("bilingual", {
    description: "Toggle or configure paragraph bilingual cards",
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
      if (first === "configure" || first === "config") {
        if (!ctx.hasUI) {
          ctx.ui.notify("/bilingual configure needs the TUI", "warning");
          return;
        }
        const next = await runConfigure(ctx);
        if (!next) return;
        ctx.ui.setStatus("bilingual", barStatus(next));
        ctx.ui.notify(statusLine(next), "info");
        return;
      }
      const next = await applyCommand(args.trim());
      if (typeof next === "string") {
        ctx.ui.notify(next, "info");
        return;
      }
      ctx.ui.setStatus("bilingual", barStatus(next));
      ctx.ui.notify(statusLine(next), "info");
    },
  });
}



const SUBCOMMANDS = [
  { name: "on", description: "Enable bilingual cards" },
  { name: "off", description: "Disable bilingual cards" },
  { name: "status", description: "Show backend, model, version, and on/off" },
  { name: "version", description: "Show installed plugin version" },
  { name: "update", description: "How to upgrade this plugin" },
  { name: "configure", description: "Open TUI to set backend, key, and model" },
  { name: "google", description: "Switch to free Google Translate" },
  { name: "deepseek", description: "Switch to DeepSeek (configure key first)" },
  { name: "hunyuan", description: "Switch to Hunyuan (configure key first)" },
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
    if (!value) return "用法: /bilingual target zh-CN";
    return patchConfig({ target: value });
  }
  return [
    "用法:",
    "  /bilingual on|off|status|version|update",
    "  /bilingual configure",
    "  /bilingual google|deepseek|hunyuan",
  ].join("\n");
}

function barStatus(config: PluginConfig): string {
  if (!config.enabled) return `译:off ${PACKAGE_VERSION}`;
  return `译:${describeBackend(config.backend)} ${PACKAGE_VERSION}`;
}

function statusLine(config: PluginConfig): string {
  const on = config.enabled ? "on" : "off";
  if (config.backend === "deepseek") {
    return `bilingual ${PACKAGE_VERSION} ${on} · deepseek · ${config.deepseekModel}${config.deepseekApiKey ? "" : " · no key"}`;
  }
  if (config.backend === "hunyuan") {
    return `bilingual ${PACKAGE_VERSION} ${on} · hunyuan · ${config.hunyuanModel}${config.hunyuanApiKey ? "" : " · no key"}`;
  }
  return `bilingual ${PACKAGE_VERSION} ${on} · google · ${config.target}`;
}
