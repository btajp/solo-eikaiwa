import { extractErrorMessage } from "./http";

export type ListeningFormat = "monologue" | "dialogue";
export type ListeningTurn = { speaker: string; text: string };
export type ListeningMeta = {
  id: string; title: string; titleJa: string;
  domain: "daily" | "business" | "it"; level: [number, number];
  /** #220: 2話者対話素材の識別（省略時は従来のmonologue扱い） */
  format?: ListeningFormat;
  speakers?: string[];
};
export type ListeningDetail = ListeningMeta & {
  paragraphs: string[];
  /** #220: dialogue のみ。ラベル抜きの発話ターン（表示は話者ラベル付き・再生は結合テキスト1本） */
  turns?: ListeningTurn[];
};

export async function fetchListeningLibrary(): Promise<{ items: ListeningMeta[]; weeklyCount: number }> {
  const res = await fetch("/api/listening");
  if (!res.ok) throw new Error(`listening failed: ${await extractErrorMessage(res)}`);
  return (await res.json()) as { items: ListeningMeta[]; weeklyCount: number };
}

export async function fetchListeningItem(id: string): Promise<ListeningDetail> {
  const res = await fetch(`/api/listening/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`listening item failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { item: ListeningDetail }).item;
}

/** 1回の聴取を記録し、更新後の「今週n本」を返す（情報表示のみ・ノルマなし）。 */
export async function logListening(itemId: string, attemptId: string): Promise<{ weeklyCount: number }> {
  const res = await fetch("/api/listening/log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemId, attemptId }),
  });
  if (!res.ok) throw new Error(`listening log failed: ${await extractErrorMessage(res)}`);
  return (await res.json()) as { weeklyCount: number };
}
