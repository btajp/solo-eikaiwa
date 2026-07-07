import { extractErrorMessage } from "./http";

export type LevelProposal = {
  kind: "up" | "down";
  toLevel: number;
  rationale: {
    xpReached?: boolean; practicedDays14?: number; completionRate?: number | null; fttAborts?: number; lowOutputRounds?: number;
    /** down提案で実際に発火した条件のみ（省略時は表示側で従来どおりのフォールバック表示） */
    triggers?: string[];
  };
};
export type ProgressSummary = {
  level: number; xp: number; xpIntoLevel: number; xpToNext: number;
  stage: number; difficultyMaxed: boolean; proposal: LevelProposal | null;
};

/**
 * summary 更新の軽量Pub/Sub。サイドバーのゲージ等、複数箇所で summary を表示する画面が
 * XP付与・レベル操作の直後に最新値へ追従できるようにする（再取得のポーリングは行わない）。
 */
let progressListeners: Array<(s: ProgressSummary) => void> = [];

/** 購読する。戻り値を呼ぶと購読解除される */
export function onProgressUpdate(fn: (s: ProgressSummary) => void): () => void {
  progressListeners.push(fn);
  return () => { progressListeners = progressListeners.filter((f) => f !== fn); };
}

export function notifyProgress(s: ProgressSummary): void {
  for (const fn of progressListeners) fn(s);
}

/**
 * summary を返す POST の共通ラッパ。成功時に必ず notifyProgress を呼ぶことで、
 * XP付与・レベル操作・プレースメント確定の3経路で手書きしていた notify 結線を1箇所に集約する。
 */
export async function postForSummary(url: string, body: unknown): Promise<ProgressSummary> {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  const summary = (await res.json()) as ProgressSummary;
  notifyProgress(summary);
  return summary;
}

export async function fetchProgressSummary(): Promise<ProgressSummary> {
  const res = await fetch("/api/progress/summary");
  if (!res.ok) throw new Error(`progress summary failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function progressBlockStart(kind: string): Promise<number> {
  const res = await fetch("/api/progress/block-start", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }),
  });
  if (!res.ok) throw new Error(`block-start failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { attemptId: number }).attemptId;
}

export function progressBlockXp(amount: number, attemptId: number | null): Promise<ProgressSummary> {
  return postForSummary("/api/progress/xp", { kind: "block", amount, attemptId: attemptId ?? undefined });
}

export function progressLevelAction(
  action: "accept" | "decline" | "set", level?: number,
): Promise<ProgressSummary> {
  return postForSummary("/api/progress/level", { action, level });
}

export async function fetchPracticeDays(): Promise<string[]> {
  const res = await fetch("/api/progress/days");
  if (!res.ok) throw new Error(`practice days failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { days: string[] }).days;
}
