import { afterEach, expect, test } from "bun:test";
import { backendChain, reviewEnglishPrompt, translateParagraphs } from "./translate.ts";
import { DEFAULT_CONFIG, type PluginConfig } from "./types.ts";

const cfg: PluginConfig = {
  ...DEFAULT_CONFIG,
  backend: "custom",
  fallback1: "deepseek",
  fallback2: "off",
  customApiKey: "k-custom",
  customBaseUrl: "https://custom.test/v1",
  customModel: "custom-model",
  deepseekApiKey: "k-deepseek",
  deepseekModel: "deepseek-model",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("backendChain keeps primary then two fallbacks and skips dupes", () => {
  expect(backendChain({ ...cfg, fallback2: "google" })).toEqual(["custom", "deepseek", "google"]);
  expect(backendChain({ ...cfg, fallback1: "custom", fallback2: "google" })).toEqual(["custom", "google"]);
});

test("bad JSON review falls through to the next LLM", async () => {
  const hosts: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    hosts.push(new URL(url).host);
    if (url.includes("custom.test")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ok: true,
                corrected: "Hello there, friend.",
                better: "Greet the teammate.",
                note: "语气自然。",
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const review = await reviewEnglishPrompt("hello there friend", cfg);
  expect(review?.ok).toBe(true);
  expect(review?.corrected).toBe("Hello there, friend.");
  expect(hosts).toEqual(["custom.test", "api.deepseek.com"]);
});

test("aborted review does not call the next backend", async () => {
  const ac = new AbortController();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    ac.abort();
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    throw err;
  }) as typeof fetch;

  await expect(reviewEnglishPrompt("hello there friend", cfg, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
});

test("aborted translate does not call the next backend", async () => {
  const ac = new AbortController();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    ac.abort();
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    throw err;
  }) as typeof fetch;

  await expect(translateParagraphs(["Need git status first."], cfg, ac.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(calls).toBe(1);
});
