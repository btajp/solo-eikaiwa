import type { Database } from "bun:sqlite";
import { insertReturningId } from "./db-util";

export type ListeningLogRow = { id: number; ts: string; ymd: string; itemId: string };
export type ListeningLogResult =
  | { status: "recorded" | "replayed"; row: ListeningLogRow }
  | { status: "conflict" };

export type ListeningStore = {
  /** attemptIdで冪等に1回の聴取を記録する。ymd は呼び出し側のローカル日付。 */
  log(itemId: string, ymd: string, attemptId: string): ListeningLogResult;
  /** fromYmd 以降（fromYmd を含む）の聴取回数。「今週n本」の情報表示に使う。 */
  countSince(fromYmd: string): number;
};

export function ensureListeningSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS listening_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    ymd TEXT NOT NULL,
    item_id TEXT NOT NULL
  )`);
  // 既存の聴取履歴を変更せず、client生成IDと新規ログだけを対応づける冪等台帳。
  db.run(`CREATE TABLE IF NOT EXISTS listening_log_attempts (
    attempt_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    log_id INTEGER NOT NULL UNIQUE
  )`);
}

export function makeListeningStore(db: Database): ListeningStore {
  const logOnce = db.transaction((itemId: string, ymd: string, attemptId: string): ListeningLogResult => {
    const existing = db.query<{
      request_item_id: string; id: number; ts: string; ymd: string; item_id: string;
    }, [string]>(`
      SELECT a.item_id AS request_item_id, l.id, l.ts, l.ymd, l.item_id
      FROM listening_log_attempts a
      JOIN listening_logs l ON l.id = a.log_id
      WHERE a.attempt_id = ?
    `).get(attemptId);
    if (existing) {
      if (existing.request_item_id !== itemId) return { status: "conflict" };
      return {
        status: "replayed",
        row: { id: existing.id, ts: existing.ts, ymd: existing.ymd, itemId: existing.item_id },
      };
    }

    const ts = new Date().toISOString();
    db.run("INSERT INTO listening_logs (ts, ymd, item_id) VALUES (?, ?, ?)", [ts, ymd, itemId]);
    const id = insertReturningId(db);
    db.run(
      "INSERT INTO listening_log_attempts (attempt_id, item_id, log_id) VALUES (?, ?, ?)",
      [attemptId, itemId, id],
    );
    return { status: "recorded", row: { id, ts, ymd, itemId } };
  });

  return {
    log(itemId, ymd, attemptId) {
      return logOnce.immediate(itemId, ymd, attemptId);
    },
    countSince(fromYmd) {
      const row = db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM listening_logs WHERE ymd >= ?")
        .get(fromYmd);
      return row?.n ?? 0;
    },
  };
}
