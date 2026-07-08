/**
 * 口語レジスター検証の純ロジック。
 * 英文テキストから ①短縮形率 ②平均文長（語/文） ③書き言葉語彙ヒットを算出し、帯別閾値で PASS/FAIL を返す。
 * 較正根拠（docs/superpowers/plans/2026-07-09-spoken-register-pack.md の監査事実）:
 *   例文300 = 平均9.58語/文・短縮形37%・書き言葉語彙ほぼ0 → PASS基準のコーパス
 *   多聴6本（旧版） = 初級2本 短縮形0%の教科書調 / 上級3本 平均17.8〜19.4語/文のエッセイ調 → FAIL現物
 * 閾値の具体値は __tests__/spoken-register-check.test.ts で実データ較正して固定している。
 */
import type { SpokenBand } from "./spoken-style";

export type SpokenRegisterMetrics = {
  sentenceCount: number;
  wordCount: number;
  avgWordsPerSentence: number;
  contractionCount: number;
  /** 短縮形出現数/文数（短縮可能位置の分母を厳密に数えない簡易近似。ブリーフで明示許容） */
  contractionsPerSentence: number;
  writtenVocabHits: Array<{ term: string; count: number }>;
};

export type SpokenRegisterResult = {
  band: SpokenBand;
  metrics: SpokenRegisterMetrics;
  pass: boolean;
  reasons: string[];
};

/**
 * 文分割で短縮形と誤認しないよう保護する略語（ピリオドを伴うもの）。
 * プレースホルダー文字での退避/復元は使わない（過去に制御文字(NULバイト)が紛れ込みファイルがgit上binary扱いになった事故があるため）。
 * 代わりに「直前が [.!?] かつ、直前が『略語+ピリオド』ではない」ことを否定後読みで判定し、その位置でのみ分割する。
 */
const ABBREVIATIONS = ["Mr", "Mrs", "Ms", "Dr", "Prof", "Jr", "Sr", "St", "vs", "etc"];
const SENTENCE_SPLIT_RE = new RegExp(`(?<=[.!?])(?<!\\b(?:${ABBREVIATIONS.join("|")})\\.)\\s+`);

