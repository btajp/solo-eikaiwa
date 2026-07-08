import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeEn } from "./chunks";
import { extractJson, generateSentenceExplanation } from "./coach";
import type { ClaudeRunner } from "./converse";
import { loadContent, type Domain } from "./content";
import { loadListening } from "./listening";
import { loadBundledExplanations, loadSentences, type Sentence } from "./sentences";
import { vocabConstraint } from "./progression";
import { categoryBadRates, pickWorstCategories } from "./srs-analytics";
import { spokenStyleFor, type SpokenBand } from "./spoken-style";
import { BAND_STAGE_RANGE, BANDS, computeBandCoverageStatuses, prioritizeFillTasks, type Band } from "./content-coverage";
import { checkTopicAnchor } from "./topic-anchor-check";
import { checkScenarioStarter, checkSpokenRegister, countWords, findWrittenVocabHits } from "./spoken-register-check";

const ORIGINALITY = "All output must be completely original — do not copy or adapt sentences from existing textbooks or courses.";

export type NewSentenceCandidate = { domain: string; en: string; ja: string; note: string };
const DOMAINS = ["daily", "business", "it"] as const;

/**
 * 生成候補を検証して Sentence[] に整形する。1件でも不正・重複があれば null（全体不採用 → 再生成を促す）。
 * no は既存最大+1 から連番。
 */
export function validateNewSentences(
  cands: unknown,
  existing: Sentence[],
  categoryNo: number,
  category: string,
): Sentence[] | null {
  if (!Array.isArray(cands) || cands.length === 0) return null;
  const norms = new Set(existing.map((s) => normalizeEn(s.en)));
  let no = Math.max(...existing.map((s) => s.no));
  const out: Sentence[] = [];
  for (const raw of cands) {
    const c = raw as NewSentenceCandidate;
    if (typeof c?.en !== "string" || typeof c?.ja !== "string" || typeof c?.note !== "string") return null;
    if (!(DOMAINS as readonly string[]).includes(c.domain)) return null;
    const en = c.en.trim();
    if (!en || en.length > 200) return null;
    const ja = c.ja.trim();
    if (!ja) return null;
    const norm = normalizeEn(en);
    if (!norm || norms.has(norm)) return null;
    norms.add(norm);
    no++;
    out.push({
      no, category_no: categoryNo, category,
      domain: c.domain as Sentence["domain"],
      en, ja, note: c.note.trim(),
    });
  }
  return out;
}

export type NewContentCandidate = {
  id: string;
  kind: "topic" | "scenario";
  title: string;
  titleJa: string;
  domain: string;
  level: [number, number];
  hints: string[];
  /** scenario専用の3件の英語オープナー。topicは常に未設定（既存挙動を変えない） */
  starters?: string[];
  /**
   * v0.26 content-ladder wave1: topicの「完全に既知」アンカー（topic-anchor-check対象・省略可）。
   * 省略時はcontentToMarkdownがフィールド自体を出力しない（既存テスト・既存挙動を変えない）。
   */
  experienceAnchor?: string;
  memoryCue?: string;
  commonObjectsOrActions?: string[];
};

/** menu.ts の parseContentFile が読める markdown に整形する（ラウンドトリップをテストで保証） */
export function contentToMarkdown(c: NewContentCandidate): string {
  const heading = c.kind === "topic" ? "Talk about:" : "Roleplay setup:";
  return [
    "---",
    `id: ${c.id}`,
    `kind: ${c.kind}`,
    `title: "${c.title}"`,
    `title_ja: "${c.titleJa}"`,
    `domain: ${c.domain}`,
    `level: [${c.level[0]}, ${c.level[1]}]`,
    ...(c.experienceAnchor ? [`experience_anchor: "${c.experienceAnchor}"`] : []),
    ...(c.memoryCue ? [`memory_cue: "${c.memoryCue}"`] : []),
    ...(c.commonObjectsOrActions ? [`common_objects_or_actions: "${c.commonObjectsOrActions.join(", ")}"`] : []),
    "---",
    heading,
    ...c.hints.map((h) => `- ${h}`),
    ...(c.starters ? c.starters.map((s) => `> ${s}`) : []),
    "",
  ].join("\n");
}

/**
 * AI生成トピック/シナリオ候補の厳格バリデーション（menu.ts の parseContentFile とは別物）。
 * parseContentFile は手編集ファイル向けに不正値をデフォルトへ静かにフォールバックするが、
 * AI出力は1つでも不正なら候補全体を invalid として再生成に回す必要があるため、ここで直接検査する。
 * 検査項目: id(kebab-case・重複なし) / title・titleJa(空でない) / domain(daily|business|it) /
 * level([min,max] が 1..6 内・min<=max・現stageを含む) / hints(1件以上・すべて空でない文字列)。
 */
export function validateTopicCandidate(
  parsed: unknown,
  kind: "topic" | "scenario",
  existingIds: Set<string>,
  dir: string,
  stage: number,
): NewContentCandidate | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Partial<NewContentCandidate>;

  if (typeof c.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) return null;
  if (existingIds.has(c.id) || existsSync(path.join(dir, `${c.id}.md`))) return null;

  if (typeof c.title !== "string" || !c.title.trim()) return null;
  if (typeof c.titleJa !== "string" || !c.titleJa.trim()) return null;
  if (!(DOMAINS as readonly string[]).includes(c.domain as string)) return null;

  if (!Array.isArray(c.level) || c.level.length !== 2) return null;
  const [min, max] = c.level;
  if (typeof min !== "number" || typeof max !== "number") return null;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  if (min < 1 || max > 6 || min > max) return null;
  if (!(min <= stage && stage <= max)) return null;

  if (!Array.isArray(c.hints) || c.hints.length === 0) return null;
  if (!c.hints.every((h) => typeof h === "string" && h.trim().length > 0)) return null;

  return {
    id: c.id, kind, title: c.title.trim(), titleJa: c.titleJa.trim(),
    domain: c.domain as string, level: [min, max], hints: c.hints.map((h) => h.trim()),
  };
}

export type GenSentencesDeps = {
  runner: ClaudeRunner;
  sentencesFile: string;
  db: Database;
  stage: number;
  dry: boolean;
  log?: (s: string) => void;
};

/**
 * SRSの苦手カテゴリ(bad率上位3)向けに新規例文を各4文生成し追記する。
 * データ不足時は何もせず正常終了。生成が2回とも検証NGなら何も書き込まず throw する（呼び出し側でexit 1にする）。
 */
