import { afterEach, expect, test } from "bun:test";
import { backendChain, coachChinesePrompt, describeChain, resolvedBackends, reviewEnglishPrompt, reusableCachedCoach, serializeCoachCache, translateParagraphs } from "./translate.ts";
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

test("customs race in place; later fallbacks stay later", () => {
  const multi: PluginConfig = {
    ...cfg,
    fallback1: "google",
    fallback2: "deepseek",
    customs: [
      { alias: "a", apiKey: "k1", baseUrl: "https://a.test/v1", model: "m1" },
      { alias: "b", apiKey: "k2", baseUrl: "https://b.test/v1", model: "m2" },
    ],
  };
  expect(resolvedBackends(multi).map((b) => b.kind)).toEqual(["custom", "custom", "google", "deepseek"]);
  expect(describeChain(multi)).toBe("a/m1|b/m2>google>deepseek-model");
});

test("google primary stays before custom racers", () => {
  const multi: PluginConfig = {
    ...cfg,
    backend: "google",
    fallback1: "custom",
    fallback2: "off",
    customs: [
      { alias: "a", apiKey: "k1", baseUrl: "https://a.test/v1", model: "m1" },
      { alias: "b", apiKey: "k2", baseUrl: "https://b.test/v1", model: "m2" },
    ],
  };
  expect(resolvedBackends(multi).map((b) => b.kind)).toEqual(["google", "custom", "custom"]);
  expect(describeChain(multi)).toBe("google>a/m1|b/m2");
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
  expect(pairs[0]?.alias).toBe("fast");
  expect(pairs[0]?.delayMs).toBeGreaterThanOrEqual(0);
  expect(`${pairs[0]?.zh}${translationSuffix(pairs[0]?.alias, pairs[0]?.delayMs)}`).toMatch(
    /^先检查 git status。 · fast \d+ms$/,
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
    expect(pairs[0]?.alias).toBe("fast");
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

test("fastest coach wins and falls back to Google when LLMs fail", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("custom.test")) {
      return jsonResponse("not-json");
    }
    if (url.includes("api.deepseek.com")) {
      return jsonResponse(
        JSON.stringify({
          english: "Can we also translate Chinese questions into English?",
          better: "Also show English for Chinese prompts.",
          note: "also 放在动词前。谐音 all so：全都算上。",
        }),
      );
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

  const coach = await coachChinesePrompt("能不能也把提问译成英文？", cfg);
  expect(coach?.english).toBe("Can we also translate Chinese questions into English?");
  expect(coach?.note).toContain("谐音");
});

test("coachChinesePrompt uses Google when no LLM is configured", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("translate.googleapis.com")) throw new Error(`unexpected ${url}`);
    return new Response(JSON.stringify([[["Can we also translate Chinese questions?", "能不能也把提问译成英文"]]]), {
      status: 200,
    });
  }) as typeof fetch;
  const coach = await coachChinesePrompt("能不能也把提问译成英文？", DEFAULT_CONFIG);
  expect(coach?.english).toBe("Can we also translate Chinese questions?");
  expect(coach?.better).toBe("");
  expect(coach?.note).toContain("对照译文");
  expect(coach?.provider).toBe("google");
});

test("google fallback coach shows LLM failure reason", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("translate.googleapis.com")) {
      return new Response(JSON.stringify([[["Can we also translate Chinese questions?", "能不能也把提问译成英文"]]]), {
        status: 200,
      });
    }
    return jsonResponse("not-json");
  }) as typeof fetch;

  const coach = await coachChinesePrompt("能不能也把提问译成英文？", {
    ...cfg,
    fallback1: "google",
    fallback2: "off",
  });
  expect(coach?.english).toBe("Can we also translate Chinese questions?");
  expect(coach?.note).toContain("failed:");
  expect(coach?.note).toContain("not JSON");
  expect(coach?.provider).toBe("google");
});

test("coach reports empty content with backend name on Google fallback", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("translate.googleapis.com")) {
      return new Response(JSON.stringify([[["Hi", "你好"]]]), { status: 200 });
    }
    return jsonResponse("");
  }) as typeof fetch;

  const coach = await coachChinesePrompt("能不能也把提问译成英文？", {
    ...cfg,
    fallback1: "google",
    fallback2: "off",
  });
  expect(coach?.provider).toBe("google");
  expect(coach?.note).toContain("failed: empty content");
});

test("google coach is not cached so a later LLM result can upgrade the same prompt", () => {
  const google = {
    english: "I also want you to support something",
    better: "",
    note: "对照译文。custom failed: not JSON",
    provider: "google" as const,
  };
  expect(serializeCoachCache(google)).toBeUndefined();
  expect(reusableCachedCoach(JSON.stringify(google))).toBeUndefined();
  const llm = {
    english: "Also add a right-side signal on the board after each market close.",
    better: "Add a right-side signal after market close.",
    note: "also 放在动词前。谐音 all so：全都算上。",
    provider: "llm" as const,
  };
  const stored = serializeCoachCache(llm);
  expect(stored).toBeTruthy();
  expect(reusableCachedCoach(stored ?? "")?.note).toContain("谐音");
});

test("legacy 对照译文 cache is not reused", () => {
  expect(
    reusableCachedCoach(
      JSON.stringify({
        english: "Hi",
        better: "",
        note: "对照译文。配 DeepSeek / 混元 / custom 可看记忆技巧。",
      }),
    ),
  ).toBeUndefined();
});

test("custom-only coach failure never calls Google", async () => {
  const hosts: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    hosts.push(new URL(url).host);
    return jsonResponse("not-json");
  }) as typeof fetch;

  await expect(
    coachChinesePrompt("能不能也把提问译成英文？", {
      ...cfg,
      fallback1: "off",
      fallback2: "off",
    }),
  ).rejects.toThrow(/failed: not JSON|learn failed/);
  expect(hosts).toEqual(["custom.test"]);
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
  expect(calls).toBe(1);
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
  expect(calls).toBe(1);
});

test("all customs failing falls through to the next stage", async () => {
  const multi: PluginConfig = {
    ...cfg,
    fallback1: "google",
    fallback2: "off",
    customs: [
      { alias: "a", apiKey: "k1", baseUrl: "https://a.test/v1", model: "m1" },
      { alias: "b", apiKey: "k2", baseUrl: "https://b.test/v1", model: "m2" },
    ],
  };
  const hosts: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    hosts.push(new URL(url).host);
    if (url.includes("googleapis.com")) {
      return new Response(JSON.stringify([[["先检查 git status。", "Need git status first."]]]), { status: 200 });
    }
    return new Response("nope", { status: 500 });
  }) as typeof fetch;

  const pairs = await translateParagraphs(["Need git status first."], multi);
  expect(pairs[0]?.zh).toBe("先检查 git status。");
  expect(pairs[0]?.alias).toBe("google");
  expect(hosts.filter((h) => h.includes("a.test") || h.includes("b.test")).length).toBe(2);
  expect(hosts.some((h) => h.includes("googleapis.com"))).toBe(true);
});

test("translationSuffix is display-only", () => {
  expect(translationSuffix("b.ai", 320)).toBe(" · b.ai 320ms");
  expect(translationSuffix()).toBe("");
  expect(translationSuffix("b.ai")).toBe("");
});
