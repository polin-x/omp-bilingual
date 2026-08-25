import { expect, test } from "bun:test";
import { bindThinkingRefresh, rememberThinkingView } from "./thinking-refresh.ts";

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

test("refresh keeps one translation when the same paragraph is repeated", () => {
  const en =
    "Need to verify CertificateEnrollment.ensureLocalNetworkProfile wasn't duplicated by the auto-repair. Also writeAndOpen should use openExisting. Update tests. Check controller rest of function still ha...";
  const zh =
    "需要验证自动修复没有重复 CertificateEnrollment.ensureLocalNetworkProfile。另外 writeAndOpen 应该使用 openExisting。更新测试。检查控制器其余函数是否仍然 ...";
  const view = {
    zh: "",
    setZh(next: string) {
      this.zh = next;
    },
  };
  bindThinkingRefresh({
    view,
    paras: [en, en, en, en, en],
    cachedZh: (text) => (text === en ? zh : undefined),
    stampFor: () => undefined,
    requestRender: () => {},
  })();
  expect(view.zh).toBe(zh);
  expect(view.zh.split("\n\n")).toEqual([zh]);
});

test("rememberThinkingView returns the same instance for a thinkingIndex", () => {
  const views = new Map<number, { id: number }>();
  let created = 0;
  const first = rememberThinkingView(views, 0, () => ({ id: ++created }));
  const again = rememberThinkingView(views, 0, () => ({ id: ++created }));
  const other = rememberThinkingView(views, 1, () => ({ id: ++created }));
  expect(again).toBe(first);
  expect(other).not.toBe(first);
  expect(created).toBe(2);
  views.clear();
  const nextMessage = rememberThinkingView(views, 0, () => ({ id: ++created }));
  expect(nextMessage).not.toBe(first);
});


