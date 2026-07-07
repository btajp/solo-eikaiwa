import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { addDaysYmd } from "./dates";
import { FTT_ENGAGED_SEC, FTT_WORDS_FLOOR } from "./progression";
import { SESSIONS_DIR } from "./paths";

export type SessionEvent = {
  ts: string;
  type:
    | "session_start" | "session_end"
    | "user_utterance" | "stt_result" | "assistant_reply" | "error"
    | "block_start" | "block_end" | "round_start" | "round_end";
  sessionId: string;
  text?: string;
  meta?: Record<string, unknown>;
};

export function appendEvent(file: string, e: SessionEvent): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(e) + "\n", "utf8");
}

export function readEvents(file: string): SessionEvent[] {
  if (!existsSync(file)) return [];
  const events: SessionEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch {
      // 途中クラッシュ等による不正・途中切れ行は読み飛ばす（書き込みは追記型なので後続行は健全）
      console.warn(`session-log: skipping malformed line in ${file}`);
    }
  }
  return events;
}

const LOGGED_MARKER = Symbol.for("learn-english.errorLogged");

/** この Error は既に error イベントとして記録済み、という印を付ける（二重記録防止） */
export function markErrorLogged(err: unknown): void {
  if (err instanceof Error) (err as Error & Record<symbol, unknown>)[LOGGED_MARKER] = true;
}

export function isErrorLogged(err: unknown): boolean {
  return err instanceof Error && (err as Error & Record<symbol, unknown>)[LOGGED_MARKER] === true;
}

/** 練習を実施した日（セッションログが存在する日）の一覧。カレンダー表示用の情報的フィードバック */
export function listPracticeDays(dir: string = SESSIONS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .map((f) => f.slice(0, -6))
    .sort();
}

/**
 * 直近 days 日の 4/3/2 `round_end` から発話量シグナルを集計する（降格提案の追加材料）。
 * lowRounds = 「engaged（elapsedSec>=FTT_ENGAGED_SEC）だが語数 < FTT_WORDS_FLOOR」のラウンド数。
 * elapsedSec/transcript は round_end に既に記録済みなので新規記録は不要。
 */
export function fttOutputSignals(
  today: string, days = 7, dir: string = SESSIONS_DIR,
): { lowRounds: number; totalRounds: number } {
  let lowRounds = 0, totalRounds = 0;
  for (let i = 0; i < days; i++) {
    const ymd = addDaysYmd(today, -i);
    for (const e of readEvents(path.join(dir, `${ymd}.jsonl`))) {
      if (e.type !== "round_end") continue;
      const m = e.meta as { block?: string; elapsedSec?: number; transcript?: string } | undefined;
      if (!m || m.block !== "four-three-two") continue;
      totalRounds++;
      const elapsed = typeof m.elapsedSec === "number" ? m.elapsedSec : 0;
      const words = (m.transcript ?? "").trim().split(/\s+/).filter(Boolean).length;
      if (elapsed >= FTT_ENGAGED_SEC && words < FTT_WORDS_FLOOR) lowRounds++;
    }
  }
  return { lowRounds, totalRounds };
}
