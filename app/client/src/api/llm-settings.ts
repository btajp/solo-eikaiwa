import { extractErrorMessage } from "./http";

// 設定は UI/DB が唯一の真実（旧 "env"=環境変数に従う センチネルは廃止・v0.29）
export type LlmProvider = "claude" | "openai-compat" | "codex";

export type LlmRole = "conversation" | "assist" | "coaching" | "generation" | "assessment";
export const LLM_ROLES: readonly LlmRole[] = ["conversation", "assist", "coaching", "generation", "assessment"];
export type LlmRoleProvider = "inherit" | "claude" | "openai-compat" | "codex";

export type LlmRoleView = {
  provider: LlmRoleProvider;
  baseUrl: string | null;
  model: string | null;
  codexModel: string | null;
};

/** ロール別チューニングの選択肢（サーバのホワイトリストと一致させる）。
 * Claude モデルはホワイトリスト廃止（v0.29）: カタログ由来の任意モデルID文字列を保存できる。 */
export type EffortOption = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_OPTIONS: readonly EffortOption[] = ["low", "medium", "high", "xhigh", "max"];
export type ServiceTierOption = "fast" | "standard";
export const SERVICE_TIER_OPTIONS: readonly ServiceTierOption[] = ["fast", "standard"];

/** 認証モード（サーバの llm_auth テーブルと一致）。api-key は対応する鍵が未設定だと 400 になる。 */
export type AuthMode = "subscription" | "api-key";
export const AUTH_MODE_OPTIONS: readonly AuthMode[] = ["subscription", "api-key"];
/** 認証モードの対象プロバイダ（claude/codex の2つ。ローカルLLMは認証概念自体が無い）。 */
export type LlmAuthProvider = "claude" | "codex";

/** ロール別チューニングの値。null は「既定へ従う（未指定）」を表す。 */
export type RoleTuning = { claudeModel: string | null; effort: EffortOption | null; serviceTier: ServiceTierOption | null };

/** GET/PUT 応答。APIキー値は含まれない（有無のみ apiKeyConfigured）。 */
export type LlmSettingsView = {
  provider: LlmProvider;
  baseUrl: string | null;
  model: string | null;
  codexModel: string | null;
  apiKeyConfigured: boolean;
  /** 現在のOpenAI互換originに対して保存済み鍵の利用が明示承認されているか。 */
  apiKeyApproved?: boolean;
  /** PUT 応答のみ: 実行中プロセスへ適用できたか */
  applied?: boolean;
  /** PUT 応答のみ: 適用失敗時のメッセージ */
  error?: string | null;
  /** ロール別の現在設定（未設定ロールは provider:"inherit"）。 */
  roles: Record<LlmRole, LlmRoleView>;
  /** 全ロール共通の既定チューニング（llm_role_tuning の "global" 行・行不在は全項目null）。旧サーバ応答にはキー自体が無い場合がある（additive API）。 */
  globalTuning?: RoleTuning;
  /** ロール別チューニング（未設定ロールは全項目null）。旧サーバ応答にはキー自体が無い場合がある（additive API）。 */
  tuning: Record<LlmRole, RoleTuning>;
  /** 認証モード（行不在は "subscription"）。旧サーバ応答にはキー自体が無い場合がある（additive API）。 */
  authModes: Record<LlmAuthProvider, AuthMode>;
  /** Keychain/envのキー検出のみ（値は返さない）。旧サーバ応答にはキー自体が無い場合がある。 */
  authKeys: { anthropic: boolean; codex: boolean };
};

export type LlmSettingsInput = {
  provider: LlmProvider;
  baseUrl?: string | null;
  model?: string | null;
  codexModel?: string | null;
};

export async function fetchLlmSettings(): Promise<LlmSettingsView> {
  const res = await fetch("/api/llm-settings");
  if (!res.ok) throw new Error(`llm-settings failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function saveLlmSettings(input: LlmSettingsInput): Promise<LlmSettingsView> {
  const res = await fetch("/api/llm-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`llm-settings save failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export type LlmRoleInput = {
  provider: LlmRoleProvider;
  baseUrl?: string | null;
  model?: string | null;
  codexModel?: string | null;
};

/** ロール別設定の一括更新。global を含めると全体設定も同時に保存する（プリセット用）。 */
export type LlmRolesInput = {
  global?: LlmSettingsInput;
  roles?: Partial<Record<LlmRole, LlmRoleInput>>;
  /** ロール別チューニング + "global"（全ロール共通既定）。省略スコープ・省略フィールドはサーバ側で既存値保持。 */
  tuning?: Partial<Record<LlmRole | "global", Partial<RoleTuning>>>;
  /** 認証モード。省略した provider はサーバ側で既存値保持。api-key 指定時に対応する env キーが未設定だと 400。 */
  auth?: Partial<Record<LlmAuthProvider, AuthMode>>;
};

export async function saveLlmRoleSettings(input: LlmRolesInput): Promise<LlmSettingsView> {
  const res = await fetch("/api/llm-settings/roles", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`llm role settings save failed: ${await extractErrorMessage(res)}`);
  return res.json();
}
