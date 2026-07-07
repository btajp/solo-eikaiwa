import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_SUPPORT, loadSupport, resolveSupport } from "./support";

function stubStorage(value: string | null): void {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => value, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
  } as Storage;
}
afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

describe("resolveSupport", () => {
  test("override が非nullなら preset/既定より優先される", () => {
    expect(resolveSupport(true, "less", false)).toBe(true);
    expect(resolveSupport(false, "more", true)).toBe(false);
  });
  test("override が null: more は常にオン、less は常にオフ", () => {
    expect(resolveSupport(null, "more", false)).toBe(true);
    expect(resolveSupport(null, "less", true)).toBe(false);
  });
  test("override が null かつ auto なら stage 既定（autoDefault）に従う", () => {
    expect(resolveSupport(null, "auto", true)).toBe(true);
    expect(resolveSupport(null, "auto", false)).toBe(false);
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
  test("未知の preset / 不正 toggle は既定に丸め、妥当値は保持する", () => {
    stubStorage(JSON.stringify({ preset: "bogus", jaHint: "yes", modelTalk: true, cloze: false }));
    expect(loadSupport()).toEqual({ preset: "auto", jaHint: null, modelTalk: true, cloze: false });
  });
});