/** .!? の直後の空白で分割する（Mr./Dr. などの略語のピリオドでは分割しない） */
export function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const WORD_RE = /[A-Za-z0-9]+(?:'[A-Za-z]+)?/g;

/** 語数（短縮形 don't 等は1語として数える） */
export function countWords(text: string): number {
  return text.match(WORD_RE)?.length ?? 0;
}

/**
 * 短縮形の出現数。
 * - n't / 'm / 're / 've / 'll / 'd は所有格と綴りが衝突しないため常にカウントする（don't, I'm, we're, we've, we'll, I'd 等）。
 * - 's は所有格（例: the manager's desk）と綴りが同じため、既知の短縮形ホスト（it/that/there/here/he/she/what/who/let/how）
 *   に続く場合のみカウントする（it's, that's, there's, here's, he's, she's, what's, who's, let's, how's）。
 *   固有名詞+'s（例: James's）は所有格・短縮形の判別がつかず稀なため対象外とする。
 */
const NT_OR_SUFFIX_CONTRACTION_RE = /\b[A-Za-z]+'(?:m|re|ve|ll|d)\b|\b[A-Za-z]+n't\b/gi;
const S_CONTRACTION_HOSTS = ["it", "that", "there", "here", "he", "she", "what", "who", "let", "how"];
const S_CONTRACTION_RE = new RegExp(`\\b(?:${S_CONTRACTION_HOSTS.join("|")})'s\\b`, "gi");

export function countContractions(text: string): number {
  const suffixCount = text.match(NT_OR_SUFFIX_CONTRACTION_RE)?.length ?? 0;
  const sCount = text.match(S_CONTRACTION_RE)?.length ?? 0;
  return suffixCount + sCount;
}

/**
 * 書き言葉語彙の禁止リスト（Task1 spoken-style.ts のブロック内の禁止例に、監査で指摘された語を加えたもの）。
 * 活用形（s/ed/ing/ly等）でのすり抜けを防ぐため、語ごとに活用形をカバーする正規表現を対で持つ。
 * 不変の談話標識（moreover等）は活用しないためそのまま。
 */
const BAN_TERM_PATTERNS: ReadonlyArray<{ term: string; pattern: string }> = [
  { term: "moreover", pattern: "moreover" },
  { term: "furthermore", pattern: "furthermore" },
  { term: "therefore", pattern: "therefore" },
  { term: "consequently", pattern: "consequently" },
  { term: "nevertheless", pattern: "nevertheless" },
  { term: "in addition", pattern: "in\\s+addition" },
  { term: "utilize", pattern: "utiliz(?:e|es|ed|ing|ation)" },
  { term: "individual", pattern: "individual(?:s|ly)?" },
  { term: "numerous", pattern: "numerous(?:ly)?" },
  { term: "approximately", pattern: "approximat(?:e|es|ed|ely|ing)" },
];

export const WRITTEN_VOCAB_BAN_LIST: readonly string[] = BAN_TERM_PATTERNS.map((p) => p.term);

/** 禁止語彙の出現をヒット語ごとに数える（活用形込み・大文字小文字を問わない単語/フレーズ一致） */
export function findWrittenVocabHits(text: string): Array<{ term: string; count: number }> {
  const hits: Array<{ term: string; count: number }> = [];
  for (const { term, pattern } of BAN_TERM_PATTERNS) {
    const re = new RegExp(`\\b${pattern}\\b`, "gi");
    const count = text.match(re)?.length ?? 0;
    if (count > 0) hits.push({ term, count });
  }
  return hits;
}

export function computeSpokenRegisterMetrics(text: string): SpokenRegisterMetrics {
  const sentenceCount = splitSentences(text).length;
  const wordCount = countWords(text);
  const contractionCount = countContractions(text);
  return {
    sentenceCount,
    wordCount,
    avgWordsPerSentence: sentenceCount === 0 ? 0 : wordCount / sentenceCount,
    contractionCount,
    contractionsPerSentence: sentenceCount === 0 ? 0 : contractionCount / sentenceCount,
    writtenVocabHits: findWrittenVocabHits(text),
  };
}

export type BandThresholds = {
  /** これを超えたら FAIL（エッセイ調の長文化を検出） */
  maxAvgWordsPerSentence: number;
  /** これを下回ったら FAIL（短縮形0%の教科書調を検出） */
  minContractionsPerSentence: number;
  /** これを超えたら FAIL（書き言葉語彙ヒット件数の上限。既定0） */
  maxWrittenVocabHits: number;
};

/**
 * 帯別閾値。spoken-style.ts の LENGTH_CAP_BY_BAND（各帯の文長上限ガイド: 6-10 / 9-13 / 10-15 語）に
 * 1語の余裕を足した値を上限とし、短縮形率の下限は全帯 0.2（短縮形数/文数）で統一。
 * __tests__/spoken-register-check.test.ts の較正テストで実データに対して固定している値:
 *   例文300（抜粋） PASS / 多聴6本（旧版・抜粋） FAIL が両立するように調整済み。
 */
export const THRESHOLDS_BY_BAND: Record<SpokenBand, BandThresholds> = {
  beginner: { maxAvgWordsPerSentence: 11, minContractionsPerSentence: 0.2, maxWrittenVocabHits: 0 },
  intermediate: { maxAvgWordsPerSentence: 14, minContractionsPerSentence: 0.2, maxWrittenVocabHits: 0 },
  advanced: { maxAvgWordsPerSentence: 16, minContractionsPerSentence: 0.2, maxWrittenVocabHits: 0 },
};

/**
 * frontmatter の level: [min, max] から帯を推定する（3帯 [1,2]/[3,4]/[5,6] の境界と一致: level[1]<=3 は beginner、
 * level[0]>=4 は advanced、それ以外（development=[3,4]自体・帯をまたぐbridge）は intermediate）。
 * 旧実装は scripts/check-spoken-register.ts 内にのみ private に存在しテストが無かった。genListening系の
 * 帯決定とCLIの両方から参照できるよう、ここに一本化してエクスポートする。
 */
export function bandForLevel(level: [number, number]): SpokenBand {
  if (level[1] <= 3) return "beginner";
  if (level[0] >= 4) return "advanced";
  return "intermediate";
}

export function checkSpokenRegister(text: string, band: SpokenBand): SpokenRegisterResult {
  const metrics = computeSpokenRegisterMetrics(text);
  const th = THRESHOLDS_BY_BAND[band];
  const reasons: string[] = [];
  if (metrics.avgWordsPerSentence > th.maxAvgWordsPerSentence) {
    reasons.push(
      `平均文長 ${metrics.avgWordsPerSentence.toFixed(2)} 語/文が上限 ${th.maxAvgWordsPerSentence} 語/文を超えています（エッセイ調の可能性）`,
    );
  }
  if (metrics.contractionsPerSentence < th.minContractionsPerSentence) {
    reasons.push(
      `短縮形率 ${metrics.contractionsPerSentence.toFixed(2)}（短縮形数/文数）が下限 ${th.minContractionsPerSentence} 未満です（教科書調の可能性）`,
    );
  }
  if (metrics.writtenVocabHits.length > th.maxWrittenVocabHits) {
    reasons.push(
      `書き言葉語彙を検出: ${metrics.writtenVocabHits.map((h) => `${h.term}×${h.count}`).join(", ")}`,
    );
  }
  return { band, metrics, pass: reasons.length === 0, reasons };
}

/**
 * model talk（連続モノローグ）の口語レジスター検証。
 * 設計doc §5: 「listening / model talk（連続モノローグ）: spoken-register 3指標を hard fail（帯別閾値）」
 * — ロジックは checkSpokenRegister と完全に同一（同じ3指標・同じ帯別閾値）。model talk 生成パイプライン
 * から意味の伝わる名前で呼べるようにする別名エクスポートであり、listening 側の呼び出しは
 * checkSpokenRegister のまま変更しない（既存セマンティクス不変）。
 */
export function checkModelTalk(text: string, band: SpokenBand): SpokenRegisterResult {
  return checkSpokenRegister(text, band);
}

export type PrepChunk = { en: string; ja: string };

export type PrepChunkThresholds = { minWords: number; maxWords: number };

/**
 * prepPack 1chunk あたりの語数許容レンジ。
 * coach.ts prepSystem() の帯別ガイド（stage1-2: 6-10語 / stage3: 8-14語 / stage4+: 8-16語）の全域を
 * カバーする単一の外枠として設定する。本チェックはプロンプト側の帯別厳密さを補完する粗い機械ゲートであり、
 * stage別の厳密な範囲判定はしない — 明らかな異常（1語のフラグメント・数十語の長文化）だけを検出する。
 */
export const PREP_CHUNK_WORD_RANGE: PrepChunkThresholds = { minWords: 4, maxWords: 20 };

/**
 * placeholder らしき文字列（未展開のテンプレート跡）を検出する。
 * [name] / <topic> / {slot} のようなブラケット系、TODO/TBD、3つ以上の連続アンダースコア、そして
 * 省略記号（coach.ts prepSystem が明示的に禁止する "..." / "…"）を対象にする。
 */
const PLACEHOLDER_RE = /\[[^\]]*\]|<[^>]*>|\{[^}]*\}|\bTODO\b|\bTBD\b|_{2,}|\.\.\.|…/i;

