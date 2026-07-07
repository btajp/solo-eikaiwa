import { query } from "@anthropic-ai/claude-agent-sdk";
import { selectRunner, settingsToEnv, type LlmSettings } from "./llm-provider";
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
let currentRunner: ClaudeRunner = selectRunner({
  claudeRunner,
  defaultSystemPrompt: PARTNER_SYSTEM_PROMPT,
});
export const defaultRunner: ClaudeRunner = (prompt, resumeId, opts) =>
  currentRunner(prompt, resumeId, opts);

/** 現在アクティブな runner を返す（診断・テスト用のシーム）。 */
export function getCurrentRunner(): ClaudeRunner {
  return currentRunner;
}

/**
 * DB 由来の LLM 設定を実行中プロセスへ即時適用する（再起動不要）。
 * 既存 selectRunner を再利用し、新しいアダプタは作らない。settingsToEnv が DB 設定を env 形状へ写像し、
 * APIキーは env（.env）由来のみ。検証済み入力に対しては throw しない（openai-compat の必須値は route が保証）。
 * 不正な provider 等では selectRunner が throw しうるため、起動時適用側（index.ts）で fail-open ガードする。
 */
export function applyLlmSettings(
  settings: LlmSettings,
  env: Record<string, string | undefined> = Bun.env,
): void {
  currentRunner = selectRunner({
    claudeRunner,
    defaultSystemPrompt: PARTNER_SYSTEM_PROMPT,
    env: settingsToEnv(settings, env),
  });
}

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
