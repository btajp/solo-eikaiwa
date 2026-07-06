# P1: 会話系の日本語支援 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自由会話・ロールプレイ画面に、AI発話ごとの「訳」ボタン・「言い方ヒント」入力・ロールプレイ開始フレーズ提示を追加し、会話系の日本語支援ゼロ地帯を解消する。

**Architecture:** サーバは R1 の機能別ルータ規約に従い `routes/coach.ts` に軽量エンドポイントを2本追加する（訳のみの `/api/coach/translate`＝ハッシュキャッシュ、会話コンテキスト付き `/api/coach/phrase-hint`＝キャッシュなし）。クライアントは `FreeTalkScreen.tsx` に訳ボタンとヒント入力を足す。`RoleplayScreen` は `FreeTalkScreen` を内包しているため、この2機能は自由会話とロールプレイの両方に同時に効く。開始フレーズは `content/scenarios/*.md` に追記し、`parseContentFile` が `ContentItem.starters` として拾い、既存の `block.params.scenario` 経由でクライアントに自動で流れる。

**Tech Stack:** Bun + TypeScript（サーバ）、bun:sqlite、`@anthropic-ai/claude-agent-sdk`（`makeClaudeRunner`）、React + Vite（クライアント）、bun:test。

## Global Constraints

以下は全タスク共通。各タスクの要件に暗黙に含まれる。

- **研究制約（binding）**: 情報的フィードバックのみ。訳・ヒントはユーザーの明示的操作（ボタン押下・テキスト入力）でのみ表示し、自動では出さない。訂正・採点・判定・警告調の文言は導入しない。プロンプトは学習者の英語を「直す」のではなく、求められた意味の訳/言い方を提供する（need-based learning）。
- **HTTP additive のみ**: 既存エンドポイントの request/response 契約は変更しない。ハンドラ内部のリファクタ（挙動不変）は可。
- **R1 ルータ規約**: 新エンドポイントは `app/server/routes/coach.ts` にハンドラ＋テーブルエントリを追加。`CoachRoutesDeps` を狭く拡張し、`app/server/__tests__/helpers/route-deps.ts` の `makeTestDeps` に `satisfies` を維持したままフェイクを追加する（`as` によるアサーション禁止）。テストは `app/server/__tests__/routes-coach.test.ts` に足す。
- **LLM 呼び出し規約**: プロンプト文面と生成関数は `app/server/coach.ts` に置き、既存の `defaultRunner: ClaudeRunner = makeClaudeRunner(query)` を使う。JSON 出力は既存の `extractJson<T>()` でパースし、失敗時フォールバックを持つ。
- **クライアント規約**: これらは「マウント時ロード」ではなく「ユーザー操作トリガのアクション」なので `useLoad` は使わず、`ShadowingScreen.tsx` の解説ボタン（ローカル state + `aliveRef` ガード）と同じイディオムに倣う。日付操作は発生しないため `dates.ts` は不要。
- **UI 文言**: 新 UI 文言は日本語ハードコードで既存の会話系画面（`FreeTalkScreen`/`RoleplayScreen`）に合わせる。i18n 辞書（`i18n.ts`）への追加はしない（P4 で一括 i18n 化予定のため二重作業を避ける）。
- **コミット**: Conventional Commits（`feat:` 等）。1タスク1コミット。
- **各タスク末尾の検証ゲート（3コマンドすべて緑を確認してからコミット）**:
  - `cd app && bun test` → Expected: すべて pass（0 fail）
  - `cd app && bun run typecheck` → Expected: エラーなし
  - `cd app/client && bun run build` → Expected: vite build 成功
- リポジトリ規約: `data/` 配下やローカル生成物・秘密情報には触れない。

---

## タスク概要

1. **サーバ: `/api/coach/translate`（AI発話の訳のみ・ハッシュキャッシュ）** — TDD。`talk-explain` と共通の hash-cache ヘルパを抽出して両者で共有。
2. **サーバ: `/api/coach/phrase-hint`（言い方ヒント・会話コンテキスト付き）** — TDD。キャッシュなしの新エンドポイント。
3. **クライアント: FreeTalkScreen の AI発話ごと「訳」ボタン** — 自由会話・ロールプレイ両方に効く。
4. **クライアント: FreeTalkScreen の「言い方ヒント」入力** — テキスト入力のみ（音声入力は本タスクではスコープ外）。
5. **ロールプレイの開始フレーズ提示** — `content/scenarios/*.md` に `> ` 行を追記し、`ContentItem.starters` として `RoleplayScreen` に表示。

---

### Task 1: サーバ `/api/coach/translate`（AI発話の訳のみ・ハッシュキャッシュ）

AI発話バブルの「訳」ボタン用に、英語1発話を日本語訳のみに変換する軽量エンドポイントを追加する。既存 `/api/coach/talk-explain`（訳＋表現解説）の軽量版。本文 sha256 をキーに専用テーブル `utterance_translations` へキャッシュする（`talk_explanations` と別テーブルにするのは、同一本文でも「訳のみ」と「訳＋解説」が別内容になりキー衝突を避けるため）。

**Files:**
- Modify: `app/server/coach.ts`（訳のみプロンプト + `generateUtteranceTranslation` を追加）
- Modify: `app/server/db.ts`（`utterance_translations` テーブル + `makeTranslationCache` を追加。`makeTalkExplainCache` と共通の `makeHashTextCache` ヘルパへ寄せる）
- Modify: `app/server/routes/coach.ts`（`respondHashCached` ヘルパを抽出し `talk-explain` を移行、`translate` ルートを追加、`CoachRoutesDeps` に `translate`/`translationCache` を追加）
- Modify: `app/server/index.ts`（`translate`/`translationCache` を実装で配線）
- Modify: `app/server/__tests__/helpers/route-deps.ts`（`makeTestDeps` に `translate`/`translationCache` のフェイクを追加）
- Test: `app/server/__tests__/routes-coach.test.ts`（`/api/coach/translate` のテストを追加）

