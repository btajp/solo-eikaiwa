#!/usr/bin/env bun
/**
 * 4/3/2お題の「既知の内容」アンカー検証CLI（#182・check-content系ゲート）。
 *   bun scripts/check-topic-anchors.ts            # 全お題を検証。violationがあれば非ゼロ終了
 *   bun scripts/check-topic-anchors.ts --strict   # legacy未検証（grandfather分）も不合格として非ゼロ終了
 *
 * menu.ts は content/topics 全件を通常・クイック双方の4/3/2候補にするため、検証対象はディレクトリ全件。
 * 判定は app/server/topic-anchor-check.ts の auditTopicAnchors に委譲する:
 *   - verified: アンカー（experienceAnchor/memoryCue/commonObjectsOrActions）完備で checkTopicAnchor をPASS
 *   - legacyUnanchored: アンカー未整備だが LEGACY_UNANCHORED_TOPIC_IDS でgrandfatherされている既存お題
 *     （#182 の再生成バッチで解消し、完了したものから一覧を縮める。既定では非ゼロ終了の対象にしない）
 *   - violations: legacy一覧に無いのに検証FAIL（新規追加お題のアンカー欠落等）→ 常に非ゼロ終了
 * AI生成教材の手修正は禁止（AGENTS.md）— FAILしたお題は既存の生成・検証手順で再生成する。
 */
import { loadContent } from "../app/server/content";
import { TOPICS_DIR } from "../app/server/paths";
import { auditTopicAnchors, LEGACY_UNANCHORED_TOPIC_IDS } from "../app/server/topic-anchor-check";

function main(): void {
  const strict = process.argv.includes("--strict");
  const topics = loadContent(TOPICS_DIR);
  if (topics.length === 0) {
    console.error(`対象のお題がありません: ${TOPICS_DIR}`);
    process.exit(1);
  }
  const audit = auditTopicAnchors(topics);

  console.log(`4/3/2候補お題: ${topics.length}件 / アンカー検証済み: ${audit.verified.length}件`);
  if (audit.legacyUnanchored.length > 0) {
    console.log(`\n未検証（アンカー未整備のlegacyお題・#182の再生成で解消予定・${audit.legacyUnanchored.length}件）:`);
    for (const id of audit.legacyUnanchored) console.log(`  - ${id}`);
  }

  // legacy一覧の陳腐化検出（再生成でアンカー完備になった/削除されたのに一覧に残っている場合の掃除案内）
  const currentLegacy = new Set(audit.legacyUnanchored);
  const staleLegacy = LEGACY_UNANCHORED_TOPIC_IDS.filter((id) => !currentLegacy.has(id));
  if (staleLegacy.length > 0) {
    console.log(`\n情報: legacy一覧に残っていますが現物は解消済みです: ${staleLegacy.join(", ")}`);
    console.log("  → app/server/topic-anchor-check.ts の LEGACY_UNANCHORED_TOPIC_IDS から除去してください。");
  }

  if (audit.violations.length > 0) {
    console.log(`\n違反（legacy一覧外でアンカー検証FAIL・新規お題はアンカー必須）: ${audit.violations.length}件`);
    for (const v of audit.violations) console.log(`  - ${v.id}: ${v.reasons.join(" / ")}`);
  }

  const strictFail = strict && audit.legacyUnanchored.length > 0;
  if (audit.violations.length > 0 || strictFail) {
    console.log("\n結果: FAIL（AI生成教材の手修正は禁止 — 再生成で対応。AGENTS.md）");
    process.exit(1);
  }
  if (strict) console.log("\n結果: 全件PASS（strict）");
  else if (audit.legacyUnanchored.length === 0) console.log("\n結果: 全件PASS（violationなし・未検証legacyなし）");
  else console.log("\n結果: PASS（violationなし。未検証legacyは再生成で解消予定）");
  process.exit(0);
}

main();
