import { localYmd, addDaysYmd } from "../dates";
import { json, parseJsonBody, exact, prefix, bestEffort, type RouteEntry } from "./http";
import type { ListeningItem } from "../listening";
import type { ListeningStore } from "../listening-store";

export type ListeningRoutesDeps = {
  /** 素材（本文込み）の一覧。実体は loadListening、テストはフェイク。 */
  listListening: () => ListeningItem[];
  /** listeningId → 素材（未知は undefined）。本文取得と log の存在確認で使う。 */
  findListening: (id: string) => ListeningItem | undefined;
  listeningStore: ListeningStore;
};

/** 「今週」= 今日を含む直近7日。クライアント PracticeStat の週集計と同じ窓。 */
function weekStartYmd(now: Date): string {
  return addDaysYmd(localYmd(now), -6);
}

function handleList(deps: ListeningRoutesDeps): Response {
  // 一覧は本文（paragraphs）を含めない（本文は GET /api/listening/:id で取る）
  const items = deps.listListening().map(({ paragraphs, ...meta }) => meta);
  let weeklyCount = 0;
  bestEffort("[listening] countSince failed, returning 0:", () => {
    weeklyCount = deps.listeningStore.countSince(weekStartYmd(new Date()));
  });
  return json({ items, weeklyCount });
}

function handleGet(url: URL, deps: ListeningRoutesDeps): Response {
  const id = url.pathname.slice("/api/listening/".length);
  const item = deps.findListening(id);
  if (!item) return json({ error: `unknown listening id: ${id}` }, 404);
  return json({ item });
}

async function handleLog(req: Request, deps: ListeningRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ itemId?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { itemId } = parsed.body;
  if (typeof itemId !== "string" || !itemId.trim()) return json({ error: "itemId must be a non-empty string" }, 400);
  if (itemId.length > 200) return json({ error: "itemId must be at most 200 characters" }, 400);
  if (!deps.findListening(itemId)) return json({ error: `unknown listening id: ${itemId}` }, 400);
  const now = new Date();
  deps.listeningStore.log(itemId, localYmd(now));
  return json({ weeklyCount: deps.listeningStore.countSince(weekStartYmd(now)) });
}

export function makeListeningRoutes(deps: ListeningRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/listening", () => handleList(deps)),
    exact("POST", "/api/listening/log", (req) => handleLog(req, deps)),
    // 本文取得は末尾の前方一致（/api/listening/:id）。log は POST なので競合しない。
    prefix("GET", "/api/listening/", (_req, url) => handleGet(url, deps)),
  ];
}
