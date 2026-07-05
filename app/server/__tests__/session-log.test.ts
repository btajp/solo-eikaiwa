import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, readEvents, type SessionEvent } from "../session-log";

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
