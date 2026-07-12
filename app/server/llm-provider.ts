import type { ClaudeRunner } from "./converse";
import { makeOpenAICompatRunner } from "./providers/openai-compat";
import { makeCodexRunner } from "./providers/codex";
import { getCodexAppServerRunner } from "./providers/codex-app-server";
import { withFallback, withTimeout } from "./providers/decorators";
import { OPENAI_BASE_URL } from "./openai";

/** サイドバー設定UIで選べる LLM プロバイダ。設定は UI/DB が唯一の真実（env フォールバック廃止・v0.29）。 */
export type LlmProvider = "claude" | "openai" | "openai-compat" | "codex";

/** DB 行が無いときの既定設定（コード定数）。旧 "env"（環境変数に従う）センチネルは廃止し、store 読込時に claude へ正規化する。 */
export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  provider: "claude", baseUrl: null, model: null, openaiModel: null, codexModel: null,
};

/**
 * LLM 呼び出しの用途ロール（5つ固定）。各ロールは全体設定を継承(inherit)するか、独自プロバイダを持つ。
 * assist（クイック支援）は連鎖規則（binding）を持つ: 行不在(inherit)のときは coaching の解決済みランナーと
 * 同一参照になる（coaching も不在なら従来どおり global）。実装は converse.ts の applyLlmRoleSettings 内の1点。
 */
export type LlmRole = "conversation" | "assist" | "coaching" | "generation" | "assessment";

/** ロールの走査順（UI テーブルの並びと一致させる）。 */
export const LLM_ROLES: readonly LlmRole[] = ["conversation", "assist", "coaching", "generation", "assessment"];

/** ロール別プロバイダ。"inherit" は「全体設定に従う」センチネル。それ以外は LlmProvider の部分集合（"env" はロールでは扱わない）。 */
export type LlmRoleProvider = "inherit" | "claude" | "openai" | "openai-compat" | "codex";

/** ロール別の永続化設定。APIキーは含めず、resolverから実行時に注入する。inherit のときフィールドは null。 */
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
  const official = s.provider === "openai";
  return {
    provider: s.provider as LlmProvider,
    baseUrl: official ? null : s.baseUrl,
    model: official ? null : s.model,
    openaiModel: official ? s.model : null,
    codexModel: s.codexModel,
  };
}

/** DB(llm_settings 単一行)に永続化する LLM 設定。APIキーは含めず、resolverから実行時に注入する。 */
export type LlmSettings = {
  provider: LlmProvider;
  baseUrl: string | null;
  model: string | null;
  /** OpenAI 公式用モデル。旧呼び出し元との後方互換のため省略時は null 扱い。 */
  openaiModel?: string | null;
  codexModel: string | null;
};

export type SelectRunnerArgs = {
  /** 既定（claude）で返す、事前構築済みの Claude SDK runner。converse.ts から渡す（循環回避のため） */
  claudeRunner: ClaudeRunner;
  /** アダプタが systemPrompt 未指定時に使う既定プロンプト（PARTNER_SYSTEM_PROMPT） */
  defaultSystemPrompt: string;
  /** テスト用の注入 seam。既定は Bun.env */
  env?: Record<string, string | undefined>;
  /**
   * ロール別チューニング上書き（codex 用。優先順位: tuning > env > 既定）。
   * claude 経路では使わない（claude のロール別チューニングは converse.ts の resolveClaudeRunner が
   * 別途担う — circular import 回避のため selectRunner はここに関与しない）。openai-compat 経路も
   * 対応する設定項目が無いため無視する。
   */
  tuning?: { effort?: string; serviceTier?: string };
};

function requireEnv(env: Record<string, string | undefined>, key: string, provider = "openai-compat"): string {
  const v = env[key];
  if (!v || !v.trim()) throw new Error(`${key} is required when LLM_PROVIDER=${provider}`);
  return v.trim();
}

