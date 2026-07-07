import { extractErrorMessage } from "./http";

export type LlmProvider = "env" | "claude" | "openai-compat" | "codex";

export type LlmRole = "conversation" | "coaching" | "generation" | "assessment";
export const LLM_ROLES: readonly LlmRole[] = ["conversation", "coaching", "generation", "assessment"];
export type LlmRoleProvider = "inherit" | "claude" | "openai-compat" | "codex";

export type LlmRoleView = {
  provider: LlmRoleProvider;
  baseUrl: string | null;
  model: string | null;
  codexModel: string | null;
};

/** GET/PUT 応答。APIキー値は含まれない（有無のみ apiKeyConfigured）。 */
export type LlmSettingsView = {
  provider: LlmProvider;
  baseUrl: string | null;
  model: string | null;
  codexModel: string | null;
  apiKeyConfigured: boolean;
  envProvider: string;
  /** PUT 応答のみ: 実行中プロセスへ適用できたか */
  applied?: boolean;
  /** PUT 応答のみ: 適用失敗時のメッセージ */
  error?: string | null;
  /** ロール別の現在設定（未設定ロールは provider:"inherit"）。 */
  roles: Record<LlmRole, LlmRoleView>;
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
