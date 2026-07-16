/**
 * 4/3/2 の AE フィードバック（コーチのヒント）取得失敗後に再試行ボタンを出せるか (#200)。
 * transcript は transcriptsRef に残っているため、一時的な LLM 障害なら再要求で回復できる。
 * 取得中は二重要求を防ぐため出さない。transcript が空なら再試行しても 400 になるだけなので出さない。
 */
export function canRetryAeFeedback(args: { errorMsg: string; aeLoading: boolean; transcript: string }): boolean {
  return args.errorMsg.length > 0 && !args.aeLoading && args.transcript.trim().length > 0;
}
