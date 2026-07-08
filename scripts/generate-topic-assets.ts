#!/usr/bin/env bun
/**
 * quota topics（36本・帯範囲ちょうどのlevelを持つtopic）の prepPack + model talk を一括生成し、
 * content/topic-assets/{topicId}.json へ同梱する（v0.26 content-ladder wave3）。
 *   bun scripts/generate-topic-assets.ts [--force]
 * --force: 既存ファイルが新鮮（sourceHash/promptVersion一致・帯内全stage揃い済み）でも強制再生成する。
 * 既定は Claude Agent SDK（サブスクリプション認証）。LLM_PROVIDER で openai-compat / codex に切替可能。
 * チューニング env はこの CLI だけが解釈する（サーバ/UI 経路は env チューニングを一切読まない）:
 *   LLM_PROVIDER=claude（既定）: CLAUDE_MODEL（haiku|sonnet|opus）/ CLAUDE_EFFORT（low|medium|high|xhigh|max）
 *   LLM_PROVIDER=codex: CODEX_REASONING_EFFORT（low|medium|high|xhigh|max）/ CODEX_SERVICE_TIER（fast|standard）
 * 恒久教材の生成には LLM_PROVIDER=claude CLAUDE_MODEL=opus CLAUDE_EFFORT=high を推奨。
 * このファイルは依存関係の組み立てだけを行う薄いラッパ。コア生成ロジックは app/server/topic-assets.ts。
 */
import { genTopicAssets } from "../app/server/topic-assets";
import { resolveCliRunner } from "../app/server/converse";
import { resolveProviderKey } from "../app/server/llm-provider";
import { CLAUDE_MODELS, EFFORTS, SERVICE_TIERS, type RoleTuning } from "../app/server/llm-role-tuning-store";
import { TOPICS_DIR, TOPIC_ASSETS_DIR } from "../app/server/paths";

/** env の選択値を読む。未設定/空白は null（既定に従う）、不正値は許容値を提示して即終了（LLM 呼び出し前）。 */
function envChoice(name: string, allowed: readonly string[]): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  if (!allowed.includes(raw)) {
    console.error(`${name}=${raw} は不正です。許容値: ${allowed.join(", ")}（未設定なら既定を使います）`);
    process.exit(1);
  }
  return raw;
}

/**
 * CLI の env チューニング解釈（サーバ/UI と同じホワイトリストで検証）。CLI プロセスの env はこのプロセスの
 * インターフェースなのでここで明示解釈し、resolveCliRunner へ渡す（サーバ経路は env チューニングを読まない）。
 */
function tuningFromEnv(): RoleTuning {
  const provider = resolveProviderKey(process.env);
  if (provider === "" || provider === "claude") {
    return { claudeModel: envChoice("CLAUDE_MODEL", CLAUDE_MODELS), effort: envChoice("CLAUDE_EFFORT", EFFORTS), serviceTier: null };
  }
  if (provider === "codex") {
    return { claudeModel: null, effort: envChoice("CODEX_REASONING_EFFORT", EFFORTS), serviceTier: envChoice("CODEX_SERVICE_TIER", SERVICE_TIERS) };
  }
  // openai-compat 等: 対応するチューニング項目なし（既定継承）
  return { claudeModel: null, effort: null, serviceTier: null };
}

const runner = resolveCliRunner(tuningFromEnv());
const force = process.argv.includes("--force");

genTopicAssets({ runner, topicsDir: TOPICS_DIR, assetsDir: TOPIC_ASSETS_DIR, force, log: console.log }).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
