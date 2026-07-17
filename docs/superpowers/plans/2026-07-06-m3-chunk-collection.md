# M3: 詰まった表現の自動チャンク収集と SRS 統合 実装計画

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 4/3/2 の AE フィードバックと振り返りが指摘した「学習者が詰まった表現」を自動でチャンク（元発話＋修正版＋解説）として収集し、暗記例文300 と同じ SRS 練習キューに統合する。

**Architecture:** 収集源は既存のAI出力（AeFeedback.items / Reflection.fixes）の再利用のみで、追加の Claude 呼び出しはしない。チャンクは SQLite の `collected_chunks` テーブル（SRS列インライン）に保存し、SRS遷移ロジックは sentences.ts から `srsTransition` として抽出して両者で共通利用する。収集はルートハンドラ成功後のベストエフォート（失敗しても学習フローを止めない）。クライアントは練習キューの discriminated union（sentence / chunk）で分岐する。

**Tech Stack:** Bun + TypeScript / bun:sqlite / React + Vite（クライアント）

## Global Constraints

- 追加のみ: 既存239テストと HTTP 契約の**既存フィールド**は不変（フィールド追加・新エンドポイントのみ許可）
- SRS遷移ロジックは sentences.ts と共通（`srsTransition` を export して再利用 — 重複実装禁止）
- 収集はベストエフォート: collect の失敗で AE フィードバック・振り返りのレスポンスを失敗させない（既存の XP 付与 swallow パターンと同じ）
- 日付はサーバのローカル日付（`localYmd` / `addDaysYmd` を再利用。`toISOString` による UTC 日付は使わない）
- 情報的フィードバックのみ（喪失を煽る演出・文言は追加しない）
- コミットは Conventional Commits（日本語）
- ゲート: `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build`
- 例文コンテンツ（en/ja/note）は i18n 翻訳対象外。UI 文言は EN/JA 両方
- 1日の自動収集上限は 5 件。dedup は正規化した en で既存チャンク・既存 sentences300 の両方に対して行う

## Interfaces（タスク間契約）

- Task 1 produces（Task 2 が消費）:
  - `app/server/sentences.ts`: `export function srsTransition(stage: number, grade: Grade, today: string): { stage: number; due: string }`
  - `app/server/chunks.ts`: `export type CollectSource = "ae" | "reflection"` / `export type CollectCandidate = { source: CollectSource; promptText: string; en: string; note: string }` / `export type Chunk = { id: number; created: string; source: CollectSource; promptText: string; en: string; note: string; srs: SrsState }` / `export type ChunkStore = { collect(cands: CollectCandidate[], today?: string): number; list(): Chunk[]; dueChunks(today?: string): Chunk[]; grade(id: number, grade: Grade, today?: string): { id: number; stage: number; due: string } | null; remove(id: number): boolean }` / `export function makeChunkStore(db: Database, sentenceEns: string[]): ChunkStore` / `export const MAX_COLLECT_PER_DAY = 5` / `export function normalizeEn(s: string): string`
- Task 2 produces（Task 3 が消費）:
  - `GET /api/sentences/queue` → `{ queue: Array<({kind:"sentence"} & 既存sentence項目) | {kind:"chunk", id, promptText, en, note, srs}> }`（チャンクが先頭）
  - `POST /api/feedback/ae` / `POST /api/coach/reflection` のレスポンスに additive フィールド `collectedChunks: number`
  - `GET /api/chunks` → `{ chunks: Chunk[] }` / `POST /api/chunks/grade {id, grade}` → `{id, stage, due}` / `DELETE /api/chunks/:id` → `{ok:true}` or 404

---

### Task 1: サーバ — chunk ストアと SRS 遷移の共通化

**Files:**
- Modify: `app/server/sentences.ts`（`srsTransition` 抽出。挙動不変のリファクタ）
- Modify: `app/server/db.ts`（`collected_chunks` テーブル追加）
- Create: `app/server/chunks.ts`
- Test: `app/server/__tests__/chunks.test.ts`

**Interfaces:**
- Consumes: `sentences.ts` の `LADDER` / `localYmd` / `addDaysYmd` / `Grade` / `SrsState`
- Produces: 上記 Interfaces 節の Task 1 分（Task 2 が RouteDeps 経由で使う）

- [ ] **Step 1: sentences.ts に srsTransition を抽出（挙動不変）**

`app/server/sentences.ts` の `LADDER` 定義の直後（`localYmd` の前）に追加:

```ts
/** stage×grade → 次の stage と due。例文・収集チャンク共通の SRS 遷移（LADDER 準拠） */
export function srsTransition(stage: number, grade: Grade, today: string): { stage: number; due: string } {
  if (grade === "good") {
    const s = Math.min(stage + 1, LADDER.length - 1);
    return { stage: s, due: addDaysYmd(today, LADDER[s]) };
  }
  if (grade === "soso") return { stage, due: addDaysYmd(today, 1) };
  return { stage: Math.max(stage - 1, 0), due: addDaysYmd(today, 1) };
}
```

