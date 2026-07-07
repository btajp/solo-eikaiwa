import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeEn } from "./chunks";
import { extractJson } from "./coach";
import type { ClaudeRunner } from "./converse";
import { loadContent } from "./content";
import { loadListening } from "./listening";
import { loadSentences, type Sentence } from "./sentences";
import { vocabConstraint } from "./progression";
import { categoryBadRates, pickWorstCategories } from "./srs-analytics";

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
    const system = `You create one original ${p.kind} for an English speaking practice app (Japanese learner, difficulty stage ${deps.stage} of 6).
${p.kind === "topic"
  ? "A topic gives 4 talking-point hints for a monologue."
  : "A scenario sets up a roleplay: who the AI plays, who the learner is, the goal, and useful moves."}
Each hint line: English phrase — 日本語の補足. Spoken register. ${ORIGINALITY}
${vocabLine}Do NOT reuse these existing ids: ${existing}
Reply with STRICT JSON only:
{"id":"kebab-case-id","title":"English title","titleJa":"日本語タイトル","domain":"daily|business|it","level":[min,max],"hints":["English — 日本語", ...4 items]}
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
        cand = validateTopicCandidate(parsed, p.kind, existingIds, p.dir, deps.stage);
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
  if (!Array.isArray(c.starters) || c.starters.length !== 3) return null;
  if (!c.starters.every((s) => typeof s === "string" && s.trim().length > 0 && !s.includes("\n"))) return null;
  return {
    id: c.id, title: c.title.trim(), titleJa: c.titleJa.trim(),
    hints: c.hints.map((h) => h.trim()), starters: c.starters.map((s) => s.trim()),
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

export type GenListeningDeps = {
  runner: ClaudeRunner;
  listeningDir: string;
  dry: boolean;
  log?: (s: string) => void;
};

/**
 * stage帯（下=1-3 / 上=4-6）× 3ドメイン = 6本の多聴素材を生成する。level と domain はプランで固定し、
 * 語彙制約は帯に連動（下帯は vocabConstraint あり・上帯は無し）。全候補を検証してから一括書き込み（all-or-nothing）。
 * いずれかが2回とも検証NGなら何も書き込まず throw する。
 */
const LISTENING_PLAN: ReadonlyArray<{ domain: (typeof DOMAINS)[number]; level: [number, number]; vocabStage: number }> = [
  { domain: "daily", level: [1, 3], vocabStage: 2 },
  { domain: "business", level: [1, 3], vocabStage: 2 },
  { domain: "it", level: [1, 3], vocabStage: 2 },
  { domain: "daily", level: [4, 6], vocabStage: 5 },
  { domain: "business", level: [4, 6], vocabStage: 5 },
  { domain: "it", level: [4, 6], vocabStage: 5 },
];

export async function genListening(deps: GenListeningDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const existingIds = new Set(loadListening(deps.listeningDir).map((it) => it.id));
  const candidates: Array<NewListeningCandidate & { domain: string; level: [number, number] }> = [];

  for (const p of LISTENING_PLAN) {
    const vocab = vocabConstraint(p.vocabStage);
    // stage>=4（vocab===null）は行自体を挿入しない（上級者向け素材の語彙制約なし）
    const vocabLine = vocab ? `${vocab}\n` : "";
    const domainDesc = p.domain === "daily" ? "everyday life" : p.domain === "business" ? "the workplace" : "software/IT work";
    const system = `You write an original short LISTENING script for a Japanese learner of English to listen to (about 2-4 minutes when read aloud, roughly 250-450 words).
Topic domain: ${domainDesc}. Difficulty: aim at CEFR level band for learner stage ${p.level[0]}-${p.level[1]} of 6.
Write natural spoken-style prose (first or third person) in 3-5 short paragraphs. No headings, no bullet lists, no dialogue markers, no speaker labels.
${vocabLine}${ORIGINALITY}
Do NOT reuse these existing ids: ${[...existingIds].join(", ") || "(none)"}
Reply with STRICT JSON only — no markdown fences:
{"id":"kebab-case-id","title":"English title","titleJa":"日本語タイトル","paragraphs":["paragraph 1 text", "paragraph 2 text", "..."]}
Do not use any tools — reply directly with text only.`;
    let cand: NewListeningCandidate | null = null;
    for (let attempt = 1; attempt <= 2 && !cand; attempt++) {
      let text: string | undefined;
      try {
        ({ text } = await deps.runner(`Write the ${p.domain} listening script now.`, undefined, { systemPrompt: system }));
      } catch (err) {
        // SDK呼び出し自体の一過性エラー（例: tool_use起因のmaxTurns超過）も検証NGと同様に1回だけ再試行する。
        // 非一過性の障害（認証切れ等）が「検証NG」に化けて原因が消えないよう、実エラーは必ずログに残す
        console.warn("[content-gen] runner error:", err instanceof Error ? err.message : String(err));
      }
      if (text !== undefined) {
        const parsed = extractJson<NewListeningCandidate>(text);
        cand = validateListeningCandidate(parsed, existingIds, deps.listeningDir);
      }
      if (!cand && attempt === 1) log(`  ${p.domain}/${p.level[0]}-${p.level[1]}: 検証NG — 再生成します`);
    }
    if (!cand) {
      throw new Error(`エラー: ${p.domain}/${p.level[0]}-${p.level[1]} の多聴素材が検証を通りませんでした。何も書き込みません。`);
    }
    existingIds.add(cand.id);
    candidates.push({ ...cand, domain: p.domain, level: p.level });
    log(`  + listening: ${cand.id} [${p.domain}/${p.level[0]}-${p.level[1]}] ${cand.title}`);
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
  log(`完了: ${written.length} 本の多聴素材を追加しました。`);
}
