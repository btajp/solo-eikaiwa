import type { ClaudeRunner } from "./converse";
import { makeOpenAICompatRunner } from "./providers/openai-compat";
import { makeCodexRunner } from "./providers/codex";

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
        defaultSystemPrompt: args.defaultSystemPrompt,
      });

    default:
      throw new Error(`Unknown LLM_PROVIDER: ${provider} (expected claude | openai-compat | codex)`);
  }
}