注意: `addDaysYmd` は現在 `srsTransition` 挿入位置より後ろで定義されているため、`localYmd` / `addDaysYmd` の2関数を `LADDER` より**前**に移動してから `srsTransition` を `LADDER` の直後に置く（hoisting に頼らない配置にする。関数宣言なので動作上はどちらでも良いが、読み順を保つ）。

`makeSentenceStore` の `grade()` 本体を次で置き換える（if/else の遷移計算を共通関数に委譲。INSERT 文はそのまま）:

```ts
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
```

- [ ] **Step 2: リファクタが挙動不変なことを既存テストで確認**

Run: `cd app && bun test __tests__/sentences.test.ts`
Expected: 既存の sentences テスト全 PASS（期待値変更なし）

- [ ] **Step 3: db.ts に collected_chunks テーブルを追加**

`app/server/db.ts` の `openDb()` 内、`placement_results` の `db.run` の直後に追加:

```ts
  db.run(`CREATE TABLE IF NOT EXISTS collected_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created TEXT NOT NULL,
    source TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    en TEXT NOT NULL,
    norm_en TEXT NOT NULL UNIQUE,
    note TEXT NOT NULL DEFAULT '',
    stage INTEGER NOT NULL DEFAULT 0,
    due TEXT NOT NULL,
    last_grade TEXT,
    reviews INTEGER NOT NULL DEFAULT 0
  )`);
```

- [ ] **Step 4: chunks.test.ts を書く（RED）**

Create `app/server/__tests__/chunks.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import { LADDER } from "../sentences";
import { MAX_COLLECT_PER_DAY, makeChunkStore, normalizeEn, type CollectCandidate } from "../chunks";

const TODAY = "2026-07-06";

function store(sentenceEns: string[] = []) {
  return makeChunkStore(openDb(":memory:"), sentenceEns);
}

function cand(over: Partial<CollectCandidate> = {}): CollectCandidate {
  return { source: "ae", promptText: "I go office yesterday", en: "I went to the office yesterday", note: "過去形", ...over };
}

describe("chunks: normalizeEn", () => {
  test("小文字化・記号除去・空白圧縮", () => {
    expect(normalizeEn("I went to the office, yesterday!")).toBe("i went to the office yesterday");
    expect(normalizeEn("  Don't   worry.  ")).toBe("dont worry");
  });
});

describe("chunks: collect", () => {
  test("保存: stage0・due=翌日・入った件数を返す", () => {
    const s = store();
    expect(s.collect([cand()], TODAY)).toBe(1);
    const all = s.list();
    expect(all).toHaveLength(1);
    expect(all[0].en).toBe("I went to the office yesterday");
    expect(all[0].promptText).toBe("I go office yesterday");
    expect(all[0].note).toBe("過去形");
    expect(all[0].source).toBe("ae");
    expect(all[0].srs).toEqual({ stage: 0, due: "2026-07-07", reviews: 0 });
  });

  test("promptText か en が空の候補はスキップ", () => {
    const s = store();
    expect(s.collect([cand({ promptText: "  " }), cand({ en: "" })], TODAY)).toBe(0);
    expect(s.list()).toHaveLength(0);
  });

  test("既存チャンクと正規化enが同じならスキップ（大文字小文字・記号差は同一視）", () => {
    const s = store();
    expect(s.collect([cand()], TODAY)).toBe(1);
    expect(s.collect([cand({ en: "I went to the office, YESTERDAY!" })], TODAY)).toBe(0);
    expect(s.list()).toHaveLength(1);
  });

  test("sentences300 の en と一致するものはスキップ", () => {
    const s = store(["I went to the office yesterday."]);
    expect(s.collect([cand()], TODAY)).toBe(0);
  });

  test("1日の上限は5件（超過分はスキップ・同日2回目も残枠のみ）", () => {
    const s = store();
    const seven = Array.from({ length: 7 }, (_, i) => cand({ en: `Unique sentence number ${i} here` }));
    expect(s.collect(seven, TODAY)).toBe(MAX_COLLECT_PER_DAY);
    expect(s.collect([cand({ en: "One more different sentence" })], TODAY)).toBe(0);
    // 翌日は枠が回復する
    expect(s.collect([cand({ en: "One more different sentence" })], "2026-07-07")).toBe(1);
    expect(s.list()).toHaveLength(6);
  });

  test("200文字を超える en はスキップ", () => {
    const s = store();
    expect(s.collect([cand({ en: "a".repeat(201) })], TODAY)).toBe(0);
  });
});

describe("chunks: grade（sentences と同じ LADDER 遷移）", () => {
  test("good で stage 上昇・LADDER 間隔、bad で後退・翌日", () => {
    const s = store();
    s.collect([cand()], TODAY);
    const id = s.list()[0].id;
    const g1 = s.grade(id, "good", TODAY)!;
    expect(g1.stage).toBe(1);
    expect(g1.due).toBe("2026-07-09"); // TODAY + LADDER[1]=3
    const g2 = s.grade(id, "soso", TODAY)!;
    expect(g2.stage).toBe(1);
    expect(g2.due).toBe("2026-07-07");
    const g3 = s.grade(id, "bad", TODAY)!;
    expect(g3.stage).toBe(0);
    expect(g3.due).toBe("2026-07-07");
    expect(s.list()[0].srs.reviews).toBe(3);
    expect(LADDER[1]).toBe(3); // 前提の明示
  });

  test("未知の id は null", () => {
    expect(store().grade(999, "good", TODAY)).toBeNull();
  });
});

describe("chunks: dueChunks / remove", () => {
  test("dueChunks は due<=today のみ・due昇順", () => {
    const s = store();
    s.collect([cand({ en: "First unique sentence" }), cand({ en: "Second unique sentence" })], TODAY);
    // 収集直後（当日）はまだ出題しない
    expect(s.dueChunks(TODAY)).toHaveLength(0);
    expect(s.dueChunks("2026-07-07")).toHaveLength(2);
    // 片方を good にすると due が先送りされる
    const [a] = s.list();
    s.grade(a.id, "good", "2026-07-07");
    const due = s.dueChunks("2026-07-08");
    expect(due).toHaveLength(1);
    expect(due[0].id).not.toBe(a.id);
  });

  test("remove は存在すれば true・行が消える、無ければ false", () => {
    const s = store();
    s.collect([cand()], TODAY);
    const id = s.list()[0].id;
    expect(s.remove(id)).toBe(true);
    expect(s.list()).toHaveLength(0);
    expect(s.remove(id)).toBe(false);
  });
});
```

