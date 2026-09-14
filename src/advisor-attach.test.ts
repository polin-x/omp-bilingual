import { expect, test } from "bun:test";
import { attachAdvisorCards, decorateAdvisorCard, isAdvisorMessage, looksLikeAdvisorCard } from "./advisor-attach.ts";

test("isAdvisorMessage only matches custom advisor rows", () => {
  expect(isAdvisorMessage({ role: "custom", customType: "advisor" })).toBe(true);
  expect(isAdvisorMessage({ role: "assistant", customType: "advisor" })).toBe(false);
  expect(isAdvisorMessage({ role: "custom", customType: "com.omp.bilingual" })).toBe(false);
});

test("looksLikeAdvisorCard reads the host header", () => {
  expect(looksLikeAdvisorCard({ render: () => ["i Advisor 1 note"] })).toBe(true);
  expect(looksLikeAdvisorCard({ render: () => ["Need git status first."] })).toBe(false);
});

test("decorateAdvisorCard appends zh under the original card", () => {
  const card = {
    render: (width: number) => [`Advisor ${width}`],
    invalidate() {},
  };
  const view = {
    render: () => ["译: 先检查 git status。"],
    invalidate() {},
  };
  expect(decorateAdvisorCard(card, view)).toBe(true);
  expect(decorateAdvisorCard(card, view)).toBe(false);
  expect(card.render(40)).toEqual(["Advisor 40", "译: 先检查 git status。"]);
});

test("attachAdvisorCards pairs advisor messages with advisor children", () => {
  const attached: string[] = [];
  attachAdvisorCards(
    [{ render: () => ["user"] }, { render: () => ["i Advisor 1 note"] }, { render: () => ["assistant"] }],
    [
      { role: "user", customType: "" },
      { role: "custom", customType: "advisor" },
      { role: "assistant", customType: "" },
    ],
    (_card, message) => {
      attached.push(message.customType ?? "");
    },
  );
  expect(attached).toEqual(["advisor"]);
});
