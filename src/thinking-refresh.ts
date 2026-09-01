import { partitionTranslatableParagraphs } from "./extract.ts";

export type ThinkingStamp = { alias: string; delayMs: number };

export type ThinkingView = {
  setZh: (zh: string, stamp?: ThinkingStamp) => void;
};

export function uniqueParagraphs(texts: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function joinCachedZh(paras: string[], cachedZh: (en: string) => string | undefined): string {
  const zhs: string[] = [];
  const seen = new Set<string>();
  for (const en of uniqueParagraphs(paras)) {
    const zh = cachedZh(en);
    if (!zh || seen.has(zh)) continue;
    seen.add(zh);
    zhs.push(zh);
  }
  return zhs.join("\n\n");
}

export function bindThinkingRefresh(opts: {
  view: ThinkingView;
  paras: string[];
  cachedZh: (en: string) => string | undefined;
  stampFor: (texts: string[]) => ThinkingStamp | undefined;
  requestRender: () => void;
}): () => void {
  return () => {
    const paras = uniqueParagraphs(opts.paras);
    opts.view.setZh(joinCachedZh(paras, opts.cachedZh), opts.stampFor(paras));
    opts.requestRender();
  };
}

export function attachThinkingTranslation<T extends ThinkingView>(opts: {
  text: string;
  createView: () => T;
  cachedZh: (en: string) => string | undefined;
  stampFor: (texts: string[]) => ThinkingStamp | undefined;
  requestRender: () => void;
}): { view: T; paras: string[]; closed: string[]; refresh: () => void } | undefined {
  const { closed, open } = partitionTranslatableParagraphs(opts.text);
  const paras = uniqueParagraphs(open ? [...closed, open] : closed);
  if (paras.length === 0) return undefined;
  const view = opts.createView();
  const refresh = bindThinkingRefresh({
    view,
    paras,
    cachedZh: opts.cachedZh,
    stampFor: opts.stampFor,
    requestRender: opts.requestRender,
  });
  view.setZh(joinCachedZh(paras, opts.cachedZh), opts.stampFor(paras));
  return { view, paras, closed: uniqueParagraphs(closed), refresh };
}