- [ ] **Step 5: RED を確認**

Run: `cd app && bun test __tests__/chunks.test.ts`
Expected: FAIL（`../chunks` が存在しない）

- [ ] **Step 6: chunks.ts を実装**

Create `app/server/chunks.ts`:

```ts
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
```

- [ ] **Step 7: GREEN と全ゲート**

Run: `cd app && bun test`
Expected: 全 PASS（239 + 新規12前後）
Run: `cd app && bun run typecheck`
Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add app/server/sentences.ts app/server/db.ts app/server/chunks.ts app/server/__tests__/chunks.test.ts
git commit -m "feat: 詰まった表現のチャンクストアとSRS遷移の共通化を追加"
```

---

### Task 2: サーバ — 収集フック・queue 統合・chunks API

**Files:**
- Modify: `app/server/routes.ts`
- Modify: `app/server/index.ts`
- Test: `app/server/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: Task 1 の `ChunkStore` / `CollectCandidate` / `Chunk`
- Produces: Interfaces 節の Task 2 分（Task 3 のクライアントが叩く）

- [ ] **Step 1: routes.test.ts の makeTestDeps に chunkStore を追加し、影響する既存アサーションを更新（RED準備）**

`makeTestDeps` の `sentenceStore: {...}` の直後に追加:

```ts
    chunkStore: {
      collect: (_c) => 0,
      list: () => [],
      dueChunks: () => [],
      grade: (id, _g) => (id === 1 ? { id: 1, stage: 1, due: "2026-07-09" } : null),
      remove: (id) => id === 1,
    } as RouteDeps["chunkStore"],
```

既存アサーションの更新（2箇所。実行して落ちたテストがこの2種であることを確認しながら直す）:
1. `POST /api/feedback/ae` のレスポンス期待値: `FAKE_AE` の deep-equal は `{ ...FAKE_AE, collectedChunks: 0 }` に変更
2. `POST /api/coach/reflection` のレスポンス期待値: `{ ...FAKE_REFLECTION, collectedChunks: 0 }` に変更
3. `GET /api/sentences/queue` の期待値: `[FAKE_SENTENCE]` → `[{ kind: "sentence", ...FAKE_SENTENCE }]` に変更

- [ ] **Step 2: 新規契約テストを追加（RED）**

`routes.test.ts` 末尾に追加:

```ts
describe("chunks: 収集フックと API", () => {
  test("AEフィードバック成功時に quote/better 非空の item だけが collect に渡り、件数がレスポンスに載る", async () => {
    const got: unknown[] = [];
    const { deps } = makeTestDeps({
      aeFeedback: async () => ({
        items: [
          { quote: "I go office", issue: "tense", better: "I went to the office", why_ja: "過去形にします" },
          { quote: "", issue: "feedback", better: "", why_ja: "fallback item" },
        ],
        praise: "Nice!",
      }),
      chunkStore: {
        collect: (c: unknown[]) => { got.push(...c); return 1; },
        list: () => [], dueChunks: () => [],
        grade: () => null, remove: () => false,
      } as RouteDeps["chunkStore"],
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/feedback/ae", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "I go office", topicTitle: "t" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { collectedChunks: number };
    expect(body.collectedChunks).toBe(1);
    expect(got).toEqual([
      { source: "ae", promptText: "I go office", en: "I went to the office", note: "過去形にします" },
    ]);
  });

  test("collect が throw しても AE フィードバックは 200 で返り collectedChunks は 0", async () => {
    const { deps } = makeTestDeps({
      chunkStore: {
        collect: () => { throw new Error("db boom"); },
        list: () => [], dueChunks: () => [], grade: () => null, remove: () => false,
      } as RouteDeps["chunkStore"],
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/feedback/ae", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "hello" }),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { collectedChunks: number }).collectedChunks).toBe(0);
  });

  test("振り返りの fixes からも収集され collectedChunks が載る", async () => {
    const got: unknown[] = [];
    const { deps } = makeTestDeps({
      reflection: async () => ({
        goodPhrases: [],
        fixes: [{ original: "he go", better: "he goes" }, { original: "", better: "x" }],
        noteForTomorrow_ja: "メモ",
      }),
      chunkStore: {
        collect: (c: unknown[]) => { got.push(...c); return 1; },
        list: () => [], dueChunks: () => [], grade: () => null, remove: () => false,
      } as RouteDeps["chunkStore"],
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/coach/reflection", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { collectedChunks: number }).collectedChunks).toBe(1);
    expect(got).toEqual([{ source: "reflection", promptText: "he go", en: "he goes", note: "" }]);
  });

  test("queue: 期限到来チャンクが復習例文より先頭に kind 付きで混ざる", async () => {
    const { deps } = makeTestDeps({
      chunkStore: {
        collect: () => 0, grade: () => null, remove: () => false, list: () => [],
        dueChunks: () => [{
          id: 3, created: "2026-07-05", source: "ae" as const,
          promptText: "I go office", en: "I went to the office", note: "過去形",
          srs: { stage: 0, due: "2026-07-06", reviews: 0 },
        }],
      } as RouteDeps["chunkStore"],
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/sentences/queue?new=1"));
    const body = await res.json() as { queue: Array<{ kind: string }> };
    expect(body.queue[0]).toEqual({
      kind: "chunk", id: 3, promptText: "I go office", en: "I went to the office", note: "過去形",
      srs: { stage: 0, due: "2026-07-06", reviews: 0 },
    });
    expect(body.queue[1]).toEqual({ kind: "sentence", ...FAKE_SENTENCE });
  });

  test("queue: dueChunks が throw しても例文キューだけで 200", async () => {
    const { deps } = makeTestDeps({
      chunkStore: {
        collect: () => 0, list: () => [], grade: () => null, remove: () => false,
        dueChunks: () => { throw new Error("boom"); },
      } as RouteDeps["chunkStore"],
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/sentences/queue?new=1"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { queue: unknown[] }).queue).toEqual([{ kind: "sentence", ...FAKE_SENTENCE }]);
  });

  test("GET /api/chunks は一覧を返す", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(new Request("http://x/api/chunks"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chunks: [] });
  });

  test("POST /api/chunks/grade: 正常時は遷移を返し srs-grade XP が付与される", async () => {
    const xp: Array<{ kind: string; amount: number }> = [];
    const { deps } = makeTestDeps();
    const base = deps.progressStore;
    deps.progressStore = {
      ...base,
      addXp: (kind, amount, meta) => { xp.push({ kind: kind as string, amount }); return base.addXp(kind, amount, meta); },
    } as RouteDeps["progressStore"];
    const res = await makeFetchHandler(deps)(new Request("http://x/api/chunks/grade", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, grade: "good" }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, stage: 1, due: "2026-07-09" });
    expect(xp).toEqual([{ kind: "srs-grade", amount: 2 }]);
  });

  test("POST /api/chunks/grade: 未知idは400・不正gradeは400", async () => {
    const { deps } = makeTestDeps();
    const h = makeFetchHandler(deps);
    const r1 = await h(new Request("http://x/api/chunks/grade", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 999, grade: "good" }),
    }));
    expect(r1.status).toBe(400);
    const r2 = await h(new Request("http://x/api/chunks/grade", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, grade: "great" }),
    }));
    expect(r2.status).toBe(400);
  });

  test("DELETE /api/chunks/:id: 成功は ok、未知は404、非整数は400", async () => {
    const { deps } = makeTestDeps();
    const h = makeFetchHandler(deps);
    expect((await h(new Request("http://x/api/chunks/1", { method: "DELETE" }))).status).toBe(200);
    expect((await h(new Request("http://x/api/chunks/999", { method: "DELETE" }))).status).toBe(404);
    expect((await h(new Request("http://x/api/chunks/abc", { method: "DELETE" }))).status).toBe(400);
  });
});
```

