import { json, parseJsonBody, exact, type RouteEntry } from "./http";
import { DEFAULT_LLM_SETTINGS, LLM_ROLES, type LlmSettings, type LlmProvider, type LlmRole, type LlmRoleProvider, type LlmRoleSetting } from "../llm-provider";
import { EFFORTS, CODEX_EFFORTS, SERVICE_TIERS, type RoleTuning, type TuningScope } from "../llm-role-tuning-store";
import { AUTH_MODES, type AuthMode, type LlmAuthModes, type LlmAuthProvider } from "../llm-auth-store";
import { parseRemoteBaseUrl } from "../remote-endpoint";
import { isOfficialOpenAiBaseUrl } from "../openai";

export type LlmSettingsRoutesDeps = {
  getLlmSettings: () => LlmSettings | null;
  saveLlmSettings: (s: LlmSettings) => void;
  getLlmRoleSettings: () => Record<LlmRole, LlmRoleSetting>;
  saveLlmRoleSettings: (role: LlmRole, s: LlmRoleSetting) => void;
  getLlmRoleTuning: () => Record<LlmRole, RoleTuning>;
  /** グローバル既定チューニング（llm_role_tuning の "global" 行。行不在は全 null）。 */
  getLlmGlobalTuning: () => RoleTuning;
  /** 渡されたスコープ（ロール or "global"）だけを部分更新する（route 側で検証済み）。 */
  saveLlmRoleTuning: (t: Partial<Record<TuningScope, Partial<RoleTuning>>>) => void;
  applyLlmSettings: (s: LlmSettings) => void;
  /** Keychain/env resolver由来のAPIキー状態のみ。値は返さない。 */
  llmEnv: () => { apiKeyConfigured: boolean; apiKeyApproved?: boolean; openAiKeyConfigured?: boolean };
  /** 受信入口の fire-and-forget フック（conversation が openai-compat のときローカルモデルを温める）。llm-settings ルート自体は使わない。 */
  warmLlm: () => void;
  /** 認証モード（DB 由来。行不在は "subscription"）。 */
  getLlmAuthModes: () => LlmAuthModes;
  /** 単一 provider の認証モードを upsert する（route 側でホワイトリスト・キー存在を検証済み）。 */
  saveLlmAuthMode: (provider: LlmAuthProvider, mode: AuthMode) => void;
  /** Keychain/env resolverのキー検出のみ（値は返さない）。 */
  getAuthKeysConfigured: () => { anthropic: boolean; codex: boolean };
  /** 保存直後の最新モードを runner 側のランタイムキャッシュへ反映する（サーバ再起動なしに反映するため）。 */
  applyLlmAuthModes: (modes: LlmAuthModes) => void;
  /** codex を api-key モードへ切替える際、隔離 CODEX_HOME に auth.json を用意する（無ければ codex login）。 */
  ensureCodexApiKeyHome: () => Promise<string>;
  /** codex の認証モードが変わったとき、常駐 app-server プロセスを kill する（認証環境変更のため。次回 lazy respawn）。 */
  killCodexAppServerRegistry: () => void;
};

const PROVIDERS = ["claude", "openai", "openai-compat", "codex"] as const;
const ROLE_PROVIDERS = ["inherit", "claude", "openai", "openai-compat", "codex"] as const;

