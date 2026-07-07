#!/usr/bin/env bun
/**
 * 実力データ駆動のコンテンツ生成CLI（完全オリジナル教材を追加する）。
 *   bun scripts/generate-content.ts sentences [--dry]  # SRSの苦手カテゴリに新規例文を各4文追記
 *   bun scripts/generate-content.ts topics    [--dry]  # 現在ステージ向けのお題2本+シナリオ1本を追加
 *   bun scripts/generate-content.ts scenarios [--dry]  # stage1帯のbusiness/ITロールプレイを1本ずつ生成
 *   bun scripts/generate-content.ts listening [--dry]  # 多聴素材を6本（3ドメイン×上下2帯）生成
 * --dry はプレビューのみ（ファイルを書かない）。書き込み前バリデーションに失敗したら何も書かずに終了する。
 * 対話AIは Claude Agent SDK（サブスクリプション認証）を使う。
 * このファイルは依存関係の組み立てだけを行う薄いラッパ。コア生成ロジックは app/server/content-gen.ts。
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { openDb } from "../app/server/db";
import { genSentences, genTopics, genScenarios, genListening } from "../app/server/content-gen";
import { makeClaudeRunner } from "../app/server/converse";
import { makeProgressStore } from "../app/server/progress-store";
import { stageOf } from "../app/server/progression";
import { SENTENCES_FILE, SCENARIOS_DIR, TOPICS_DIR, LISTENING_DIR } from "../app/server/paths";

const sub = process.argv[2];
const dry = process.argv.includes("--dry");
const runner = makeClaudeRunner(query);

async function main(): Promise<void> {
  const db = openDb();
  const stage = stageOf(makeProgressStore(db).getLevel());
  if (sub === "sentences") {
    await genSentences({ runner, sentencesFile: SENTENCES_FILE, db, stage, dry, log: console.log });
  } else if (sub === "topics") {
    await genTopics({ runner, topicsDir: TOPICS_DIR, scenariosDir: SCENARIOS_DIR, stage, dry, log: console.log });
  } else if (sub === "scenarios") {
    await genScenarios({ runner, scenariosDir: SCENARIOS_DIR, dry, log: console.log });
  } else if (sub === "listening") {
    await genListening({ runner, listeningDir: LISTENING_DIR, dry, log: console.log });
  } else {
    console.error("使い方: bun scripts/generate-content.ts <sentences|topics|scenarios|listening> [--dry]");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
