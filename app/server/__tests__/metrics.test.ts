import { describe, expect, test } from "bun:test";
import { computeUtteranceMetrics } from "../metrics";

describe("metrics / computeUtteranceMetrics", () => {
  test("2セグメント: 速度・調音速度・ポーズを算出する", () => {
    // words=7, totalMs=4000, speechMs=2000+1500=3500
    // speechRate = 7/(4000/60000) = 105 wpm / articulation = 7/(3500/60000) = 120 wpm
    // gap = 2500-2000 = 500ms > 300 → pause 1件
    const m = computeUtteranceMetrics([
      { fromMs: 0, toMs: 2000, text: " I usually skip breakfast" },
      { fromMs: 2500, toMs: 4000, text: " and grab coffee" },
    ]);
    expect(m).toEqual({
      words: 7, totalMs: 4000, speechMs: 3500,
      speechRateWpm: 105, articulationRateWpm: 120,
      pauses: { count: 1, totalMs: 500, longestMs: 500 },
      repetitionRatio: 0,
    });
  });

  test("セグメント0件はすべてゼロ", () => {
    expect(computeUtteranceMetrics([])).toEqual({
      words: 0, totalMs: 0, speechMs: 0,
      speechRateWpm: 0, articulationRateWpm: 0,
      pauses: { count: 0, totalMs: 0, longestMs: 0 },
      repetitionRatio: 0,
    });
  });

  test("1セグメント: ポーズなし・速度=調音速度", () => {
    // words=3, ms=1500 → 3/(1500/60000) = 120
    const m = computeUtteranceMetrics([{ fromMs: 0, toMs: 1500, text: "Well I think" }]);
    expect(m.words).toBe(3);
    expect(m.speechRateWpm).toBe(120);
    expect(m.articulationRateWpm).toBe(120);
    expect(m.pauses).toEqual({ count: 0, totalMs: 0, longestMs: 0 });
  });

  test("ギャップ300ms丁度はポーズに数えない（>300が閾値）", () => {
    const m = computeUtteranceMetrics([
      { fromMs: 0, toMs: 1000, text: " I see" },
      { fromMs: 1300, toMs: 2000, text: " thanks a lot" },
    ]);
    expect(m.pauses.count).toBe(0);
  });

  test("隣接同一語の繰り返しを数える", () => {
    // tokens: i,i,want,to,to,say,say,it = 8語 / 隣接反復 3 (i-i, to-to, say-say)
    // bigram はすべて1回 → 余剰0。ratio = 3/8 = 0.375
    const m = computeUtteranceMetrics([{ fromMs: 0, toMs: 3000, text: "I I want to to say say it" }]);
    expect(m.repetitionRatio).toBe(0.375);
  });

  test("bigram の言い直しを数える", () => {
    // tokens: you,know,you,know = 4語 / 隣接反復0
    // bigram: "you know"×2(余剰1), "know you"×1 → ratio = 1/4 = 0.25
    const m = computeUtteranceMetrics([{ fromMs: 0, toMs: 2000, text: "you know you know" }]);
    expect(m.repetitionRatio).toBe(0.25);
  });

  test("縮約形は1語として数える", () => {
    // don't, it's → 2語
    const m = computeUtteranceMetrics([{ fromMs: 0, toMs: 1000, text: "don't it's" }]);
    expect(m.words).toBe(2);
  });

  test("回帰: 同じ10秒・7語でもASRのセグメント分割で調音速度・ポーズが変わる（推定値である根拠）", () => {
    // Issue #183 の再現例。指標はWhisperの区切り方に依存する推定値であり、
    // この分割依存性が変わる（＝真の測定になる）場合はUIの注記も見直すこと。
    const single = computeUtteranceMetrics([
      { fromMs: 0, toMs: 10_000, text: "I usually skip breakfast and grab coffee" },
    ]);
    const split = computeUtteranceMetrics([
      { fromMs: 0, toMs: 4_000, text: "I usually skip breakfast" },
      { fromMs: 6_000, toMs: 10_000, text: "and grab coffee" },
    ]);
    expect(single.words).toBe(7);
    expect(split.words).toBe(7);
    expect(single.totalMs).toBe(split.totalMs);
    // 1セグメント: 発話=総時間 → 42wpm・ポーズ0 / 2セグメント: 発話8秒 → 52.5wpm・ポーズ2秒
    expect(single.articulationRateWpm).toBe(42);
    expect(single.pauses).toEqual({ count: 0, totalMs: 0, longestMs: 0 });
    expect(split.articulationRateWpm).toBe(52.5);
    expect(split.pauses).toEqual({ count: 1, totalMs: 2_000, longestMs: 2_000 });
  });

  test("回帰: ポーズはセグメント間ギャップの合算で、節内・節末（考えるポーズ）を区別しない", () => {
    // Sun et al. 2023 では節内ポーズのみが知覚熟達度の負の予測子。現実装は区別できないため
    // 文中の詰まりも文間の考えるポーズも同じ1件として数える（限界はUI・docs/metrics.mdに明記）。
    const midClause = computeUtteranceMetrics([
      { fromMs: 0, toMs: 2_000, text: "I want to" },          // 文の途中で詰まる
      { fromMs: 3_000, toMs: 5_000, text: "say something" },
    ]);
    const clauseFinal = computeUtteranceMetrics([
      { fromMs: 0, toMs: 2_000, text: "I like coffee." },      // 文が終わってから考える
      { fromMs: 3_000, toMs: 5_000, text: "It helps me focus." },
    ]);
    expect(midClause.pauses).toEqual(clauseFinal.pauses);
  });
});
