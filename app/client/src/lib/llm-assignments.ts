import {
  LLM_ROLES, SERVICE_TIER_OPTIONS, EFFORT_OPTIONS,
  type LlmRole, type LlmRoleInput, type LlmRoleView, type LlmSettingsInput, type LlmSettingsView, type RoleTuning,
  type ServiceTierOption, type EffortOption, type CatalogModel, type CatalogModelEffort, type CatalogResult,
  type AuthMode, type LlmAuthProvider,
} from "../api";

/**
 * codex 用の effort 静的フォールバック選択肢。codex はリクエストレベルで "max" を受け付けない
 * （サーバ側 llm-role-tuning-store.ts の CODEX_EFFORTS と同じ理由）ため EFFORT_OPTIONS から除外する。
 * カタログ取得可能時は effortOptionsForCodexModel の実カタログ値を使うため、これはカタログ不可時のみ使う。
 */
export const CODEX_EFFORT_OPTIONS: readonly EffortOption[] = EFFORT_OPTIONS.filter((e) => e !== "max");

/** ロール割当（UI が直接選ぶ）。inherit/env は UI に出さない。 */
export type RoleTarget = "claude" | "openai" | "local" | "codex";
export type RoleTargets = Record<LlmRole, RoleTarget>;

/** 優先クラウド（プリセットの "claude" 枠に代入するクラウド先）。 */
export type CloudTarget = "claude" | "openai" | "codex";

/** 接続入力（接続セクションの3フィールド。空文字＝未指定）。 */
export type Connection = { baseUrl: string; model: string; openaiModel?: string; codexModel: string };

export type EndpointLocation = "loopback" | "lan" | "remote" | "invalid";
export type EndpointClassification = { location: EndpointLocation; origin: string | null };
const OPENAI_OFFICIAL_BASE_URL = "https://api.openai.com/v1";
export type RoleTargetAvailabilityReason = "connection" | "authentication";
export type RoleTargetAvailability = Record<
  RoleTarget,
  { available: boolean; reason?: RoleTargetAvailabilityReason }
>;

function normalizeEndpointHostname(hostname: string): string {
  let lower = hostname.trim().toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]")) lower = lower.slice(1, -1);
  if (lower.endsWith(".")) lower = lower.slice(0, -1);
  return lower;
}

function ipv4Parts(hostname: string): number[] | null {
  const raw = hostname.split(".");
  if (raw.length !== 4 || raw.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const parts = raw.map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function isLanHostname(hostname: string): boolean {
  const ip = ipv4Parts(hostname);
  if (ip) {
    return ip[0] === 10
      || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31)
      || (ip[0] === 192 && ip[1] === 168)
      || (ip[0] === 169 && ip[1] === 254)
      || (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127)
      || ip.every((part) => part === 0);
  }
  return hostname.endsWith(".local")
    || hostname === "host.docker.internal"
    || /^(?:fc|fd)[0-9a-f:]*$/.test(hostname)
    || /^fe[89ab][0-9a-f:]*$/.test(hostname);
}

/** OpenAI互換Base URLを、利用者へ開示する処理場所と正規化originへ分類する。 */
export function classifyOpenAiEndpoint(raw: string): EndpointClassification {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { location: "invalid", origin: null };
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || Boolean(url.username || url.password || url.search || url.hash)) {
    return { location: "invalid", origin: null };
  }
  const hostname = normalizeEndpointHostname(url.hostname);
  const ip = ipv4Parts(hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || ip?.[0] === 127) {
    return { location: "loopback", origin: url.origin };
  }
  if (isLanHostname(hostname)) return { location: "lan", origin: url.origin };
  return { location: "remote", origin: url.origin };
}

/**
 * サーバの isOfficialOpenAiBaseUrl と同じ判定（binding）: 正規化（末尾スラッシュ除去・origin 正規化）後に
 * OpenAI 公式 Base URL へ一致するか。公式は互換接続ではなく専用の OpenAI 接続（専用キーバンク・固定URL）を
 * 使う契約のため、互換 Base URL としては保存前に拒否する（#178）。
 */
export function isOfficialOpenAiBaseUrl(raw: string): boolean {
  const endpoint = classifyOpenAiEndpoint(raw);
  if (endpoint.location === "invalid" || endpoint.origin === null) return false;
  const pathname = new URL(raw.trim()).pathname.replace(/\/+$/, "");
  return `${endpoint.origin}${pathname}` === OPENAI_OFFICIAL_BASE_URL;
}

