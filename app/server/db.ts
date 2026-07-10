import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";
import { ensureProgressSchema } from "./progress-store";
import { ensureSentenceSchema } from "./sentences";
import { ensureChunkSchema } from "./chunks";
import { ensurePlacementSchema } from "./placement";
import { ensureAssessmentSchema } from "./assessment";
import { ensureListeningSchema } from "./listening-store";
import { ensureFeedbackSchema } from "./feedback-store";
import { ensureLlmSettingsSchema } from "./llm-settings-store";
import { ensureTtsSettingsSchema } from "./tts-settings-store";
import { ensureTtsProviderSchema } from "./tts-provider-store";
import { ensureLlmRoleSettingsSchema } from "./llm-role-settings-store";
import { ensureLlmRoleTuningSchema } from "./llm-role-tuning-store";
import { ensureLlmAuthSchema } from "./llm-auth-store";
import { ensureTopicAssetCacheSchema } from "./topic-assets";
import { ensureApiKeyOriginSchema } from "./api-key-origin-store";
import { assertSchemaCompatible, readSchemaContract, type SchemaContract } from "./schema-contract";
import { assertDatabaseNotRestoring } from "./database-lock";

/** 構造化された状態・履歴の置き場（ログはJSONLのまま）。data/ はローカル専用（gitignore済み）。 */
// DB ファイル名はリネーム（solo-eikaiwa）後も旧名を維持する: 既存ユーザーの学習データ継続のため（表示名とは独立）
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

export function ensureLibrarySchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS model_talks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    topic_title TEXT NOT NULL,
    text TEXT NOT NULL
  )`);
}

/** hashTextCache 系の2テーブル（訳・解説キャッシュ）をまとめて保証する */
export function ensureHashCacheSchemas(db: Database): void {
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
}

function ensureAllSchemas(db: Database): void {
  ensureLibrarySchema(db);
  ensureHashCacheSchemas(db);
  ensureProgressSchema(db);
  ensureSentenceSchema(db);
  ensureChunkSchema(db);
  ensurePlacementSchema(db);
  ensureAssessmentSchema(db);
  ensureListeningSchema(db);
  ensureFeedbackSchema(db);
  ensureLlmSettingsSchema(db);
  ensureTtsSettingsSchema(db);
  ensureTtsProviderSchema(db);
  ensureLlmRoleSettingsSchema(db);
  ensureLlmRoleTuningSchema(db);
  ensureLlmAuthSchema(db);
  ensureTopicAssetCacheSchema(db);
  ensureApiKeyOriginSchema(db);
}

let expectedSchemaContract: SchemaContract | undefined;

function getExpectedSchemaContract(): SchemaContract {
  if (expectedSchemaContract) return expectedSchemaContract;
  const reference = new Database(":memory:");
  try {
    ensureAllSchemas(reference);
    expectedSchemaContract = readSchemaContract(reference);
    return expectedSchemaContract;
  } finally {
    reference.close();
  }
}

/** 既存テーブルの必須契約を読み取り専用で検査してから、不足している新規テーブルを作成する。 */
export function openDb(dbPath: string = DEFAULT_DB_PATH): Database {
  const expected = getExpectedSchemaContract();
  const displayPath = dbPath === ":memory:" ? dbPath : path.resolve(dbPath);
  assertDatabaseNotRestoring(dbPath);
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  try {
    db.run("PRAGMA query_only = ON");
    assertSchemaCompatible(db, displayPath, expected);
    db.run("PRAGMA query_only = OFF");
    db.run("PRAGMA journal_mode = WAL");
    db.transaction(() => ensureAllSchemas(db))();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
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
