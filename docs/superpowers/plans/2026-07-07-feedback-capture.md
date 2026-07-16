# アプリ内フィードバック収集 Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 練習の完了時に控えめな1タップの難易度フィードバック（キツい/ちょうどいい/簡単＋任意メモ）を溜め、サイドバーの専用画面で日付降順に閲覧・Markdownエクスポートできるようにし、次の開発サイクルの入力にする。

**Architecture:** サーバは既存の `makeXRoutes` 規約に沿って `feedback` ドメイン（`bun:sqlite` の `feedback` テーブル + `ensureFeedbackSchema` ストア + `/api/feedback` の POST/GET）を1つ追加する。クライアントは再利用可能な `<FeedbackRow>` を1コンポーネント作り、練習完了の代表3点（セッション完了・自由会話・多聴聴取後）に配置する。閲覧はサイドバーの `FeedbackScreen`（一覧＋純関数 `feedbackToMarkdown` によるコピー）で行う。

**Tech Stack:** Bun + `bun:sqlite`（サーバ）、React 18 + TypeScript + Vite（クライアント）、`bun test`（TDD）。

## Global Constraints

- 研究制約: フィードバック行は**情報的のみ**。ノルマ・連続日数・警告・叱責・データ削除を一切導入しない。スキップは完全に自由で、未入力なら何も起きない。
- サーバのエンドポイントは `makeXRoutes(deps)` 規約に従い、ドメインモジュール1つ＋`routes.ts` の合成配列に1行＋`RouteDeps` 交差型に1項で完結させる。
- ストアは `ensureXSchema(db)`（`CREATE IF NOT EXISTS` のみ、マイグレーション機構は作らない）＋ `makeXStore(db)` の形。DBは `openDb()` で開き `db.ts` の `openDb` に `ensureFeedbackSchema` を1行足す。
- サーバは TDD（`bun test`）。ルートテストは `makeTestDeps` の `satisfies` フェイク＋`postJson`/`getReq` ヘルパを使い、ソケットを開かず `makeFetchHandler(deps)` を叩く。
- i18n は named 型（`FeedbackRowStrings` 等）を定義して `Strings` 交差型に足し、`STR.en` / `STR.ja` の**両方**に新キーを入れる。文字列を直書きしない。
- クライアントの `fetch` ラッパは `api/` に置き `api/index.ts` バレルから再エクスポートする。画面のデータ取得は `useLoad` を使う。
- 純ロジック（ストア・ルート・`feedbackToMarkdown`）は TDD。React コンポーネント／画面はリポジトリ慣習どおり単体テストを書かず、`tsc --noEmit` と全 `bun test` グリーンで検証する（本リポジトリに RTL 等のコンポーネントテスト基盤は無い）。
- ローカル日付は `localYmd`（サーバ `app/server/dates.ts`）を使う。`toISOString().slice(0,10)` は使わない。
- コミットは各タスク末尾で行う（frequent commits）。実際のコミット主体は実行セッションのワークフローに従う。

**検証コマンド（各タスクで使う）:**
- サーバ単体・全体テスト: `cd app && bun test`（`app/` から実行すると `client/src/**` の純ロジックテストも同時に走る）
- サーバ型チェック: `cd app && bun run typecheck`
- クライアント型チェック: `cd app/client && bunx tsc --noEmit`（失敗する場合は `bun run build` でも可）

---

## Architecture & Design Decisions

### データモデル（`feedback` テーブル）

| 列 | 型 | 意味 |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | 採番 |
| `ts` | TEXT NOT NULL | ISO タイムスタンプ（`new Date().toISOString()`） |
| `ymd` | TEXT NOT NULL | ローカル日付（`localYmd`、日付グルーピング用） |
| `block_kind` | TEXT NOT NULL | 練習種別タグ `"session" \| "free-talk" \| "listening"`（将来拡張可） |
| `ref_id` | TEXT NULL | セッション種別署名／シナリオ・素材id（無ければ null） |
| `level` | INTEGER NULL | 送信時の学習レベル（best-effort） |
| `stage` | INTEGER NULL | 送信時の stage（best-effort） |
| `rating` | TEXT NOT NULL | `"hard" \| "just-right" \| "easy"` |
| `note` | TEXT NOT NULL DEFAULT '' | 任意の一言メモ |

`session-log` の JSONL ではなく既存 `learn-english.db` にテーブルを足す理由: 恒久的な一覧・日付降順閲覧・Markdown一括エクスポートに向くため（要件どおり）。

### 表示ポイントの選定（UX過剰を避ける代表3点）

再利用コンポーネント `<FeedbackRow context={{ blockKind, refId? }} lang />` を1つ作り、**練習完了の自然な区切り**に限定して置く。`level`/`stage` は表示せず、送信時に `fetchProgressSummary()` から best-effort で文脈として付与する（配置側は `blockKind` と `refId` だけ渡せばよい）。

**採用する3点（理由つき）:**
1. **セッション完了**（`SessionRunner`）— 日次60/30・クイックドリルはすべて `SessionRunner` を通る。最後のブロックで即 `onExit()` する代わりに完了パネルを1枚出し、そこに1行置く。ウォームアップ/4-3-2/ロールプレイ/シャドーイング/振り返りを**セッション単位で1回**集約するのが正しい高度。ブロックごと（60分で最大5行）はノイズなので置かない。文脈: `blockKind:"session"`, `refId:` 種別署名（`daily-60` / `quick-shadowing` 等）。
2. **自由会話の終了**（`FreeTalkScreen`）— サイドバー直下の会話練習。少なくとも1往復（`turns.length >= 2`）した後に末尾へ控えめに出す。`FreeTalkScreen` はロールプレイからも `scenarioId` 付きで再利用されるため、**`scenarioId === undefined`（＝スタンドアロン自由会話）に限定**して表示し、セッション内ロールプレイとの二重表示を避ける。文脈: `blockKind:"free-talk"`, `refId:null`。
3. **多聴の聴取後**（`ListeningScreen` の `ListeningPlayback`）— 通し再生が完了して `logListening` が走った直後にだけ出す。受容練習の完了点。文脈: `blockKind:"listening"`, `refId:` 素材id。

**あえて置かない点（理由つき）:**
- **例文セット（`SentencesScreen`）**: SRS採点（good/soso/bad）が既に項目ごとの難易度シグナルを持つため、難易度フィードバック行は重複。置かない。
- **セッション内のブロック単位**: 過剰（1セッションで最大5行）。セッション完了1点で集約する。
- **レベル測定・進捗・ライブラリ**: 練習ではない（評価・閲覧）ため対象外。

### ファイル構成マップ

