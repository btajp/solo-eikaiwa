/**
 * NEW-topic の「完全に既知」条項の機械検証（wave0・docs/superpowers/specs/2026-07-09-content-ladder-design.md §5）。
 * Nation の「学習者が新知識なしで自分の経験を話せる、具体的で一般的な場面」という接地条件を近似するため、
 * 生成候補には experienceAnchor / memoryCue / commonObjectsOrActions の3フィールドを必須とし、
 * 禁止カテゴリ（抽象論/専門知識/時事/希少趣味/個人情報前提）と抽象タイトルをキーワード/表層ヒューリスティックで検出する。
 *
 * 設計判断（wave1実装時に再検討が必要）: commonObjectsOrActions（配列）の frontmatter シリアライズ形式は
 * 本タスクでは未確定 —— content.ts の parseFrontmatter は単純な `key: value` の1行形式のみサポートし、
 * 配列値を扱えない。そのため本チェッカーは markdown frontmatter を直接読むのではなく、生成候補オブジェクト
 * （content-gen.ts の NewContentCandidate と同様、LLM出力JSONをパースした後の形）を検証対象とする。
 * markdown への実際のシリアライズ方式（カンマ区切り1行 / JSON埋め込み等）は、この3フィールドを実際に
 * 生成に使うwave（プランのwave1以降）で決定する。
 */

export type BannedCategory =
  | "abstract"
  | "specialist"
  | "current-affairs"
  | "rare-hobby"
  | "personal-info-required";

export const BANNED_CATEGORIES: readonly BannedCategory[] = [
  "abstract",
  "specialist",
  "current-affairs",
  "rare-hobby",
  "personal-info-required",
];

/**
 * 禁止カテゴリのキーワードヒューリスティック。いずれも非網羅的なキーワード一覧であり、限界がある:
 * - abstract: 哲学的・抽象論的な語のみを対象。具体的なモノに接地した比喩的タイトル（誤検出）や、
 *   リスト外の抽象語（見逃し）がありうる。
 * - specialist: 大学レベルの専門用語の代表例のみ。IT専門職の学習者にとって「専門的すぎる」境界は主観的。
 * - current-affairs: 時事性を示す定型句のみ。年号ベースの検出はしない（西暦を含む一般的な話題まで
 *   誤検出するため）。話題が実際に「最近のニュース」かどうかは語彙だけでは判別できない。
 * - rare-hobby: 代表的な希少趣味の固有名詞のみ。「希少」は本質的にロングテールで一覧化が不可能。
 *   一般的な趣味（料理・読書等）を誤ってrare-hobbyと判定することは無い設計だが、リスト外の希少趣味は
 *   素通りする（見逃し）。
 * - personal-info-required: 個人を特定しうる情報を尋ねる定型句のみ。日常会話で自然に出る「電話番号」等の
 *   一般語は誤検出を避けるため意図的に含めていない（"passport number" 等、明確に機微な項目のみ対象）。
 * いずれも「機械的な一次スクリーニング」であり、最終判断ではない（AGENTS.mdのAI生成教材手修正禁止方針に
 * 従い、FAIL時は生成し直す前提 — 誤検出があっても再生成でカバーされる）。
 */
const BANNED_CATEGORY_PATTERNS: ReadonlyArray<{ category: BannedCategory; pattern: RegExp }> = [
  {
    category: "abstract",
    pattern:
      /\bphilosophy\b|\bmetaphysics\b|\bepistemology\b|\bexistential(?:ism)?\b|\bthe meaning of life\b|\bconsciousness\b|\bmorality\b|\bideology\b|\bthe nature of\b|\bthe concept of\b|\babstract concept\b/i,
  },
  {
    category: "specialist",
    pattern:
      /\bquantum mechanics\b|\bthermodynamics\b|\bjurisprudence\b|\bmolecular biology\b|\bmacroeconomic policy\b|\bclinical trial\b|\borganic chemistry\b|\bastrophysics\b|\beconometrics\b|\bgenome sequencing\b/i,
  },
  {
    category: "current-affairs",
    pattern:
      /\bbreaking news\b|\belection\b|\bwar in\b|\bpolitical crisis\b|\brecent scandal\b|\bcurrent events\b|\bgeopolitics\b|\bdiplomatic crisis\b|\btrade war\b|\bpandemic outbreak\b/i,
  },
  {
    category: "rare-hobby",
    pattern:
      /\bfalconry\b|\btaxidermy\b|\bcompetitive yo-?yo\b|\bextreme ironing\b|\bcheese rolling\b|\bunderwater hockey\b|\bmedieval reenactment\b|\bgeocaching\b|\btrainspotting\b/i,
  },
  {
    category: "personal-info-required",
    pattern:
      /\bsocial security number\b|\bpassport number\b|\bbank account number\b|\bcredit card number\b|\bhome address\b|\bmedical history\b|\bmedical records\b|\bsalary details\b|\btax id\b|\bofficial id number\b/i,
  },
];