**Interfaces:**
- Produces:
  - `generateUtteranceTranslation(args: { text: string }, runner?: ClaudeRunner): Promise<{ text: string }>`（coach.ts）
  - `makeTranslationCache(db: Database): TalkExplainCache`（db.ts）
  - HTTP `POST /api/coach/translate` — body `{ text: string }` → `{ text: string }`（日本語訳のみ）。空文字/3000超は400。
  - `CoachRoutesDeps.translate: (text: string) => Promise<{ text: string }>`
  - `CoachRoutesDeps.translationCache: TalkExplainCache`
- Consumes: 既存の `TalkExplainCache`（db.ts）、`extractJson`/`defaultRunner`（coach.ts）、`createHash`/`json`/`parseJsonBody`/`exact`（routes 層）。

- [ ] **Step 1: 失敗テストを書く**

`app/server/__tests__/routes-coach.test.ts` の末尾（最後の `});` の後）に以下の describe を追加する。

```ts
describe("routes: AI発話の訳（translate）", () => {
  test("POST /api/coach/translate は訳を生成して返しハッシュキーで保存する", async () => {
    const saved: Array<{ hash: string; text: string }> = [];
    let generateCalls = 0;
    const { deps } = makeTestDeps({
      translate: async () => { generateCalls++; return { text: "私はたいていコーヒーで一日を始めます。" }; },
      translationCache: makeFakeTalkExplainCache({
        get: () => null,
        save: (hash, text) => { saved.push({ hash, text }); },
      }),
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/coach/translate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "I usually start my day with coffee." }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe("私はたいていコーヒーで一日を始めます。");
    expect(generateCalls).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("POST /api/coach/translate はキャッシュ命中時に生成しない", async () => {
    let generateCalls = 0;
    const { deps } = makeTestDeps({
      translate: async () => { generateCalls++; return { text: "x" }; },
      translationCache: makeFakeTalkExplainCache({
        get: () => "キャッシュ済みの訳",
        save: () => { throw new Error("must not save on cache hit"); },
      }),
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/coach/translate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Any line." }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe("キャッシュ済みの訳");
    expect(generateCalls).toBe(0);
  });

  test("POST /api/coach/translate は空文字・過長テキストに 400", async () => {
    const handler = makeFetchHandler(makeTestDeps().deps);
    const empty = await handler(new Request("http://x/api/coach/translate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "  " }),
    }));
    expect(empty.status).toBe(400);
    const tooLong = await handler(new Request("http://x/api/coach/translate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "a".repeat(3001) }),
    }));
    expect(tooLong.status).toBe(400);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `cd app && bun test routes-coach`
Expected: 追加した3テストが FAIL（ルート未実装のため 404 が返り、`expect(...).toBe(200)` が失敗。過長/空文字テストも 404 で 400 と一致せず失敗）。既存の coach テストは pass のまま。

- [ ] **Step 3: coach.ts に訳のみプロンプトと生成関数を追加**

`app/server/coach.ts` の `generateTalkExplanation`（`TALK_EXPLAIN_SYSTEM` のブロック）の直後に以下を追加する。

```ts
const TRANSLATE_SYSTEM = `You translate one short English line from a live conversation into natural Japanese for a Japanese learner (CEFR A2-B1).
Reply with ONLY the Japanese translation — no English, no notes, no labels, no quotes — plain text on a single line.
Do not correct or comment on the English; just translate its meaning naturally.
Do not use any tools — reply directly with text only.`;

/** AI発話の日本語訳のみを生成する（表現解説は付けない・routes 側で本文ハッシュをキーにキャッシュされる） */
export async function generateUtteranceTranslation(
  args: { text: string },
  runner: ClaudeRunner = defaultRunner,
): Promise<{ text: string }> {
  const { text } = await runner(args.text, undefined, { systemPrompt: TRANSLATE_SYSTEM });
  return { text: text.trim() };
}
```

- [ ] **Step 4: db.ts に `utterance_translations` テーブルと `makeTranslationCache` を追加**

`app/server/db.ts` の `openDb` 内、`talk_explanations` の `CREATE TABLE` 直後（`monthly_reports` の CREATE の前）に以下を追加する。

```ts
  db.run(`CREATE TABLE IF NOT EXISTS utterance_translations (
    hash TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    created TEXT NOT NULL
  )`);
```

続けて、既存の `makeTalkExplainCache` 関数（`export function makeTalkExplainCache(db: Database): TalkExplainCache { ... }` 全体）を、共通ヘルパへ寄せた次の3定義に置き換える（挙動は不変。`table` は内部定数のみで、外部入力を SQL に埋め込まないため安全）。

```ts
/** hash→text の単純キャッシュ実体（テーブル名だけが異なる複数キャッシュで共有する） */
function makeHashTextCache(db: Database, table: string): TalkExplainCache {
  return {
    get(hash) {
      const row = db.query<{ text: string }, [string]>(
        `SELECT text FROM ${table} WHERE hash = ?`,
      ).get(hash);
      return row?.text ?? null;
    },
    save(hash, text, created) {
      db.run(
        `INSERT INTO ${table} (hash, text, created) VALUES (?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET text = excluded.text, created = excluded.created`,
        [hash, text, created],
      );
    },
  };
}

export function makeTalkExplainCache(db: Database): TalkExplainCache {
  return makeHashTextCache(db, "talk_explanations");
}

/** AI発話の訳のキャッシュ（本文の sha256 をキーにする。talk_explanations とは別テーブル） */
export function makeTranslationCache(db: Database): TalkExplainCache {
  return makeHashTextCache(db, "utterance_translations");
}
```

- [ ] **Step 5: CoachRoutesDeps に deps を追加し、共通ヘルパで talk-explain と translate を配線**

`app/server/routes/coach.ts` の `CoachRoutesDeps` 型に、`talkExplainCache` フィールドの直後へ以下を追加する。

```ts
  /** AI発話の日本語訳のみを生成（実体は coach.ts、テストはフェイク） */
  translate: (text: string) => Promise<{ text: string }>;
  /** 訳のハッシュキャッシュ（実体は db.ts の utterance_translations、テストはフェイク） */
  translationCache: TalkExplainCache;