**新規:**
- `app/server/feedback-store.ts` — スキーマ＋ストア（save/list）
- `app/server/__tests__/feedback-store.test.ts` — ストアの TDD
- `app/server/routes/feedback.ts` — `/api/feedback` の POST/GET
- `app/server/__tests__/routes-feedback.test.ts` — ルートの TDD
- `app/client/src/api/feedback.ts` — `postFeedback` / `fetchFeedback`
- `app/client/src/screens/feedbackMarkdown.ts` — 純関数エクスポート
- `app/client/src/screens/feedbackMarkdown.test.ts` — 純関数の TDD
- `app/client/src/ui/FeedbackRow.tsx` — 再利用フィードバック行
- `app/client/src/screens/FeedbackScreen.tsx` — 閲覧画面

**変更:**
- `app/server/db.ts` — `openDb` に `ensureFeedbackSchema(db)` を追加
- `app/server/routes.ts` — `FeedbackRoutesDeps` を交差型に、`makeFeedbackRoutes(deps)` を合成配列に
- `app/server/index.ts` — `makeFeedbackStore(db)` を配線
- `app/server/__tests__/helpers/route-deps.ts` — `makeFakeFeedbackStore` ＋ `feedbackStore` を `makeTestDeps` に
- `app/client/src/api/index.ts` — バレルに1行
- `app/client/src/i18n.ts` — `FeedbackRowStrings` / `FeedbackScreenStrings` / `nav.feedback` を型と en/ja に
- `app/client/src/App.tsx` — `Mode` に`feedback`、navItem、描画分岐
- `app/client/src/screens/SessionRunner.tsx` — セッション完了パネルに `FeedbackRow`
- `app/client/src/screens/FreeTalkScreen.tsx` — スタンドアロン終了に `FeedbackRow`
- `app/client/src/screens/ListeningScreen.tsx` — 聴取後に `FeedbackRow`

---

## Task 1: feedback ストア（サーバ TDD）

**Files:**
- Create: `app/server/feedback-store.ts`
- Test: `app/server/__tests__/feedback-store.test.ts`
- Modify: `app/server/db.ts`（import 追加 + `openDb` 内に1行）

**Interfaces:**
- Produces:
  - `type FeedbackRating = "hard" | "just-right" | "easy"`
  - `type FeedbackInput = { blockKind: string; refId: string | null; level: number | null; stage: number | null; rating: FeedbackRating; note: string; ymd: string }`
  - `type FeedbackRow = { id: number; ts: string; ymd: string; blockKind: string; refId: string | null; level: number | null; stage: number | null; rating: FeedbackRating; note: string }`
  - `type FeedbackStore = { save(input: FeedbackInput): FeedbackRow; list(limit?: number): FeedbackRow[] }`
  - `function ensureFeedbackSchema(db: Database): void`
  - `function makeFeedbackStore(db: Database): FeedbackStore`

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/feedback-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import { makeFeedbackStore } from "../feedback-store";

function memStore() {
  return makeFeedbackStore(openDb(":memory:"));
}

describe("feedback-store", () => {
  test("save して list で取れる（スキーマ自動作成・採番・列マッピング）", () => {
    const store = memStore();
    const row = store.save({
      blockKind: "session", refId: "daily-60", level: 13, stage: 2,
      rating: "just-right", note: "調子よかった", ymd: "2026-07-07",
    });
    expect(typeof row.id).toBe("number");
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      blockKind: "session", refId: "daily-60", level: 13, stage: 2,
      rating: "just-right", note: "調子よかった", ymd: "2026-07-07",
    });
  });

  test("null の refId/level/stage と空 note を保持する", () => {
    const store = memStore();
    store.save({ blockKind: "free-talk", refId: null, level: null, stage: null, rating: "hard", note: "", ymd: "2026-07-07" });
    const [row] = store.list();
    expect(row.refId).toBeNull();
    expect(row.level).toBeNull();
    expect(row.stage).toBeNull();
    expect(row.note).toBe("");
  });

  test("list は id 降順（新しい順）", () => {
    const store = memStore();
    store.save({ blockKind: "a", refId: null, level: null, stage: null, rating: "easy", note: "", ymd: "2026-07-06" });
    store.save({ blockKind: "b", refId: null, level: null, stage: null, rating: "easy", note: "", ymd: "2026-07-07" });
    const list = store.list();
    expect(list.map((r) => r.blockKind)).toEqual(["b", "a"]);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `cd app && bun test __tests__/feedback-store.test.ts`
Expected: FAIL（`Cannot find module '../feedback-store'` 系）

- [ ] **Step 3: ストアを実装する**

`app/server/feedback-store.ts`:

```ts
import type { Database } from "bun:sqlite";
import { insertReturningId } from "./db-util";

export type FeedbackRating = "hard" | "just-right" | "easy";

export type FeedbackInput = {
  blockKind: string;
  refId: string | null;
  level: number | null;
  stage: number | null;
  rating: FeedbackRating;
  note: string;
  ymd: string;
};

export type FeedbackRow = {
  id: number;
  ts: string;
  ymd: string;
  blockKind: string;
  refId: string | null;
  level: number | null;
  stage: number | null;
  rating: FeedbackRating;
  note: string;
};

export type FeedbackStore = {
  /** 1件の完了時フィードバックを記録する（情報表示のみ・削除しない）。ymd は呼び出し側のローカル日付。 */
  save(input: FeedbackInput): FeedbackRow;
  /** 新しい順（id 降順）で最大 limit 件。閲覧画面と Markdown エクスポートで使う。 */
  list(limit?: number): FeedbackRow[];
};

export function ensureFeedbackSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    ymd TEXT NOT NULL,
    block_kind TEXT NOT NULL,
    ref_id TEXT,
    level INTEGER,
    stage INTEGER,
    rating TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  )`);
}

type Row = {
  id: number; ts: string; ymd: string; block_kind: string;
  ref_id: string | null; level: number | null; stage: number | null;
  rating: string; note: string;
};

function toEntry(r: Row): FeedbackRow {
  return {
    id: r.id, ts: r.ts, ymd: r.ymd, blockKind: r.block_kind,
    refId: r.ref_id, level: r.level, stage: r.stage,
    rating: r.rating as FeedbackRating, note: r.note,
  };
}

export function makeFeedbackStore(db: Database): FeedbackStore {
  return {
    save(input) {
      const ts = new Date().toISOString();
      db.run(
        "INSERT INTO feedback (ts, ymd, block_kind, ref_id, level, stage, rating, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [ts, input.ymd, input.blockKind, input.refId, input.level, input.stage, input.rating, input.note],
      );
      return {
        id: insertReturningId(db), ts, ymd: input.ymd, blockKind: input.blockKind,
        refId: input.refId, level: input.level, stage: input.stage, rating: input.rating, note: input.note,
      };
    },
    list(limit = 500) {
      const rows = db
        .query<Row, [number]>("SELECT * FROM feedback ORDER BY id DESC LIMIT ?")
        .all(limit);
      return rows.map(toEntry);
    },
  };
}
```

- [ ] **Step 4: `db.ts` の `openDb` にスキーマ保証を足す**

`app/server/db.ts` の import 群（先頭付近、`ensureListeningSchema` の import の次）に追加:

```ts
import { ensureFeedbackSchema } from "./feedback-store";
```

`openDb` 内、`ensureListeningSchema(db);` の直後に追加:

```ts
  ensureFeedbackSchema(db);
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd app && bun test __tests__/feedback-store.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 6: 既存テストが壊れていないことを確認する**