/** テキスト（title + experienceAnchor 等）から禁止カテゴリ該当を検出する（複数該当しうる） */
export function detectBannedCategories(text: string): BannedCategory[] {
  const hits: BannedCategory[] = [];
  for (const { category, pattern } of BANNED_CATEGORY_PATTERNS) {
    if (pattern.test(text)) hits.push(category);
  }
  return hits;
}

/**
 * 具体名詞ヒントの代表例（daily/business/itドメインで頻出する語彙のごく一部・非網羅）。
 * 「no concrete noun heuristic」: タイトルにこれらの語が1つも含まれなければ「抽象的かもしれない」と判定する。
 * 限界: この一覧に無いことは「非具体」を意味しない — 固有名詞や個別のモノ・場所・役割等を含む正当な
 * タイトルを誤って抽象判定してしまう（false positive）。逆に抽象語がこの一覧の語と偶然共起する
 * タイトル（例: "The Philosophy of Coffee"）は見逃す（false negative）。あくまで粗い一次シグナルであり、
 * 単独の確定判定には使わない（FAIL時は再生成でカバーする前提）。
 */
const CONCRETE_NOUN_HINTS: readonly string[] = [
  // daily
  "coffee", "tea", "breakfast", "lunch", "dinner", "kitchen", "grocery", "restaurant", "apartment",
  "bus", "train", "weekend", "phone", "laptop", "gym", "closet", "laundry", "neighbor", "hobby",
  "travel", "vacation", "pet", "dog", "cat", "morning", "commute",
  // business
  "meeting", "email", "manager", "colleague", "client", "customer", "office", "deadline", "interview",
  "resume", "salary", "presentation", "budget", "invoice", "schedule", "project", "team", "coworker",
  // it
  "code", "bug", "server", "database", "app", "software", "password", "network", "deployment",
  "test", "keyboard", "screen", "file", "backup", "ticket", "incident", "review",
];

export function looksAbstractTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return !CONCRETE_NOUN_HINTS.some((w) => lower.includes(w));
}

export type TopicAnchorCandidate = {
  title: string;
  experienceAnchor?: unknown;
  memoryCue?: unknown;
  commonObjectsOrActions?: unknown;
};

export type TopicAnchorCheckResult = {
  pass: boolean;
  reasons: string[];
};

/**
 * NEW-topic候補の「完全に既知」条項を検証する。
 * 検査項目: ①experienceAnchor/memoryCueが非空文字列か ②commonObjectsOrActionsが非空文字列の配列か
 * ③禁止カテゴリ（title + experienceAnchorのテキストから検出）④抽象タイトル（no concrete noun heuristic）。
 */
export function checkTopicAnchor(candidate: TopicAnchorCandidate): TopicAnchorCheckResult {
  const reasons: string[] = [];

  if (typeof candidate.experienceAnchor !== "string" || !candidate.experienceAnchor.trim()) {
    reasons.push("experienceAnchor が空です（学習者が自分の経験に接地できる具体的な説明が必要）");
  }
  if (typeof candidate.memoryCue !== "string" || !candidate.memoryCue.trim()) {
    reasons.push("memoryCue が空です");
  }
  const objectsOk =
    Array.isArray(candidate.commonObjectsOrActions) &&
    candidate.commonObjectsOrActions.length > 0 &&
    candidate.commonObjectsOrActions.every((x) => typeof x === "string" && x.trim().length > 0);
  if (!objectsOk) {
    reasons.push("commonObjectsOrActions が空、または非文字列要素を含みます（1件以上の具体的なモノ/行動が必要）");
  }

  const experienceAnchorText = typeof candidate.experienceAnchor === "string" ? candidate.experienceAnchor : "";
  const scanText = `${candidate.title} ${experienceAnchorText}`;
  const banned = detectBannedCategories(scanText);
  if (banned.length > 0) {
    reasons.push(`禁止カテゴリに該当する可能性: ${banned.join(", ")}`);
  }

  if (looksAbstractTitle(candidate.title)) {
    reasons.push(`タイトルが抽象的な可能性があります（具体名詞ヒューリスティック未検出）: "${candidate.title}"`);
  }

  return { pass: reasons.length === 0, reasons };
}
