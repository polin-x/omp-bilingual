import { expect, test } from "bun:test";

const REQUIRED = [
  "flushThinkingTranslate",
  "queueThinkingTranslate",
  "flushTextTranslate",
  "queueTextTranslate",
  "attachInlineText",
  "installInlineText",
  "reviewKeyOf",
  "paintReviews",
  "postTextCard",
  "whenIdle",
  "paintTextCards",
  "pairsFromCache",
  "runEnglishReview",
  "runPromptCoach",
];

const ORDERED = ["flushThinkingTranslate", "paintReviews"];

test("critical helpers are defined", async () => {
  const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  for (const name of REQUIRED) {
    expect(src.search(new RegExp(`const ${name}\\s*=`)), `${name} defined`).toBeGreaterThan(-1);
  }
  for (const name of ORDERED) {
    const definedAt = src.search(new RegExp(`const ${name}\\s*=`));
    const usedAt = src.search(new RegExp(`\\b${name}\\s*\\(`));
    expect(usedAt, `${name} used`).toBeGreaterThan(definedAt);
  }
});

test("before_agent_start dispatches Chinese prompts before English review", async () => {
  const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  const chinese = src.indexOf("isChinesePrompt(text)");
  const english = src.indexOf("isEnglishPrompt(text)");
  expect(chinese).toBeGreaterThan(-1);
  expect(english).toBeGreaterThan(chinese);
});

test("postTextCard waits for idle before nextTurn send", async () => {
  const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  const when = src.indexOf("const whenIdle");
  const post = src.indexOf("const postTextCard");
  const send = src.indexOf('deliverAs: "nextTurn"');
  expect(when).toBeGreaterThan(-1);
  expect(post).toBeGreaterThan(when);
  expect(send).toBeGreaterThan(post);
  expect(src.slice(post, send)).toContain("whenIdle");
});


test("thinking renderer reuses the view for a thinkingIndex", async () => {
  const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  expect(src).toContain("rememberThinkingView(thinkingViews, context.thinkingIndex");
  expect(src).toContain("if (event.message.role === \"assistant\") thinkingViews.clear()");
  const renderer = src.indexOf("pi.registerAssistantThinkingRenderer");
  const returned = src.indexOf("return view;", renderer);
  expect(renderer).toBeGreaterThan(-1);
  expect(returned).toBeGreaterThan(renderer);
});

test("assistant body cards are skipped when the inline hook is installed", async () => {
  const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  expect(src).toContain("!textInlineInstalled && texts.length > 0");
  expect(src).toContain("installUpdateContentHook");
  expect(src).toContain("return installInlineText()");
});