/**
 * 文の表層的な完全性判定（大文字始まり・句読点終わり）。
 * 主語+動詞の厳密な文法完全性は判定しない — 相槌的な短い発話（例: "Sure thing." "Sounds good!"）も
 * 正当な話し言葉の完結した発話として扱うため、意図的に表層規則のみで判定する
 * （ブリーフの「natural spoken fragment rule」に対応 — 文法的完全性を要求すると自然な短い発話を
 * 誤ってFAILさせてしまうため、句読点で閉じているかどうかだけを見る）。
 */
function looksLikeCompleteSentence(text: string): boolean {
  if (!text) return false;
  const startsOk = /^[A-Z0-9"'(]/.test(text);
  const endsOk = /[.!?]["')]?$/.test(text);
  return startsOk && endsOk;
}

export type PrepChunkResult = {
  pass: boolean;
  reasons: string[];
  wordCount: number;
};

/**
 * prepPack の1chunk単位の検証（listening/model talkの「集計」チェックとは別物 — 1文ごとに判定する）。
 * 検査項目: ①完全な文か（大文字始まり・句読点終わり） ②語数が許容レンジ内か ③placeholderトークンが無いか。
 */
export function checkPrepChunk(chunk: PrepChunk): PrepChunkResult {
  const text = (chunk.en ?? "").trim();
  const reasons: string[] = [];
  const wordCount = countWords(text);

  if (!looksLikeCompleteSentence(text)) {
    reasons.push(`完全な文になっていません（大文字始まり・句読点終わりが必要）: "${text}"`);
  }
  if (wordCount < PREP_CHUNK_WORD_RANGE.minWords || wordCount > PREP_CHUNK_WORD_RANGE.maxWords) {
    reasons.push(
      `語数 ${wordCount} 語が許容範囲 ${PREP_CHUNK_WORD_RANGE.minWords}-${PREP_CHUNK_WORD_RANGE.maxWords} 語の外です`,
    );
  }
  const placeholder = text.match(PLACEHOLDER_RE);
  if (placeholder) {
    reasons.push(`placeholderらしき文字列を検出: "${placeholder[0]}"`);
  }
  return { pass: reasons.length === 0, reasons, wordCount };
}

export type ScenarioStarterResult = {
  pass: boolean;
  reasons: string[];
  wordCount: number;
  hasContraction: boolean;
};

/**
 * starter（シナリオ冒頭セリフ）1件あたりの語数上限。単一の話しことば発話としては明らかに長すぎる
 * （手紙・案内文調に流れている）ことを検出するための粗い外枠。実在54件の起点セリフの最大語数は13語
 * （__tests__/spoken-register-check.test.ts の較正コーパスで実証）のため、十分な余裕を持たせている。
 */
const STARTER_MAX_WORDS = 20;

/**
 * starter の書き言葉調 定型句パターン（非網羅的なキーワードリスト）。
 * レビュー指摘（実データ較正）: 旧実装は「短縮形が無ければ書き言葉調」という単一発話への短縮形要求を
 * 課しており、実在54件の起点セリフ中28件（52%）を誤ってFAILさせていた（"Hi, could I see the menu,
 * please?" 等、丁寧な依頼・挨拶は短縮形が無くても自然な話しことば — 単一発話に短縮形を要求するのは
 * 言語学的に誤り）。短縮形は「あれば自然さの一つの手がかり」という positive signal に留め、
 * 必須要件にはしない。代わりに、手紙・ビジネス文書調であることが明確な定型句だけを狙い撃ちで検出する。
 */
const FORMAL_STARTER_RE =
  /\bI would like to inquire\b|\bit is necessary\b|\bI am writing (?:to|in regard to|regarding)\b|\bplease be advised\b|\bkindly\b|\bat your earliest convenience\b|\bthis is to inform you\b|\bwould it be possible for you to\b|\bI am contacting you regarding\b|\bwe regret to inform\b|\bpursuant to\b/i;

/**
 * シナリオ starters のみを対象にした口語検証（hints/setupのナラティブ文には適用しない — 呼び出し側の責務）。
 * 設計doc §5: 「scenarios: starters（冒頭セリフ）のみ口語検証。hints/setupには短縮形率を要求しない」。
 * hard-fail条件: ①書き言葉語彙ヒット ②語数超過（STARTER_MAX_WORDS） ③書き言葉調の定型句ヒット。
 * 短縮形の有無はpass/failに影響しない情報用フィールド（hasContraction）としてのみ返す。
 * 較正根拠: 実在54件の起点セリフ全件PASS・書き言葉調で構成したFAIL例文がFAILすることを
 * __tests__/spoken-register-check.test.ts で固定している。
 */
export function checkScenarioStarter(text: string): ScenarioStarterResult {
  const trimmed = text.trim();
  const wordCount = countWords(trimmed);
  const hasContraction = countContractions(trimmed) > 0;
  const reasons: string[] = [];

  if (wordCount > STARTER_MAX_WORDS) {
    reasons.push(`語数 ${wordCount} 語が上限 ${STARTER_MAX_WORDS} 語を超えています（単一発話として長すぎる可能性）`);
  }
  const formalMatch = trimmed.match(FORMAL_STARTER_RE);
  if (formalMatch) {
    reasons.push(`書き言葉調の定型句を検出: "${formalMatch[0]}"`);
  }
  const vocabHits = findWrittenVocabHits(trimmed);
  if (vocabHits.length > 0) {
    reasons.push(`書き言葉語彙を検出: ${vocabHits.map((h) => `${h.term}×${h.count}`).join(", ")}`);
  }
  return { pass: reasons.length === 0, reasons, wordCount, hasContraction };
}
