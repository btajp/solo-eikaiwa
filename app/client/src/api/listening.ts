import { extractErrorMessage } from "./http";

export type ListeningMeta = {
  id: string; title: string; titleJa: string;
  domain: "daily" | "business" | "it"; level: [number, number];
};
export type ListeningDetail = ListeningMeta & { paragraphs: string[] };

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
