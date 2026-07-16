import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addDaysYmd } from "./dates";
import { FTT_ENGAGED_SEC, FTT_WORDS_FLOOR } from "./progression";
import { SESSIONS_DIR } from "./paths";

export type SessionEvent = {
  ts: string;
  type:
    | "session_start" | "session_end"
    | "user_utterance" | "stt_result" | "assistant_reply" | "error"
    | "block_start" | "block_end" | "round_start" | "round_end"
    // ブロック内の実施実態（例: シャドーイングの listened / spoken-self-report）。練習日判定には使わない（#181）
    | "block_activity";
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

const LOGGED_MARKER = Symbol.for("solo-eikaiwa.errorLogged");

/** この Error は既に error イベントとして記録済み、という印を付ける（二重記録防止） */
export function markErrorLogged(err: unknown): void {
  if (err instanceof Error) (err as Error & Record<symbol, unknown>)[LOGGED_MARKER] = true;
}

export function isErrorLogged(err: unknown): boolean {
  return err instanceof Error && (err as Error & Record<symbol, unknown>)[LOGGED_MARKER] === true;
}

const DATE_LOG_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** 起動・閲覧ではなく、発話または明示完了を表すイベントだけを練習実施として扱う。 */
export function isPracticeActivity(e: SessionEvent): boolean {
  if (e.type === "user_utterance" || e.type === "stt_result") return true;
  if (e.type === "round_end") return (e.meta as { aborted?: unknown } | undefined)?.aborted !== true;
  if (e.type === "block_end") return (e.meta as { aborted?: unknown } | undefined)?.aborted !== true;
  return false;
}

// ---------------------------------------------------------------------------
// 永続インデックス（#205）: 過去日のJSONLは追記されない（不変）ことを利用し、練習日判定と
// sessionId→日付の対応をファイル単位でメモ化する。ファイルの size/mtimeMs が記録時と一致する
// あいだは中身を読み直さないため、読み込み量は「新規・変化したファイル分」だけに限られ、
// 履歴総量（利用日数）に比例しない。インデックスは派生キャッシュであり、壊れていれば
// 全再走査で作り直す（ユーザーデータそのものには一切触れない）。
// ---------------------------------------------------------------------------

/** インデックスの保存先ファイル名（DATE_LOG_PATTERN に一致しないため、ログ列挙には決して混ざらない）。 */
export const SESSION_INDEX_FILE = ".session-index.json";
const SESSION_INDEX_VERSION = 1;

type IndexedLogFile = {
  size: number;
  mtimeMs: number;
  practice: boolean;
  sessionIds: string[];
};

type SessionLogIndex = {
  version: number;
  files: Record<string, IndexedLogFile>;
};

function isValidIndexedLogFile(x: unknown): x is IndexedLogFile {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Partial<IndexedLogFile>;
  return typeof e.size === "number" && typeof e.mtimeMs === "number" && typeof e.practice === "boolean"
    && Array.isArray(e.sessionIds) && e.sessionIds.every((s) => typeof s === "string");
}

/** 保存済みインデックスを読む。欠損・破損・版不一致は空扱い（=全再走査で作り直す）。 */
function loadSessionLogIndex(dir: string): SessionLogIndex {
  const empty: SessionLogIndex = { version: SESSION_INDEX_VERSION, files: {} };
  const file = path.join(dir, SESSION_INDEX_FILE);
  if (!existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SessionLogIndex>;
    if (parsed?.version !== SESSION_INDEX_VERSION) return empty;
    if (typeof parsed.files !== "object" || parsed.files === null) return empty;
    const files: Record<string, IndexedLogFile> = {};
    for (const [name, entry] of Object.entries(parsed.files)) {
      if (DATE_LOG_PATTERN.test(name) && isValidIndexedLogFile(entry)) files[name] = entry;
    }
    return { version: SESSION_INDEX_VERSION, files };
  } catch {
    return empty;
  }
}

/** best-effort の原子的保存（temp→rename）。書けなくても呼び出し元の結果には影響させない。 */
function saveSessionLogIndex(dir: string, index: SessionLogIndex): void {
  const file = path.join(dir, SESSION_INDEX_FILE);
  const tempPath = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, JSON.stringify(index), "utf8");
    renameSync(tempPath, file);
  } catch (err) {
    console.warn(`session-log: index write failed for ${file}: ${String(err)}`);
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // 掃除失敗は無視（次回の書き込みで上書き・renameされる）
    }
  }
}