export async function genSentences(deps: GenSentencesDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const sentences = loadSentences(deps.sentencesFile);
  const worst = pickWorstCategories(categoryBadRates(deps.db, sentences));
  if (worst.length === 0) {
    log("データ不足: 評価5文以上で bad が出ているカテゴリがまだありません。例文練習を続けてから再実行してください。");
    return;
  }
  log(`苦手カテゴリ: ${worst.map((w) => `${w.category}(bad率${Math.round(w.badRate * 100)}%)`).join(" / ")}`);

  let all = [...sentences];
  for (const w of worst) {
    const inCategory = sentences.filter((s) => s.category_no === w.categoryNo);
    const vocab = vocabConstraint(deps.stage);
    // stage>=4（vocab===null）は行自体を挿入しない（元々この行は無かった＝上級者の挙動不変）
    const vocabLine = vocab ? `${vocab}\n` : "";
    const system = `You write original English example sentences for a Japanese learner (CEFR B1-B2).
Write exactly 4 spoken-register sentences practicing the grammar category "${w.category}".
Domains: one "daily", one "business", one "it", and one of your choice. 6-14 words each. Contractions welcome.
${vocabLine}${ORIGINALITY}
Avoid these existing sentences (do not duplicate or closely paraphrase):
${inCategory.slice(0, 12).map((s) => `- ${s.en}`).join("\n")}
Reply with STRICT JSON only: {"sentences":[{"domain":"daily|business|it","en":"...","ja":"自然な和訳","note":"文法ポイント1行(日本語)"}]}
Do not use any tools — reply directly with text only.`;
    let validated: Sentence[] | null = null;
    for (let attempt = 1; attempt <= 2 && !validated; attempt++) {
      let text: string | undefined;
      try {
        ({ text } = await deps.runner(`Generate the 4 sentences for category: ${w.category}`, undefined, { systemPrompt: system }));
      } catch (err) {
        // SDK呼び出し自体の一過性エラー（例: tool_use起因のmaxTurns超過）も検証NGと同様に1回だけ再試行する。
        // 非一過性の障害（認証切れ等）が「検証NG」に化けて原因が消えないよう、実エラーは必ずログに残す
        console.warn("[content-gen] runner error:", err instanceof Error ? err.message : String(err));
      }
      if (text !== undefined) {
        const parsed = extractJson<{ sentences?: unknown }>(text);
        validated = parsed ? validateNewSentences(parsed.sentences, all, w.categoryNo, w.category) : null;
      }
      if (!validated && attempt === 1) log(`  ${w.category}: 検証NG — 再生成します`);
    }
    if (!validated) {
      throw new Error(`エラー: カテゴリ「${w.category}」の生成が2回とも検証を通りませんでした。何も書き込まずに終了します。`);
    }
    all = [...all, ...validated];
    for (const s of validated) log(`  + no.${s.no} [${s.domain}] ${s.en}`);
  }

  if (deps.dry) {
    log(`--dry のため書き込みません（追加候補 ${all.length - sentences.length} 文）`);
    return;
  }
  // 書き込み前バリデーション: temp に書いて loadSentences が全件読めることを確認してから本番に書く
  const work = mkdtempSync(path.join(tmpdir(), "gen-sent-"));
  try {
    const tempFile = path.join(work, "sentences.json");
    writeFileSync(tempFile, JSON.stringify(all, null, 2) + "\n");
    const check = loadSentences(tempFile);
    if (check.length !== all.length) {
      throw new Error(`エラー: 生成物のバリデーションに失敗（${all.length}件中${check.length}件のみ有効）。書き込みを中止します。`);
    }
    writeFileSync(deps.sentencesFile, JSON.stringify(all, null, 2) + "\n");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  log(`完了: ${all.length - sentences.length} 文を追記しました（計 ${all.length} 文）。`);
  log("音声の差分生成: cd app && bun ../scripts/generate-sentence-audio.ts");
}

export type GenTopicsDeps = {
  runner: ClaudeRunner;
  topicsDir: string;
  scenariosDir: string;
  stage: number;
  dry: boolean;
  log?: (s: string) => void;
};

/**
 * 現在ステージ向けのお題2本+シナリオ1本を生成する。
 * 検証は3候補すべてに対して行い、全て通ってから一括で書き込む（all-or-nothing）。
 * いずれかが2回とも検証NGなら何も書き込まず throw する（先に検証を通った候補も書かれない）。
 */
export async function genTopics(deps: GenTopicsDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const topics = loadContent(deps.topicsDir);
  const scenarios = loadContent(deps.scenariosDir);
  const existingIds = new Set([...topics, ...scenarios].map((c) => c.id));

  const plans: Array<{ kind: "topic" | "scenario"; dir: string }> = [
    { kind: "topic", dir: deps.topicsDir },
    { kind: "topic", dir: deps.topicsDir },
    { kind: "scenario", dir: deps.scenariosDir },
  ];
  const candidates: NewContentCandidate[] = [];
  for (const p of plans) {
    const existing = (p.kind === "topic" ? topics : scenarios).map((c) => c.id).join(", ");
    const vocab = vocabConstraint(deps.stage);
    // stage>=4（vocab===null）は行自体を挿入しない（元々この行は無かった＝上級者の挙動不変）
    const vocabLine = vocab ? `${vocab}\n` : "";
    // scenario は genScenarios と同じナラティブ+スターター仕様（coach.ts roleplayPrompt の Setup 欄が
    // 前提とする形式）。topic 側のプロンプトは従来どおり一切変更しない。domain/level は genTopics 従来仕様
    // のままモデルが決める（genScenarios の固定プランとは異なる）。
    const system = p.kind === "topic"
      ? `You create one original topic for an English speaking practice app (Japanese learner, difficulty stage ${deps.stage} of 6).
A topic gives 4 talking-point hints for a monologue.
Each hint line: English phrase — 日本語の補足. Spoken register. ${ORIGINALITY}
${vocabLine}Do NOT reuse these existing ids: ${existing}
Reply with STRICT JSON only:
{"id":"kebab-case-id","title":"English title","titleJa":"日本語タイトル","domain":"daily|business|it","level":[min,max],"hints":["English — 日本語", ...4 items]}
level must be within 1..6 and include stage ${deps.stage}.
Do not use any tools — reply directly with text only.`
      : `You create one original roleplay SCENARIO for an English speaking practice app (Japanese learner, difficulty stage ${deps.stage} of 6).
A scenario sets up a roleplay that an AI coach will run with the learner by voice.
Write exactly 3 "hints" lines, English only (no Japanese, no translations), in this order:
1. The learner's role or task in the scene (what they are doing / who they are).
2. Who the AI plays, starting with "The AI plays ...".
3. The goal of the roleplay, starting with "Goal: ...".
Also write exactly 3 "starters": short English sentences the learner could say to open the roleplay.
Spoken register. ${ORIGINALITY}
${vocabLine}Do NOT reuse these existing ids: ${existing}
Reply with STRICT JSON only:
{"id":"kebab-case-id","title":"English title","titleJa":"日本語タイトル","domain":"daily|business|it","level":[min,max],"hints":["You ...","The AI plays ...","Goal: ..."],"starters":["Opener sentence 1.","Opener sentence 2.","Opener sentence 3."]}
level must be within 1..6 and include stage ${deps.stage}.
Do not use any tools — reply directly with text only.`;
    let cand: NewContentCandidate | null = null;
    for (let attempt = 1; attempt <= 2 && !cand; attempt++) {
      let text: string | undefined;
      try {
        ({ text } = await deps.runner(`Create the ${p.kind} now.`, undefined, { systemPrompt: system }));
      } catch (err) {
        // SDK呼び出し自体の一過性エラー（例: tool_use起因のmaxTurns超過）も検証NGと同様に1回だけ再試行する。
        // 非一過性の障害（認証切れ等）が「検証NG」に化けて原因が消えないよう、実エラーは必ずログに残す
        console.warn("[content-gen] runner error:", err instanceof Error ? err.message : String(err));
      }
      if (text !== undefined) {
        const parsed = extractJson<NewContentCandidate>(text);
        const base = validateTopicCandidate(parsed, p.kind, existingIds, p.dir, deps.stage);
        if (base && p.kind === "scenario") {
          const starters = validateStarters((parsed as { starters?: unknown } | null)?.starters);
          cand = starters ? { ...base, starters } : null;
        } else {
          cand = base;
        }
      }
      if (!cand && attempt === 1) log(`  ${p.kind}: 検証NG — 再生成します`);
    }
    if (!cand) {
      throw new Error(`エラー: ${p.kind} の生成が検証を通りませんでした。何も書き込みません。`);
    }
    existingIds.add(cand.id);
    candidates.push(cand);
    log(`  + ${p.kind}: ${cand.id} [${cand.domain}/${cand.level[0]}-${cand.level[1]}] ${cand.title}`);
  }

  if (deps.dry) {
    log("--dry のため書き込みません");
    return;
  }

  // 全候補の検証済み後にまとめて書き込む。途中で衝突等が判明した場合はここまでの分もロールバックする。
  const written: string[] = [];
  try {
    for (const cand of candidates) {
      const dir = cand.kind === "topic" ? deps.topicsDir : deps.scenariosDir;
      const file = path.join(dir, `${cand.id}.md`);
      if (existsSync(file)) throw new Error(`エラー: ${file} は既に存在します。中止します。`);
      writeFileSync(file, contentToMarkdown(cand));
      written.push(file);
    }
  } catch (err) {
    for (const f of written) rmSync(f, { force: true });
    throw err;
  }
  log(`完了: ${written.length} ファイルを追加しました。`);
}

export type GenScenariosDeps = {
  runner: ClaudeRunner;
  scenariosDir: string;
  dry: boolean;
  log?: (s: string) => void;
};

/** stage1 帯が枯渇しているドメインを補う固定プラン（domain/level を固定・語彙は stage1 レベリング） */
export const SCENARIO_BAND_PLAN: ReadonlyArray<{ domain: (typeof DOMAINS)[number]; level: [number, number]; vocabStage: number }> = [
  { domain: "business", level: [1, 3], vocabStage: 1 },
  { domain: "it", level: [1, 3], vocabStage: 1 },
];

/**
 * starters 配列の検証: ちょうど3件・非空・改行なし。genScenarios と genTopics のシナリオ分岐で共有する
 * （roleplayPrompt / RoleplayScreen が前提とする既存シナリオ形式の一部）。
 */
function validateStarters(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  if (!raw.every((s) => typeof s === "string" && s.trim().length > 0 && !s.includes("\n"))) return null;
  return raw.map((s) => (s as string).trim());
}

/**
 * genScenarios 用の候補検証（domain/level はプラン固定なので検査しない — id/title/titleJa/hints/starters のみ）。
 * hints/starters は roleplayPrompt（coach.ts）の Setup 注入と RoleplayScreen の表示が前提とする既存シナリオ形式
 * （hints=英語のみのナラティブ、starters=英語オープナー3件）に合わせて検査する。
 */
function validateScenarioCandidate(
  parsed: unknown, existingIds: Set<string>, dir: string,
): { id: string; title: string; titleJa: string; hints: string[]; starters: string[] } | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Partial<NewContentCandidate>;
  if (typeof c.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) return null;
  if (existingIds.has(c.id) || existsSync(path.join(dir, `${c.id}.md`))) return null;
  if (typeof c.title !== "string" || !c.title.trim() || /[\n"]/.test(c.title)) return null;
  if (typeof c.titleJa !== "string" || !c.titleJa.trim() || /[\n"]/.test(c.titleJa)) return null;
  if (!Array.isArray(c.hints) || c.hints.length === 0) return null;
  if (!c.hints.every((h) => typeof h === "string" && h.trim().length > 0)) return null;
  const starters = validateStarters(c.starters);
  if (!starters) return null;
  return {
    id: c.id, title: c.title.trim(), titleJa: c.titleJa.trim(),
    hints: c.hints.map((h) => h.trim()), starters,
  };
}

/**
 * 固定プラン（SCENARIO_BAND_PLAN）で stage1 帯のシナリオを補充する。domain/level はプランで固定し、
 * 語彙制約は帯に連動（stage1）。全候補を検証してから一括書き込み（all-or-nothing）。
 */
export async function genScenarios(deps: GenScenariosDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const existingIds = new Set(loadContent(deps.scenariosDir).map((c) => c.id));
  const candidates: NewContentCandidate[] = [];

  for (const p of SCENARIO_BAND_PLAN) {
    const vocab = vocabConstraint(p.vocabStage);
    const vocabLine = vocab ? `${vocab}\n` : "";
    const domainDesc = p.domain === "daily" ? "everyday life" : p.domain === "business" ? "the workplace" : "software/IT work";
    const system = `You create one original roleplay SCENARIO for an English speaking practice app (Japanese learner, beginner difficulty stage ${p.level[0]}-${p.level[1]} of 6).
Domain: ${domainDesc}. A scenario sets up a roleplay that an AI coach will run with the learner by voice.
Write exactly 3 "hints" lines, English only (no Japanese, no translations), in this order:
1. The learner's role or task in the scene (what they are doing / who they are).
2. Who the AI plays, starting with "The AI plays ...".
3. The goal of the roleplay, starting with "Goal: ...".
Also write exactly 3 "starters": short English sentences the learner could say to open the roleplay.
Spoken register. Keep vocabulary and sentence structure approachable for a near-beginner. ${ORIGINALITY}
${vocabLine}Do NOT reuse these existing ids: ${[...existingIds].join(", ") || "(none)"}
Reply with STRICT JSON only:
{"id":"kebab-case-id","title":"English title","titleJa":"日本語タイトル","hints":["You ...","The AI plays ...","Goal: ..."],"starters":["Opener sentence 1.","Opener sentence 2.","Opener sentence 3."]}
Do not use any tools — reply directly with text only.`;
    let cand: { id: string; title: string; titleJa: string; hints: string[]; starters: string[] } | null = null;
    for (let attempt = 1; attempt <= 2 && !cand; attempt++) {
      let text: string | undefined;
      try {
        ({ text } = await deps.runner(`Write the ${p.domain} beginner scenario now.`, undefined, { systemPrompt: system }));
      } catch (err) {
        console.warn("[content-gen] runner error:", err instanceof Error ? err.message : String(err));
      }
      if (text !== undefined) {
        const parsed = extractJson<NewContentCandidate>(text);
        cand = validateScenarioCandidate(parsed, existingIds, deps.scenariosDir);
      }
      if (!cand && attempt === 1) log(`  ${p.domain}/${p.level[0]}-${p.level[1]}: 検証NG — 再生成します`);
    }
    if (!cand) {
      throw new Error(`エラー: ${p.domain}/${p.level[0]}-${p.level[1]} のシナリオが検証を通りませんでした。何も書き込みません。`);
    }
    existingIds.add(cand.id);
    candidates.push({ ...cand, kind: "scenario", domain: p.domain, level: p.level });
    log(`  + scenario: ${cand.id} [${p.domain}/${p.level[0]}-${p.level[1]}] ${cand.title}`);
  }

  if (deps.dry) {
    log("--dry のため書き込みません");
    return;
  }

  const written: string[] = [];
  try {
    for (const cand of candidates) {
      const file = path.join(deps.scenariosDir, `${cand.id}.md`);
      if (existsSync(file)) throw new Error(`エラー: ${file} は既に存在します。中止します。`);
      writeFileSync(file, contentToMarkdown(cand));
      written.push(file);
    }
  } catch (err) {
    for (const f of written) rmSync(f, { force: true });
    throw err;
  }
  log(`完了: ${written.length} 本の stage1 シナリオを追加しました。`);
}

export type GenTopicsBandDeps = {
  runner: ClaudeRunner;
  topicsDir: string;
  dry: boolean;
  log?: (s: string) => void;
};

/** stage1 帯が枯渇しているドメイン(business/it)を補う固定プラン（domain/level を固定・語彙は stage1 レベリング） */
export const TOPIC_BAND_PLAN: ReadonlyArray<{ domain: "business" | "it"; level: [number, number]; vocabStage: number }> = [
  { domain: "business", level: [1, 3], vocabStage: 1 },
  { domain: "business", level: [1, 3], vocabStage: 1 },
  { domain: "it", level: [1, 3], vocabStage: 1 },
  { domain: "it", level: [1, 3], vocabStage: 1 },
];

/**
 * genTopicsBand 用の候補検証（domain/level はプラン固定なので検査しない — id/title/titleJa/hints のみ）。
 * hints は genTopics の topic 分岐と同じ「English phrase — 日本語の補足」形式で4件ちょうどを要求する。
 */
function validateTopicBandCandidate(
  parsed: unknown, existingIds: Set<string>, dir: string,
): { id: string; title: string; titleJa: string; hints: string[] } | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Partial<NewContentCandidate>;
  if (typeof c.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) return null;
  if (existingIds.has(c.id) || existsSync(path.join(dir, `${c.id}.md`))) return null;
  if (typeof c.title !== "string" || !c.title.trim() || /[\n"]/.test(c.title)) return null;
  if (typeof c.titleJa !== "string" || !c.titleJa.trim() || /[\n"]/.test(c.titleJa)) return null;
  if (!Array.isArray(c.hints) || c.hints.length !== 4) return null;
  if (!c.hints.every((h) => typeof h === "string" && h.trim().length > 0)) return null;
  return {
    id: c.id, title: c.title.trim(), titleJa: c.titleJa.trim(),
    hints: c.hints.map((h) => h.trim()),
  };
}

/**
 * 固定プラン（TOPIC_BAND_PLAN）で stage1 帯の business/IT お題を補充する。domain/level はプランで固定し、
 * 語彙制約は帯に連動（stage1）。全候補を検証してから一括書き込み（all-or-nothing）。
 */
export async function genTopicsBand(deps: GenTopicsBandDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const existingIds = new Set(loadContent(deps.topicsDir).map((c) => c.id));
  const candidates: NewContentCandidate[] = [];

  for (const p of TOPIC_BAND_PLAN) {
    const vocab = vocabConstraint(p.vocabStage);
    const vocabLine = vocab ? `${vocab}\n` : "";
    const domainDesc = p.domain === "business" ? "the workplace" : "software/IT work";
    const system = `You create one original topic for an English speaking practice app (Japanese learner, beginner difficulty stage ${p.level[0]}-${p.level[1]} of 6).
Domain: ${domainDesc}. A topic gives 4 talking-point hints for a monologue: a near-beginner can talk about it from their own daily work life (e.g., describing a workday, tools they use, asking for help — pick your own original angle).
Each hint line: English phrase — 日本語の補足. Spoken register. ${ORIGINALITY}
${vocabLine}Do NOT reuse these existing ids: ${[...existingIds].join(", ") || "(none)"}
Reply with STRICT JSON only:
{"id":"kebab-case-id","title":"English title","titleJa":"日本語タイトル","hints":["English — 日本語", ...4 items]}
Do not use any tools — reply directly with text only.`;
    let cand: { id: string; title: string; titleJa: string; hints: string[] } | null = null;
    for (let attempt = 1; attempt <= 2 && !cand; attempt++) {
      let text: string | undefined;
      try {
        ({ text } = await deps.runner(`Write the ${p.domain} beginner topic now.`, undefined, { systemPrompt: system }));
      } catch (err) {
        // SDK呼び出し自体の一過性エラー（例: tool_use起因のmaxTurns超過）も検証NGと同様に1回だけ再試行する。
        // 非一過性の障害（認証切れ等）が「検証NG」に化けて原因が消えないよう、実エラーは必ずログに残す
        console.warn("[content-gen] runner error:", err instanceof Error ? err.message : String(err));
      }
      if (text !== undefined) {
        const parsed = extractJson<NewContentCandidate>(text);
        cand = validateTopicBandCandidate(parsed, existingIds, deps.topicsDir);
      }
      if (!cand && attempt === 1) log(`  ${p.domain}/${p.level[0]}-${p.level[1]}: 検証NG — 再生成します`);
    }
    if (!cand) {
      throw new Error(`エラー: ${p.domain}/${p.level[0]}-${p.level[1]} のお題が検証を通りませんでした。何も書き込みません。`);
    }
    existingIds.add(cand.id);
    candidates.push({ ...cand, kind: "topic", domain: p.domain, level: p.level });
    log(`  + topic: ${cand.id} [${p.domain}/${p.level[0]}-${p.level[1]}] ${cand.title}`);
  }

  if (deps.dry) {
    log("--dry のため書き込みません");
    return;
  }

  const written: string[] = [];
  try {
    for (const cand of candidates) {
      const file = path.join(deps.topicsDir, `${cand.id}.md`);
      if (existsSync(file)) throw new Error(`エラー: ${file} は既に存在します。中止します。`);
      writeFileSync(file, contentToMarkdown(cand));
      written.push(file);
    }
  } catch (err) {
    for (const f of written) rmSync(f, { force: true });
    throw err;
  }
  log(`完了: ${written.length} 本の stage1帯 business/IT お題を追加しました。`);
}

export type NewListeningCandidate = { id: string; title: string; titleJa: string; paragraphs: string[] };

/** parseListeningFile が読める markdown に整形する（ラウンドトリップをテストで保証）。domain/level はプラン側で固定。 */
export function listeningToMarkdown(c: NewListeningCandidate & { domain: string; level: [number, number] }): string {
  return [
    "---",
    `id: ${c.id}`,
    `title: "${c.title}"`,
    `title_ja: "${c.titleJa}"`,
    `domain: ${c.domain}`,
    `level: [${c.level[0]}, ${c.level[1]}]`,
    "---",
    "",
    c.paragraphs.join("\n\n"),
    "",
  ].join("\n");
}

/** talk-explain のクライアント訳解説が受け付ける本文の上限（3000字）に対し、余裕を持たせた生成側の上限 */
const LISTENING_BODY_MAX_CHARS = 2800;

/**
 * AI 生成 listening 候補の厳格バリデーション（parseListeningFile とは別物 — 不正は静かにフォールバックせず候補全体を棄却）。
 * 検査: id(kebab-case・予約語"log"禁止・既存集合/ファイルと非衝突) / title・titleJa(空でない・改行や二重引用符を含まない) /
 * paragraphs(2件以上・すべて非空文字列・結合後の長さが上限以内)。
 * domain・level はプランで固定するためここでは検査しない。
 * id="log" を拒否するのは POST /api/listening/log と GET /api/listening/:id (prefix) の混同を避けるため。
 * title・titleJa の改行/二重引用符を拒否するのは frontmatter（`title: "..."` 形式）の破壊を防ぐため。
 * 本文の長さ上限は talk-explain（3000字上限）がこの本文全体を受け取っても常に成功するようにするため。
 */
export function validateListeningCandidate(
  parsed: unknown, existingIds: Set<string>, dir: string,
): NewListeningCandidate | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Partial<NewListeningCandidate>;
  if (typeof c.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) return null;
  if (c.id === "log") return null;
  if (existingIds.has(c.id) || existsSync(path.join(dir, `${c.id}.md`))) return null;
  if (typeof c.title !== "string" || !c.title.trim() || /[\n"]/.test(c.title)) return null;
  if (typeof c.titleJa !== "string" || !c.titleJa.trim() || /[\n"]/.test(c.titleJa)) return null;
  if (!Array.isArray(c.paragraphs) || c.paragraphs.length < 2) return null;
  if (!c.paragraphs.every((p) => typeof p === "string" && p.trim().length > 0)) return null;
  const paragraphs = c.paragraphs.map((p) => p.trim());
  if (paragraphs.join("\n\n").length > LISTENING_BODY_MAX_CHARS) return null;
  return { id: c.id, title: c.title.trim(), titleJa: c.titleJa.trim(), paragraphs };
}

/**
 * it ドメインの多聴生成が「手順書調（I check the code. I run the test.）」に寄り、宣言的な手順文の連続で
 * 短縮形の入る余地が無くなる問題への対策（T3差し戻し・it×beginner residual FAIL）。
 * it は全帯（development/fluency含む）に注入して害はない。daily/business は不変。
 */
const IT_DOMAIN_CASUAL_LINE =
  "Even when talking about software/IT work, talk about it casually like telling a coworker over coffee — NOT like a manual or tutorial. " +
  "Avoid sequences of bare procedural statements; add reactions and feelings (I'm glad..., it's annoying when..., don't you hate it when...) which naturally carry contractions.";

/** content-coverage の帯語彙(foundation/development/fluency)から spoken-style の帯語彙(beginner/intermediate/advanced)への対応 */
const SPOKEN_BAND_FOR_BAND: Record<Band, SpokenBand> = {
  foundation: "beginner", development: "intermediate", fluency: "advanced",
};

export type GenListeningForTargetDeps = {
  runner: ClaudeRunner;
  listeningDir: string;
  domain: Domain;
  band: Band;
  count: number;
  dry: boolean;
  log?: (s: string) => void;
};

/**
 * --fill-coverage の生成本体（listening側）。genTopicsForTarget/genScenariosForTargetと対をなす。
 * 指定した帯(BAND_STAGE_RANGEの範囲そのものをlevelにする)×domain×countでquota適合素材をcount本生成する。
 * 構造検証（validateListeningCandidate）に加え、checkSpokenRegister（帯別閾値の口語レジスター3指標）を
 * hard-fail条件としてゲートする（設計doc§5「listening: spoken-register 3指標をhard fail」・
 * genScenariosForTargetがcheckScenarioStarterをゲートするのと同じ構造）。旧実装はこのゲートが無く、
 * 実生成36本中3本(短縮形率不足)が未検出のまま書き込まれてしまった実績があるため必須の修正。
 * 各アイテムは3ラウンド規律（attempt<=3）で検証NGなら再生成する。全アイテム検証済み後に一括書き込み（all-or-nothing）。
 */
export async function genListeningForTarget(deps: GenListeningForTargetDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const existingIds = new Set(loadListening(deps.listeningDir).map((it) => it.id));
  const [lo, hi] = BAND_STAGE_RANGE[deps.band];
  const vocab = vocabConstraint(lo);
  const vocabLine = vocab ? `${vocab}\n` : "";
  const domainDesc = DOMAIN_DESC[deps.domain];
  const spokenBand = SPOKEN_BAND_FOR_BAND[deps.band];
  // it ドメインのみマニュアル調回避の指示を追加する（daily/businessは従来どおり不変・全帯対象）
  const itCasualLine = deps.domain === "it" ? `${IT_DOMAIN_CASUAL_LINE}\n` : "";
  const candidates: Array<NewListeningCandidate & { domain: string; level: [number, number] }> = [];

  for (let i = 0; i < deps.count; i++) {
    const system = `You write an original short LISTENING script for a Japanese learner of English to listen to (about 2-4 minutes when read aloud, roughly 250-450 words).
Topic domain: ${domainDesc}. Difficulty: aim at CEFR level band for learner stage ${lo}-${hi} of 6.
Write natural spoken-style prose (first or third person) in 3-5 short paragraphs. No headings, no bullet lists, no dialogue markers, no speaker labels.
${spokenStyleFor(spokenBand)}
${itCasualLine}${vocabLine}${ORIGINALITY}
Do NOT reuse these existing ids: ${[...existingIds].join(", ") || "(none)"}
Reply with STRICT JSON only — no markdown fences:
{"id":"kebab-case-id","title":"English title","titleJa":"日本語タイトル","paragraphs":["paragraph 1 text", "paragraph 2 text", "..."]}
Do not use any tools — reply directly with text only.`;
    let cand: NewListeningCandidate | null = null;
    for (let attempt = 1; attempt <= 3 && !cand; attempt++) {
      let text: string | undefined;
      try {
        ({ text } = await deps.runner(
          `Write the ${deps.domain} listening script (band ${deps.band}, item ${i + 1}/${deps.count}) now.`, undefined, { systemPrompt: system },
        ));
      } catch (err) {
        // SDK呼び出し自体の一過性エラー（例: tool_use起因のmaxTurns超過）も検証NGと同様に再試行する。
        // 非一過性の障害（認証切れ等）が「検証NG」に化けて原因が消えないよう、実エラーは必ずログに残す
        console.warn("[content-gen] runner error:", err instanceof Error ? err.message : String(err));
      }
      if (text !== undefined) {
        const parsed = extractJson<NewListeningCandidate>(text);
        const base = validateListeningCandidate(parsed, existingIds, deps.listeningDir);
        cand = base && checkSpokenRegister(base.paragraphs.join("\n\n"), spokenBand).pass ? base : null;
      }
      if (!cand && attempt < 3) log(`  ${deps.domain}/${deps.band}: 検証NG — 再生成します(${attempt}/3)`);
    }
    if (!cand) {
      throw new Error(`エラー: ${deps.domain}/${deps.band} の listening (${i + 1}/${deps.count}) が3回とも検証を通りませんでした。何も書き込みません。`);
    }
    existingIds.add(cand.id);
    candidates.push({ ...cand, domain: deps.domain, level: [lo, hi] });
    log(`  + listening: ${cand.id} [${deps.domain}/${lo}-${hi}] ${cand.title}`);
  }

  if (deps.dry) {
    log("--dry のため書き込みません");
    return;
  }

  mkdirSync(deps.listeningDir, { recursive: true });
  const written: string[] = [];
  try {
    for (const cand of candidates) {
      const file = path.join(deps.listeningDir, `${cand.id}.md`);
      if (existsSync(file)) throw new Error(`エラー: ${file} は既に存在します。中止します。`);
      writeFileSync(file, listeningToMarkdown(cand));
      written.push(file);
    }
  } catch (err) {
    for (const f of written) rmSync(f, { force: true });
    throw err;
  }
  log(`完了: ${written.length} 本の ${deps.domain}/${deps.band} listening を追加しました。`);
}

export type GenListeningDeps = {
  runner: ClaudeRunner;
  listeningDir: string;
  dry: boolean;
  log?: (s: string) => void;
};

/**
 * listening の3帯(foundation[1,2]/development[3,4]/fluency[5,6])×3domain×quota(4本)を、
 * 既存ファイルからの適合数（bridge除外・content-coverage.computeBandCoverageStatusesに委譲）を
 * 差し引いた不足分だけ生成する（旧: 固定6本プランを毎回丸ごと生成・既存ファイルと無関係に追加していた）。
 * 既存6本（bridge: [1,3]/[4,6]）はquota集計から除外されるため、削除せずとも資産として残ったまま
 * 新設計の9セル（3帯×3domain）それぞれの不足分（quota4本）だけが生成される。
 * 中断後の再実行でも、既に書かれた分は loadListening 経由で不足数の再計算に反映されるため、
 * 二重生成せず不足分のみを積み増す（べき等・再開可能）。
 */
export async function genListening(deps: GenListeningDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const existing = loadListening(deps.listeningDir).map((it) => ({ id: it.id, domain: it.domain, level: it.level }));
  const tasks = prioritizeFillTasks(computeBandCoverageStatuses("listening", existing));

  if (tasks.length === 0) {
    log("不足セルはありません（listening は全帯×domainでquota充足済み）。");
    return;
  }
  for (const task of tasks) {
    const zeroNote = task.zeroEvenWithBridge ? " ※bridge込みでも空白" : "";
    log(`\n=== listening / ${task.domain} / ${task.band} (${task.neededCount}本)${zeroNote} ===`);
    await genListeningForTarget({
      runner: deps.runner, listeningDir: deps.listeningDir, domain: task.domain, band: task.band,
      count: task.neededCount, dry: deps.dry, log,
    });
  }
}

const DOMAIN_DESC: Record<Domain, string> = {
  daily: "everyday life", business: "the workplace", it: "software/IT work",
};

/**
 * 「完全に既知」条項（Nation条件近似・設計doc§5）をプロンプトへ埋め込む共通ブロック。
 * topic-anchor-check.ts の禁止カテゴリ（abstract/specialist/current-affairs/rare-hobby/personal-info-required）
 * と対応する語（abstract/specialist・academic/current affairs・news/rare/niche hobbies/sensitive personal
 * identifiers）を明示し、モデルが禁止カテゴリを自己回避しやすくする。checkTopicAnchor はこれとは独立した
 * 機械検証であり、本文言はあくまで一次予防（生成側の歩留まり向上）。
 */
const KNOWN_INFORMATION_RULE =
  'CRITICAL grounding rule (Nation\'s "known information" principle): the topic MUST be something the learner can already talk about from their own real, lived experience — no new knowledge required. Ground it in a concrete, near-universal routine or situation. ' +
  "Do NOT write about: abstract or philosophical topics, specialist or academic subjects, current affairs or news, rare or niche hobbies, or anything requiring the learner to reveal sensitive personal identifiers (SSN, passport number, bank details, etc).";

type TopicTargetCandidate = {
  id: string; title: string; titleJa: string; hints: string[];
  experienceAnchor: string; memoryCue: string; commonObjectsOrActions: string[];
};

/** frontmatterの単一行シリアライズ(comma区切り)を壊す文字（改行・二重引用符・カンマ）を含まないか */
function safeInlineField(s: string): boolean {
  return !/[\n",]/.test(s);
}

/**
 * genTopicsForTarget 用の候補検証。domain/level はターゲット指定で固定するため検査しない。
 * hints は genTopicsBand と同じ4件形式に加え、experienceAnchor/memoryCue/commonObjectsOrActions の
 * frontmatter安全性（改行・二重引用符・カンマ不可 — commonObjectsOrActionsはカンマ区切りで結合するため要素にカンマ不可）と、
 * topic-anchor-check.checkTopicAnchor（「完全に既知」条項の機械検証）の両方を通過することを要求する。
 */
function validateTopicTargetCandidate(
  parsed: unknown, existingIds: Set<string>, dir: string,
): TopicTargetCandidate | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Partial<NewContentCandidate>;
  if (typeof c.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) return null;
  if (existingIds.has(c.id) || existsSync(path.join(dir, `${c.id}.md`))) return null;
  if (typeof c.title !== "string" || !c.title.trim() || /[\n"]/.test(c.title)) return null;
  if (typeof c.titleJa !== "string" || !c.titleJa.trim() || /[\n"]/.test(c.titleJa)) return null;
  if (!Array.isArray(c.hints) || c.hints.length !== 4) return null;
  if (!c.hints.every((h) => typeof h === "string" && h.trim().length > 0)) return null;
  if (typeof c.experienceAnchor !== "string" || !c.experienceAnchor.trim() || !safeInlineField(c.experienceAnchor)) return null;
  if (typeof c.memoryCue !== "string" || !c.memoryCue.trim() || !safeInlineField(c.memoryCue)) return null;
  if (
    !Array.isArray(c.commonObjectsOrActions) || c.commonObjectsOrActions.length === 0 ||
    !c.commonObjectsOrActions.every((x) => typeof x === "string" && x.trim().length > 0 && safeInlineField(x))
  ) {
    return null;
  }
  const anchor = checkTopicAnchor({
    title: c.title, experienceAnchor: c.experienceAnchor, memoryCue: c.memoryCue,
    commonObjectsOrActions: c.commonObjectsOrActions,
  });
  if (!anchor.pass) return null;
  return {
    id: c.id, title: c.title.trim(), titleJa: c.titleJa.trim(), hints: c.hints.map((h) => h.trim()),
    experienceAnchor: c.experienceAnchor.trim(), memoryCue: c.memoryCue.trim(),
    commonObjectsOrActions: c.commonObjectsOrActions.map((x) => x.trim()),
  };
}

export type GenTopicsForTargetDeps = {
  runner: ClaudeRunner;
  topicsDir: string;
  domain: Domain;
  band: Band;
  count: number;
  dry: boolean;
  log?: (s: string) => void;
};

/**
 * --fill-coverage の生成本体（topic側）。指定した帯([1,2]|[3,4]|[5,6]と対応するband名)×domain×countで
 * quota適合教材（level=帯範囲そのもの）をcount本生成する。TOPIC_BAND_PLAN等の固定プランとは異なり、
 * domain/band/countを呼び出し側が指定する（--fill-coverageのセル駆動生成に対応）。
 * 各アイテムは3ラウンド規律（attempt<=3）で検証NGなら再生成し、3回とも失敗した時点でエラーにする
 * （既存gen*系の2ラウンドより1ラウンド厚くし、experienceAnchor必須化による歩留まり低下を吸収する）。
 * 全アイテム検証済み後に一括書き込み（all-or-nothing・オーファン無し）。
 */
export async function genTopicsForTarget(deps: GenTopicsForTargetDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const existingIds = new Set(loadContent(deps.topicsDir).map((c) => c.id));
  const [lo, hi] = BAND_STAGE_RANGE[deps.band];
  const vocab = vocabConstraint(lo);
  const vocabLine = vocab ? `${vocab}\n` : "";
  const domainDesc = DOMAIN_DESC[deps.domain];
  const candidates: NewContentCandidate[] = [];

  for (let i = 0; i < deps.count; i++) {
    const system = `You create one original topic for an English speaking practice app (Japanese learner, difficulty stage ${lo}-${hi} of 6).
Domain: ${domainDesc}.
${KNOWN_INFORMATION_RULE}
A topic gives 4 talking-point hints for a monologue.
Each hint line: English phrase — 日本語の補足. Spoken register. ${ORIGINALITY}
${vocabLine}Do NOT reuse these existing ids: ${[...existingIds].join(", ") || "(none)"}
Reply with STRICT JSON only:
{"id":"kebab-case-id","title":"English title","titleJa":"日本語タイトル","hints":["English — 日本語", ...4 items],
"experienceAnchor":"日本語1文: なぜ学習者が新知識なしで自分の経験から話せるか","memoryCue":"日本語1文: 学習者が思い出せる具体的な場面や記憶","commonObjectsOrActions":["具体的なモノ/行動を英語で3-5件（カンマ・引用符・改行は使わないこと）"]}
Do not use any tools — reply directly with text only.`;
    let cand: TopicTargetCandidate | null = null;
    for (let attempt = 1; attempt <= 3 && !cand; attempt++) {
      let text: string | undefined;
      try {
        ({ text } = await deps.runner(
          `Write the ${deps.domain} topic (band ${deps.band}, item ${i + 1}/${deps.count}) now.`, undefined, { systemPrompt: system },
        ));
      } catch (err) {
        // SDK呼び出し自体の一過性エラー（例: tool_use起因のmaxTurns超過）も検証NGと同様に再試行する。
        // 非一過性の障害（認証切れ等）が「検証NG」に化けて原因が消えないよう、実エラーは必ずログに残す
        console.warn("[content-gen] runner error:", err instanceof Error ? err.message : String(err));
      }
      if (text !== undefined) {
        const parsed = extractJson<NewContentCandidate>(text);
        cand = validateTopicTargetCandidate(parsed, existingIds, deps.topicsDir);
      }
      if (!cand && attempt < 3) log(`  ${deps.domain}/${deps.band}: 検証NG — 再生成します(${attempt}/3)`);
    }
    if (!cand) {
      throw new Error(`エラー: ${deps.domain}/${deps.band} の topic (${i + 1}/${deps.count}) が3回とも検証を通りませんでした。何も書き込みません。`);
    }
    existingIds.add(cand.id);
    candidates.push({ ...cand, kind: "topic", domain: deps.domain, level: [lo, hi] });
    log(`  + topic: ${cand.id} [${deps.domain}/${lo}-${hi}] ${cand.title}`);
  }

  if (deps.dry) {
    log("--dry のため書き込みません");
    return;
  }

  const written: string[] = [];
  try {
    for (const cand of candidates) {
      const file = path.join(deps.topicsDir, `${cand.id}.md`);
      if (existsSync(file)) throw new Error(`エラー: ${file} は既に存在します。中止します。`);
      writeFileSync(file, contentToMarkdown(cand));
      written.push(file);
    }
  } catch (err) {
    for (const f of written) rmSync(f, { force: true });
    throw err;
  }
  log(`完了: ${written.length} 本の ${deps.domain}/${deps.band} topic を追加しました。`);
}

type ScenarioTargetCandidate = { id: string; title: string; titleJa: string; hints: string[]; starters: string[] };

/**
 * genScenariosForTarget 用の候補検証。domain/level はターゲット指定で固定するため検査しない。
 * hints/starters の形式は既存 validateScenarioCandidate と同一だが、加えて starters の3件すべてが
 * spoken-register-check.checkScenarioStarter（starter単体の口語検証）をPASSすることを要求する
 * （設計doc§5: 「scenarios: starters（冒頭セリフ）のみ口語検証」）。
 */
function validateScenarioTargetCandidate(
  parsed: unknown, existingIds: Set<string>, dir: string,
): ScenarioTargetCandidate | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Partial<NewContentCandidate>;
  if (typeof c.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) return null;
  if (existingIds.has(c.id) || existsSync(path.join(dir, `${c.id}.md`))) return null;
  if (typeof c.title !== "string" || !c.title.trim() || /[\n"]/.test(c.title)) return null;
  if (typeof c.titleJa !== "string" || !c.titleJa.trim() || /[\n"]/.test(c.titleJa)) return null;
  if (!Array.isArray(c.hints) || c.hints.length === 0) return null;
  if (!c.hints.every((h) => typeof h === "string" && h.trim().length > 0)) return null;
  const starters = validateStarters(c.starters);
  if (!starters) return null;
  if (!starters.every((s) => checkScenarioStarter(s).pass)) return null;
  return { id: c.id, title: c.title.trim(), titleJa: c.titleJa.trim(), hints: c.hints.map((h) => h.trim()), starters };
}

export type GenScenariosForTargetDeps = {
  runner: ClaudeRunner;
  scenariosDir: string;
  domain: Domain;
  band: Band;
  count: number;
  dry: boolean;
  log?: (s: string) => void;
};

/**
 * --fill-coverage の生成本体（scenario側）。genTopicsForTarget と対をなす。starter口語検証
 * （checkScenarioStarter）で不合格ならそのアイテムは3ラウンド規律で再生成する。all-or-nothing書き込み。
 */
export async function genScenariosForTarget(deps: GenScenariosForTargetDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const existingIds = new Set(loadContent(deps.scenariosDir).map((c) => c.id));
  const [lo, hi] = BAND_STAGE_RANGE[deps.band];
  const vocab = vocabConstraint(lo);
  const vocabLine = vocab ? `${vocab}\n` : "";
  const domainDesc = DOMAIN_DESC[deps.domain];
  const candidates: NewContentCandidate[] = [];

  for (let i = 0; i < deps.count; i++) {
    const system = `You create one original roleplay SCENARIO for an English speaking practice app (Japanese learner, difficulty stage ${lo}-${hi} of 6).
Domain: ${domainDesc}. A scenario sets up a roleplay that an AI coach will run with the learner by voice.
Grounding rule: ground the scene in something concrete and near-universal (an everyday routine or common situation the learner has almost certainly experienced or can easily imagine) — avoid rare, specialist, or current-affairs settings.
Write exactly 3 "hints" lines, English only (no Japanese, no translations), in this order:
1. The learner's role or task in the scene (what they are doing / who they are).
2. Who the AI plays, starting with "The AI plays ...".
3. The goal of the roleplay, starting with "Goal: ...".
Also write exactly 3 "starters": short English sentences the learner could say to open the roleplay.
Spoken register. ${ORIGINALITY}
${vocabLine}Do NOT reuse these existing ids: ${[...existingIds].join(", ") || "(none)"}
Reply with STRICT JSON only:
{"id":"kebab-case-id","title":"English title","titleJa":"日本語タイトル","hints":["You ...","The AI plays ...","Goal: ..."],"starters":["Opener sentence 1.","Opener sentence 2.","Opener sentence 3."]}
Do not use any tools — reply directly with text only.`;
    let cand: ScenarioTargetCandidate | null = null;
    for (let attempt = 1; attempt <= 3 && !cand; attempt++) {
      let text: string | undefined;
      try {
        ({ text } = await deps.runner(
          `Write the ${deps.domain} scenario (band ${deps.band}, item ${i + 1}/${deps.count}) now.`, undefined, { systemPrompt: system },
        ));
      } catch (err) {
        console.warn("[content-gen] runner error:", err instanceof Error ? err.message : String(err));
      }
      if (text !== undefined) {
        const parsed = extractJson<NewContentCandidate>(text);
        cand = validateScenarioTargetCandidate(parsed, existingIds, deps.scenariosDir);
      }
      if (!cand && attempt < 3) log(`  ${deps.domain}/${deps.band}: 検証NG — 再生成します(${attempt}/3)`);
    }
    if (!cand) {
      throw new Error(`エラー: ${deps.domain}/${deps.band} の scenario (${i + 1}/${deps.count}) が3回とも検証を通りませんでした。何も書き込みません。`);
    }
    existingIds.add(cand.id);
    candidates.push({ ...cand, kind: "scenario", domain: deps.domain, level: [lo, hi] });
    log(`  + scenario: ${cand.id} [${deps.domain}/${lo}-${hi}] ${cand.title}`);
  }

  if (deps.dry) {
    log("--dry のため書き込みません");
    return;
  }

  const written: string[] = [];
  try {
    for (const cand of candidates) {
      const file = path.join(deps.scenariosDir, `${cand.id}.md`);
      if (existsSync(file)) throw new Error(`エラー: ${file} は既に存在します。中止します。`);
      writeFileSync(file, contentToMarkdown(cand));
      written.push(file);
    }
  } catch (err) {
    for (const f of written) rmSync(f, { force: true });
    throw err;
  }
  log(`完了: ${written.length} 本の ${deps.domain}/${deps.band} scenario を追加しました。`);
}

// v0.26 content-ladder wave4: spoken function 例文（依頼/断り/聞き返し/言い換え/相槌）+90（帯別30・解説つき）。
// 設計doc §3「domain非依存・帯別30」。既存の文法/機能カテゴリ(1-25)とは別枠として category_no 26-30 を固定で
// 割り当てる（category_no は将来にわたって不変な識別子のため、実行時の動的採番ではなく固定表にする）。
export const SPOKEN_FUNCTIONS = ["request", "refusal", "clarification", "paraphrase", "backchannel"] as const;
export type SpokenFunction = (typeof SPOKEN_FUNCTIONS)[number];

export const SPOKEN_FUNCTION_CATEGORY_NO: Record<SpokenFunction, number> = {
  request: 26, refusal: 27, clarification: 28, paraphrase: 29, backchannel: 30,
};

/** 既存の「機能: 依頼・許可・提案」等（category_no 22-25・複数機能の合成カテゴリ）と区別するため「会話機能:」を使う */
export const SPOKEN_FUNCTION_CATEGORY_JA: Record<SpokenFunction, string> = {
  request: "会話機能: 依頼する",
  refusal: "会話機能: 断る",
  clarification: "会話機能: 聞き返す",
  paraphrase: "会話機能: 言い換える",
  backchannel: "会話機能: 相槌を打つ",
};

const SPOKEN_FUNCTION_DESC: Record<SpokenFunction, string> = {
  request: "making a polite request — asking someone to do something for you",
  refusal: "politely declining or saying no to a request, invitation, or offer",
  clarification: "asking someone to repeat, clarify, or explain something you didn't catch or understand",
  paraphrase: "rephrasing or restating an idea in different words, e.g. to check or confirm understanding",
  backchannel: "short reactive phrases used while listening to someone (agreeing, showing interest, surprise, etc.)",
};

/**
 * 帯×カテゴリあたりのquota（5カテゴリ×6件=30文/帯・3帯で計90文）。checkPrepChunk等の粗い外枠とは異なり、
 * ここは「1回のバッチ生成で何件を依頼するか」を兼ねる（genSentencesの「4文まとめて生成」と同じ発想の拡張）。
 */
const SPOKEN_FUNCTION_QUOTA_PER_CATEGORY = 6;

/**
 * spoken function 例文の帯別・文あたりの語数上限（hard cap）。spoken-style.LENGTH_CAP_BY_BANDのガイド
 * （6-10/9-13/10-15語）に、THRESHOLDS_BY_BANDのmaxAvgWordsPerSentence(11/14/16)よりさらに数語の
 * 余裕を持たせた「明らかな逸脱だけを弾く」粗いゲート。文単位の主要な質ゲートはcheckSpokenRegister
 * （バッチ結合テキストへの平均文長・短縮形率チェック）が担う。
 */
const SPOKEN_FUNCTION_WORD_CAP: Record<Band, number> = {
  foundation: 13, development: 16, fluency: 19,
};

/** content-coverage.Band(foundation/development/fluency) → spoken-style.SpokenBand(beginner/intermediate/advanced) */
const SPOKEN_BAND_FOR_CONTENT_BAND: Record<Band, SpokenBand> = {
  foundation: "beginner", development: "intermediate", fluency: "advanced",
};

const SPOKEN_FUNCTION_BAND_DIFFICULTY_DESC: Record<Band, string> = {
  foundation: "beginner difficulty stage 1-2 of 6",
  development: "intermediate difficulty stage 3-4 of 6",
  fluency: "advanced difficulty stage 5-6 of 6",
};

/**
 * spoken function 例文候補の検証。既存 validateNewSentences（domain/空文字/重複/no連番）に加えて、
 * 帯別の書き言葉語彙禁止（1文でも書き言葉語彙を含めば候補全体を不採用）と帯別語数上限（同）を課す。
 * 通過した候補には band を付与して返す（既存の300文には無い additive フィールド）。
 * 短縮形率はここでは検査しない（呼び出し側が帯全体の集計でのみ checkSpokenRegister を課す）。
 * 理由: request（依頼）機能の自然な定番表現 "Can/Could you ...?" は短縮できない語順のため短縮形が
 * ほぼ0%でも完全に自然な話し言葉であり、カテゴリ単体に短縮形率を要求すると誤ってFAILする
 * （spoken-register-check.checkScenarioStarterが単一発話への短縮形要求を撤回した理由と同じ較正実績）。
 */
export function validateSpokenFunctionSentences(
  cands: unknown, existing: Sentence[], categoryNo: number, category: string, band: Band,
): Sentence[] | null {
  const base = validateNewSentences(cands, existing, categoryNo, category);
  if (!base) return null;
  const cap = SPOKEN_FUNCTION_WORD_CAP[band];
  for (const s of base) {
    if (findWrittenVocabHits(s.en).length > 0) return null;
    if (countWords(s.en) > cap) return null;
  }
  return base.map((s) => ({ ...s, band }));
}

export type GenSpokenFunctionSentencesForTargetDeps = {
  runner: ClaudeRunner;
  sentencesFile: string;
  band: Band;
  dry: boolean;
  log?: (s: string) => void;
};

/**
 * 指定した帯(band)1つ分の spoken function 例文（5カテゴリ×quota6件=最大30文）を生成する。
 * カテゴリ×帯セルごとに既存件数（category_no一致 かつ band一致）を数え、quota(6件)充足済みなら
 * そのカテゴリはスキップする（べき等・中断後の再実行対応。genListeningForTarget等と違い、こちらは
 * セル内のカテゴリ単位でスキップ判定するため--fill-coverageのcomputeBandCoverageStatusesは使わない
 * — 帯×domain×typeの粒度ではなく帯×カテゴリの粒度で完結する専用ロジック）。
 * 各カテゴリのバッチ生成は3ラウンド規律（genListeningForTarget等と同じ）で、構造検証
 * （validateSpokenFunctionSentences: 既存フォーマット + 書き言葉語彙禁止 + 帯別語数上限）をhard-failゲートする。
 * カテゴリ単体では checkSpokenRegister（短縮形率等）を課さない — request（依頼）のように定番表現が
 * 短縮不能で短縮形率が自然に0%近くなる機能があるため（validateSpokenFunctionSentencesのコメント参照）。
 * 全カテゴリ処理後、帯全体（新規+既存の充足済み分を合わせた最大30文・複数機能を横断した集計）でのみ
 * checkSpokenRegister を通す（コーパス粒度の最終確認 — request単体は短縮形0%でも、他機能[refusal/
 * clarification等]の短縮形が多い分で帯全体としては自然な話し言葉の水準に収まる想定）。
 * FAILならこの呼び出し全体を書き込みゼロで throw する（同じ帯を再実行すれば、既存カテゴリはそのまま・
 * 不足カテゴリだけ再生成される）。
 */
export async function genSpokenFunctionSentencesForTarget(deps: GenSpokenFunctionSentencesForTargetDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const sentences = loadSentences(deps.sentencesFile);
  const [lo] = BAND_STAGE_RANGE[deps.band];
  const spokenBand = SPOKEN_BAND_FOR_CONTENT_BAND[deps.band];
  const vocab = vocabConstraint(lo);
  const vocabLine = vocab ? `${vocab}\n` : "";

  let all = [...sentences];
  const bandAdded: Sentence[] = [];
  let anyGenerated = false;

  for (const fn of SPOKEN_FUNCTIONS) {
    const categoryNo = SPOKEN_FUNCTION_CATEGORY_NO[fn];
    const category = SPOKEN_FUNCTION_CATEGORY_JA[fn];
    const existingInCell = all.filter((s) => s.category_no === categoryNo && s.band === deps.band);
    bandAdded.push(...existingInCell);
    const needed = SPOKEN_FUNCTION_QUOTA_PER_CATEGORY - existingInCell.length;
    if (needed <= 0) {
      log(`  ${fn}/${deps.band}: 充足済み（スキップ）`);
      continue;
    }

    const existingInCategory = all.filter((s) => s.category_no === categoryNo);
    const system = `You write original English example sentences for a Japanese learner (${SPOKEN_FUNCTION_BAND_DIFFICULTY_DESC[deps.band]}) practicing a spoken conversational function: ${SPOKEN_FUNCTION_DESC[fn]}.
Write exactly ${needed} original spoken-register sentences using this function. Domains: spread freely across daily life, business/work, and IT/tech situations — the function itself is not tied to any one domain.
${spokenStyleFor(spokenBand)}
${vocabLine}${ORIGINALITY}
Avoid these existing sentences in this category (do not duplicate or closely paraphrase):
${existingInCategory.slice(0, 12).map((s) => `- ${s.en}`).join("\n")}
Reply with STRICT JSON only: {"sentences":[{"domain":"daily|business|it","en":"...","ja":"自然な和訳","note":"使う場面や言い方のポイント1行(日本語)"}]}
Do not use any tools — reply directly with text only.`;

    let validated: Sentence[] | null = null;
    for (let attempt = 1; attempt <= 3 && !validated; attempt++) {
      let text: string | undefined;
      try {
        ({ text } = await deps.runner(`Generate the ${needed} sentences for spoken function: ${fn} (band ${deps.band}).`, undefined, { systemPrompt: system }));
      } catch (err) {
        // SDK呼び出し自体の一過性エラー（例: tool_use起因のmaxTurns超過）も検証NGと同様に再試行する。
        // 非一過性の障害（認証切れ等）が「検証NG」に化けて原因が消えないよう、実エラーは必ずログに残す
        console.warn("[content-gen] runner error:", err instanceof Error ? err.message : String(err));
      }
      if (text !== undefined) {
        const parsed = extractJson<{ sentences?: unknown }>(text);
        validated = parsed ? validateSpokenFunctionSentences(parsed.sentences, all, categoryNo, category, deps.band) : null;
      }
      if (!validated && attempt < 3) log(`  ${fn}/${deps.band}: 検証NG — 再生成します(${attempt}/3)`);
    }
    if (!validated) {
      throw new Error(`エラー: spoken function「${fn}」(band ${deps.band}) の生成が3回とも検証を通りませんでした。何も書き込みません。`);
    }
    all = [...all, ...validated];
    bandAdded.push(...validated);
    anyGenerated = true;
    for (const s of validated) log(`  + no.${s.no} [${deps.band}/${fn}] ${s.en}`);
  }

  if (!anyGenerated) {
    log(`  band ${deps.band}: 全カテゴリ充足済み（生成不要）。`);
    return;
  }

  const aggregate = checkSpokenRegister(bandAdded.map((s) => s.en).join(" "), spokenBand);
  if (!aggregate.pass) {
    throw new Error(
      `エラー: band ${deps.band} の合計${bandAdded.length}文での口語レジスター集計検証がFAILしました: ` +
      `${aggregate.reasons.join(" / ")}。何も書き込みません。`,
    );
  }
  log(`  band ${deps.band}: 集計チェックPASS（${bandAdded.length}文・平均${aggregate.metrics.avgWordsPerSentence.toFixed(2)}語/文・短縮形率${aggregate.metrics.contractionsPerSentence.toFixed(2)}）`);

  if (deps.dry) {
    log("--dry のため書き込みません");
    return;
  }
  // 書き込み前バリデーション: temp に書いて loadSentences が全件読めることを確認してから本番に書く（genSentencesと同型）
  const work = mkdtempSync(path.join(tmpdir(), "gen-sf-"));
  try {
    const tempFile = path.join(work, "sentences.json");
    writeFileSync(tempFile, JSON.stringify(all, null, 2) + "\n");
    const check = loadSentences(tempFile);
    if (check.length !== all.length) {
      throw new Error(`エラー: 生成物のバリデーションに失敗（${all.length}件中${check.length}件のみ有効）。書き込みを中止します。`);
    }
    writeFileSync(deps.sentencesFile, JSON.stringify(all, null, 2) + "\n");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  log(`完了: band ${deps.band} に ${all.length - sentences.length} 文を追記しました（計 ${all.length} 文）。`);
}

export type GenSpokenFunctionSentencesDeps = {
  runner: ClaudeRunner;
  sentencesFile: string;
  dry: boolean;
  log?: (s: string) => void;
};

/**
 * spoken function 例文の3帯ラッパー（foundation→development→fluencyの順に genSpokenFunctionSentencesForTarget
 * を呼ぶ・genListeningがgenListeningForTargetを帯ごとに呼ぶのと同じ構造）。帯ごとに書き込みが確定するため、
 * 途中の帯で失敗しても、それより前に完了した帯の内容はファイルに残る（中断後の再実行で続きから進められる）。
 */
export async function genSpokenFunctionSentences(deps: GenSpokenFunctionSentencesDeps): Promise<void> {
  const log = deps.log ?? console.log;
  for (const band of BANDS) {
    log(`\n=== spoken functions / ${band} ===`);
    await genSpokenFunctionSentencesForTarget({
      runner: deps.runner, sentencesFile: deps.sentencesFile, band, dry: deps.dry, log,
    });
  }
}

export type GenSentenceExplanationsDeps = {
  runner: ClaudeRunner;
  sentencesFile: string;
  explanationsFile: string;
  dry: boolean;
  log?: (s: string) => void;
};

/**
 * sentences.json にあって explanations.json に無い no のぶんだけ解説を生成して追記する（同梱解説の欠損補充）。
 * 生成は coach.ts の generateSentenceExplanation を再利用する（ルートの都度生成・DBキャッシュと同一プロンプト
 * ・同一フォーマット = explanations.json のスキーマ {no, text} とも一致する）。
 * 1件ずつ生成する（文ごとに文脈が異なる自由記述の解説をバッチ化する利点が薄いため）。
 * 個々の生成失敗（runner例外・空文字）はその no をスキップしてログに残し、全体は止めない
 * （解説はUXの補助でありSRS等の必須データではない — 未生成分は routes 側の都度生成+DBキャッシュに
 * フォールバックする既存経路が担保するため、他の gen* 系のようなall-or-nothingにはしない）。
 */
export async function genMissingSentenceExplanations(deps: GenSentenceExplanationsDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const sentences = loadSentences(deps.sentencesFile);
  const existing = loadBundledExplanations(deps.explanationsFile);
  const missing = sentences.filter((s) => !existing.has(s.no));
  if (missing.length === 0) {
    log("解説の欠損はありません。");
    return;
  }
  log(`解説を生成します: ${missing.length}件`);

  const added: Array<{ no: number; text: string }> = [];
  for (const s of missing) {
    try {
      const { text } = await generateSentenceExplanation({ en: s.en, ja: s.ja, note: s.note }, deps.runner);
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        log(`  no.${s.no}: 空の解説を無視します`);
        continue;
      }
      added.push({ no: s.no, text: trimmed });
      log(`  + no.${s.no} の解説を生成しました`);
    } catch (err) {
      log(`  no.${s.no}: 解説生成に失敗しました（スキップ）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (deps.dry) {
    log("--dry のため書き込みません");
    return;
  }
  if (added.length === 0) return;

  const raw: unknown = existsSync(deps.explanationsFile) ? JSON.parse(readFileSync(deps.explanationsFile, "utf8")) : [];
  const arr = Array.isArray(raw) ? (raw as Array<{ no: number; text: string }>) : [];
  const merged = [...arr, ...added];
  writeFileSync(deps.explanationsFile, JSON.stringify(merged, null, 2) + "\n");
  log(`完了: 解説 ${added.length}件を追記しました（計 ${merged.length}件）。`);
}
