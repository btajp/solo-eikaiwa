import { query, type EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import {
  selectRunner, settingsToEnv, roleSettingToSettings, isInheritRole, resolveProviderKey, LLM_ROLES,
  type LlmSettings, type LlmRole, type LlmRoleSetting,
} from "./llm-provider";
import { conversationWarmup } from "./llm-warmup";
import { openAICompatWarmTargetFromEnv } from "./providers/openai-compat";
import { TransportError } from "./providers/errors";
import { withFallback, withTimeout } from "./providers/decorators";
import { makeClaudePrintRunner } from "./providers/claude-print";
import { appendEvent, markErrorLogged } from "./session-log";
import { sessionLogPath } from "./paths";
import { vocabConstraint } from "./progression";
import type { RoleTuning } from "./llm-role-tuning-store";
import { getActiveAuthModes, claudeSpawnEnv } from "./llm-auth-store";

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

export function makeClaudeRunner(
  queryFn: typeof query,
  cfg?: { model?: string; effort?: string },
): ClaudeRunner {
  return async (prompt, resumeId, opts) => {
    let sessionId = resumeId ?? "";
    let text = "";
    // 2相エラー分類（binding、providers/decorators.ts の withFallback の判定基盤）:
    // SDK から最初のメッセージを受け取る前に throw した例外はプロセス起動・ハンドシェイク等の
    // transport 起因とみなし TransportError に包む（cause 保持）。query() 呼び出し自体の同期 throw
    // （例: ネイティブ CLI バイナリ欠損の起動前バリデーション）も iterator 以前の失敗として同じ扱い。
    // 最初のメッセージ以後の失敗（下の result subtype エラー・末尾の空 text）はモデル起因として
    // 現行どおり plain Error のまま投げる。メッセージ文字列の sniffing はしない — 「最初のメッセージを
    // 受け取ったかどうか」という時系列だけで分岐する。
    const asTransportError = (err: unknown) =>
      new TransportError(
        `Claude SDK failed before first message: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );

    let receivedFirstMessage = false;
    // api-key 認証モードのときだけ ANTHROPIC_API_KEY を注入した env を渡す（subscription では undefined のまま
    // options.env 自体を渡さず、現行どおり SDK が process.env を継承する＝挙動不変の核）。モードは呼び出しごとに
    // 都度参照する（llm-auth-store.ts の getActiveAuthModes 参照）ため、claudeRunner が module-level 単一
    // インスタンスのままでも PUT 直後の切替がサーバ再起動なしに反映される。
    const claudeAuthEnv = claudeSpawnEnv(getActiveAuthModes().claude);
    const iterator = (() => {
      try {
        return queryFn({
          prompt,
          options: {
            systemPrompt: opts?.systemPrompt ?? PARTNER_SYSTEM_PROMPT,
            model: cfg?.model ?? "sonnet",
            ...(cfg?.effort ? { effort: cfg.effort as EffortLevel } : {}),
            // `allowedTools` only controls auto-allow/permission-prompt behavior; per the SDK's own
            // sdk.d.ts docs it does NOT restrict which tools the model can see ("To restrict which
            // tools are available, use the `tools` option instead."). An empty allowedTools array
            // still leaves every built-in tool in the model's context, so it could still emit a
            // tool_use and burn our single maxTurns budget → error_max_turns. `tools: []` is the
            // option sdk.d.ts documents as "Disable all built-in tools", which is what we want here.
            tools: [],
            maxTurns: 1,
            ...(resumeId ? { resume: resumeId } : {}),
            ...(claudeAuthEnv ? { env: claudeAuthEnv } : {}),
          },
        })[Symbol.asyncIterator]();
      } catch (err) {
        throw asTransportError(err);
      }
    })();

    while (true) {
      let step: Awaited<ReturnType<typeof iterator.next>>;
      try {
        step = await iterator.next();
      } catch (err) {
        if (receivedFirstMessage) throw err;
        throw asTransportError(err);
      }
      if (step.done) break;
      receivedFirstMessage = true;
      const msg = step.value;
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
 * claude 経路既定チューニング（純コード定数）。サーバは env のチューニング（CLAUDE_MODEL/CLAUDE_EFFORT）を
 * 一切読まない — UI の既定表示（既定（sonnet）/ 既定（SDK標準））と実挙動の乖離を機構的に防ぐため。
 * env の解釈は CLI エントリポイント（scripts/generate-content.ts）だけが行い、resolveCliRunner へ明示的に渡す。
 * module-level claudeRunner を1度だけ組み立てる際に使う。ロール別の優先順位式は resolveClaudeTuning が担う。
 */
const CLAUDE_DEFAULT_TUNING: { model: string; effort?: string } = { model: "sonnet" };

/**
 * 全ドメイン共有の claude ランナー（唯一の module-level 単一インスタンス）。
 * プロンプト配置規約: 各ドメインの system プロンプトはそのドメインモジュール
 * （coach.ts / placement.ts / assessment.ts / content-gen.ts / converse.ts）に置き、
 * ここでは実行器だけを共有する。
 *
 * 合成: SDK 経路（withTimeout でハング打ち切り）を primary、`claude -p` ワンショット（claude-print.ts）を
 * フォールバックにした withFallback 合成（transport 障害時のみ委譲。モデル起因の失敗は委譲しない）。
 *
 * ランタイム切替: defaultRunner は「現在の currentRunner に委譲する安定参照のラッパ」。
 * 6つの呼び出し側（coach / placement / assessment / converse / scripts/generate-content）は
 * `runner: ClaudeRunner = defaultRunner` のまま無変更で、applyLlmSettings による
 * currentRunner の差し替えが即座に反映される（再起動不要）。
 * claudeRunner は一度だけ生成して使い回すので、claude/env に戻す・tuning が空のロールは同一参照へ戻る
 * （resolveClaudeRunner の回帰基準）。
 */
export const claudeRunner: ClaudeRunner = withFallback(
  withTimeout(makeClaudeRunner(query, CLAUDE_DEFAULT_TUNING)),
  makeClaudePrintRunner({ ...CLAUDE_DEFAULT_TUNING, defaultSystemPrompt: PARTNER_SYSTEM_PROMPT }),
);

/**
 * ロール別チューニングの優先順位式（binding）: tuning.claudeModel > "sonnet" / tuning.effort > 未指定（SDK標準）。
 * env のチューニング（CLAUDE_MODEL/CLAUDE_EFFORT）は読まない（UI の既定表示と実挙動の乖離を機構的に防ぐ）。
 * rt が claudeModel/effort とも null（未カスタマイズ）なら undefined を返す — 呼び出し側
 * （resolveClaudeRunner）はこれを「空」トリガーとして module-level claudeRunner の単一参照を返す（回帰基準）。
 */
export function resolveClaudeTuning(rt: RoleTuning): { model?: string; effort?: string } | undefined {
  if (rt.claudeModel === null && rt.effort === null) return undefined;
  return {
    model: rt.claudeModel ?? "sonnet",
    effort: rt.effort ?? undefined,
  };
}

/**
 * tuning から claude 用 ClaudeRunner を解決する。tuning が空（model/effort とも未指定）なら
 * module-level claudeRunner（withFallback/withTimeout/claude-print 合成済みの単一参照）をそのまま返す
 * （「claude/env に戻すと同一参照」回帰基準の維持）。指定ありなら SDK・`claude -p` の両方をその
 * model/effort で組み直した新規合成を返す。
 */
export function resolveClaudeRunner(tuning?: { model?: string; effort?: string }): ClaudeRunner {
  if (!tuning || (tuning.model === undefined && tuning.effort === undefined)) return claudeRunner;
  return withFallback(
    withTimeout(makeClaudeRunner(query, tuning)),
    makeClaudePrintRunner({ ...tuning, defaultSystemPrompt: PARTNER_SYSTEM_PROMPT }),
  );
}

/** チューニング行が完全に既定（3項目とも null）かどうか。 */
const EMPTY_TUNING: RoleTuning = { claudeModel: null, effort: null, serviceTier: null };
function isEmptyTuning(rt: RoleTuning): boolean {
  return rt.claudeModel === null && rt.effort === null && rt.serviceTier === null;
}

/** provider="env"（DB未設定=pure env）の LlmSettings。モジュール初期化時の既定解決に使う。 */
const ENV_SETTINGS: LlmSettings = { provider: "env", baseUrl: null, model: null, codexModel: null };

/**
 * 「有効設定 + そのロールのチューニング」から1ロール分の runner を解決する核関数。
 * 有効プロバイダが claude（またはenv解決の結果claudeに落ちる場合）なら resolveClaudeRunner に委譲し
 * （tuning は resolveClaudeTuning で優先順位式を通す。circular import 回避のため llm-provider.ts の
 * selectRunner はここに関与しない）、それ以外（openai-compat/codex）は selectRunner に委譲する
 * （tuning.effort/serviceTier をそのまま渡し、codex 分岐でのみ消費される）。
 */
function resolveRoleRunner(
  settings: LlmSettings,
  rt: RoleTuning,
  env: Record<string, string | undefined>,
): ClaudeRunner {
  const roleEnv = settingsToEnv(settings, env);
  const provider = resolveProviderKey(roleEnv);
  if (provider === "" || provider === "claude") {
    return resolveClaudeRunner(resolveClaudeTuning(rt));
  }
  return selectRunner({
    claudeRunner,
    defaultSystemPrompt: PARTNER_SYSTEM_PROMPT,
    env: roleEnv,
    tuning: { effort: rt.effort ?? undefined, serviceTier: rt.serviceTier ?? undefined },
  });
}

/**
 * CLI（scripts/generate-content.ts 等のヘッドレス実行）用: env によるプロバイダ解決（LLM_PROVIDER・接続 env）に
 * 明示チューニングを重ねて runner を1つ解決する。サーバ/UI 経路は env チューニングを一切読まないため、
 * CLI プロセスは自分の env（CLAUDE_MODEL / CLAUDE_EFFORT / CODEX_REASONING_EFFORT / CODEX_SERVICE_TIER）を
 * エントリポイントで検証・解釈し、RoleTuning としてここへ渡す（CLI プロセスの env はそのプロセスのインターフェース）。
 */
export function resolveCliRunner(rt: RoleTuning, env: Record<string, string | undefined> = Bun.env): ClaudeRunner {
  return resolveRoleRunner(ENV_SETTINGS, rt, env);
}

/**
 * ロール別の「現在解決済み runner」。モジュールロード時は全ロール pure-env baseline・tuning 無し
 * （env/claude では resolveRoleRunner が同一の claudeRunner を返すので、全ロール同一参照＝現行と完全一致）。
 */
const currentRunners = new Map<LlmRole, ClaudeRunner>(
  LLM_ROLES.map((r) => [r, resolveRoleRunner(ENV_SETTINGS, EMPTY_TUNING, Bun.env)]),
);

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
 * 全体設定 + ロール別設定 + ロール別チューニングから5ロールの runner を一括再解決する（再起動不要）。
 * inherit ロールでチューニングも空（3項目とも null）のものは global の runner を共有参照する
 * （= 全 inherit かつ tuning 全 null なら全ロール同一参照＝既定挙動不変）。inherit でもそのロール自身の
 * チューニングが入っていれば独立に解決する（例: 全ロール claude 継承のまま assessment だけ opus/xhigh）。
 * APIキーは env（.env）由来のみ（settingsToEnv が担保）。不正 provider 等では selectRunner が throw しうるため、
 * 起動時適用側（index.ts）とルート層で fail-open ガードする。
 */
export function applyLlmRoleSettings(
  global: LlmSettings,
  roles: Record<LlmRole, LlmRoleSetting>,
  env: Record<string, string | undefined> = Bun.env,
  tuning?: Record<LlmRole, RoleTuning>,
): void {
  const globalRunner = resolveRoleRunner(global, EMPTY_TUNING, env);
  for (const role of LLM_ROLES) {
    const rs = roles[role];
    const rt = tuning?.[role] ?? EMPTY_TUNING;
    currentRunners.set(
      role,
      isInheritRole(rs) && isEmptyTuning(rt)
        ? globalRunner
        : resolveRoleRunner(isInheritRole(rs) ? global : roleSettingToSettings(rs), rt, env),
    );
  }
  // assist の連鎖規則（binding）: assist の設定行が inherit のとき、assist は coaching の解決済み
  // ランナー「そのもの」と同一参照になる。coaching のチューニングも丸ごと引き継ぐ（assist 独自の
  // tuning 行があっても inherit の間は使われない＝連鎖の一貫性）。coaching も inherit かつ tuning 空
  // なら上のループで globalRunner が入っているため、結果として従来どおり global と同一参照になる。
  if (isInheritRole(roles.assist)) {
    currentRunners.set("assist", currentRunners.get("coaching")!);
  }
  // conversation の解決先が openai-compat のときだけ warm 対象を更新する（inherit なら global を辿る）。
  const convSetting = isInheritRole(roles.conversation) ? global : roleSettingToSettings(roles.conversation);
  conversationWarmup.setTarget(openAICompatWarmTargetFromEnv(settingsToEnv(convSetting, env)));
}

/**
 * 後方互換: 全体設定のみを適用する（全ロール inherit・tuning 無しとして apply）。
 * 既存の起動時適用・テストがこの形で呼ぶ。ロール別上書き・チューニングを保持したい配線は index.ts 側で
 * applyLlmRoleSettings(global, roleStore.getAll(), env, tuningStore.getAll()) を使う。
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
