import { describe, expect, test } from "bun:test";
import { resolveSupport } from "./support";

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
