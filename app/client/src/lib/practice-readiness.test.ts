import { describe, expect, test } from "bun:test";
import {
  canStartRecordingPractice,
  missingPracticeCapabilities,
  RECORDING_PRACTICE_CAPABILITIES,
  startSelectionNeedsRecordingReadiness,
} from "./practice-readiness";

describe("recording practice readiness", () => {
  test.each([
    [{ modelFile: true, llmReady: true }, []],
    [{ modelFile: false, llmReady: true }, ["stt"]],
    [{ modelFile: true, llmReady: false }, ["llm"]],
    [{ modelFile: false, llmReady: false }, ["stt", "llm"]],
  ] as const)("modelFile=%o, llmReady=%o の不足要件を返す", (health, expected) => {
    expect(missingPracticeCapabilities(health)).toEqual([...expected]);
    expect(canStartRecordingPractice(health)).toBe(expected.length === 0);
  });

  test("health未取得と旧サーバの欠損項目は既存フローを阻害しない", () => {
    expect(missingPracticeCapabilities(null)).toEqual([]);
    expect(missingPracticeCapabilities({})).toEqual([]);
    expect(canStartRecordingPractice(null)).toBe(true);
  });

  test("必要能力を限定して確認できる", () => {
    expect(missingPracticeCapabilities({ modelFile: false, llmReady: false }, ["stt"])).toEqual(["stt"]);
    expect(RECORDING_PRACTICE_CAPABILITIES).toEqual(["stt", "llm"]);
  });

  test.each([
    [{ type: "free" }, true],
    [{ type: "placement" }, true],
    [{ type: "session", source: { type: "quick", drill: "ftt-mini" } }, true],
    [{ type: "session", source: { type: "quick", drill: "roleplay" } }, true],
    [{ type: "session", source: { type: "quick", drill: "warmup" } }, false],
    [{ type: "session", source: { type: "quick", drill: "shadowing" } }, false],
    [{ type: "session", source: { type: "daily" } }, false],
    [{ type: "library" }, false],
  ] as const)("開始CTA %o の録音準備確認=%s", (selection, expected) => {
    expect(startSelectionNeedsRecordingReadiness(selection)).toBe(expected);
  });
});
