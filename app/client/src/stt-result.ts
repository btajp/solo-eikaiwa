/**
 * 音声認識の応答を、利用者の発話量とは独立した技術結果として分類する。
 * 空文字は「何も話さなかった」と決めつけず、再録音可能な失敗として扱う。
 */
export type SttOutcome =
  | { kind: "success"; text: string }
  | { kind: "empty" }
  | { kind: "error"; error: unknown };

export async function resolveSttOutcome(read: () => Promise<string>): Promise<SttOutcome> {
  try {
    const text = (await read()).trim();
    return text ? { kind: "success", text } : { kind: "empty" };
  } catch (error) {
    return { kind: "error", error };
  }
}