Run: `cd app && bun test __tests__/db.test.ts`
Expected: PASS（`openDb` 変更の影響なし）

- [ ] **Step 7: コミット**

```bash
git add app/server/feedback-store.ts app/server/__tests__/feedback-store.test.ts app/server/db.ts
git commit -m "feat: feedbackストア（bun:sqlite feedbackテーブル + save/list）を追加"
```

---

## Task 2: feedback ルート（サーバ TDD）

**Files:**
- Create: `app/server/routes/feedback.ts`
- Test: `app/server/__tests__/routes-feedback.test.ts`
- Modify: `app/server/__tests__/helpers/route-deps.ts`（`makeFakeFeedbackStore` ＋ `feedbackStore` を `makeTestDeps` に）
- Modify: `app/server/routes.ts`（交差型に1項 + 合成配列に1行）
- Modify: `app/server/index.ts`（`makeFeedbackStore(db)` を配線）

**Interfaces:**
- Consumes: `FeedbackStore` / `FeedbackInput` / `FeedbackRating`（Task 1）、`json` / `parseJsonBody` / `exact` / `RouteEntry`（`routes/http.ts`）、`localYmd`（`../dates`）
- Produces:
  - `type FeedbackRoutesDeps = { feedbackStore: FeedbackStore }`
  - `function makeFeedbackRoutes(deps: FeedbackRoutesDeps): RouteEntry[]`（`POST /api/feedback` → `{ ok: true }`、`GET /api/feedback` → `{ items: FeedbackRow[] }`）
  - `function makeFakeFeedbackStore(overrides?: Partial<FeedbackStore>): FeedbackStore`（テストヘルパ）

- [ ] **Step 1: テストヘルパにフェイクストアを足す**

`app/server/__tests__/helpers/route-deps.ts` の import 群に追加（`ListeningStore` import の次）:

```ts
import type { FeedbackStore } from "../../feedback-store";
```

`makeFakeListeningStore` の定義の直後に、新しいフェイクを追加:

```ts
export function makeFakeFeedbackStore(overrides: Partial<FeedbackStore> = {}): FeedbackStore {
  return {
    save: (input) => ({ id: 1, ts: "2026-07-07T00:00:00.000Z", ...input }),
    list: () => [],
    ...overrides,
  } satisfies FeedbackStore;
}
```

`makeTestDeps` 内の `deps` オブジェクト、`listeningStore: makeFakeListeningStore(),` の直後に追加:

```ts
    feedbackStore: makeFakeFeedbackStore(),
```

- [ ] **Step 2: 失敗するルートテストを書く**

`app/server/__tests__/routes-feedback.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeFakeFeedbackStore, makeTestDeps } from "./helpers/route-deps";
import { getReq, postJson } from "./helpers/http";
import type { FeedbackInput } from "../feedback-store";

describe("feedback API", () => {
  test("POST /api/feedback は context を保存して {ok:true} を返す", async () => {
    const saved: FeedbackInput[] = [];
    const { deps } = makeTestDeps({
      feedbackStore: makeFakeFeedbackStore({
        save: (input) => { saved.push(input); return { id: 1, ts: "t", ...input }; },
      }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/feedback", {
      blockKind: "session", refId: "daily-60", level: 13, stage: 2, rating: "hard", note: "きつめ",
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ blockKind: "session", refId: "daily-60", level: 13, stage: 2, rating: "hard", note: "きつめ" });
    expect(saved[0].ymd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("POST は refId/level/stage/note 省略時に null/'' で保存する", async () => {
    const saved: FeedbackInput[] = [];
    const { deps } = makeTestDeps({
      feedbackStore: makeFakeFeedbackStore({ save: (input) => { saved.push(input); return { id: 1, ts: "t", ...input }; } }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/feedback", { blockKind: "free-talk", rating: "easy" }));
    expect(res.status).toBe(200);
    expect(saved[0]).toMatchObject({ refId: null, level: null, stage: null, note: "" });
  });

  test("POST の400系: 空 blockKind・不正 rating・長すぎ note・非整数 level・不正JSON", async () => {
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      feedbackStore: makeFakeFeedbackStore({ save: (input) => { saved.push(input); return { id: 1, ts: "t", ...input }; } }),
    });
    const handler = makeFetchHandler(deps);
    expect((await handler(postJson("/api/feedback", { blockKind: "  ", rating: "hard" }))).status).toBe(400);
    expect((await handler(postJson("/api/feedback", { blockKind: "session", rating: "nope" }))).status).toBe(400);
    expect((await handler(postJson("/api/feedback", { blockKind: "session", rating: "hard", note: "x".repeat(301) }))).status).toBe(400);
    expect((await handler(postJson("/api/feedback", { blockKind: "session", rating: "hard", level: 1.5 }))).status).toBe(400);
    const badJson = await handler(new Request("http://x/api/feedback", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }));
    expect(badJson.status).toBe(400);
    expect(saved).toHaveLength(0); // 400 系では記録しない
  });

  test("GET /api/feedback は store.list の結果を items で返す（日付降順）", async () => {
    const rows = [
      { id: 2, ts: "t2", ymd: "2026-07-07", blockKind: "session", refId: "daily-60", level: 13, stage: 2, rating: "hard" as const, note: "b" },
      { id: 1, ts: "t1", ymd: "2026-07-06", blockKind: "free-talk", refId: null, level: null, stage: null, rating: "easy" as const, note: "" },
    ];
    const { deps } = makeTestDeps({ feedbackStore: makeFakeFeedbackStore({ list: () => rows }) });
    const res = await makeFetchHandler(deps)(getReq("/api/feedback"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: rows });
  });
});
```

- [ ] **Step 3: 失敗を確認する**

Run: `cd app && bun test __tests__/routes-feedback.test.ts`
Expected: FAIL（`makeFeedbackRoutes` 未実装で `RouteDeps` に `feedbackStore` が無い、または 404 になる）

- [ ] **Step 4: ルートモジュールを実装する**

`app/server/routes/feedback.ts`:

