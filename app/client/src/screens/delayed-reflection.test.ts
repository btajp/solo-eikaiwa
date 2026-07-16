import { describe, expect, test } from "bun:test";
import {
  DELAYED_REFLECTION_MAX_FIXES,
  canOfferDelayedReflection,
  limitDelayedReflectionFixes,
  shouldOfferQuickSessionReflection,
} from "./delayed-reflection";

describe("自由会話の遅延訂正ループの表示タイミング (#179)", () => {
  test("会話の途中（終了の明示操作前）は振り返り導線を出さない", () => {
    expect(canOfferDelayedReflection(false, 3)).toBe(false);
  });

  test("利用者が練習終了を明示し、自分の発話が1回以上あれば任意導線を出す", () => {
    expect(canOfferDelayedReflection(true, 1)).toBe(true);
    expect(canOfferDelayedReflection(true, 5)).toBe(true);
  });

  test("自分の発話がゼロなら訂正材料がないため導線を出さない", () => {
    expect(canOfferDelayedReflection(true, 0)).toBe(false);
  });
});

describe("クイックドリル終了画面の遅延訂正ループの表示タイミング (#179)", () => {
  test("クイック・ロールプレイの完了後だけ任意導線を出す", () => {
    expect(shouldOfferQuickSessionReflection({ type: "quick", drill: "roleplay" }, true)).toBe(true);
  });

  test("完了前は出さない", () => {
    expect(shouldOfferQuickSessionReflection({ type: "quick", drill: "roleplay" }, false)).toBe(false);
  });

  test("会話を伴わないクイックドリルには出さない", () => {
    expect(shouldOfferQuickSessionReflection({ type: "quick", drill: "warmup" }, true)).toBe(false);
    expect(shouldOfferQuickSessionReflection({ type: "quick", drill: "shadowing" }, true)).toBe(false);
    expect(shouldOfferQuickSessionReflection({ type: "quick", drill: "ftt-mini" }, true)).toBe(false);
  });

  test("通しセッションには専用の振り返りブロックがあるため出さない", () => {
    expect(shouldOfferQuickSessionReflection({ type: "daily" }, true)).toBe(false);
  });
});

describe("遅延訂正の提示件数 (#179)", () => {
  test("訂正は最大3件に制限される", () => {
    expect(DELAYED_REFLECTION_MAX_FIXES).toBe(3);
    const five = [1, 2, 3, 4, 5].map((n) => ({ original: `o${n}`, better: `b${n}` }));
    expect(limitDelayedReflectionFixes(five)).toHaveLength(3);
    expect(limitDelayedReflectionFixes(five).map((f) => f.original)).toEqual(["o1", "o2", "o3"]);
  });

  test("3件以下ならそのまま返す", () => {
    const two = [{ original: "a", better: "b" }, { original: "c", better: "d" }];
    expect(limitDelayedReflectionFixes(two)).toEqual(two);
    expect(limitDelayedReflectionFixes([])).toEqual([]);
  });
});