Run: `cd app && bun test __tests__/routes.test.ts`
Expected: FAIL（chunkStore が RouteDeps に無い / ルート未実装）

- [ ] **Step 3: routes.ts を実装**

(a) import に追加:

```ts
import type { Chunk, ChunkStore, CollectCandidate } from "./chunks";
```

(b) `RouteDeps` の `evaluatePlacement` の直後に必須フィールドを追加:

```ts
  /** 詰まった表現の収集チャンク（実体は chunks.ts、テストはフェイク） */
  chunkStore: ChunkStore;
```

(c) `handleAeFeedback` を置き換え:

```ts
async function handleAeFeedback(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ transcript?: string; topicTitle?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const { transcript, topicTitle } = parsed.body;
  if (!transcript?.trim()) return json({ error: "transcript is required" }, 400);
  const fb = await deps.aeFeedback({ transcript, topicTitle: topicTitle ?? "" });
  const cands: CollectCandidate[] = fb.items
    .filter((i) => i.quote?.trim() && i.better?.trim())
    .map((i) => ({ source: "ae" as const, promptText: i.quote, en: i.better, note: i.why_ja?.trim() || i.issue || "" }));
  return json({ ...fb, collectedChunks: collectBestEffort(deps, cands) });
}
```

(d) 振り返りハンドラをインライン呼び出しから関数に昇格。route テーブルの
`if (req.method === "POST" && url.pathname === "/api/coach/reflection") return json(await deps.reflection());`
を `return await handleReflection(deps);` に変更し、次を追加:

```ts
/** 収集はベストエフォート — 失敗しても親レスポンスを失敗させない（XP付与と同じ方針） */
function collectBestEffort(deps: RouteDeps, cands: CollectCandidate[]): number {
  try {
    return deps.chunkStore.collect(cands);
  } catch (err) {
    console.warn("[chunks] collect failed, continuing:", String(err));
    return 0;
  }
}

async function handleReflection(deps: RouteDeps): Promise<Response> {
  const refl = await deps.reflection();
  const cands: CollectCandidate[] = refl.fixes
    .filter((f) => f.original?.trim() && f.better?.trim())
    .map((f) => ({ source: "reflection" as const, promptText: f.original, en: f.better, note: "" }));
  return json({ ...refl, collectedChunks: collectBestEffort(deps, cands) });
}
```

(e) `handleSentenceQueue` を置き換え（エラーメッセージ文字列は既存のまま維持）:

```ts
function handleSentenceQueue(url: URL, deps: RouteDeps): Response {
  const raw = url.searchParams.get("new") ?? "10";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 50) {
    return json({ error: "new must be an integer between 0 and 50" }, 400);
  }
  const sentences = deps.sentenceStore.queue(n).map((s) => ({ kind: "sentence" as const, ...s }));
  // 期限到来チャンクは復習例文より先頭。読み取り失敗時は例文キューだけで継続
  let chunks: Array<{ kind: "chunk" } & Omit<Chunk, "created" | "source">> = [];
  try {
    chunks = deps.chunkStore.dueChunks().map((c) => ({
      kind: "chunk" as const, id: c.id, promptText: c.promptText, en: c.en, note: c.note, srs: c.srs,
    }));
  } catch (err) {
    console.warn("[chunks] dueChunks failed, continuing with sentences only:", String(err));
  }
  return json({ queue: [...chunks, ...sentences] });
}
```

(f) chunk grade / delete ハンドラを追加（`handleSentenceGrade` の直後）:

```ts
async function handleChunkGrade(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ id?: unknown; grade?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { id, grade } = parsed.body;
  if (typeof id !== "number" || !Number.isInteger(id)) return json({ error: "id must be an integer" }, 400);
  if (!(GRADES as readonly string[]).includes(grade as string)) {
    return json({ error: `grade must be one of: ${GRADES.join(", ")}` }, 400);
  }
  const r = deps.chunkStore.grade(id, grade as Grade);
  if (!r) return json({ error: `unknown chunk id: ${id}` }, 400);
  // 例文と同じ努力XP（good=2 / soso=1 / bad=1）。付与失敗で採点は失敗させない
  try {
    deps.progressStore.addXp("srs-grade", grade === "good" ? 2 : 1, { chunkId: id });
  } catch (err) {
    console.warn("[progress] srs-grade xp (chunk) failed, continuing:", String(err));
  }
  return json(r);
}

function handleChunkDelete(url: URL, deps: RouteDeps): Response {
  const seg = url.pathname.slice("/api/chunks/".length);
  const id = Number(seg);
  if (!/^\d+$/.test(seg) || !Number.isInteger(id)) return json({ error: "id must be a positive integer" }, 400);
  return deps.chunkStore.remove(id) ? json({ ok: true }) : json({ error: `unknown chunk id: ${id}` }, 404);
}
```

