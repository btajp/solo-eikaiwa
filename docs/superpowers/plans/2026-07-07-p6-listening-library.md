# P6-2 多聴ミニライブラリ Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** レベル適合の短い聴取素材（2〜4分）を段階的スクリプト表示・聴取ログ付きで提供する「多聴ミニライブラリ」を新設する。

**Architecture:** コンテンツ層は既存の `ContentItem` union を広げず、独立した `ListeningItem` 型＋`parseListeningFile` を新設し、frontmatter パース部だけを共有ヘルパ `parseFrontmatter` に切り出して `content.ts` と共用する。サーバは新ルータ `routes/listening.ts`（素材一覧・本文取得・聴取ログ記録の3エンドポイント）＋新ストア `listening-store.ts`。初期素材は生成 CLI（`generate-content.ts` に `listening` モード追加・P6-1 の `vocabConstraint` に連動）で6本生成して commit する。クライアントは `ListeningScreen` 新設で、段落ごとの `playTtsCached` を await 連鎖で逐次再生する（停止・アンマウント安全な制御を新規実装）。

**Tech Stack:** Bun + TypeScript（サーバ）、bun:sqlite（ストア）、React + Vite（クライアント）、bun:test（TDD）、Claude Agent SDK（素材生成 CLI）。

## Global Constraints

これらは spec（`docs/superpowers/specs/2026-07-07-p6-input-vocab-plan.md` の P6-2）と確立済み規約から。**全タスクの要件に暗黙で含まれる。**

- **研究制約**: 聴取ログは記録と情報表示のみ（「今週n本」）。**ノルマ・目標・未達表示は置かない**。データ非削除・自動表示なし。
- **ContentItem を広げない**: `parseContentFile` の kind は topic/scenario にハード限定のまま。`ListeningItem` は完全に独立した型で新設する。
- **プリセット廃止済み**: サポート設定は個別トグル3つ（`jaHint`/`modelTalk`/`cloze`）のみ。preset は存在しない。ListeningScreen のスクリプト隠し既定は Shadowing 同様の固定 `false` ＋「表示」ボタン方式（サポート設定には足さない）。
- **ルータ規約（R1）**: 新エンドポイントは機能別ルータのモジュール1つ＋ `RouteDeps` 交差型に1項＋合成配列に1行＋ `index.ts` の `realDeps` 配線。ハンドラは狭い `Deps` 型に依存し、テストはフェイクを渡す。
- **ストア規約**: `ensureXxxSchema(db)`＋`makeXxxStore(db)`、採番は `insertReturningId(db)`、`openDb` に `ensureSchema` 呼び出しを1行合成（CREATE IF NOT EXISTS のみ。マイグレーション機構は作らない）。
- **api/バレル規約**: 新 fetch は `api/<domain>.ts` に置き、`api/index.ts` バレルに `export * from "./<domain>";` を1行追加。エラーは `extractErrorMessage(res)` 経由。
- **named 型辞書 EN/JA 規約**: 画面文言は `i18n.ts` の named 型サブ辞書（`type XxxStrings = { xxx: {...} }`）を `Strings` 交差に加え、`STR.en` / `STR.ja` の両方に**同じキー集合**を実装する。
- **useLoad / useExplain 再利用**: マウント時1回ロードは `useLoad`、「訳・解説」ボタンは `useExplain(() => fetchTalkExplanation(...))` を流用する（ShadowingScreen / LibraryScreen 参照）。
- **リポジトリ規約**: `data/` や royal300 には触れない。素材は `content/listening/`（`content/` は commit 対象）に置く。
- **1タスク1コミット・Conventional Commits**（`feat:` / `test:` など）。

**各タスク末尾の検証ゲート（共通）:**
- `cd app && bun test`
- `cd app && bun run typecheck`
- クライアントを変更したタスクのみ: `cd app/client && bun run build`

---

## File Structure

新規・変更ファイルと責務:

- **`app/server/content.ts`** (変更): frontmatter パース部を `parseFrontmatter` に切り出し、`parseContentFile` をそれ経由に。`parseDomain` / `parseLevelRange` を export（listening が再利用）。
- **`app/server/paths.ts`** (変更): `LISTENING_DIR` を追加。
- **`app/server/listening.ts`** (新規): `ListeningItem` 型・`parseListeningFile` / `loadListening` / `findListening`（コンテンツ層）。
- **`app/server/listening-store.ts`** (新規): `ListeningStore`・`ensureListeningSchema` / `makeListeningStore`（聴取ログ）。
- **`app/server/db.ts`** (変更): `ensureListeningSchema` を `openDb` に合成（import 1・呼び出し1）。
- **`app/server/routes/listening.ts`** (新規): `ListeningRoutesDeps`・`makeListeningRoutes`（3エンドポイント）。
- **`app/server/routes.ts`** (変更): `RouteDeps` 交差に1項・合成配列に1行・import。
- **`app/server/index.ts`** (変更): `realDeps` に listening 配線・`listeningStore` 生成・`LISTENING_DIR` import。
- **`app/server/__tests__/helpers/route-deps.ts`** (変更): `makeFakeListeningStore` ＋ `FAKE_LISTENING_ITEM` ＋ `makeTestDeps` デフォルトに3項。
- **`app/server/content-gen.ts`** (変更): `NewListeningCandidate`・`listeningToMarkdown`・`validateListeningCandidate`・`genListening`。
- **`scripts/generate-content.ts`** (変更): `listening` サブコマンド追加。
- **`app/client/src/api/listening.ts`** (新規) ＋ **`api/index.ts`** (変更・バレル1行)。
- **`app/client/src/i18n.ts`** (変更): `nav.listening` キー・`ListeningScreenStrings`（EN/JA）。
- **`app/client/src/screens/ListeningScreen.tsx`** (新規): 一覧＋逐次再生プレイヤー。
- **`app/client/src/App.tsx`** (変更): nav 5箇所（Mode union / navItems / 描画分岐 / import / NavStrings キーは i18n 側）。
- **テスト（新規）**: `__tests__/listening.test.ts`（パーサ単体）・`__tests__/listening-store.test.ts`（DB単体）・`__tests__/routes-listening.test.ts`（ルート）・`__tests__/listening-content.test.ts`（リポジトリ素材の整合性・Task 5）。`__tests__/content-gen.test.ts`（追記・Task 3）。

---

## Task 1: コンテンツ層 — 共有 frontmatter ヘルパ ＋ ListeningItem / parseListeningFile

**Files:**
- Modify: `app/server/content.ts`
- Modify: `app/server/paths.ts`
- Create: `app/server/listening.ts`
- Test: `app/server/__tests__/listening.test.ts`

**Interfaces:**
- Consumes: `Domain`（`content.ts`・既存 export）。
- Produces:
  - `content.ts`: `export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } | null`、`export function parseDomain(raw: string | undefined): Domain`、`export function parseLevelRange(raw: string | undefined): [number, number]`。
  - `paths.ts`: `export const LISTENING_DIR: string`。
  - `listening.ts`: `export type ListeningItem = { id: string; title: string; titleJa: string; domain: Domain; level: [number, number]; paragraphs: string[] }`、`export function parseListeningFile(text: string): ListeningItem | null`、`export function loadListening(dir: string): ListeningItem[]`、`export function findListening(id: string): ListeningItem | undefined`。

- [ ] **Step 1: `parseFrontmatter` の失敗テストを書く**

`app/server/__tests__/listening.test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../content";
import { parseListeningFile } from "../listening";

const VALID = `---
id: morning-routine
title: "My morning routine"
title_ja: "朝のルーティン"
domain: daily
level: [1, 3]
---

I wake up at seven every day. Then I make a cup of coffee and check the news.

After breakfast, I walk to the station. The walk takes about ten minutes.`;

describe("parseFrontmatter", () => {
  test("frontmatter を fields と body に分解する", () => {
    const fm = parseFrontmatter(VALID)!;
    expect(fm.fields.id).toBe("morning-routine");
    expect(fm.fields.title).toBe("My morning routine");
    expect(fm.fields.domain).toBe("daily");
    expect(fm.body.trim().startsWith("I wake up")).toBe(true);
  });

  test("frontmatter が無ければ null", () => {
    expect(parseFrontmatter("no frontmatter here")).toBeNull();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd app && bun test listening.test.ts`
