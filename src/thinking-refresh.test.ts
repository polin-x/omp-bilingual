import { expect, test } from "bun:test";
import { attachThinkingTranslation, bindThinkingRefresh } from "./thinking-refresh.ts";



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

test("a later thinkingIndex 0 does not inherit an earlier blob translation", () => {
  const blobEn =
    "There's a recent omp blob: `/Users/polin/.omp/agent/blobs/e848f650c973c9af8042ef7d8069954b73bb7dfe4d3b494498cd56673791e1bb.jpg` from 0 seconds ago - that might be the user's image!";
  const blobZh =
    "有一个最近的 omp blob : /Users/polin/.omp/agent/blobs/e848f650c973c9af8042ef7d8069954b73bb7dfe4d3b494498cd56673791e1bb.jpg, 来自 0 秒前—那可能是用户的图片！";
  const cache = new Map<string, string>([[blobEn, blobZh]]);
  const created: Array<{ zh: string; setZh: (zh: string) => void }> = [];
  const createView = () => {
    const view = {
      zh: "stale",
      setZh(zh: string) {
        this.zh = zh;
      },
    };
    created.push(view);
    return view;
  };
  const render = (text: string) =>
    attachThinkingTranslation({
      text,
      createView,
      cachedZh: (en) => cache.get(en),
      stampFor: () => undefined,
      requestRender: () => {},
    });
  const first = render(blobEn);
  const second = render("This includes both expiry reload and TTL countdown. Commit and push.");
  const third = render("commit push");
  expect(created).toHaveLength(3);
  expect(second?.view).not.toBe(first?.view);
  expect(third?.view).not.toBe(first?.view);
  expect(first?.view.zh).toBe(blobZh);
  expect(second?.view.zh).toBe("");
  expect(third?.view.zh).toBe("");
});




