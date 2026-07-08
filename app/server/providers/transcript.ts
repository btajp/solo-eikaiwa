/** 1往復分の発話（プロバイダ横断でインメモリ会話履歴を表す共通単位）。 */
export type ChatTurn = { role: "user" | "assistant"; content: string };

/**
 * resumeId が store に居ればそれをそのまま返し、いなければ新しい UUID を返す。
 * 未知の resumeId を渡された場合も黙って新セッションとして扱う（既存3実装の共通規約）。
 */
export function resolveSessionId(store: Map<string, ChatTurn[]>, resumeId: string | undefined): string {
  return resumeId && store.has(resumeId) ? resumeId : crypto.randomUUID();
}

/** user/assistant の1往復を、既存履歴の末尾に追記した新しい配列として store に保存する。 */
export function appendTurn(store: Map<string, ChatTurn[]>, sessionId: string, userText: string, assistantText: string): void {
  const history = store.get(sessionId) ?? [];
  store.set(sessionId, [
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: assistantText },
  ]);
}
