/**
 * topic-assets 3層ルックアップ（v0.26 content-ladder wave3・設計doc §4）。
 * prepPack / model talk の解決順は「同梱JSON（content/topic-assets/{topicId}.json） → DBキャッシュ → 実行時生成」。
 * 生成そのもの（coach.ts の generatePrepPack/generateModelTalk）とその検証ゲート（spoken-register-check.ts）は
 * 変えず、この3層のあいだをどう振り分けるか・どう事前生成するかだけをこのモジュールが担う。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadContent, type ContentItem } from "./content";
import { isBridgeItem } from "./content-coverage";
import { generateModelTalk, generatePrepPack, type PrepPack } from "./coach";
import type { ClaudeRunner } from "./converse";
import { prepParams } from "./progression";
import { bandForLevel, checkModelTalk, checkPrepChunk } from "./spoken-register-check";

export type TopicAssetModelTalk = { text: string };
export type TopicAssetStageBundle = { prepPack?: PrepPack; modelTalk?: TopicAssetModelTalk };
export type TopicAssetFile = {
  topicId: string;
  sourceHash: string;
  promptVersion: string;
  /** キーは stage 番号の文字列表現（JSON のオブジェクトキーは文字列のみのため）。例: "3", "4" */
  byStage: Record<string, TopicAssetStageBundle>;
};

/**
 * 同梱アセットの生成仕様バージョン。coach.ts の modelTalkSystem / prepSystem の出力仕様（語数・構造・
 * ルール文言）や progression.ts の PREP_TABLE（stage→chunkCount/hintLang）を変更した場合は必ずbumpする。
 * bumpすると既存の同梱JSONは全件stale判定になり、次回アクセス時にDBキャッシュ/実行時生成へフォールバックする
 * （scripts/generate-topic-assets.ts を再実行して同梱を作り直すまでの安全弁）。
 */
export const TOPIC_ASSET_PROMPT_VERSION = "v1";

/**
 * sourceHash: topicファイルの「正本」= ディスク上の生ファイル内容そのもののsha256 hex。
 * 内容の意味的な差分（フィールド単位の比較等）ではなくバイト単位の内容そのものを対象にすることで、
 * topicの再生成・手直しによる変化を取りこぼしなく検出できる（意味的な差分抽出よりも単純で確実）。
 */
export function computeSourceHash(rawContent: string): string {
  return createHash("sha256").update(rawContent).digest("hex");
}

function isValidPrepPack(x: unknown): x is PrepPack {
  if (typeof x !== "object" || x === null) return false;
  const p = x as Partial<PrepPack>;
  if (!Array.isArray(p.chunks)) return false;
  if (!p.chunks.every((c) => typeof c?.en === "string" && typeof c?.ja === "string")) return false;
  if (!Array.isArray(p.outline) || !p.outline.every((o) => typeof o === "string")) return false;
  if (p.hintDefault !== "ja" && p.hintDefault !== "en") return false;
  return true;
}

function isValidModelTalk(x: unknown): x is TopicAssetModelTalk {
  return typeof x === "object" && x !== null
    && typeof (x as { text?: unknown }).text === "string" && (x as { text: string }).text.trim().length > 0;
}

/** 1 stage 分のバンドル({prepPack?, modelTalk?})を検証する。存在するフィールドが1つでも不正なら null（部分救済しない）。 */
function parseStageBundle(x: unknown): TopicAssetStageBundle | null {
  if (typeof x !== "object" || x === null) return null;
  const b = x as { prepPack?: unknown; modelTalk?: unknown };
  if (b.prepPack !== undefined && !isValidPrepPack(b.prepPack)) return null;
  if (b.modelTalk !== undefined && !isValidModelTalk(b.modelTalk)) return null;
  return { prepPack: b.prepPack as PrepPack | undefined, modelTalk: b.modelTalk as TopicAssetModelTalk | undefined };
}

/**
 * 同梱JSON1件のパース+厳格バリデーション（純ロジック・fs非依存）。
 * byStage のいずれか1エントリでも不正なら、ファイル全体を無効（null）として扱う——生成物は機械検証を経た
 * all-or-nothingの資産という前提（AGENTS.md「手修正禁止」）のもと、部分的な信頼はしない。
 */
