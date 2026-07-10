import { extractErrorMessage } from "./http";

export async function converse(
  userText: string,
  activitySessionId: string,
  sessionId?: string,
  scenarioId?: string,
): Promise<{ replyText: string; sessionId: string }> {
  const res = await fetch("/api/converse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userText, activitySessionId, sessionId, scenarioId }),
  });
  if (!res.ok) throw new Error(`converse failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function ttsFetch(text: string): Promise<Blob> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`TTS failed: ${await extractErrorMessage(res)}`);
  return res.blob();
}

/**
 * sessionId はアプリ起動時に mint するクライアント側セッションUUID（省略可・後方互換）。
 * converse() が返す会話用 sessionId とは別概念で、ライフサイクル/ブロック/ラウンドイベントの突合に使う。
 */
export async function sessionStart(sessionId?: string): Promise<void> {
  await fetch("/api/session/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

export async function sessionEnd(sessionId: string): Promise<void> {
  await fetch("/api/session/end", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

/**
 * タブを閉じる/リロード時にも session_end を届けるための keepalive 送信。
 * pagehide からの呼び出し想定なので await しない（fire-and-forget）。
 */
export function sessionEndKeepalive(sessionId: string): void {
  void fetch("/api/session/end", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
    keepalive: true,
  }).catch(() => {});
}

export function sendSessionEvent(
  type: "block_start" | "block_end" | "round_start" | "round_end",
  sessionId: string | undefined,
  meta?: Record<string, unknown>,
): void {
  // 進行イベントは fire-and-forget（記録失敗でセッションを止めない）
  void fetch("/api/session/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, sessionId, meta }),
  }).catch(() => {});
}
