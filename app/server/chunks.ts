import type { Database } from "bun:sqlite";
import { addDaysYmd, localYmd, srsTransition, type Grade, type SrsState } from "./sentences";

export type CollectSource = "ae" | "reflection";

export type CollectCandidate = {
  source: CollectSource;
  /** 学習者の元の発話（AE: quote / 振り返り: original） */
  promptText: string;
  /** 修正された自然な言い方（better） */
  en: string;
  /** 解説（AE: why_ja または issue。振り返り由来は空可） */
  note: string;
};

export type Chunk = {
  id: number;
  created: string;
  source: CollectSource;
  promptText: string;
  en: string;
  note: string;
  srs: SrsState;
};

export type ChunkStore = {
  /** 候補を dedup・日次上限つきで保存し、実際に入った件数を返す */
  collect(cands: CollectCandidate[], today?: string): number;
  list(): Chunk[];
  dueChunks(today?: string): Chunk[];
  grade(id: number, grade: Grade, today?: string): { id: number; stage: number; due: string } | null;
  remove(id: number): boolean;
};

/** 1日に自動収集する新規チャンクの上限。詰まりが多い日でも復習負債を暴発させない */
export const MAX_COLLECT_PER_DAY = 5;

/** dedup 用の正規化: 小文字化・文字/数字/空白以外を除去・空白圧縮 */
export function normalizeEn(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

type ChunkRow = {
  id: number; created: string; source: string; prompt_text: string;
  en: string; norm_en: string; note: string;
  stage: number; due: string; last_grade: string | null; reviews: number;
};

function toChunk(r: ChunkRow): Chunk {
  return {
    id: r.id, created: r.created, source: r.source as CollectSource,
    promptText: r.prompt_text, en: r.en, note: r.note,
    srs: { stage: r.stage, due: r.due, reviews: r.reviews },
  };
}

export function makeChunkStore(db: Database, sentenceEns: string[]): ChunkStore {
  const sentenceNorms = new Set(sentenceEns.map(normalizeEn));

  return {
    collect(cands, today = localYmd()) {
      const already = db.query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM collected_chunks WHERE created = ?",
      ).get(today)?.n ?? 0;
      let budget = MAX_COLLECT_PER_DAY - already;
      let inserted = 0;
      for (const c of cands) {
        if (budget <= 0) break;
        const promptText = c.promptText?.trim() ?? "";
        const en = c.en?.trim() ?? "";
        if (!promptText || !en || en.length > 200) continue;
        const norm = normalizeEn(en);
        if (!norm || sentenceNorms.has(norm)) continue;
        const dup = db.query<{ id: number }, [string]>(
          "SELECT id FROM collected_chunks WHERE norm_en = ?",
        ).get(norm);
        if (dup) continue;
        // 収集直後は答えを見た直後なので当日出題しない（due=翌日）
        db.run(
          `INSERT OR IGNORE INTO collected_chunks
             (created, source, prompt_text, en, norm_en, note, stage, due, reviews)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)`,
          [today, c.source, promptText, en, norm, c.note?.trim() ?? "", addDaysYmd(today, 1)],
        );
        inserted++;
        budget--;
      }
      return inserted;
    },

    list() {
      return db.query<ChunkRow, []>("SELECT * FROM collected_chunks ORDER BY id DESC").all().map(toChunk);
    },

    dueChunks(today = localYmd()) {
      return db
        .query<ChunkRow, [string]>("SELECT * FROM collected_chunks WHERE due <= ? ORDER BY due ASC, id ASC")
        .all(today)
        .map(toChunk);
    },

    grade(id, grade, today = localYmd()) {
      const row = db.query<ChunkRow, [number]>("SELECT * FROM collected_chunks WHERE id = ?").get(id);
      if (!row) return null;
      const t = srsTransition(row.stage, grade, today);
      db.run(
        "UPDATE collected_chunks SET stage = ?, due = ?, last_grade = ?, reviews = reviews + 1 WHERE id = ?",
        [t.stage, t.due, grade, id],
      );
      return { id, stage: t.stage, due: t.due };
    },

    remove(id) {
      const exists = db.query<{ id: number }, [number]>("SELECT id FROM collected_chunks WHERE id = ?").get(id);
      if (!exists) return false;
      db.run("DELETE FROM collected_chunks WHERE id = ?", [id]);
      return true;
    },
  };
}
