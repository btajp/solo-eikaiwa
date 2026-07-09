import type { Database } from "bun:sqlite";
import type { TtsProvider } from "./tts";

/**
 * TTS プロバイダの明示選択の永続化（単一行 id=1・v0.29）。
 * tts_settings（baseUrl/model/voice）とは別テーブル（既存テーブルへの列追加はしない規約のため）。
 * 行不在は "auto"（従来の暗黙決定）を意味する。
 */
export function ensureTtsProviderSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS tts_provider_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

export const TTS_PROVIDERS = ["auto", "say", "openai-compat"] as const;

export type TtsProviderStore = {
  /** 保存済みプロバイダ。行不在・未知値は "auto"（安全側=従来挙動）に正規化して返す。 */
  get(): TtsProvider;
  /** 単一行(id=1)を upsert する。妥当性は route が保証する。 */
  save(p: TtsProvider): void;
};

export function makeTtsProviderStore(db: Database): TtsProviderStore {
  return {
    get() {
      const row = db
        .query<{ provider: string }, []>("SELECT provider FROM tts_provider_settings WHERE id = 1")
        .get();
      const v = row?.provider;
      return (TTS_PROVIDERS as readonly string[]).includes(v ?? "") ? (v as TtsProvider) : "auto";
    },
    save(p) {
      db.run(
        `INSERT INTO tts_provider_settings (id, provider, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, updated_at = excluded.updated_at`,
        [p, new Date().toISOString()],
      );
    },
  };
}
