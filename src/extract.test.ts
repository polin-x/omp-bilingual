import { expect, test } from "bun:test";
import { extractAdvisorParagraphs, extractSourceParagraphs, extractThinkParagraphs, findLastTranslatableAssistant, isChinesePrompt, splitTranslatableParagraphs } from "./extract.ts";


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

test("isChinesePrompt accepts Chinese-dominant questions", () => {
  expect(isChinesePrompt("能不能也把提问译成英文，并加上记忆技巧？")).toBe(true);
  expect(isChinesePrompt("帮我看下这个插件。")).toBe(true);
  expect(isChinesePrompt("这个 bug 怎么修")).toBe(true);
  expect(isChinesePrompt("怎么用 TypeScript API？")).toBe(true);
});

test("isChinesePrompt rejects English, slash commands, and short replies", () => {
  expect(isChinesePrompt("Can we also translate Chinese questions?")).toBe(false);
  expect(isChinesePrompt("/bilingual status")).toBe(false);
  expect(isChinesePrompt("好的")).toBe(false);
  expect(isChinesePrompt("fix this bug please")).toBe(false);
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

test("splitTranslatableParagraphs skips indented and long Markdown fences", () => {
  const texts = splitTranslatableParagraphs(
    [
      "Please run this next.",
      "",
      "   ```",
      "   const secretToken = \"do not translate this\";",
      "   ```",
      "",
      "Then the four-backtick block:",
      "",
      "````js",
      "const secretToken = \"still do not translate\";",
      "````",
      "",
      "And the long tilde fence:",
      "",
      "~~~~",
      "const secretToken = \"tilde fence stays code\";",
      "~~~~",
      "",
      "Done after the fences.",
    ].join("\n"),
  );
  expect(texts).toEqual([
    "Please run this next.",
    "Then the four-backtick block:",
    "And the long tilde fence:",
    "Done after the fences.",
  ]);
});

test("truncated session thinking is one paragraph", () => {
  const text =
    "Need to verify CertificateEnrollment.ensureLocalNetworkProfile wasn't duplicated by the auto-repair. Also writeAndOpen should use openExisting. Update tests. Check controller rest of function still ha...\n\n";
  expect(splitTranslatableParagraphs(text)).toEqual([text.trim()]);
});


test("extractSourceParagraphs reads assistant text blocks", () => {
  const out = extractSourceParagraphs({
    role: "assistant",
    content: [{ type: "text", text: "Implemented and pushed.\n\nOn every VPN connection attempt:" }],
  });
  expect(out.map((p) => p.text)).toEqual(["Implemented and pushed.", "On every VPN connection attempt:"]);
});

test("extractThinkParagraphs keeps the session think-tool plan", () => {
  const thoughts = [
    "User wants me to:",
    "1. Study UpdateCastscreenCodeLeboTask() from ~/golang-dev/it-castscreen-api",
    "2. Update this project's cast code",
    "3. Create a todo",
    "4. DON'T modify code now",
    "",
    "This is a research + planning task. I need to:",
    "- Find and understand UpdateCastscreenCodeLeboTask()",
    "- Understand current cast code in this project (it-castscreen)",
    "- Create a todo capturing the work",
    "- No code modifications",
    "",
    "I should start by exploring both codebases in parallel. Use scout for the API repo if needed, grep/read for the function, and look at this project's cast code.",
    "",
    "Let me also check if there's a relevant skill - doesn't seem like browser-use or kero-automation apply.",
    "",
    "I'll search both repos and read the function.",
  ].join("\n");
  const paras = extractThinkParagraphs({ thoughts });
  expect(paras.some((p) => p.startsWith("User wants me to:"))).toBe(true);
  expect(paras.some((p) => p.includes("research + planning task"))).toBe(true);
  expect(paras.some((p) => p.includes("exploring both codebases"))).toBe(true);
  const out = extractSourceParagraphs({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me search both codebases in parallel.\n\n" },
      { type: "toolCall", name: "think", arguments: { thoughts } },
    ],
  });
  expect(out.filter((p) => p.kind === "think").map((p) => p.text)).toEqual(paras);
});


test("findLastTranslatableAssistant skips a later Chinese-only assistant", () => {
  const hit = findLastTranslatableAssistant(
    [
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Implemented and pushed." }] },
      },
      { type: "message", message: { role: "custom", customType: "advisor", content: "" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "已修正用词。" }] } },
    ],
    (m) => m.customType === "com.omp.bilingual",
  );
  expect(hit?.texts).toEqual(["Implemented and pushed."]);
  expect(hit?.alreadyCarded).toBe(false);
});

test("findLastTranslatableAssistant skips later Chinese text with English thinking", () => {
  const hit = findLastTranslatableAssistant(
    [
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Implemented and pushed." }] },
      },
      { type: "message", message: { role: "custom", customType: "advisor", content: "" } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should rewrite the previous answer in Chinese." },
            { type: "text", text: "已修正用词。" },
          ],
        },
      },
    ],
    (m) => m.customType === "com.omp.bilingual",
  );
  expect(hit?.texts).toEqual(["Implemented and pushed."]);
  expect(hit?.thinking).toEqual([]);
});

test("findLastTranslatableAssistant treats persisted custom_message as already carded", () => {
  const hit = findLastTranslatableAssistant(
    [
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Implemented and pushed." }] },
      },
      { type: "custom_message", customType: "com.omp.bilingual" },
    ],
    (m) => m.role === "custom" && m.customType === "com.omp.bilingual",
  );
  expect(hit?.texts).toEqual(["Implemented and pushed."]);
  expect(hit?.alreadyCarded).toBe(true);
});
