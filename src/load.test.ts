import { expect, test } from "bun:test";

test("thinking flush helper is defined before use", async () => {
  const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  const definedAt = src.search(/const flushThinkingTranslate\s*=/);
  const usedAt = src.search(/\bflushThinkingTranslate\s*\(/);
  expect(definedAt).toBeGreaterThan(-1);
  expect(usedAt).toBeGreaterThan(definedAt);
});