export function parseTopicAssetFile(raw: string): TopicAssetFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const f = parsed as Partial<TopicAssetFile>;
  if (typeof f.topicId !== "string" || !f.topicId) return null;
  if (typeof f.sourceHash !== "string" || !f.sourceHash) return null;
  if (typeof f.promptVersion !== "string" || !f.promptVersion) return null;
  if (typeof f.byStage !== "object" || f.byStage === null) return null;
  const byStage: Record<string, TopicAssetStageBundle> = {};
  for (const [key, value] of Object.entries(f.byStage)) {
    const bundle = parseStageBundle(value);
    if (!bundle) return null;
    byStage[key] = bundle;
  }
  return { topicId: f.topicId, sourceHash: f.sourceHash, promptVersion: f.promptVersion, byStage };
}

export type ResolveBundledResult = { entry: TopicAssetStageBundle | null; stale: boolean };

/**
 * 同梱アセットのstale判定+stage解決（純ロジック・fs非依存）。
 * sourceHash か promptVersion が現行と不一致なら stale=true・entry=null（同梱を無視して次層へ）。
 * 一致していても対象stageのエントリが無ければ entry=null・stale=false（「staleではないが該当なし」を区別する）。
 */
export function resolveBundledEntry(
  asset: TopicAssetFile | null, currentSourceHash: string, stage: number,
): ResolveBundledResult {
  if (!asset) return { entry: null, stale: false };
  if (asset.sourceHash !== currentSourceHash || asset.promptVersion !== TOPIC_ASSET_PROMPT_VERSION) {
    return { entry: null, stale: true };
  }
  return { entry: asset.byStage[String(stage)] ?? null, stale: false };
}

const warnedStaleTopicIds = new Set<string>();

/**
 * 3層の第1層（同梱JSON）を読む。topic/assetファイルの実体をfsから読み、resolveBundledEntryで判定する。
 * staleを検出したtopicIdごとに1回だけ情報ログを出す（警告調ではなくinfo — 実行時生成へのフォールバックは
 * 正常な動作であり、障害ではない）。
 */
export function lookupBundledTopicAsset(
  assetsDir: string, topicsDir: string, topicId: string, stage: number,
): TopicAssetStageBundle | null {
  const assetFile = path.join(assetsDir, `${topicId}.json`);
  if (!existsSync(assetFile)) return null;
  const asset = parseTopicAssetFile(readFileSync(assetFile, "utf8"));
  if (!asset) return null;
  const topicFile = path.join(topicsDir, `${topicId}.md`);
  if (!existsSync(topicFile)) return null;
  const currentSourceHash = computeSourceHash(readFileSync(topicFile, "utf8"));
  const { entry, stale } = resolveBundledEntry(asset, currentSourceHash, stage);
  if (stale && !warnedStaleTopicIds.has(topicId)) {
    warnedStaleTopicIds.add(topicId);
    console.log(`[topic-assets] ${topicId}: 同梱JSONがstale（sourceHash/promptVersion不一致）— DBキャッシュ/実行時生成にフォールバックします`);
  }
  return entry;
}

/**
 * 3層の第2層（DBキャッシュ）。
 * 設計doc §4 は「同梱JSON→DB永続キャッシュ→実行時生成」を model_talks 相乗りで示唆するが、既存 model_talks
 * テーブルは stage 列を持たない（Library 表示専用の履歴テーブル）。stage を無視して「topicの最新1件」を
 * 再利用すると、学習者のレベルが変わった際に別stage向けの文章（語数・語彙制約が異なる）を誤って返しかねず、
 * 「キャッシュ以外の挙動は変えない」という制約に反する。そのため既存 model_talks は一切変更せず
 * （Library 機能は従来どおり）、topic×stage をキーにした専用のキャッシュテーブルを新設する。
 */
export function ensureTopicAssetCacheSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS prep_pack_cache (
    topic_id TEXT NOT NULL,
    stage INTEGER NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (topic_id, stage)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS model_talk_cache (
    topic_id TEXT NOT NULL,
    stage INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (topic_id, stage)
  )`);
}

export type TopicAssetCacheStore = {
  getPrepPack(topicId: string, stage: number): PrepPack | null;
  savePrepPack(topicId: string, stage: number, pack: PrepPack): void;
  getModelTalk(topicId: string, stage: number): string | null;
  saveModelTalk(topicId: string, stage: number, text: string): void;
};

export function makeTopicAssetCacheStore(db: Database): TopicAssetCacheStore {
  return {
    getPrepPack(topicId, stage) {
      const row = db.query<{ data: string }, [string, number]>(
        "SELECT data FROM prep_pack_cache WHERE topic_id = ? AND stage = ?",
      ).get(topicId, stage);
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.data);
        return isValidPrepPack(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    savePrepPack(topicId, stage, pack) {
      db.run(
        `INSERT INTO prep_pack_cache (topic_id, stage, data, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(topic_id, stage) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`,
        [topicId, stage, JSON.stringify(pack), new Date().toISOString()],
      );
    },
    getModelTalk(topicId, stage) {
      const row = db.query<{ text: string }, [string, number]>(
        "SELECT text FROM model_talk_cache WHERE topic_id = ? AND stage = ?",
      ).get(topicId, stage);
      return row?.text ?? null;
    },
    saveModelTalk(topicId, stage, text) {
      db.run(
        `INSERT INTO model_talk_cache (topic_id, stage, text, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(topic_id, stage) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`,
        [topicId, stage, text, new Date().toISOString()],
      );
    },
  };
}

export type ResolveTopicAssetDeps = {
  assetsDir: string;
  topicsDir: string;
  cache: TopicAssetCacheStore;
};

/** 3層フォールバック（prepPack版）: 同梱 → DBキャッシュ → generate（成功時はDBへwrite-through）。 */
export async function resolvePrepPack(
  topicId: string, stage: number, deps: ResolveTopicAssetDeps, generate: () => Promise<PrepPack>,
): Promise<PrepPack> {
  const bundled = lookupBundledTopicAsset(deps.assetsDir, deps.topicsDir, topicId, stage);
  if (bundled?.prepPack) return bundled.prepPack;
  const cached = deps.cache.getPrepPack(topicId, stage);
  if (cached) return cached;
  const generated = await generate();
  deps.cache.savePrepPack(topicId, stage, generated);
  return generated;
}

/** 3層フォールバック（model talk版）: 同梱 → DBキャッシュ → generate（成功時はDBへwrite-through）。 */
export async function resolveModelTalk(
  topicId: string, stage: number, deps: ResolveTopicAssetDeps, generate: () => Promise<TopicAssetModelTalk>,
): Promise<TopicAssetModelTalk> {
  const bundled = lookupBundledTopicAsset(deps.assetsDir, deps.topicsDir, topicId, stage);
  if (bundled?.modelTalk) return bundled.modelTalk;
  const cached = deps.cache.getModelTalk(topicId, stage);
  if (cached !== null) return { text: cached };
  const generated = await generate();
  deps.cache.saveModelTalk(topicId, stage, generated.text);
  return generated;
}

// ---------------------------------------------------------------------------
// 事前生成バッチ（scripts/generate-topic-assets.ts のコアロジック）
// ---------------------------------------------------------------------------

export type GenTopicAssetSlotDeps = {
  runner: ClaudeRunner;
  topic: ContentItem;
  stage: number;
  log?: (s: string) => void;
};

/**
 * 1スロット（topic×stage）分の prepPack + model talk を生成する。coach.ts の generatePrepPack/generateModelTalk
 * （実行時生成と全く同じ関数）を呼び、それぞれ独立に3ラウンド規律（attempt<=3）で検証NGなら再生成する。
 * 検証はループ内のhard-failゲート:
 *   - prepPack: 全chunkが checkPrepChunk をPASS（1件でもFAILなら候補全体を不採用）
 *   - modelTalk: checkModelTalk（帯別spoken-register閾値。bandForLevel(topic.level)で決まる帯）
 * （Task 3で判明した「ゲートが生成ループの外にあり非対称だった」教訓を踏まえ、ここでは最初からループ内でゲートする）。
 * どちらか一方でも3回とも検証NGならエラーをthrowする（呼び出し側は該当topicの書き込みを行わない）。
 */
export async function genTopicAssetSlot(deps: GenTopicAssetSlotDeps): Promise<TopicAssetStageBundle> {
  const log = deps.log ?? console.log;
  const { topic, stage } = deps;
  const band = bandForLevel(topic.level);
  const p = prepParams(stage);

  let prepPack: PrepPack | null = null;
  let modelTalk: TopicAssetModelTalk | null = null;

  for (let attempt = 1; attempt <= 3 && !(prepPack && modelTalk); attempt++) {
    if (!prepPack) {
      try {
        const candidate = await generatePrepPack(
          { topicTitle: topic.title, hints: topic.hints, chunkCount: p.chunkCount, hintLang: p.hintLang, stage },
          deps.runner,
        );
        const allChunksPass = candidate.chunks.length > 0 && candidate.chunks.every((c) => checkPrepChunk(c).pass);
        if (allChunksPass) {
          prepPack = candidate;
        } else if (attempt < 3) {
          log(`  ${topic.id}/stage${stage} prepPack: 検証NG — 再生成します(${attempt}/3)`);
        }
      } catch (error) {
        console.warn("[topic-assets] prepPack runner error:", error instanceof Error ? error.message : String(error));
        if (attempt < 3) log(`  ${topic.id}/stage${stage} prepPack: 実行失敗 — 再生成します(${attempt}/3)`);
      }
    }
    if (!modelTalk) {
      try {
        const candidate = await generateModelTalk({ topicTitle: topic.title, hints: topic.hints, stage }, deps.runner);
        if (checkModelTalk(candidate.text, band).pass) {
          modelTalk = candidate;
        } else if (attempt < 3) {
          log(`  ${topic.id}/stage${stage} modelTalk: 検証NG — 再生成します(${attempt}/3)`);
        }
      } catch (error) {
        console.warn("[topic-assets] modelTalk runner error:", error instanceof Error ? error.message : String(error));
        if (attempt < 3) log(`  ${topic.id}/stage${stage} modelTalk: 実行失敗 — 再生成します(${attempt}/3)`);
      }
    }
  }

  if (!prepPack || !modelTalk) {
    const failed = [!prepPack ? "prepPack" : null, !modelTalk ? "modelTalk" : null].filter(Boolean).join("・");
    throw new Error(`エラー: ${topic.id}/stage${stage} の${failed}が3回とも検証を通りませんでした。`);
  }
  return { prepPack, modelTalk };
}

function stagesInRange([lo, hi]: [number, number]): number[] {
  const out: number[] = [];
  for (let s = lo; s <= hi; s++) out.push(s);
  return out;
}

export type GenTopicAssetsDeps = {
  runner: ClaudeRunner;
  topicsDir: string;
  assetsDir: string;
  /** true なら既存が新鮮でも強制再生成する（CLI の --force） */
  force: boolean;
  log?: (s: string) => void;
};

/**
 * quota topics（isBridgeItem===false・level=帯範囲そのもの。設計doc §3「36（現26）」の対象）全件について、
 * 帯内2 stage分の prepPack/model talk を生成し content/topic-assets/{topicId}.json へ書き込む
 * （scripts/generate-topic-assets.ts のコア。CLIは薄いラッパー — generate-content.ts と同じ構成）。
 * べき等: 既存ファイルの sourceHash/promptVersion が現行と一致し、対象2 stageとも prepPack/modelTalk が
 * 揃っていればスキップする（--force で強制再生成）。1topic=1ファイル単位の all-or-nothing。
 */
export async function genTopicAssets(deps: GenTopicAssetsDeps): Promise<{ written: number; skipped: number }> {
  const log = deps.log ?? console.log;
  const quotaTopics = loadContent(deps.topicsDir).filter((t) => !isBridgeItem(t.level));
  mkdirSync(deps.assetsDir, { recursive: true });

  let written = 0;
  let skipped = 0;
  for (const topic of quotaTopics) {
    const topicFile = path.join(deps.topicsDir, `${topic.id}.md`);
    const sourceHash = computeSourceHash(readFileSync(topicFile, "utf8"));
    const assetFile = path.join(deps.assetsDir, `${topic.id}.json`);
    const existing = existsSync(assetFile) ? parseTopicAssetFile(readFileSync(assetFile, "utf8")) : null;
    const stages = stagesInRange(topic.level);
    const isFresh = Boolean(existing)
      && existing!.sourceHash === sourceHash
      && existing!.promptVersion === TOPIC_ASSET_PROMPT_VERSION
      && stages.every((s) => Boolean(existing!.byStage[String(s)]?.prepPack) && Boolean(existing!.byStage[String(s)]?.modelTalk));

    if (isFresh && !deps.force) {
      log(`skip: ${topic.id}（既存が新鮮）`);
      skipped++;
      continue;
    }

    log(`=== ${topic.id} [${topic.domain}/${topic.level[0]}-${topic.level[1]}] ===`);
    const byStage: Record<string, TopicAssetStageBundle> = {};
    for (const stage of stages) {
      log(`  生成中: stage${stage}`);
      byStage[String(stage)] = await genTopicAssetSlot({ runner: deps.runner, topic, stage, log });
    }
    const file: TopicAssetFile = { topicId: topic.id, sourceHash, promptVersion: TOPIC_ASSET_PROMPT_VERSION, byStage };
    writeFileSync(assetFile, JSON.stringify(file, null, 2) + "\n");
    log(`  完了: ${assetFile}`);
    written++;
  }
  log(`\n完了: ${written}件書き込み・${skipped}件スキップ（quota topics ${quotaTopics.length}件中）`);
  return { written, skipped };
}
