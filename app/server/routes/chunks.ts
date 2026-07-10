import type { Chunk, ChunkStore, CollectCandidate } from "../chunks";
import { GRADES, type Grade } from "../sentences";
import type { ProgressStore } from "../progress-store";
import type { SrsReviewStore } from "../srs-review-store";
import { xpForGrade } from "../progression";
import { json, parseJsonBody, exact, prefix, type RouteEntry } from "./http";
import { isIdempotencyKey } from "../idempotency-key";

export type ChunkRoutesDeps = {
  chunkStore: ChunkStore;
  progressStore: ProgressStore;
  srsReviewStore: SrsReviewStore;
};

export type CollectedChunksOutcome = {
  status: "saved" | "none" | "failed";
  chunks: Chunk[];
};

/** 収集はベストエフォート — 失敗しても親のコーチング応答を失敗させない。 */
export function collectBestEffort(chunkStore: ChunkStore, cands: CollectCandidate[]): CollectedChunksOutcome {
  try {
    const chunks = chunkStore.collect(cands);
    return { status: chunks.length > 0 ? "saved" : "none", chunks };
  } catch (err) {
    console.warn("[chunks] collect failed, continuing:", String(err));
    return { status: "failed", chunks: [] };
  }
}

async function handleChunkGrade(req: Request, deps: ChunkRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ id?: unknown; grade?: unknown; answerId?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { id, grade, answerId } = parsed.body;
  if (typeof id !== "number" || !Number.isInteger(id)) return json({ error: "id must be an integer" }, 400);
  if (!(GRADES as readonly string[]).includes(grade as string)) {
    return json({ error: `grade must be one of: ${GRADES.join(", ")}` }, 400);
  }
  if (!isIdempotencyKey(answerId)) {
    return json({ error: "answerId must be an idempotency key of 8..128 safe characters" }, 400);
  }
  const outcome = deps.srsReviewStore.apply({
    answerId, targetKind: "chunk", targetId: id, grade: grade as Grade,
  }, () => {
    const result = deps.chunkStore.grade(id, grade as Grade);
    if (!result) return null;
    const summary = deps.progressStore.addXp("srs-grade", xpForGrade(grade as Grade), { chunkId: id, answerId });
    if (!summary) throw new Error("failed to apply SRS grade XP");
    return { stage: result.stage, due: result.due };
  });
  if (outcome.status === "missing") return json({ error: `unknown chunk id: ${id}` }, 400);
  if (outcome.status === "conflict") return json({ error: "answerId was already used for different data" }, 409);
  if (!("stage" in outcome)) throw new Error("unexpected SRS review outcome");
  return json({ id, stage: outcome.stage, due: outcome.due });
}

function handleChunkList(url: URL, deps: ChunkRoutesDeps): Response {
  const visibility = url.searchParams.get("visibility") ?? "visible";
  if (visibility === "visible") return json({ chunks: deps.chunkStore.list() });
  if (visibility === "hidden") return json({ chunks: deps.chunkStore.listHidden() });
  return json({ error: "visibility must be one of: visible, hidden" }, 400);
}

async function handleChunkVisibility(req: Request, url: URL, deps: ChunkRoutesDeps): Promise<Response> {
  const seg = url.pathname.slice("/api/chunks/".length);
  const match = /^([1-9]\d*)\/visibility$/.exec(seg);
  const id = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(id)) return json({ error: "id must be a positive safe integer" }, 400);
  const parsed = await parseJsonBody<{ hidden?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  if (typeof parsed.body.hidden !== "boolean") return json({ error: "hidden must be a boolean" }, 400);
  return deps.chunkStore.setHidden(id, parsed.body.hidden)
    ? json({ ok: true, hidden: parsed.body.hidden })
    : json({ error: `unknown chunk id: ${id}` }, 404);
}

export function makeChunkRoutes(deps: ChunkRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/chunks", (_req, url) => handleChunkList(url, deps)),
    exact("POST", "/api/chunks/grade", (req) => handleChunkGrade(req, deps)),
    prefix("PUT", "/api/chunks/", (req, url) => handleChunkVisibility(req, url, deps)),
  ];
}