/** env から実効プロバイダキーを取り出す（未設定/空白は "claude" 扱い）。selectRunner と
 * ロール解決側（converse.ts の resolveRoleRunner）で共有する単一の判定ロジック。 */
export function resolveProviderKey(env: Record<string, string | undefined>): string {
  return (env.LLM_PROVIDER ?? "claude").trim().toLowerCase();
}

/**
 * codex 接続設定を組み立てる純関数（優先順位・binding）: tuning.effort > "medium" / tuning.serviceTier > "fast"。
 * env のチューニング（CODEX_REASONING_EFFORT/CODEX_SERVICE_TIER）は読まない（UI の既定表示と実挙動の乖離を
 * 機構的に防ぐ。CLI は scripts/generate-content.ts がエントリポイントで env を検証・解釈して tuning に渡す）。
 * CODEX_MODEL は接続レベル設定（チューニングではない）のため env のまま。
 * selectRunner と単体テストで共有する（実プロセスに依存しないため直接テスト可能）。
 */
export function resolveCodexConn(
  env: Record<string, string | undefined>,
  defaultSystemPrompt: string,
  tuning?: { effort?: string; serviceTier?: string },
): { model?: string; reasoningEffort: string; serviceTier: string; defaultSystemPrompt: string } {
  // codex は effort "max" をリクエスト時に拒否する（CODEX_EFFORTS の根拠と同じ実機所見）。
  // 保存時検証をすり抜けた保存済み値（例: claude 時代に正当に保存した global effort=max のまま
  // プロバイダだけを codex へ切替した場合）でも毎ターン失敗しないよう、最終防衛線として
  // codex の最上位である "xhigh" へクランプする（意図＝最大思考量に最も近い解釈）。
  const effort = tuning?.effort === "max" ? "xhigh" : tuning?.effort;
  return {
    model: env.CODEX_MODEL?.trim() || undefined,
    // 会話用途では xhigh 級の長考がレイテンシに直撃するため、既定を medium に固定（UI の用途別詳細設定で変更可）
    reasoningEffort: effort ?? "medium",
    // Fast サービスティアを既定に（無効な環境ではサーバ側で黙って無視されるため安全）
    serviceTier: tuning?.serviceTier ?? "fast",
    defaultSystemPrompt,
  };
}

/**
 * LLM_PROVIDER に応じて ClaudeRunner を選ぶ純関数。
 * 未設定/claude は渡された claudeRunner をそのまま返す（現行と完全同一＝回帰基準）。
 * converse.ts の defaultRunner 生成点から1度だけ呼ばれる。
 */
export function selectRunner(args: SelectRunnerArgs): ClaudeRunner {
  const env = args.env ?? Bun.env;
  const provider = resolveProviderKey(env);

  switch (provider) {
    case "":
    case "claude":
      // タスク境界: claude 経路への withFallback/withTimeout 合成・ロール別チューニングは
      // converse.ts の resolveClaudeRunner に集約する（circular import 回避のためここでは行わない）。
      return args.claudeRunner;

    case "openai-compat":
      // ハング検出のため withTimeout を適用する（従来は無限待ちだった。挙動変更）。
      // openai-compat には exec 相当の代替経路が無いため withFallback は適用しない。
      return withTimeout(
        makeOpenAICompatRunner({
          baseUrl: requireEnv(env, "OPENAI_COMPAT_BASE_URL"),
          apiKey: env.OPENAI_COMPAT_API_KEY?.trim() || undefined,
          model: requireEnv(env, "OPENAI_COMPAT_MODEL"),
          defaultSystemPrompt: args.defaultSystemPrompt,
        }),
      );

    case "openai":
      return withTimeout(
        makeOpenAICompatRunner({
          baseUrl: OPENAI_BASE_URL,
          apiKey: env.OPENAI_API_KEY?.trim() || undefined,
          model: requireEnv(env, "OPENAI_MODEL", "openai"),
          defaultSystemPrompt: args.defaultSystemPrompt,
        }),
      );

    case "codex": {
      // codex app-server（常駐プロセス）を既定経路にし、transport 障害（TransportError）時のみ
      // codex exec（ワンショット）へ委譲する。両経路はwithFallbackの総deadlineを共有する。
      // 接続設定（model/reasoningEffort/serviceTier）はどちらの経路でも同一値を渡す
      // （conn オブジェクトを1箇所で組み立てて両方へ展開する＝設定ドリフト防止）。
      const conn = resolveCodexConn(env, args.defaultSystemPrompt, args.tuning);
      return withFallback(withTimeout(getCodexAppServerRunner(conn)), makeCodexRunner(conn));
    }

    default:
      throw new Error(`Unknown LLM_PROVIDER: ${provider} (expected claude | openai | openai-compat | codex)`);
  }
}

