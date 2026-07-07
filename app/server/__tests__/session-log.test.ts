import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, fttOutputSignals, listPracticeDays, readEvents, type SessionEvent } from "../session-log";

describe("session-log", () => {
  test("appendEvent は1行1JSONで追記し readEvents で復元できる", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sess-"));
    const file = path.join(dir, "2026-07-05.jsonl");
    const e1: SessionEvent = { ts: "2026-07-05T09:00:00.000Z", type: "session_start", sessionId: "s1" };
    const e2: SessionEvent = { ts: "2026-07-05T09:00:05.000Z", type: "user_utterance", sessionId: "s1", text: "hello" };
    appendEvent(file, e1);
    appendEvent(file, e2);
    const events = readEvents(file);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("session_start");
    expect(events[1].text).toBe("hello");
  });

  test("readEvents は存在しないファイルで空配列を返す", () => {
    expect(readEvents("/nonexistent/nope.jsonl")).toEqual([]);
  });

  test("readEvents は不正な行をスキップして残りを返す（クラッシュ耐性）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sess-"));
    const file = path.join(dir, "log.jsonl");
    const good1 = JSON.stringify({ ts: "t1", type: "session_start", sessionId: "s1" });
    const good2 = JSON.stringify({ ts: "t2", type: "user_utterance", sessionId: "s1", text: "hi" });
    writeFileSync(file, `${good1}\n{truncated...\n${good2}\n`, "utf8");
    const events = readEvents(file);
    expect(events).toHaveLength(2);
    expect(events[1].text).toBe("hi");
  });
});

describe("listPracticeDays", () => {
  test("YYYY-MM-DD.jsonl のみを昇順で返す（拡張子なし）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "days-"));
    writeFileSync(path.join(dir, "2026-07-03.jsonl"), "");
    writeFileSync(path.join(dir, "2026-07-01.jsonl"), "");
    writeFileSync(path.join(dir, "notes.txt"), "");
    writeFileSync(path.join(dir, "bad-name.jsonl"), "");
    expect(listPracticeDays(dir)).toEqual(["2026-07-01", "2026-07-03"]);
  });

  test("ディレクトリが無ければ空配列", () => {
    expect(listPracticeDays("/nonexistent/nope")).toEqual([]);
  });
});

describe("session-log: 日付形式の互換性", () => {
  test("listPracticeDays は旧UTC名・新ローカル名のファイルを区別なく列挙する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sessions-"));
    // 移行前（UTC名）と移行後（ローカル名）が混在しても、パターン一致で両方拾える
    writeFileSync(path.join(dir, "2026-07-05.jsonl"), "");
    writeFileSync(path.join(dir, "2026-07-06.jsonl"), "");
    writeFileSync(path.join(dir, "not-a-log.txt"), "");
    expect(listPracticeDays(dir)).toEqual(["2026-07-05", "2026-07-06"]);
  });
});

describe("fttOutputSignals", () => {
  test("engagedかつ低語数のみ lowRounds に数える（block一致・elapsed/語数で判定）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sig-"));
    const file = path.join(dir, "2026-07-06.jsonl");
    const ev = (meta: Record<string, unknown>) =>
      appendEvent(file, { ts: "2026-07-06T09:00:00Z", type: "round_end", sessionId: "s", meta });
    ev({ block: "four-three-two", elapsedSec: 40, transcript: "well um yeah" });     // 3語 → low
    ev({ block: "four-three-two", elapsedSec: 40, transcript: "I think we should ship the feature today because it is ready" }); // 12語 → not low
    ev({ block: "four-three-two", elapsedSec: 5, transcript: "no" });                // engaged未満 → 数えるが low ではない
    ev({ block: "roleplay", elapsedSec: 40, transcript: "hi" });                     // 別block → 無視
    const r = fttOutputSignals("2026-07-06", 7, dir);
    expect(r.totalRounds).toBe(3); // four-three-two の3件
    expect(r.lowRounds).toBe(1);   // 1件目のみ
  });

  test("ログが無い日は 0/0", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sig-"));
    expect(fttOutputSignals("2026-07-06", 7, dir)).toEqual({ lowRounds: 0, totalRounds: 0 });
  });
});