/** undefined/null/空文字 → null（未指定）、trim後1文字以上でmax以下の文字列 → trim値、それ以外 → undefined（不正） */
function asOptionalStr(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type SettingsInput = { provider?: unknown; baseUrl?: unknown; model?: unknown; openaiModel?: unknown; codexModel?: unknown };
type ParsedSettings = {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  openaiModel: string | null;
  codexModel: string | null;
};

/**
 * 全体設定/ロール設定の共通バリデータ。allowed で provider 集合を切替（全体=env含む・ロール=inherit含む）。
 * openai-compat は baseUrl(http(s)) + model 必須、codex は codexModel 任意、それ以外はフィールドなし。
 */
function parseSettingsInput(
  b: SettingsInput,
  allowed: readonly string[],
  scope: "global" | "role",
): { ok: true; value: ParsedSettings } | { ok: false; error: string } {
  if (typeof b.provider !== "string" || !allowed.includes(b.provider)) {
    return { ok: false, error: `provider must be one of ${allowed.join(", ")}` };
  }
  if (scope === "global") {
    const baseUrl = asOptionalStr(b.baseUrl, 500);
    if (baseUrl === undefined) return { ok: false, error: "baseUrl must be a string of at most 500 characters" };
    let normalizedBaseUrl = baseUrl;
    if (baseUrl !== null) {
      const parsedBase = parseRemoteBaseUrl(baseUrl);
      if (!parsedBase.ok) return { ok: false, error: parsedBase.error };
      normalizedBaseUrl = parsedBase.baseUrl;
    }
    const model = asOptionalStr(b.model, 200);
    if (model === undefined) return { ok: false, error: "model must be a string of at most 200 characters" };
    const openaiModel = asOptionalStr(b.openaiModel, 200);
    if (openaiModel === undefined) return { ok: false, error: "openaiModel must be a string of at most 200 characters" };
    const codexModel = asOptionalStr(b.codexModel, 200);
    if (codexModel === undefined) return { ok: false, error: "codexModel must be a string of at most 200 characters" };
    if (b.provider === "openai-compat" && (!normalizedBaseUrl || !model)) {
      return { ok: false, error: "baseUrl and model are required for openai-compat" };
    }
    if (b.provider === "openai" && !openaiModel) {
      return { ok: false, error: "openaiModel is required for openai" };
    }
    return {
      ok: true,
      value: { provider: b.provider, baseUrl: normalizedBaseUrl, model, openaiModel, codexModel },
    };
  }

  if (b.provider === "openai-compat") {
    const baseUrl = asOptionalStr(b.baseUrl, 500);
    if (!baseUrl) return { ok: false, error: "baseUrl must be a valid http(s) URL for openai-compat" };
    const parsedBase = parseRemoteBaseUrl(baseUrl);
    if (!parsedBase.ok) return { ok: false, error: parsedBase.error };
    // 公式URLは互換ロールとして保存させない: 公式には専用の openai プロバイダ（専用キーバンク・固定URL）が
    // あり、互換行に紛れると保存と読込の契約が二重解釈になるため、保存前に理由つきで拒否する（#178）。
    if (isOfficialOpenAiBaseUrl(parsedBase.baseUrl)) {
      return { ok: false, error: "baseUrl is the official OpenAI API; use the official OpenAI connection (provider \"openai\") instead of openai-compat" };
    }
    const model = asOptionalStr(b.model, 200);
    if (!model) return { ok: false, error: "model is required for openai-compat" };
    return { ok: true, value: { provider: "openai-compat", baseUrl: parsedBase.baseUrl, model, openaiModel: null, codexModel: null } };
  }
  if (b.provider === "openai") {
    const model = asOptionalStr(b.model, 200);
    if (!model) return { ok: false, error: "model is required for openai" };
    return { ok: true, value: { provider: "openai", baseUrl: null, model, openaiModel: null, codexModel: null } };
  }
  if (b.provider === "codex") {
    const codexModel = asOptionalStr(b.codexModel, 200);
    if (codexModel === undefined) return { ok: false, error: "codexModel must be a string of at most 200 characters" };
    return { ok: true, value: { provider: "codex", baseUrl: null, model: null, openaiModel: null, codexModel } };
  }
  // claude / inherit: 付随フィールドは持たない（claude のモデルはグローバルチューニング〔tuning.global〕が担う）
  return { ok: true, value: { provider: b.provider, baseUrl: null, model: null, openaiModel: null, codexModel: null } };
}

/** GET と PUT 応答の共通ビュー。APIキー値は決して含めない（有無の boolean のみ）。roles/tuning は additive。 */
function viewOf(deps: LlmSettingsRoutesDeps, applied?: boolean, error?: string | null) {
  const stored = deps.getLlmSettings();
  const env = deps.llmEnv();
  const s: LlmSettings = stored ?? DEFAULT_LLM_SETTINGS;
  const roleSettings = deps.getLlmRoleSettings();
  const roles = {} as Record<LlmRole, { provider: LlmRoleProvider; baseUrl: string | null; model: string | null; codexModel: string | null }>;
  for (const role of LLM_ROLES) {
    const r = roleSettings[role];
    roles[role] = { provider: r.provider, baseUrl: r.baseUrl, model: r.model, codexModel: r.codexModel };
  }
  const roleTuning = deps.getLlmRoleTuning();
  const tuning = {} as Record<LlmRole, RoleTuning>;
  for (const role of LLM_ROLES) {
    const t = roleTuning[role];
    tuning[role] = { claudeModel: t.claudeModel, effort: t.effort, serviceTier: t.serviceTier };
  }
  const authModes = deps.getLlmAuthModes();
  const authKeys = deps.getAuthKeysConfigured();
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    openaiModel: s.openaiModel ?? null,
    codexModel: s.codexModel,
    apiKeyConfigured: env.apiKeyConfigured,
    apiKeyApproved: env.apiKeyApproved ?? false,
    openAiKeyConfigured: env.openAiKeyConfigured ?? false,
    roles,
    globalTuning: deps.getLlmGlobalTuning(),
    tuning,
    authModes: { claude: authModes.claude, codex: authModes.codex },
    authKeys: { anthropic: authKeys.anthropic, codex: authKeys.codex },
    ...(applied === undefined ? {} : { applied }),
    ...(error === undefined ? {} : { error }),
  };
}

