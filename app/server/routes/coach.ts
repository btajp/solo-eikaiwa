import { createHash } from "node:crypto";
import type { AeFeedback, Reflection, PrepPack } from "../coach";
import type { LibraryStore, TalkExplainCache } from "../db";
import type { ChunkStore, CollectCandidate } from "../chunks";
import { json, parseJsonBody, exact, type RouteEntry } from "./http";
import { collectBestEffort } from "./chunks";

export type CoachRoutesDeps = {
  aeFeedback: (args: { transcript: string; topicTitle: string }) => Promise<AeFeedback>;
  /** 未知の topicId は null（ルートは404を返す）。topicTitle はライブラリ記録用（レスポンスには含めない） */
  modelTalk: (topicId: string) => Promise<{ text: string; topicTitle?: string } | null>;
  /** モデルトークの記録と一覧（実体は db.ts、テストはフェイク/インメモリ） */
  libraryStore: LibraryStore;
  reflection: () => Promise<Reflection>;
  /** 未知の topicId は null（ルートは404を返す） */
  prepPack: (topicId: string) => Promise<PrepPack | null>;
  /** モデルトークの日本語訳＋表現解説を生成（実体は coach.ts、テストはフェイク） */
  explainTalk: (text: string) => Promise<{ text: string }>;
  /** モデルトーク解説のキャッシュ（実体は db.ts、テストはフェイク） */
  talkExplainCache: TalkExplainCache;
  /** AI発話の日本語訳のみを生成（実体は coach.ts、テストはフェイク） */
  translate: (text: string) => Promise<{ text: string }>;
  /** 訳のハッシュキャッシュ（実体は db.ts の utterance_translations、テストはフェイク） */
  translationCache: TalkExplainCache;
  /** 言い方ヒント（会話コンテキスト付き・実体は coach.ts、テストはフェイク） */
  phraseHint: (args: { jaText: string; history?: Array<{ role: "you" | "ai"; text: string }> }) => Promise<{ suggestions: Array<{ en: string; ja: string }> }>;
  /** 詰まった表現の収集チャンク（実体は chunks.ts、テストはフェイク） */
  chunkStore: ChunkStore;
};

async function handleAeFeedback(req: Request, deps: CoachRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ transcript?: string; topicTitle?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const { transcript, topicTitle } = parsed.body;
  if (!transcript?.trim()) return json({ error: "transcript is required" }, 400);
  const fb = await deps.aeFeedback({ transcript, topicTitle: topicTitle ?? "" });
  const cands: CollectCandidate[] = fb.items
    .filter((i) => i.quote?.trim() && i.better?.trim())
    .map((i) => ({ source: "ae" as const, promptText: i.quote, en: i.better, note: i.why_ja?.trim() || i.issue || "" }));
  return json({ ...fb, collectedChunks: collectBestEffort(deps.chunkStore, cands) });
}

async function handleReflection(deps: CoachRoutesDeps): Promise<Response> {
  const refl = await deps.reflection();
  const cands: CollectCandidate[] = refl.fixes
    .filter((f) => f.original?.trim() && f.better?.trim())
    .map((f) => ({ source: "reflection" as const, promptText: f.original, en: f.better, note: "" }));
  return json({ ...refl, collectedChunks: collectBestEffort(deps.chunkStore, cands) });
}

async function handleModelTalk(req: Request, deps: CoachRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ topicId?: string }>(req);
  if (!parsed.ok) return parsed.response;
  if (!parsed.body.topicId?.trim()) return json({ error: "topicId is required" }, 400);
  const talk = await deps.modelTalk(parsed.body.topicId);
  if (!talk) return json({ error: "unknown topicId" }, 404);
  try {
    deps.libraryStore.saveModelTalk({
      topicId: parsed.body.topicId,
      topicTitle: talk.topicTitle ?? "",
      text: talk.text,
    });
  } catch (err) {
    console.warn("[library] saveModelTalk failed, continuing:", String(err));
  }
  return json({ text: talk.text });
}

async function handlePrep(req: Request, deps: CoachRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ topicId?: string }>(req);
  if (!parsed.ok) return parsed.response;
  if (!parsed.body.topicId?.trim()) return json({ error: "topicId is required" }, 400);
  const pack = await deps.prepPack(parsed.body.topicId);
  if (!pack) return json({ error: "unknown topicId" }, 404);
  return json(pack);
}

/** {text} を受け取りハッシュキャッシュ経由で {text} を返す共通ハンドラ（talk-explain / translate 共有） */
async function respondHashCached(
  req: Request,
  cache: TalkExplainCache,
  generate: (text: string) => Promise<{ text: string }>,
  cacheWarnLabel: string,
): Promise<Response> {
  const parsed = await parseJsonBody<{ text?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { text } = parsed.body;
  if (typeof text !== "string" || text.trim().length === 0) return json({ error: "text must be a non-empty string" }, 400);
  if (text.length > 3000) return json({ error: "text too long" }, 400);
  const hash = createHash("sha256").update(text).digest("hex");
  const cached = cache.get(hash);
  if (cached !== null) return json({ text: cached });
  const generated = await generate(text);
  // キャッシュ書き込み失敗は返却を妨げない
  try {
    cache.save(hash, generated.text, new Date().toISOString());
  } catch (err) {
    console.warn(cacheWarnLabel, String(err));
  }
  return json({ text: generated.text });
}

async function handlePhraseHint(req: Request, deps: CoachRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ jaText?: unknown; history?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { jaText, history } = parsed.body;
  if (typeof jaText !== "string" || jaText.trim().length === 0) return json({ error: "jaText must be a non-empty string" }, 400);
  if (jaText.length > 1000) return json({ error: "jaText too long" }, 400);
  // 履歴は任意。role/text が揃った要素だけ残し、直近6件までに絞ってプロンプト肥大を防ぐ
  const safeHistory = Array.isArray(history)
    ? history
        .filter((h): h is { role: "you" | "ai"; text: string } =>
          !!h && typeof h === "object" && (h.role === "you" || h.role === "ai") && typeof h.text === "string")
        .slice(-6)
    : undefined;
  const result = await deps.phraseHint({ jaText, history: safeHistory });
  return json(result);
}

export function makeCoachRoutes(deps: CoachRoutesDeps): RouteEntry[] {
  return [
    exact("POST", "/api/feedback/ae", (req) => handleAeFeedback(req, deps)),
    exact("POST", "/api/coach/model-talk", (req) => handleModelTalk(req, deps)),
    exact("POST", "/api/coach/prep", (req) => handlePrep(req, deps)),
    exact("POST", "/api/coach/reflection", () => handleReflection(deps)),
    exact("POST", "/api/coach/talk-explain", (req) =>
      respondHashCached(req, deps.talkExplainCache, deps.explainTalk, "[coach] talk explanation cache write failed, continuing:")),
    exact("POST", "/api/coach/translate", (req) =>
      respondHashCached(req, deps.translationCache, deps.translate, "[coach] translation cache write failed, continuing:")),
    exact("POST", "/api/coach/phrase-hint", (req) => handlePhraseHint(req, deps)),
  ];
}
