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

export function rememberThinkingView<T>(
  views: Map<number, T>,
  thinkingIndex: number,
  create: () => T,
): T {
  const existing = views.get(thinkingIndex);
  if (existing) return existing;
  const view = create();
  views.set(thinkingIndex, view);
  return view;
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

