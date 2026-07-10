import type { Database } from "bun:sqlite";
import { insertReturningId } from "./db-util";
import {
  BOUNDARY_LEVELS, DEFAULT_LEVEL, demotionTargetLevel, needXp, stageOf, PLACEMENT_XP,
} from "./progression";
import { addDaysYmd, localYmd } from "./dates";
import { isIdempotencyKey } from "./idempotency-key";

export type XpKind = "block" | "srs-grade" | "placement";
export type UpRationale = { xpReached: true; practicedDays14: number; completionRate: number };
export type DownRationale = {
  completionRate: number | null; fttAborts: number; lowOutputRounds: number;
  /** 実際に発火した条件のみ（表示側が根拠と無関係な行を出さないようにするため） */
  triggers: ("lowCompletion" | "fttAborts" | "lowOutput")[];
};
export type Proposal = { kind: "up" | "down"; toLevel: number; rationale: UpRationale | DownRationale };
export type ExpectedProposal = Pick<Proposal, "kind" | "toLevel">;
export type ProgressSummary = {
  level: number; xp: number; xpIntoLevel: number; xpToNext: number;
  stage: number; difficultyMaxed: boolean; proposal: Proposal | null;
};
/** レベル変更系の戻り値。summary は従来どおり、levelChanged で「当日メニューキャッシュを無効化すべきか」を伝える */
export type LevelChangeResult = {
  status: "applied" | "mismatch";
  summary: ProgressSummary;
  levelChanged: boolean;
};
export type BlockCompletionInput = {
  completionId: string;
  attemptId: number | null;
  blockKind: string;
};
export type BlockCompletionStatus =
  | "applied" | "duplicate" | "conflict"
  | "invalid" | "unknown-attempt" | "attempt-mismatch" | "attempt-aborted";
export type BlockCompletionResult = { status: BlockCompletionStatus; summary: ProgressSummary | null };
export type BlockAbortStatus = "aborted" | "duplicate" | "completed" | "unknown-attempt" | "attempt-mismatch";
export type BlockAbortResult = { status: BlockAbortStatus };
export type ProgressStore = {
  getLevel(): number;
  getSummary(today?: string): ProgressSummary;
  /** 不正な kind/amount は null（ルートは400にする）。meta.attemptId があれば該当試行を完了にする */
  addXp(kind: XpKind, amount: number, meta?: Record<string, unknown>, today?: string): ProgressSummary | null;
  blockStart(kind: string, today?: string): { attemptId: number };
  /** completionIdで冪等化し、attempt検証・完了・XP付与を単一transactionで行う。 */
  completeBlock(amount: number, input: BlockCompletionInput, today?: string): BlockCompletionResult;
  /** ユーザーが明示的に途中離脱したattemptだけを中断シグナルへ含める。 */
  abortBlock(attemptId: number, blockKind: string): BlockAbortResult;
  /** accept/decline は表示時の提案と一致した場合のみ適用。set は不正レベルで null。 */
  levelAction(
    action: "accept" | "decline" | "set",
    level?: number,
    today?: string,
    expected?: ExpectedProposal,
  ): LevelChangeResult | null;
  /** プレースメント確定によるレベル設定（level_events kind: placement-set）。同一レベルは no-op（levelChanged=false） */
  placementSet(level: number, today?: string): LevelChangeResult | null;
  /** 日別XP合計（全kind・ymd昇順は呼び出し側で不要） */
  xpByDay(): Record<string, number>;
};

/** XP上限（kind別）。placement は固定値10のみ許容 */
const XP_CAPS: Record<XpKind, number> = { block: 60, "srs-grade": 2, placement: PLACEMENT_XP };

/** 昇格: 14日窓の練習日下限 / 20試行窓の完了率下限。降格: 7日窓の完了率上限（最少試行数）/ 4/3/2中断 */
const PROMOTE_MIN_PRACTICE_DAYS = 5;
const PROMOTE_MIN_COMPLETION = 0.7;
const DEMOTE_MAX_COMPLETION = 0.4;
const DEMOTE_MIN_ATTEMPTS = 5;
const DEMOTE_FTT_ABORTS = 3;
const DEMOTE_LOW_OUTPUT_MIN = 4;      // この数以上の低産出ラウンドで降格材料に
const DEMOTE_LOW_OUTPUT_WINDOW = 6;   // 信頼するのに必要な観測ラウンド数（totalRounds 下限）
const DECLINE_COOLDOWN_DAYS = 7;

