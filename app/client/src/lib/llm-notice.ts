const KEY = "llmNotice.dismissed";

/**
 * 「Claude/Codex/ローカルLLM未導入だと会話系が動かない」案内バナーの既読フラグ（ブラウザプロファイル単位・localStorage永続）。
 * SentencesScreen の hideNote 等と同じ「明示的に閉じるまで表示し続ける」パターン（自動既読化はしない —
 * ユーザーが実際に閉じた操作だけを「もう見た」とみなす）。
 */
export function isLlmNoticeDismissed(): boolean {
  return localStorage.getItem(KEY) === "1";
}

export function dismissLlmNotice(): void {
  localStorage.setItem(KEY, "1");
}
