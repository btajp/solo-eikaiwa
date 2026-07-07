import type { ChunkStore, CollectCandidate } from "../chunks";
import { GRADES, type Grade } from "../sentences";
import type { ProgressStore } from "../progress-store";
import { xpForGrade } from "../progression";
import { json, parseJsonBody, exact, prefix, bestEffort, type RouteEntry } from "./http";

export type ChunkRoutesDeps = {
  chunkStore: ChunkStore;
  progressStore: ProgressStore;
};

/** 収集はベストエフォート — 失敗しても親レスポンスを失敗させない（XP付与と同じ方針） */
export function collectBestEffort(chunkStore: ChunkStore, cands: CollectCandidate[]): number {
  try {
    return chunkStore.collect(cands);
  } catch (err) {
    console.warn("[chunks] collect failed, continuing:", String(err));
    return 0;
  }
}

async function handleChunkGrade(req: Request, deps: ChunkRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ id?: unknown; grade?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { id, grade } = parsed.body;
  if (typeof id !== "number" || !Number.isInteger(id)) return json({ error: "id must be an integer" }, 400);
  if (!(GRADES as readonly string[]).includes(grade as string)) {
    return json({ error: `grade must be one of: ${GRADES.join(", ")}` }, 400);
  }
  const r = deps.chunkStore.grade(id, grade as Grade);
  if (!r) return json({ error: `unknown chunk id: ${id}` }, 400);
  // 例文と同じ努力XP（good=2 / soso=1 / bad=1）。付与失敗で採点は失敗させない
  bestEffort("[progress] srs-grade xp (chunk) failed, continuing:", () =>
    deps.progressStore.addXp("srs-grade", xpForGrade(grade as Grade), { chunkId: id }));
  return json(r);
}

function handleChunkDelete(url: URL, deps: ChunkRoutesDeps): Response {
  const seg = url.pathname.slice("/api/chunks/".length);
  const id = Number(seg);
  if (!/^\d+$/.test(seg) || !Number.isInteger(id)) return json({ error: "id must be a positive integer" }, 400);
  return deps.chunkStore.remove(id) ? json({ ok: true }) : json({ error: `unknown chunk id: ${id}` }, 404);
}

export function makeChunkRoutes(deps: ChunkRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/chunks", () => json({ chunks: deps.chunkStore.list() })),
    exact("POST", "/api/chunks/grade", (req) => handleChunkGrade(req, deps)),
    prefix("DELETE", "/api/chunks/", (_req, url) => handleChunkDelete(url, deps)),
  ];
}
