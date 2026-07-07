import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_SUPPORT, loadSupport, resolveSupport } from "./support";

function stubStorage(value: string | null): void {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => value, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
  } as Storage;
}
afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

describe("resolveSupport", () => {
  test("override が非nullなら autoDefault より優先される", () => {
    expect(resolveSupport(true, false)).toBe(true);
    expect(resolveSupport(false, true)).toBe(false);
  });
  test("override が null なら autoDefault に従う", () => {
    expect(resolveSupport(null, true)).toBe(true);
    expect(resolveSupport(null, false)).toBe(false);
  });
});

describe("loadSupport", () => {
  test("保存値なしは全既定", () => {
    stubStorage(null);
    expect(loadSupport()).toEqual(DEFAULT_SUPPORT);
  });
  test("不正JSONは既定へフォールバックする", () => {
    stubStorage("{ not json");
    expect(loadSupport()).toEqual(DEFAULT_SUPPORT);
  });
  test("不正 toggle は既定に丸め、妥当値は保持する", () => {
    stubStorage(JSON.stringify({ jaHint: "yes", modelTalk: true, cloze: false }));
    expect(loadSupport()).toEqual({ jaHint: null, modelTalk: true, cloze: false });
  });
  test("旧バージョンの preset フィールドが残っていてもクラッシュせず個別フィールドが生きる", () => {
    stubStorage(JSON.stringify({ preset: "more", jaHint: true, modelTalk: null, cloze: false }));
    expect(loadSupport()).toEqual({ jaHint: true, modelTalk: null, cloze: false });
  });
});
