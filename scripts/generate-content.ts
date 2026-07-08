#!/usr/bin/env bun
/**
 * 実力データ駆動のコンテンツ生成CLI（完全オリジナル教材を追加する）。
 *   bun scripts/generate-content.ts sentences   [--dry]  # SRSの苦手カテゴリに新規例文を各4文追記
 *   bun scripts/generate-content.ts topics      [--dry]  # 現在ステージ向けのお題2本+シナリオ1本を追加
 *   bun scripts/generate-content.ts scenarios   [--dry]  # stage1帯のbusiness/ITロールプレイを1本ずつ生成
 *   bun scripts/generate-content.ts topics-band [--dry]  # stage1帯のbusiness/ITお題を2本ずつ生成
 *   bun scripts/generate-content.ts listening   [--dry]  # content-coverageの不足セル分だけ多聴素材を生成
 *                                                          # （3帯[1,2]/[3,4]/[5,6]×3domain×quota4本・既存のbridge教材はquota外で温存・べき等）
 *   bun scripts/generate-content.ts spoken-functions [--dry]  # spoken function例文(依頼/断り/聞き返し/言い換え/相槌)を
 *                                                          # 3帯×5カテゴリ×quota6本=最大90文生成 + 解説を同一フローで生成（帯×カテゴリ単位でべき等）
 *   bun scripts/generate-content.ts topics-target    --band <foundation|development|fluency> --domain <daily|business|it> --count <n> [--dry]
 *                                                          # 帯×domain×countを明示指定してtopicを生成（experienceAnchor必須）
 *   bun scripts/generate-content.ts scenarios-target --band <...> --domain <...> --count <n> [--dry]
 *                                                          # 同上（scenario・starter口語検証必須）
 *   bun scripts/generate-content.ts listening-target --band <...> --domain <...> --count <n> [--dry]
 *                                                          # 同上（listening・特定セルだけ狙い撃ちで再生成したい時用）
 *   bun scripts/generate-content.ts --fill-coverage [--dry]
 *                                                          # content-coverageの不足セル（帯×domain×topics/scenarios/listening）を
 *                                                          # 優先順（bridge込みでもカバレッジゼロのセルを先頭）に全自動で埋める
 * --dry はプレビューのみ（ファイルを書かない）。書き込み前バリデーションに失敗したら何も書かずに終了する。
 * 既定は Claude Agent SDK（サブスクリプション認証）。LLM_PROVIDER で openai-compat / codex に切替可能。
 * チューニング env はこの CLI だけが解釈する（サーバ/UI 経路は env チューニングを一切読まない）:
 *   LLM_PROVIDER=claude（既定）: CLAUDE_MODEL（haiku|sonnet|opus）/ CLAUDE_EFFORT（low|medium|high|xhigh|max）
 *   LLM_PROVIDER=codex: CODEX_REASONING_EFFORT（low|medium|high|xhigh|max）/ CODEX_SERVICE_TIER（fast|standard）
 * 恒久教材の生成には LLM_PROVIDER=claude CLAUDE_MODEL=opus CLAUDE_EFFORT=high を推奨。
 * このファイルは依存関係の組み立てだけを行う薄いラッパ。コア生成ロジックは app/server/content-gen.ts。
 */
import { openDb } from "../app/server/db";
import {
  genSentences, genTopics, genScenarios, genTopicsBand, genListening,
  genTopicsForTarget, genScenariosForTarget, genListeningForTarget,
  genSpokenFunctionSentences, genMissingSentenceExplanations,
} from "../app/server/content-gen";
import { resolveCliRunner } from "../app/server/converse";
import { resolveProviderKey } from "../app/server/llm-provider";
import { CLAUDE_MODELS, EFFORTS, SERVICE_TIERS, type RoleTuning } from "../app/server/llm-role-tuning-store";
import { makeProgressStore } from "../app/server/progress-store";
import { stageOf } from "../app/server/progression";
import { SENTENCES_FILE, EXPLANATIONS_FILE, SCENARIOS_DIR, TOPICS_DIR, LISTENING_DIR } from "../app/server/paths";
import { loadContent, DOMAINS, type Domain } from "../app/server/content";
import { loadListening } from "../app/server/listening";
import {
  computeBandCoverageStatuses, prioritizeFillTasks, BANDS, type Band, type BandCoverageStatus,
} from "../app/server/content-coverage";

const sub = process.argv[2];
const dry = process.argv.includes("--dry");

/** env の選択値を読む。未設定/空白は null（既定に従う）、不正値は許容値を提示して即終了（LLM 呼び出し前）。 */
function envChoice(name: string, allowed: readonly string[]): string | null {
  const raw = Bun.env[name]?.trim();
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
  const provider = resolveProviderKey(Bun.env);
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

/** --band/--domain/--count のフラグ値を読む（値なし・フラグ自体が無い場合は undefined） */
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function parseBandArg(): Band {
  const raw = argValue("--band");
  if (!raw || !(BANDS as readonly string[]).includes(raw)) {
    console.error(`--band は必須です。許容値: ${BANDS.join(", ")}`);
    process.exit(1);
  }
  return raw as Band;
}

function parseDomainArg(): Domain {
  const raw = argValue("--domain");
  if (!raw || !(DOMAINS as readonly string[]).includes(raw)) {
    console.error(`--domain は必須です。許容値: ${DOMAINS.join(", ")}`);
    process.exit(1);
  }
  return raw as Domain;
}

function parseCountArg(): number {
  const raw = argValue("--count");
  const n = raw ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    console.error("--count は1以上の整数で指定してください。");
    process.exit(1);
  }
  return n;
}