/** サーバの parseRemoteBaseUrl.credentialsAllowed と同じ、資格情報を送信可能な接続先判定。 */
export function endpointAllowsCredentials(raw: string): boolean {
  const endpoint = classifyOpenAiEndpoint(raw);
  if (endpoint.location === "invalid") return false;
  try {
    return new URL(raw.trim()).protocol === "https:" || endpoint.location === "loopback";
  } catch {
    return false;
  }
}

/** プリセット識別子。 */
export type PresetId = "all-local" | "balanced" | "high-quality";

/**
 * プリセットのロール割当（固定）。バランスは会話・クイック支援・教材生成=ローカル / コーチング・測定=Claude。
 * クイック支援は単純で即答が欲しいタスクのためローカル側、測定は Claude との品質差が最大かつ低頻度のため Claude 側に含める。
 */
export const PRESETS: Record<PresetId, RoleTargets> = {
  "all-local": { conversation: "local", assist: "local", coaching: "local", generation: "local", assessment: "local" },
  balanced: { conversation: "local", assist: "local", coaching: "claude", generation: "local", assessment: "claude" },
  "high-quality": { conversation: "claude", assist: "claude", coaching: "claude", generation: "claude", assessment: "claude" },
};

/** baseUrl と model が両方非空ならローカル接続は定義済み。 */
export function isLocalDefined(conn: Connection): boolean {
  return conn.baseUrl.trim().length > 0 && conn.model.trim().length > 0;
}

/**
 * 用途タブで選択できる接続だけを返す。
 * Claude/Codex の subscription はキー不要、api-key は対応キーが必須。OpenAI互換は
 * loopback/LANなら接続定義だけでよいが、remoteはorigin承認済みキーを必要とする。
 * OpenAI 公式URLは互換接続として扱わない（サーバが保存を400で拒否する契約・#178）。
 * 既存割当は呼び出し側で表示を残し、この結果によって黙って書き換えない。
 */
export function roleTargetAvailability(
  view: LlmSettingsView,
  conn: Connection,
): RoleTargetAvailability {
  const authModes = hydrateAuthModes(view);
  const authKeys = hydrateAuthKeys(view);
  const cloud = (mode: AuthMode, keyConfigured: boolean) => mode === "subscription" || keyConfigured
    ? { available: true }
    : { available: false, reason: "authentication" as const };

  let local: RoleTargetAvailability["local"];
  const endpoint = classifyOpenAiEndpoint(conn.baseUrl);
  if (!isLocalDefined(conn) || endpoint.location === "invalid" || isOfficialOpenAiBaseUrl(conn.baseUrl)) {
    local = { available: false, reason: "connection" };
  } else if (endpoint.location !== "remote" || view.apiKeyApproved === true) {
    local = { available: true };
  } else {
    local = { available: false, reason: "authentication" };
  }

  return {
    claude: cloud(authModes.claude, authKeys.anthropic),
    openai: !(conn.openaiModel ?? "").trim()
      ? { available: false, reason: "connection" }
      : view.openAiKeyConfigured === true
      ? { available: true }
      : { available: false, reason: "authentication" },
    local,
    codex: cloud(authModes.codex, authKeys.codex),
  };
}

/** ローカルを含むプリセットはローカル定義が必要。high-quality は常に可。 */
export function presetEnabled(id: PresetId, conn: Connection): boolean {
  if (id === "high-quality") return true;
  return isLocalDefined(conn);
}

/** プリセットの "claude" 枠を優先クラウドへ写像したロール割当を返す（"local" 枠は不変）。 */
export function presetTargets(id: PresetId, cloud: CloudTarget): RoleTargets {
  const preset = PRESETS[id];
  const out = {} as RoleTargets;
  for (const role of LLM_ROLES) {
    out[role] = preset[role] === "claude" ? cloud : preset[role];
  }
  return out;
}

const EMPTY_TUNING: RoleTuning = { claudeModel: null, effort: null, serviceTier: null };

/** 全ロール分の既定チューニング（全項目 null）を返す。buildRolesPayload の tuning 省略時の既定にも使う。 */
export function defaultTuning(): Record<LlmRole, RoleTuning> {
  const out = {} as Record<LlmRole, RoleTuning>;
  for (const role of LLM_ROLES) out[role] = { ...EMPTY_TUNING };
  return out;
}

/** GET 応答からロール別チューニングを復元する。tuning キー自体、または個別ロールの欠落に耐える（旧サーバ応答の後方互換）。 */
export function hydrateTuning(view: LlmSettingsView): Record<LlmRole, RoleTuning> {
  const out = {} as Record<LlmRole, RoleTuning>;
  for (const role of LLM_ROLES) {
    out[role] = view.tuning?.[role] ?? { ...EMPTY_TUNING };
  }
  return out;
}

