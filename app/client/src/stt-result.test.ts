import { describe, expect, test } from "bun:test";
import { resolveSttOutcome } from "./stt-result";

const RECORDING_SCREENS = ["free-talk", "placement", "four-three-two"] as const;

for (const screen of RECORDING_SCREENS) {
  describe(`${screen} のSTT結果`, () => {
    test("空文字は再録音できる技術失敗として分類する", async () => {
      expect(await resolveSttOutcome(async () => " \n ")).toEqual({ kind: "empty" });
    });

    test("発話文字列は前後の空白を除いて成功として分類する", async () => {
      expect(await resolveSttOutcome(async () => "  I explained the problem.  ")).toEqual({
        kind: "success",
        text: "I explained the problem.",
      });
    });

    test("通信例外は技術失敗として呼び出し側へ渡す", async () => {
      const failure = new Error("STT unavailable");
      const outcome = await resolveSttOutcome(async () => { throw failure; });
      expect(outcome).toEqual({ kind: "error", error: failure });
    });
  });
}
