import { appendEvent, isErrorLogged } from "./session-log";
import { json, type RouteEntry } from "./routes/http";
import { makeSystemRoutes, type SystemRoutesDeps } from "./routes/system";
import { makeConverseRoutes, type ConverseRoutesDeps } from "./routes/converse";
import { makeSessionRoutes, type SessionRoutesDeps } from "./routes/session";
import { makeMenuRoutes, type MenuRoutesDeps } from "./routes/menu";
import { makeSettingsRoutes, type SettingsRoutesDeps } from "./routes/settings";
import { makeLibraryRoutes, type LibraryRoutesDeps } from "./routes/library";
import { makeCoachRoutes, type CoachRoutesDeps } from "./routes/coach";
import { makeSentenceRoutes, type SentenceRoutesDeps } from "./routes/sentences";
import { makeChunkRoutes, type ChunkRoutesDeps } from "./routes/chunks";
import { makeProgressRoutes, type ProgressRoutesDeps } from "./routes/progress";
import { makePlacementRoutes, type PlacementRoutesDeps } from "./routes/placement";
import { makeMetricsRoutes, type MetricsRoutesDeps } from "./routes/metrics";
import { makeAssessmentRoutes, type AssessmentRoutesDeps } from "./routes/assessment";
import { makeListeningRoutes, type ListeningRoutesDeps } from "./routes/listening";
import { makeFeedbackRoutes, type FeedbackRoutesDeps } from "./routes/feedback";
import { makeLlmSettingsRoutes, type LlmSettingsRoutesDeps } from "./routes/llm-settings";

/**
 * HTTP ハンドラが依存する副作用の総体。各ドメインの狭い Deps 型の交差で構成する。
 * 実サーバ（index.ts）は実装を、テスト（__tests__）はフェイクを渡す。
 * エンドポイント追加は「ドメインモジュールに1ハンドラ＋1エントリ」、新ドメインなら
 * 「新モジュール＋この合成配列に1行＋この交差型に1項」で完結する。
 */
export type RouteDeps =
  SystemRoutesDeps & ConverseRoutesDeps & SessionRoutesDeps & MenuRoutesDeps &
  SettingsRoutesDeps & LibraryRoutesDeps & CoachRoutesDeps & SentenceRoutesDeps &
  ChunkRoutesDeps & ProgressRoutesDeps & PlacementRoutesDeps & MetricsRoutesDeps &
  AssessmentRoutesDeps & ListeningRoutesDeps & FeedbackRoutesDeps & LlmSettingsRoutesDeps;

/** 現在の index.ts の全ルーティング・ハンドラをソケットを開かずにテストできる形に切り出したもの */
export function makeFetchHandler(deps: RouteDeps): (req: Request) => Promise<Response> {
  const routes: RouteEntry[] = [
    ...makeSystemRoutes(deps),
    ...makeConverseRoutes(deps),
    ...makeSessionRoutes(deps),
    ...makeMenuRoutes(deps),
    ...makeSettingsRoutes(deps),
    ...makeLibraryRoutes(deps),
    ...makeCoachRoutes(deps),
    ...makeSentenceRoutes(deps),
    ...makeChunkRoutes(deps),
    ...makeProgressRoutes(deps),
    ...makePlacementRoutes(deps),
    ...makeMetricsRoutes(deps),
    ...makeAssessmentRoutes(deps),
    ...makeListeningRoutes(deps),
    ...makeFeedbackRoutes(deps),
    ...makeLlmSettingsRoutes(deps),
  ];
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      for (const r of routes) {
        if (req.method === r.method && r.match(url.pathname)) return await r.handler(req, url);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isErrorLogged(err)) {
        try {
          appendEvent(deps.logFile(), {
            ts: new Date().toISOString(), type: "error", sessionId: "server", text: message,
          });
        } catch (logErr) {
          // ロギング自体の失敗で「常に{error}JSONを返す」保証を崩さないためのガード
          console.error(`routes: failed to append error event: ${String(logErr)}`);
        }
      }
      return json({ error: message }, 500);
    }
  };
}
