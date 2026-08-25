import { Box, Markdown, Spacer } from "@oh-my-pi/pi-tui";
import type { Component, MarkdownTheme } from "@oh-my-pi/pi-tui";
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent";
import type { BilingualDetails, Pair } from "./types.ts";
import type { EnglishReview, PromptCoach } from "./translate.ts";
import { CUSTOM_TYPE, translationSuffix } from "./types.ts";

export type ThemeLike = {
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
  const rec = value as { pairs?: unknown; texts?: unknown; backend?: unknown };
  if (typeof rec.backend !== "string") return false;
  return Array.isArray(rec.pairs) || Array.isArray(rec.texts);
}

export function renderBilingualCard(
  message: CustomMessage<unknown>,
  theme: ThemeLike,
): Component | undefined {
  if (message.customType !== CUSTOM_TYPE) return undefined;
  const details = isBilingualDetails(message.details) ? message.details : undefined;
  if (!details) return undefined;
  return new TextCardView(theme, details.chain || details.backend, details.pairs ?? []);
}

export class TextCardView implements Component {
  #pairs: Pair[] = [];

  constructor(
    private readonly theme: ThemeLike,
    private readonly backend: string,
    pairs: Pair[] = [],
  ) {
    this.#pairs = pairs;
  }

  setPairs(pairs: Pair[]): void {
    this.#pairs = pairs;
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (this.#pairs.length === 0) return [];
    return (
      renderPairCard(
        { pairs: this.#pairs, backend: this.backend as BilingualDetails["backend"], chain: this.backend },
        this.theme,
      )?.render(width) ?? []
    );
  }
}

export function renderPairCard(details: BilingualDetails, theme: ThemeLike): Component | undefined {
  const pairs = details.pairs ?? [];
  if (pairs.length === 0) return undefined;

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
    const advisor = pair.kind === "advisor";
    const last = i === pairs.length - 1;
    const zh = `${pair.zh}${last ? translationSuffix(pair.alias, pair.delayMs) : ""}`;
    box.addChild(
      new Trimmed(
        new Markdown(advisor ? `EN  ${pair.en}` : pair.en, 0, 0, mdTheme, {
          color: (t) => theme.fg(thinking ? "thinkingText" : "dim", t),
          italic: thinking,
        }),
      ),
    );
    box.addChild(markedZh(advisor ? `中  ${zh}` : zh, theme, mdTheme));
    if (i < pairs.length - 1) box.addChild(new Spacer(1));
  }
  box.addChild(
    new CornerTag(
      theme.fg("dim", pairs.some((p) => p.kind === "advisor") ? "译·advisor" : `译·${details.chain || details.backend}`),
    ),
  );
  return box;
}

export function renderThinkingTranslation(zh: string, theme: ThemeLike): Component {
  return markedZh(zh, theme, markdownTheme(theme));
}

function markedZh(zh: string, theme: ThemeLike, mdTheme: MarkdownTheme): Component {
  const md = new Markdown(zh, 0, 0, mdTheme, {
    color: (t) => theme.fg("accent", t),
  });
  return new Prefixed(new Trimmed(md), () => theme.fg("accent", "│ "));
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
  #alias?: string;
  #delayMs?: number;
  constructor(private readonly theme: ThemeLike) {}

  setZh(zh: string, stamp?: { alias: string; delayMs: number }): void {
    this.#zh = zh;
    this.#alias = stamp?.alias;
    this.#delayMs = stamp?.delayMs;
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (!this.#zh) return [];
    return renderThinkingTranslation(`${this.#zh}${translationSuffix(this.#alias, this.#delayMs)}`, this.theme).render(
      width,
    );
  }
}

export class TextTranslationView extends ThinkingTranslationView {}

export function renderEnglishReview(review: EnglishReview, theme: ThemeLike): Component {
  const recommended = review.better || review.corrected;
  const lines = [
    review.ok ? "Looks natural." : review.corrected ? `Corrected: ${review.corrected}` : "",
    recommended ? `Try (LLM prompt): ${recommended}` : "",
    review.note,
  ].filter(Boolean);
  return markedZh(lines.join("\n\n"), theme, markdownTheme(theme));
}

export class EnglishReviewView implements Component {
  #review: EnglishReview | undefined;
  constructor(private readonly theme: ThemeLike) {}

  setReview(review: EnglishReview): void {
    this.#review = review;
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (!this.#review) return [];
    return renderEnglishReview(this.#review, this.theme).render(width);
  }
}

export function renderPromptCoach(coach: PromptCoach, theme: ThemeLike): Component {
  const lines = [
    "下次可以这样问：",
    coach.english,
    coach.better ? `Try (LLM prompt): ${coach.better}` : "",
    coach.note,
  ].filter(Boolean);
  return markedZh(lines.join("\n\n"), theme, markdownTheme(theme));
}

export class PromptCoachView implements Component {
  #coach: PromptCoach | undefined;
  constructor(private readonly theme: ThemeLike) {}

  setCoach(coach: PromptCoach): void {
    this.#coach = coach;
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (!this.#coach) return [];
    return renderPromptCoach(this.#coach, this.theme).render(width);
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
