import type { Database } from "bun:sqlite";
import type { TtsSettings } from "./tts";

/** TTS プロバイダ設定の永続化（単一行 id=1）。APIキーは持たず、resolverから実行時に注入する。 */
export function ensureTtsSettingsSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS tts_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_url TEXT,
    model TEXT,
    voice TEXT,
    updated_at TEXT NOT NULL
  )`);
}

export type TtsSettingsStore = {
  /** 保存済み設定。行が無ければ null（＝env/既定に従う）。 */
  get(): TtsSettings | null;
  /** 単一行(id=1)を upsert し、保存した設定をそのまま返す。妥当性は route が保証する。 */
  save(s: TtsSettings): TtsSettings;
};

type Row = { base_url: string | null; model: string | null; voice: string | null };

export function makeTtsSettingsStore(db: Database): TtsSettingsStore {
  return {
    get() {
      const row = db
        .query<Row, []>("SELECT base_url, model, voice FROM tts_settings WHERE id = 1")
        .get();
      if (!row) return null;
      return { baseUrl: row.base_url, model: row.model, voice: row.voice };
    },
    save(s) {
      db.run(
        `INSERT INTO tts_settings (id, base_url, model, voice, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           base_url = excluded.base_url,
           model = excluded.model,
           voice = excluded.voice,
           updated_at = excluded.updated_at`,
        [s.baseUrl, s.model, s.voice, new Date().toISOString()],
      );
      return s;
    },
  };
}