```ts
import { localYmd } from "../dates";
import { json, parseJsonBody, exact, type RouteEntry } from "./http";
import type { FeedbackRating, FeedbackStore } from "../feedback-store";

export type FeedbackRoutesDeps = {
  feedbackStore: FeedbackStore;
};

const RATINGS = ["hard", "just-right", "easy"] as const;

function isRating(v: unknown): v is FeedbackRating {
  return typeof v === "string" && (RATINGS as readonly string[]).includes(v);
}

/** undefined/null → null（未指定は null 扱い）、整数 → その値、それ以外 → undefined（不正） */
function asNullableInt(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/** undefined/null → null、max 以下の文字列 → その値、それ以外 → undefined（不正） */
function asNullableStr(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === "string" && v.length <= max ? v : undefined;
}

type FeedbackBody = {
  blockKind?: unknown; refId?: unknown; level?: unknown; stage?: unknown; rating?: unknown; note?: unknown;
};

async function handlePost(req: Request, deps: FeedbackRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<FeedbackBody>(req);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  if (typeof b.blockKind !== "string" || !b.blockKind.trim() || b.blockKind.length > 40) {
    return json({ error: "blockKind must be a non-empty string of at most 40 characters" }, 400);
  }
  if (!isRating(b.rating)) {
    return json({ error: `rating must be one of ${RATINGS.join(", ")}` }, 400);
  }
  const note = b.note === undefined || b.note === null ? "" : b.note;
  if (typeof note !== "string" || note.length > 300) {
    return json({ error: "note must be a string of at most 300 characters" }, 400);
  }
  const refId = asNullableStr(b.refId, 120);
  if (refId === undefined) return json({ error: "refId must be a string of at most 120 characters or null" }, 400);
  const level = asNullableInt(b.level);
  if (level === undefined) return json({ error: "level must be an integer or null" }, 400);
  const stage = asNullableInt(b.stage);
  if (stage === undefined) return json({ error: "stage must be an integer or null" }, 400);

  deps.feedbackStore.save({
    blockKind: b.blockKind, refId, level, stage, rating: b.rating, note, ymd: localYmd(new Date()),
  });
  return json({ ok: true });
}

function handleList(deps: FeedbackRoutesDeps): Response {
  return json({ items: deps.feedbackStore.list() });
}

export function makeFeedbackRoutes(deps: FeedbackRoutesDeps): RouteEntry[] {
  return [
    exact("POST", "/api/feedback", (req) => handlePost(req, deps)),
    exact("GET", "/api/feedback", () => handleList(deps)),
  ];
}
```

- [ ] **Step 5: `routes.ts` に配線する**

`app/server/routes.ts` の import 群（`makeListeningRoutes` の import の次）に追加:

```ts
import { makeFeedbackRoutes, type FeedbackRoutesDeps } from "./routes/feedback";
```

`RouteDeps` 交差型の末尾（`AssessmentRoutesDeps & ListeningRoutesDeps` の後）を変更:

```ts
export type RouteDeps =
  SystemRoutesDeps & ConverseRoutesDeps & SessionRoutesDeps & MenuRoutesDeps &
  SettingsRoutesDeps & LibraryRoutesDeps & CoachRoutesDeps & SentenceRoutesDeps &
  ChunkRoutesDeps & ProgressRoutesDeps & PlacementRoutesDeps & MetricsRoutesDeps &
  AssessmentRoutesDeps & ListeningRoutesDeps & FeedbackRoutesDeps;
```

`routes` 配列の末尾（`...makeListeningRoutes(deps),` の次）に追加:

```ts
    ...makeFeedbackRoutes(deps),
```

- [ ] **Step 6: `index.ts` に実ストアを配線する**

`app/server/index.ts` の import 群（`makeListeningStore` の import の次）に追加:

```ts
import { makeFeedbackStore } from "./feedback-store";
```

`const listeningStore = makeListeningStore(db);` の直後に追加:

```ts
const feedbackStore = makeFeedbackStore(db);
```

`realDeps` オブジェクトの末尾（`listeningStore,` の次）に追加:

```ts
  feedbackStore,
```

- [ ] **Step 7: テストが通ることを確認する**

Run: `cd app && bun test __tests__/routes-feedback.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 8: 型チェックと全テストで回帰がないことを確認する**

Run: `cd app && bun run typecheck && bun test`
Expected: 型エラーなし・全テスト PASS

- [ ] **Step 9: コミット**

```bash
git add app/server/routes/feedback.ts app/server/__tests__/routes-feedback.test.ts \
        app/server/__tests__/helpers/route-deps.ts app/server/routes.ts app/server/index.ts
git commit -m "feat: /api/feedback（POST保存・GET一覧）ルートを追加"
```

---

## Task 3: クライアント API ＋ Markdown エクスポート純関数（TDD）

**Files:**
- Create: `app/client/src/api/feedback.ts`
- Modify: `app/client/src/api/index.ts`（バレルに1行）
- Create: `app/client/src/screens/feedbackMarkdown.ts`
- Test: `app/client/src/screens/feedbackMarkdown.test.ts`

**Interfaces:**
- Consumes: `extractErrorMessage`（`api/http.ts`）
- Produces:
  - `type FeedbackRating = "hard" | "just-right" | "easy"`
  - `type FeedbackEntry = { id: number; ts: string; ymd: string; blockKind: string; refId: string | null; level: number | null; stage: number | null; rating: FeedbackRating; note: string }`
  - `type FeedbackContext = { blockKind: string; refId?: string | null }`
  - `function postFeedback(input: { blockKind: string; refId: string | null; level: number | null; stage: number | null; rating: FeedbackRating; note: string }): Promise<void>`
  - `function fetchFeedback(): Promise<FeedbackEntry[]>`
  - `type FeedbackMarkdownLabels = { heading: (n: number) => string; rating: (rating: FeedbackRating) => string }`
  - `function feedbackToMarkdown(entries: FeedbackEntry[], labels: FeedbackMarkdownLabels): string`

- [ ] **Step 1: API モジュールを作る**

`app/client/src/api/feedback.ts`:

```ts
import { extractErrorMessage } from "./http";

export type FeedbackRating = "hard" | "just-right" | "easy";

export type FeedbackEntry = {
  id: number;
  ts: string;
  ymd: string;
  blockKind: string;
  refId: string | null;
  level: number | null;
  stage: number | null;
  rating: FeedbackRating;
  note: string;
};

/** 配置側が渡す最小文脈。level/stage は FeedbackRow が送信時に付与するのでここには含めない。 */
export type FeedbackContext = { blockKind: string; refId?: string | null };