Expected: FAIL（`parseFrontmatter` / `parseListeningFile` が未定義でインポートエラー）

- [ ] **Step 3: `content.ts` に `parseFrontmatter` を追加し `parseContentFile` を切り出す**

`app/server/content.ts` の `parseDomain` / `parseLevelRange` に `export` を付け、`parseFrontmatter` を追加し、`parseContentFile` をヘルパ経由に置き換える。

`function parseDomain(` を `export function parseDomain(` に、`function parseLevelRange(` を `export function parseLevelRange(` に変更。

`parseContentFile` を以下で置き換える:

```ts
/** frontmatter（先頭の `---\n ... \n---` ブロック）を key:value 辞書と本文に分解する。
 *  topic/scenario（parseContentFile）と listening（parseListeningFile）で共有する。frontmatter が無ければ null。 */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { fields, body: text.slice(m[0].length) };
}

export function parseContentFile(text: string): ContentItem | null {
  const fm = parseFrontmatter(text);
  if (!fm) return null;
  const { fields, body } = fm;
  if (!fields.id || !fields.title || (fields.kind !== "topic" && fields.kind !== "scenario")) return null;
  const hints = body.split("\n").filter((l) => l.trim().startsWith("- ")).map((l) => l.trim().slice(2));
  const starters = body.split("\n").filter((l) => l.trim().startsWith("> ")).map((l) => l.trim().slice(2).trim());
  return {
    id: fields.id, kind: fields.kind, title: fields.title, titleJa: fields.title_ja ?? "", hints, starters,
    domain: parseDomain(fields.domain), level: parseLevelRange(fields.level),
  };
}
```

- [ ] **Step 4: `paths.ts` に `LISTENING_DIR` を追加する**

`app/server/paths.ts` の `SCENARIOS_DIR` の行の直後に追加:

```ts
export const LISTENING_DIR = path.join(CONTENT_DIR, "listening");
```

（`ensureDirs` には追加しない — `content/` はコミット済みの読み取り専用素材で、topics/scenarios と同様に起動時生成しない。）

- [ ] **Step 5: `listening.ts` を作成する**

`app/server/listening.ts` を新規作成:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LISTENING_DIR } from "./paths";
import { parseFrontmatter, parseDomain, parseLevelRange, type Domain } from "./content";

/** 多聴素材1本。本文は散文スクリプトを段落（空行区切り）に分割して持つ（TTS は段落単位で逐次再生するため）。 */
export type ListeningItem = {
  id: string;
  title: string;
  titleJa: string;
  domain: Domain;
  level: [number, number];
  paragraphs: string[];
};

/**
 * listening/*.md をパースする。frontmatter は content と共有ヘルパ、本文は散文の段落分割（箇条書きではない）。
 * id・title が無い、または段落が1つも取れないファイルは null（loadListening で除外される）。
 */
export function parseListeningFile(text: string): ListeningItem | null {
  const fm = parseFrontmatter(text);
  if (!fm) return null;
  const { fields, body } = fm;
  if (!fields.id || !fields.title) return null;
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (paragraphs.length === 0) return null;
  return {
    id: fields.id, title: fields.title, titleJa: fields.title_ja ?? "",
    domain: parseDomain(fields.domain), level: parseLevelRange(fields.level), paragraphs,
  };
}

export function loadListening(dir: string): ListeningItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseListeningFile(readFileSync(path.join(dir, f), "utf8")))
    .filter((c): c is ListeningItem => c !== null);
}

/** listeningId → 素材定義（未知は undefined）。routes の配線クロージャから使う。 */
export function findListening(id: string): ListeningItem | undefined {
  return loadListening(LISTENING_DIR).find((it) => it.id === id);
}
```

- [ ] **Step 6: `parseListeningFile` の本体テストを追加する**

`app/server/__tests__/listening.test.ts` に追記（`describe("parseFrontmatter", ...)` の後）:

```ts
describe("parseListeningFile", () => {
  test("正常系: 段落を空行区切りで分割する", () => {
    const it = parseListeningFile(VALID)!;
    expect(it.id).toBe("morning-routine");
    expect(it.title).toBe("My morning routine");
    expect(it.titleJa).toBe("朝のルーティン");
    expect(it.domain).toBe("daily");
    expect(it.level).toEqual([1, 3]);
    expect(it.paragraphs).toHaveLength(2);
    expect(it.paragraphs[0].startsWith("I wake up")).toBe(true);
  });

  test("frontmatter 無しは null", () => {
    expect(parseListeningFile("just prose, no frontmatter")).toBeNull();
  });

  test("id / title 欠落は null", () => {
    const noId = `---\ntitle: "T"\ndomain: daily\n---\n\nBody paragraph.`;
    const noTitle = `---\nid: x\ndomain: daily\n---\n\nBody paragraph.`;
    expect(parseListeningFile(noId)).toBeNull();
    expect(parseListeningFile(noTitle)).toBeNull();
  });

  test("本文が空（段落ゼロ）は null", () => {
    const empty = `---\nid: x\ntitle: "T"\ndomain: daily\nlevel: [1, 3]\n---\n\n   `;
    expect(parseListeningFile(empty)).toBeNull();
  });

  test("不正 domain / level は content と同じ挙動でフォールバック（it / [1,6]）", () => {
    const bad = `---\nid: x\ntitle: "T"\ndomain: nope\nlevel: [9, 9]\n---\n\nBody paragraph one.\n\nBody paragraph two.`;
    const it = parseListeningFile(bad)!;
    expect(it.domain).toBe("it");
    expect(it.level).toEqual([1, 6]);
  });
});
```

- [ ] **Step 7: テストが通ることを確認する（既存 content テストの非回帰も）**

Run: `cd app && bun test listening.test.ts content.test.ts content-gen.test.ts`
Expected: PASS（`parseContentFile` のリファクタは挙動不変なので `content.test.ts` / `content-gen.test.ts` も緑）

- [ ] **Step 8: 検証ゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: 全 PASS / 型エラーなし

- [ ] **Step 9: コミット**

```bash
git add app/server/content.ts app/server/paths.ts app/server/listening.ts app/server/__tests__/listening.test.ts
git commit -m "feat: 多聴素材のコンテンツ層（ListeningItem/parseListeningFile）とfrontmatter共有ヘルパを追加"
```

---

## Task 2: サーバ — listening-store ＋ routes/listening（TDD）

**Files:**
- Create: `app/server/listening-store.ts`
- Modify: `app/server/db.ts`
- Create: `app/server/routes/listening.ts`
- Modify: `app/server/routes.ts`
- Modify: `app/server/index.ts`
- Modify: `app/server/__tests__/helpers/route-deps.ts`
- Test: `app/server/__tests__/listening-store.test.ts`, `app/server/__tests__/routes-listening.test.ts`

**Interfaces:**
- Consumes: `insertReturningId`（`db-util.ts`）、`ListeningItem`（`listening.ts`・Task 1）、`loadListening` / `findListening`（`listening.ts`）、`localYmd` / `addDaysYmd`（`dates.ts`）、`json` / `parseJsonBody` / `exact` / `prefix` / `bestEffort`（`routes/http.ts`）。
- Produces:
  - `listening-store.ts`: `export type ListeningLogRow = { id: number; ts: string; ymd: string; itemId: string }`、`export type ListeningStore = { log(itemId: string, ymd: string): ListeningLogRow; countSince(fromYmd: string): number }`、`export function ensureListeningSchema(db: Database): void`、`export function makeListeningStore(db: Database): ListeningStore`。
  - `routes/listening.ts`: `export type ListeningRoutesDeps = { listListening: () => ListeningItem[]; findListening: (id: string) => ListeningItem | undefined; listeningStore: ListeningStore }`、`export function makeListeningRoutes(deps: ListeningRoutesDeps): RouteEntry[]`。
  - エンドポイント: `GET /api/listening` → `{ items: Array<Omit<ListeningItem,"paragraphs">>; weeklyCount: number }`、`GET /api/listening/:id` → `{ item: ListeningItem }`（未知は 404）、`POST /api/listening/log` `{ itemId }` → `{ weeklyCount: number }`（未知 itemId / 空は 400）。
  - `route-deps.ts`: `export const FAKE_LISTENING_ITEM: ListeningItem`、`export function makeFakeListeningStore(overrides?: Partial<ListeningStore>): ListeningStore`。

- [ ] **Step 1: ストアの失敗テストを書く**

`app/server/__tests__/listening-store.test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import { makeListeningStore } from "../listening-store";