/**
 * インデックスを現状に同期する。size/mtimeMs が記録時と一致するファイルは読み直さず、
 * 新規・変化したファイルだけ全行を読んで判定し直す（当日ファイルは追記のたびにここで再判定される）。
 */
function refreshSessionLogIndex(dir: string): SessionLogIndex {
  const previous = loadSessionLogIndex(dir);
  const files: Record<string, IndexedLogFile> = {};
  let changed = false;
  for (const name of readdirSync(dir)) {
    if (!DATE_LOG_PATTERN.test(name)) continue;
    let stat;
    try {
      stat = statSync(path.join(dir, name));
    } catch {
      continue; // 列挙とstatの間に消えた等。存在しないものとして扱う
    }
    const cached = previous.files[name];
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      files[name] = cached;
      continue;
    }
    const events = readEvents(path.join(dir, name));
    files[name] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      practice: events.some(isPracticeActivity),
      sessionIds: [...new Set(events.map((e) => e.sessionId))],
    };
    changed = true;
  }
  if (Object.keys(previous.files).some((name) => !(name in files))) changed = true;
  const index: SessionLogIndex = { version: SESSION_INDEX_VERSION, files };
  if (changed) saveSessionLogIndex(dir, index);
  return index;
}

/** 練習を実施した日の一覧。起動だけで作られた既存ログは表示対象から除外する。 */
export function listPracticeDays(dir: string = SESSIONS_DIR): string[] {
  if (!existsSync(dir)) return [];
  const index = refreshSessionLogIndex(dir);
  return Object.entries(index.files)
    .filter(([, entry]) => entry.practice)
    .map(([name]) => name.slice(0, -6))
    .sort();
}

/** 日付ファイルを跨いで対象sessionだけを抽出し、timestampと記録順で安定ソートする。 */
export function readSessionEvents(sessionId: string, dir: string = SESSIONS_DIR): SessionEvent[] {
  if (!existsSync(dir)) return [];
  const index = refreshSessionLogIndex(dir);
  let sequence = 0;
  return Object.entries(index.files)
    .filter(([, entry]) => entry.sessionIds.includes(sessionId))
    .map(([name]) => name)
    .sort()
    .flatMap((file) => readEvents(path.join(dir, file)))
    .map((event) => ({ event, sequence: sequence++ }))
    .filter(({ event }) => event.sessionId === sessionId)
    .sort((a, b) => a.event.ts.localeCompare(b.event.ts) || a.sequence - b.sequence)
    .map(({ event }) => event);
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
      const m = e.meta as { block?: string; elapsedSec?: number; transcript?: string; sttFailed?: boolean } | undefined;
      if (!m || m.block !== "four-three-two") continue;
      // STT（whisper）失敗ラウンドは transcript が空のまま記録されるが、これは技術障害であって
      // 英語力の低さのシグナルではないため、観測対象（totalRounds/lowRoundsどちらも）から除外する
      if (m.sttFailed === true) continue;
      totalRounds++;
      const elapsed = typeof m.elapsedSec === "number" ? m.elapsedSec : 0;
      const words = (m.transcript ?? "").trim().split(/\s+/).filter(Boolean).length;
      if (elapsed >= FTT_ENGAGED_SEC && words < FTT_WORDS_FLOOR) lowRounds++;
    }
  }
  return { lowRounds, totalRounds };
}
