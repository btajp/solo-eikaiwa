import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { addDaysYmd, localYmd } from "./dates";
import { EXPLANATIONS_FILE, SENTENCES_FILE } from "./paths";
import { BANDS, type Band } from "./content-coverage";

export type Sentence = {
  no: number;
  category_no: number;
  category: string;
  domain: "daily" | "business" | "it";
  en: string;
  ja: string;
  note: string;
  /**
   * v0.26 content-ladder wave4: spoken function 例文の帯タグ（省略可・additive）。
   * 既存300文には無く、新規のspoken function例文にのみ付く。sentences300全体のラダー化は別論点
   * （設計doc §9）— この項目はメタデータとして持つのみで、選定ロジック（queue等）は一切参照しない。
   */
  band?: Band;
};

export type SrsState = { stage: number; due: string; reviews: number };
export type SentenceWithSrs = Sentence & { srs: SrsState | null };
export const GRADES = ["good", "soso", "bad"] as const;
export type Grade = (typeof GRADES)[number];

export type SentenceStore = {
  list(): SentenceWithSrs[];
  queue(newCount: number, today?: string): SentenceWithSrs[];
  grade(no: number, grade: Grade, today?: string): { no: number; stage: number; due: string } | null;
  /** 例文の詳しい解説キャッシュ。未生成は null */
  getExplanation(no: number): string | null;
  saveExplanation(no: number, text: string, today?: string): void;
  /** 解説生成の入力用。未知の no は undefined */
  find(no: number): Sentence | undefined;
};

/** 固定間隔ラダー（index = stage）。検証済みリサーチ: 均等〜長め固定で十分、拡張間隔に実証優位なし */
export const LADDER = [1, 3, 7, 14, 30, 60] as const;

/** stage×grade → 次の stage と due。例文・収集チャンク共通の SRS 遷移（LADDER 準拠） */
export function srsTransition(stage: number, grade: Grade, today: string): { stage: number; due: string } {
  if (grade === "good") {
    const s = Math.min(stage + 1, LADDER.length - 1);
    return { stage: s, due: addDaysYmd(today, LADDER[s]) };
  }
  if (grade === "soso") return { stage, due: addDaysYmd(today, 1) };
  return { stage: Math.max(stage - 1, 0), due: addDaysYmd(today, 1) };
}

const DOMAINS = ["daily", "business", "it"] as const;

function isValidSentence(x: unknown): x is Sentence {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.no === "number" &&
    typeof s.category_no === "number" &&
    typeof s.category === "string" &&
    (DOMAINS as readonly string[]).includes(s.domain as string) &&
    typeof s.en === "string" && s.en.length > 0 &&
    typeof s.ja === "string" &&
    typeof s.note === "string" &&
    // band は省略可。値がある場合のみ3値のいずれかを要求する（不正値は項目ごとスキップに倒す）。
    // 未知の追加フィールド（band以外）はここで検査しないため、そのまま許容される（将来の拡張耐性）。
    (s.band === undefined || (BANDS as readonly string[]).includes(s.band as string))
  );
}

/** 例文JSONを読み込む。ファイル欠落は throw（起動時に気づく）。不正項目は警告してスキップ */
export function loadSentences(file: string = SENTENCES_FILE): Sentence[] {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`sentences file is not an array: ${file}`);
  const valid = raw.filter(isValidSentence);
  if (valid.length !== raw.length) {
    console.warn(`[sentences] skipped ${raw.length - valid.length} invalid item(s) in ${file}`);
  }
  return valid;
}

type SrsRow = { no: number; stage: number; due: string; last_grade: string | null; reviews: number };

/** 同梱解説を読み込む（no→text）。欠落・不正はエラーにせず空で返す（都度生成にフォールバック） */
export function loadBundledExplanations(file: string = EXPLANATIONS_FILE): Map<number, string> {
  const map = new Map<number, string>();
  if (!existsSync(file)) return map;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(raw)) {
      for (const e of raw) {
        if (typeof e?.no === "number" && typeof e?.text === "string" && e.text.length > 0) {
          map.set(e.no, e.text);
        }
      }
    }
  } catch (err) {
    console.warn(`[sentences] bundled explanations unreadable, falling back to on-demand: ${String(err)}`);
  }
  return map;
}

export function ensureSentenceSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS sentence_srs (
    no INTEGER PRIMARY KEY,
    stage INTEGER NOT NULL DEFAULT 0,
    due TEXT NOT NULL,
    last_grade TEXT,
    reviews INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sentence_explanations (
    no INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    created TEXT NOT NULL
  )`);
}

export function makeSentenceStore(
  db: Database,
  sentences: Sentence[],
  bundledExplanations: Map<number, string> = loadBundledExplanations(),
): SentenceStore {
  const byNo = new Map(sentences.map((s) => [s.no, s]));

  function srsMap(): Map<number, SrsState> {
    const rows = db.query<SrsRow, []>("SELECT * FROM sentence_srs").all();
    return new Map(rows.map((r) => [r.no, { stage: r.stage, due: r.due, reviews: r.reviews }]));
  }

  return {
    list() {
      const srs = srsMap();
      return sentences.map((s) => ({ ...s, srs: srs.get(s.no) ?? null }));
    },

    queue(newCount, today = localYmd()) {
      const srs = srsMap();
      const reviews = sentences
        .filter((s) => { const st = srs.get(s.no); return st !== undefined && st.due <= today; })
        .sort((a, b) => {
          const da = srs.get(a.no)!.due, dbb = srs.get(b.no)!.due;
          return da < dbb ? -1 : da > dbb ? 1 : a.no - b.no;
        });
      const fresh = sentences
        .filter((s) => !srs.has(s.no))
        .sort((a, b) => a.no - b.no)
        .slice(0, newCount);
      return [...reviews, ...fresh].map((s) => ({ ...s, srs: srs.get(s.no) ?? null }));
    },

    grade(no, grade, today = localYmd()) {
      if (!byNo.has(no)) return null;
      const row = db.query<SrsRow, [number]>("SELECT * FROM sentence_srs WHERE no = ?").get(no);
      const t = srsTransition(row?.stage ?? 0, grade, today);
      db.run(
        `INSERT INTO sentence_srs (no, stage, due, last_grade, reviews) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(no) DO UPDATE SET stage = excluded.stage, due = excluded.due,
           last_grade = excluded.last_grade, reviews = sentence_srs.reviews + 1`,
        [no, t.stage, t.due, grade],
      );
      return { no, stage: t.stage, due: t.due };
    },

    getExplanation(no) {
      // 同梱 → SQLiteキャッシュ（カスタム例文の都度生成分） → null（ルートが生成）
      const bundled = bundledExplanations.get(no);
      if (bundled !== undefined) return bundled;
      const row = db.query<{ text: string }, [number]>(
        "SELECT text FROM sentence_explanations WHERE no = ?",
      ).get(no);
      return row?.text ?? null;
    },

    saveExplanation(no, text, today = localYmd()) {
      db.run(
        `INSERT INTO sentence_explanations (no, text, created) VALUES (?, ?, ?)
         ON CONFLICT(no) DO UPDATE SET text = excluded.text, created = excluded.created`,
        [no, text, today],
      );
    },

    find(no) {
      return byNo.get(no);
    },
  };
}
