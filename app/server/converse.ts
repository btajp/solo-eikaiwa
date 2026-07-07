import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  selectRunner, settingsToEnv, roleSettingToSettings, isInheritRole, LLM_ROLES,
  type LlmSettings, type LlmRole, type LlmRoleSetting,
} from "./llm-provider";
import { conversationWarmup } from "./llm-warmup";
import { openAICompatWarmTargetFromEnv } from "./providers/openai-compat";
import { appendEvent, markErrorLogged } from "./session-log";
import { sessionLogPath } from "./paths";
import { vocabConstraint } from "./progression";

export function partnerSystemPrompt(stage: number): string {
  return `You are an English conversation partner for a Japanese IT professional (CEFR A2-B1).
- You are a friendly colleague. Talk about tech work, identity management, security, AI — or whatever the learner brings up.
- Keep every reply SHORT: 2-4 sentences, then ask ONE follow-up question.
- ${vocabConstraint(stage) ?? "Use plain, high-frequency English (B1 level). No rare idioms."}
- Do NOT correct errors explicitly in this mode; just respond naturally (recast briefly only when meaning is unclear).
- Never switch to Japanese.
- Do not use any tools — reply directly with text only.`;
}

/**
 * makeClaudeRunner の runner が systemPrompt 未指定時に使うフォールバック既定。
 * routes/converse.ts の handleConverse は自由会話・シナリオ会話のどちらでも必ず systemPromptOverride を組んで渡すため、
 * 実運用のリクエスト経路ではこのフォールバックに到達しない。テストや makeClaudeRunner の直接呼び出し用の既定値。
 */
export const PARTNER_SYSTEM_PROMPT = partnerSystemPrompt(1);

export type ClaudeRunner = (
  prompt: string,
  resumeId?: string,
  opts?: { systemPrompt?: string },
) => Promise<{ text: string; sessionId: string }>;

export function makeClaudeRunner(queryFn: typeof query): ClaudeRunner {
  return async (prompt, resumeId, opts) => {
    let sessionId = resumeId ?? "";
    let text = "";
    for await (const msg of queryFn({
      prompt,
      options: {
        systemPrompt: opts?.systemPrompt ?? PARTNER_SYSTEM_PROMPT,
        model: "sonnet",
        // `allowedTools` only controls auto-allow/permission-prompt behavior; per the SDK's own
        // sdk.d.ts docs it does NOT restrict which tools the model can see ("To restrict which
        // tools are available, use the `tools` option instead."). An empty allowedTools array
        // still leaves every built-in tool in the model's context, so it could still emit a
        // tool_use and burn our single maxTurns budget → error_max_turns. `tools: []` is the
        // option sdk.d.ts documents as "Disable all built-in tools", which is what we want here.
        tools: [],
        maxTurns: 1,
        ...(resumeId ? { resume: resumeId } : {}),
      },
    })) {
      if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          text = msg.result;
        } else {
          const details: string[] = [];
          if (msg.stop_reason) details.push(`stop_reason=${msg.stop_reason}`);
          if (msg.errors?.length) details.push(`errors=${msg.errors.join("; ")}`);
          const suffix = details.length ? `: ${details.join(", ")}` : "";
          throw new Error(`Claude result error (${msg.subtype})${suffix}`);
        }
      }
    }
    if (!text) throw new Error("Claude returned empty result");
    return { text, sessionId };
  };
}

/**
 * 全ドメイン共有の LLM ランナー（唯一の makeClaudeRunner(query) 生成点）。
 * プロンプト配置規約: 各ドメインの system プロンプトはそのドメインモジュール
 * （coach.ts / placement.ts / assessment.ts / content-gen.ts / converse.ts）に置き、
 * ここでは実行器だけを共有する。
 *
 * ランタイム切替: defaultRunner は「現在の currentRunner に委譲する安定参照のラッパ」。
 * 6つの呼び出し側（coach / placement / assessment / converse / scripts/generate-content）は
 * `runner: ClaudeRunner = defaultRunner` のまま無変更で、applyLlmSettings による
 * currentRunner の差し替えが即座に反映される（再起動不要）。
 * claudeRunner は一度だけ生成して使い回すので、claude/env に戻すと同一参照へ戻る。
 */
const claudeRunner = makeClaudeRunner(query);

/** env を渡して runner を1つ解決する薄いヘルパ（env 省略で Bun.env・= 現行の初期化と同一）。 */
function resolveRunner(env?: Record<string, string | undefined>): ClaudeRunner {
  return selectRunner({
    claudeRunner,
    defaultSystemPrompt: PARTNER_SYSTEM_PROMPT,
    ...(env ? { env } : {}),
  });
}

/**
 * ロール別の「現在解決済み runner」。モジュールロード時は全ロール pure-env baseline
 * （env/claude では resolveRunner が同一の claudeRunner を返すので、全ロール同一参照＝現行と完全一致）。
 */