```

次に、既存の `handleTalkExplain` 関数（`async function handleTalkExplain(...) { ... }` 全体）を、共通ヘルパ `respondHashCached` に置き換える。

```ts
/** {text} を受け取りハッシュキャッシュ経由で {text} を返す共通ハンドラ（talk-explain / translate 共有） */
async function respondHashCached(
  req: Request,
  cache: TalkExplainCache,
  generate: (text: string) => Promise<{ text: string }>,
  cacheWarnLabel: string,
): Promise<Response> {
  const parsed = await parseJsonBody<{ text?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { text } = parsed.body;
  if (typeof text !== "string" || text.trim().length === 0) return json({ error: "text must be a non-empty string" }, 400);
  if (text.length > 3000) return json({ error: "text too long" }, 400);
  const hash = createHash("sha256").update(text).digest("hex");
  const cached = cache.get(hash);
  if (cached !== null) return json({ text: cached });
  const generated = await generate(text);
  // キャッシュ書き込み失敗は返却を妨げない
  try {
    cache.save(hash, generated.text, new Date().toISOString());
  } catch (err) {
    console.warn(cacheWarnLabel, String(err));
  }
  return json({ text: generated.text });
}
```

最後に `makeCoachRoutes` の return 配列の `talk-explain` の行を差し替え、`translate` の行を追加する。

```ts
    exact("POST", "/api/coach/talk-explain", (req) =>
      respondHashCached(req, deps.talkExplainCache, deps.explainTalk, "[coach] talk explanation cache write failed, continuing:")),
    exact("POST", "/api/coach/translate", (req) =>
      respondHashCached(req, deps.translationCache, deps.translate, "[coach] translation cache write failed, continuing:")),
```

- [ ] **Step 6: route-deps フェイクに `translate`/`translationCache` を追加**

`app/server/__tests__/helpers/route-deps.ts` の `makeTestDeps` の `deps` オブジェクト内、`talkExplainCache: makeFakeTalkExplainCache(),` の直後に以下を追加する。

```ts
    translate: async () => ({ text: "テスト訳" }),
    translationCache: makeFakeTalkExplainCache(),
```

- [ ] **Step 7: index.ts を実装で配線**

`app/server/index.ts` の import 文2箇所を修正する。

`./coach` の import 行を次に置き換える（`generateUtteranceTranslation` を追加。`generatePhraseHints` は Task 2 でこの行に足すので、ここでは含めない — Task 1 時点では未定義で typecheck が落ちるため）。

```ts
import { generateAeFeedback, generateModelTalk, generatePrepPack, generateReflection, generateSentenceExplanation, generateTalkExplanation, generateUtteranceTranslation, roleplayPrompt } from "./coach";
```

`./db` の import 行を次に置き換える。

```ts
import { makeLibraryStore, makeTalkExplainCache, makeTranslationCache, openDb } from "./db";
```

`realDeps` オブジェクト内、`talkExplainCache: makeTalkExplainCache(db),` の直後に以下を追加する。

```ts
  translate: (text) => generateUtteranceTranslation({ text }),
  translationCache: makeTranslationCache(db),
```

- [ ] **Step 8: テストを実行して緑を確認**

Run: `cd app && bun test routes-coach`
Expected: 追加した3テストが PASS。既存の talk-explain テスト（訳＋解説）も PASS のまま（内部ヘルパ移行で挙動不変）。

- [ ] **Step 9: 検証ゲート**

Run: `cd app && bun test` → Expected: 全 pass（0 fail）
Run: `cd app && bun run typecheck` → Expected: エラーなし
Run: `cd app/client && bun run build` → Expected: build 成功

- [ ] **Step 10: コミット**

```bash
git add app/server/coach.ts app/server/db.ts app/server/routes/coach.ts app/server/index.ts app/server/__tests__/helpers/route-deps.ts app/server/__tests__/routes-coach.test.ts
git commit -m "feat: AI発話の訳のみエンドポイント /api/coach/translate を追加（ハッシュキャッシュ）"
```

---

### Task 2: サーバ `/api/coach/phrase-hint`（言い方ヒント・会話コンテキスト付き）

会話に詰まったユーザーが「言いたいこと」を日本語で入力すると、使える英語表現を2〜3個提案するエンドポイント。直近の会話履歴をコンテキストとして受け取り、レジスターに合った言い方を返す（need-based learning。明示的要求ベースなので研究制約に抵触しない）。キャッシュは持たない（入力が自由文＋文脈依存でヒット率が低いため。既存の他エンドポイントもキャッシュ不要なものは持たない方針に合わせる）。

**Files:**
- Modify: `app/server/coach.ts`（ヒント用プロンプト + `generatePhraseHints` + `PhraseHint` 型を追加）
- Modify: `app/server/routes/coach.ts`（`handlePhraseHint` + ルート + `CoachRoutesDeps.phraseHint` を追加）
- Modify: `app/server/index.ts`（`phraseHint` を配線）
- Modify: `app/server/__tests__/helpers/route-deps.ts`（`makeTestDeps` に `phraseHint` フェイクを追加）
- Test: `app/server/__tests__/routes-coach.test.ts`（`/api/coach/phrase-hint` のテストを追加）

**Interfaces:**
- Consumes: Task 1 の `generateUtteranceTranslation` は不要。`extractJson`/`defaultRunner`（coach.ts）を使う。
- Produces:
  - `type PhraseHint = { en: string; ja: string }`（coach.ts）
  - `generatePhraseHints(args: { jaText: string; history?: Array<{ role: "you" | "ai"; text: string }> }, runner?: ClaudeRunner): Promise<{ suggestions: PhraseHint[] }>`（coach.ts）
  - HTTP `POST /api/coach/phrase-hint` — body `{ jaText: string; history?: Array<{ role: "you" | "ai"; text: string }> }` → `{ suggestions: Array<{ en: string; ja: string }> }`。`jaText` 空文字は400、1000超は400。`history` は任意（サーバ側で末尾6件までにトリム）。
  - `CoachRoutesDeps.phraseHint: (args: { jaText: string; history?: Array<{ role: "you" | "ai"; text: string }> }) => Promise<{ suggestions: Array<{ en: string; ja: string }> }>`

- [ ] **Step 1: 失敗テストを書く**

`app/server/__tests__/routes-coach.test.ts` の末尾に以下の describe を追加する。

```ts
describe("routes: 言い方ヒント（phrase-hint）", () => {
  test("POST /api/coach/phrase-hint は suggestions を返す", async () => {
    let receivedJa = "";
    let receivedHistoryLen = -1;
    const { deps } = makeTestDeps({
      phraseHint: async (args) => {
        receivedJa = args.jaText;
        receivedHistoryLen = args.history?.length ?? -1;
        return { suggestions: [
          { en: "I haven't tried that feature yet.", ja: "まだ試していない、の言い方" },
          { en: "That's still on my to-do list.", ja: "これからやる予定、のニュアンス" },
        ] };
      },
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/coach/phrase-hint", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jaText: "その機能はまだ試していません",
        history: [{ role: "ai", text: "Have you tried the new dashboard?" }],
      }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: Array<{ en: string; ja: string }> };
    expect(body.suggestions).toHaveLength(2);
    expect(body.suggestions[0].en).toContain("tried");
    expect(receivedJa).toBe("その機能はまだ試していません");
    expect(receivedHistoryLen).toBe(1);
  });

  test("POST /api/coach/phrase-hint は history 省略でも 200", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(new Request("http://x/api/coach/phrase-hint", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jaText: "少し考える時間をください" }),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { suggestions: unknown[] }).suggestions.length).toBeGreaterThan(0);
  });

  test("POST /api/coach/phrase-hint は jaText 空・過長で 400", async () => {
    const handler = makeFetchHandler(makeTestDeps().deps);
    const empty = await handler(new Request("http://x/api/coach/phrase-hint", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jaText: "  " }),
    }));
    expect(empty.status).toBe(400);
    const tooLong = await handler(new Request("http://x/api/coach/phrase-hint", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jaText: "あ".repeat(1001) }),
    }));
    expect(tooLong.status).toBe(400);
  });

  test("POST /api/coach/phrase-hint は不正な history 要素を除外して渡す", async () => {
    let receivedHistoryLen = -1;
    const { deps } = makeTestDeps({
      phraseHint: async (args) => { receivedHistoryLen = args.history?.length ?? -1; return { suggestions: [{ en: "ok", ja: "" }] }; },
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/coach/phrase-hint", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jaText: "はい",
        history: [
          { role: "you", text: "Hello" },
          { role: "bogus", text: "drop me" },
          { role: "ai", text: "Hi there" },
          { text: "no role" },
        ],
      }),
    }));
    expect(res.status).toBe(200);
    expect(receivedHistoryLen).toBe(2);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `cd app && bun test routes-coach`
