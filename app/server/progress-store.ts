import type { Database } from "bun:sqlite";
import { insertReturningId } from "./db-util";
import {
  BOUNDARY_LEVELS, DEFAULT_LEVEL, demotionTargetLevel, needXp, stageOf, PLACEMENT_XP,
} from "./progression";
import { addDaysYmd, localYmd } from "./dates";

export type XpKind = "block" | "srs-grade" | "placement";
export type UpRationale = { xpReached: true; practicedDays14: number; completionRate: number };
export type DownRationale = { completionRate: number | null; fttAborts: number; lowOutputRounds: number };
export type Proposal = { kind: "up" | "down"; toLevel: number; rationale: UpRationale | DownRationale };
export type ProgressSummary = {
  level: number; xp: number; xpIntoLevel: number; xpToNext: number;
  stage: number; difficultyMaxed: boolean; proposal: Proposal | null;
};
/** レベル変更系の戻り値。summary は従来どおり、levelChanged で「当日メニューキャッシュを無効化すべきか」を伝える */
export type LevelChangeResult = { summary: ProgressSummary; levelChanged: boolean };
export type ProgressStore = {
  getLevel(): number;
  getSummary(today?: string): ProgressSummary;
  /** 不正な kind/amount は null（ルートは400にする）。meta.attemptId があれば該当試行を完了にする */
  addXp(kind: XpKind, amount: number, meta?: Record<string, unknown>, today?: string): ProgressSummary | null;
  blockStart(kind: string, today?: string): { attemptId: number };
  /** accept/decline は提案が無ければ null。set は不正レベルで null。levelChanged=実際にレベルが動いたか */
  levelAction(action: "accept" | "decline" | "set", level?: number, today?: string): LevelChangeResult | null;
  /** プレースメント確定によるレベル設定（level_events kind: placement-set）。同一レベルは no-op（levelChanged=false） */
  placementSet(level: number, today?: string): LevelChangeResult | null;
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
      "SELECT completed FROM block_attempts ORDER BY id DESC LIMIT ?").all(limit);
    if (rows.length === 0) return null;
    return rows.filter((r) => r.completed === 1).length / rows.length;
  }

  /** 直近7日窓の完了率と試行数 */
  function completionRate7d(today: string): { rate: number | null; count: number } {
    const since = addDaysYmd(today, -6);
    const rows = db.query<{ completed: number }, [string, string]>(
      "SELECT completed FROM block_attempts WHERE ymd >= ? AND ymd <= ?").all(since, today);
    if (rows.length === 0) return { rate: null, count: 0 };
    return { rate: rows.filter((r) => r.completed === 1).length / rows.length, count: rows.length };
  }

  function fttAbortsLast5(): { aborts: number; count: number } {
    const rows = db.query<{ completed: number }, []>(
      "SELECT completed FROM block_attempts WHERE kind = 'four-three-two' ORDER BY id DESC LIMIT 5").all();
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
        return {
          kind: "down",
          toLevel: demotionTargetLevel(row.level),
          rationale: { completionRate: week.rate, fttAborts: ftt.aborts, lowOutputRounds: out.lowRounds },
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
    if (level === row.level) return { summary: summarize(row, today), levelChanged: false };
    recordLevelEvent(eventKind, row.level, level, null, today);
    row.level = level;
    row.xp_into_level = 0;
    save(row);
    return { summary: summarize(row, today), levelChanged: true };
  }

  return {
    getLevel() {
      return ensureRow().level;
    },

    getSummary(today = localYmd()) {
      return summarize(ensureRow(), today);
    },

    addXp(kind, amount, meta = {}, today = localYmd()) {
      if (!(kind in XP_CAPS)) return null;
      if (!Number.isInteger(amount) || amount < 1 || amount > XP_CAPS[kind]) return null;
      if (kind === "placement" && amount !== XP_CAPS.placement) return null;
      const attemptId = (meta as { attemptId?: unknown }).attemptId;
      const hasAttempt = kind === "block" && Number.isInteger(attemptId);
      if (hasAttempt) {
        // 同一 attemptId の完了XPが二重に付与されないようにする（連打・再送で block_attempts が既に
        // completed=1 なら xp_events への記録もXP加算も行わず、現在の summary をそのまま返す）
        const existing = db.query<{ completed: number }, [number]>(
          "SELECT completed FROM block_attempts WHERE id = ?").get(attemptId as number);
        if (existing?.completed === 1) return summarize(ensureRow(), today);
      }
      const row = ensureRow();
      db.run("INSERT INTO xp_events (ts, ymd, kind, amount, meta) VALUES (?, ?, ?, ?, ?)",
        [nowTs(), today, kind, amount, Object.keys(meta).length ? JSON.stringify(meta) : null]);
      if (hasAttempt) {
        db.run("UPDATE block_attempts SET completed = 1 WHERE id = ?", [attemptId as number]);
      }
      row.xp += amount;
      row.xp_into_level += amount;
      autoLevelUp(row);
      save(row);
      return summarize(row, today);
    },

    blockStart(kind, today = localYmd()) {
      db.run("INSERT INTO block_attempts (ts, ymd, kind, completed) VALUES (?, ?, ?, 0)", [nowTs(), today, kind]);
      return { attemptId: insertReturningId(db) };
    },

    levelAction(action, level, today = localYmd()) {
      if (action === "set") return setLevelTo(level, "manual-set", today);
      const row = ensureRow();
      const proposal = computeProposal(row, today);
      if (!proposal) return null;
      if (action === "decline") {
        recordLevelEvent(proposal.kind === "up" ? "decline-up" : "decline-down", row.level, proposal.toLevel, proposal.rationale, today);
        return { summary: summarize(row, today), levelChanged: false };
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
      return { summary: summarize(row, today), levelChanged: true };
    },

    placementSet(level, today = localYmd()) {
      return setLevelTo(level, "placement-set", today);
    },
  };
}