/** 練習完了時の1タップ評価を記録する（情報表示のみ・スキップ自由・返り値は使わない）。 */
export async function postFeedback(input: {
  blockKind: string; refId: string | null; level: number | null; stage: number | null;
  rating: FeedbackRating; note: string;
}): Promise<void> {
  const res = await fetch("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`feedback failed: ${await extractErrorMessage(res)}`);
}

export async function fetchFeedback(): Promise<FeedbackEntry[]> {
  const res = await fetch("/api/feedback");
  if (!res.ok) throw new Error(`feedback list failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { items: FeedbackEntry[] }).items;
}
```

- [ ] **Step 2: バレルに足す**

`app/client/src/api/index.ts` の末尾（`export * from "./listening";` の次）に追加:

```ts
export * from "./feedback";
```

- [ ] **Step 3: 失敗する純関数テストを書く**

`app/client/src/screens/feedbackMarkdown.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { feedbackToMarkdown, type FeedbackMarkdownLabels } from "./feedbackMarkdown";
import type { FeedbackEntry } from "../api";

const LABELS: FeedbackMarkdownLabels = {
  heading: (n) => `# フィードバック（${n}件）`,
  rating: (r) => ({ hard: "きつい", "just-right": "ちょうどいい", easy: "簡単" }[r]),
};

function entry(over: Partial<FeedbackEntry>): FeedbackEntry {
  return {
    id: 1, ts: "t", ymd: "2026-07-07", blockKind: "session",
    refId: null, level: null, stage: null, rating: "just-right", note: "", ...over,
  };
}

describe("feedbackToMarkdown", () => {
  test("日付ごとに見出しを作り、文脈と評価を1行にまとめる", () => {
    const md = feedbackToMarkdown([
      entry({ ymd: "2026-07-07", blockKind: "session", refId: "daily-60", level: 13, stage: 2, rating: "hard", note: "きつめ" }),
      entry({ ymd: "2026-07-07", blockKind: "free-talk", rating: "just-right" }),
      entry({ ymd: "2026-07-06", blockKind: "listening", refId: "morning-routine", rating: "easy" }),
    ], LABELS);
    expect(md).toBe(
      [
        "# フィードバック（3件）",
        "",
        "## 2026-07-07",
        "- **session** · (daily-60) · Lv13 · Stage2 · きつい — きつめ",
        "- **free-talk** · ちょうどいい",
        "",
        "## 2026-07-06",
        "- **listening** · (morning-routine) · 簡単",
      ].join("\n"),
    );
  });

  test("空配列でも見出しだけ返す", () => {
    expect(feedbackToMarkdown([], LABELS)).toBe("# フィードバック（0件）\n");
  });
});
```

- [ ] **Step 4: 失敗を確認する**

Run: `cd app && bun test client/src/screens/feedbackMarkdown.test.ts`
Expected: FAIL（`Cannot find module './feedbackMarkdown'`）

- [ ] **Step 5: 純関数を実装する**

`app/client/src/screens/feedbackMarkdown.ts`:

```ts
import type { FeedbackEntry, FeedbackRating } from "../api";

export type FeedbackMarkdownLabels = {
  heading: (n: number) => string;
  rating: (rating: FeedbackRating) => string;
};

/**
 * フィードバック一覧を日付見出し付き Markdown にする（次の開発サイクルへ貼るエクスポート用の純関数）。
 * entries は日付降順（サーバの list 順）を前提とし、ymd が変わるたびに `## <ymd>` を挟む。
 */
export function feedbackToMarkdown(entries: FeedbackEntry[], labels: FeedbackMarkdownLabels): string {
  const lines: string[] = [labels.heading(entries.length), ""];
  let currentYmd: string | null = null;
  for (const e of entries) {
    if (e.ymd !== currentYmd) {
      if (currentYmd !== null) lines.push("");
      lines.push(`## ${e.ymd}`);
      currentYmd = e.ymd;
    }
    const parts = [`**${e.blockKind}**`];
    if (e.refId) parts.push(`(${e.refId})`);
    if (e.level !== null) parts.push(`Lv${e.level}`);
    if (e.stage !== null) parts.push(`Stage${e.stage}`);
    parts.push(labels.rating(e.rating));
    let line = `- ${parts.join(" · ")}`;
    if (e.note) line += ` — ${e.note}`;
    lines.push(line);
  }
  return lines.join("\n");
}
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `cd app && bun test client/src/screens/feedbackMarkdown.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 7: クライアント型チェック**

Run: `cd app/client && bunx tsc --noEmit`
Expected: 型エラーなし

- [ ] **Step 8: コミット**

```bash
git add app/client/src/api/feedback.ts app/client/src/api/index.ts \
        app/client/src/screens/feedbackMarkdown.ts app/client/src/screens/feedbackMarkdown.test.ts
git commit -m "feat: feedback クライアントAPIとMarkdownエクスポート純関数を追加"
```

---

## Task 4: FeedbackRow コンポーネント ＋ i18n（feedbackRow）

**Files:**
- Create: `app/client/src/ui/FeedbackRow.tsx`
- Modify: `app/client/src/i18n.ts`（`FeedbackRowStrings` 型 + `Strings` 交差 + en/ja に `feedbackRow`）

**Interfaces:**
- Consumes: `fetchProgressSummary` / `postFeedback` / `FeedbackContext` / `FeedbackRating`（`../api`）、`STR` / `Lang`（`../i18n`）
- Produces:
  - `type FeedbackRowStrings = { feedbackRow: { prompt: string; notePlaceholder: string; hard: string; justRight: string; easy: string; thanks: string; retryHint: string } }`
  - `function FeedbackRow({ context, lang }: { context: FeedbackContext; lang: Lang }): JSX.Element`

- [ ] **Step 1: i18n に named 型を足す**

`app/client/src/i18n.ts` の `type ListeningScreenStrings = { ... };` ブロックの直後に追加:

```ts
type FeedbackRowStrings = { feedbackRow: {
  prompt: string; notePlaceholder: string;
  hard: string; justRight: string; easy: string;
  thanks: string; retryHint: string;
} };
```

`type Strings =` の交差の末尾（`& ListeningScreenStrings` の後）に追加:

```ts
  & ListeningScreenStrings & FeedbackRowStrings;
```

（元の行 `... & FreeTalkScreenStrings & ListeningScreenStrings;` を `... & FreeTalkScreenStrings & ListeningScreenStrings & FeedbackRowStrings;` に変更する。）

- [ ] **Step 2: en / ja に文字列を足す**

`app/client/src/i18n.ts` の en 側、`listeningScreen: { ... },` ブロックの閉じ `},` の直後（en オブジェクトを閉じる `},` の前）に追加:

```ts
    feedbackRow: {
      prompt: "How was that? (optional)",
      notePlaceholder: "One-line note (optional)",
      hard: "Too hard", justRight: "Just right", easy: "Too easy",
      thanks: "Thanks — noted.",
      retryHint: "Couldn't save. Tap again to retry.",
    },
```

ja 側、`listeningScreen: { ... },` ブロックの閉じ `},` の直後（ja オブジェクトを閉じる `},` の前）に追加:

```ts
    feedbackRow: {
      prompt: "今のはどうでしたか？（任意）",
      notePlaceholder: "ひとことメモ（任意）",
      hard: "キツい", justRight: "ちょうどいい", easy: "簡単",
      thanks: "ありがとう、記録しました。",
      retryHint: "保存できませんでした。もう一度タップしてください。",
    },
