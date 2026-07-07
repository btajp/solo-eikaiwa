import { json, parseJsonBody, exact, type RouteEntry } from "./http";
import type { LlmSettings, LlmProvider } from "../llm-provider";

export type LlmSettingsRoutesDeps = {
  getLlmSettings: () => LlmSettings | null;
  saveLlmSettings: (s: LlmSettings) => void;
  applyLlmSettings: (s: LlmSettings) => void;
  /** env 由来の情報。値そのものは返さず、APIキーは presence(boolean) のみ。 */
  llmEnv: () => { provider: string; apiKeyConfigured: boolean };
};

const PROVIDERS = ["env", "claude", "openai-compat", "codex"] as const;

function isProvider(v: unknown): v is LlmProvider {
  return typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** undefined/null/空文字 → null（未指定）、trim後1文字以上でmax以下の文字列 → trim値、それ以外 → undefined（不正） */
function asOptionalStr(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type Body = { provider?: unknown; baseUrl?: unknown; model?: unknown; codexModel?: unknown };

/** GET と PUT 応答の共通ビュー。APIキー値は決して含めない（有無の boolean のみ）。 */
function viewOf(deps: LlmSettingsRoutesDeps, applied?: boolean, error?: string | null) {
  const stored = deps.getLlmSettings();
  const env = deps.llmEnv();
  const s: LlmSettings = stored ?? { provider: "env", baseUrl: null, model: null, codexModel: null };
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    codexModel: s.codexModel,
    apiKeyConfigured: env.apiKeyConfigured,
    envProvider: env.provider,
    ...(applied === undefined ? {} : { applied }),
    ...(error === undefined ? {} : { error }),
  };
}

async function handlePut(req: Request, deps: LlmSettingsRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<Body>(req);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  if (!isProvider(b.provider)) {
    return json({ error: `provider must be one of ${PROVIDERS.join(", ")}` }, 400);
  }

  let settings: LlmSettings;
  if (b.provider === "openai-compat") {
    const baseUrl = asOptionalStr(b.baseUrl, 500);
    if (!baseUrl || !isHttpUrl(baseUrl)) {
      return json({ error: "baseUrl must be a valid http(s) URL for openai-compat" }, 400);
    }
    const model = asOptionalStr(b.model, 200);
    if (!model) return json({ error: "model is required for openai-compat" }, 400);
    settings = { provider: "openai-compat", baseUrl, model, codexModel: null };
  } else if (b.provider === "codex") {
    const codexModel = asOptionalStr(b.codexModel, 200);
    if (codexModel === undefined) {
      return json({ error: "codexModel must be a string of at most 200 characters" }, 400);
    }
    settings = { provider: "codex", baseUrl: null, model: null, codexModel };
  } else {
    // "claude" / "env": 付随フィールドは持たない
    settings = { provider: b.provider, baseUrl: null, model: null, codexModel: null };
  }

  deps.saveLlmSettings(settings);
  // fail-open: 検証済み入力は基本 throw しないが、万一失敗しても「保存は成功」として中立に
  // applied:false + error を返す（保存成功を 5xx に化けさせない＝crash風の体験を避ける）。
  let applied = true;
  let error: string | null = null;
  try {
    deps.applyLlmSettings(settings);
  } catch (err) {
    applied = false;
    error = err instanceof Error ? err.message : String(err);
  }
  return json(viewOf(deps, applied, error));
}

export function makeLlmSettingsRoutes(deps: LlmSettingsRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/llm-settings", () => json(viewOf(deps))),
    exact("PUT", "/api/llm-settings", (req) => handlePut(req, deps)),
  ];
}