Expected: 追加した4テストが FAIL（ルート未実装で 404）。既存テストは pass のまま。

- [ ] **Step 3: coach.ts にヒント用プロンプトと生成関数を追加**

`app/server/coach.ts` の Task 1 で追加した `generateUtteranceTranslation` の直後に以下を追加する。

```ts
export type PhraseHint = { en: string; ja: string };

const PHRASE_HINT_SYSTEM = `You help a Japanese learner (CEFR A2-B1) say something in English during a live conversation.
You receive: (1) what the learner wants to say, written in Japanese, and optionally (2) the recent conversation so far.
Offer 2-3 natural English ways to express that meaning, matching the register of the conversation.
Do NOT correct the learner and do NOT judge their level. Only provide the wording they asked for.
Reply with STRICT JSON only — no markdown fences, no commentary — exactly this shape:
{"suggestions":[{"en":"<natural, speakable English phrase or short sentence>","ja":"<日本語で使い方やニュアンスを1文>"}]}
Give 2 or 3 suggestions.
Do not use any tools — reply directly with text only.`;

/** 言い方ヒント: 言いたい日本語＋直近履歴から英語表現を2〜3個提案する（キャッシュしない） */
export async function generatePhraseHints(
  args: { jaText: string; history?: Array<{ role: "you" | "ai"; text: string }> },
  runner: ClaudeRunner = defaultRunner,
): Promise<{ suggestions: PhraseHint[] }> {
  const context = (args.history ?? [])
    .map((h) => `${h.role === "you" ? "Learner" : "Partner"}: ${h.text}`)
    .join("\n");
  const prompt = context
    ? `Recent conversation:\n${context}\n\nThe learner wants to say (in Japanese):\n${args.jaText}`
    : `The learner wants to say (in Japanese):\n${args.jaText}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: PHRASE_HINT_SYSTEM });
  const parsed = extractJson<{ suggestions: PhraseHint[] }>(text);
  if (parsed && Array.isArray(parsed.suggestions)) {
    const suggestions = parsed.suggestions
      .filter((s) => typeof s?.en === "string" && s.en && typeof s?.ja === "string")
      .map((s) => ({ en: s.en, ja: s.ja }));
    if (suggestions.length > 0) return { suggestions };
  }
  // パース失敗時のフォールバック: 素のテキストを1件に包んでUIに出せる形にする
  return { suggestions: [{ en: text.trim(), ja: "" }] };
}
```

- [ ] **Step 4: routes/coach.ts に deps・ハンドラ・ルートを追加**

`app/server/routes/coach.ts` の `CoachRoutesDeps` 型に、Task 1 で追加した `translationCache` の直後へ以下を追加する。

```ts
  /** 言い方ヒント（会話コンテキスト付き・実体は coach.ts、テストはフェイク） */
  phraseHint: (args: { jaText: string; history?: Array<{ role: "you" | "ai"; text: string }> }) => Promise<{ suggestions: Array<{ en: string; ja: string }> }>;
```

`respondHashCached` の直後に以下のハンドラを追加する。

```ts
async function handlePhraseHint(req: Request, deps: CoachRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ jaText?: unknown; history?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { jaText, history } = parsed.body;
  if (typeof jaText !== "string" || jaText.trim().length === 0) return json({ error: "jaText must be a non-empty string" }, 400);
  if (jaText.length > 1000) return json({ error: "jaText too long" }, 400);
  // 履歴は任意。role/text が揃った要素だけ残し、直近6件までに絞ってプロンプト肥大を防ぐ
  const safeHistory = Array.isArray(history)
    ? history
        .filter((h): h is { role: "you" | "ai"; text: string } =>
          !!h && typeof h === "object" && (h.role === "you" || h.role === "ai") && typeof h.text === "string")
        .slice(-6)
    : undefined;
  const result = await deps.phraseHint({ jaText, history: safeHistory });
  return json(result);
}
```

`makeCoachRoutes` の return 配列末尾（`translate` の行の後）に以下を追加する。

```ts
    exact("POST", "/api/coach/phrase-hint", (req) => handlePhraseHint(req, deps)),
