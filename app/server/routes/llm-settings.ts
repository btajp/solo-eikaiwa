import { json, parseJsonBody, exact, type RouteEntry } from "./http";
import { LLM_ROLES, type LlmSettings, type LlmProvider, type LlmRole, type LlmRoleProvider, type LlmRoleSetting } from "../llm-provider";

export type LlmSettingsRoutesDeps = {
  getLlmSettings: () => LlmSettings | null;
  saveLlmSettings: (s: LlmSettings) => void;
  getLlmRoleSettings: () => Record<LlmRole, LlmRoleSetting>;
  saveLlmRoleSettings: (role: LlmRole, s: LlmRoleSetting) => void;
  applyLlmSettings: (s: LlmSettings) => void;
  /** env 由来の情報。値そのものは返さず、APIキーは presence(boolean) のみ。 */
  llmEnv: () => { provider: string; apiKeyConfigured: boolean };
  /** 受信入口の fire-and-forget フック（conversation が openai-compat のときローカルモデルを温める）。llm-settings ルート自体は使わない。 */
  warmLlm: () => void;
};

const PROVIDERS = ["env", "claude", "openai-compat", "codex"] as const;
const ROLE_PROVIDERS = ["inherit", "claude", "openai-compat", "codex"] as const;

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

type SettingsInput = { provider?: unknown; baseUrl?: unknown; model?: unknown; codexModel?: unknown };
type ParsedSettings = { provider: string; baseUrl: string | null; model: string | null; codexModel: string | null };

/**
 * 全体設定/ロール設定の共通バリデータ。allowed で provider 集合を切替（全体=env含む・ロール=inherit含む）。
 * openai-compat は baseUrl(http(s)) + model 必須、codex は codexModel 任意、それ以外はフィールドなし。
 */
function parseSettingsInput(
  b: SettingsInput,
  allowed: readonly string[],
): { ok: true; value: ParsedSettings } | { ok: false; error: string } {
  if (typeof b.provider !== "string" || !allowed.includes(b.provider)) {
    return { ok: false, error: `provider must be one of ${allowed.join(", ")}` };
  }
  if (b.provider === "openai-compat") {
    const baseUrl = asOptionalStr(b.baseUrl, 500);
    if (!baseUrl || !isHttpUrl(baseUrl)) return { ok: false, error: "baseUrl must be a valid http(s) URL for openai-compat" };
    const model = asOptionalStr(b.model, 200);
    if (!model) return { ok: false, error: "model is required for openai-compat" };
    return { ok: true, value: { provider: "openai-compat", baseUrl, model, codexModel: null } };
  }
  if (b.provider === "codex") {
    const codexModel = asOptionalStr(b.codexModel, 200);
    if (codexModel === undefined) return { ok: false, error: "codexModel must be a string of at most 200 characters" };
    return { ok: true, value: { provider: "codex", baseUrl: null, model: null, codexModel } };
  }
  // env / claude / inherit: 付随フィールドは持たない
  return { ok: true, value: { provider: b.provider, baseUrl: null, model: null, codexModel: null } };
}

/** GET と PUT 応答の共通ビュー。APIキー値は決して含めない（有無の boolean のみ）。roles は additive。 */
function viewOf(deps: LlmSettingsRoutesDeps, applied?: boolean, error?: string | null) {
  const stored = deps.getLlmSettings();
  const env = deps.llmEnv();
  const s: LlmSettings = stored ?? { provider: "env", baseUrl: null, model: null, codexModel: null };
  const roleSettings = deps.getLlmRoleSettings();
  const roles = {} as Record<LlmRole, { provider: LlmRoleProvider; baseUrl: string | null; model: string | null; codexModel: string | null }>;
  for (const role of LLM_ROLES) {
    const r = roleSettings[role];
    roles[role] = { provider: r.provider, baseUrl: r.baseUrl, model: r.model, codexModel: r.codexModel };
  }
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    codexModel: s.codexModel,
    apiKeyConfigured: env.apiKeyConfigured,
    envProvider: env.provider,
    roles,
    ...(applied === undefined ? {} : { applied }),
    ...(error === undefined ? {} : { error }),
  };
}