type ProgressRow = { level: number; xp: number; xp_into_level: number };

export function ensureProgressSchema(db: Database): void {
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
  db.run(`CREATE TABLE IF NOT EXISTS block_attempt_outcomes (
    attempt_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS block_completion_events (
    completion_id TEXT PRIMARY KEY,
    attempt_id INTEGER,
    block_kind TEXT NOT NULL,
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_xp_events_ymd ON xp_events(ymd)");
  db.run("CREATE INDEX IF NOT EXISTS idx_block_completion_attempt ON block_completion_events(attempt_id)");
}

export function makeProgressStore(
  db: Database,
  fttSignals: (today: string) => { lowRounds: number; totalRounds: number } = () => ({ lowRounds: 0, totalRounds: 0 }),
): ProgressStore {
  function nowTs(): string {
    return new Date().toISOString();
  }

  function ensureRow(): ProgressRow {
    db.run(
      "INSERT OR IGNORE INTO user_progress (id, level, xp, xp_into_level, updated_at) VALUES (1, ?, 0, 0, ?)",
      [DEFAULT_LEVEL, nowTs()],
    );
    return db.query<ProgressRow, []>("SELECT level, xp, xp_into_level FROM user_progress WHERE id = 1").get()!;
  }

  function save(row: ProgressRow): void {
    db.run("UPDATE user_progress SET level = ?, xp = ?, xp_into_level = ?, updated_at = ? WHERE id = 1",
      [row.level, row.xp, row.xp_into_level, nowTs()]);
  }

  /** ステージ内の自動昇格（境界レベルで停止。60→61 は境界でないので進む） */
  function autoLevelUp(row: ProgressRow): void {
    while (row.xp_into_level >= needXp(row.level) && !BOUNDARY_LEVELS.includes(row.level)) {
      row.xp_into_level -= needXp(row.level);
      row.level += 1;
    }
  }

  function lastDeclineYmd(kind: "decline-up" | "decline-down"): string | null {
    const r = db.query<{ ymd: string }, [string]>(
      "SELECT ymd FROM level_events WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind);
    return r?.ymd ?? null;
  }

  function inCooldown(kind: "decline-up" | "decline-down", today: string): boolean {
    const last = lastDeclineYmd(kind);
    return last !== null && last > addDaysYmd(today, -DECLINE_COOLDOWN_DAYS);
  }

  function practicedDays14(today: string): number {
    const since = addDaysYmd(today, -13);
    const r = db.query<{ n: number }, [string, string]>(
      "SELECT COUNT(DISTINCT ymd) AS n FROM xp_events WHERE kind = 'block' AND ymd >= ? AND ymd <= ?",
    ).get(since, today)!;
    return r.n;
  }

  /** 直近 limit 試行の完了率。試行0件は null */
  function completionRateLastN(limit: number): number | null {
    const rows = db.query<{ completed: number }, [number]>(
      `SELECT a.completed FROM block_attempts a
       LEFT JOIN block_attempt_outcomes o ON o.attempt_id = a.id
       WHERE o.attempt_id IS NULL OR o.status IN ('completed', 'aborted')
       ORDER BY a.id DESC LIMIT ?`,
    ).all(limit);
    if (rows.length === 0) return null;
    return rows.filter((r) => r.completed === 1).length / rows.length;
  }

  /** 直近7日窓の完了率と試行数 */
  function completionRate7d(today: string): { rate: number | null; count: number } {
    const since = addDaysYmd(today, -6);
    const rows = db.query<{ completed: number }, [string, string]>(
      `SELECT a.completed FROM block_attempts a
       LEFT JOIN block_attempt_outcomes o ON o.attempt_id = a.id
       WHERE a.ymd >= ? AND a.ymd <= ?
         AND (o.attempt_id IS NULL OR o.status IN ('completed', 'aborted'))`,
    ).all(since, today);
    if (rows.length === 0) return { rate: null, count: 0 };
    return { rate: rows.filter((r) => r.completed === 1).length / rows.length, count: rows.length };
  }

  function fttAbortsLast5(): { aborts: number; count: number } {
    const rows = db.query<{ completed: number }, []>(
      `SELECT a.completed FROM block_attempts a
       LEFT JOIN block_attempt_outcomes o ON o.attempt_id = a.id
       WHERE a.kind = 'four-three-two'
         AND (o.attempt_id IS NULL OR o.status IN ('completed', 'aborted'))
       ORDER BY a.id DESC LIMIT 5`,
    ).all();
    return { aborts: rows.filter((r) => r.completed === 0).length, count: rows.length };
  }

  /** 提案の計算（永続化しない）。降格を優先（直近シグナル重視） */
  function computeProposal(row: ProgressRow, today: string): Proposal | null {
    // 降格（§5.2）
    if (stageOf(row.level) >= 2 && !inCooldown("decline-down", today)) {
      const week = completionRate7d(today);
      const ftt = fttAbortsLast5();
      const out = fttSignals(today);
      const lowCompletion = week.count >= DEMOTE_MIN_ATTEMPTS && week.rate !== null && week.rate < DEMOTE_MAX_COMPLETION;
      // 仕様§5.2: 「直近5回中3回以上」中断。fttAbortsLast5 は直近5件までの窓なので、
      // 窓が5件揃っていること（count>=5）を下限にする（count<=DEMOTE_FTT_ABORTSは常に真になり無意味だった）。
      const manyAborts = ftt.count >= 5 && ftt.aborts >= DEMOTE_FTT_ABORTS;
      // 「完走するが苦しい」層: 完了/中断では拾えない、engagedだが極端に低語数のラウンドが続く状態
      const lowOutput = out.totalRounds >= DEMOTE_LOW_OUTPUT_WINDOW && out.lowRounds >= DEMOTE_LOW_OUTPUT_MIN;
      if (lowCompletion || manyAborts || lowOutput) {
        const triggers: DownRationale["triggers"] = [];
        if (lowCompletion) triggers.push("lowCompletion");
        if (manyAborts) triggers.push("fttAborts");
        if (lowOutput) triggers.push("lowOutput");
        return {
          kind: "down",
          toLevel: demotionTargetLevel(row.level),
          rationale: { completionRate: week.rate, fttAborts: ftt.aborts, lowOutputRounds: out.lowRounds, triggers },
        };
      }
    }
    // 昇格（§5.1）
    if (BOUNDARY_LEVELS.includes(row.level) && row.xp_into_level >= needXp(row.level) && !inCooldown("decline-up", today)) {
      const days = practicedDays14(today);
      const rate = completionRateLastN(20);
      if (days >= PROMOTE_MIN_PRACTICE_DAYS && rate !== null && rate >= PROMOTE_MIN_COMPLETION) {
        return {
          kind: "up",
          toLevel: row.level + 1,
          rationale: { xpReached: true, practicedDays14: days, completionRate: rate },
        };
      }
    }
    return null;
  }

  function summarize(row: ProgressRow, today: string): ProgressSummary {
    return {
      level: row.level,
      xp: row.xp,
      xpIntoLevel: row.xp_into_level,
      xpToNext: Math.max(0, needXp(row.level) - row.xp_into_level),
      stage: stageOf(row.level),
      difficultyMaxed: row.level >= 61,
      proposal: computeProposal(row, today),
    };
  }

  function recordLevelEvent(kind: string, from: number, to: number, rationale: unknown, ymd: string): void {
    db.run("INSERT INTO level_events (ts, ymd, kind, from_level, to_level, rationale) VALUES (?, ?, ?, ?, ?, ?)",
      [nowTs(), ymd, kind, from, to, rationale == null ? null : JSON.stringify(rationale)]);
  }

  /** set系の共通処理。eventKind だけが異なる（manual-set / placement-set） */
  function setLevelTo(level: number | undefined, eventKind: "manual-set" | "placement-set", today: string): LevelChangeResult | null {
    const row = ensureRow();
    if (level === undefined || !Number.isInteger(level) || level < 1 || level > 999) return null;
    // 同一レベルへの set は no-op（xp_into_level を維持し、level_events も記録しない）
    if (level === row.level) return { status: "applied", summary: summarize(row, today), levelChanged: false };
    recordLevelEvent(eventKind, row.level, level, null, today);
    row.level = level;
    row.xp_into_level = 0;
    save(row);
    return { status: "applied", summary: summarize(row, today), levelChanged: true };
  }

  /** 検証済みXPを記録して進捗行を更新する。呼び出し側のtransaction内で使う。 */
  function addXpCore(kind: XpKind, amount: number, meta: Record<string, unknown>, today: string): ProgressRow {
    const row = ensureRow();
    db.run("INSERT INTO xp_events (ts, ymd, kind, amount, meta) VALUES (?, ?, ?, ?, ?)",
      [nowTs(), today, kind, amount, Object.keys(meta).length ? JSON.stringify(meta) : null]);
    row.xp += amount;
    row.xp_into_level += amount;
    autoLevelUp(row);
    save(row);
    return row;
  }

  function validXp(kind: XpKind, amount: number): boolean {
    return Object.prototype.hasOwnProperty.call(XP_CAPS, kind)
      && Number.isInteger(amount)
      && amount >= 1
      && amount <= XP_CAPS[kind]
      && (kind !== "placement" || amount === XP_CAPS.placement);
  }

  const completeBlockTransaction = db.transaction((
    amount: number,
    input: BlockCompletionInput,
    today: string,
  ): BlockCompletionResult => {
    const existingCompletion = db.query<{
      attempt_id: number | null; block_kind: string; amount: number;
    }, [string]>(
      "SELECT attempt_id, block_kind, amount FROM block_completion_events WHERE completion_id = ?",
    ).get(input.completionId);
    if (existingCompletion) {
      const same = existingCompletion.attempt_id === input.attemptId
        && existingCompletion.block_kind === input.blockKind
        && existingCompletion.amount === amount;
      return same
        ? { status: "duplicate", summary: summarize(ensureRow(), today) }
        : { status: "conflict", summary: null };
    }

    if (input.attemptId !== null) {
      const attempt = db.query<{
        kind: string; completed: number; status: string | null;
      }, [number]>(
        `SELECT a.kind, a.completed, o.status
         FROM block_attempts a
         LEFT JOIN block_attempt_outcomes o ON o.attempt_id = a.id
         WHERE a.id = ?`,
      ).get(input.attemptId);
      if (!attempt) return { status: "unknown-attempt", summary: null };
      if (attempt.kind !== input.blockKind) return { status: "attempt-mismatch", summary: null };
      if (attempt.status === "aborted") return { status: "attempt-aborted", summary: null };
      if (attempt.completed === 1 || attempt.status === "completed") {
        const original = db.query<{ block_kind: string; amount: number }, [number]>(
          "SELECT block_kind, amount FROM block_completion_events WHERE attempt_id = ? ORDER BY rowid LIMIT 1",
        ).get(input.attemptId);
        if (original && (original.block_kind !== input.blockKind || original.amount !== amount)) {
          return { status: "conflict", summary: null };
        }
        db.run(
          `INSERT INTO block_completion_events
           (completion_id, attempt_id, block_kind, amount, created_at) VALUES (?, ?, ?, ?, ?)`,
          [input.completionId, input.attemptId, input.blockKind, amount, nowTs()],
        );
        return { status: "duplicate", summary: summarize(ensureRow(), today) };
      }
    }

    db.run(
      `INSERT INTO block_completion_events
       (completion_id, attempt_id, block_kind, amount, created_at) VALUES (?, ?, ?, ?, ?)`,
      [input.completionId, input.attemptId, input.blockKind, amount, nowTs()],
    );
    const meta: Record<string, unknown> = {
      completionId: input.completionId,
      blockKind: input.blockKind,
      ...(input.attemptId !== null ? { attemptId: input.attemptId } : {}),
    };
    const row = addXpCore("block", amount, meta, today);
    if (input.attemptId !== null) {
      db.run("UPDATE block_attempts SET completed = 1 WHERE id = ?", [input.attemptId]);
      db.run(
        `INSERT INTO block_attempt_outcomes (attempt_id, status, updated_at) VALUES (?, 'completed', ?)
         ON CONFLICT(attempt_id) DO UPDATE SET status = 'completed', updated_at = excluded.updated_at`,
        [input.attemptId, nowTs()],
      );
    }
    return { status: "applied", summary: summarize(row, today) };
  });

  const abortBlockTransaction = db.transaction((attemptId: number, blockKind: string): BlockAbortResult => {
    const attempt = db.query<{ kind: string; completed: number; status: string | null }, [number]>(
      `SELECT a.kind, a.completed, o.status FROM block_attempts a
       LEFT JOIN block_attempt_outcomes o ON o.attempt_id = a.id WHERE a.id = ?`,
    ).get(attemptId);
    if (!attempt) return { status: "unknown-attempt" };
    if (attempt.kind !== blockKind) return { status: "attempt-mismatch" };
    if (attempt.completed === 1 || attempt.status === "completed") return { status: "completed" };
    if (attempt.status === "aborted") return { status: "duplicate" };
    db.run(
      `INSERT INTO block_attempt_outcomes (attempt_id, status, updated_at) VALUES (?, 'aborted', ?)
       ON CONFLICT(attempt_id) DO UPDATE SET status = 'aborted', updated_at = excluded.updated_at`,
      [attemptId, nowTs()],
    );
    return { status: "aborted" };
  });

  return {
    getLevel() {
      return ensureRow().level;
    },

    getSummary(today = localYmd()) {
      return summarize(ensureRow(), today);
    },

    addXp(kind, amount, meta = {}, today = localYmd()) {
      if (!validXp(kind, amount)) return null;
      const attemptId = (meta as { attemptId?: unknown }).attemptId;
      if (kind === "block" && Number.isInteger(attemptId)) {
        // 内部呼び出しの後方互換。HTTP経路はclient生成completionIdを必須にしてcompleteBlockを直接使う。
        const attempt = db.query<{ kind: string }, [number]>(
          "SELECT kind FROM block_attempts WHERE id = ?",
        ).get(attemptId as number);
        if (!attempt) return null;
        const result = completeBlockTransaction.immediate(amount, {
          completionId: `legacy-attempt-${String(attemptId)}`,
          attemptId: attemptId as number,
          blockKind: attempt.kind,
        }, today);
        return result.summary;
      }
      return db.transaction(() => summarize(addXpCore(kind, amount, meta, today), today)).immediate();
    },

    blockStart(kind, today = localYmd()) {
      return db.transaction(() => {
        db.run("INSERT INTO block_attempts (ts, ymd, kind, completed) VALUES (?, ?, ?, 0)", [nowTs(), today, kind]);
        const attemptId = insertReturningId(db);
        db.run(
          "INSERT INTO block_attempt_outcomes (attempt_id, status, updated_at) VALUES (?, 'pending', ?)",
          [attemptId, nowTs()],
        );
        return { attemptId };
      }).immediate();
    },

    completeBlock(amount, input, today = localYmd()) {
      if (!validXp("block", amount)
        || !isIdempotencyKey(input.completionId)
        || typeof input.blockKind !== "string"
        || input.blockKind.length < 1
        || (input.attemptId !== null && (!Number.isInteger(input.attemptId) || input.attemptId < 1))) {
        return { status: "invalid", summary: null };
      }
      return completeBlockTransaction.immediate(amount, input, today);
    },

    abortBlock(attemptId, blockKind) {
      if (!Number.isInteger(attemptId) || attemptId < 1 || typeof blockKind !== "string" || blockKind.length < 1) {
        return { status: "unknown-attempt" };
      }
      return abortBlockTransaction.immediate(attemptId, blockKind);
    },

    levelAction(action, level, today = localYmd(), expected) {
      if (action === "set") return setLevelTo(level, "manual-set", today);
      const row = ensureRow();
      const proposal = computeProposal(row, today);
      if (!proposal
        || !expected
        || proposal.kind !== expected.kind
        || proposal.toLevel !== expected.toLevel) {
        return { status: "mismatch", summary: summarize(row, today), levelChanged: false };
      }
      if (action === "decline") {
        recordLevelEvent(proposal.kind === "up" ? "decline-up" : "decline-down", row.level, proposal.toLevel, proposal.rationale, today);
        return { status: "applied", summary: summarize(row, today), levelChanged: false };
      }
      // accept
      const fromLevel = row.level; // 変異前に捕捉（up のカスケード / down のレベル上書きで壊れないように）
      if (proposal.kind === "up") {
        row.xp_into_level -= needXp(row.level);
        row.level += 1;
        autoLevelUp(row);
      } else {
        row.level = proposal.toLevel;
        row.xp_into_level = 0;
      }
      recordLevelEvent(proposal.kind === "up" ? "accept-up" : "accept-down", fromLevel, row.level, proposal.rationale, today);
      save(row);
      return { status: "applied", summary: summarize(row, today), levelChanged: true };
    },

    placementSet(level, today = localYmd()) {
      return setLevelTo(level, "placement-set", today);
    },

    xpByDay() {
      const rows = db.query<{ ymd: string; total: number }, []>(
        "SELECT ymd, SUM(amount) AS total FROM xp_events GROUP BY ymd").all();
      return Object.fromEntries(rows.map((r) => [r.ymd, r.total]));
    },
  };
}
