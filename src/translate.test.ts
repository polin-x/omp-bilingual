import { afterEach, expect, test } from "bun:test";
import { backendChain, describeChain, resolvedBackends, reviewEnglishPrompt, translateParagraphs } from "./translate.ts";
import { DEFAULT_CONFIG, translationSuffix, type PluginConfig } from "./types.ts";

const cfg: PluginConfig = {
  ...DEFAULT_CONFIG,
  backend: "custom",
  fallback1: "deepseek",
  fallback2: "off",
  customs: [
    {
      alias: "custom",
      apiKey: "k-custom",
      baseUrl: "https://custom.test/v1",
      model: "custom-model",
    },
  ],
  deepseekApiKey: "k-deepseek",
  deepseekModel: "deepseek-model",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function translationResponse(zh: string): Response {
  return jsonResponse(JSON.stringify([zh]));
}

test("backendChain keeps primary then two fallbacks and skips dupes", () => {
  expect(backendChain({ ...cfg, fallback2: "google" })).toEqual(["custom", "deepseek", "google"]);
  expect(backendChain({ ...cfg, fallback1: "custom", fallback2: "google" })).toEqual(["custom", "google"]);
});

test("resolvedBackends expands each custom LLM", () => {
  const multi: PluginConfig = {
    ...cfg,
    fallback1: "off",
    customs: [
      { alias: "a", apiKey: "k1", baseUrl: "https://a.test/v1", model: "m1" },
      { alias: "b", apiKey: "k2", baseUrl: "https://b.test/v1", model: "m2" },
    ],
  };
  expect(resolvedBackends(multi)).toEqual([
    { kind: "custom", llm: multi.customs[0]! },
    { kind: "custom", llm: multi.customs[1]! },
  ]);
  expect(describeChain(multi)).toBe("a/m1|b/m2");
});

test("fastest custom wins and aborts the slower one", async () => {
  const multi: PluginConfig = {
    ...DEFAULT_CONFIG,
    backend: "custom",
    customs: [
      { alias: "slow", apiKey: "k1", baseUrl: "https://slow.test/v1", model: "m1" },
      { alias: "fast", apiKey: "k2", baseUrl: "https://fast.test/v1", model: "m2" },
    ],
  };
  let slowAborted = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("slow.test")) {
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          slowAborted = true;
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return translationResponse("先检查 git status。");
  }) as typeof fetch;

  const pairs = await translateParagraphs(["Need git status first."], multi);
  expect(pairs).toHaveLength(1);
  expect(pairs[0]?.en).toBe("Need git status first.");
  expect(pairs[0]?.zh).toBe("先检查 git status。");
  expect(pairs[0]?.alias).toBe("fast/m2");
  expect(pairs[0]?.delayMs).toBeGreaterThanOrEqual(0);
  expect(`${pairs[0]?.zh}${translationSuffix(pairs[0]?.alias, pairs[0]?.delayMs)}`).toMatch(
    /^先检查 git status。 · fast\/m2 \d+ms$/,
  );
  expect(slowAborted).toBe(true);
});

test("delayMs is the winner latency, not the slower sibling", async () => {
  const multi: PluginConfig = {
    ...DEFAULT_CONFIG,
    backend: "custom",
    customs: [
      { alias: "slow", apiKey: "k1", baseUrl: "https://slow.test/v1", model: "m1" },
      { alias: "fast", apiKey: "k2", baseUrl: "https://fast.test/v1", model: "m2" },
    ],
  };
  let now = 1_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("slow.test")) {
        const { promise, reject } = Promise.withResolvers<Response>();
        const onAbort = () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener("abort", onAbort, { once: true });
        return promise;
      }
      now += 40;
      return translationResponse("先检查 git status。");
    }) as typeof fetch;

    const pairs = await translateParagraphs(["Need git status first."], multi);
    expect(pairs[0]?.alias).toBe("fast/m2");
    expect(pairs[0]?.delayMs).toBe(40);
  } finally {
    Date.now = realNow;
  }
});

test("bad JSON review still succeeds from a sibling LLM", async () => {
  const hosts: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    hosts.push(new URL(url).host);
    if (url.includes("custom.test")) {
      return jsonResponse("not-json");
    }
    return jsonResponse(
      JSON.stringify({
        ok: true,
        corrected: "Hello there, friend.",
        better: "Greet the teammate.",
        note: "语气自然。",
      }),
    );
  }) as typeof fetch;

  const review = await reviewEnglishPrompt("hello there friend", cfg);
  expect(review?.ok).toBe(true);
  expect(review?.corrected).toBe("Hello there, friend.");
  expect(hosts.sort()).toEqual(["api.deepseek.com", "custom.test"]);
});

test("aborted review rejects after every racer has started", async () => {
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
  expect(calls).toBe(2);
});

test("aborted translate rejects after every racer has started", async () => {
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
  expect(calls).toBe(2);
});

test("translationSuffix is display-only", () => {
  expect(translationSuffix("b.ai", 320)).toBe(" · b.ai 320ms");
  expect(translationSuffix()).toBe("");
  expect(translationSuffix("b.ai")).toBe("");
});
