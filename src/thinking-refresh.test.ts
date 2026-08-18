import { expect, test } from "bun:test";
import { bindThinkingRefresh } from "./thinking-refresh.ts";

test("refresh writes cache onto the existing view after late translate", () => {
  const cache = new Map<string, string>();
  let stamp: { alias: string; delayMs: number } | undefined;
  let renders = 0;
  const view = {
    zh: "",
    stamp: undefined as { alias: string; delayMs: number } | undefined,
    setZh(zh: string, next?: { alias: string; delayMs: number }) {
      this.zh = zh;
      this.stamp = next;
    },
  };
  const refresh = bindThinkingRefresh({
    view,
    paras: ["Need git status first."],
    cachedZh: (en) => cache.get(en),
    stampFor: () => stamp,
    requestRender: () => {
      renders += 1;
    },
  });

  refresh();
  expect(view.zh).toBe("");
  expect(renders).toBe(1);

  cache.set("Need git status first.", "先检查 git status。");
  stamp = { alias: "b.ai", delayMs: 40 };
  refresh();
  expect(view.zh).toBe("先检查 git status。");
  expect(view.stamp).toEqual({ alias: "b.ai", delayMs: 40 });
  expect(renders).toBe(2);
});
