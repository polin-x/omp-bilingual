import { Box, Markdown, Spacer } from "@oh-my-pi/pi-tui";
import type { Component, MarkdownTheme } from "@oh-my-pi/pi-tui";
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent";
import type { BilingualDetails } from "./types.ts";
import { CUSTOM_TYPE, ornamentFrame } from "./types.ts";

type ThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  bg(color: string, text: string): string;
  boxRound: {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
  };
};

const TABLE_BOX = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
  cross: "+",
  teeDown: "+",
  teeUp: "+",
  teeLeft: "+",
  teeRight: "+",
};

export function isBilingualDetails(value: unknown): value is BilingualDetails {
  if (!value || typeof value !== "object") return false;
  const rec = value as { pairs?: unknown; backend?: unknown };
  return Array.isArray(rec.pairs) && typeof rec.backend === "string";
}

export function renderBilingualCard(
  message: CustomMessage<unknown>,
  theme: ThemeLike,
): Component | undefined {
  if (message.customType !== CUSTOM_TYPE) return undefined;
  const details = isBilingualDetails(message.details) ? message.details : undefined;
  if (!details) return undefined;
  return renderPairCard(details, theme);
}

export function renderPairCard(details: BilingualDetails, theme: ThemeLike): Component | undefined {
  const pairs = details.pairs;
  if (pairs.length === 0) return undefined;
  const ornament = details.ornament ?? "globe";

  const mdTheme = markdownTheme(theme);
  const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
  box.setIgnoreTight(true);
  box.setBorder({
    chars: theme.boxRound,
    color: (t) => theme.fg("borderAccent", t),
  });
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    const thinking = pair.kind === "thinking";
    box.addChild(
      new Trimmed(
        new Markdown(pair.en, 0, 0, mdTheme, {
          color: (t) => theme.fg(thinking ? "thinkingText" : "dim", t),
          italic: thinking,
        }),
      ),
    );
    box.addChild(markedZh(pair.zh, theme, mdTheme, ornament, false));
    if (i < pairs.length - 1) box.addChild(new Spacer(1));
  }
  box.addChild(new CornerTag(theme.fg("dim", `译·${details.backend}`)));
  return box;
}

export function renderThinkingTranslation(zh: string, theme: ThemeLike, ornament = "globe"): Component {
  return markedZh(zh, theme, markdownTheme(theme), ornament, true);
}

function markedZh(
  zh: string,
  theme: ThemeLike,
  mdTheme: MarkdownTheme,
  ornament: string,
  animate: boolean,
): Component {
  const md = new Markdown(zh, 0, 0, mdTheme, {
    color: (t) => theme.fg("accent", t),
  });
  return new Prefixed(new Trimmed(md), () =>
    theme.fg("accent", `${ornamentFrame(ornament, animate ? Date.now() : 0)} `),
  );
}

class Trimmed implements Component {
  constructor(private readonly inner: Component) {}

  invalidate(): void {
    this.inner.invalidate?.();
  }

  render(width: number): readonly string[] {
    const lines = this.inner.render(width);
    let start = 0;
    let end = lines.length;
    while (start < end && visibleWidth(lines[start] ?? "") === 0) start += 1;
    while (end > start && visibleWidth(lines[end - 1] ?? "") === 0) end -= 1;
    return lines.slice(start, end);
  }
}

class Prefixed implements Component {
  constructor(
    private readonly inner: Component,
    private readonly prefix: () => string,
  ) {}

  invalidate(): void {
    this.inner.invalidate?.();
  }

  render(width: number): readonly string[] {
    const mark = this.prefix();
    const innerWidth = Math.max(1, width - visibleWidth(mark));
    return this.inner.render(innerWidth).map((line) => mark + line);
  }
}

export class ThinkingTranslationView implements Component {
  #zh = "";
  #ornament = "globe";
  constructor(private readonly theme: ThemeLike) {}

  setOrnament(ornament: string): void {
    this.#ornament = ornament;
  }

  setZh(zh: string): void {
    this.#zh = zh;
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (!this.#zh) return [];
    return renderThinkingTranslation(this.#zh, this.theme, this.#ornament).render(width);
  }
}

function markdownTheme(theme: ThemeLike): MarkdownTheme {
  return {
    heading: (text) => theme.fg("text", text),
    link: (text) => theme.fg("text", text),
    linkUrl: (text) => theme.fg("dim", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => text,
    underline: (text) => text,
    symbols: {
      cursor: ">",
      inputCursor: "|",
      boxRound: theme.boxRound,
      boxSharp: TABLE_BOX,
      table: TABLE_BOX,
      quoteBorder: "|",
      hrChar: "-",
      spinnerFrames: ["-"],
    },
  };
}

class CornerTag implements Component {
  constructor(private readonly tag: string) {}

  invalidate(): void {}

  render(width: number): readonly string[] {
    const tag = this.tag.length === 0 ? "" : truncateToWidth(this.tag, Math.max(0, width));
    const w = visibleWidth(tag);
    if (w >= width) return [tag];
    return [padding(width - w) + tag];
  }
}
