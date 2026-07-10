import { extractErrorMessage } from "./http";

export type SentenceSrs = { stage: number; due: string; reviews: number };
export type SentenceItem = {
  no: number; category_no: number; category: string;
  domain: "daily" | "business" | "it";
  en: string; ja: string; note: string;
  srs: SentenceSrs | null;
};

export type ChunkSrs = SentenceSrs;
export type ChunkQueueItem = {
  kind: "chunk";
  id: number;
  promptText: string;
  en: string;
  note: string;
  srs: ChunkSrs;
};
export type SentenceQueueItem = SentenceItem & { kind: "sentence" };
export type QueueItem = SentenceQueueItem | ChunkQueueItem;

export type ChunkListItem = {
  id: number; created: string; source: "ae" | "reflection";
  promptText: string; en: string; note: string; srs: ChunkSrs;
};

export async function fetchChunks(): Promise<ChunkListItem[]> {
  const res = await fetch("/api/chunks");
  if (!res.ok) throw new Error(`chunks failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { chunks: ChunkListItem[] }).chunks;
}

export async function gradeChunk(
  id: number, grade: "good" | "soso" | "bad", answerId: string,
): Promise<{ id: number; stage: number; due: string }> {
  const res = await fetch("/api/chunks/grade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, grade, answerId }),
  });
  if (!res.ok) throw new Error(`grade failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function deleteChunk(id: number): Promise<void> {
  const res = await fetch(`/api/chunks/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${await extractErrorMessage(res)}`);
}

export async function fetchSentences(): Promise<SentenceItem[]> {
  const res = await fetch("/api/sentences");
  if (!res.ok) throw new Error(`sentences failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { sentences: SentenceItem[] }).sentences;
}

export async function fetchSentenceQueue(newCount = 10): Promise<QueueItem[]> {
  const res = await fetch(`/api/sentences/queue?new=${newCount}`);
  if (!res.ok) throw new Error(`queue failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { queue: QueueItem[] }).queue;
}

export async function gradeSentence(
  no: number, grade: "good" | "soso" | "bad", answerId: string,
): Promise<{ no: number; stage: number; due: string }> {
  const res = await fetch("/api/sentences/grade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ no, grade, answerId }),
  });
  if (!res.ok) throw new Error(`grade failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

/** 例文の詳しい解説（サーバ側でキャッシュされ、2回目以降は即返る） */
export async function fetchSentenceExplanation(no: number): Promise<string> {
  const res = await fetch("/api/sentences/explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ no }),
  });
  if (!res.ok) throw new Error(`explain failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}
