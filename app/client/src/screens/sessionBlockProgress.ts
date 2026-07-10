/** セッション親が受け取る子ブロックの進行状態。準備と有効な実施を分け、未実施のXP付与を防ぐ。 */
export type SessionBlockProgress = { ready: boolean; validAttempt: boolean };

export const SESSION_BLOCK_KINDS = [
  "warmup-reading",
  "four-three-two",
  "roleplay",
  "shadowing",
  "reflection",
] as const;

export type BlockCompletionGate = "preparing" | "needs-attempt" | "ready";

/** 4/3/2はラウンド・フィードバックを完走して初めて親の「次へ」を見せる。 */
export function requiresInternalCompletion(kind: string): boolean {
  return kind === "four-three-two";
}

export function initialBlockProgress(): SessionBlockProgress {
  return { ready: false, validAttempt: false };
}

export function markBlockReady(progress: SessionBlockProgress): SessionBlockProgress {
  return progress.ready ? progress : { ...progress, ready: true };
}

/** 準備済みのブロックだけが有効な実施を報告できる。古い子画面からの早すぎる通知も無視する。 */
export function markValidAttempt(progress: SessionBlockProgress): SessionBlockProgress {
  return progress.ready && !progress.validAttempt ? { ...progress, validAttempt: true } : progress;
}

export function blockCompletionGate(progress: SessionBlockProgress): BlockCompletionGate {
  if (!progress.ready) return "preparing";
  return progress.validAttempt ? "ready" : "needs-attempt";
}