```

- [ ] **Step 3: コンポーネントを実装する**

`app/client/src/ui/FeedbackRow.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { fetchProgressSummary, postFeedback, type FeedbackContext, type FeedbackRating } from "../api";
import { STR, type Lang } from "../i18n";

/**
 * 練習完了時の控えめな1タップ評価行。メモ（任意）を先に入力してから3択（キツい/ちょうどいい/簡単）を
 * 押すと、その1タップでメモごと送信される。スキップ完全自由・ノルマなし・未入力なら何も起きない
 * （研究制約: 情報的のみ・警告/叱責なし）。level/stage は表示せず、送信時の文脈として進捗サマリから
 * best-effort で付与する（取得失敗時は null）。保存失敗時だけ中立的な再試行ヒントを出す（評価内容への叱責ではない）。
 */
export function FeedbackRow({ context, lang }: { context: FeedbackContext; lang: Lang }) {
  const t = STR[lang].feedbackRow;
  const [phase, setPhase] = useState<"prompt" | "sent">("prompt");
  const [note, setNote] = useState("");
  const [retryHint, setRetryHint] = useState(false);
  const enrichRef = useRef<{ level: number | null; stage: number | null }>({ level: null, stage: null });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    fetchProgressSummary()
      .then((s) => { if (aliveRef.current) enrichRef.current = { level: s.level, stage: s.stage }; })
      .catch(() => {});
    return () => { aliveRef.current = false; };
  }, []);

  async function submit(rating: FeedbackRating) {
    setRetryHint(false);
    try {
      await postFeedback({
        blockKind: context.blockKind,
        refId: context.refId ?? null,
        level: enrichRef.current.level,
        stage: enrichRef.current.stage,
        rating,
        note: note.trim(),
      });
      if (aliveRef.current) setPhase("sent");
    } catch (err) {
      console.warn("feedback post failed:", err);
      if (aliveRef.current) setRetryHint(true);
    }
  }

  if (phase === "sent") {
    return <p className="feedback-row-thanks text-sm text-muted">{t.thanks}</p>;
  }

  return (
    <div className="feedback-row stack">
      <span className="text-sm text-muted">{t.prompt}</span>
      <input
        className="feedback-note"
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t.notePlaceholder}
        maxLength={300}
        aria-label={t.notePlaceholder}
      />
      <div className="lang-toggle" role="group" aria-label={t.prompt}>
        <button onClick={() => submit("hard")}>{t.hard}</button>
        <button onClick={() => submit("just-right")}>{t.justRight}</button>
        <button onClick={() => submit("easy")}>{t.easy}</button>
      </div>
      {retryHint && <span className="text-sm text-muted">{t.retryHint}</span>}
    </div>
  );
}
```

> スタイルは既存ユーティリティクラス（`.stack` / `.lang-toggle` / `.text-sm` / `.text-muted`）で成立する。`.feedback-row` 等は付与しても未定義でも動作に影響しない（新規 CSS は必須ではない）。

- [ ] **Step 4: クライアント型チェック**

Run: `cd app/client && bunx tsc --noEmit`
Expected: 型エラーなし（未使用の `FeedbackRow` export は tsc ではエラーにならない）

- [ ] **Step 5: コミット**

```bash
git add app/client/src/ui/FeedbackRow.tsx app/client/src/i18n.ts
git commit -m "feat: 再利用可能な1タップFeedbackRowコンポーネントとi18nを追加"
```

---

## Task 5: FeedbackScreen（閲覧＋コピー）＋ ナビ配線 ＋ i18n（feedbackScreen / nav）

**Files:**
- Create: `app/client/src/screens/FeedbackScreen.tsx`
- Modify: `app/client/src/i18n.ts`（`FeedbackScreenStrings` 型 + `Strings` 交差 + `nav.feedback` を型と en/ja に）
- Modify: `app/client/src/App.tsx`（`Mode` に `feedback`、navItem、描画分岐、import）

**Interfaces:**
- Consumes: `fetchFeedback` / `FeedbackEntry`（`../api`）、`useLoad`、`feedbackToMarkdown`（`./feedbackMarkdown`）、`STR` / `Lang`、`Banner` / `Button` / `Card`
- Produces:
  - `type FeedbackScreenStrings`（下記）
  - `function FeedbackScreen({ lang }: { lang: Lang }): JSX.Element`
  - `nav.feedback: string`（`NavStrings` 拡張）

- [ ] **Step 1: i18n に named 型を足す**

`app/client/src/i18n.ts` の Task 4 で足した `FeedbackRowStrings` 定義の直後に追加:

```ts
type FeedbackScreenStrings = { feedbackScreen: {
  title: string; desc: string;
  loading: string; retry: string; empty: string;
  copy: string; copied: string;
  rating: { hard: string; "just-right": string; easy: string };
  block: { session: string; "free-talk": string; listening: string };
  at: (ymd: string) => string;
  levelStage: (level: number | null, stage: number | null) => string;
} };
```

`NavStrings` 型を変更（`progress: string` の後に `feedback: string` を追加）:

```ts
type NavStrings = { nav: { home: string; placement: string; free: string; library: string; sentences: string; listening: string; progress: string; feedback: string } };
```

`type Strings =` の交差末尾を変更（Task 4 で `& FeedbackRowStrings` まで足した後）:

```ts
  & ListeningScreenStrings & FeedbackRowStrings & FeedbackScreenStrings;
```

- [ ] **Step 2: en / ja に文字列を足す**

en 側 `nav: { ... }` を変更（`progress: "Progress"` の後に追加）:

```ts
    nav: { home: "Home", placement: "Level Check", free: "Free Talk", library: "Library", sentences: "300 Sentences", listening: "Listening", progress: "Progress", feedback: "Feedback" },
```

en 側 Task 4 で足した `feedbackRow: { ... },` の直後に追加:

```ts
    feedbackScreen: {
      title: "Feedback",
      desc: "Your quick reactions after practice. Copy them as Markdown to feed into the next round of development.",
      loading: "Loading…", retry: "Retry",
      empty: "No feedback yet. It shows up here after you react at the end of a practice.",
      copy: "📋 Copy as Markdown", copied: "Copied!",
      rating: { hard: "Too hard", "just-right": "Just right", easy: "Too easy" },
      block: { session: "Session", "free-talk": "Free talk", listening: "Listening" },
      at: (ymd) => ymd,
      levelStage: (level, stage) =>
        [level !== null ? `Lv${level}` : null, stage !== null ? `Stage${stage}` : null].filter(Boolean).join(" · ") || "—",
    },
```

ja 側 `nav: { ... }` を変更（`progress: "進捗"` の後に追加）:

```ts
    nav: { home: "ホーム", placement: "レベル測定", free: "自由会話", library: "ライブラリ", sentences: "暗記例文300", listening: "多聴", progress: "進捗", feedback: "フィードバック" },
