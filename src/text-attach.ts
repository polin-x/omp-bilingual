export type ChildHost = {
  children?: unknown[];
  addChild?: (child: unknown) => void;
  removeChild?: (child: unknown) => void;
};

export type UpdateContentHost = {
  prototype: {
    updateContent: (message: unknown, opts?: unknown) => void;
  };
};

function isHost(value: unknown): value is ChildHost {
  return Boolean(value && typeof value === "object" && "children" in value && Array.isArray(value.children));
}

/** AssistantMessageComponent children: [markerSlot, contentContainer]. */
export function contentHost(root: { children?: unknown[] }): ChildHost | undefined {
  const kids = root.children;
  if (!Array.isArray(kids)) return undefined;
  if (kids.length >= 2 && isHost(kids[1])) return kids[1];
  for (let i = kids.length - 1; i >= 0; i--) {
    if (isHost(kids[i])) return kids[i];
  }
  return undefined;
}

export function ensureTrailingView<T>(
  host: ChildHost,
  isView: (child: unknown) => child is T,
  create: () => T,
): T {
  const kids = host.children ?? [];
  const existing = kids.find(isView);
  if (existing) {
    if (kids[kids.length - 1] !== existing) {
      host.removeChild?.(existing);
      host.addChild?.(existing);
    }
    return existing;
  }
  const view = create();
  host.addChild?.(view);
  return view;
}

export function removeTrailingView<T>(host: ChildHost, isView: (child: unknown) => child is T): void {
  for (const child of [...(host.children ?? [])]) {
    if (isView(child)) host.removeChild?.(child);
  }
}

export function extractAssistantText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    if (!("type" in block) || !("text" in block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(block.text);
  }
  return parts.join("\n\n");
}

export function asUpdateContentHost(mod: unknown): UpdateContentHost | undefined {
  if (!mod || typeof mod !== "object" || !("AssistantMessageComponent" in mod)) return undefined;
  const ctor = mod.AssistantMessageComponent;
  if (!ctor || (typeof ctor !== "object" && typeof ctor !== "function") || !("prototype" in ctor)) return undefined;
  const proto = ctor.prototype;
  if (!proto || typeof proto !== "object" || !("updateContent" in proto)) return undefined;
  if (typeof proto.updateContent !== "function") return undefined;
  return ctor as UpdateContentHost;
}

export function themeFromModule(mod: unknown): unknown {
  if (!mod || typeof mod !== "object" || !("theme" in mod)) return undefined;
  return mod.theme;
}

export function installUpdateContentHook(
  ctor: UpdateContentHost,
  after: (host: object, message: object) => void,
): void {
  const orig = ctor.prototype.updateContent;
  ctor.prototype.updateContent = function (this: object, message: unknown, opts?: unknown) {
    orig.call(this, message, opts);
    if (message && typeof message === "object") after(this, message);
  };
}
