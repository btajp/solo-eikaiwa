const RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

/** server down 時だけ行う限定再接続の待機時間。範囲外は自動再試行しない。 */
export function healthRetryDelay(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return RETRY_DELAYS_MS[attempt - 1] ?? null;
}