```

ja 側 Task 4 で足した `feedbackRow: { ... },` の直後に追加:

```ts
    feedbackScreen: {
      title: "フィードバック",
      desc: "練習のあとに送った短い反応の記録です。Markdown でコピーして次の開発サイクルの入力にできます。",
      loading: "読み込み中…", retry: "再試行",
      empty: "まだフィードバックはありません。練習の最後に反応するとここに表示されます。",
      copy: "📋 Markdownでコピー", copied: "コピーしました",
      rating: { hard: "キツい", "just-right": "ちょうどいい", easy: "簡単" },
      block: { session: "セッション", "free-talk": "自由会話", listening: "多聴" },
      at: (ymd) => ymd,
      levelStage: (level, stage) =>
        [level !== null ? `Lv${level}` : null, stage !== null ? `Stage${stage}` : null].filter(Boolean).join(" · ") || "—",
    },
```

- [ ] **Step 3: 画面を実装する**

`app/client/src/screens/FeedbackScreen.tsx`:

```tsx
import { useState } from "react";
import { fetchFeedback, type FeedbackEntry } from "../api";
import { STR, type Lang } from "../i18n";
import { useLoad } from "../useLoad";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { feedbackToMarkdown } from "./feedbackMarkdown";

/** サイドバーの「フィードバック」画面。日付降順の一覧＋Markdownコピー（次サイクルへの貼り付け用）。 */
export function FeedbackScreen({ lang }: { lang: Lang }) {
  const t = STR[lang].feedbackScreen;
  const { state, reload } = useLoad(fetchFeedback);
  const [copied, setCopied] = useState(false);

  async function copyAll(entries: FeedbackEntry[]) {
    const md = feedbackToMarkdown(entries, {
      heading: (n) => `# ${t.title}（${n}）`,
      rating: (r) => t.rating[r],
    });
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn("clipboard write failed:", err);
    }
  }

  return (
    <div className="stack">
      <div className="hero">
        <h2 className="hero-title">{t.title}</h2>
        <p className="hero-date">{t.desc}</p>
      </div>
      {state.status === "loading" && <p className="text-muted">{t.loading}</p>}
      {state.status === "error" && (
        <Banner kind="error" action={<Button onClick={reload}>{t.retry}</Button>}>{state.error}</Banner>
      )}
      {state.status === "ready" && (
        state.data.length === 0 ? (
          <p className="text-muted">{t.empty}</p>
        ) : (
          <>
            <Button variant="secondary" onClick={() => copyAll(state.data)}>
              {copied ? t.copied : t.copy}
            </Button>
            {state.data.map((e) => {
              const blockLabel = (t.block as Record<string, string>)[e.blockKind] ?? e.blockKind;
              return (
                <Card
                  key={e.id}
                  header={<>{t.at(e.ymd)}{" "}<span className="text-sm text-muted">{blockLabel} · {t.rating[e.rating]}</span></>}
                >
                  <p className="text-sm text-muted">
                    {t.levelStage(e.level, e.stage)}{e.refId ? ` · ${e.refId}` : ""}
                  </p>
                  {e.note && <p className="sentence-explain text-sm">{e.note}</p>}
                </Card>
              );
            })}
          </>
        )
      )}
    </div>
  );
}
```

- [ ] **Step 4: `App.tsx` にナビと描画を配線する**

`app/client/src/App.tsx` の import 群（`ProgressScreen` の import の次あたり）に追加:

```ts
import { FeedbackScreen } from "./screens/FeedbackScreen";
```

`Mode` 型の末尾に追加（`| { kind: "progress" }` の後）:

```ts
type Mode = { kind: "start" } | { kind: "free" } | { kind: "session"; source: MenuSource } | { kind: "library" } | { kind: "sentences" } | { kind: "listening" } | { kind: "placement" } | { kind: "progress" } | { kind: "feedback" };
```

`navItems` 配列の末尾（`progress` の項目の後）に追加:

```ts
    { key: "feedback", icon: "📝", label: t.nav.feedback, active: mode.kind === "feedback", go: () => setMode({ kind: "feedback" }) },
```

`<main className="app">` 内の描画分岐、`{mode.kind === "progress" && <ProgressScreen lang={lang} />}` の直後に追加:

```tsx
      {mode.kind === "feedback" && <FeedbackScreen lang={lang} />}
```

- [ ] **Step 5: クライアント型チェック**

Run: `cd app/client && bunx tsc --noEmit`
Expected: 型エラーなし（`Mode` に `feedback` が入り、`nav.feedback` が en/ja 両方で埋まっているため網羅性 OK）

- [ ] **Step 6: 純関数テストが回帰していないことを確認する**

Run: `cd app && bun test client/src/screens/feedbackMarkdown.test.ts`
Expected: PASS（`feedbackToMarkdown` の I/F は不変）

- [ ] **Step 7: コミット**

```bash
git add app/client/src/screens/FeedbackScreen.tsx app/client/src/i18n.ts app/client/src/App.tsx
git commit -m "feat: サイドバーにフィードバック閲覧画面（一覧＋Markdownコピー）を追加"
```

---

## Task 6: FeedbackRow を練習完了の代表3点に配置

**Files:**
- Modify: `app/client/src/screens/SessionRunner.tsx`（セッション完了パネル）
- Modify: `app/client/src/screens/FreeTalkScreen.tsx`（スタンドアロン終了）
- Modify: `app/client/src/screens/ListeningScreen.tsx`（聴取後）

**Interfaces:**
- Consumes: `FeedbackRow`（`../ui/FeedbackRow`、Task 4）、`FeedbackContext`（型は暗黙、`{ blockKind, refId? }` を渡すだけ）

- [ ] **Step 1: SessionRunner にセッション完了パネルを足す**

`app/client/src/screens/SessionRunner.tsx` の import 群（`blockTitle` の import の次）に追加:

```ts
import { FeedbackRow } from "../ui/FeedbackRow";
```

ファイル内、`export function SessionRunner(...)` の**外側**（`SessionRunner` 定義の直前）にヘルパを追加:

```ts
/** セッション種別を feedback の refId に使う短い署名にする（例: daily-60 / quick-shadowing / quick-roleplay-daily）。 */
function sourceSignature(src: MenuSource): string {
  if (src.type === "daily") return `daily-${src.minutes}`;
  return `quick-${src.drill}${src.domain ? `-${src.domain}` : ""}`;
}
```

`SessionRunner` 本体、`const timer = useCountdown(0);` の直後に完了状態を追加:

```ts
  // 最終ブロック完了後、即離脱せず完了パネル（フィードバック行）を出すためのフラグ
  const [done, setDone] = useState(false);
```

`nextBlock` の `isLast` 分岐を変更。現状:

```ts
    if (isLast) {
      props.onExit();
      return;
    }
