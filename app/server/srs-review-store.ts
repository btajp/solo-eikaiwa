import type { Database } from "bun:sqlite";
import type { Grade } from "./sentences";

export type SrsTargetKind = "sentence" | "chunk";
export type SrsReviewInput = {
  answerId: string;
  targetKind: SrsTargetKind;
  targetId: number;
  grade: Grade;
};
export type SrsMutationResult = { stage: number; due: string };
export type SrsReviewOutcome =
  | ({ status: "applied" | "duplicate" } & SrsMutationResult)
  | { status: "missing" | "conflict" };

export type SrsReviewStore = {
  /** ledger確保・SRS更新・XP更新を同一transactionで実行する。null mutationは対象不在。 */
  apply(input: SrsReviewInput, mutate: () => SrsMutationResult | null): SrsReviewOutcome;
};

export function ensureSrsReviewSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS srs_review_events (
    answer_id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    grade TEXT NOT NULL,
    stage INTEGER,
    due TEXT,
    created_at TEXT NOT NULL
  )`);
}

type ReviewRow = {
  target_kind: string;
  target_id: number;
  grade: string;
  stage: number | null;
  due: string | null;
};

class MissingTarget extends Error {}

export function makeSrsReviewStore(db: Database): SrsReviewStore {
  const applyTransaction = db.transaction((input: SrsReviewInput, mutate: () => SrsMutationResult | null): SrsReviewOutcome => {
    const existing = db.query<ReviewRow, [string]>(
      "SELECT target_kind, target_id, grade, stage, due FROM srs_review_events WHERE answer_id = ?",
    ).get(input.answerId);
    if (existing) {
      const same = existing.target_kind === input.targetKind
        && existing.target_id === input.targetId
        && existing.grade === input.grade;
      if (!same) return { status: "conflict" };
      if (existing.stage === null || existing.due === null) {
        throw new Error("incomplete SRS review ledger row");
      }
      return { status: "duplicate", stage: existing.stage, due: existing.due };
    }

    // mutation前にIDを確保する。後続失敗時はtransactionごとrollbackされる。
    db.run(
      `INSERT INTO srs_review_events
       (answer_id, target_kind, target_id, grade, stage, due, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      [input.answerId, input.targetKind, input.targetId, input.grade, new Date().toISOString()],
    );
    const result = mutate();
    if (result === null) throw new MissingTarget();
    db.run("UPDATE srs_review_events SET stage = ?, due = ? WHERE answer_id = ?", [
      result.stage, result.due, input.answerId,
    ]);
    return { status: "applied", ...result };
  });

  return {
    apply(input, mutate) {
      try {
        return applyTransaction.immediate(input, mutate);
      } catch (error) {
        if (error instanceof MissingTarget) return { status: "missing" };
        throw error;
      }
    },
  };
}