function memStore() {
  return makeListeningStore(openDb(":memory:"));
}

describe("listening-store", () => {
  test("log して countSince で数えられる（スキーマ自動作成・採番）", () => {
    const store = memStore();
    const row = store.log("item-a", "2026-07-07");
    expect(typeof row.id).toBe("number");
    expect(row.itemId).toBe("item-a");
    expect(row.ymd).toBe("2026-07-07");
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store.countSince("2026-07-01")).toBe(1);
  });

  test("countSince は fromYmd を含み、それ以前を除外する", () => {
    const store = memStore();
    store.log("a", "2026-06-30"); // 窓の外
    store.log("b", "2026-07-01"); // 境界（含む）
    store.log("c", "2026-07-05");
    expect(store.countSince("2026-07-01")).toBe(2);
  });

  test("同一素材の複数聴取もすべて数える（回数カウントであり distinct ではない）", () => {
    const store = memStore();
    store.log("a", "2026-07-07");
    store.log("a", "2026-07-07");
    expect(store.countSince("2026-07-01")).toBe(2);
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `cd app && bun test listening-store.test.ts`
Expected: FAIL（`makeListeningStore` 未定義）

- [ ] **Step 3: `listening-store.ts` を実装する**

`app/server/listening-store.ts` を新規作成:

```ts
import type { Database } from "bun:sqlite";
import { insertReturningId } from "./db-util";

export type ListeningLogRow = { id: number; ts: string; ymd: string; itemId: string };

export type ListeningStore = {
  /** 1回の聴取を記録する（記録と情報表示のみ・ノルマ判定はしない）。ymd は呼び出し側のローカル日付。 */
  log(itemId: string, ymd: string): ListeningLogRow;
  /** fromYmd 以降（fromYmd を含む）の聴取回数。「今週n本」の情報表示に使う。 */
  countSince(fromYmd: string): number;
};

type DbRow = { id: number; ts: string; ymd: string; item_id: string };

export function ensureListeningSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS listening_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    ymd TEXT NOT NULL,
    item_id TEXT NOT NULL
  )`);
}

export function makeListeningStore(db: Database): ListeningStore {
  return {
    log(itemId, ymd) {
      const ts = new Date().toISOString();
      db.run("INSERT INTO listening_logs (ts, ymd, item_id) VALUES (?, ?, ?)", [ts, ymd, itemId]);
      return { id: insertReturningId(db), ts, ymd, itemId };
    },
    countSince(fromYmd) {
      const row = db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM listening_logs WHERE ymd >= ?")
        .get(fromYmd);
      return row?.n ?? 0;
    },
  };
}

// DbRow は将来の list 取得用に型を残す（現状 countSince は集計のみ）。
export type { DbRow };
```

- [ ] **Step 4: `db.ts` に schema 合成を追加する**

`app/server/db.ts` の import 群に追加:

```ts
import { ensureListeningSchema } from "./listening-store";
```

`openDb` 内の `ensureAssessmentSchema(db);` の直後に追加:

```ts
  ensureListeningSchema(db);
```

- [ ] **Step 5: ストアテストが通ることを確認する**

Run: `cd app && bun test listening-store.test.ts`
Expected: PASS

- [ ] **Step 6: ルートの失敗テストを書く**

`app/server/__tests__/routes-listening.test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { FAKE_LISTENING_ITEM, makeFakeListeningStore, makeTestDeps } from "./helpers/route-deps";
import { getReq, postJson } from "./helpers/http";

describe("listening API", () => {
  test("GET /api/listening は本文（paragraphs）を除いたメタ一覧 + weeklyCount を返す", async () => {
    const { deps } = makeTestDeps({
      listeningStore: makeFakeListeningStore({ countSince: () => 3 }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/listening"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>>; weeklyCount: number };
    expect(body.weeklyCount).toBe(3);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("morning-routine");
    expect(body.items[0]).not.toHaveProperty("paragraphs"); // 一覧は本文を含めない
  });

  test("GET /api/listening は countSince が投げても weeklyCount 0 で一覧を返す（bestEffort）", async () => {
    const { deps } = makeTestDeps({
      listeningStore: makeFakeListeningStore({ countSince: () => { throw new Error("db down"); } }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/listening"));
    expect(res.status).toBe(200);
    expect((await res.json() as { weeklyCount: number }).weeklyCount).toBe(0);
  });

  test("GET /api/listening/:id は既知素材の本文を返し、未知は404", async () => {
    const { deps } = makeTestDeps();
    const ok = await makeFetchHandler(deps)(getReq("/api/listening/morning-routine"));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { item: { id: string; paragraphs: string[] } };
    expect(body.item.id).toBe("morning-routine");
    expect(body.item.paragraphs.length).toBeGreaterThan(0);
    const notFound = await makeFetchHandler(deps)(getReq("/api/listening/nope"));
    expect(notFound.status).toBe(404);
  });

  test("POST /api/listening/log は記録して weeklyCount を返す", async () => {
    const logged: Array<{ itemId: string; ymd: string }> = [];
    const { deps } = makeTestDeps({
      listeningStore: makeFakeListeningStore({
        log: (itemId, ymd) => { logged.push({ itemId, ymd }); return { id: 1, ts: "t", ymd, itemId }; },
        countSince: () => 5,
      }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/listening/log", { itemId: "morning-routine" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weeklyCount: 5 });
    expect(logged).toHaveLength(1);
    expect(logged[0].itemId).toBe("morning-routine");
    expect(logged[0].ymd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("POST /api/listening/log の400系: 空 itemId・未知 itemId・不正JSON", async () => {
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      listeningStore: makeFakeListeningStore({
        log: (itemId, ymd) => { saved.push(itemId); return { id: 1, ts: "t", ymd, itemId }; },
      }),
    });
    const handler = makeFetchHandler(deps);
    expect((await handler(postJson("/api/listening/log", { itemId: "  " }))).status).toBe(400);
    expect((await handler(postJson("/api/listening/log", { itemId: "nope" }))).status).toBe(400);
    const badJson = await handler(new Request("http://x/api/listening/log", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }));
    expect(badJson.status).toBe(400);
    expect(saved).toHaveLength(0); // 400 系では記録しない
  });
});
```

- [ ] **Step 7: 失敗を確認する**

Run: `cd app && bun test routes-listening.test.ts`
Expected: FAIL（`makeFakeListeningStore` / `FAKE_LISTENING_ITEM` 未定義、ルート未実装で 404）

- [ ] **Step 8: `route-deps.ts` にフェイクとデフォルトを追加する**

`app/server/__tests__/helpers/route-deps.ts` の import 群に追加:

```ts
import type { ListeningItem } from "../../listening";
import type { ListeningStore } from "../../listening-store";
```

`makeFakeAssessmentStore` の定義の後に追加:

```ts
export const FAKE_LISTENING_ITEM: ListeningItem = {
  id: "morning-routine", title: "My morning routine", titleJa: "朝のルーティン",
  domain: "daily", level: [1, 3], paragraphs: ["I wake up at seven.", "Then I make coffee."],
};

export function makeFakeListeningStore(overrides: Partial<ListeningStore> = {}): ListeningStore {
  return {
    log: (itemId, ymd) => ({ id: 1, ts: "2026-07-07T00:00:00.000Z", ymd, itemId }),
    countSince: () => 0,
    ...overrides,
  } satisfies ListeningStore;
}
```

`makeTestDeps` の `deps` オブジェクト（`assembleMonthData` / `generateMonthlyReport` の付近）に3項追加:

```ts
    listListening: () => [FAKE_LISTENING_ITEM],
    findListening: (id: string) => (id === "morning-routine" ? FAKE_LISTENING_ITEM : undefined),
    listeningStore: makeFakeListeningStore(),
```

- [ ] **Step 9: `routes/listening.ts` を実装する**

`app/server/routes/listening.ts` を新規作成:

```ts
import { localYmd, addDaysYmd } from "../dates";
import { json, parseJsonBody, exact, prefix, bestEffort, type RouteEntry } from "./http";
import type { ListeningItem } from "../listening";
import type { ListeningStore } from "../listening-store";

export type ListeningRoutesDeps = {
  /** 素材（本文込み）の一覧。実体は loadListening、テストはフェイク。 */
  listListening: () => ListeningItem[];
  /** listeningId → 素材（未知は undefined）。本文取得と log の存在確認で使う。 */
  findListening: (id: string) => ListeningItem | undefined;
  listeningStore: ListeningStore;
};

/** 「今週」= 今日を含む直近7日。クライアント PracticeStat の週集計と同じ窓。 */
function weekStartYmd(now: Date): string {
  return addDaysYmd(localYmd(now), -6);
}

function handleList(deps: ListeningRoutesDeps): Response {
  // 一覧は本文（paragraphs）を含めない（本文は GET /api/listening/:id で取る）
  const items = deps.listListening().map(({ paragraphs, ...meta }) => meta);
  let weeklyCount = 0;
  bestEffort("[listening] countSince failed, returning 0:", () => {
    weeklyCount = deps.listeningStore.countSince(weekStartYmd(new Date()));
  });
  return json({ items, weeklyCount });
}

function handleGet(url: URL, deps: ListeningRoutesDeps): Response {
  const id = url.pathname.slice("/api/listening/".length);
  const item = deps.findListening(id);
  if (!item) return json({ error: `unknown listening id: ${id}` }, 404);
  return json({ item });
}

async function handleLog(req: Request, deps: ListeningRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ itemId?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { itemId } = parsed.body;
  if (typeof itemId !== "string" || !itemId.trim()) return json({ error: "itemId must be a non-empty string" }, 400);
  if (!deps.findListening(itemId)) return json({ error: `unknown listening id: ${itemId}` }, 400);
  const now = new Date();
  deps.listeningStore.log(itemId, localYmd(now));
  return json({ weeklyCount: deps.listeningStore.countSince(weekStartYmd(now)) });
}

export function makeListeningRoutes(deps: ListeningRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/listening", () => handleList(deps)),
    exact("POST", "/api/listening/log", (req) => handleLog(req, deps)),
    // 本文取得は末尾の前方一致（/api/listening/:id）。log は POST なので競合しない。
    prefix("GET", "/api/listening/", (_req, url) => handleGet(url, deps)),
  ];
}
```

- [ ] **Step 10: `routes.ts` にルータを合成する**

`app/server/routes.ts` の import 群（`makeAssessmentRoutes` の行の後）に追加:

```ts
import { makeListeningRoutes, type ListeningRoutesDeps } from "./routes/listening";
```

`RouteDeps` 交差型の末尾（`AssessmentRoutesDeps;` を `AssessmentRoutesDeps & ListeningRoutesDeps;` に変更）:

```ts
export type RouteDeps =
  SystemRoutesDeps & ConverseRoutesDeps & SessionRoutesDeps & MenuRoutesDeps &
  SettingsRoutesDeps & LibraryRoutesDeps & CoachRoutesDeps & SentenceRoutesDeps &
  ChunkRoutesDeps & ProgressRoutesDeps & PlacementRoutesDeps & MetricsRoutesDeps &
  AssessmentRoutesDeps & ListeningRoutesDeps;
```

`makeFetchHandler` の `routes` 配列末尾（`...makeAssessmentRoutes(deps),` の後）に追加:

```ts
    ...makeListeningRoutes(deps),
```

- [ ] **Step 11: `index.ts` に realDeps 配線を追加する**

`app/server/index.ts` の paths import に `LISTENING_DIR` を追加:

```ts
import { ensureDirs, LISTENING_DIR, RECORDINGS_DIR, sessionLogPath } from "./paths";
```

listening 用の import を追加（`makeAssessmentStore` の import 行の付近）:

```ts
import { loadListening, findListening } from "./listening";
import { makeListeningStore } from "./listening-store";
```

ストア生成（`const assessmentStore = makeAssessmentStore(db);` の後）:

```ts
const listeningStore = makeListeningStore(db);
```

`realDeps` オブジェクトの末尾（`generateMonthlyReport:` の行の後）に追加:

```ts
  listListening: () => loadListening(LISTENING_DIR),
  findListening: (id) => findListening(id),
  listeningStore,
```

- [ ] **Step 12: ルートテストと全テストが通ることを確認する**

Run: `cd app && bun test`
Expected: 全 PASS（`routes-listening.test.ts` を含む。`route-deps.ts` の型追加で既存ルートテストも維持）

- [ ] **Step 13: 検証ゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: 全 PASS / 型エラーなし

- [ ] **Step 14: コミット**

```bash
git add app/server/listening-store.ts app/server/db.ts app/server/routes/listening.ts app/server/routes.ts app/server/index.ts app/server/__tests__/helpers/route-deps.ts app/server/__tests__/listening-store.test.ts app/server/__tests__/routes-listening.test.ts
git commit -m "feat: 多聴の聴取ログストアと素材一覧・本文・記録の3エンドポイントを追加"
```

---

## Task 3: 生成 CLI — listening モード（vocabConstraint 連動）

**Files:**
- Modify: `app/server/content-gen.ts`
- Modify: `scripts/generate-content.ts`
- Test: `app/server/__tests__/content-gen.test.ts`

**Interfaces:**
- Consumes: `loadListening`（`listening.ts`）、`parseListeningFile`（`listening.ts`・テストのラウンドトリップ）、`vocabConstraint`（`progression.ts`）、`extractJson`（`coach.ts`）、`ClaudeRunner`（`converse.ts`）、`LISTENING_DIR`（`paths.ts`）。
- Produces:
  - `content-gen.ts`: `export type NewListeningCandidate = { id: string; title: string; titleJa: string; paragraphs: string[] }`、`export function listeningToMarkdown(c: NewListeningCandidate & { domain: string; level: [number, number] }): string`、`export function validateListeningCandidate(parsed: unknown, existingIds: Set<string>, dir: string): NewListeningCandidate | null`、`export type GenListeningDeps = { runner: ClaudeRunner; listeningDir: string; dry: boolean; log?: (s: string) => void }`、`export async function genListening(deps: GenListeningDeps): Promise<void>`。
  - `generate-content.ts`: `listening` サブコマンド。

- [ ] **Step 1: ラウンドトリップ・バリデーションの失敗テストを書く**

`app/server/__tests__/content-gen.test.ts` の import に追加:

```ts
import { loadListening, parseListeningFile } from "../listening";
import {
  genListening, listeningToMarkdown, validateListeningCandidate,
} from "../content-gen";
```

（既存の `import { contentToMarkdown, genSentences, genTopics, validateNewSentences, validateTopicCandidate } from "../content-gen";` はそのまま。上の追加分を別行で足す。）

ファイル末尾に追記:

```ts
describe("content-gen / listeningToMarkdown", () => {
  test("parseListeningFile とラウンドトリップする", () => {
    const md = listeningToMarkdown({
      id: "coffee-shop", title: "A morning at the coffee shop", titleJa: "朝のカフェ",
      domain: "daily", level: [1, 3],
      paragraphs: ["I go to the same coffee shop every morning.", "The staff already know my order."],
    });
    const parsed = parseListeningFile(md)!;
    expect(parsed.id).toBe("coffee-shop");
    expect(parsed.domain).toBe("daily");
    expect(parsed.level).toEqual([1, 3]);
    expect(parsed.paragraphs).toHaveLength(2);
  });
});

describe("content-gen / validateListeningCandidate", () => {
  const BASE = {
    id: "team-standup", title: "Our daily standup", titleJa: "朝会",
    paragraphs: ["We meet at nine every morning.", "Each person shares what they did yesterday."],
  };

  test("正常系は NewListeningCandidate を返す", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-valid-"));
    const cand = validateListeningCandidate(BASE, new Set(), dir);
    expect(cand?.id).toBe("team-standup");
    expect(cand?.paragraphs).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("id が kebab-case でない / 空 title / 段落2未満 / 空段落は null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-bad-"));
    expect(validateListeningCandidate({ ...BASE, id: "Not_Kebab" }, new Set(), dir)).toBeNull();
    expect(validateListeningCandidate({ ...BASE, title: "  " }, new Set(), dir)).toBeNull();
    expect(validateListeningCandidate({ ...BASE, paragraphs: ["only one"] }, new Set(), dir)).toBeNull();
    expect(validateListeningCandidate({ ...BASE, paragraphs: ["ok", "  "] }, new Set(), dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("既存 id 集合との衝突・ファイル衝突は null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-dup-"));
    expect(validateListeningCandidate(BASE, new Set(["team-standup"]), dir)).toBeNull();
    writeFileSync(path.join(dir, "team-standup.md"), "x");
    expect(validateListeningCandidate(BASE, new Set(), dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `cd app && bun test content-gen.test.ts`
Expected: FAIL（`listeningToMarkdown` / `validateListeningCandidate` / `genListening` 未定義）

- [ ] **Step 3: `content-gen.ts` に listening 生成を実装する**

`app/server/content-gen.ts` の import を調整。`node:fs` の import に `mkdirSync` を追加:

```ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
```

`import { loadContent } from "./content";` の行の後に追加:

```ts
import { loadListening } from "./listening";
```

ファイル末尾（`genTopics` の後）に追加:

```ts
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

/**
 * AI 生成 listening 候補の厳格バリデーション（parseListeningFile とは別物 — 不正は静かにフォールバックせず候補全体を棄却）。
 * 検査: id(kebab-case・既存集合/ファイルと非衝突) / title・titleJa(空でない) / paragraphs(2件以上・すべて非空文字列)。
 * domain・level はプランで固定するためここでは検査しない。
 */
export function validateListeningCandidate(
  parsed: unknown, existingIds: Set<string>, dir: string,
): NewListeningCandidate | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Partial<NewListeningCandidate>;
  if (typeof c.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) return null;
  if (existingIds.has(c.id) || existsSync(path.join(dir, `${c.id}.md`))) return null;
  if (typeof c.title !== "string" || !c.title.trim()) return null;
  if (typeof c.titleJa !== "string" || !c.titleJa.trim()) return null;
  if (!Array.isArray(c.paragraphs) || c.paragraphs.length < 2) return null;
  if (!c.paragraphs.every((p) => typeof p === "string" && p.trim().length > 0)) return null;
  return { id: c.id, title: c.title.trim(), titleJa: c.titleJa.trim(), paragraphs: c.paragraphs.map((p) => p.trim()) };
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
      const { text } = await deps.runner(`Write the ${p.domain} listening script now.`, undefined, { systemPrompt: system });
      const parsed = extractJson<NewListeningCandidate>(text);
      cand = validateListeningCandidate(parsed, existingIds, deps.listeningDir);
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
```

- [ ] **Step 4: genListening の挙動テストを追加する**

`app/server/__tests__/content-gen.test.ts` 末尾に追記:

```ts
describe("content-gen / genListening", () => {
  function listeningJson(id: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      id, title: `Title ${id}`, titleJa: `タイトル${id}`,
      paragraphs: [`First paragraph of ${id}.`, `Second paragraph of ${id}.`],
      ...overrides,
    });
  }
  // LISTENING_PLAN の6件分（下帯3・上帯3）を順に返す
  const SIX = ["daily-lo", "biz-lo", "it-lo", "daily-hi", "biz-hi", "it-hi"].map((id) => listeningJson(id));

  test("正常系: LISTENING_PLAN 分（6本）が listeningDir に書かれ loadListening で読める", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-run-"));
    const logs: string[] = [];
    await genListening({ runner: makeRunner(SIX), listeningDir: dir, dry: false, log: (s) => logs.push(s) });
    const items = loadListening(dir);
    expect(items).toHaveLength(6);
    // 下帯 [1,3] と上帯 [4,6] の両方が生成される
    expect(items.some((i) => i.level[0] === 1 && i.level[1] === 3)).toBe(true);
    expect(items.some((i) => i.level[0] === 4 && i.level[1] === 6)).toBe(true);
    expect(logs.some((l) => l.startsWith("完了:"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry=true は一切書かない", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-dry-"));
    const logs: string[] = [];
    await genListening({ runner: makeRunner(SIX), listeningDir: dir, dry: true, log: (s) => logs.push(s) });
    expect(loadListening(dir)).toHaveLength(0);
    expect(logs.some((l) => l.includes("--dry"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("下帯は systemPrompt に高頻度語彙制約(word families)が入り、上帯には入らない", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-vocab-"));
    const { runner, seen } = makeCapturingRunner(SIX);
    await genListening({ runner, listeningDir: dir, dry: true });
    // LISTENING_PLAN の先頭3件が下帯（vocabStage 2）、後半3件が上帯（vocabStage 5）
    expect(seen[0].systemPrompt).toContain("word families");
    expect(seen[3].systemPrompt).not.toContain("word families");
    expect(seen[3].systemPrompt).not.toMatch(/\bnull\b/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("不正候補が2回続くと書き込みゼロで throw（オーファン無し）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-fail-"));
    const bad = listeningJson("ok-id", { paragraphs: ["only one"] }); // 段落2未満で検証NG
    await expect(
      genListening({ runner: makeRunner([SIX[0], SIX[1], bad, bad]), listeningDir: dir, dry: false }),
    ).rejects.toThrow();
    expect(loadListening(dir)).toHaveLength(0); // 先に検証を通った候補も書かれない
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 5: `scripts/generate-content.ts` に listening サブコマンドを追加する**

import 群を更新:

```ts
import { genSentences, genTopics, genListening } from "../app/server/content-gen";
```

```ts
import { SENTENCES_FILE, SCENARIOS_DIR, TOPICS_DIR, LISTENING_DIR } from "../app/server/paths";
```

`main()` の分岐に `topics` の後、`else` の前に追加:

```ts
  } else if (sub === "listening") {
    await genListening({ runner, listeningDir: LISTENING_DIR, dry, log: console.log });
```

使い方メッセージを更新:

```ts
    console.error("使い方: bun scripts/generate-content.ts <sentences|topics|listening> [--dry]");
```

先頭のコメントブロックにも1行追加（`topics` の行の後）:

```ts
 *   bun scripts/generate-content.ts listening [--dry]  # 多聴素材を6本（3ドメイン×上下2帯）生成
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `cd app && bun test content-gen.test.ts`
Expected: PASS

- [ ] **Step 7: 検証ゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: 全 PASS / 型エラーなし

- [ ] **Step 8: コミット**

```bash
git add app/server/content-gen.ts scripts/generate-content.ts app/server/__tests__/content-gen.test.ts
git commit -m "feat: 多聴素材の生成CLIモード（listening・vocabConstraint連動）を追加"
```

---

## Task 4: クライアント — ListeningScreen ＋ nav ＋ api ＋ i18n

**Files:**
- Create: `app/client/src/api/listening.ts`
- Modify: `app/client/src/api/index.ts`
- Modify: `app/client/src/i18n.ts`
- Create: `app/client/src/screens/ListeningScreen.tsx`
- Modify: `app/client/src/App.tsx`

**Interfaces:**
- Consumes: `extractErrorMessage`（`api/http.ts`）、`fetchProgressSummary`（`api/progress.ts`・`ProgressSummary.stage`）、`fetchTalkExplanation`（`api/coach.ts`）、`playTtsCached`（`api/tts.ts`・バレル経由）、`stopPlayback`（`audio.ts`）、`useLoad` / `useExplain`、`STR` / `Lang`、`Banner` / `Button` / `Card`（`ui/`）。
- Produces:
  - `api/listening.ts`: `export type ListeningMeta = { id: string; title: string; titleJa: string; domain: "daily"|"business"|"it"; level: [number, number] }`、`export type ListeningDetail = ListeningMeta & { paragraphs: string[] }`、`export async function fetchListeningLibrary(): Promise<{ items: ListeningMeta[]; weeklyCount: number }>`、`export async function fetchListeningItem(id: string): Promise<ListeningDetail>`、`export async function logListening(itemId: string): Promise<{ weeklyCount: number }>`。
  - `i18n.ts`: `nav.listening`、`listeningScreen` サブ辞書。
  - `screens/ListeningScreen.tsx`: `export function ListeningScreen({ lang }: { lang: Lang }): JSX.Element`。
  - `App.tsx`: `Mode` に `{ kind: "listening" }`。

- [ ] **Step 1: `api/listening.ts` を作成する**

`app/client/src/api/listening.ts` を新規作成:

```ts
import { extractErrorMessage } from "./http";

export type ListeningMeta = {
  id: string; title: string; titleJa: string;
  domain: "daily" | "business" | "it"; level: [number, number];
};
export type ListeningDetail = ListeningMeta & { paragraphs: string[] };

export async function fetchListeningLibrary(): Promise<{ items: ListeningMeta[]; weeklyCount: number }> {
  const res = await fetch("/api/listening");
  if (!res.ok) throw new Error(`listening failed: ${await extractErrorMessage(res)}`);
  return (await res.json()) as { items: ListeningMeta[]; weeklyCount: number };
}

export async function fetchListeningItem(id: string): Promise<ListeningDetail> {
  const res = await fetch(`/api/listening/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`listening item failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { item: ListeningDetail }).item;
}

/** 1回の聴取を記録し、更新後の「今週n本」を返す（情報表示のみ・ノルマなし）。 */
export async function logListening(itemId: string): Promise<{ weeklyCount: number }> {
  const res = await fetch("/api/listening/log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemId }),
  });
  if (!res.ok) throw new Error(`listening log failed: ${await extractErrorMessage(res)}`);
  return (await res.json()) as { weeklyCount: number };
}
```

- [ ] **Step 2: バレルに追加する**

`app/client/src/api/index.ts` の末尾（`export * from "./assessment";` の後）に追加:

```ts
export * from "./listening";
```

- [ ] **Step 3: `i18n.ts` に nav キーと ListeningScreenStrings を追加する**

`NavStrings` に `listening` を追加（`type NavStrings = ...` の行）:

```ts
type NavStrings = { nav: { home: string; placement: string; free: string; library: string; sentences: string; listening: string; progress: string } };
```

`FreeTalkScreenStrings` の型定義の後に `ListeningScreenStrings` を追加:

```ts
type ListeningScreenStrings = { listeningScreen: {
  title: string; desc: string;
  loading: string; retry: string; empty: string;
  weekCount: (n: number) => string;
  filterFit: string; filterAll: string;
  domain: { daily: string; business: string; it: string };
  open: string; back: string;
  play: string; playing: string; stop: string;
  showScript: string; scriptLoading: string;
  explainMore: string; explainLoading: string; explainError: string;
} };
```

`Strings` 交差の末尾（`& ShadowingStrings & LibraryStrings & RoleplayStrings & FreeTalkScreenStrings;`）を変更:

```ts
  & ShadowingStrings & LibraryStrings & RoleplayStrings & FreeTalkScreenStrings & ListeningScreenStrings;
```

`STR.en.nav` を更新（`sentences` の後に `listening` を追加）:

```ts
    nav: { home: "Home", placement: "Level Check", free: "Free Talk", library: "Library", sentences: "300 Sentences", listening: "Listening", progress: "Progress" },
```

`STR.en` の `freeTalkScreen: {...},` の直後（`ja:` ブロックに入る前、`en` オブジェクト末尾）に追加:

```ts
    listeningScreen: {
      title: "Listening Library",
      desc: "Short talks at your level. Listen first without the script — it trains your ear.",
      loading: "Loading…", retry: "Retry",
      empty: "No listening material for this filter yet.",
      weekCount: (n) => `${n} listens this week`,
      filterFit: "Your level", filterAll: "All",
      domain: { daily: "Daily", business: "Business", it: "IT" },
      open: "Listen", back: "← Back to list",
      play: "▶ Play", playing: "🔊 Playing…", stop: "⏹ Stop",
      showScript: "📄 Show script", scriptLoading: "Loading the script…",
      explainMore: "💡 Translation & notes", explainLoading: "Writing the translation and notes…",
      explainError: "Couldn't load the explanation. Please try again.",
    },
```

`STR.ja.nav` を更新:

```ts
    nav: { home: "ホーム", placement: "レベル測定", free: "自由会話", library: "ライブラリ", sentences: "暗記例文300", listening: "多聴", progress: "進捗" },
```

`STR.ja` の `freeTalkScreen: {...},` の直後（`ja` オブジェクト末尾）に追加:

```ts
    listeningScreen: {
      title: "多聴ライブラリ",
      desc: "レベルに合った短い英語を聞きます。まずはスクリプトを見ずに聞くと、耳が育ちます。",
      loading: "読み込み中…", retry: "再試行",
      empty: "この絞り込みに合う多聴素材がまだありません。",
      weekCount: (n) => `今週 ${n} 本`,
      filterFit: "自分のレベル", filterAll: "すべて",
      domain: { daily: "日常", business: "ビジネス", it: "IT" },
      open: "聞く", back: "← 一覧に戻る",
      play: "▶ 再生", playing: "🔊 再生中…", stop: "⏹ 停止",
      showScript: "📄 スクリプトを表示", scriptLoading: "スクリプトを読み込み中…",
      explainMore: "💡 日本語訳と解説", explainLoading: "日本語訳と解説を書いています…",
      explainError: "解説を取得できませんでした。もう一度お試しください。",
    },
```

- [ ] **Step 4: `ListeningScreen.tsx` を作成する**

`app/client/src/screens/ListeningScreen.tsx` を新規作成:

```tsx
import { useEffect, useRef, useState } from "react";
import {
  fetchListeningLibrary, fetchListeningItem, logListening, fetchProgressSummary, fetchTalkExplanation,
  playTtsCached, type ListeningMeta, type ListeningDetail,
} from "../api";
import { stopPlayback } from "../audio";
import { STR, type Lang } from "../i18n";
import { useLoad } from "../useLoad";
import { useExplain } from "../useExplain";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

type LibraryData = { items: ListeningMeta[]; weeklyCount: number; stage: number };

/** 一覧のレベル適合フィルタに使う stage を進捗サマリから、素材と週次カウントを listening API から同時取得する。 */
async function loadLibrary(): Promise<LibraryData> {
  const [lib, summary] = await Promise.all([fetchListeningLibrary(), fetchProgressSummary()]);
  return { items: lib.items, weeklyCount: lib.weeklyCount, stage: summary.stage };
}

/** 多聴ミニライブラリ。一覧（レベル適合フィルタ既定・全表示可）→ 再生（逐次TTS・スクリプト隠し既定）→ 聴取記録（情報表示のみ）。 */
export function ListeningScreen({ lang }: { lang: Lang }) {
  const t = STR[lang].listeningScreen;
  const { state, reload } = useLoad(loadLibrary);
  const [selected, setSelected] = useState<ListeningMeta | null>(null);
  // プレイヤーが聴取記録したら返ってくる最新の「今週n本」で表示を上書きする（一覧を再取得しない）
  const [weekOverride, setWeekOverride] = useState<number | null>(null);

  if (selected) {
    return <ListeningPlayer meta={selected} lang={lang} onListened={setWeekOverride} onBack={() => setSelected(null)} />;
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
        <ListeningList
          data={state.data} lang={lang}
          weekCount={weekOverride ?? state.data.weeklyCount}
          onOpen={setSelected}
        />
      )}
    </div>
  );
}

/** 一覧: レベル適合フィルタ（既定）↔ 全表示トグル。週次カウントは情報表示（ノルマなし）。 */
function ListeningList({ data, lang, weekCount, onOpen }: {
  data: LibraryData; lang: Lang; weekCount: number; onOpen: (m: ListeningMeta) => void;
}) {
  const t = STR[lang].listeningScreen;
  const [showAll, setShowAll] = useState(false);
  const shown = showAll
    ? data.items
    : data.items.filter((it) => it.level[0] <= data.stage && data.stage <= it.level[1]);
  return (
    <>
      <p className="text-sm text-muted">{t.weekCount(weekCount)}</p>
      <div className="lang-toggle" role="group" aria-label={t.filterFit}>
        <button className={!showAll ? "is-active" : ""} onClick={() => setShowAll(false)}>{t.filterFit}</button>
        <button className={showAll ? "is-active" : ""} onClick={() => setShowAll(true)}>{t.filterAll}</button>
      </div>
      {shown.length === 0 && <p className="text-muted">{t.empty}</p>}
      {shown.map((it) => (
        <Card
          key={it.id}
          header={<>{it.titleJa || it.title}{" "}<span className="text-sm text-muted">{t.domain[it.domain]}</span></>}
        >
          <Button variant="primary" onClick={() => onOpen(it)}>{t.open}</Button>
        </Card>
      ))}
    </>
  );
}

/** 1素材の再生画面。本文（paragraphs）を取得してから逐次プレイヤーを描画する。 */
function ListeningPlayer({ meta, lang, onListened, onBack }: {
  meta: ListeningMeta; lang: Lang; onListened: (weeklyCount: number) => void; onBack: () => void;
}) {
  const t = STR[lang].listeningScreen;
  const { state, reload } = useLoad(() => fetchListeningItem(meta.id));
  return (
    <div className="stack">
      <Button variant="secondary" onClick={onBack}>{t.back}</Button>
      <div className="hero"><h2 className="hero-title">{meta.titleJa || meta.title}</h2></div>
      {state.status === "loading" && <p className="text-muted">{t.scriptLoading}</p>}
      {state.status === "error" && (
        <Banner kind="error" action={<Button onClick={reload}>{t.retry}</Button>}>{state.error}</Banner>
      )}
      {state.status === "ready" && <ListeningPlayback item={state.data} lang={lang} onListened={onListened} />}
    </div>
  );
}

/**
 * 逐次TTS再生本体。段落ごとに playTtsCached を await 連鎖で順次再生する。
 * - stop: abortRef を立ててから stopPlayback()。stopPlayback は再生中 Promise を「正常終了扱い」で
 *   resolve するため await が戻る → ループが次段落へ進んでしまう。abortRef の後段チェックで確実に止める。
 * - unmount: aliveRef=false + abortRef=true + stopPlayback() でループと setState を安全に停止。
 * 全段落を通し再生し終えたときだけ聴取を記録する（情報表示のみ）。
 */
function ListeningPlayback({ item, lang, onListened }: {
  item: ListeningDetail; lang: Lang; onListened: (weeklyCount: number) => void;
}) {
  const t = STR[lang].listeningScreen;
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const [showScript, setShowScript] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const aliveRef = useRef(true);
  const abortRef = useRef(false);
  const explainer = useExplain(() => fetchTalkExplanation(item.paragraphs.join("\n\n")));

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current = true;
      stopPlayback();
    };
  }, []);

  async function playAll() {
    setErrorMsg("");
    abortRef.current = false;
    for (let i = 0; i < item.paragraphs.length; i++) {
      if (abortRef.current || !aliveRef.current) { setPlayingIdx(null); return; }
      setPlayingIdx(i);
      try {
        await playTtsCached(item.paragraphs[i]);
      } catch (err) {
        if (!aliveRef.current) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setPlayingIdx(null);
        return;
      }
    }
    if (abortRef.current || !aliveRef.current) { setPlayingIdx(null); return; }
    setPlayingIdx(null);
    // 通し再生の完了 → 聴取を記録（記録失敗は再生体験を妨げない）
    try {
      const { weeklyCount } = await logListening(item.id);
      if (aliveRef.current) onListened(weeklyCount);
    } catch (err) {
      console.warn("listening log failed:", err);
    }
  }

  function stop() {
    abortRef.current = true;
    stopPlayback();
    setPlayingIdx(null);
  }

  const isPlaying = playingIdx !== null;
  return (
    <div className="stack">
      <p className="text-muted">{t.desc}</p>
      {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
      {!isPlaying && <Button variant="primary" onClick={playAll}>{t.play}</Button>}
      {isPlaying && <Button variant="secondary" onClick={stop}>{t.stop}</Button>}
      {isPlaying && <p className="text-sm text-muted">{t.playing}</p>}
      {!showScript && <Button variant="secondary" onClick={() => setShowScript(true)}>{t.showScript}</Button>}
      {showScript && (
        <>
          {item.paragraphs.map((p, i) => (
            <Card key={i} className="reading-text">{p}</Card>
          ))}
          {explainer.state.status === "idle" && (
            <Button variant="ghost" onClick={explainer.request}>{t.explainMore}</Button>
          )}
          {explainer.state.status === "loading" && <p className="text-sm text-muted">{t.explainLoading}</p>}
          {explainer.state.status === "error" && (
            <p className="text-sm text-muted">{t.explainError}<Button variant="ghost" onClick={explainer.request}>{t.retry}</Button></p>
          )}
          {explainer.state.status === "done" && <p className="sentence-explain text-sm">{explainer.state.text}</p>}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: `App.tsx` に nav を5箇所配線する**

(1) import（`SentencesScreen` の import の後）:

```tsx
import { ListeningScreen } from "./screens/ListeningScreen";
```

(2) `Mode` union に `listening` を追加:

```tsx
type Mode = { kind: "start" } | { kind: "free" } | { kind: "session"; source: MenuSource } | { kind: "library" } | { kind: "sentences" } | { kind: "listening" } | { kind: "placement" } | { kind: "progress" };
```

(3) `navItems` の `sentences` エントリの後に追加:

```tsx
    { key: "listening", icon: "🎧", label: t.nav.listening, active: mode.kind === "listening", go: () => setMode({ kind: "listening" }) },
```

(4) 描画分岐（`{mode.kind === "sentences" && <SentencesScreen lang={lang} />}` の後）に追加:

```tsx
      {mode.kind === "listening" && <ListeningScreen lang={lang} />}
```

（(5) NavStrings キーは Task 4 Step 3 の i18n 変更で対応済み。）

- [ ] **Step 6: 型チェックとビルドが通ることを確認する**

Run: `cd app && bun run typecheck`
Expected: 型エラーなし（`STR.en` / `STR.ja` 両方に `listeningScreen` と `nav.listening` があること・`Mode` の網羅性）

Run: `cd app/client && bun run build`
Expected: `tsc --noEmit && vite build` が成功

- [ ] **Step 7: サーバ側テストの非回帰を確認する**

Run: `cd app && bun test`
Expected: 全 PASS（クライアント変更のみだが念のため）

- [ ] **Step 8: コミット**

```bash
git add app/client/src/api/listening.ts app/client/src/api/index.ts app/client/src/i18n.ts app/client/src/screens/ListeningScreen.tsx app/client/src/App.tsx
git commit -m "feat: 多聴ライブラリ画面（逐次再生・レベル適合フィルタ・聴取記録）とnav追加"
```

---

## Task 5: 素材生成実行 ＋ 検収

**このタスクだけ TDD ではなく「生成 → 検証」型。** LLM 生成は実行時に走る（Claude Agent SDK・サブスクリプション認証）。生成物を人手確認して commit し、リポジトリ素材の整合性テストで固定する。

**Files:**
- Create: `content/listening/*.md`（生成物・6本）
- Test: `app/server/__tests__/listening-content.test.ts`

**Interfaces:**
- Consumes: `loadListening`（`listening.ts`）、`DOMAINS`（`content.ts`）、`LISTENING_DIR`（`paths.ts`）。
- Produces: `content/listening/` に6本の `*.md`（frontmatter: id/title/title_ja/domain/level、本文: 散文スクリプト）。

- [ ] **Step 1: まず dry-run で生成内容を確認する**

Run: `cd app && OPENAI_API_KEY 不要。Claude Agent SDK のサブスクリプション認証が有効な環境で:`
```bash
bun ../scripts/generate-content.ts listening --dry
```
Expected: 6件の候補ログ（`+ listening: <id> [<domain>/<lo>-<hi>] <title>`）が出て「--dry のため書き込みません」で終了。検証NGが出た場合は自動で1回再生成する。2回連続NGなら throw（何も書かれない）。

- [ ] **Step 2: 本生成してファイルを書き出す**

Run:
```bash
cd app && bun ../scripts/generate-content.ts listening
```
Expected: `content/listening/` に6本の `.md` が生成され「完了: 6 本の多聴素材を追加しました。」

- [ ] **Step 3: 生成物を人手確認する**

確認観点（それぞれ目視）:
- **何をするか**: 各ファイルの本文が散文スクリプト（箇条書き・対話記号なし）で、段落が空行区切りで2〜5個あること。
- **なぜ必要か**: 下帯（level [1,3]）の語彙が高頻度語中心で、稀語・イディオムが混ざっていないこと（vocabConstraint の実効確認）。上帯（[4,6]）はより自然で複雑でよい。
- **どう書くか**: frontmatter の `domain` が daily/business/it、`level` が [1,3] または [4,6]、`title_ja` が入っていること。不適切・不自然な素材があれば当該ファイルを削除して `bun ../scripts/generate-content.ts listening` を再実行（既存 id は衝突回避され、不足分だけは埋まらないため、必要なら削除して6本になるよう再生成する）。

Run（生成結果の一覧確認）:
```bash
ls content/listening/ && grep -h "^level:\|^domain:\|^title_ja:" content/listening/*.md
```

- [ ] **Step 4: リポジトリ素材の整合性テストを書く**

`app/server/__tests__/listening-content.test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import { DOMAINS } from "../content";
import { loadListening } from "../listening";
import { LISTENING_DIR } from "../paths";

/** リポジトリ同梱の多聴素材（content/listening）の整合性 */
describe("listening content integrity", () => {
  const items = loadListening(LISTENING_DIR);

  test("6本以上パースできる", () => {
    expect(items.length).toBeGreaterThanOrEqual(6);
  });

  test("3ドメインすべてに1本以上ある", () => {
    for (const domain of DOMAINS) {
      expect(items.filter((i) => i.domain === domain).length).toBeGreaterThanOrEqual(1);
    }
  });

  test("下帯（stage3 に適合）と上帯（stage5 に適合）の両方に素材がある", () => {
    expect(items.some((i) => i.level[0] <= 3 && 3 <= i.level[1])).toBe(true);
    expect(items.some((i) => i.level[0] <= 5 && 5 <= i.level[1])).toBe(true);
  });

  test("全 item は段落2以上・level が 1..6 の有効範囲", () => {
    for (const it of items) {
      expect(it.paragraphs.length).toBeGreaterThanOrEqual(2);
      expect(it.level[0]).toBeGreaterThanOrEqual(1);
      expect(it.level[1]).toBeLessThanOrEqual(6);
      expect(it.level[0]).toBeLessThanOrEqual(it.level[1]);
    }
  });
});
```

- [ ] **Step 5: 整合性テストが通ることを確認する**

Run: `cd app && bun test listening-content.test.ts`
Expected: PASS（6本・3ドメイン・上下帯・段落2以上）

- [ ] **Step 6: 全体検証ゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: 全 PASS / 型エラーなし

Run: `cd app/client && bun run build`
Expected: 成功

- [ ] **Step 7: コミット**

```bash
git add content/listening/ app/server/__tests__/listening-content.test.ts
git commit -m "feat: 多聴素材6本（3ドメイン×上下2帯）を生成し整合性テストを追加"
```

---

## Self-Review

**1. Spec coverage（P6-2 の各要件 → タスク対応）:**
- ContentItem を広げず ListeningItem 独立型＋parseListeningFile 新設・frontmatter 共有ヘルパ切り出し → **Task 1**。
- `content/listening/*.md`（level帯・domain・title_ja）・paths.ts に LISTENING_DIR → **Task 1**（DIR）/ **Task 5**（素材）。
- 初期素材を生成 CLI（listening モード・vocabConstraint 連動）で6本 → **Task 3**（実装）/ **Task 5**（実行）。
- 音声: 段落分割＋逐次再生制御（await 連鎖・停止・アンマウント安全）は新規 → **Task 4**（`ListeningPlayback`）。段落ごと `playTtsCached` はキャッシュ流用。
- サーバ: routes/listening.ts（R1 規約）・素材一覧/本文取得/聴取ログの3エンドポイント・listening-store.ts（ensureListeningSchema + insertReturningId・db.ts に合成1行）→ **Task 2**。
- クライアント: ListeningScreen 新設・nav 5箇所・ListeningScreenStrings（EN/JA）・一覧（stage 適合フィルタ既定・全表示可）→再生（スクリプト隠し既定・表示ボタン・訳解説 useExplain 流用）→聴取記録（情報表示のみ）・api/listening.ts バレル1行 → **Task 4**。
- 研究制約（ノルマ・未達表示なし・記録は情報的）→ 全タスク（Global Constraints）。weekCount は情報表示のみ。
- リデザイン統合しない（Shadowing と供給経路別）→ 別ファイル・別型で新設（統合しない）。

**2. Placeholder scan:** 各コード step に実コードを記載済み。「適切なエラー処理」等の曖昧表現なし。テストは実コード。生成素材の本文のみ実行時生成（Task 5）で、これは spec 指定どおり（プロンプトと検証ロジックは Task 3 に完全記載）。

**3. Type consistency:**
- `ListeningItem`（server）は `{ id, title, titleJa, domain, level, paragraphs }` で Task 1/2/3 一貫。
- `ListeningStore` の `log(itemId, ymd)` / `countSince(fromYmd)` は Task 2 の store・route・fake で一致。route は `localYmd(now)` を log に、`weekStartYmd(now)=addDaysYmd(localYmd(now),-6)` を countSince に渡す。
- client `ListeningMeta` / `ListeningDetail`（`ListeningMeta & { paragraphs }`）は Task 4 の api・画面で一致。一覧レスポンスは paragraphs を含まない（route が `Omit`）→ `ListeningMeta`、本文取得は `ListeningDetail`。
- `fetchProgressSummary().stage` は既存 `ProgressSummary`（実在・確認済み）。
- `playTtsCached` はバレル（`api/index.ts` → `./tts`）経由で `../api` から import 可能（確認済み）。
- nav 追加は Mode union / navItems / 描画分岐 / import（App.tsx 4箇所）＋ NavStrings キー（i18n）で計5箇所、spec と一致。

**懸念・注意（実装者向け）:**
- ルート順序: `exact GET /api/listening` → `POST /api/listening/log` → `prefix GET /api/listening/`。prefix は末尾スラッシュ必須なので `/api/listening`（exact）と競合せず、log は POST なので prefix(GET) と競合しない。
- `route-deps.ts` の `makeTestDeps` に3項を追加しないと **全ルートテストが型エラー**になる（RouteDeps 交差のため）。Task 2 Step 8 で必ず対応。
- Task 5 の生成は環境依存（Claude Agent SDK 認証）。CI では実行できないため、生成物を commit したうえで整合性テストが緑になることを確認する。
