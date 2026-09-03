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

test("bindTextView imports bindThinkingRefresh and joinCachedZh", async () => {
  const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  const imp = src.match(/import \{([^}]+)\} from "\.\/thinking-refresh\.ts"/)?.[1] ?? "";
  expect(imp).toContain("bindThinkingRefresh");
  expect(imp).toContain("joinCachedZh");
  expect(imp).toContain("attachThinkingTranslation");
  const bind = src.indexOf("const bindTextView");
  const end = src.indexOf("const attachInlineText", bind);
  expect(bind).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(bind);
  const body = src.slice(bind, end);
  expect(body).toContain("bindThinkingRefresh(");
  expect(body).toContain("joinCachedZh(");
});


test("before_agent_start dispatches Chinese prompts before English review", async () => {
  const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  const chinese = src.indexOf("isChinesePrompt(text)");
  const english = src.indexOf("isEnglishPrompt(text)");
  expect(chinese).toBeGreaterThan(-1);
  expect(english).toBeGreaterThan(chinese);
});

test("plugin never registers a context hook or sendMessage cards", async () => {
  const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  expect(src).not.toContain('pi.on("context"');
  expect(src).not.toContain("sendMessage");
  expect(src).not.toContain('deliverAs: "nextTurn"');
  expect(src).not.toContain("postTextCard");
  expect(src).toContain("void boot.then(");
  expect(src).not.toContain("await boot");
});

test("before_agent_start inserts prompt cards into the transcript", async () => {
  const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  const start = src.indexOf('pi.on("before_agent_start"');
  const end = src.indexOf('pi.on("message_end"', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);
  expect(block).toContain("void runPromptCoach(text)");
  expect(block).toContain("void runEnglishReview(text)");
  expect(block).toContain("return { message: learnCard(text) }");
  expect(block).toContain("return { message: reviewCard(text) }");
  expect(block).not.toContain("setWidget");
});


test("thinking renderer creates a new view every call", async () => {
  const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  expect(src).toContain("attachThinkingTranslation");
  expect(src).toContain("createView: () => new ThinkingTranslationView(theme)");
  expect(src).not.toContain("rememberThinkingView");
  expect(src).not.toContain("thinkingViews");
  const renderer = src.indexOf("pi.registerAssistantThinkingRenderer");
  const returned = src.indexOf("return attached.view;", renderer);
  expect(renderer).toBeGreaterThan(-1);
  expect(returned).toBeGreaterThan(renderer);
});