```

- [ ] **Step 5: route-deps フェイクに `phraseHint` を追加**

`app/server/__tests__/helpers/route-deps.ts` の `makeTestDeps` の `deps` オブジェクト内、Task 1 で追加した `translationCache: makeFakeTalkExplainCache(),` の直後に以下を追加する。

```ts
    phraseHint: async () => ({ suggestions: [{ en: "Could you give me a moment?", ja: "少し時間をもらう言い方" }] }),
```

- [ ] **Step 6: index.ts を配線**

`app/server/index.ts` の `./coach` import 行に `generatePhraseHints` を追加する（次の行に置き換える）。

```ts
import { generateAeFeedback, generateModelTalk, generatePhraseHints, generatePrepPack, generateReflection, generateSentenceExplanation, generateTalkExplanation, generateUtteranceTranslation, roleplayPrompt } from "./coach";
```

`realDeps` オブジェクト内、Task 1 で追加した `translationCache: makeTranslationCache(db),` の直後に以下を追加する。

```ts
  phraseHint: (args) => generatePhraseHints(args),
```

- [ ] **Step 7: テストを実行して緑を確認**

Run: `cd app && bun test routes-coach`
Expected: 追加した4テストが PASS。既存テストも PASS のまま。

- [ ] **Step 8: 検証ゲート**

Run: `cd app && bun test` → Expected: 全 pass（0 fail）
Run: `cd app && bun run typecheck` → Expected: エラーなし
Run: `cd app/client && bun run build` → Expected: build 成功

- [ ] **Step 9: コミット**

```bash
git add app/server/coach.ts app/server/routes/coach.ts app/server/index.ts app/server/__tests__/helpers/route-deps.ts app/server/__tests__/routes-coach.test.ts
git commit -m "feat: 言い方ヒントエンドポイント /api/coach/phrase-hint を追加（会話コンテキスト付き）"
```

---

### Task 3: クライアント FreeTalkScreen の AI発話ごと「訳」ボタン

各 AI 発話バブルの下に「訳」ボタン（ghost）を出し、押すと `/api/coach/translate` で日本語訳のみを取得して表示する。`RoleplayScreen` は `FreeTalkScreen` を内包しているため、自由会話・ロールプレイの両方で有効になる。訳はユーザーがボタンを押したときだけ表示（自動表示しない）。

**Files:**
- Modify: `app/client/src/api.ts`（`fetchUtteranceTranslation` を追加）
- Modify: `app/client/src/screens/FreeTalkScreen.tsx`（訳の state と AI バブル下の訳UIを追加）

**Interfaces:**
- Consumes: Task 1 の `POST /api/coach/translate`。既存の `extractErrorMessage`（api.ts 内・非公開）、`Button`（`variant="ghost"`）。
- Produces: `fetchUtteranceTranslation(text: string): Promise<string>`（api.ts）

- [ ] **Step 1: api.ts に訳取得関数を追加**

`app/client/src/api.ts` の既存 `fetchTalkExplanation`（`/api/coach/talk-explain` を叩く関数）の直後に以下を追加する。

```ts
/** AI発話の日本語訳のみ（サーバ側で本文ハッシュキャッシュ・2回目以降は即返る） */
export async function fetchUtteranceTranslation(text: string): Promise<string> {
  const res = await fetch("/api/coach/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`translate failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}
```

- [ ] **Step 2: FreeTalkScreen に訳の import と state を追加**

`app/client/src/screens/FreeTalkScreen.tsx` の import 行 `import { converse, sttUpload, ttsFetch } from "../api";` を次に置き換える。

```ts
import { converse, fetchUtteranceTranslation, sttUpload, ttsFetch } from "../api";
```

`const aliveRef = useRef(true);` の直後に以下の state を追加する。

```ts
  // AI発話ごとの訳。キーは turns の index。値: undefined=未取得, "loading"=取得中, それ以外=訳文
  const [translations, setTranslations] = useState<Record<number, string>>({});
```

- [ ] **Step 3: 訳取得ハンドラを追加**

`onMainButton` 関数の閉じ `}` の直後（`return (` の前）に以下の関数を追加する。

```ts
  async function translateTurn(i: number, text: string) {
    setTranslations((m) => ({ ...m, [i]: "loading" }));
    try {
      const ja = await fetchUtteranceTranslation(text);
      if (aliveRef.current) setTranslations((m) => ({ ...m, [i]: ja }));
    } catch {
      if (aliveRef.current) setTranslations((m) => ({ ...m, [i]: "訳を取得できませんでした。もう一度お試しください。" }));
    }
  }
```

- [ ] **Step 4: AI バブルの描画に訳UIを追加**

`FreeTalkScreen.tsx` の `turns.map(...)` ブロックを次に置き換える。

```tsx
        {turns.map((t, i) => (
          <div key={i} className={`chat-row ${t.role === "you" ? "you" : "ai"}`}>
            <div className={`bubble ${t.role === "you" ? "bubble-you" : "bubble-ai"}`} aria-label={t.role === "you" ? "あなた" : "AI"}>{t.text}</div>
            {t.role === "ai" && (
              <div className="chat-translate">
                {translations[i] === undefined && (
                  <Button variant="ghost" onClick={() => translateTurn(i, t.text)}>訳</Button>
                )}
                {translations[i] === "loading" && <p className="text-sm text-muted">訳しています…</p>}
                {typeof translations[i] === "string" && translations[i] !== "loading" && (
                  <p className="sentence-explain text-sm">{translations[i]}</p>
                )}
              </div>
            )}
          </div>
        ))}
```

- [ ] **Step 5: 検証ゲート**

Run: `cd app && bun test` → Expected: 全 pass（0 fail）
Run: `cd app && bun run typecheck` → Expected: エラーなし
Run: `cd app/client && bun run build` → Expected: build 成功

- [ ] **Step 6: コミット**

```bash
git add app/client/src/api.ts app/client/src/screens/FreeTalkScreen.tsx
git commit -m "feat: 会話画面のAI発話ごとに日本語訳ボタンを追加（自由会話・ロールプレイ共通）"
```

---

### Task 4: クライアント FreeTalkScreen の「言い方ヒント」入力

メインの録音ボタンの下に、言いたいことを日本語で入力するテキスト欄と「言い方のヒント」ボタンを置く。押すと直近の会話履歴（末尾6件）を添えて `/api/coach/phrase-hint` を呼び、英語表現2〜3個（英語＋日本語ニュアンス）を表示する。`FreeTalkScreen` は自由会話・ロールプレイ両方で使われるため両方に効く。

**音声入力を今回スコープ外にする判断理由:** (1) `FreeTalkScreen` は会話ループ用にマイク（`Recorder`）を専有し、`idle/recording/transcribing/thinking/speaking` の状態機械を `aliveRef` で慎重にガードしている。ここへ「日本語ディクテーション用の第2の録音経路」を差し込むとマイク競合と状態機械の複雑化を招き、コメントが警告するアンマウント後 setState のバグクラスに触れる。(2) 既存 `sttUpload` は会話用（英語想定）の文字起こし経路で、日本語入力用の別STT言語モードは存在しない。(3) need-based の「言いたいことを渡す」目的にはテキスト入力で十分かつ決定的で、スコープを最小に保てる。よってテキスト入力のみとする。

**Files:**
- Modify: `app/client/src/api.ts`（`fetchPhraseHints` と `PhraseHint` 型を追加）
- Modify: `app/client/src/screens/FreeTalkScreen.tsx`（ヒント入力 state・ハンドラ・UI を追加）

**Interfaces:**
- Consumes: Task 2 の `POST /api/coach/phrase-hint`。`Turn` 型（`{ role: "you" | "ai"; text: string }`、FreeTalkScreen 内で定義済み）。既存の `extractErrorMessage`、`Button`（`variant="secondary"`）。
- Produces:
  - `type PhraseHint = { en: string; ja: string }`（api.ts）
  - `fetchPhraseHints(jaText: string, history?: Array<{ role: "you" | "ai"; text: string }>): Promise<PhraseHint[]>`（api.ts）

- [ ] **Step 1: api.ts にヒント取得関数を追加**

`app/client/src/api.ts` の Task 3 で追加した `fetchUtteranceTranslation` の直後に以下を追加する。

```ts
export type PhraseHint = { en: string; ja: string };

/** 言い方ヒント: 言いたい日本語＋直近履歴 → 使える英語表現2〜3個 */
export async function fetchPhraseHints(
  jaText: string,
  history?: Array<{ role: "you" | "ai"; text: string }>,
): Promise<PhraseHint[]> {
  const res = await fetch("/api/coach/phrase-hint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jaText, history }),
  });
  if (!res.ok) throw new Error(`phrase hint failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { suggestions: PhraseHint[] }).suggestions;
}
```

- [ ] **Step 2: FreeTalkScreen に import と state を追加**

`app/client/src/screens/FreeTalkScreen.tsx` の api import 行を次に置き換える（Task 3 で `fetchUtteranceTranslation` を追加済みの前提）。

```ts
import { converse, fetchPhraseHints, fetchUtteranceTranslation, sttUpload, ttsFetch, type PhraseHint } from "../api";
```

Task 3 で追加した `translations` state の直後に以下を追加する。

```ts
  const [hintInput, setHintInput] = useState("");
  // 言い方ヒント。null=未取得, "loading"=取得中, 配列=提案結果
  const [hints, setHints] = useState<PhraseHint[] | "loading" | null>(null);
  const [hintError, setHintError] = useState("");
```

- [ ] **Step 3: ヒント取得ハンドラを追加**

Task 3 で追加した `translateTurn` 関数の直後に以下を追加する。

```ts
  async function requestHints() {
    const jaText = hintInput.trim();
    if (!jaText) return;
    setHintError("");
    setHints("loading");
    try {
      const suggestions = await fetchPhraseHints(jaText, turns.slice(-6));
      if (aliveRef.current) setHints(suggestions);
    } catch {
      if (aliveRef.current) {
        setHints(null);
        setHintError("ヒントを取得できませんでした。もう一度お試しください。");
      }
    }
  }
```

- [ ] **Step 4: ヒント入力UIを追加**

`FreeTalkScreen.tsx` の `{errorMsg && <Banner kind="error">{errorMsg}</Banner>}` の直後（`<section className="chat">` の前）に以下を追加する。

```tsx
      <div className="phrase-hint stack">
        <label className="text-sm text-muted" htmlFor="phrase-hint-input">
          うまく言えないときは、言いたいことを日本語で入力すると英語の言い方を提案します
        </label>
        <input
          id="phrase-hint-input"
          type="text"
          value={hintInput}
          onChange={(e) => setHintInput(e.target.value)}
          placeholder="例: その機能はまだ試していません"
        />
        <Button variant="secondary" onClick={requestHints} disabled={hints === "loading" || !hintInput.trim()}>
          💡 言い方のヒント
        </Button>
        {hints === "loading" && <p className="text-sm text-muted">言い方を考えています…</p>}
        {hintError && <p className="sentence-explain text-sm">{hintError}</p>}
        {Array.isArray(hints) && (
          <div className="stack">
            {hints.map((h, i) => (
              <div key={i} className="sentence-explain text-sm">
                <div>{h.en}</div>
                {h.ja && <div className="text-muted">{h.ja}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
```

- [ ] **Step 5: 検証ゲート**

Run: `cd app && bun test` → Expected: 全 pass（0 fail）
Run: `cd app && bun run typecheck` → Expected: エラーなし
Run: `cd app/client && bun run build` → Expected: build 成功

- [ ] **Step 6: コミット**

```bash
git add app/client/src/api.ts app/client/src/screens/FreeTalkScreen.tsx
git commit -m "feat: 会話画面に言い方ヒント入力を追加（詰まったとき日本語で聞ける）"
```

---

### Task 5: ロールプレイの開始フレーズ提示

ロールプレイ開始前に、シナリオの開始フレーズ（学習者が最初に言える一言）2〜3個を表示する。

**開始フレーズを生成でなく scenario md 追記にする選定理由:** (1) `content/scenarios/*.md` は既に title_ja・hints・level を人手で管理する curated コンテンツ層で、開始フレーズも各シナリオの役割・レベル帯に合わせて品質管理された資産として置くのが自然。(2) データは既存の `block.params.scenario`（`ContentItem`）経由でクライアントへ流れており、新エンドポイント・deps・キャッシュ・フェイクを増やさずに済む（生成方式より変更面が小さい）。(3) 生成方式はロールプレイ開始前に Claude 呼び出し＋スピナーが挟まり、「開始前に軽く見せる」UXを損なう。追記方式なら即時・決定的で、パーサの単体テストだけで担保できる。追記の一度きりの authoring コストと引き換えに、実行時LLMコスト・恒久コード・テスト面がいずれも小さい。

**Files:**
- Modify: `app/server/menu.ts`（`ContentItem` に `starters` を追加、`parseContentFile` で `> ` 行を抽出）
- Modify: `app/server/__tests__/menu.test.ts`（既存 `toEqual` に `starters: []` を追加、starters 抽出テストを追加）
- Modify: `content/scenarios/*.md`（全16ファイルに `> ` 開始フレーズ行を追記）
- Modify: `app/client/src/api.ts`（`ContentItem` 型に `starters?: string[]` を追加）
- Modify: `app/client/src/screens/RoleplayScreen.tsx`（開始フレーズを表示）

**Interfaces:**
- Produces:
  - `ContentItem.starters: string[]`（menu.ts）— body の `> ` 行を抽出。topic は空配列。
  - クライアント `ContentItem.starters?: string[]`（api.ts）
- Consumes: 既存の `parseContentFile`/`loadContent`（menu.ts）、`block.params.scenario` 経由の受け渡し（変更不要）。

- [ ] **Step 1: menu.test.ts に失敗テストを書く / 既存テストを更新**

`app/server/__tests__/menu.test.ts` の既存テスト `"frontmatter と hints を抽出する"` の `expect(item).toEqual({...})` を次に置き換える（`starters: []` を追加）。

```ts
    expect(item).toEqual({
      id: "abc", kind: "topic", title: "Hello Title", titleJa: "こんにちは",
      hints: ["first hint", "second hint"], starters: [],
      domain: "it", level: [1, 6],
    });
```

同じ `describe("parseContentFile / loadContent", ...)` 内に、新テストを追加する。

```ts
  test("starters（> 行）を hints と分けて抽出する", () => {
    const item = parseContentFile(
      `---\nid: abc\nkind: scenario\ntitle: "T"\ntitle_ja: "t"\n---\nRoleplay setup:\n- a hint\n> Hello there.\n> How are you today?\n`,
    );
    expect(item?.hints).toEqual(["a hint"]);
    expect(item?.starters).toEqual(["Hello there.", "How are you today?"]);
  });
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `cd app && bun test menu`
Expected: `"frontmatter と hints を抽出する"` が FAIL（実際の item に `starters` が無く `toEqual` 不一致）、`"starters（> 行）を..."` も FAIL（`item?.starters` が undefined）。

- [ ] **Step 3: ContentItem 型と parseContentFile を更新**

`app/server/menu.ts` の `ContentItem` 型を次に置き換える。

```ts
export type ContentItem = {
  id: string; kind: "topic" | "scenario"; title: string; titleJa: string; hints: string[];
  starters: string[];
  domain: Domain; level: [number, number];
};
```

`parseContentFile` の `const hints = ...` の直後、`return {` の前に以下を追加する。

```ts
  const starters = text.slice(m[0].length).split("\n")
    .filter((l) => l.trim().startsWith("> "))
    .map((l) => l.trim().slice(2).trim());
```

`parseContentFile` の return を次に置き換える。

```ts
  return {
    id: fields.id, kind: fields.kind, title: fields.title, titleJa: fields.title_ja ?? "", hints, starters,
    domain: parseDomain(fields.domain), level: parseLevelRange(fields.level),
  };
```

- [ ] **Step 4: テストを実行して緑を確認**

Run: `cd app && bun test menu`
Expected: Step 1 の2テストが PASS。既存の menu テストも PASS のまま。

- [ ] **Step 5: 全16シナリオに開始フレーズを追記**

各 `content/scenarios/<id>.md` の末尾（既存の `- ` hints 行の後）に、以下の `> ` 行を追記する。既存の frontmatter・hints 行は変更しない。

`daily-standup.md`:
```
> Good morning, everyone. Here is my update for today.
> Yesterday I finished the login bug, and today I'll start on the API.
> I have one blocker I'd like to mention.
```

`restaurant-order.md`:
```
> Hi, could I see the menu, please?
> What would you recommend here?
> I'd like to order the pasta, please.
```

`casual-interview.md`:
```
> Thanks for joining us today. Let me start by introducing our company.
> We're a small team working on identity and security tools.
> Could you tell me a bit about your background?
```

`conference-qa.md`:
```
> Thanks for the question. Let me make sure I understand it.
> That's a great point — here's how we approached it.
> Good question. I don't know the exact number, but I can follow up.
```

`customer-complaint.md`:
```
> I'm very sorry for the trouble this has caused.
> Let me make sure I understand what happened.
> Thank you for letting us know — I'd like to fix this for you.
```

`customer-hearing.md`:
```
> Thanks for your time today. I'd like to understand your current setup.
> Could you walk me through the problems you're facing?
> How are your team's accounts and devices managed right now?
```

`incident-report.md`:
```
> I need to report an incident we found about an hour ago.
> Let me give you the facts first, then our next steps.
> Here's what happened and the current impact.
```

`job-interview.md`:
```
> Thank you for having me today.
> Let me start with a short introduction of my background.
> I'd be happy to walk you through one of my recent projects.
```

`neighbor-chat.md`:
```
> Oh, hi! Nice weather today, isn't it?
> Hi there — how was your weekend?
> Good morning! Have you been keeping busy lately?
```

`pharmacy-visit.md`:
```
> Hi, I'm not feeling well and I need some help.
> I've had a headache and a sore throat since yesterday.
> Could you recommend something for a cold?
```

`progress-update.md`:
```
> Here's my progress update for this week.
> Let me start with the numbers, then explain one delay.
> Most of the work is done, but I have one delay to report.
```

`reschedule-deadline.md`:
```
> I'd like to talk about the deadline for this deliverable.
> I'm sorry, but I need a bit more time to finish this properly.
> Could we discuss moving the date by one week?
```

`security-review.md`:
```
> Thanks for bringing this tool to us for review.
> Before we approve it, I have a few security questions.
> Could you tell me what kind of data this tool will handle?
```

`tech-discussion.md`:
```
> I'd like to walk you through a design I'm proposing.
> Let me explain the main trade-offs I considered.
> Please push back if anything is unclear.
```

`travel-trouble.md`:
```
> Hi, I have a reservation under my name for tonight.
> I booked this room online last week — here's my confirmation.
> It's been a long flight, so I'd really appreciate your help.
```

`vendor-meeting.md`:
```
> Thanks for making time for our regular meeting.
> I'd like to review the open issues first.
> Can we start with an update on the delayed feature?
```

- [ ] **Step 6: loadContent が starters を拾うことを実データで確認**

Run: `cd app && bun test menu`
Expected: 全 pass（既存の `loadContent` テストは temp dir の合成ファイルを使うため影響なし。実 md の追記は既存テストを壊さない）。

- [ ] **Step 7: クライアント ContentItem 型を更新**

`app/client/src/api.ts` の `ContentItem` 型定義を次に置き換える。

```ts
export type ContentItem = { id: string; kind: "topic" | "scenario"; title: string; titleJa: string; hints: string[]; starters?: string[] };
```

- [ ] **Step 8: RoleplayScreen に開始フレーズ表示を追加**

`app/client/src/screens/RoleplayScreen.tsx` の全体を次に置き換える。

```tsx
import { type ContentItem } from "../api";
import { Card } from "../ui/Card";
import { FreeTalkScreen } from "./FreeTalkScreen";

export function RoleplayScreen(props: { scenario: ContentItem }) {
  const starters = props.scenario.starters ?? [];
  return (
    <div className="stack">
      <Card>
        <p className="text-muted">{props.scenario.titleJa}</p>
        <ul>
          {props.scenario.hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
        {starters.length > 0 && (
          <div className="stack">
            <p className="text-sm text-muted">こう切り出せます:</p>
            <ul>
              {starters.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      <FreeTalkScreen scenarioId={props.scenario.id} />
    </div>
  );
}
```

- [ ] **Step 9: 検証ゲート**

Run: `cd app && bun test` → Expected: 全 pass（0 fail）
Run: `cd app && bun run typecheck` → Expected: エラーなし
Run: `cd app/client && bun run build` → Expected: build 成功

- [ ] **Step 10: コミット**

```bash
git add app/server/menu.ts app/server/__tests__/menu.test.ts content/scenarios app/client/src/api.ts app/client/src/screens/RoleplayScreen.tsx
git commit -m "feat: ロールプレイ開始前にシナリオの開始フレーズを表示"
```

---

## Self-Review

**1. Spec coverage（spec §3 P1 の3項目）:**
- 「AI発話ごとの訳ボタン（自由会話・ロールプレイ両方・talk-explain の軽量版=訳のみ・ハッシュキャッシュ）」→ Task 1（サーバ `/api/coach/translate` + `utterance_translations` キャッシュ）+ Task 3（FreeTalkScreen の訳ボタン。RoleplayScreen が FreeTalkScreen を内包するため両方カバー）。✓
- 「言い方ヒントボタン（日本語入力→英語表現2〜3個・会話コンテキスト付き・新エンドポイント・need-based）」→ Task 2（サーバ `/api/coach/phrase-hint`・history 付き）+ Task 4（テキスト入力UI・音声入力はスコープ外＋理由記載）。✓
- 「ロールプレイの軽量準備＝開始フレーズ2〜3個を開始前に表示」→ Task 5（md 追記 + `ContentItem.starters` + RoleplayScreen 表示。選定理由記載）。✓

**2. Placeholder scan:** TBD/TODO・「適切なエラー処理」等の曖昧語なし。全コードブロックは完全な実装。16シナリオの開始フレーズは全文明記。プロンプト文面も全文明記。✓

**3. Type consistency:**
- `TalkExplainCache`（db.ts の既存型）を `makeTranslationCache` の戻り値・`CoachRoutesDeps.translationCache`・フェイク `makeFakeTalkExplainCache` で一貫使用。✓
- `translate: (text: string) => Promise<{ text: string }>` は既存 `explainTalk` と同シグネチャ、`respondHashCached` の `generate` 引数と一致。✓
- `PhraseHint = { en: string; ja: string }` はサーバ（coach.ts）・deps・クライアント（api.ts）・UI で一致。`suggestions` プロパティ名も全経路一致。✓
- `history` の要素型 `{ role: "you" | "ai"; text: string }` はサーバ deps・生成関数・クライアント `Turn`・`fetchPhraseHints` 引数で一致。✓
- `ContentItem.starters`: サーバは `string[]`（必須）、クライアントは `starters?: string[]`（任意）。サーバは常に配列を送るため互換。RoleplayScreen は `?? []` でフォールバック。✓

**Research-constraint check:** 訳（Task 1/3）・ヒント（Task 2/4）はいずれもユーザーの明示操作（ボタン押下／テキスト入力）でのみ発火。プロンプトは訂正・採点を明示的に禁止（`Do not correct...` / `Do NOT correct the learner and do NOT judge...`）。自動表示・警告調なし。✓

**HTTP additive check:** 既存エンドポイントは request/response 契約不変。`handleTalkExplain` は `respondHashCached` へ内部リファクタしたが入出力挙動は同一（既存 talk-explain テストが回帰ガード）。追加は新規2エンドポイントのみ。`ContentItem` へのフィールド追加は additive。✓