/**
 * DB 由来の LlmSettings を selectRunner が読む env 形状へ写像する純関数。
 * 合成envはDB由来の接続設定と、選択providerが必要とする承認済みキーだけで構成する。
 * 実envの接続設定・無関係なAPIキー・その他の値は引き継がない。
 */
export function settingsToEnv(
  s: LlmSettings,
  env: Record<string, string | undefined> = Bun.env,
  apiKeyForBaseUrl?: (baseUrl: string) => string | undefined,
  openAiApiKey?: string,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {
    LLM_PROVIDER: s.provider,
    OPENAI_COMPAT_BASE_URL: s.baseUrl ?? undefined,
    OPENAI_COMPAT_MODEL: s.model ?? undefined,
    OPENAI_MODEL: s.openaiModel ?? undefined,
    CODEX_MODEL: s.codexModel ?? undefined,
  };
  // LLM runnerへ渡すsecretは選択providerが実際に使う1種類だけ。サーバ経路ではorigin承認resolverを
  // 必須配線し、CLI経路だけ従来の明示env入力へフォールバックする。
  if (s.provider === "openai-compat" && s.baseUrl) {
    out.OPENAI_COMPAT_API_KEY = apiKeyForBaseUrl
      ? apiKeyForBaseUrl(s.baseUrl)
      : env.OPENAI_COMPAT_API_KEY?.trim() || undefined;
  }
  if (s.provider === "openai") {
    out.OPENAI_API_KEY = openAiApiKey ?? (env.OPENAI_API_KEY?.trim() || undefined);
  }
  return out;
}

/**
 * health.llmReady 集約判定（Tauri Phase 2 T3 fix）が使う純関数: グローバル設定（DB行。無ければ
 * DEFAULT_LLM_SETTINGS=claude）を反映した「有効env」上で、openai-compatが実際に選択され、
 * かつ接続に必要なbaseUrl/modelが揃っているかを判定する。
 * selectRunner/resolveRoleRunnerが実際に使うのと同じ resolveProviderKey/settingsToEnv を再利用する
 * ことで、判定ロジックの二重実装（＝ドリフト）を避ける。
 */
export function isOpenAiCompatReady(
  settings: LlmSettings | null,
  env: Record<string, string | undefined> = Bun.env,
): boolean {
  const effectiveEnv = settingsToEnv(settings ?? DEFAULT_LLM_SETTINGS, env);
  return (
    resolveProviderKey(effectiveEnv) === "openai-compat" &&
    Boolean(effectiveEnv.OPENAI_COMPAT_BASE_URL?.trim()) &&
    Boolean(effectiveEnv.OPENAI_COMPAT_MODEL?.trim())
  );
}

/** OpenAI 公式経路が選択され、モデルと専用キーが揃っているかを判定する。 */
export function isOpenAiReady(
  settings: LlmSettings | null,
  env: Record<string, string | undefined> = Bun.env,
): boolean {
  const effectiveEnv = settingsToEnv(settings ?? DEFAULT_LLM_SETTINGS, env);
  return resolveProviderKey(effectiveEnv) === "openai"
    && Boolean(effectiveEnv.OPENAI_MODEL?.trim())
    && Boolean(effectiveEnv.OPENAI_API_KEY?.trim());
}
