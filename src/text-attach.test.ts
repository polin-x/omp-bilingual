import { expect, test } from "bun:test";
import {
  asUpdateContentHost,
  contentHost,
  ensureTrailingView,
  extractAssistantText,
  installUpdateContentHook,
  removeTrailingView,
} from "./text-attach.ts";

class View {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}

function isView(child: unknown): child is View {
  return child instanceof View;
}

test("contentHost prefers the second child container", () => {
  const marker = { children: ["marker"] };
  const content = { children: ["md"] };
  expect(contentHost({ children: [marker, content] })).toBe(content);
});

test("extractAssistantText joins text blocks and skips thinking", () => {
  expect(
    extractAssistantText({
      content: [
        { type: "thinking", thinking: "Need git status first." },
        { type: "text", text: "Need git status first." },
        { type: "text", text: "Then push." },
      ],
    }),
  ).toBe("Need git status first.\n\nThen push.");
});

test("ensureTrailingView appends once and moves an existing view to the end", () => {
  const host = {
    children: ["md"] as unknown[],
    addChild(child: unknown) {
      this.children.push(child);
    },
    removeChild(child: unknown) {
      this.children = this.children.filter((c) => c !== child);
    },
  };
  const first = ensureTrailingView(host, isView, () => new View("a"));
  expect(host.children).toEqual(["md", first]);
  host.children = [first, "md2"];
  const again = ensureTrailingView(host, isView, () => new View("b"));
  expect(again).toBe(first);
  expect(host.children).toEqual(["md2", first]);
});

test("removeTrailingView drops attached views", () => {
  const view = new View("a");
  const host = {
    children: ["md", view] as unknown[],
    removeChild(child: unknown) {
      this.children = this.children.filter((c) => c !== child);
    },
  };
  removeTrailingView(host, isView);
  expect(host.children).toEqual(["md"]);
});

test("installUpdateContentHook runs after the original update", () => {
  const calls: string[] = [];
  const ctor = {
    prototype: {
      updateContent(this: { id: string }, message: unknown) {
        const text = messageText(message);
        calls.push(`orig:${text}:${this.id}`);
      },
    },
  };
  installUpdateContentHook(ctor, (host, message) => {
    const text = messageText(message);
    const id = "id" in host && typeof host.id === "string" ? host.id : "";
    calls.push(`after:${text}:${id}`);
  });
  ctor.prototype.updateContent.call({ id: "host" }, { text: "Need git status first." });
  expect(calls).toEqual(["orig:Need git status first.:host", "after:Need git status first.:host"]);
});

function messageText(message: unknown): string {
  if (!message || typeof message !== "object" || !("text" in message)) return "";
  return typeof message.text === "string" ? message.text : "";
}

test("asUpdateContentHost accepts a class constructor", () => {
  class AssistantMessageComponent {
    updateContent(_message: unknown) {}
  }
  expect(asUpdateContentHost({ AssistantMessageComponent })).toBe(AssistantMessageComponent);
  expect(asUpdateContentHost({ AssistantMessageComponent: { prototype: {} } })).toBeUndefined();
});
