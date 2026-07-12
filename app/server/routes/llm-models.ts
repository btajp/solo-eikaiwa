import { json, exact, type RouteEntry } from "./http";
import type { CatalogResult, LlmCatalogProvider } from "../providers/model-catalog";

export type LlmModelsRoutesDeps = {
  /** provider 別のモデルカタログを返す（TTL キャッシュ・劣化パスは providers/model-catalog.ts が担う）。 */
  getModelCatalog: (provider: LlmCatalogProvider, refresh: boolean) => Promise<CatalogResult>;
};

/** ルートは薄く保つ: refresh クエリを読み取り、4ソースを並行取得して合成するだけ。HTTP は常に 200。 */
export function makeLlmModelsRoutes(deps: LlmModelsRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/llm-models", async (_req, url) => {
      const refresh = url.searchParams.get("refresh") === "1";
      const [claude, openai, codex, local] = await Promise.all([
        deps.getModelCatalog("claude", refresh),
        deps.getModelCatalog("openai", refresh),
        deps.getModelCatalog("codex", refresh),
        deps.getModelCatalog("local", refresh),
      ]);
      return json({ claude, openai, codex, local });
    }),
  ];
}
