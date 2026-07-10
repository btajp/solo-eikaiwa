import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../db";
import { makeMetricsSummary } from "../metrics-aggregate";

function writeDay(dir: string, ymd: string, lines: unknown[]): void {
  writeFileSync(path.join(dir, `${ymd}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const M1 = { words: 10, totalMs: 6000, speechMs: 5000, speechRateWpm: 100, articulationRateWpm: 120, pauses: { count: 1, totalMs: 1000, longestMs: 1000 }, repetitionRatio: 0.1 };
const M2 = { words: 20, totalMs: 12000, speechMs: 10000, speechRateWpm: 100, articulationRateWpm: 120, pauses: { count: 2, totalMs: 2000, longestMs: 1500 }, repetitionRatio: 0.4 };

describe("metrics-aggregate", () => {
  test("stt_result を日別に加重集計し、metrics無しイベントはスキップする", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ma-"));
    writeDay(dir, "2026-07-05", [
      { ts: "t", type: "stt_result", sessionId: "stt", text: "a", meta: { metrics: M1 } },
      { ts: "t", type: "stt_result", sessionId: "stt", text: "b", meta: { metrics: M2 } },
      { ts: "t", type: "user_utterance", sessionId: "x", text: "旧イベント" },   // 対象外type
      { ts: "t", type: "stt_result", sessionId: "stt", text: "c" },              // metrics無し（旧形式）
    ]);
    const summary = makeMetricsSummary({ db: openDb(":memory:"), sessionsDir: dir, currentLevel: () => 13 })(2, "2026-07-06");
    expect(summary.days).toHaveLength(2);
    const d5 = summary.days[0];
    expect(d5.ymd).toBe("2026-07-05");
    expect(d5.utterances).toBe(2);
    // speechMs計 15000 → 15秒 / words計 30 → 30/(15000/60000) = 120 wpm
    expect(d5.speakingSec).toBe(15);
    expect(d5.avgArticulationWpm).toBe(120);
    // pause計 3000 / total計 18000 = 0.167
    expect(d5.avgPauseRatio).toBe(0.167);
    // 語数加重: (0.1*10 + 0.4*20)/30 = 0.3
    expect(d5.repetitionRatio).toBe(0.3);
    expect(d5).toMatchObject({
      words: 30,
      speechMs: 15_000,
      totalMs: 18_000,
      pauseMs: 3_000,
      repetitionWords: 30,
      repetitionWeightedWords: 9,
    });
    // ログの無い日はゼロ行
    const d6 = summary.days[1];
    expect(d6).toEqual({
      ymd: "2026-07-06", utterances: 0, words: 0, speechMs: 0, totalMs: 0, pauseMs: 0,
      repetitionWords: 0, repetitionWeightedWords: 0, speakingSec: 0,
      avgArticulationWpm: 0, avgPauseRatio: 0, repetitionRatio: 0,
    });
  });

  test("指標別の分母が欠けたeventはその率だけから除外する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ma-missing-"));
    writeDay(dir, "2026-07-06", [
      { ts: "t1", type: "stt_result", sessionId: "s", meta: { metrics: M1 } },
      {
        ts: "t2", type: "stt_result", sessionId: "s",
        meta: { metrics: { words: 10, speechMs: 5_000, totalMs: 5_000 } },
      },
    ]);
    const day = makeMetricsSummary({ db: openDb(":memory:"), sessionsDir: dir, currentLevel: () => 13 })(1, "2026-07-06").days[0];
    expect(day.utterances).toBe(2);
    expect(day.avgPauseRatio).toBe(0.167);
    expect(day.repetitionRatio).toBe(0.1);
  });

  test("週次値は日別率の再平均ではなくraw分子・分母の和から計算する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ma-week-"));
    const small = {
      words: 1, totalMs: 1_000, speechMs: 600, speechRateWpm: 60, articulationRateWpm: 100,
      pauses: { count: 1, totalMs: 1_000, longestMs: 1_000 }, repetitionRatio: 1,
    };
    const large = {
      words: 100, totalMs: 100_000, speechMs: 60_000, speechRateWpm: 60, articulationRateWpm: 100,
      pauses: { count: 0, totalMs: 0, longestMs: 0 }, repetitionRatio: 0,
    };
    writeDay(dir, "2026-06-30", [
      { ts: "t1", type: "stt_result", sessionId: "s", meta: { metrics: small } },
    ]);
    writeDay(dir, "2026-06-29", [
      { ts: "t2", type: "stt_result", sessionId: "s", meta: { metrics: large } },
    ]);

    const summary = makeMetricsSummary({ db: openDb(":memory:"), sessionsDir: dir, currentLevel: () => 13 })(14, "2026-07-07");
    expect(summary.weekly.previous.utterances).toBe(2);
    expect(summary.weekly.previous.avgPauseRatio).toBe(0.01);
    expect(summary.weekly.previous.repetitionRatio).toBe(0.01);
    expect(summary.weekly.current).toMatchObject({ utterances: 0, avgPauseRatio: 0, repetitionRatio: 0 });
  });

  test("level history は level_events の日別最後の値", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO level_events (ts, ymd, kind, from_level, to_level) VALUES ('t','2026-07-05','manual-set',13,20)");
    db.run("INSERT INTO level_events (ts, ymd, kind, from_level, to_level) VALUES ('t','2026-07-05','manual-set',20,15)");
    db.run("INSERT INTO level_events (ts, ymd, kind, from_level, to_level) VALUES ('t','2026-07-06','accept-up',15,21)");
    const dir = mkdtempSync(path.join(tmpdir(), "ma-"));
    const summary = makeMetricsSummary({ db, sessionsDir: dir, currentLevel: () => 21 })(1, "2026-07-06");
    expect(summary.level.current).toBe(21);
    expect(summary.level.history).toEqual([
      { ymd: "2026-07-05", level: 15 },
      { ymd: "2026-07-06", level: 21 },
    ]);
  });

  test("level history は却下された提案（decline-*）のレベルを除外する", () => {
    const db = openDb(":memory:");
    // manual-set で 13 にセット
    db.run("INSERT INTO level_events (ts, ymd, kind, from_level, to_level) VALUES ('t','2026-07-05','manual-set',0,13)");
    // decline-up で 14 に却下（history に含めてはいけない）
    db.run("INSERT INTO level_events (ts, ymd, kind, from_level, to_level) VALUES ('t','2026-07-05','decline-up',13,14)");
    const dir = mkdtempSync(path.join(tmpdir(), "ma-"));
    const summary = makeMetricsSummary({ db, sessionsDir: dir, currentLevel: () => 13 })(1, "2026-07-05");
    expect(summary.level.current).toBe(13);
    expect(summary.level.history).toEqual([
      { ymd: "2026-07-05", level: 13 },
    ]);
  });
});