(g) route テーブル（`/api/sentences/grade` の行の直後）に追加:

```ts
      if (req.method === "GET" && url.pathname === "/api/chunks") return json({ chunks: deps.chunkStore.list() });
      if (req.method === "POST" && url.pathname === "/api/chunks/grade") return await handleChunkGrade(req, deps);
      if (req.method === "DELETE" && url.pathname.startsWith("/api/chunks/")) return handleChunkDelete(url, deps);
```

- [ ] **Step 4: index.ts を配線**

`app/server/index.ts` の `const sentenceStore = makeSentenceStore(db, loadSentences());` を次に変更し、deps に `chunkStore` を追加:

```ts
const sentences = loadSentences();
const sentenceStore = makeSentenceStore(db, sentences);
const chunkStore = makeChunkStore(db, sentences.map((s) => s.en));
```

import に `makeChunkStore`（`./chunks`）を追加し、`makeFetchHandler` に渡す deps オブジェクトへ `chunkStore,` を追加する。

- [ ] **Step 5: GREEN と全ゲート**

Run: `cd app && bun test`
Expected: 全 PASS
Run: `cd app && bun run typecheck`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add app/server/routes.ts app/server/index.ts app/server/__tests__/routes.test.ts
git commit -m "feat: AE・振り返りからのチャンク自動収集とchunks APIを追加"
```

---

### Task 3: クライアント — チャンクカードと My chunks

**Files:**
- Modify: `app/client/src/api.ts`
- Modify: `app/client/src/i18n.ts`
- Modify: `app/client/src/screens/SentencesScreen.tsx`

**Interfaces:**
- Consumes: Task 2 の queue union / `GET /api/chunks` / `POST /api/chunks/grade` / `DELETE /api/chunks/:id`、Task 1 とは間接（cloze シードオフセット +100000 の約束のみ）
- Produces: なし（末端）

**変えてはいけない箇所:** App.tsx は一切触らない。PracticeTab の alive-guard / stopPlayback / busy ガードの構造は維持。

- [ ] **Step 1: api.ts に型とヘルパを追加**

`SentenceItem` 定義の直後に追加し、`fetchSentenceQueue` の戻り値型を差し替える:

```ts
export type ChunkSrs = SentenceSrs;
export type ChunkQueueItem = {
  kind: "chunk";
  id: number;
  promptText: string;
  en: string;
  note: string;
  srs: ChunkSrs;
};
export type SentenceQueueItem = SentenceItem & { kind: "sentence" };
export type QueueItem = SentenceQueueItem | ChunkQueueItem;

export type ChunkListItem = {
  id: number; created: string; source: "ae" | "reflection";
  promptText: string; en: string; note: string; srs: ChunkSrs;
};

