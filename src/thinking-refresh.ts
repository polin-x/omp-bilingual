export type ThinkingStamp = { alias: string; delayMs: number };

export type ThinkingView = {
  setZh: (zh: string, stamp?: ThinkingStamp) => void;
};

export function bindThinkingRefresh(opts: {
  view: ThinkingView;
  paras: string[];
  cachedZh: (en: string) => string | undefined;
  stampFor: (texts: string[]) => ThinkingStamp | undefined;
  requestRender: () => void;
}): () => void {
  return () => {
    const zh = opts.paras.map((p) => opts.cachedZh(p)).filter((t): t is string => Boolean(t)).join("\n\n");
    opts.view.setZh(zh, opts.stampFor(opts.paras));
    opts.requestRender();
  };
}
