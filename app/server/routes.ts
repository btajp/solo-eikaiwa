import { appendEvent, isErrorLogged } from "./session-log";
import { json, type RouteEntry } from "./routes/http";
import { serveStatic, type StaticRoutesDeps } from "./routes/static";
import { makeDevRoutes, type DevRoutesDeps } from "./routes/dev";
import { CLIENT_DIST_DIR } from "./paths";
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
import { makeLlmModelsRoutes, type LlmModelsRoutesDeps } from "./routes/llm-models";
import { makeTtsSettingsRoutes, type TtsSettingsRoutesDeps } from "./routes/tts-settings";

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
  AssessmentRoutesDeps & ListeningRoutesDeps & FeedbackRoutesDeps & LlmSettingsRoutesDeps &
  LlmModelsRoutesDeps & TtsSettingsRoutesDeps & StaticRoutesDeps & DevRoutesDeps;

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
    ...makeLlmModelsRoutes(deps),
    ...makeTtsSettingsRoutes(deps),
    ...makeDevRoutes(deps),
  ];
  return async function fetch(req: Request): Promise<Response> {
    // 受信を契機にローカルLLM（conversation が openai-compat のとき）を温める。throttle 済み・fire-and-forget。
    // リクエスト処理には一切影響させない（await しない・例外を伝播させない）。
    try { deps.warmLlm(); } catch { /* warmup must never affect request handling */ }
    const url = new URL(req.url);
    try {
      for (const r of routes) {
        if (req.method === r.method && r.match(url.pathname)) return await r.handler(req, url);
      }
      // /api/* 以外は client dist を直接配信する（Caddy無しでも http://127.0.0.1:3111 で完結・SPAフォールバック込み）。
      // /api/* は既存どおり 404 JSON のまま（挙動不変）。
      if (!url.pathname.startsWith("/api/")) {
        return serveStatic(req.method, url.pathname, deps.staticDir ?? CLIENT_DIST_DIR);
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
