const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const LATIN = /[A-Za-z]/;
const KANA = /[\u3040-\u30ff]/;
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/;
const PATH_PREFIX = /^(?:~|\/|\.\/|\.\.\/|[A-Za-z]:[\\/])/;
const CMD_PREFIX = /^[$#%>]\s+\S/;

export type SourceParagraph = {
  text: string;
  kind: "text" | "thinking";
};

export function extractSourceParagraphs(message: { role?: string; content?: unknown }): SourceParagraph[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const out: SourceParagraph[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (rec.type === "thinking" && typeof rec.thinking === "string") {
      for (const text of splitTranslatableParagraphs(rec.thinking)) out.push({ text, kind: "thinking" });
    }
    if (rec.type === "text" && typeof rec.text === "string") {
      for (const text of splitTranslatableParagraphs(rec.text)) out.push({ text, kind: "text" });
    }
  }
  return out;
}

export type SessionLikeEntry = {
  type?: string;
  message?: { role?: string; content?: unknown; customType?: string };
};

export function findLastTranslatableAssistant(
  entries: ReadonlyArray<SessionLikeEntry>,
  isCard: (message: { role?: string; customType?: string }) => boolean,
): { texts: string[]; thinking: string[]; alreadyCarded: boolean } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = entry?.message;
    if (entry?.type !== "message" || !message || message.role !== "assistant") continue;
    const sources = extractSourceParagraphs(message);
    const texts = sources.filter((s) => s.kind === "text").map((s) => s.text);
    const thinking = sources.filter((s) => s.kind === "thinking").map((s) => s.text);
    if (texts.length === 0 && thinking.length === 0) continue;
    const later = entries.slice(i + 1);
    const alreadyCarded = later.some((next) => next.type === "message" && next.message && isCard(next.message));
    return { texts, thinking, alreadyCarded };
  }
  return undefined;
}

export function extractAdvisorParagraphs(message: {
  role?: string;
  customType?: string;
  details?: unknown;
}): string[] {
  if (message.role !== "custom" || message.customType !== "advisor") return [];
  const details = message.details;
  if (!details || typeof details !== "object" || !("notes" in details) || !Array.isArray(details.notes)) return [];
  const out: string[] = [];
  for (const entry of details.notes) {
    if (!entry || typeof entry !== "object" || !("note" in entry)) continue;
    const note = entry.note;
    if (typeof note !== "string") continue;
    for (const text of splitTranslatableParagraphs(note)) out.push(text);
  }
  return out;
}

export type PartitionedParagraphs = {
  closed: string[];
  open: string | undefined;
};

export function partitionTranslatableParagraphs(source: string): PartitionedParagraphs {
  const closed: string[] = [];
  let fence: string | undefined;
  let para: string[] = [];

  const flush = () => {
    const text = para.join("\n").trim();
    para = [];
    if (text && isTranslatable(text)) closed.push(text);
  };

  for (const raw of source.replaceAll("\r\n", "\n").split("\n")) {
    const fenceMatch = raw.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (!fence) {
        flush();
        fence = marker[0];
      } else if (marker[0] === fence) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;
    if (isStructuralMarkdownLine(raw)) {
      flush();
      continue;
    }
    if (raw.trim() === "") {
      flush();
      continue;
    }
    para.push(raw);
  }
  const openText = para.join("\n").trim();
  const open = openText && isTranslatable(openText) ? openText : undefined;
  return { closed, open };
}

export function splitTranslatableParagraphs(source: string): string[] {
  const { closed, open } = partitionTranslatableParagraphs(source);
  return open ? [...closed, open] : closed;
}

export function isTranslatable(text: string): boolean {
  const compact = text.trim();
  if (PATH_PREFIX.test(compact) && /[\\/]/.test(compact.slice(1))) return false;
  if (CMD_PREFIX.test(compact)) return false;
  if (looksLikeMarkdownTable(text)) return false;
  if (looksLikeCode(text)) return false;
  if (KANA.test(text) || HANGUL.test(text)) return true;
  if (!LATIN.test(text)) return false;
  if (CJK.test(text) && !enoughEnglish(text)) return false;
  return true;
}

export function isEnglishPrompt(text: string): boolean {
  const t = text.trim();
  if (t.length < 6 || t.startsWith("/")) return false;
  if (!LATIN.test(t)) return false;
  const letters = t.match(/[A-Za-z]/g)?.length ?? 0;
  const cjk = t.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return letters >= 6 && letters > cjk * 2;
}

function isStructuralMarkdownLine(raw: string): boolean {
  const line = raw.trim();
  if (line.length === 0) return false;
  if (/^#{1,6}[ \t]+\S/.test(line)) return true;
  if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) return true;
  if (line.includes("|") && (line.startsWith("|") || line.endsWith("|") || /^\|?[\s:-]+\|[\s|:-]+$/.test(line))) {
    return true;
  }
  return false;
}

function looksLikeMarkdownTable(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const pipes = lines.filter((l) => l.includes("|"));
  return pipes.length >= Math.max(2, Math.ceil(lines.length * 0.7));
}

function enoughEnglish(text: string): boolean {
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
  const cjk = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return letters >= 24 && letters > cjk * 2;
}

function looksLikeCode(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  let hits = 0;
  for (const line of lines) {
    if (
      /^(import|export|from|const|let|var|function|class|def|return|if|for|while|try|catch)\b/.test(line) ||
      /[{};]$/.test(line) ||
      /=>/.test(line) ||
      /^\s*(?:\/\/|#|\/\*)/.test(line)
    ) {
      hits += 1;
    }
  }
  return hits / lines.length >= 0.6;
}
