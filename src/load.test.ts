import { expect, test } from "bun:test";

const REQUIRED = [
  "flushThinkingTranslate",
  "queueThinkingTranslate",
  "reviewKeyOf",
  "paintReviews",
  "postTextCard",
  "paintTextCards",
  "pairsFromCache",
  "runEnglishReview",
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