/** auth の1エントリを検証する。undefined=未指定(変更なし)、それ以外はホワイトリスト適合を要求する。 */
function parseAuthMode(v: unknown): { ok: true; value: AuthMode | undefined } | { ok: false } {
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v === "string" && (AUTH_MODES as readonly string[]).includes(v)) return { ok: true, value: v as AuthMode };
  return { ok: false };
}

type AuthInput = { claude?: unknown; codex?: unknown };

/**
 * auth 全体を検証する。api-key を指定した provider に対応する env キーが未設定なら 400 相当のエラーを返す
 * （キーを保存済みDBへ書く前に弾く＝「保存したのに使えないモード」を作らない）。
 */
function parseAuthInput(
  v: unknown,
  keysConfigured: { anthropic: boolean; codex: boolean },
): { ok: true; value: Partial<Record<LlmAuthProvider, AuthMode>> } | { ok: false; error: string } {
  if (typeof v !== "object" || v === null) return { ok: false, error: "auth must be an object" };
  const b = v as AuthInput;
  const out: Partial<Record<LlmAuthProvider, AuthMode>> = {};

  const claude = parseAuthMode(b.claude);
  if (!claude.ok) return { ok: false, error: `auth.claude must be one of ${AUTH_MODES.join(", ")}` };
  if (claude.value !== undefined) {
    if (claude.value === "api-key" && !keysConfigured.anthropic) {
      return { ok: false, error: "anthropic api key is not configured; save it in settings before selecting api-key mode" };
    }
    out.claude = claude.value;
  }

  const codex = parseAuthMode(b.codex);
  if (!codex.ok) return { ok: false, error: `auth.codex must be one of ${AUTH_MODES.join(", ")}` };
  if (codex.value !== undefined) {
    if (codex.value === "api-key" && !keysConfigured.codex) {
      return { ok: false, error: "codex api key is not configured; save it in settings before selecting api-key mode" };
    }
    out.codex = codex.value;
  }

  return { ok: true, value: out };
}

