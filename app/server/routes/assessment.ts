import { localYmd } from "../dates";
import type { AssessmentStore, MonthData } from "../assessment";
import { json, parseJsonBody, exact, type RouteEntry } from "./http";

export type AssessmentRoutesDeps = {
  /** 月次レビューの保存・取得（実体は assessment.ts、テストはフェイク） */
  assessmentStore: AssessmentStore;
  /** 直近30日の学習データ組み立て（実体は assessment.ts、テストはフェイク） */
  assembleMonthData: () => MonthData;
  /** 月次レポート生成。空出力は null（ルートは502）。signal はHTTP中断の伝播（#189） */
  generateMonthlyReport: (data: MonthData, signal?: AbortSignal) => Promise<string | null>;
};

async function handleAssessmentGenerate(req: Request, deps: AssessmentRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ force?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  if (parsed.body.force !== undefined && typeof parsed.body.force !== "boolean") {
    return json({ error: "force must be a boolean" }, 400);
  }
  const force = parsed.body.force === true;
  const today = localYmd();
  const existing = deps.assessmentStore.findByMonth(today.slice(0, 7));
  if (existing && !force) return json({ report: existing, cached: true });
  const data = deps.assembleMonthData();
  const text = await deps.generateMonthlyReport(data, req.signal);
  if (!text) return json({ error: "report generation returned empty output — try again" }, 502);
  const saved = deps.assessmentStore.save({ ymd: today, text, data });
  return json({ report: saved, cached: false });
}

export function makeAssessmentRoutes(deps: AssessmentRoutesDeps): RouteEntry[] {
  return [
    exact("POST", "/api/assessment/generate", (req) => handleAssessmentGenerate(req, deps)),
    exact("GET", "/api/assessment/latest", () => json({ report: deps.assessmentStore.latest() })),
    exact("GET", "/api/assessment/list", () => json({ reports: deps.assessmentStore.list() })),
  ];
}
