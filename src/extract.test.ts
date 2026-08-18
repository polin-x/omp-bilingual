import { expect, test } from "bun:test";
import { extractAdvisorParagraphs, extractSourceParagraphs, splitTranslatableParagraphs } from "./extract.ts";

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

test("splitTranslatableParagraphs keeps English lists with a few CJK quotes", () => {
  const texts = splitTranslatableParagraphs(
    [
      "Implemented and pushed.",
      "",
      "### System Extension check and customer guide",
      "",
      "On every VPN connection attempt:",
      "",
      "- Link displays \"需要启用 Link 网络扩展\" with:",
      "  - 打开系统设置 button;",
      "",
      "### Security",
      "",
      "- Host and Provider use the same Keychain Access Group.",
    ].join("\n"),
  );
  expect(texts.some((t) => t.startsWith("Implemented and pushed."))).toBe(true);
  expect(texts.some((t) => t.includes("Keychain Access Group"))).toBe(true);
});

test("extractSourceParagraphs reads assistant text blocks", () => {
  const out = extractSourceParagraphs({
    role: "assistant",
    content: [{ type: "text", text: "Implemented and pushed.\n\nOn every VPN connection attempt:" }],
  });
  expect(out.map((p) => p.text)).toEqual(["Implemented and pushed.", "On every VPN connection attempt:"]);
});
