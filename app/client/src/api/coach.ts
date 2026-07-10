import { extractErrorMessage } from "./http";

export type AeItem = { quote: string; issue: string; better: string; why_ja: string };
export type CollectedChunkStatus = "saved" | "none" | "failed";
export type CollectedChunkItem = { id: number; promptText: string; en: string };
export type CollectedChunks = {
  collectedChunks: number;
  collectedChunkItems: CollectedChunkItem[];
  collectedChunkStatus: CollectedChunkStatus;
};
export type AeFeedback = { items: AeItem[]; praise: string } & CollectedChunks;
export type Reflection = {
  goodPhrases: string[];
  fixes: Array<{ original: string; better: string }>;
  noteForTomorrow_ja: string;
} & CollectedChunks;
export type PrepPack = { chunks: Array<{ en: string; ja: string }>; outline: string[]; hintDefault: "ja" | "en" };

export async function fetchAeFeedback(transcript: string, topicTitle: string): Promise<AeFeedback> {
  const res = await fetch("/api/feedback/ae", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript, topicTitle }),
  });
  if (!res.ok) throw new Error(`AE feedback failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function fetchModelTalk(topicId: string): Promise<string> {
  const res = await fetch("/api/coach/model-talk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topicId }),
  });
  if (!res.ok) throw new Error(`model talk failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}

export async function fetchReflection(sessionId: string): Promise<Reflection> {
  const res = await fetch("/api/coach/reflection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error(`reflection failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

/**
 * トピックID→PrepPack のセッション内キャッシュ（進行中Promise共有）。音読ウォームアップと4/3/2準備フェーズが
 * 同じトピックのパックを要求するため、Claude呼び出しをセッションあたり1回に抑える。
 * 失敗時は削除して再試行可能。
 */
const prepPackCache = new Map<string, Promise<PrepPack>>();

export async function fetchPrepPack(topicId: string): Promise<PrepPack> {
  let p = prepPackCache.get(topicId);
  if (!p) {
    p = (async () => {
      const res = await fetch("/api/coach/prep", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topicId }),
      });
      if (!res.ok) throw new Error(`prep failed: ${await extractErrorMessage(res)}`);
      return (await res.json()) as PrepPack;
    })();
    p.catch(() => prepPackCache.delete(topicId));
    prepPackCache.set(topicId, p);
  }
  return p;
}

/** モデルトークの日本語訳＋表現解説（サーバ側で本文ハッシュキャッシュ・2回目以降は即返る） */
export async function fetchTalkExplanation(text: string): Promise<string> {
  const res = await fetch("/api/coach/talk-explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`talk explain failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}

/** AI発話の日本語訳のみ（サーバ側で本文ハッシュキャッシュ・2回目以降は即返る） */
export async function fetchUtteranceTranslation(text: string): Promise<string> {
  const res = await fetch("/api/coach/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`translate failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}

export type PhraseHint = { en: string; ja: string };

/** 言い方ヒント: 言いたい日本語＋直近履歴 → 使える英語表現2〜3個 */
export async function fetchPhraseHints(
  jaText: string,
  history?: Array<{ role: "you" | "ai"; text: string }>,
): Promise<PhraseHint[]> {
  const res = await fetch("/api/coach/phrase-hint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jaText, history }),
  });
  if (!res.ok) throw new Error(`phrase hint failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { suggestions: PhraseHint[] }).suggestions;
}

/** 訂正（original→better）の詳しい日本語解説（キャッシュなし・ボタン起点のオンデマンド生成） */
export async function fetchFixExplanation(original: string, better: string, note?: string): Promise<string> {
  const res = await fetch("/api/coach/fix-explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ original, better, note }),
  });
  if (!res.ok) throw new Error(`fix explain failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}
