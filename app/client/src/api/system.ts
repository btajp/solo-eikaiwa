import { extractErrorMessage } from "./http";

export type Health = {
  ok: boolean; whisper: boolean; ffmpeg: boolean; claude: boolean; ttsKey: boolean; modelFile: boolean;
  /** Tauri Phase 2: サーバの身元確認用（デスクトップの attach-first が別アプリに繋がっていないかの検証等）。既存フィールドへの additive 追加。 */
  app: string; version: string;
  /** claude/codex/openai/openai-compatのいずれかの会話系ルートが実際に使えるかの集約判定。 */
  llmReady: boolean;
};

export async function getHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`health failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function sttUpload(blob: Blob): Promise<string> {
  const res = await fetch("/api/stt", {
    method: "POST",
    headers: { "content-type": blob.type || "audio/webm" },
    body: blob,
  });
  if (!res.ok) throw new Error(`STT failed: ${await extractErrorMessage(res)}`);
  return (await res.json()).text as string;
}
