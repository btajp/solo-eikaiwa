import { describe, expect, test } from "bun:test";
import { rovingTargetIndex } from "./roving-focus";

describe("rovingTargetIndex", () => {
  test("左右矢印で前後へ移動し、端では折り返す", () => {
    expect(rovingTargetIndex("ArrowRight", 0, 4)).toBe(1);
    expect(rovingTargetIndex("ArrowRight", 3, 4)).toBe(0);
    expect(rovingTargetIndex("ArrowLeft", 2, 4)).toBe(1);
    expect(rovingTargetIndex("ArrowLeft", 0, 4)).toBe(3);
  });

  test("Home / End は両端へ移動する", () => {
    expect(rovingTargetIndex("Home", 2, 4)).toBe(0);
    expect(rovingTargetIndex("End", 1, 4)).toBe(3);
  });

  test("radiogroup（both）は上下矢印も前後移動になる", () => {
    expect(rovingTargetIndex("ArrowDown", 0, 2, "both")).toBe(1);
    expect(rovingTargetIndex("ArrowUp", 0, 2, "both")).toBe(1);
  });

  test("横向き tablist（horizontal）は上下矢印に反応しない", () => {
    expect(rovingTargetIndex("ArrowDown", 0, 4, "horizontal")).toBeNull();
    expect(rovingTargetIndex("ArrowUp", 2, 4, "horizontal")).toBeNull();
  });

  test("対象外のキー・不正な現在位置は null（既定動作を妨げない）", () => {
    expect(rovingTargetIndex("Tab", 0, 4)).toBeNull();
    expect(rovingTargetIndex("Enter", 0, 4)).toBeNull();
    expect(rovingTargetIndex("a", 0, 4)).toBeNull();
    expect(rovingTargetIndex("ArrowRight", -1, 4)).toBeNull();
    expect(rovingTargetIndex("ArrowRight", 4, 4)).toBeNull();
    expect(rovingTargetIndex("ArrowRight", 0, 0)).toBeNull();
  });
});
