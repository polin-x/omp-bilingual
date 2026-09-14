export function isAdvisorMessage(message: { role?: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === "advisor";
}

export function looksLikeAdvisorCard(child: { render?: (width: number) => readonly string[] }): boolean {
  if (typeof child.render !== "function") return false;
  const line = child.render(80)[0];
  return typeof line === "string" && line.includes("Advisor");
}

export type AdvisorCard = {
  render: (width: number) => readonly string[];
  invalidate?: () => void;
};

export type AdvisorZhView = {
  render: (width: number) => readonly string[];
  invalidate?: () => void;
};

const decorated = new WeakSet<object>();

export function decorateAdvisorCard(card: AdvisorCard, view: AdvisorZhView): boolean {
  if (decorated.has(card)) return false;
  decorated.add(card);
  const origRender = card.render.bind(card);
  const origInvalidate = card.invalidate?.bind(card);
  card.render = (width: number) => {
    const base = origRender(width);
    const extra = view.render(width);
    return extra.length === 0 ? base : [...base, ...extra];
  };
  card.invalidate = () => {
    origInvalidate?.();
    view.invalidate?.();
  };
  return true;
}

export function attachAdvisorCards(
  children: unknown[],
  messages: Array<{ role?: string; customType?: string }>,
  attach: (card: AdvisorCard, message: { role?: string; customType?: string }) => void,
): void {
  let i = 0;
  for (const message of messages) {
    if (!isAdvisorMessage(message)) continue;
    while (i < children.length && !looksLikeAdvisorCard(children[i] as AdvisorCard)) i += 1;
    const card = children[i];
    if (card && looksLikeAdvisorCard(card as AdvisorCard)) {
      attach(card as AdvisorCard, message);
      i += 1;
    }
  }
}
