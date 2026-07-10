import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../db";

function withFixture(run: (dbPath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "solo-eikaiwa-schema-"));
  try {
    run(path.join(dir, "fixture.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function captureOpenError(dbPath: string): Error {
  try {
    const opened = openDb(dbPath);
    opened.close();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("非互換スキーマを検出しませんでした");
}

describe("database schema contract", () => {
  test("互換性のある旧DBのデータを保ったまま不足テーブルを追加する", () => {
    withFixture((dbPath) => {
      const fixture = new Database(dbPath, { create: true });
      fixture.run(`CREATE TABLE model_talks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        topic_title TEXT NOT NULL,
        text TEXT NOT NULL,
        legacy_note TEXT
      )`);
      fixture.run(
        "INSERT INTO model_talks (created_at, topic_id, topic_title, text, legacy_note) VALUES (?, ?, ?, ?, ?)",
        ["2026-07-10T00:00:00.000Z", "legacy", "Legacy", "Preserved.", "allowed"],
      );
      fixture.close();

      const db = openDb(dbPath);
      expect(db.query<{ text: string }, []>("SELECT text FROM model_talks").get()?.text).toBe("Preserved.");
      expect(db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'user_progress'",
      ).get()?.name).toBe("user_progress");
      db.close();
    });
  });

  test("必須列の欠落を対象DB・期待値・実値・非破壊の復旧手順つきで拒否する", () => {
    withFixture((dbPath) => {
      const fixture = new Database(dbPath, { create: true });
      fixture.run(`CREATE TABLE user_progress (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        level INTEGER NOT NULL,
        xp INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      fixture.close();
      const before = readFileSync(dbPath);

      const error = captureOpenError(dbPath);

      expect(error.message).toContain(dbPath);
      expect(error.message).toContain("user_progress.xp_into_level");
      expect(error.message).toContain("期待");
      expect(error.message).toContain("実際");
      expect(error.message).toContain("書き込みを行っていません");
      expect(error.message).toContain("バックアップ");
      expect(readFileSync(dbPath)).toEqual(before);
    });
  });

  test("必須列の宣言型が異なるDBを拒否する", () => {
    withFixture((dbPath) => {
      const fixture = new Database(dbPath, { create: true });
      fixture.run(`CREATE TABLE user_progress (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        level INTEGER NOT NULL,
        xp TEXT NOT NULL,
        xp_into_level INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`);
      fixture.close();

      const error = captureOpenError(dbPath);
      expect(error.message).toContain("user_progress.xp");
      expect(error.message).toContain("type=INTEGER");
      expect(error.message).toContain("type=TEXT");
    });
  });

  test("必須indexの欠落を検出し、不完全なDBへindexを追加しない", () => {
    withFixture((dbPath) => {
      const fixture = new Database(dbPath, { create: true });
      fixture.run(`CREATE TABLE xp_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        ymd TEXT NOT NULL,
        kind TEXT NOT NULL,
        amount INTEGER NOT NULL,
        meta TEXT
      )`);
      fixture.close();
      const before = readFileSync(dbPath);

      const error = captureOpenError(dbPath);
      expect(error.message).toContain("xp_events.idx_xp_events_ymd");
      expect(error.message).toContain("実際: missing");
      expect(readFileSync(dbPath)).toEqual(before);

      const unchanged = new Database(dbPath, { readonly: true });
      const indexes = unchanged.query<{ name: string }, []>("PRAGMA index_list('xp_events')").all();
      expect(indexes).toEqual([]);
      unchanged.close();
    });
  });
});
