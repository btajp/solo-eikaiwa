import { describe, expect, test } from "bun:test";
import { canShowFreeTalkReaction } from "./practice-reaction";

describe("自由会話後の感想導線", () => {
  test("最初の一往復だけでは会話途中の感想入力を出さない", () => {
    expect(canShowFreeTalkReaction(2, false)).toBe(false);
  });

  test("利用者が練習完了を選ぶと一往復以上の感想を出す", () => {
    expect(canShowFreeTalkReaction(2, true)).toBe(true);
  });
});