```

を次に置き換える:

```ts
    if (isLast) {
      setDone(true);
      advancingRef.current = false;
      return;
    }
```

（`block_end` 送信と `progressBlockXp` は変更前と同じくこの分岐の手前で既に実行済み。`openBlockRef.current = null` も手前で実行済みなので、アンマウント時の abort 用 effect は完了パネル表示中に誤って `block_end(aborted)` を送らない。）

`if (!menu) return <p className="text-muted">{t.building}</p>;` の直後に完了パネルの描画を追加:

```tsx
  if (done) {
    return (
      <div className="stack fade-in">
        <FeedbackRow context={{ blockKind: "session", refId: sourceSignature(props.source) }} lang={props.lang} />
        <div className="round-actions">
          <Button variant="primary" size="lg" onClick={props.onExit}>{t.finish}</Button>
        </div>
      </div>
    );
  }
```

- [ ] **Step 2: FreeTalkScreen（スタンドアロン）に足す**

`app/client/src/screens/FreeTalkScreen.tsx` の import 群（`Button` の import の次）に追加:

```ts
import { FeedbackRow } from "../ui/FeedbackRow";
```

`return (` 直下の最上位 `<div>` 内、末尾の `</section>` の直後（`</div>` で閉じる前）に追加:

```tsx
      {props.scenarioId === undefined && turns.length >= 2 && (
        <FeedbackRow context={{ blockKind: "free-talk", refId: null }} lang={props.lang} />
      )}
```

（`scenarioId === undefined` によりロールプレイ経由の埋め込み利用は除外され、セッション内フィードバックとの二重表示を避ける。`turns.length >= 2` は少なくとも1往復した後に限定する条件。）

- [ ] **Step 3: ListeningScreen（聴取後）に足す**

`app/client/src/screens/ListeningScreen.tsx` の import 群（`Card` の import の次）に追加:

```ts
import { FeedbackRow } from "../ui/FeedbackRow";
```

`ListeningPlayback` 内、`const [showScript, setShowScript] = useState(false);` の直後に聴取完了フラグを追加:

```ts
  const [listened, setListened] = useState(false);
```

`playAll` の通し再生完了ブロック（`onListened(weeklyCount)` を呼ぶ箇所）を変更。現状:

```ts
    try {
      const { weeklyCount } = await logListening(item.id);
      if (aliveRef.current && tokenRef.current === my) onListened(weeklyCount);
    } catch (err) {
      console.warn("listening log failed:", err);
    }
```

を次に置き換える:

```ts
    try {
      const { weeklyCount } = await logListening(item.id);
      if (aliveRef.current && tokenRef.current === my) {
        onListened(weeklyCount);
        setListened(true);
      }
    } catch (err) {
      console.warn("listening log failed:", err);
    }
```

`ListeningPlayback` の `return (` 内、最上位 `<div className="stack">` の末尾（`showScript` ブロックの閉じ `)}` の後、`</div>` の前）に追加:

```tsx
      {listened && <FeedbackRow context={{ blockKind: "listening", refId: item.id }} lang={lang} />}
```

- [ ] **Step 4: クライアント型チェック**

Run: `cd app/client && bunx tsc --noEmit`
Expected: 型エラーなし

- [ ] **Step 5: サーバ型チェックと全テストで回帰がないことを確認する**

Run: `cd app && bun run typecheck && bun test`
Expected: 型エラーなし・全テスト PASS（既存 + `feedback-store` + `routes-feedback` + `feedbackMarkdown`）

- [ ] **Step 6: 実アプリで動作を目視確認する（任意だが推奨）**

Run: `cd app && bun run dev`（別ターミナルで `cd app/client && bun run dev`）
確認: セッション最後の「終わる」でフィードバック行が出る／自由会話で1往復後に出る／多聴の通し再生後に出る／サイドバー「フィードバック」で一覧とMarkdownコピーが動く。スキップしても何も起きない。

- [ ] **Step 7: コミット**

```bash
git add app/client/src/screens/SessionRunner.tsx app/client/src/screens/FreeTalkScreen.tsx app/client/src/screens/ListeningScreen.tsx
git commit -m "feat: 練習完了の代表3点（セッション完了・自由会話・多聴聴取後）にFeedbackRowを配置"
```

---

## Self-Review

**1. Spec coverage:**

| 要件 | 実装タスク |
| --- | --- |
| 使用期間中に構造化フィードバックを溜め次サイクルの入力にする | Task 1（テーブル）+ Task 5（Markdownエクスポート） |
| 練習完了時に控えめな1タップ行（3択＋任意メモ） | Task 4（FeedbackRow）+ Task 6（配置） |
| スキップ自由・ノルマなし・未入力で何も起きない・警告/叱責なし・非削除 | Task 4（`phase` 未タップで no-op、保存失敗のみ中立ヒント、削除APIなし） |
| 文脈の自動付与（いつ・どの練習・レベル・stage） | Task 4（`ts`/`ymd` はサーバ、`level`/`stage` は `fetchProgressSummary`、`blockKind`/`refId` は配置側） |
| 保存（makeXRoutes・ensureSchema・bun:sqlite・既存dbにfeedbackテーブル） | Task 1 + Task 2 |
| 閲覧（サイドバー小画面・日付降順・文脈表示・Markdownコピー） | Task 5 |
| 表示ポイントの吟味と理由 | 「表示ポイントの選定」節（採用3点＋除外3点の理由） |
| 規約（named型i18n EN/JA・apiバレル・useLoad・サーバTDD・satisfiesフェイク＋postJson/getReq） | Task 2/3/4/5 で遵守 |

ギャップなし。

**2. Placeholder scan:** 「TBD」「適切に」「同様に」「後で」等は無し。全コードステップは実コードを含み、テストは実アサーションを含む。

**3. Type consistency:**
- `FeedbackRating = "hard" | "just-right" | "easy"` はサーバ（Task 1）とクライアント（Task 3）で同一文字列。i18n の `feedbackScreen.rating` / `feedbackRow` のキーも同じ3値に対応。
- `FeedbackInput`/`FeedbackRow`/`FeedbackStore` の名前は Task 1 定義を Task 2 のフェイク・テストがそのまま使用。
- `FeedbackEntry`（クライアント）は `FeedbackRow`（サーバ）と同一形。GET の `{ items }` 契約は Task 2 のルートと Task 3 の `fetchFeedback` で一致。
- `makeFeedbackRoutes` / `makeFeedbackStore` / `makeFakeFeedbackStore` / `ensureFeedbackSchema` の関数名は全タスクで一貫。
- 配置側（Task 6）は `{ blockKind, refId? }` のみ渡し、`FeedbackContext`（Task 3）と一致。`sourceSignature` の出力（`daily-60` 等）は `refId` の想定用途と整合。