export async function fetchChunks(): Promise<ChunkListItem[]> {
  const res = await fetch("/api/chunks");
  if (!res.ok) throw new Error(`chunks failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { chunks: ChunkListItem[] }).chunks;
}

export async function gradeChunk(id: number, grade: "good" | "soso" | "bad"): Promise<{ id: number; stage: number; due: string }> {
  const res = await fetch("/api/chunks/grade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, grade }),
  });
  if (!res.ok) throw new Error(`grade failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function deleteChunk(id: number): Promise<void> {
  const res = await fetch(`/api/chunks/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${await extractErrorMessage(res)}`);
}
```

`fetchSentenceQueue` の変更:

```ts
export async function fetchSentenceQueue(newCount = 10): Promise<QueueItem[]> {
  const res = await fetch(`/api/sentences/queue?new=${newCount}`);
  if (!res.ok) throw new Error(`queue failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { queue: QueueItem[] }).queue;
}
```

- [ ] **Step 2: i18n.ts に文言を追加**

`Strings.sentences` 型に追加:

```ts
    chunkLabel: string;
    chunkSayIt: string;
    myChunks: string;
    deleteConfirm: string;
    deleteAria: (id: number) => string;
    playChunkAria: (id: number) => string;
```

`en.sentences` に追加:

```ts
      chunkLabel: "Your phrase",
      chunkSayIt: "↑ Say a more natural version out loud",
      myChunks: "My chunks — collected from your sessions",
      deleteConfirm: "Delete?",
      deleteAria: (id) => `Delete chunk ${id}`,
      playChunkAria: (id) => `Play chunk ${id}`,
```

`ja.sentences` に追加:

```ts
      chunkLabel: "あなたの表現",
      chunkSayIt: "↑ より自然な言い方を声に出してみましょう",
      myChunks: "マイチャンク — セッションから自動収集",
      deleteConfirm: "削除する?",
      deleteAria: (id) => `チャンク${id}を削除`,
      playChunkAria: (id) => `チャンク${id}を再生`,
```

- [ ] **Step 3: PracticeTab をチャンク対応に**

`SentencesScreen.tsx` の import を更新:

```ts
import {
  deleteChunk, fetchChunks, fetchSentenceQueue, fetchSentences, gradeChunk, gradeSentence, playTtsCached,
  type ChunkListItem, type QueueItem, type SentenceItem,
} from "../api";
```

PracticeTab 内の変更点（全て queue の型が `QueueItem[]` になることに伴う分岐）:

```ts
  const [queue, setQueue] = useState<QueueItem[]>([]);
```

`grade` 関数を置き換え:

```ts
  async function grade(g: "good" | "soso" | "bad") {
    setBusy(true);
    setErrorMsg("");
    try {
      if (current.kind === "chunk") await gradeChunk(current.id, g);
      else await gradeSentence(current.no, g);
      if (!aliveRef.current) return;
      stopPlayback();
      setGradedCount((n) => n + 1);
      setIdx((i) => i + 1);
      setPhase("prompt");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }
```

カード描画部（`<Card>` 直下）を置き換え:

```tsx
      <Card>
        {current.kind === "chunk" ? (
          <>
            <p className="text-sm text-muted">{t.chunkLabel}</p>
            <p className="sentence-ja">{current.promptText}</p>
          </>
        ) : (
          <p className="sentence-ja">{current.ja}</p>
        )}
        {!hideNote && current.note && <p className="text-sm text-muted">{current.note}</p>}
        {phase === "prompt" && (
          <>
            <p className="text-muted">{current.kind === "chunk" ? t.chunkSayIt : t.sayItFirst}</p>
            <div className="round-actions">
              <Button variant="secondary" onClick={() => setPhase("cloze")}>{t.showCloze}</Button>
              <Button variant="primary" size="lg" onClick={reveal}>{t.showAnswer}</Button>
            </div>
          </>
        )}
        {phase === "cloze" && (
          <>
            <p className="sentence-cloze">
              {clozeText(current.en, current.kind === "chunk" ? current.id + 100000 : current.no)}
            </p>
            <p className="text-muted">{t.clozeHint}</p>
            <div className="round-actions">
              <Button variant="primary" size="lg" onClick={reveal}>{t.showAnswer}</Button>
            </div>
          </>
        )}
        {phase === "answer" && (
          <>
            <p className="sentence-en">{current.en}</p>
            <div className="round-actions">
              <Button variant="ghost" onClick={() => playTtsCached(current.en).catch(() => {})} ariaLabel={t.playAgain}>
                {t.playAgain}
              </Button>
            </div>
            <div className="grade-row">
              <Button onClick={() => grade("good")} disabled={busy}>{t.gradeGood}</Button>
              <Button onClick={() => grade("soso")} disabled={busy}>{t.gradeSoso}</Button>
              <Button onClick={() => grade("bad")} disabled={busy}>{t.gradeBad}</Button>
            </div>
          </>
        )}
        {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
      </Card>
```

補足: 既存の `reveal()` / 完了画面 / dueTomorrow 計算（例文のみ対象）は無変更。cloze のシードオフセット `+100000` は sentences の no（1..300）と衝突しない約束値。

- [ ] **Step 4: BrowseTab に My chunks セクションを追加**

BrowseTab に state を追加:

```ts
  const [chunks, setChunks] = useState<ChunkListItem[]>([]);
  const [playingChunkId, setPlayingChunkId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
```

`load()` 内の `setItems(all);` の直後に追加（チャンク取得失敗で一覧は壊さない）:

```ts
      try {
        const cs = await fetchChunks();
        if (!aliveRef.current) return;
        setChunks(cs);
      } catch {
        // チャンクは補助セクション — 取得失敗でも例文一覧は表示する
      }
```

再生・削除ハンドラを追加（`play` の直後）:

```ts
  async function playChunk(c: ChunkListItem) {
    setPlayingChunkId(c.id);
    try {
      await playTtsCached(c.en);
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setPlayingChunkId(null);
    }
  }

  /** 削除は2タップ式: 1タップ目でボタンが「削除する?」に変わり、2タップ目で確定 */
  async function onDeleteChunk(id: number) {
    if (deletingId !== id) {
      setDeletingId(id);
      return;
    }
    try {
      await deleteChunk(id);
      if (!aliveRef.current) return;
      setChunks((cs) => cs.filter((c) => c.id !== id));
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setDeletingId(null);
    }
  }
```

JSX: `{errorMsg && <Banner kind="error">{errorMsg}</Banner>}` の直後・カテゴリ `<Card>` 群の前に追加（0件なら非表示）:

```tsx
      {chunks.length > 0 && (
        <Card header={t.myChunks}>
          {chunks.map((c) => (
            <div key={c.id} className="sentence-row">
              <Button
                variant="ghost"
                onClick={() => playChunk(c)}
                disabled={playingNo !== null || playingChunkId !== null}
                ariaLabel={t.playChunkAria(c.id)}
              >
                {playingChunkId === c.id ? "🔊" : "▶"}
              </Button>
              <div className="sentence-body">
                <span className="sentence-en">{c.en}</span>
                <span className="sentence-ja-sub">{c.promptText}</span>
                {c.note && <span className="text-sm text-muted">{c.note}</span>}
              </div>
              <span className="sentence-srs text-sm text-muted">{`st${c.srs.stage} ・ ${c.srs.due.slice(5)}`}</span>
              <Button variant={deletingId === c.id ? "danger" : "ghost"} onClick={() => onDeleteChunk(c.id)} ariaLabel={t.deleteAria(c.id)}>
                {deletingId === c.id ? t.deleteConfirm : "🗑"}
              </Button>
            </div>
          ))}
        </Card>
      )}
```

既存の例文再生ボタンの `disabled={playingNo !== null}` も `disabled={playingNo !== null || playingChunkId !== null}` に変更する（同時再生防止の一貫性）。

- [ ] **Step 5: ゲート**

Run: `cd app && bun test`
Expected: 全 PASS（サーバ側不変）
Run: `cd app && bun run typecheck`
Expected: exit 0
Run: `cd app/client && bun run build`
Expected: ビルド成功（tsc + vite）

- [ ] **Step 6: Commit**

```bash
git add app/client/src/api.ts app/client/src/i18n.ts app/client/src/screens/SentencesScreen.tsx
git commit -m "feat: 練習キューにチャンクカードとMy chunksセクションを追加"
```

---

## 既存テストへの影響（列挙）

- `app/server/__tests__/sentences.test.ts`: 影響なし（`srsTransition` 抽出は挙動不変。既存の grade 遷移テストが回帰ネット）
- `app/server/__tests__/routes.test.ts`: (1) `makeTestDeps` に必須 `chunkStore` フェイク追加 (2) AE / reflection レスポンスの deep-equal に `collectedChunks: 0` を追加 (3) sentences queue の期待値に `kind: "sentence"` を追加
- それ以外のサーバテスト・クライアントビルド: 影響なし（App.tsx 不変・SentencesScreen は型分岐のみ）

## Self-Review（執筆後チェック済み）

1. **設計6点のカバレッジ**: ①収集源=AE items+reflection fixes（追加Claude呼び出しなし・フィルタ条件明記）✅ ②collected_chunks テーブル（SRS列インライン・due=翌日・norm_en UNIQUE）✅ ③収集フック（ベストエフォート・dedup 二重（チャンク・sentences300）・日次上限5・collectedChunks フィールド）✅ ④queue 統合（チャンク先頭・kind union・grade 共通化 srsTransition・XP srs-grade）✅ ⑤クライアント（チャンクカード分岐・cloze シード +100000・My chunks・2タップ削除・0件非表示・i18n EN/JA）✅ ⑥HTTP契約（既存フィールド不変・追加のみ・新規3エンドポイント）✅
2. **プレースホルダ**: なし（TBD/TODO/「後で実装」ゼロ。全ステップに実コード）
3. **型整合**: `SrsState`（sentences.ts）を chunks.ts / routes.ts / クライアント `ChunkSrs = SentenceSrs` で一貫使用。`Grade` は sentences.ts から再利用。queue union のフィールド名（promptText/en/note/srs）はサーバ→クライアントで一致。`FAKE_SENTENCE` / `FAKE_AE` / `FAKE_REFLECTION` は routes.test.ts 既存定数を参照。
4. **遷移ロジックの共通化**: sentences.ts の grade は `srsTransition` に委譲する形へ書き換え、chunks.ts の grade も同関数を使用 — LADDER・境界（min/max）の実装は1箇所のみ。
5. **既存テスト影響**: 上節に列挙（3種のみ・すべて機械的更新）。
6. **注意点（実装者へ）**: routes.test.ts の既存アサーションの正確な行は実行して落ちた箇所で特定すること（deep-equal の書き方がテストごとに違う可能性があるため、期待値の**中身**を本計画の指示どおりに直す）。`db.run` の戻りで削除件数を判定しない（存在チェック→DELETE の2段で決定的に）。