/** GET 応答からグローバル既定チューニング（"global" 行）を復元する。キー欠落に耐える（旧サーバ応答の後方互換）。 */
export function hydrateGlobalTuning(view: LlmSettingsView): RoleTuning {
  return view.globalTuning ?? { ...EMPTY_TUNING };
}

/** GET 応答から認証モードを復元する。authModes キー自体、または個別 provider の欠落に耐える（旧サーバ応答の後方互換・行不在は既定 "subscription"）。 */
export function hydrateAuthModes(view: LlmSettingsView): Record<LlmAuthProvider, AuthMode> {
  return {
    claude: view.authModes?.claude ?? "subscription",
    codex: view.authModes?.codex ?? "subscription",
  };
}

/** GET 応答から env キー検出状態を復元する。authKeys キー自体、または個別 provider の欠落に耐える（旧サーバ応答の後方互換・既定 false）。 */
export function hydrateAuthKeys(view: LlmSettingsView): { anthropic: boolean; codex: boolean } {
  return {
    anthropic: view.authKeys?.anthropic ?? false,
    codex: view.authKeys?.codex ?? false,
  };
}

/**
 * 認証モードの PUT ペイロード用パッチを組み立てる。ベースライン（直近 hydrate 済みの値）から
 * 変更された provider のみを含める（両方未変更なら undefined＝PUT payload に auth フィールド自体を含めない）。
 * これが無いと、api-key で保存済みのまま後から app/.env のキーを削除した状態で、auth を一切変更していない
 * 他の保存（接続保存・割当保存・プリセット適用）まで毎回 auth を再送し、サーバ側の
 * 「api-key 指定時に env キー未設定なら 400」検証に毎回引っかかって設定変更が一切保存できなくなる
 * （ロックアウト）。「本当に auth を変更した保存だけが 400 になり得る」を保証するための差分抽出。
 */