/**
 * 帯×domain×topics/scenarios/listeningの不足セルを、優先順（bridge込みでもカバレッジゼロのセルを先頭、次いで
 * 必要生成数の多い順）に全自動で埋める（content-ladder設計doc§8 wave1・listeningはwave2でLISTENING_PLAN自体を
 * 3帯化してから合流）。
 * 1セルでも3ラウンド規律で検証を通せなければ gen*ForTarget が例外を投げ、ここで捕まえず main() の catch まで
 * 伝播させて非ゼロ終了する（その時点までに完了した他セルのファイル書き込みはそのセル単位でall-or-nothingのため残る）。
 */
async function runFillCoverage(): Promise<void> {
  const topicItems = loadContent(TOPICS_DIR).map((c) => ({ id: c.id, domain: c.domain, level: c.level }));
  const scenarioItems = loadContent(SCENARIOS_DIR).map((c) => ({ id: c.id, domain: c.domain, level: c.level }));
  const listeningItems = loadListening(LISTENING_DIR).map((it) => ({ id: it.id, domain: it.domain, level: it.level }));
  const tasks: BandCoverageStatus[] = prioritizeFillTasks([
    ...computeBandCoverageStatuses("topics", topicItems),
    ...computeBandCoverageStatuses("scenarios", scenarioItems),
    ...computeBandCoverageStatuses("listening", listeningItems),
  ]);

  if (tasks.length === 0) {
    console.log("不足セルはありません（topics/scenarios/listening とも quota 充足済み）。");
    return;
  }
  console.log(`不足セル: ${tasks.length}件（優先順に実行します。bridge込みでもカバレッジゼロのセルを先頭）`);
  for (const task of tasks) {
    const zeroNote = task.zeroEvenWithBridge ? " ※bridge込みでも空白（無警告振替の実害セル）" : "";
    console.log(`\n=== ${task.type} / ${task.domain} / ${task.band} (${task.neededCount}本)${zeroNote} ===`);
    if (task.type === "topics") {
      await genTopicsForTarget({
        runner, topicsDir: TOPICS_DIR, domain: task.domain, band: task.band, count: task.neededCount, dry, log: console.log,
      });
    } else if (task.type === "scenarios") {
      await genScenariosForTarget({
        runner, scenariosDir: SCENARIOS_DIR, domain: task.domain, band: task.band, count: task.neededCount, dry, log: console.log,
      });
    } else if (task.type === "listening") {
      await genListeningForTarget({
        runner, listeningDir: LISTENING_DIR, domain: task.domain, band: task.band, count: task.neededCount, dry, log: console.log,
      });
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--fill-coverage")) {
    await runFillCoverage();
    return;
  }
  if (sub === "topics-target") {
    await genTopicsForTarget({
      runner, topicsDir: TOPICS_DIR, domain: parseDomainArg(), band: parseBandArg(), count: parseCountArg(), dry, log: console.log,
    });
    return;
  }
  if (sub === "scenarios-target") {
    await genScenariosForTarget({
      runner, scenariosDir: SCENARIOS_DIR, domain: parseDomainArg(), band: parseBandArg(), count: parseCountArg(), dry, log: console.log,
    });
    return;
  }
  if (sub === "listening-target") {
    await genListeningForTarget({
      runner, listeningDir: LISTENING_DIR, domain: parseDomainArg(), band: parseBandArg(), count: parseCountArg(), dry, log: console.log,
    });
    return;
  }

  const db = openDb();
  const stage = stageOf(makeProgressStore(db).getLevel());
  if (sub === "sentences") {
    await genSentences({ runner, sentencesFile: SENTENCES_FILE, db, stage, dry, log: console.log });
  } else if (sub === "topics") {
    await genTopics({ runner, topicsDir: TOPICS_DIR, scenariosDir: SCENARIOS_DIR, stage, dry, log: console.log });
  } else if (sub === "scenarios") {
    await genScenarios({ runner, scenariosDir: SCENARIOS_DIR, dry, log: console.log });
  } else if (sub === "topics-band") {
    await genTopicsBand({ runner, topicsDir: TOPICS_DIR, dry, log: console.log });
  } else if (sub === "listening") {
    await genListening({ runner, listeningDir: LISTENING_DIR, dry, log: console.log });
  } else if (sub === "spoken-functions") {
    // 帯別30(計90)の例文本体を先に確定させてから、その差分ぶんだけ解説を生成する（同じ実行フロー内で完結）
    await genSpokenFunctionSentences({ runner, sentencesFile: SENTENCES_FILE, dry, log: console.log });
    await genMissingSentenceExplanations({ runner, sentencesFile: SENTENCES_FILE, explanationsFile: EXPLANATIONS_FILE, dry, log: console.log });
  } else {
    console.error(
      "使い方: bun scripts/generate-content.ts <sentences|topics|scenarios|topics-band|listening|spoken-functions|topics-target|scenarios-target|listening-target> [--dry]\n" +
      "       bun scripts/generate-content.ts --fill-coverage [--dry]",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