/** tuning の1フィールド分をホワイトリスト検証する。undefined=未指定(変更なし)・null=クリア・それ以外はホワイトリスト適合を要求する。 */
function parseTuningField<T extends string>(
  v: unknown,
  allowed: readonly T[],
): { ok: true; value: T | null | undefined } | { ok: false } {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null) return { ok: true, value: null };
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return { ok: true, value: v as T };
  return { ok: false };
}

type TuningInput = { claudeModel?: unknown; effort?: unknown; serviceTier?: unknown };

/**
 * 1ロール分の tuning エントリを検証する。指定されなかったフィールドは結果に含めない（既存値を保持する部分更新のため）。
 * effort のホワイトリストは呼び出し側がロールの実効プロバイダに応じて選ぶ（resolveEffortWhitelist 参照。
 * codex は "max" を受け付けないため EFFORTS のままだと「保存はできるが request 時に失敗する」設定を作れてしまう）。
 */
function parseRoleTuning(
  v: unknown,
  effortWhitelist: readonly string[],
): { ok: true; value: Partial<RoleTuning> } | { ok: false; error: string } {
  if (typeof v !== "object" || v === null) return { ok: false, error: "tuning entry must be an object" };
  const b = v as TuningInput;
  const patch: Partial<RoleTuning> = {};

  // claudeModel はホワイトリストではなく形式検証（codexModel と同基準・v0.29）。
  // 選択肢の提示はカタログ API（SDK supportedModels()）が担い、任意のモデルIDも保存できる（UI 真実性）。
  if (b.claudeModel !== undefined) {
    if (b.claudeModel === null) {
      patch.claudeModel = null;
    } else {
      const cm = asOptionalStr(b.claudeModel, 200);
      if (cm === undefined || cm === null) {
        return { ok: false, error: "claudeModel must be a non-empty string of at most 200 characters or null" };
      }
      patch.claudeModel = cm;
    }
  }

  const ef = parseTuningField(b.effort, effortWhitelist);
  if (!ef.ok) return { ok: false, error: `effort must be one of ${effortWhitelist.join(", ")} or null` };
  if (ef.value !== undefined) patch.effort = ef.value;

  const st = parseTuningField(b.serviceTier, SERVICE_TIERS);
  if (!st.ok) return { ok: false, error: `serviceTier must be one of ${SERVICE_TIERS.join(", ")} or null` };
  if (st.value !== undefined) patch.serviceTier = st.value;

  return { ok: true, value: patch };
}

/**
 * ロールの実効プロバイダ（このリクエスト内の変更 > 保存済み設定の順で解決）から effort ホワイトリストを選ぶ。
 * inherit は global の実効プロバイダへ解決する（このリクエスト内の global 変更 > 保存済み global >
 * 既定 claude の順。env フォールバックは廃止済み）。codex 以外（claude・openai-compat・未知値）は
 * 全て EFFORTS（"max" 込み）を許容する — openai-compat は effort 自体を使わないため実害が無く、
 * codex だけが実際に "max" で失敗するため。
 *
 * assist→coaching 連鎖（binding）: converse.ts の applyLlmRoleSettings（コメント参照: converse.ts:280-286）が、
 * assist の設定行が inherit の間は assist を独自解決せず coaching の解決結果（プロバイダ・チューニングとも）を
 * そのまま使う規則を持つ（client 側の resolveEffective〔llm-assignments.ts〕も同じ連鎖を再現している）。
 * ここでの effort 検証も実行時に実際に適用されるプロバイダに合わせる必要があるため、assist が inherit のときは
 * assist ではなく coaching の実効プロバイダで判定する（coaching 自身が inherit ならさらに下の global 分岐へ）。
 * 3箇所（converse.ts / llm-assignments.ts の resolveEffective / ここ）はそれぞれ入力の形（保存後の Record・
 * GET応答のview・このリクエスト内override+保存済みの2段解決）が異なるため個別実装だが、セマンティクスは一致させる。
 */