export function buildAuthPatch(
  baseline: Record<LlmAuthProvider, AuthMode>,
  current: Record<LlmAuthProvider, AuthMode>,
): Partial<Record<LlmAuthProvider, AuthMode>> | undefined {
  const patch: Partial<Record<LlmAuthProvider, AuthMode>> = {};
  if (current.claude !== baseline.claude) patch.claude = current.claude;
  if (current.codex !== baseline.codex) patch.codex = current.codex;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * ロール別の推奨チューニング（spec §4 推奨マトリクスの逐語定数）。
 * クラウド割当（claude/codex）のロールにのみ適用する想定 — local 割当ロールは対象外（applyRecommendedTuning 参照）。
 */
export const RECOMMENDED_TUNING: Record<LlmRole, { claude: RoleTuning; codex: RoleTuning }> = {
  conversation: {
    claude: { claudeModel: "sonnet", effort: "low", serviceTier: null },
    codex: { claudeModel: null, effort: "low", serviceTier: "fast" },
  },
  assist: {
    // haiku は effort 非対応（実測 2026-07-08: `claude -p --model haiku --effort low` は成功するが
    // effort は黙って無視される）。無視される値を書き込む/表示するのは UI 真実性違反のため null（既定）にする。
    claude: { claudeModel: "haiku", effort: null, serviceTier: null },
    codex: { claudeModel: null, effort: "low", serviceTier: "fast" },
  },
  coaching: {
    claude: { claudeModel: "sonnet", effort: "high", serviceTier: null },
    codex: { claudeModel: null, effort: "medium", serviceTier: "fast" },
  },
  generation: {
    claude: { claudeModel: "sonnet", effort: "medium", serviceTier: null },
    codex: { claudeModel: null, effort: "medium", serviceTier: "fast" },
  },
  assessment: {
    claude: { claudeModel: "opus", effort: "xhigh", serviceTier: null },
    codex: { claudeModel: null, effort: "xhigh", serviceTier: "standard" },
  },
};

/**
 * 推奨チューニングを現在のロール割当に基づいて適用する（クラウド割当ロールのみ書き換え・local 割当ロールは current を維持）。
 * 保存はしない（呼び出し側の state を更新するのみ。確定は割当保存ボタン）。current を変更せず新しいオブジェクトを返す。
 */
export function applyRecommendedTuning(
  current: Record<LlmRole, RoleTuning>,
  targets: RoleTargets,
): Record<LlmRole, RoleTuning> {
  const out = {} as Record<LlmRole, RoleTuning>;
  for (const role of LLM_ROLES) {
    const target = targets[role];
    out[role] =
      target === "claude" ? { ...RECOMMENDED_TUNING[role].claude }
      : target === "codex" ? { ...RECOMMENDED_TUNING[role].codex }
      : { ...current[role] };
  }
  return out;
}

/** effective global provider（"env" センチネル廃止後は llm_settings.provider がそのまま実効値）。 */
function effectiveGlobalProvider(view: LlmSettingsView): string {
  return view.provider;
}

/** GET 応答から接続入力を復元する（llm_settings 優先・ロール行フォールバック）。 */
export function hydrateConnection(view: LlmSettingsView): Connection {
  // ロール行の欠落に耐える（旧サーバ応答に新設ロールの行が無い場合。additive API の後方互換）
  const roleList = LLM_ROLES.map((r) => view.roles[r]).filter((r) => r != null);
  const localRole = roleList.find((r) => r.provider === "openai-compat" && r.baseUrl && r.model);
  const openAiRole = roleList.find((r) => r.provider === "openai" && r.model);
  const codexRole = roleList.find((r) => r.provider === "codex" && r.codexModel);
  return {
    baseUrl: view.baseUrl ?? localRole?.baseUrl ?? "",
    model: view.model ?? localRole?.model ?? "",
    openaiModel: view.openaiModel ?? openAiRole?.model ?? "",
    codexModel: view.codexModel ?? codexRole?.codexModel ?? "",
  };
}

/** GET 応答からロール割当（3値）を復元する。inherit は effective global を辿る。 */
export function hydrateTargets(view: LlmSettingsView): RoleTargets {
  const global = effectiveGlobalProvider(view);
  const out = {} as RoleTargets;
  for (const role of LLM_ROLES) {
    // 行欠落は inherit 扱い（旧サーバ応答に新設ロールの行が無い場合。additive API の後方互換）
    const raw = view.roles[role]?.provider ?? "inherit";
    // サーバのbindingと一致させる: assistのinheritはglobalではなくcoachingの解決先を継承する。
    const coaching = view.roles.coaching?.provider ?? "inherit";
    const p = raw === "inherit"
      ? role === "assist" && coaching !== "inherit" ? coaching : global
      : raw;
    out[role] = p === "openai-compat" ? "local" : p === "openai" ? "openai" : p === "codex" ? "codex" : "claude";
  }
  return out;
}

/**
 * (targets, conn) を PUT /api/llm-settings/roles のペイロードへ直列化する。
 * - 接続はロールの実行に必要な値として使うが、この関数の戻り値に global は含めない。
 * - ローカル未定義のとき local ターゲットは優先クラウド（既定 claude）にフォールバックする（空 baseUrl で 400 になるのを防ぐ）。
 * - tuning は常時（全ロール分）含める。省略時は全ロール null（既定）。割当やプリセット適用とは独立して素通しする
 *   （プリセット適用は tuning を変更しない — 呼び出し側が現在の tuning state をそのまま渡す）。
 */
/** 接続タブだけが保存する global 設定を直列化する。 */
export function buildGlobalConnectionPayload(conn: Connection, currentProvider?: LlmSettingsView["provider"]): LlmSettingsInput {
  const baseUrl = conn.baseUrl.trim();
  const model = conn.model.trim();
  const openaiModel = (conn.openaiModel ?? "").trim();
  const codexModel = conn.codexModel.trim() || null;
  const localDefined = Boolean(baseUrl && model);
  const usable = (provider: LlmSettingsView["provider"]) =>
    provider === "openai-compat" ? localDefined
    : provider === "openai" ? Boolean(openaiModel)
    : provider === "codex" ? Boolean(codexModel)
    : true;
  const provider = currentProvider && usable(currentProvider)
    ? currentProvider
    : localDefined ? "openai-compat"
    : openaiModel ? "openai"
    : codexModel ? "codex"
    : "claude";
  return {
    provider,
    ...(localDefined ? { baseUrl, model } : {}),
    ...(openaiModel ? { openaiModel } : {}),
    ...(codexModel ? { codexModel } : provider === "openai-compat" ? { codexModel: null } : {}),
  };
}

export function buildRoleAssignmentPayload(
  targets: RoleTargets,
  conn: Connection,
  cloud: CloudTarget = "claude",
  tuning: Record<LlmRole, RoleTuning> = defaultTuning(),
  globalTuning?: Partial<RoleTuning>,
): { roles: Record<LlmRole, LlmRoleInput>; tuning: Partial<Record<LlmRole | "global", Partial<RoleTuning>>> } {
  const baseUrl = conn.baseUrl.trim();
  const model = conn.model.trim();
  const openaiModel = (conn.openaiModel ?? "").trim();
  const codexModel = conn.codexModel.trim() || null;
  const localDefined = baseUrl.length > 0 && model.length > 0;

  const roles = {} as Record<LlmRole, LlmRoleInput>;
  for (const role of LLM_ROLES) {
    const t = !localDefined && targets[role] === "local" ? cloud : targets[role];
    roles[role] =
      t === "local" ? { provider: "openai-compat", baseUrl, model }
      : t === "openai" ? { provider: "openai", model: openaiModel }
      : t === "codex" ? { provider: "codex", codexModel }
      : { provider: "claude" };
  }
  return { roles, tuning: globalTuning !== undefined ? { ...tuning, global: globalTuning } : tuning };
}

/**
 * 接続保存時にだけ更新する、既存の接続依存ロールのパッチ。
 * inherit / Claude は global を参照するため送らず、未保存の用途タブstateをこの処理へ混ぜない。
 */
export function buildSavedRoleConnectionPatch(
  savedRoles: Record<LlmRole, LlmRoleView>,
  conn: Connection,
): Partial<Record<LlmRole, LlmRoleInput>> {
  const baseUrl = conn.baseUrl.trim();
  const model = conn.model.trim();
  const openaiModel = (conn.openaiModel ?? "").trim();
  const codexModel = conn.codexModel.trim() || null;
  const patch: Partial<Record<LlmRole, LlmRoleInput>> = {};
  for (const role of LLM_ROLES) {
    if (savedRoles[role].provider === "openai-compat") {
      patch[role] = { provider: "openai-compat", baseUrl, model };
    } else if (savedRoles[role].provider === "openai") {
      patch[role] = { provider: "openai", model: openaiModel };
    } else if (savedRoles[role].provider === "codex") {
      patch[role] = { provider: "codex", codexModel };
    }
  }
  return patch;
}

/** 保存済みロールにローカル接続を直接参照するものがあるか。接続を空にする前に割当変更を促す。 */
export function hasSavedLocalRole(savedRoles: Record<LlmRole, LlmRoleView>): boolean {
  return LLM_ROLES.some((role) => savedRoles[role].provider === "openai-compat");
}

/** 保存済みロールに OpenAI 公式モデルを直接参照するものがあるか。 */
export function hasSavedOpenAiRole(savedRoles: Record<LlmRole, LlmRoleView>): boolean {
  return LLM_ROLES.some((role) => savedRoles[role].provider === "openai");
}

/**
 * 互換用の全体ペイロード。明示的に全scopeを保存する呼び出しだけが使う。
 * 画面の「接続を保存」「割当を保存」は、それぞれ部分ペイロードを使う。
 */
export function buildRolesPayload(
  targets: RoleTargets,
  conn: Connection,
  cloud: CloudTarget = "claude",
  tuning: Record<LlmRole, RoleTuning> = defaultTuning(),
  globalTuning?: Partial<RoleTuning>,
): { global: LlmSettingsInput; roles: Record<LlmRole, LlmRoleInput>; tuning: Partial<Record<LlmRole | "global", Partial<RoleTuning>>> } {
  return {
    global: buildGlobalConnectionPayload(conn),
    ...buildRoleAssignmentPayload(targets, conn, cloud, tuning, globalTuning),
  };
}

/**
 * 現在の割当が一致するプリセット（値一致・適用履歴ではない）。
 * 各プリセット×優先クラウド（claude/codex）の総当たりで緩く一致させ、一致した { id, cloud } を返す。
 * どれとも一致しなければ "custom"。
 * 注: all-local はクラウド枠を持たないため、一致すれば常に cloud: "claude"（総当たり順で先に一致）を返す。
 *     これは実クラウド選択に依らない仕様上の割り切りであり、意図的に許容する。
 */
export function matchPreset(targets: RoleTargets): { id: PresetId; cloud: CloudTarget } | "custom" {
  const ids = Object.keys(PRESETS) as PresetId[];
  const clouds: CloudTarget[] = ["claude", "openai", "codex"];
  for (const id of ids) {
    for (const cloud of clouds) {
      if (LLM_ROLES.every((r) => presetTargets(id, cloud)[r] === targets[r])) {
        return { id, cloud };
      }
    }
  }
  return "custom";
}

// ---------------------------------------------------------------------------
// モデルカタログ（GET /api/llm-models）由来の選択肢・実効モデル解決
// ---------------------------------------------------------------------------

/** プロバイダ別カタログ（App 側の catalog state の形。未取得は undefined）。 */
export type LlmModelCatalog = { claude: CatalogResult; openai?: CatalogResult; codex: CatalogResult; local: CatalogResult };

/** claude ロールの既定エイリアス（コード定数。catalog の isDefault 行は CLI 自身の既定であり別物のため使わない）。 */
const CLAUDE_DEFAULT_ALIAS = "sonnet";
/** カタログ不可時の静的フォールバック選択肢（旧ホワイトリストの3エイリアス。保存自体は任意文字列可）。 */
const CLAUDE_FALLBACK_ALIASES: readonly string[] = ["haiku", "sonnet", "opus"];
/** codex ロールの既定チューニング（コード定数。selectRunner/resolveCodexConn と一致させる）。 */
const CODEX_DEFAULT_EFFORT = "medium";
const CODEX_DEFAULT_TIER: ServiceTierOption = "fast";

/** 保存値（カタログ id または旧エイリアス haiku/sonnet/opus）に対応するカタログ行を解決する。
 * id 一致を優先し、旧エイリアス（displayName 小文字一致）にもフォールバックする（後方互換）。 */
function findClaudeCatalogRow(catalog: CatalogResult | undefined, value: string): CatalogModel | undefined {
  if (!catalog?.available) return undefined;
  return catalog.models.find((m) => m.id === value) ?? catalog.models.find((m) => m.displayName.toLowerCase() === value);
}

function findCodexCatalogRowById(catalog: CatalogResult | undefined, id: string): CatalogModel | undefined {
  if (!catalog?.available) return undefined;
  return catalog.models.find((m) => m.id === id);
}

function findCodexDefaultRow(catalog: CatalogResult | undefined): CatalogModel | undefined {
  if (!catalog?.available) return undefined;
  return catalog.models.find((m) => m.isDefault === true);
}

/**
 * claude モデル DD の選択肢（v0.29: カタログ駆動）。カタログの全行（id="default"=CLI自身の既定行は除く —
 * 「既定」は空選択肢が担う）を提示し、ラベルに実体（resolvedModel）を併記する（例:「Sonnet — claude-sonnet-5」）。
 * カタログ不可時は旧3エイリアスの静的フォールバック（推測の具体IDは出さない）。
 */
export function claudeModelSelectOptions(catalog: CatalogResult | undefined): Array<{ value: string; label: string }> {
  if (!catalog?.available) return CLAUDE_FALLBACK_ALIASES.map((alias) => ({ value: alias, label: alias }));
  return catalog.models
    .filter((m) => m.id !== "default")
    .map((m) => ({ value: m.id, label: m.resolvedModel ? `${m.displayName} — ${m.resolvedModel}` : m.displayName }));
}

/** 選択中の claude エイリアスに対応するカタログ行の effort 選択肢（id のみ）。無ければ空配列＝既定のみ選択可（haiku 等）。 */
export function effortOptionsForClaudeAlias(catalog: CatalogResult | undefined, alias: string): string[] {
  return findClaudeCatalogRow(catalog, alias)?.efforts?.map((e) => e.id) ?? [];
}

/** codexModel（接続タブ）DD の選択肢。isDefault はバッジ表示用。カタログ不可・空なら空配列（自由記述へフォールバック）。 */
export function codexModelSelectOptions(catalog: CatalogResult | undefined): Array<{ value: string; label: string; isDefault: boolean }> {
  if (!catalog?.available) return [];
  return catalog.models.map((m) => ({ value: m.id, label: m.displayName, isDefault: m.isDefault === true }));
}

/** 指定 codexModel（空文字="CLI既定"）に対応するカタログ行の effort 選択肢（description 併記用に丸ごと返す）。 */
export function effortOptionsForCodexModel(catalog: CatalogResult | undefined, codexModel: string): CatalogModelEffort[] {
  const row = codexModel ? findCodexCatalogRowById(catalog, codexModel) : findCodexDefaultRow(catalog);
  return row?.efforts ?? [];
}

/**
 * 指定 codexModel に対応する配信(tier)選択肢。**カタログの生の tier id（例: "priority"）は使わない**
 * — 保存語彙は {fast, standard} を維持する仕様（spec §7 実機所見）。tiers を持つモデルは fast/standard 両方、
 * 持たないモデルは standard のみを返す（fast を選ばせても無効なため選択肢自体を絞る＝UI真実性）。
 * 行が見つからない場合（未マッチ・カタログ不可）は保守的に standard のみを返す。
 */
export function tierOptionsForCodexModel(catalog: CatalogResult | undefined, codexModel: string): readonly ServiceTierOption[] {
  const row = codexModel ? findCodexCatalogRowById(catalog, codexModel) : findCodexDefaultRow(catalog);
  return row?.tiers?.length ? SERVICE_TIER_OPTIONS : (["standard"] as const);
}

/** codex カタログの CLI 既定行の表示名。不可・不在は null（呼び出し側が静的文言へ劣化する）。
 * 「空欄で既定」のような表示に実際のモデル名を併記するために使う（UI 真実性）。 */
export function codexDefaultModelLabel(catalog: CatalogResult | undefined): string | null {
  return findCodexDefaultRow(catalog)?.displayName ?? null;
}

/** codex effort の既定ラベル（catalog の defaultEffort 優先・不一致/不可はコード既定 "medium"）。 */
export function codexDefaultEffortLabel(catalog: CatalogResult | undefined, codexModel: string): string {
  const row = codexModel ? findCodexCatalogRowById(catalog, codexModel) : findCodexDefaultRow(catalog);
  return row?.defaultEffort ?? CODEX_DEFAULT_EFFORT;
}

/** local モデル DD の選択肢（/models 由来）。カタログ不可・空なら空配列（自由記述へフォールバック）。 */
export function localModelSelectOptions(catalog: CatalogResult | undefined): Array<{ value: string; label: string }> {
  if (!catalog?.available) return [];
  return catalog.models.map((m) => ({ value: m.id, label: m.displayName }));
}

/** OpenAI 公式モデルの選択肢（公式 /models 由来）。 */
export const openAiModelSelectOptions = localModelSelectOptions;

/** 実効モデルの解決結果（表示用）。confirmed=true のときのみ text はカタログ確認済みの具体ID。 */
export type EffectiveModelInfo =
  | { confirmed: true; text: string }
  | { confirmed: false; text: string; cliDefault?: boolean };

/** 実効 effort/tier。null は「このプロバイダには概念自体が無い」（local）ことを表す。 */
export type EffectiveTuningValue = { value: string; isDefault: boolean } | null;

export type EffectiveResolution = {
  provider: RoleTarget;
  model: EffectiveModelInfo;
  effort: EffectiveTuningValue;
  tier: EffectiveTuningValue;
  endpoint?: EndpointClassification;
};

const EMPTY_ROLE_TUNING: RoleTuning = { claudeModel: null, effort: null, serviceTier: null };

/** env 解決済み文字列 / ロールプロバイダ文字列を3値の RoleTarget へ正規化する（hydrateTargets と共通の写像）。 */
function normalizeProviderKey(p: string): RoleTarget {
  return p === "openai-compat" ? "local" : p === "openai" ? "openai" : p === "codex" ? "codex" : "claude";
}

/**
 * 用途タブの「実効」サマリ用の核関数（純粋）: 直近保存済みの view（GET/PUT応答）とカタログから、
 * 1ロール分の実効プロバイダ・具体モデル・effort・配信を解決する。サーバ側 converse.ts の
 * resolveRoleRunner / applyLlmRoleSettings と同じ優先順位を再現する:
 * - assist が inherit のときは coaching の解決結果（プロバイダ・tuning とも）をそのまま使う（連鎖・binding）。
 *   assist 自身に tuning 行があっても inherit の間は使われない（連鎖の一貫性）。
 * - inherit はグローバル実効プロバイダ（provider="env" なら envProvider）へ解決する。
 * - tuning null はコード既定へ（claude: sonnet・SDK標準／codex: medium・fast）。
 * - カタログ不可・非マッチは「未確認」（推測の具体IDを出さない＝UI真実性の原則）。
 * 注: 「現在実行中の挙動」を示すため、未保存の編集中 state ではなく view（サーバの現在解決状態）を読む。
 */
export function resolveEffective(
  role: LlmRole,
  view: LlmSettingsView,
  catalog?: LlmModelCatalog,
): EffectiveResolution {
  const chainRole: LlmRole = role === "assist" && view.roles.assist?.provider === "inherit" ? "coaching" : role;
  const roleSetting = view.roles[chainRole];
  // 解決順（サーバ converse.ts の mergeTuning と一致・binding）: ロール別 > global > コード既定
  const roleTuning = view.tuning?.[chainRole] ?? EMPTY_ROLE_TUNING;
  const globalTuning = view.globalTuning ?? EMPTY_ROLE_TUNING;
  const tuning: RoleTuning = {
    claudeModel: roleTuning.claudeModel ?? globalTuning.claudeModel,
    effort: roleTuning.effort ?? globalTuning.effort,
    serviceTier: roleTuning.serviceTier ?? globalTuning.serviceTier,
  };
  const providerRaw = !roleSetting || roleSetting.provider === "inherit" ? view.provider : roleSetting.provider;
  const provider = normalizeProviderKey(providerRaw);

  if (provider === "local") {
    const modelValue = roleSetting?.model ?? view.model ?? "";
    const baseUrl = roleSetting?.baseUrl ?? view.baseUrl ?? "";
    return {
      provider,
      model: { confirmed: true, text: modelValue },
      effort: null,
      tier: null,
      endpoint: classifyOpenAiEndpoint(baseUrl),
    };
  }

  if (provider === "openai") {
    const modelValue = (roleSetting?.provider === "openai" ? roleSetting.model : view.openaiModel) ?? "";
    const row = catalog?.openai?.available
      ? catalog.openai.models.find((m) => m.id === modelValue)
      : undefined;
    return {
      provider,
      model: row ? { confirmed: true, text: row.id } : { confirmed: false, text: modelValue },
      effort: null,
      tier: null,
      endpoint: classifyOpenAiEndpoint(OPENAI_OFFICIAL_BASE_URL),
    };
  }

  if (provider === "codex") {
    const codexModel = (roleSetting?.codexModel ?? view.codexModel ?? "").trim();
    const row = codexModel ? findCodexCatalogRowById(catalog?.codex, codexModel) : findCodexDefaultRow(catalog?.codex);
    const model: EffectiveModelInfo = row?.resolvedModel
      ? { confirmed: true, text: row.resolvedModel }
      : codexModel
      ? { confirmed: false, text: codexModel }
      : { confirmed: false, text: "", cliDefault: true };
    // 実測: tiers 非対応の codex モデル（例: gpt-5.4-mini/5.3-spark）へ配信ティアを送っても黙って無視され、
    // 標準ルーティングになる（claude effort の effortIgnored と同じ「非対応値は静かに無視される」パターン）。
    // カタログが利用可能で選択中モデルに tiers が無ければ、保存値に関わらず実効は「標準（既定）」とする。
    // カタログ不可時は判定材料が無いため従来どおり保存値をそのまま表示する。
    const catalogAvailable = catalog?.codex?.available === true;
    const tierIgnored = catalogAvailable && !(row?.tiers && row.tiers.length > 0);
    // サーバ resolveCodexConn と同じクランプ（binding）: codex は "max" を受け付けないため実効は "xhigh"。
    const codexEffort = tuning.effort === "max" ? "xhigh" : tuning.effort;
    return {
      provider,
      model,
      effort: { value: codexEffort ?? row?.defaultEffort ?? CODEX_DEFAULT_EFFORT, isDefault: tuning.effort === null },
      tier: tierIgnored
        ? { value: "standard", isDefault: true }
        : { value: tuning.serviceTier ?? CODEX_DEFAULT_TIER, isDefault: tuning.serviceTier === null },
    };
  }

  // claude
  const alias = tuning.claudeModel ?? CLAUDE_DEFAULT_ALIAS;
  const row = findClaudeCatalogRow(catalog?.claude, alias);
  const model: EffectiveModelInfo = row?.resolvedModel
    ? { confirmed: true, text: row.resolvedModel }
    : { confirmed: false, text: alias };
  // 実測（2026-07-08）: `claude -p --model <alias> --effort <値>` はモデルが対応しない effort でも
  // エラーにならず、その effort を黙って無視する（例: haiku + low）。カタログが利用可能で、選択中モデルが
  // effort 非対応（efforts欄なし）または保存値がそのモデルの対応リストに無ければ、実際には無視されて
  // SDK 標準相当の挙動になる — 保存値をそのまま「実効」に出すと嘘になるため sdk-standard を返す。
  // カタログ不可時は判定材料が無いため従来どおり保存値をそのまま表示する（「実体未確認」が不確実性を示す）。
  const catalogAvailable = catalog?.claude?.available === true;
  const effortIgnored =
    catalogAvailable && (!row?.efforts || (tuning.effort !== null && !row.efforts.some((e) => e.id === tuning.effort)));
  const effort: EffectiveTuningValue =
    tuning.effort !== null && !effortIgnored
      ? { value: tuning.effort, isDefault: false }
      : { value: "sdk-standard", isDefault: true };
  return { provider, model, effort, tier: null };
}

/**
 * claude モデル DD の onChange 用: モデル切替後に選択中の effort が新モデルで無効化される場合、
 * effort を null（既定へ戻す）にクランプする純関数。実測（2026-07-08）で `claude -p` が非対応 effort を
 * 黙って無視することが確認されたため、UI 上に「効かない値」を残さないための処置。
 * カタログ不可時は判定材料が無いため現在値をそのまま維持する（clamp しない）。
 */
export function clampClaudeEffort(
  catalog: CatalogResult | undefined,
  newAlias: string,
  currentEffort: string | null,
): string | null {
  if (!catalog?.available) return currentEffort;
  const efforts = effortOptionsForClaudeAlias(catalog, newAlias);
  if (efforts.length === 0) return null;
  if (currentEffort !== null && !efforts.includes(currentEffort)) return null;
  return currentEffort;
}
