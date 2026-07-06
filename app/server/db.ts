import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";

/** 構造化された状態・履歴の置き場（ログはJSONLのまま）。data/ はローカル専用（gitignore済み）。 */
export const DEFAULT_DB_PATH = path.join(DATA_DIR, "learn-english.db");

export type ModelTalkEntry = {
  id: number;
  createdAt: string;
  topicId: string;
  topicTitle: string;
  text: string;
};

export type LibraryStore = {
  saveModelTalk: (e: { topicId: string; topicTitle: string; text: string }) => void;
  listModelTalks: (limit?: number) => ModelTalkEntry[];
};

/** DBを開き、スキーマを保証する（CREATE IF NOT EXISTS のみ。マイグレーション機構はYAGNI） */
export function openDb(dbPath: string = DEFAULT_DB_PATH): Database {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS model_talks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    topic_title TEXT NOT NULL,
    text TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sentence_srs (
    no INTEGER PRIMARY KEY,
    stage INTEGER NOT NULL DEFAULT 0,
    due TEXT NOT NULL,
    last_grade TEXT,
    reviews INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS user_progress (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    level INTEGER NOT NULL,
    xp INTEGER NOT NULL,
    xp_into_level INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS xp_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, ymd TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, meta TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS level_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, ymd TEXT NOT NULL, kind TEXT NOT NULL,
    from_level INTEGER NOT NULL, to_level INTEGER NOT NULL, rationale TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS block_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, ymd TEXT NOT NULL, kind TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS placement_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, stage INTEGER NOT NULL, start_level INTEGER NOT NULL,
    rationale TEXT NOT NULL, metrics TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sentence_explanations (
    no INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    created TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS collected_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created TEXT NOT NULL,
    source TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    en TEXT NOT NULL,
    norm_en TEXT NOT NULL UNIQUE,
    note TEXT NOT NULL DEFAULT '',
    stage INTEGER NOT NULL DEFAULT 0,
    due TEXT NOT NULL,
    last_grade TEXT,
    reviews INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS talk_explanations (
    hash TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    created TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS utterance_translations (
    hash TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    created TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS monthly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    ymd TEXT NOT NULL,
    text TEXT NOT NULL,
    data_json TEXT NOT NULL
  )`);
  return db;
}

/** モデルトーク解説のキャッシュ（本文の sha256 をキーにする） */
export type TalkExplainCache = {
  get(hash: string): string | null;
  save(hash: string, text: string, created: string): void;
};

/** hash→text の単純キャッシュ実体（テーブル名だけが異なる複数キャッシュで共有する） */
function makeHashTextCache(db: Database, table: string): TalkExplainCache {
  return {
    get(hash) {
      const row = db.query<{ text: string }, [string]>(
        `SELECT text FROM ${table} WHERE hash = ?`,
      ).get(hash);
      return row?.text ?? null;
    },
    save(hash, text, created) {
      db.run(
        `INSERT INTO ${table} (hash, text, created) VALUES (?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET text = excluded.text, created = excluded.created`,
        [hash, text, created],
      );
    },
  };
}

export function makeTalkExplainCache(db: Database): TalkExplainCache {
  return makeHashTextCache(db, "talk_explanations");
}

/** AI発話の訳のキャッシュ（本文の sha256 をキーにする。talk_explanations とは別テーブル） */
export function makeTranslationCache(db: Database): TalkExplainCache {
  return makeHashTextCache(db, "utterance_translations");
}

type Row = { id: number; created_at: string; topic_id: string; topic_title: string; text: string };

export function makeLibraryStore(db: Database): LibraryStore {
  return {
    saveModelTalk(e) {
      // 連打・再訪で同じトークが無限に増えないための素朴なガード:
      // 同一トピックの直近行と本文が同じなら挿入しない
      const last = db
        .query<Pick<Row, "text">, [string]>("SELECT text FROM model_talks WHERE topic_id = ? ORDER BY id DESC LIMIT 1")
        .get(e.topicId);
      if (last && last.text === e.text) return;
      db.run(
        "INSERT INTO model_talks (created_at, topic_id, topic_title, text) VALUES (?, ?, ?, ?)",
        [new Date().toISOString(), e.topicId, e.topicTitle, e.text],
      );
    },
    listModelTalks(limit = 100) {
      const rows = db
        .query<Row, [number]>("SELECT * FROM model_talks ORDER BY id DESC LIMIT ?")
        .all(limit);
      return rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        topicId: r.topic_id,
        topicTitle: r.topic_title,
        text: r.text,
      }));
    },
  };
}
