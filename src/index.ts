import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, patchConfig } from "./config.ts";
import { runConfigure } from "./configure.ts";
import { extractSourceParagraphs, fingerprintParagraphs, splitTranslatableParagraphs } from "./extract.ts";
import { renderBilingualCard, ThinkingTranslationView } from "./render.ts";
import { describeBackend, translateParagraphs } from "./translate.ts";
import { CUSTOM_TYPE, type Backend, type BilingualDetails, type PluginConfig } from "./types.ts";

export default function bilingual(pi: ExtensionAPI): void {
  pi.setLabel("Bilingual");
  const inflight = new Set<string>();
  const seen = new Set<string>();
  const pending: BilingualDetails[] = [];

  pi.registerMessageRenderer(CUSTOM_TYPE, (message, _opts, theme) => renderBilingualCard(message, theme));

  const thinkingZh = new Map<string, string>();
  const thinkingBusy = new Set<string>();
  pi.registerAssistantThinkingRenderer((context, theme) => {
    const paras = splitTranslatableParagraphs(context.text);
    if (paras.length === 0) return undefined;
    const key = paras.join("\n\u241e\n");
    const view = new ThinkingTranslationView(theme);
    const cached = thinkingZh.get(key);
    if (cached) {
      view.setZh(cached);
      return view;
    }
    if (!thinkingBusy.has(key)) {
      thinkingBusy.add(key);
      void loadConfig()
        .then((config) => (config.enabled ? translateParagraphs(paras, config) : []))
        .then((pairs) => {
          const zh = pairs.map((p) => p.zh).filter(Boolean).join("\n\n");
          if (zh) thinkingZh.set(key, zh);
          view.setZh(zh);
          context.requestRender();
        })
        .catch((err) => {
          pi.logger.error("bilingual thinking translate failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => thinkingBusy.delete(key));
    }
    return view;
  });

  pi.on("context", (event) => ({
    messages: event.messages.filter((m) => !(m.role === "custom" && m.customType === CUSTOM_TYPE)),
  }));

  pi.on("session_start", async (_event, ctx) => {
    const config = await loadConfig();
    ctx.ui.setStatus(
      "bilingual",
      config.enabled ? `译:${describeBackend(config.backend)}` : "译:off",
    );
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!isContinuableAssistant(event.message)) return;
    await translateAssistant(pi, ctx, event.message, inflight, seen, pending);
  });

  pi.on("turn_end", (_event, ctx) => flushPending(pi, ctx, pending));
  pi.on("agent_end", (_event, ctx) => flushPending(pi, ctx, pending));

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
        ctx.ui.setStatus("bilingual", next.enabled ? `译:${describeBackend(next.backend)}` : "译:off");
        ctx.ui.notify(statusLine(next), "info");
        return;
      }
      const next = await applyCommand(args.trim());
      if (typeof next === "string") {
        ctx.ui.notify(next, "info");
        return;
      }
      ctx.ui.setStatus(
        "bilingual",
        next.enabled ? `译:${describeBackend(next.backend)}` : "译:off",
      );
      ctx.ui.notify(statusLine(next), "info");
    },
  });
}

async function translateAssistant(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: { role?: string; content?: unknown },
  inflight: Set<string>,
  seen: Set<string>,
  pending: BilingualDetails[],
): Promise<void> {
  const config = await loadConfig();
  if (!config.enabled) return;
  const sources = extractSourceParagraphs(message);
  if (sources.length === 0) return;
  const key = fingerprintParagraphs(sources);
  if (seen.has(key) || inflight.has(key)) return;
  inflight.add(key);
  ctx.ui.setStatus("bilingual", "译:…");
  try {
    const translated = await translateParagraphs(
      sources.map((s) => s.text),
      config,
    );
    const pairs = translated.flatMap((pair, i) => {
      const kind = sources[i]?.kind ?? "text";
      if (!pair.zh || pair.zh === pair.en) return [];
      return [{ ...pair, kind }];
    });
    seen.add(key);
    if (seen.size > 48) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }
    if (pairs.length === 0) {
      ctx.ui.setStatus("bilingual", `译:${describeBackend(config.backend)}`);
      return;
    }
    pending.push({ pairs, backend: config.backend });
    flushPending(pi, ctx, pending);
    ctx.ui.setStatus("bilingual", `译:${describeBackend(config.backend)}`);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    pi.logger.error("bilingual translate failed", { err: text });
    ctx.ui.notify(`对照失败: ${text}`, "warning");
    ctx.ui.setStatus("bilingual", "译:err");
  } finally {
    inflight.delete(key);
  }
}

function flushPending(pi: ExtensionAPI, ctx: ExtensionContext, pending: BilingualDetails[]): void {
  if (!ctx.isIdle() || pending.length === 0) return;
  const cards = pending.splice(0, pending.length);
  for (const details of cards) {
    pi.sendMessage(
      {
        customType: CUSTOM_TYPE,
        content: details.pairs.map((p) => p.zh).join("\n\n"),
        display: true,
        attribution: "agent",
        details,
      },
      { triggerTurn: false },
    );
  }
}

function isContinuableAssistant(message: object): boolean {
  if (!("stopReason" in message)) return true;
  const stop = message.stopReason;
  return stop !== "error" && stop !== "aborted";
}


const SUBCOMMANDS = [
  { name: "on", description: "Enable bilingual cards" },
  { name: "off", description: "Disable bilingual cards" },
  { name: "status", description: "Show backend, model, and on/off" },
  { name: "configure", description: "Open TUI to set backend, key, and model" },
  { name: "google", description: "Switch to free Google Translate" },
  { name: "deepseek", description: "Switch to DeepSeek (configure key first)" },
  { name: "hunyuan", description: "Switch to Hunyuan (configure key first)" },
];
async function applyCommand(args: string): Promise<PluginConfig | string> {
  const [cmd = "", ...rest] = args.split(/\s+/).filter(Boolean);
  if (!cmd || cmd === "status") return statusLine(await loadConfig());
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
    "  /bilingual on|off|status",
    "  /bilingual configure",
    "  /bilingual google|deepseek|hunyuan",
  ].join("\n");
}

function statusLine(config: PluginConfig): string {
  const on = config.enabled ? "on" : "off";
  if (config.backend === "deepseek") {
    return `bilingual ${on} · deepseek · ${config.deepseekModel}${config.deepseekApiKey ? "" : " · no key"}`;
  }
  if (config.backend === "hunyuan") {
    return `bilingual ${on} · hunyuan · ${config.hunyuanModel}${config.hunyuanApiKey ? "" : " · no key"}`;
  }
  return `bilingual ${on} · google · ${config.target}`;
}
