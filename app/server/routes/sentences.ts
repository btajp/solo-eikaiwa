import { json, parseJsonBody, exact, bestEffort, type RouteEntry } from "./http";
import { xpForGrade } from "../progression";
import { GRADES, type Grade, type SentenceStore } from "../sentences";
import type { Chunk, ChunkStore } from "../chunks";
import type { ProgressStore } from "../progress-store";

export type SentenceRoutesDeps = {
  sentenceStore: SentenceStore;
  chunkStore: ChunkStore;
  progressStore: ProgressStore;
  /** 例文の詳しい解説を生成（キャッシュは sentenceStore 側。実体は coach.ts、テストはフェイク） */
  explainSentence: (s: { en: string; ja: string; note: string }) => Promise<{ text: string }>;
};

function handleSentenceQueue(url: URL, deps: SentenceRoutesDeps): Response {
  const raw = url.searchParams.get("new") ?? "10";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 50) {
    return json({ error: "new must be an integer between 0 and 50" }, 400);
  }
  const sentences = deps.sentenceStore.queue(n).map((s) => ({ kind: "sentence" as const, ...s }));
  // 期限到来チャンクは復習例文より先頭。読み取り失敗時は例文キューだけで継続
  let chunks: Array<{ kind: "chunk" } & Omit<Chunk, "created" | "source">> = [];
  bestEffort("[chunks] dueChunks failed, continuing with sentences only:", () => {
    chunks = deps.chunkStore.dueChunks().map((c) => ({
      kind: "chunk" as const, id: c.id, promptText: c.promptText, en: c.en, note: c.note, srs: c.srs,
    }));
  });
  return json({ queue: [...chunks, ...sentences] });
}

async function handleSentenceGrade(req: Request, deps: SentenceRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ no?: unknown; grade?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { no, grade } = parsed.body;
  if (typeof no !== "number" || !Number.isInteger(no)) return json({ error: "no must be an integer" }, 400);
  if (!(GRADES as readonly string[]).includes(grade as string)) {
    return json({ error: `grade must be one of: ${GRADES.join(", ")}` }, 400);
  }
  const r = deps.sentenceStore.grade(no, grade as Grade);
  if (!r) return json({ error: `unknown sentence no: ${no}` }, 400);
  // 自己評価1枚ごとの努力XP（good=2 / soso=1 / bad=1）。付与失敗で採点自体は失敗させない
  bestEffort("[progress] srs-grade xp failed, continuing:", () =>
    deps.progressStore.addXp("srs-grade", xpForGrade(grade as Grade), { no }));
  return json(r);
}

async function handleSentenceExplain(req: Request, deps: SentenceRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ no?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { no } = parsed.body;
  if (typeof no !== "number" || !Number.isInteger(no)) return json({ error: "no must be an integer" }, 400);
  const cached = deps.sentenceStore.getExplanation(no);
  if (cached !== null) return json({ no, text: cached });
  const sentence = deps.sentenceStore.find(no);
  if (!sentence) return json({ error: `unknown sentence no: ${no}` }, 400);
  const generated = await deps.explainSentence(sentence);
  // キャッシュ書き込み失敗は解説の返却を妨げない
  bestEffort("[sentences] explanation cache write failed, continuing:", () =>
    deps.sentenceStore.saveExplanation(no, generated.text));
  return json({ no, text: generated.text });
}

export function makeSentenceRoutes(deps: SentenceRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/sentences", () => json({ sentences: deps.sentenceStore.list() })),
    exact("GET", "/api/sentences/queue", (_req, url) => handleSentenceQueue(url, deps)),
    exact("POST", "/api/sentences/grade", (req) => handleSentenceGrade(req, deps)),
    exact("POST", "/api/sentences/explain", (req) => handleSentenceExplain(req, deps)),
  ];
}
