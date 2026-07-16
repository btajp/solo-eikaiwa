import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendEvent, fttOutputSignals, listPracticeDays, readEvents, readSessionEvents,
  SESSION_INDEX_FILE, type SessionEvent,
} from "../session-log";

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
    const activity = JSON.stringify({ ts: "t", type: "user_utterance", sessionId: "s", text: "hi" }) + "\n";
    writeFileSync(path.join(dir, "2026-07-03.jsonl"), activity);
    writeFileSync(path.join(dir, "2026-07-01.jsonl"), activity);
    writeFileSync(path.join(dir, "notes.txt"), "");
    writeFileSync(path.join(dir, "bad-name.jsonl"), "");
    expect(listPracticeDays(dir)).toEqual(["2026-07-01", "2026-07-03"]);
  });

  test("ディレクトリが無ければ空配列", () => {
    expect(listPracticeDays("/nonexistent/nope")).toEqual([]);
  });

  test("起動・閲覧だけの日を除外し、発話または明示完了がある日だけ返す", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "days-activity-"));
    const write = (ymd: string, events: SessionEvent[]) => writeFileSync(
      path.join(dir, `${ymd}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    write("2026-07-01", [
      { ts: "t", type: "session_start", sessionId: "open-only" },
      { ts: "t", type: "session_end", sessionId: "open-only" },
    ]);
    write("2026-07-02", [
      { ts: "t", type: "block_end", sessionId: "aborted", meta: { aborted: true } },
    ]);
    write("2026-07-03", [
      { ts: "t", type: "user_utterance", sessionId: "spoken", text: "hello" },
    ]);
    write("2026-07-04", [
      { ts: "t", type: "block_end", sessionId: "completed", meta: { kind: "reflection" } },
    ]);
    expect(listPracticeDays(dir)).toEqual(["2026-07-03", "2026-07-04"]);
  });
});

describe("readSessionEvents", () => {
  test("同日別sessionを除外し、日付境界を跨いだ対象sessionを時刻順で返す", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "session-window-"));
    writeFileSync(path.join(dir, "2026-07-01.jsonl"), [
      { ts: "2026-07-01T23:59:50.000Z", type: "user_utterance", sessionId: "target", text: "before midnight" },
      { ts: "2026-07-01T23:59:55.000Z", type: "user_utterance", sessionId: "other", text: "other tab" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(path.join(dir, "2026-07-02.jsonl"), [
      { ts: "2026-07-02T00:00:10.000Z", type: "user_utterance", sessionId: "target", text: "after midnight" },
      { ts: "2026-07-02T00:00:05.000Z", type: "assistant_reply", sessionId: "target", text: "reply" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");

    expect(readSessionEvents("target", dir).map((e) => e.text)).toEqual([
      "before midnight", "reply", "after midnight",
    ]);
  });
});

describe("session-log: 日付形式の互換性", () => {
  test("listPracticeDays は旧UTC名・新ローカル名のファイルを区別なく列挙する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sessions-"));
    // 移行前（UTC名）と移行後（ローカル名）が混在しても、パターン一致で両方拾える
    const activity = JSON.stringify({ ts: "t", type: "block_end", sessionId: "s", meta: {} }) + "\n";
    writeFileSync(path.join(dir, "2026-07-05.jsonl"), activity);
    writeFileSync(path.join(dir, "2026-07-06.jsonl"), activity);
    writeFileSync(path.join(dir, "not-a-log.txt"), "");
    expect(listPracticeDays(dir)).toEqual(["2026-07-05", "2026-07-06"]);
  });
});

describe("session-log: 永続インデックス（#205 全履歴フルスキャン回避）", () => {
  // サイズ・mtimeを保ったまま内容だけ差し替える観測手法:
  // インデックスが使われていれば（=ファイルを読み直していなければ）結果は差し替え前のまま変わらない。
  const FIXED_MTIME = new Date("2026-07-01T12:00:00Z"); // 秒単位に丸めた固定mtime（fsのmtime精度差の影響を避ける）

  const practiceLine = JSON.stringify({
    ts: "t", type: "user_utterance", sessionId: "s1", text: "practice practice practice",
  }) + "\n";

  /** practiceLine と同一バイト長の非practice行（session_start）を作る */
  function sameLengthNonPracticeLine(): string {
    const mk = (pad: string) => JSON.stringify({ ts: "t", type: "session_start", sessionId: "s1", text: pad }) + "\n";
    const pad = "x".repeat(Buffer.byteLength(practiceLine, "utf8") - Buffer.byteLength(mk(""), "utf8"));
    const line = mk(pad);
    expect(Buffer.byteLength(line, "utf8")).toBe(Buffer.byteLength(practiceLine, "utf8"));
    return line;
  }

  test("listPracticeDays: サイズ・mtime不変の既知ファイルは再読せずインデックスの判定を使う", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idx-days-"));
    const file = path.join(dir, "2026-07-01.jsonl");
    writeFileSync(file, practiceLine);
    utimesSync(file, FIXED_MTIME, FIXED_MTIME);
    expect(listPracticeDays(dir)).toEqual(["2026-07-01"]);

    // 内容だけ非practiceへ差し替え（サイズ・mtimeは同一）→ インデックス利用なら結果は変わらない
    writeFileSync(file, sameLengthNonPracticeLine());
    utimesSync(file, FIXED_MTIME, FIXED_MTIME);
    expect(listPracticeDays(dir)).toEqual(["2026-07-01"]);
  });

  test("listPracticeDays: 追記でサイズが変わったファイルは再判定する（当日ファイルの追記を反映）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idx-days-append-"));
    const file = path.join(dir, "2026-07-02.jsonl");
    writeFileSync(file, JSON.stringify({ ts: "t", type: "session_start", sessionId: "s1" }) + "\n");
    expect(listPracticeDays(dir)).toEqual([]);
    appendEvent(file, { ts: "t", type: "user_utterance", sessionId: "s1", text: "hi" });
    expect(listPracticeDays(dir)).toEqual(["2026-07-02"]);
  });

  test("listPracticeDays: インデックス作成後に増えた新しい日のファイルも反映する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idx-days-new-"));
    writeFileSync(path.join(dir, "2026-07-01.jsonl"), practiceLine);
    expect(listPracticeDays(dir)).toEqual(["2026-07-01"]);
    writeFileSync(path.join(dir, "2026-07-02.jsonl"), practiceLine);
    expect(listPracticeDays(dir)).toEqual(["2026-07-01", "2026-07-02"]);
  });

  test("インデックスファイルが壊れていても全再走査で正しく動き、練習日一覧にも現れない", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idx-broken-"));
    writeFileSync(path.join(dir, "2026-07-01.jsonl"), practiceLine);
    expect(listPracticeDays(dir)).toEqual(["2026-07-01"]);
    writeFileSync(path.join(dir, SESSION_INDEX_FILE), "{broken json");
    expect(listPracticeDays(dir)).toEqual(["2026-07-01"]);
    expect(readSessionEvents("s1", dir)).toHaveLength(1);
  });

  test("readSessionEvents: 対象sessionを含まない不変ファイルはインデックスで読み飛ばす", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idx-session-"));
    const mkLine = (sessionId: string, text: string) =>
      JSON.stringify({ ts: "2026-07-02T00:00:00.000Z", type: "user_utterance", sessionId, text }) + "\n";
    writeFileSync(path.join(dir, "2026-07-01.jsonl"), mkLine("target", "mine"));
    const day2 = path.join(dir, "2026-07-02.jsonl");
    const otherLine = mkLine("other!", "aaaaaa");
    writeFileSync(day2, otherLine);
    utimesSync(day2, FIXED_MTIME, FIXED_MTIME);
    expect(readSessionEvents("target", dir).map((e) => e.text)).toEqual(["mine"]);

    // 同一バイト長で対象sessionのイベントへ差し替え（サイズ・mtime同一）→ 読み飛ばされていれば現れない
    const injected = mkLine("target", "bbbbbb");
    expect(Buffer.byteLength(injected, "utf8")).toBe(Buffer.byteLength(otherLine, "utf8"));
    writeFileSync(day2, injected);
    utimesSync(day2, FIXED_MTIME, FIXED_MTIME);
    expect(readSessionEvents("target", dir).map((e) => e.text)).toEqual(["mine"]);
  });

  test("readSessionEvents: インデックス作成後の追記・新規日ファイルの対象イベントも反映する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idx-session-append-"));
    const day1 = path.join(dir, "2026-07-01.jsonl");
    appendEvent(day1, { ts: "2026-07-01T23:00:00.000Z", type: "user_utterance", sessionId: "target", text: "first" });
    expect(readSessionEvents("target", dir).map((e) => e.text)).toEqual(["first"]);

    appendEvent(day1, { ts: "2026-07-01T23:30:00.000Z", type: "assistant_reply", sessionId: "target", text: "second" });
    const day2 = path.join(dir, "2026-07-02.jsonl");
    appendEvent(day2, { ts: "2026-07-02T00:10:00.000Z", type: "user_utterance", sessionId: "target", text: "third" });
    expect(readSessionEvents("target", dir).map((e) => e.text)).toEqual(["first", "second", "third"]);
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

  test("sttFailed:trueのround_endはtotalRounds/lowRoundsどちらにも数えない（技術障害を英語力シグナルにしない）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sig-stt-"));
    const file = path.join(dir, "2026-07-06.jsonl");
    const ev = (meta: Record<string, unknown>) =>
      appendEvent(file, { ts: "2026-07-06T09:00:00Z", type: "round_end", sessionId: "s", meta });
    ev({ block: "four-three-two", elapsedSec: 40, transcript: "", sttFailed: true }); // STT失敗 → 観測対象外
    ev({ block: "four-three-two", elapsedSec: 40, transcript: "well um yeah" });      // 3語・sttFailedなし → low
    const r = fttOutputSignals("2026-07-06", 7, dir);
    expect(r.totalRounds).toBe(1);
    expect(r.lowRounds).toBe(1);
  });
});
