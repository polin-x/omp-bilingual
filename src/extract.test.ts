import { expect, test } from "bun:test";
import { extractAdvisorParagraphs } from "./extract.ts";

test("extractAdvisorParagraphs pulls English notes only", () => {
  const texts = extractAdvisorParagraphs({
    role: "custom",
    customType: "advisor",
    details: {
      notes: [
        {
          severity: "concern",
          note: "The answer understates the main real risk: reviewEnglish fires against the same endpoint.",
        },
        { severity: "info", note: "改一下配置即可。" },
      ],
    },
  });
  expect(texts).toEqual([
    "The answer understates the main real risk: reviewEnglish fires against the same endpoint.",
  ]);
});

test("extractAdvisorParagraphs ignores non-advisor messages", () => {
  expect(extractAdvisorParagraphs({ role: "assistant", customType: "advisor", details: { notes: [] } })).toEqual([]);
});