function resolveEffortWhitelist(
  role: LlmRole,
  parsedRoles: Array<{ role: LlmRole; value: ParsedSettings }>,
  parsedGlobal: ParsedSettings | null,
  storedRoles: Record<LlmRole, LlmRoleSetting>,
  storedGlobal: LlmSettings | null,
  deps: LlmSettingsRoutesDeps,
): readonly string[] {
  const providerOf = (r: LlmRole): string => parsedRoles.find((p) => p.role === r)?.value.provider ?? storedRoles[r].provider;
  const chainRole: LlmRole = role === "assist" && providerOf("assist") === "inherit" ? "coaching" : role;
  const roleProvider = providerOf(chainRole);
  if (roleProvider !== "inherit") return roleProvider === "codex" ? CODEX_EFFORTS : EFFORTS;
  const globalProvider = parsedGlobal?.provider ?? storedGlobal?.provider ?? DEFAULT_LLM_SETTINGS.provider;
  return globalProvider === "codex" ? CODEX_EFFORTS : EFFORTS;
}

/** 「現在の全体設定 + 保存済みロール」で全ロール runner を再解決する。fail-open で applied/error を返す。 */
function applyResolved(deps: LlmSettingsRoutesDeps): { applied: boolean; error: string | null } {
  const effectiveGlobal = deps.getLlmSettings() ?? DEFAULT_LLM_SETTINGS;
  try {
    deps.applyLlmSettings(effectiveGlobal);
    return { applied: true, error: null };
  } catch (err) {
    return { applied: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type Body = { provider?: unknown; baseUrl?: unknown; model?: unknown; openaiModel?: unknown; codexModel?: unknown };

async function handlePut(req: Request, deps: LlmSettingsRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<Body>(req);
  if (!parsed.ok) return parsed.response;
  const g = parseSettingsInput(parsed.body, PROVIDERS, "global");
  if (!g.ok) return json({ error: g.error }, 400);

  deps.saveLlmSettings({
    provider: g.value.provider as LlmProvider,
    baseUrl: g.value.baseUrl,
    model: g.value.model,
    openaiModel: g.value.openaiModel,
    codexModel: g.value.codexModel,
  });
  // fail-open: 検証済み入力は基本 throw しないが、万一失敗しても「保存は成功」として applied:false + error を返す。
  const { applied, error } = applyResolved(deps);
  return json(viewOf(deps, applied, error));
}

async function handlePutRoles(req: Request, deps: LlmSettingsRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ global?: unknown; roles?: unknown; tuning?: unknown; auth?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  // 第1パス: global・roles・tuning の全エントリを検証のみ行う（何も保存しない）。
  // 1つでも NG なら 400 で即返す＝後続の保存パスに進めず、部分適用（前方だけ保存済み）を防ぐ。
  let parsedGlobal: ParsedSettings | null = null;
  if (body.global !== undefined) {
    if (typeof body.global !== "object" || body.global === null) return json({ error: "global must be an object" }, 400);
    const g = parseSettingsInput(body.global as SettingsInput, PROVIDERS, "global");
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
      const p = parseSettingsInput(rv as SettingsInput, ROLE_PROVIDERS, "role");
      if (!p.ok) return json({ error: `${role}: ${p.error}` }, 400);
      parsedRoles.push({ role: role as LlmRole, value: p.value });
    }
  }

  const parsedTuning: Array<{ role: TuningScope; value: Partial<RoleTuning> }> = [];
  if (body.tuning !== undefined) {
    if (typeof body.tuning !== "object" || body.tuning === null) return json({ error: "tuning must be an object" }, 400);
    const tuningObj = body.tuning as Record<string, unknown>;
    const storedRoles = deps.getLlmRoleSettings();
    const storedGlobal = deps.getLlmSettings();
    for (const role of Object.keys(tuningObj)) {
      if (role !== "global" && !(LLM_ROLES as readonly string[]).includes(role)) {
        return json({ error: `unknown role: ${role}` }, 400);
      }
      const r = role as TuningScope;
      // "global" スコープの effort 検証: global 行の effort はロール別未設定の全ロールへ
      // プロバイダ横断でマージされる（converse.ts mergeTuning）ため、global の実効プロバイダに加えて
      // 「codex に解決されるロールが1つでもあるか」（このリクエスト内の変更 > 保存済みの順・inherit は
      // global へ解決）まで見て、あれば厳しい側（CODEX_EFFORTS）で検証する。
      // これを global provider だけで判定すると「保存できるが実行時に codex で失敗する」設定を作れてしまう。
      const effortWhitelist =
        r === "global"
          ? (() => {
              const globalProvider = parsedGlobal?.provider ?? storedGlobal?.provider ?? DEFAULT_LLM_SETTINGS.provider;
              const providerOf = (rr: LlmRole): string =>
                parsedRoles.find((p) => p.role === rr)?.value.provider ?? storedRoles[rr].provider;
              const anyCodex = LLM_ROLES.some((rr) => {
                const p = providerOf(rr);
                return (p === "inherit" ? globalProvider : p) === "codex";
              });
              return globalProvider === "codex" || anyCodex ? CODEX_EFFORTS : EFFORTS;
            })()
          : resolveEffortWhitelist(r, parsedRoles, parsedGlobal, storedRoles, storedGlobal, deps);
      const p = parseRoleTuning(tuningObj[role], effortWhitelist);
      if (!p.ok) return json({ error: `${role}: ${p.error}` }, 400);
      parsedTuning.push({ role: r, value: p.value });
    }
  }

  let parsedAuth: Partial<Record<LlmAuthProvider, AuthMode>> | null = null;
  if (body.auth !== undefined) {
    const a = parseAuthInput(body.auth, deps.getAuthKeysConfigured());
    if (!a.ok) return json({ error: a.error }, 400);
    parsedAuth = a.value;
  }

  // codex を api-key へ切替える場合、global/roles/tuning/auth のどれか1つでも保存する前に隔離 CODEX_HOME の
  // 準備（実行時に codex login を spawn しうる）を待つ。ここで失敗したら例外がハンドラの外側 catch-all まで
  // 伝播し、以降の保存パスへは進まない＝何も保存されない。第2パスの内側（auth 保存の直前）に置くと、
  // 実行時のログイン失敗時に global/roles/tuning は既に保存済みという部分適用を許してしまうため、
  // 検証パス（400 判定）と同じ「何も保存しない」原子性の範囲に含める。
  if (parsedAuth?.codex === "api-key") {
    await deps.ensureCodexApiKeyHome();
  }

  // 第2パス: 全検証（+ 上記の codex ログイン確認）通過後にまとめて保存する。
  if (parsedGlobal) {
    deps.saveLlmSettings({
      provider: parsedGlobal.provider as LlmProvider,
      baseUrl: parsedGlobal.baseUrl,
      model: parsedGlobal.model,
      openaiModel: parsedGlobal.openaiModel,
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
  if (parsedTuning.length > 0) {
    const patch: Partial<Record<TuningScope, Partial<RoleTuning>>> = {};
    for (const { role, value } of parsedTuning) patch[role] = value;
    deps.saveLlmRoleTuning(patch);
  }
  if (parsedAuth) {
    const before = deps.getLlmAuthModes();
    let codexChanged = false;
    for (const provider of Object.keys(parsedAuth) as LlmAuthProvider[]) {
      const mode = parsedAuth[provider]!;
      deps.saveLlmAuthMode(provider, mode);
      if (provider === "codex" && mode !== before.codex) codexChanged = true;
    }
    // 認証環境が変わった codex の常駐 app-server プロセスは kill する（次回 lazy respawn で新envを反映）。
    if (codexChanged) deps.killCodexAppServerRegistry();
    // 保存直後の最新モードを runner 側のランタイムキャッシュへ push する（PUT がサーバ再起動なしに反映されるため）。
    deps.applyLlmAuthModes(deps.getLlmAuthModes());
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
