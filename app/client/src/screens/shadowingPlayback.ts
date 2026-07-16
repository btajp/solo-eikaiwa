export type ShadowingPlaybackOutcome = "completed" | "stopped" | "failed";

/**
 * 再生の結果を、聴取記録と次の表示に分けて決める。停止は失敗として扱わない。
 * 全編再生は「聞いた」の記録にとどめ、有効練習（声に出した）は自己確認で別に記録する（#181）。
 */
export function resolveShadowingPlaybackOutcome(outcome: ShadowingPlaybackOutcome): {
  nextState: "ready";
  listened: boolean;
  showRetry: boolean;
} {
  return {
    nextState: "ready",
    listened: outcome === "completed",
    showRetry: outcome === "failed",
  };
}

/** 「聞いた」と「声に出した」を区別する実施状態。マイクを使わず自己申告で記録する（#181）。 */
export type ShadowingProgress = { listened: boolean; spokenConfirmed: boolean };

export function initialShadowingProgress(): ShadowingProgress {
  return { listened: false, spokenConfirmed: false };
}

export function markListened(progress: ShadowingProgress): ShadowingProgress {
  return progress.listened ? progress : { ...progress, listened: true };
}

/** 自己確認は全編再生後にだけ出す。確認済みなら再度の操作対象にしない。 */
export function canConfirmSpoken(progress: ShadowingProgress): boolean {
  return progress.listened && !progress.spokenConfirmed;
}

/** 声に出した自己申告。初回だけ firstConfirmation=true を返し、有効試行の重複発火を防ぐ。 */
export function confirmSpoken(progress: ShadowingProgress): {
  progress: ShadowingProgress;
  firstConfirmation: boolean;
} {
  if (!canConfirmSpoken(progress)) return { progress, firstConfirmation: false };
  return { progress: { ...progress, spokenConfirmed: true }, firstConfirmation: true };
}