const currentRunners = new Map<LlmRole, ClaudeRunner>(LLM_ROLES.map((r) => [r, resolveRunner()]));

/**
 * ロール別の「安定参照ラッパ」。呼び出し側（index.ts の runnerFor(role)）はこのラッパを保持し続け、
 * applyLlmRoleSettings による currentRunners 差し替えが再起動なしで反映される。
 */
const roleWrappers = new Map<LlmRole, ClaudeRunner>(
  LLM_ROLES.map((r) => [r, (prompt: string, resumeId?: string, opts?: { systemPrompt?: string }) =>
    currentRunners.get(r)!(prompt, resumeId, opts)]),
);

/** ロールに紐づく安定参照ランナーを返す（index.ts の各呼び出し側がこれを注入する）。 */
export function runnerFor(role: LlmRole): ClaudeRunner {
  return roleWrappers.get(role)!;
}

/**
 * 後方互換の全ドメイン既定ランナー（conversation ロールへ委譲する安定参照）。
 * 各ドメイン関数の `runner: ClaudeRunner = defaultRunner` 既定はこのまま（実運用の配線は index.ts が runnerFor(role) を渡す）。
 */
export const defaultRunner: ClaudeRunner = (prompt, resumeId, opts) =>
  currentRunners.get("conversation")!(prompt, resumeId, opts);

/** 指定ロールの解決済み runner を返す（診断・テスト用のシーム）。既定は conversation（後方互換）。 */
export function getCurrentRunner(role: LlmRole = "conversation"): ClaudeRunner {
  return currentRunners.get(role)!;
}

/**
 * 全体設定 + ロール別設定から4ロールの runner を一括再解決する（再起動不要）。
 * inherit ロールは global の runner を共有参照する（= 全 inherit なら全ロール同一参照）。
 * APIキーは env（.env）由来のみ（settingsToEnv が担保）。不正 provider 等では selectRunner が throw しうるため、
 * 起動時適用側（index.ts）とルート層で fail-open ガードする。
 */
export function applyLlmRoleSettings(
  global: LlmSettings,
  roles: Record<LlmRole, LlmRoleSetting>,
  env: Record<string, string | undefined> = Bun.env,
): void {
  const globalRunner = resolveRunner(settingsToEnv(global, env));
  for (const role of LLM_ROLES) {
    const rs = roles[role];
    currentRunners.set(
      role,
      isInheritRole(rs) ? globalRunner : resolveRunner(settingsToEnv(roleSettingToSettings(rs), env)),
    );
  }
  // conversation の解決先が openai-compat のときだけ warm 対象を更新する（inherit なら global を辿る）。
  const convSetting = isInheritRole(roles.conversation) ? global : roleSettingToSettings(roles.conversation);
  conversationWarmup.setTarget(openAICompatWarmTargetFromEnv(settingsToEnv(convSetting, env)));
}

/**
 * 後方互換: 全体設定のみを適用する（全ロール inherit として apply）。
 * 既存の起動時適用・テストがこの形で呼ぶ。ロール別上書きを保持したい配線は index.ts 側で
 * applyLlmRoleSettings(global, roleStore.getAll()) を使う。
 */
export function applyLlmSettings(
  settings: LlmSettings,
  env: Record<string, string | undefined> = Bun.env,
): void {
  const allInherit = Object.fromEntries(
    LLM_ROLES.map((r) => [r, { provider: "inherit" as const, baseUrl: null, model: null, codexModel: null }]),
  ) as Record<LlmRole, LlmRoleSetting>;
  applyLlmRoleSettings(settings, allInherit, env);
}

// 起動時: env 由来 provider（DB 未設定で env が openai-compat を指す構成）も warm 対象にする。
// 以後は applyLlmRoleSettings が呼ばれるたびに最新の conversation 解決先へ更新される。
conversationWarmup.setTarget(openAICompatWarmTargetFromEnv(Bun.env));

export async function converseTurn(args: {
  userText: string;
  sessionId?: string;
  runner?: ClaudeRunner;
  logFile?: string;
  systemPromptOverride?: string;
}): Promise<{ replyText: string; sessionId: string }> {
  const runner = args.runner ?? defaultRunner;
  const logFile = args.logFile ?? sessionLogPath(new Date());
  const now = () => new Date().toISOString();

  appendEvent(logFile, {
    ts: now(), type: "user_utterance", sessionId: args.sessionId ?? "pending", text: args.userText,
  });

  let text: string;
  let sessionId: string;
  try {
    ({ text, sessionId } = await runner(
      args.userText,
      args.sessionId,
      args.systemPromptOverride ? { systemPrompt: args.systemPromptOverride } : undefined,
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendEvent(logFile, {
      ts: now(), type: "error", sessionId: args.sessionId ?? "pending", text: message,
    });
    markErrorLogged(err);
    throw err;
  }

  appendEvent(logFile, { ts: now(), type: "assistant_reply", sessionId, text });
  return { replyText: text, sessionId };
}
