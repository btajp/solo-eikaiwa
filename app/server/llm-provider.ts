import type { ClaudeRunner } from "./converse";
import { makeOpenAICompatRunner } from "./providers/openai-compat";
import { makeCodexRunner } from "./providers/codex";

/** サイドバー設定UIで選べる LLM プロバイダ。"env" は「環境変数に従う」リセット用センチネル。 */
export type LlmProvider = "env" | "claude" | "openai-compat" | "codex";

/** LLM 呼び出しの用途ロール（4つ固定）。各ロールは全体設定を継承(inherit)するか、独自プロバイダを持つ。 */
export type LlmRole = "conversation" | "coaching" | "generation" | "assessment";

/** ロールの走査順（UI テーブルの並びと一致させる）。 */
export const LLM_ROLES: readonly LlmRole[] = ["conversation", "coaching", "generation", "assessment"];

/** ロール別プロバイダ。"inherit" は「全体設定に従う」センチネル。それ以外は LlmProvider の部分集合（"env" はロールでは扱わない）。 */
export type LlmRoleProvider = "inherit" | "claude" | "openai-compat" | "codex";

/** ロール別の永続化設定。APIキーは含めない（.env のみ）。inherit のときフィールドは null。 */
export type LlmRoleSetting = {
  provider: LlmRoleProvider;
  baseUrl: string | null;
  model: string | null;
  codexModel: string | null;
};

/** inherit センチネルか判定する。 */
export function isInheritRole(s: LlmRoleSetting): boolean {
  return s.provider === "inherit";
}

/** 非 inherit のロール設定を settingsToEnv が食える LlmSettings へ写す（inherit では呼ばない前提）。 */
export function roleSettingToSettings(s: LlmRoleSetting): LlmSettings {
  return { provider: s.provider as LlmProvider, baseUrl: s.baseUrl, model: s.model, codexModel: s.codexModel };
}

/** DB(llm_settings 単一行)に永続化する LLM 設定。APIキーは含めない（.env のみ）。 */
export type LlmSettings = {
  provider: LlmProvider;
  baseUrl: string | null;
  model: string | null;
  codexModel: string | null;
};

export type SelectRunnerArgs = {
  /** 既定（claude）で返す、事前構築済みの Claude SDK runner。converse.ts から渡す（循環回避のため） */
  claudeRunner: ClaudeRunner;
  /** アダプタが systemPrompt 未指定時に使う既定プロンプト（PARTNER_SYSTEM_PROMPT） */
  defaultSystemPrompt: string;
  /** テスト用の注入 seam。既定は Bun.env */
  env?: Record<string, string | undefined>;
};

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v || !v.trim()) throw new Error(`${key} is required when LLM_PROVIDER=openai-compat`);
  return v.trim();
}

/**
 * LLM_PROVIDER に応じて ClaudeRunner を選ぶ純関数。
 * 未設定/claude は渡された claudeRunner をそのまま返す（現行と完全同一＝回帰基準）。
 * converse.ts の defaultRunner 生成点から1度だけ呼ばれる。
 */
export function selectRunner(args: SelectRunnerArgs): ClaudeRunner {
  const env = args.env ?? Bun.env;
  const provider = (env.LLM_PROVIDER ?? "claude").trim().toLowerCase();

  switch (provider) {
    case "":
    case "claude":
      return args.claudeRunner;

    case "openai-compat":
      return makeOpenAICompatRunner({
        baseUrl: requireEnv(env, "OPENAI_COMPAT_BASE_URL"),
        apiKey: env.OPENAI_COMPAT_API_KEY?.trim() || undefined,
        model: requireEnv(env, "OPENAI_COMPAT_MODEL"),
        defaultSystemPrompt: args.defaultSystemPrompt,
      });

    case "codex":
      return makeCodexRunner({
        model: env.CODEX_MODEL?.trim() || undefined,
        // 会話用途では xhigh 級の長考がレイテンシに直撃するため、既定を medium に固定（env で変更可）
        reasoningEffort: env.CODEX_REASONING_EFFORT?.trim() || "medium",
        // Fast サービスティアを既定に（無効な環境ではサーバ側で黙って無視されるため安全）
        serviceTier: env.CODEX_SERVICE_TIER?.trim() || "fast",
        defaultSystemPrompt: args.defaultSystemPrompt,
      });

    default:
      throw new Error(`Unknown LLM_PROVIDER: ${provider} (expected claude | openai-compat | codex)`);
  }
}

/**
 * DB 由来の LlmSettings を selectRunner が読む env 形状へ写像する純関数。
 * - provider="env" は「環境変数に従う」ので、渡した env をそのまま返す（DB 値で一切上書きしない＝起動時の pure-env 挙動を完全再現）。
 * - それ以外は env を土台に LLM_PROVIDER / OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_MODEL / CODEX_MODEL を DB 値で上書きする。
 *   OPENAI_COMPAT_API_KEY は上書きせず env（.env）由来のまま — APIキーは DB に持たせない衛生を1箇所で担保する。
 */
export function settingsToEnv(
  s: LlmSettings,
  env: Record<string, string | undefined> = Bun.env,
): Record<string, string | undefined> {
  if (s.provider === "env") return env;
  return {
    ...env,
    LLM_PROVIDER: s.provider,
    OPENAI_COMPAT_BASE_URL: s.baseUrl ?? undefined,
    OPENAI_COMPAT_MODEL: s.model ?? undefined,
    CODEX_MODEL: s.codexModel ?? undefined,
  };
}
