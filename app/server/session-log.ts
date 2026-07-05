import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "./paths";

export type SessionEvent = {
  ts: string;
  type:
    | "session_start" | "session_end"
    | "user_utterance" | "assistant_reply" | "error"
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
