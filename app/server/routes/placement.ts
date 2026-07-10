import { PLACEMENT_TASKS, type PlacementEvaluation, type PlacementStore, type PlacementSubmission } from "../placement";
import type { ProgressStore } from "../progress-store";
import { PLACEMENT_XP } from "../progression";
import { json, parseJsonBody, exact, bestEffort, type RouteEntry } from "./http";

export type PlacementRoutesDeps = {
  /** 3タスクの評価。LLM出力が不正なら null（ルートは502で再試行を促す） */
  evaluatePlacement: (subs: PlacementSubmission[]) => Promise<PlacementEvaluation | null>;
  /** プレースメント測定結果の保存と最新取得（実体は placement.ts、テストはフェイク） */
  placementStore: PlacementStore;
  progressStore: ProgressStore;
  /** 明示的なレベル変更（accept/set）後に当日の通しメニューキャッシュを無効化する（decline では呼ばない） */
  invalidateMenuCache: () => void;
};

async function handlePlacementSubmit(req: Request, deps: PlacementRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ tasks?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const tasks = parsed.body.tasks;
  if (!Array.isArray(tasks) || tasks.length !== PLACEMENT_TASKS.length) {
    return json({ error: `tasks must be an array of ${PLACEMENT_TASKS.length} submissions` }, 400);
  }
  const subs: PlacementSubmission[] = [];
  for (const raw of tasks as Array<Record<string, unknown>>) {
    const def = PLACEMENT_TASKS.find((d) => d.id === raw?.taskId);
    if (!def) return json({ error: "unknown taskId" }, 400);
    if (subs.some((s) => s.taskId === def.id)) return json({ error: "duplicate taskId" }, 400);
    if (typeof raw.transcript !== "string" || !raw.transcript.trim()) {
      return json({ error: "transcript is required for every task" }, 400);
    }
    if (raw.transcript.length > 16_000) {
      return json({ error: "transcript must be at most 16000 characters for every task" }, 400);
    }
    if (typeof raw.durationSec !== "number" || raw.durationSec <= 0 || raw.durationSec > 600) {
      return json({ error: "durationSec must be between 1 and 600" }, 400);
    }
    if (typeof raw.wordCount !== "number" || !Number.isInteger(raw.wordCount) || raw.wordCount < 0 || raw.wordCount > 2000) {
      return json({ error: "wordCount must be an integer between 0 and 2000" }, 400);
    }
    subs.push({ taskId: def.id, transcript: raw.transcript, durationSec: raw.durationSec, wordCount: raw.wordCount });
  }
  const ev = await deps.evaluatePlacement(subs);
  if (!ev) return json({ error: "evaluation failed — please try submitting again" }, 502);
  deps.placementStore.save({
    stage: ev.stage, startLevel: ev.startLevel, rationale: ev.rationaleJa,
    metrics: subs.map((s) => ({
      taskId: s.taskId, wordCount: s.wordCount, durationSec: s.durationSec,
      density: s.durationSec > 0 ? s.wordCount / s.durationSec : 0,
    })),
  });
  // 測定完了XP（スペック§4.1: 10固定）。付与失敗で測定結果は失敗させない
  bestEffort("[placement] xp grant failed, continuing:", () =>
    deps.progressStore.addXp("placement", PLACEMENT_XP, {}));
  return json({ stage: ev.stage, startLevel: ev.startLevel, rationale: ev.rationaleJa });
}

async function handlePlacementConfirm(req: Request, deps: PlacementRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ accept?: unknown; level?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { accept, level } = parsed.body;
  if (typeof accept !== "boolean") return json({ error: "accept must be a boolean" }, 400);
  // 「今回は反映しない」— 測定履歴は submit 時点で保存済みなので何も変更しない（スペック§6.3）
  if (!accept) return json(deps.progressStore.getSummary());
  let target: number;
  if (level !== undefined) {
    if (typeof level !== "number") return json({ error: "level must be a number" }, 400);
    target = level;
  } else {
    const latest = deps.placementStore.latest();
    if (!latest) return json({ error: "no placement result to accept" }, 400);
    target = latest.startLevel;
  }
  const r = deps.progressStore.placementSet(target);
  if (!r) return json({ error: "level must be an integer between 1 and 999" }, 400);
  // レベルが実際に変わったときだけ当日メニューを再構築する（manual-set と同じ規則）
  if (r.levelChanged) deps.invalidateMenuCache();
  return json(r.summary);
}

export function makePlacementRoutes(deps: PlacementRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/placement/tasks", () => json({ tasks: PLACEMENT_TASKS })),
    exact("POST", "/api/placement/submit", (req) => handlePlacementSubmit(req, deps)),
    exact("POST", "/api/placement/confirm", (req) => handlePlacementConfirm(req, deps)),
    exact("GET", "/api/placement/latest", () => json({ result: deps.placementStore.latest() })),
  ];
}