/** 「現在の全体設定 + 保存済みロール」で全ロール runner を再解決する。fail-open で applied/error を返す。 */
function applyResolved(deps: LlmSettingsRoutesDeps): { applied: boolean; error: string | null } {
  const effectiveGlobal = deps.getLlmSettings() ?? { provider: "env" as LlmProvider, baseUrl: null, model: null, codexModel: null };
  try {
    deps.applyLlmSettings(effectiveGlobal);
    return { applied: true, error: null };
  } catch (err) {
    return { applied: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type Body = { provider?: unknown; baseUrl?: unknown; model?: unknown; codexModel?: unknown };

async function handlePut(req: Request, deps: LlmSettingsRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<Body>(req);
  if (!parsed.ok) return parsed.response;
  const g = parseSettingsInput(parsed.body, PROVIDERS);
  if (!g.ok) return json({ error: g.error }, 400);

  deps.saveLlmSettings({
    provider: g.value.provider as LlmProvider,
    baseUrl: g.value.baseUrl,
    model: g.value.model,
    codexModel: g.value.codexModel,
  });
  // fail-open: 検証済み入力は基本 throw しないが、万一失敗しても「保存は成功」として applied:false + error を返す。
  const { applied, error } = applyResolved(deps);
  return json(viewOf(deps, applied, error));
}

async function handlePutRoles(req: Request, deps: LlmSettingsRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ global?: unknown; roles?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  // 第1パス: global・roles の全エントリを検証のみ行う（何も保存しない）。
  // 1つでも NG なら 400 で即返す＝後続の保存パスに進めず、部分適用（前方だけ保存済み）を防ぐ。
  let parsedGlobal: ParsedSettings | null = null;
  if (body.global !== undefined) {
    if (typeof body.global !== "object" || body.global === null) return json({ error: "global must be an object" }, 400);
    const g = parseSettingsInput(body.global as SettingsInput, PROVIDERS);
    if (!g.ok) return json({ error: g.error }, 400);
    parsedGlobal = g.value;
  }

  const parsedRoles: Array<{ role: LlmRole; value: ParsedSettings }> = [];
  if (body.roles !== undefined) {
    if (typeof body.roles !== "object" || body.roles === null) return json({ error: "roles must be an object" }, 400);
    const rolesObj = body.roles as Record<string, unknown>;
    for (const role of Object.keys(rolesObj)) {
      if (!(LLM_ROLES as readonly string[]).includes(role)) return json({ error: `unknown role: ${role}` }, 400);
      const rv = rolesObj[role];
      if (typeof rv !== "object" || rv === null) return json({ error: `role ${role} must be an object` }, 400);
      const p = parseSettingsInput(rv as SettingsInput, ROLE_PROVIDERS);
      if (!p.ok) return json({ error: `${role}: ${p.error}` }, 400);
      parsedRoles.push({ role: role as LlmRole, value: p.value });
    }
  }

  // 第2パス: 全検証通過後にまとめて保存する。
  if (parsedGlobal) {
    deps.saveLlmSettings({
      provider: parsedGlobal.provider as LlmProvider,
      baseUrl: parsedGlobal.baseUrl,
      model: parsedGlobal.model,
      codexModel: parsedGlobal.codexModel,
    });
  }
  for (const { role, value } of parsedRoles) {
    deps.saveLlmRoleSettings(role, {
      provider: value.provider as LlmRoleProvider,
      baseUrl: value.baseUrl,
      model: value.model,
      codexModel: value.codexModel,
    });
  }

  const { applied, error } = applyResolved(deps);
  return json(viewOf(deps, applied, error));
}

export function makeLlmSettingsRoutes(deps: LlmSettingsRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/llm-settings", () => json(viewOf(deps))),
    exact("PUT", "/api/llm-settings", (req) => handlePut(req, deps)),
    exact("PUT", "/api/llm-settings/roles", (req) => handlePutRoles(req, deps)),
  ];
}
