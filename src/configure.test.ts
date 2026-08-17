import { expect, test } from "bun:test";
import { maskSecret } from "./configure.ts";

test("maskSecret hides the middle of a key", () => {
  expect(maskSecret("sk-cb4w0pxs0rn7gmoq0u3uu5vryfs5kuqe")).toBe("sk-c***kuqe");
  expect(maskSecret("abcd1234")).toBe("ab***4");
  expect(maskSecret("")).toBe("");
});
