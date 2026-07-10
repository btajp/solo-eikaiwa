import { extractErrorMessage } from "./http";

export type ModelTalkEntry = {
  id: number; createdAt: string; topicId: string; topicTitle: string; topicTitleJa?: string; text: string;
};

export async function fetchModelTalkLibrary(): Promise<ModelTalkEntry[]> {
  const res = await fetch("/api/library/model-talks");
  if (!res.ok) throw new Error(`library failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { entries: ModelTalkEntry[] }).entries;
}
