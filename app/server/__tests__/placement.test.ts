import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import {
  evaluatePlacement, makePlacementStore, PLACEMENT_TASKS, startLevelForStage,
  type PlacementSubmission,
} from "../placement";
import type { ClaudeRunner } from "../converse";

/** 固定テキストを返すフェイク runner（coach.test.ts と同じ流儀） */
function runnerReturning(text: string): ClaudeRunner {
  return async () => ({ text, sessionId: "fake" });
}

const SUBS: PlacementSubmission[] = PLACEMENT_TASKS.map((t) => ({
  taskId: t.id, transcript: "I work as an engineer and I like coffee.", durationSec: 30, wordCount: 9,
}));

describe("placement: タスク定義", () => {
  test("3タスク・id一意・durationSec正・instruction両言語・promptText非空", () => {
    expect(PLACEMENT_TASKS).toHaveLength(3);
    expect(new Set(PLACEMENT_TASKS.map((t) => t.id)).size).toBe(3);
    for (const t of PLACEMENT_TASKS) {
      expect(t.durationSec).toBeGreaterThan(0);
      expect(t.instructionEn.length).toBeGreaterThan(0);
      expect(t.instructionJa.length).toBeGreaterThan(0);
      expect(t.promptText.length).toBeGreaterThan(0);
    }
  });
});

describe("placement: startLevelForStage", () => {
  test("スペック§6.2: (stage-1)*10+3", () => {
    expect(startLevelForStage(1)).toBe(3);
    expect(startLevelForStage(2)).toBe(13);
    expect(startLevelForStage(6)).toBe(53);
  });
});

describe("placement: evaluatePlacement", () => {
  test("正常JSONを stage/startLevel/rationaleJa に整形する", async () => {
    const r = await evaluatePlacement(SUBS, runnerReturning('{"stage": 2, "rationaleJa": "簡単な文は言えます。過去形が不安定です。"}'));
    expect(r).toEqual({ stage: 2, startLevel: 13, rationaleJa: "簡単な文は言えます。過去形が不安定です。" });
  });

  test("```jsonフェンス付きでもパースできる", async () => {
    const r = await evaluatePlacement(SUBS, runnerReturning('```json\n{"stage": 4, "rationaleJa": "説明が滑らかです。"}\n```'));
    expect(r?.stage).toBe(4);
    expect(r?.startLevel).toBe(33);
  });

  test("stage が範囲外・非整数・欠落なら null", async () => {
    expect(await evaluatePlacement(SUBS, runnerReturning('{"stage": 0, "rationaleJa": "x"}'))).toBeNull();
    expect(await evaluatePlacement(SUBS, runnerReturning('{"stage": 7, "rationaleJa": "x"}'))).toBeNull();
    expect(await evaluatePlacement(SUBS, runnerReturning('{"stage": 2.5, "rationaleJa": "x"}'))).toBeNull();
    expect(await evaluatePlacement(SUBS, runnerReturning('{"rationaleJa": "x"}'))).toBeNull();
  });

  test("rationaleJa が欠落・空なら null / 非JSONテキストなら null", async () => {
    expect(await evaluatePlacement(SUBS, runnerReturning('{"stage": 2}'))).toBeNull();
    expect(await evaluatePlacement(SUBS, runnerReturning('{"stage": 2, "rationaleJa": "  "}'))).toBeNull();
    expect(await evaluatePlacement(SUBS, runnerReturning("I think stage 2 is right."))).toBeNull();
  });

  test("プロンプトに客観指標（語数・密度）と全transcriptが入る", async () => {
    let seen = "";
    const spy: ClaudeRunner = async (prompt) => { seen = prompt; return { text: '{"stage":2,"rationaleJa":"x"}', sessionId: "s" }; };
    await evaluatePlacement(SUBS, spy);
    expect(seen).toContain("9 words in 30s");
    expect(seen).toContain("0.30 words/sec");
    expect(seen).toContain("I work as an engineer");
    for (const t of PLACEMENT_TASKS) expect(seen).toContain(t.promptText);
  });

  test("signal を runner の opts.signal へ伝播する（#189）", async () => {
    const captured: Array<AbortSignal | undefined> = [];
    const spy: ClaudeRunner = async (_prompt, _resumeId, opts) => {
      captured.push(opts?.signal);
      return { text: '{"stage":2,"rationaleJa":"x"}', sessionId: "s" };
    };
    const ac = new AbortController();
    await evaluatePlacement(SUBS, spy, ac.signal);
    expect(captured[0]).toBe(ac.signal);
  });
});

describe("placement: store", () => {
  test("save → latest が保存内容を返す（空DBでは null）", () => {
    const db = openDb(":memory:");
    const store = makePlacementStore(db);
    expect(store.latest()).toBeNull();
    const saved = store.save({ stage: 3, startLevel: 23, rationale: "理由", metrics: [{ taskId: "self-intro", wordCount: 9, durationSec: 30, density: 0.3 }] });
    expect(saved.id).toBeGreaterThan(0);
    const latest = store.latest();
    expect(latest).toMatchObject({ stage: 3, startLevel: 23, rationale: "理由" });
    expect(latest!.ts.length).toBeGreaterThan(0);
  });

  test("複数保存で latest は最後の1件", () => {
    const db = openDb(":memory:");
    const store = makePlacementStore(db);
    store.save({ stage: 2, startLevel: 13, rationale: "a", metrics: [] });
    store.save({ stage: 3, startLevel: 23, rationale: "b", metrics: [] });
    expect(store.latest()!.stage).toBe(3);
  });
});
