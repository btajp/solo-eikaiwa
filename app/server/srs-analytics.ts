import type { Database } from "bun:sqlite";
import type { Sentence } from "./sentences";

export type CategoryRate = { categoryNo: number; category: string; reviewed: number; badRate: number };

/** カテゴリ別の bad率（現在の last_grade スナップショット・reviewed>0 の文のみ）。bad率降順・同率は reviewed 降順 */
export function categoryBadRates(db: Database, sentences: Sentence[]): CategoryRate[] {
  const rows = db
    .query<{ no: number; last_grade: string | null }, []>(
      "SELECT no, last_grade FROM sentence_srs WHERE reviews > 0")
    .all();
  const byNo = new Map(sentences.map((s) => [s.no, s]));
  const agg = new Map<number, { category: string; reviewed: number; bad: number }>();
  for (const r of rows) {
    const s = byNo.get(r.no);
    if (!s) continue;
    const a = agg.get(s.category_no) ?? { category: s.category, reviewed: 0, bad: 0 };
    a.reviewed++;
    if (r.last_grade === "bad") a.bad++;
    agg.set(s.category_no, a);
  }
  return [...agg.entries()]
    .map(([categoryNo, a]) => ({
      categoryNo,
      category: a.category,
      reviewed: a.reviewed,
      badRate: Math.round((a.bad / a.reviewed) * 1000) / 1000,
    }))
    .sort((x, y) => y.badRate - x.badRate || y.reviewed - x.reviewed);
}

/**
 * 苦手カテゴリのワースト選定（content-gen の生成対象選定と assessment の月次レポートが共用）。評価5文以上・bad率>0 のうち bad率降順（同率は reviewed降順）でワースト3。
 * categoryBadRates() は既にこの順で返すが、入力順序に依存しないようここでも明示的にソートする。
 */
export function pickWorstCategories(rates: CategoryRate[], minReviewed = 5, top = 3): CategoryRate[] {
  return rates
    .filter((r) => r.reviewed >= minReviewed && r.badRate > 0)
    .sort((a, b) => b.badRate - a.badRate || b.reviewed - a.reviewed)
    .slice(0, top);
}
