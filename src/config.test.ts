import { expect, test } from "bun:test";
import { configFromObject } from "./config.ts";

test("migrates legacy single custom fields", () => {
  const cfg = configFromObject({
    backend: "custom",
    customAlias: "b.ai",
    customApiKey: "k",
    customBaseUrl: "https://b.ai/v1",
    customModel: "flash",
  });
  expect(cfg.customs).toEqual([{ alias: "b.ai", apiKey: "k", baseUrl: "https://b.ai/v1", model: "flash" }]);
});

test("prefers customs array over legacy fields", () => {
  const cfg = configFromObject({
    customAlias: "old",
    customApiKey: "old-k",
    customBaseUrl: "https://old.test/v1",
    customModel: "old-m",
    customs: [
      { alias: "a", apiKey: "k1", baseUrl: "https://a.test/v1", model: "m1" },
      { alias: "b", apiKey: "k2", baseUrl: "https://b.test/v1", model: "m2" },
    ],
  });
  expect(cfg.customs.map((c) => c.alias)).toEqual(["a", "b"]);
});
