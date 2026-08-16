const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const LATIN = /[A-Za-z]/;
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

export function fingerprintParagraphs(paragraphs: SourceParagraph[]): string {
  return paragraphs.map((p) => `${p.kind}:${p.text}`).join("\n\u241e\n");
}

export function splitTranslatableParagraphs(source: string): string[] {
  const out: string[] = [];
  let fence: string | undefined;
  let para: string[] = [];

  const flush = () => {
    const text = para.join("\n").trim();
    para = [];
    if (text && isTranslatable(text)) out.push(text);
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
  flush();
  return out;
}

export function isTranslatable(text: string): boolean {
  if (!LATIN.test(text)) return false;
  if (CJK.test(text) && !enoughEnglish(text)) return false;
  const compact = text.trim();
  if (PATH_PREFIX.test(compact) && /[\\/]/.test(compact.slice(1))) return false;
  if (CMD_PREFIX.test(compact)) return false;
  if (looksLikeMarkdownTable(text)) return false;
  if (looksLikeCode(text)) return false;
  return true;
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
