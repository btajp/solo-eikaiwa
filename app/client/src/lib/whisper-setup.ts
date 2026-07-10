const KEY = "setupBanner.dismissed";

/**
 * whisperモデル未導入セットアップバナーの既読フラグ（ブラウザプロファイル単位・localStorage永続）。
 * llm-notice.ts と同じ「明示的に閉じるまで表示し続ける」パターン（自動既読化はしない）。
 */
export function isSetupBannerDismissed(): boolean {
  return localStorage.getItem(KEY) === "1";
}

export function dismissSetupBanner(): void {
  localStorage.setItem(KEY, "1");
}

/**
 * 「後で」を選んだセットアップを、アプリ内の常設導線から再び開く。
 * ダウンロード状態はサーバ側の setup status が保持しているため、フラグだけを戻せば
 * SetupBanner のポーリングが進捗・再開可能状態を復元する。
 */
export function resumeSetupBanner(): void {
  localStorage.removeItem(KEY);
}

/**
 * バナー表示条件の純関数（App.tsxから抽出・単体テスト対象）。
 * `health.modelFile === false` で厳密比較する（`!health.modelFile` ではない）: llm-notice.ts の
 * shouldShowLlmNotice と同じ理由 — 旧バージョンのサーバが返す health 応答には `modelFile` 自体が
 * 存在せず undefined になりうるため、`=== false` で非表示側にフォールバックする。
 */
export function shouldShowSetupBanner(
  health: { modelFile?: boolean } | null,
  dismissed: boolean,
): boolean {
  return health != null && health.modelFile === false && !dismissed;
}

/** 閉じた後もモデル未導入中は常設する、セットアップへ戻るための小さな導線。 */
export function shouldShowSetupResume(
  health: { modelFile?: boolean } | null,
  dismissed: boolean,
): boolean {
  return health != null && health.modelFile === false && dismissed;
}

/** ダウンロード進捗率（0-100の整数）。totalBytes<=0はゼロ除算回避で0、receivedがtotalを超える場合は100にクランプする。 */
export function progressPercent(receivedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((receivedBytes / totalBytes) * 100)));
}

/** バイト数を進捗表示用に人間可読化する（1GB未満はMB整数、以上はGB小数2桁）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** ポーリングを続けるべきステータスか（ダウンロード本体の進行中のみ）。 */
export function isDownloadActive(status: string): boolean {
  return status === "downloading" || status === "verifying";
}
