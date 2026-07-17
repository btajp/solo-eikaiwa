# P6-1 語彙レベリング + P6-4 就寝前レビュー案内 Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 低ステージ（1〜3）の学習者に対し、生成・会話系プロンプトの語彙を「最も高頻度な2,000〜3,000語族」に明示的に絞り込み（P6-1）、加えて夜（ローカル20時以降）にホーム画面へ就寝前復習の一言を情報的に表示する（P6-4）。

**Architecture:** ステージ→語彙制約文の対応を `progression.ts` の純粋関数 `vocabConstraint(stage)` に一元化し、既存の各 system プロンプト（roleplay / model talk / prep / 自由会話 / 例文・お題生成 CLI）の語彙ガイド行を stage 条件付きに差し替える。自由会話だけは現状 override 経路が無いため、`PARTNER_SYSTEM_PROMPT` を builder 化し、ルート層に stage 供給と override 組み立てを新設する。P6-4 はクライアント専用で、`StartScreen` の hero 直下にローカル時刻ゲート付きの1文を足すだけ。

**Tech Stack:** Bun + TypeScript（サーバ: `app/server`、テスト: `bun:test`）、React + Vite（クライアント: `app/client`）、Claude Agent SDK（LLM ランナー）。

## Global Constraints

これらは spec（`docs/superpowers/specs/2026-07-07-p6-input-vocab-plan.md`）と確立済み規約に由来する。**全タスクの要件に暗黙で含まれる。**

- 語彙制約は stage 条件付き: stage 1〜3 は「the most common 2,000–3,000 English word families」を明示、stage 4+ は現行の "Use plain, high-frequency English (B1 level). No rare idioms." を維持する（低ステージのみ挙動変更）。
- 閾値・レベリング数値は `progression.ts` に一元化し、他ファイルへ複製しない（既存規約: 「数値はすべてここで一元定義する」）。
- プロンプト変更はサーバテストで **フェイク runner に渡る `opts.systemPrompt` に制約文言が入ること** を assert して守る。
- 研究制約（情報的フィードバックのみ・データ非削除・自動表示/通知/強制なし）を全項目で維持する。P6-4 は通知・強制・未達表示を一切作らない。
- 画面文言は i18n の named 型サブ辞書に EN/JA 両方を追加する。
- ルータ規約: 新しい依存はドメインの狭い Deps 型に1項追加し、`index.ts` の realDeps と `__tests__/helpers/route-deps.ts` のフェイク両方に配線する。
- **やらないこと**: NGSL 等の語彙リスト同梱によるプログラム的カバレッジ検証（YAGNI）。home への SRS due 件数表示（別機能）。P6-2 / P6-3 は本計画のスコープ外。

## 検証ゲート（各タスク末尾で実行する）

```bash
cd app && bun test
cd app && bun run typecheck   # = tsc --noEmit（include は server のみ）
cd app/client && bun run build  # = tsc --noEmit && vite build
```

`cd app && bun test` は `app/` 以下を再帰スキャンするため server と client 双方のロジックテストを実行する。**注意:** `app/tsconfig.json` の `include` は `["server"]` のみで、CLI ラッパ `scripts/generate-content.ts` は typecheck 対象外。CLI の署名変更は目視 + 新 `GenSentencesDeps` 署名との一致で担保する（実行検証は実 Claude を呼ぶため行わない）。

## File Structure

**Task 1（直呼び生成プロンプトの語彙レベリング）:**
- Modify: `app/server/progression.ts` — `vocabConstraint(stage: number): string` を新設（唯一の語彙制約定義点・閾値もここ）。
- Modify: `app/server/coach.ts` — `roleplayPrompt` に stage 引数、`MODEL_TALK_SYSTEM`→`modelTalkSystem(stage)`、`prepSystem(chunkCount)`→`prepSystem(chunkCount, stage)`、`generateModelTalk`/`generatePrepPack` の args に `stage` を追加。
- Modify: `app/server/content-gen.ts` — `GenSentencesDeps` に `stage`、`genSentences`/`genTopics` の system プロンプトに `vocabConstraint(stage)`。
- Modify: `scripts/generate-content.ts` — CLI が `stage` を両サブコマンドへ供給。
- Modify (tests): `app/server/__tests__/progression.test.ts`, `coach.test.ts`, `content-gen.test.ts`。

**Task 2（自由会話 override 経路の新設）:**
- Modify: `app/server/converse.ts` — `PARTNER_SYSTEM_PROMPT` を `partnerSystemPrompt(stage)` builder 化（既存 const は builder(1) として残す）。
- Modify: `app/server/routes/converse.ts` — `ConverseRoutesDeps` に `conversationStage: () => number`、自由会話時に `partnerSystemPrompt(stage)` を override 組み立て。
- Modify: `app/server/index.ts` — `scenarioPrompt` を stage 付き `roleplayPrompt` に、`modelTalk`/`prepPack` に stage を供給、`conversationStage` を配線。
- Modify (tests): `app/server/__tests__/converse.test.ts`, `routes-converse.test.ts`, `helpers/route-deps.ts`。

**Task 3（就寝前レビュー案内・クライアント）:**
- Modify: `app/client/src/screens/StartScreen.tsx` — hero 直下にローカル20時以降ゲートの1文。
- Modify: `app/client/src/i18n.ts` — `HeroStrings` 型に `bedtime` を追加、EN/JA の hero 辞書に文言。

---

## Task 1: 直呼び生成プロンプトの語彙レベリング（progression / coach / content-gen / CLI）

roleplay・model talk・prep・例文生成・お題生成の各 system プロンプトを stage 条件付きの語彙制約に差し替える。stage が呼び出し元から自然に渡る経路（`index.ts` のクロージャ・CLI）だけで完結し、override 経路は不要（それは Task 2）。

**Files:**
- Modify: `app/server/progression.ts`
- Modify: `app/server/coach.ts`
- Modify: `app/server/content-gen.ts`
- Modify: `scripts/generate-content.ts`
- Test: `app/server/__tests__/progression.test.ts`, `app/server/__tests__/coach.test.ts`, `app/server/__tests__/content-gen.test.ts`

**Interfaces:**
- Produces: `vocabConstraint(stage: number): string`（`progression.ts` から export）。`stage <= 3` で "…word families…" を含む文、`stage >= 4` で "…B1 level…" を含む文を返す。
- Produces: `roleplayPrompt(scenario: { title: string; hints: string[] }, stage: number): string`
- Produces: `generateModelTalk(args: { topicTitle: string; hints: string[]; stage: number }, runner?): Promise<{ text: string }>`
- Produces: `generatePrepPack(args: { topicTitle: string; hints: string[]; chunkCount?: number; hintLang?: HintLang; stage: number }, runner?): Promise<PrepPack>`
- Produces: `GenSentencesDeps` に `stage: number` フィールドを追加。
- Consumes: 既存 `stageOf`, `prepParams`（`progression.ts`）、`ClaudeRunner`（`converse.ts`）。

### 1a. `vocabConstraint` を progression.ts に新設（TDD）

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/progression.test.ts` の import に `vocabConstraint` を追加し、ファイル末尾に describe を追加する。

import 行（4行目）を差し替え:

```typescript
import {
  BOUNDARY_LEVELS, DEFAULT_LEVEL, demotionTargetLevel, fttMiniRoundsSec, fttRoundsSec,
  needXp, PLACEMENT_XP, prepParams, stageOf, vocabConstraint, xpForGrade,
} from "../progression";
```

ファイル末尾に追加:

```typescript
describe("progression: vocabConstraint", () => {
  test("stage 1〜3 は高頻度語彙(word families)に絞り、B1 level 表記を使わない", () => {
    for (const s of [1, 2, 3]) {
      expect(vocabConstraint(s)).toContain("word families");
      expect(vocabConstraint(s)).not.toContain("B1 level");
    }
  });

  test("stage 4+ は従来の B1 目安を維持し word families 制約は課さない", () => {
    for (const s of [4, 5, 6]) {
      expect(vocabConstraint(s)).toContain("B1 level");
      expect(vocabConstraint(s)).not.toContain("word families");
    }
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/progression.test.ts`
Expected: FAIL（`vocabConstraint` が export されていないため import 解決エラー、または未定義参照）

- [ ] **Step 3: `vocabConstraint` を実装**

`app/server/progression.ts` の `prepParams` 関数（`export function prepParams` のブロック）の直後に追加する:

```typescript
/**
 * ステージ別の語彙レベリング制約（生成・会話プロンプトに差し込む1文）。
 * 研究知見5: 95%カバレッジ≈2,000〜3,000語族で非母語話者の聴解が安定する。
 * これは「難易度つまみ」の一種であり、閾値(stage<=3)もここに一元化する。
 * 各ドメインの system プロンプトはこの1文を自分のルール群に差し込む。
 */
export function vocabConstraint(stage: number): string {
  return stage <= 3
    ? "Use only the most common 2,000–3,000 English word families (everyday high-frequency vocabulary). Avoid rare, academic, or advanced words, and avoid idioms."
    : "Use plain, high-frequency English (B1 level). No rare idioms.";
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test server/__tests__/progression.test.ts`
Expected: PASS

### 1b. coach.ts の3プロンプトを stage 条件付きにする（TDD）

- [ ] **Step 5: 失敗するテストを書く（coach.test.ts）**

`app/server/__tests__/coach.test.ts` を3か所修正する。

(1) `roleplayPrompt` の describe（現在の `describe("roleplayPrompt", ...)` ブロック全体）を次に差し替える:

```typescript
describe("roleplayPrompt", () => {
  test("シナリオのタイトルとセットアップ・短文/日本語禁止ルールを含む", () => {
    const p = roleplayPrompt({ title: "Vendor meeting", hints: ["You are the customer", "Goal: agree next steps"] }, 5);
    expect(p).toContain("Vendor meeting");
    expect(p).toContain("You are the customer");
    expect(p).toContain("Never switch to Japanese");
  });

  test("低ステージ(1〜3)は高頻度語彙制約(word families)を課す", () => {
    const p = roleplayPrompt({ title: "t", hints: ["h"] }, 2);
    expect(p).toContain("word families");
    expect(p).not.toContain("B1 level");
  });

  test("stage 4+ は従来の B1 目安を維持する", () => {
    const p = roleplayPrompt({ title: "t", hints: ["h"] }, 5);
    expect(p).toContain("B1 level");
    expect(p).not.toContain("word families");
  });
});
```

(2) `generateModelTalk` の describe（現在の `describe("generateModelTalk", ...)` ブロック全体）を次に差し替える:

```typescript
describe("generateModelTalk", () => {
  test("topicTitleとhintsがプロンプトに入り、textを返す", async () => {
    const { runner, seen } = runnerReturning("This is a model talk.");
    const result = await generateModelTalk({ topicTitle: "Zero trust", hints: ["definition", "example"], stage: 2 }, runner);
    expect(result.text).toBe("This is a model talk.");
    expect(seen[0].prompt).toContain("Zero trust");
    expect(seen[0].prompt).toContain("definition");
  });

  test("低ステージは systemPrompt に高頻度語彙制約(word families)が入る", async () => {
    const { runner, seen } = runnerReturning("x");
    await generateModelTalk({ topicTitle: "t", hints: [], stage: 2 }, runner);
    expect(seen[0].systemPrompt).toContain("word families");
  });

  test("stage 4+ の systemPrompt は word families 制約を課さない", async () => {
    const { runner, seen } = runnerReturning("x");
    await generateModelTalk({ topicTitle: "t", hints: [], stage: 5 }, runner);
    expect(seen[0].systemPrompt).not.toContain("word families");
  });
});
```

(3) `generatePrepPack` の describe 内の **既存7か所の呼び出しに `stage: 3` を追加** し、末尾に語彙テスト2件を足す。既存呼び出しの差し替え（各行を左→右へ）:

```
generatePrepPack({ topicTitle: "Zero trust", hints: ["definition — 定義", "example — 例"] }, runner)
→ generatePrepPack({ topicTitle: "Zero trust", hints: ["definition — 定義", "example — 例"], stage: 3 }, runner)

generatePrepPack({ topicTitle: "t", hints: [] }, runner)        // 「```フェンス付き」テスト
→ generatePrepPack({ topicTitle: "t", hints: [], stage: 3 }, runner)

generatePrepPack({ topicTitle: "t", hints: [] }, runner)        // 「パース失敗時」テスト
→ generatePrepPack({ topicTitle: "t", hints: [], stage: 3 }, runner)

generatePrepPack({ topicTitle: "t", hints: [], hintLang: "en" }, runner)
→ generatePrepPack({ topicTitle: "t", hints: [], hintLang: "en", stage: 3 }, runner)

generatePrepPack({ topicTitle: "t", hints: [] }, runner)        // 「hintLang 省略時」テスト
→ generatePrepPack({ topicTitle: "t", hints: [], stage: 3 }, runner)

generatePrepPack({ topicTitle: "t", hints: [], chunkCount: 4 }, runner)
→ generatePrepPack({ topicTitle: "t", hints: [], chunkCount: 4, stage: 3 }, runner)

generatePrepPack({ topicTitle: "t", hints: [] }, runner)        // 「不正な項目をサニタイズ」テスト
→ generatePrepPack({ topicTitle: "t", hints: [], stage: 3 }, runner)
```

`describe("generatePrepPack", ...)` の閉じ括弧 `});` の直前に、次の2テストを追加する:

```typescript
  test("低ステージは systemPrompt に word families 制約が入る", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    await generatePrepPack({ topicTitle: "t", hints: [], stage: 2 }, runner);
    expect(seen[0].systemPrompt).toContain("word families");
  });

  test("stage 4+ は word families 制約を課さない（B1 目安のみ）", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    await generatePrepPack({ topicTitle: "t", hints: [], stage: 5 }, runner);
    expect(seen[0].systemPrompt).not.toContain("word families");
  });
```

> 補足: `prepSystem` は形状ヒント内に恒常的に "B1 level" を含むため、prep のテストは `word families` の有無だけで stage 条件を検証する（`B1 level` の有無では判定しない）。

- [ ] **Step 6: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/coach.test.ts`
Expected: FAIL（`roleplayPrompt` が2引数を要求していない・`generateModelTalk`/`generatePrepPack` の args に `stage` が無いため型エラー、または語彙 assert 不成立）

- [ ] **Step 7: coach.ts を実装**

`app/server/coach.ts` の import（2行目 `import type { HintLang } from "./progression";`）を差し替える:

```typescript
import { vocabConstraint, type HintLang } from "./progression";
```

`roleplayPrompt`（末尾の関数）を差し替える:

```typescript
export function roleplayPrompt(scenario: { title: string; hints: string[] }, stage: number): string {
  return `You are an English roleplay partner for a Japanese IT professional (CEFR A2-B1).
Scenario: ${scenario.title}
Setup:
${scenario.hints.map((h) => `- ${h}`).join("\n")}
Rules:
- Stay in your assigned role for the whole conversation. Do not break character.
- Keep every reply SHORT: 2-4 sentences, then ask ONE question or make ONE request.
- ${vocabConstraint(stage)}
- Do NOT correct the learner's errors explicitly; respond naturally.
- Never switch to Japanese.
- Do not use any tools — reply directly with text only.`;
}
```

`MODEL_TALK_SYSTEM` の定数定義を builder 関数に差し替える:

```typescript
function modelTalkSystem(stage: number): string {
  return `You produce a model monologue for an English learner (CEFR B1) to shadow.
Rules: 120-150 words, spoken register, first person, short sentences. ${vocabConstraint(stage)}
No headings, no lists — just the monologue text.
Do not use any tools — reply directly with text only.`;
}
```

`generateModelTalk` を差し替える:

```typescript
export async function generateModelTalk(
  args: { topicTitle: string; hints: string[]; stage: number },
  runner: ClaudeRunner = defaultRunner,
): Promise<{ text: string }> {
  const prompt = `Topic: ${args.topicTitle}\nCover these angles:\n${args.hints.map((h) => `- ${h}`).join("\n")}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: modelTalkSystem(args.stage) });
  return { text };
}
```

`prepSystem` の署名に stage を足し、Rules に制約行を挿入する:

```typescript
function prepSystem(chunkCount: number, stage: number): string {
  return `You prepare a Japanese IT professional (CEFR A2-B1) for a short English monologue.
You receive a topic and hint angles. Reply with STRICT JSON only — no markdown fences, no commentary — exactly this shape:
{"chunks":[{"en":"<complete, speakable sentence, B1 level>","ja":"<自然な日本語訳>"}],"outline":["<short English bullet>"]}
Rules:
- Exactly ${chunkCount} chunks. Each "en" MUST be a complete, speakable sentence of roughly 8-16 words that the learner can read aloud as-is.
  No ellipses ("..."), no blanks, and no placeholders like [X] — always fill the slot with a concrete, topic-relevant
  example a B1-level IT professional could plausibly say, using the given topic and hints for the content
  (e.g. "The main problem we had was a slow database query.", "What worked well was splitting the task into smaller steps.").
- ${vocabConstraint(stage)}
- Keep the reusable sentence frame recognizable at the START of each sentence (sentence-starter + filled example), so the
  learner can reuse that same frame with their own content in the next exercise.
- ja: the natural full-sentence Japanese translation of "en" (not a fragment).
- outline: 3-4 bullets forming a simple talk skeleton (opening → 1-2 points → wrap-up), tied to the given hints.
Do not use any tools — reply directly with text only.`;
}
```

`generatePrepPack` の args と `prepSystem` 呼び出しを差し替える（args に `stage` 追加、`prepSystem(chunkCount)` → `prepSystem(chunkCount, args.stage)`）:

```typescript
export async function generatePrepPack(
  args: { topicTitle: string; hints: string[]; chunkCount?: number; hintLang?: HintLang; stage: number },
  runner: ClaudeRunner = defaultRunner,
): Promise<PrepPack> {
  const chunkCount = args.chunkCount ?? 6;
  // hintLang は「表示既定の供給者」。ja のデータ自体は常に返し、表示するかはクライアントが決める。
  const hintDefault: HintLang = args.hintLang ?? "ja";
  const prompt = `Topic: ${args.topicTitle}\nHint angles:\n${args.hints.map((h) => `- ${h}`).join("\n")}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: prepSystem(chunkCount, args.stage) });
  const parsed = extractJson<PrepPack>(text);
  if (parsed && Array.isArray(parsed.chunks) && Array.isArray(parsed.outline)) {
    // Sanitize chunks: keep only items where both en and ja are strings（ja は空にしない）
    const chunks = parsed.chunks
      .filter((item) => typeof item?.en === "string" && item.en && typeof item?.ja === "string")
      .map((item) => ({ en: item.en, ja: item.ja }));
    // Sanitize outline: keep only string elements
    const outline = parsed.outline.filter((el) => typeof el === "string");
    return { chunks, outline, hintDefault };
  }
  // パース失敗時のフォールバック: チャンクなし・素のテキストをアウトラインとして表示できる形
  return { chunks: [], outline: [text], hintDefault };
}
```

> `index.ts` の `roleplayPrompt` / `generateModelTalk` / `generatePrepPack` 呼び出しは Task 2 で stage を配線する。**このタスク単独では `cd app && bun run typecheck` が index.ts の呼び出し不足で失敗する** — Step 8 では coach.test.ts の通過を確認し、typecheck の完全通過は Task 2 完了時とする（下の「Task 1 のコミット判断」を参照）。

- [ ] **Step 8: coach テストが通ることを確認**

Run: `cd app && bun test server/__tests__/coach.test.ts`
Expected: PASS

### 1c. content-gen.ts / CLI に stage 語彙制約を入れる（TDD）

- [ ] **Step 9: 失敗するテストを書く（content-gen.test.ts）**

`app/server/__tests__/content-gen.test.ts` を修正する。

(1) 既存 `makeRunner` 関数の直後に、systemPrompt を捕捉する runner を追加する:

```typescript
/** systemPrompt を捕捉する fake ClaudeRunner（語彙制約の検証用） */
function makeCapturingRunner(responses: string[]): { runner: ClaudeRunner; seen: Array<{ systemPrompt?: string }> } {
  const seen: Array<{ systemPrompt?: string }> = [];
  let i = 0;
  const runner: ClaudeRunner = async (_prompt, _resumeId, opts) => {
    seen.push({ systemPrompt: opts?.systemPrompt });
    const text = responses[Math.min(i, responses.length - 1)];
    i++;
    return { text, sessionId: "fake" };
  };
  return { runner, seen };
}
```

(2) `describe("content-gen / genSentences", ...)` 内の **既存5か所の `genSentences({...})` 呼び出しに `stage: 2` を追加** する。各呼び出しの deps オブジェクトに `stage: 2,` を挿入する（`db,` の直後が分かりやすい）。対象:
  - 「正常系: 4文が追記され…」テストの `genSentences({ runner: makeRunner([VALID_BATCH]), sentencesFile: file, db, dry: false, log: ... })`
  - 「既存と正規化重複する…」テストの `genSentences({ runner: makeRunner([dupBatch, VALID_BATCH]), sentencesFile: file, db, dry: false, log: ... })`
  - 「不正出力が2回続くと…」テストの `genSentences({ runner: makeRunner([invalidBatch, invalidBatch]), sentencesFile: file, db, dry: false })`
  - 「dry=trueは一切書かない」テストの `genSentences({ runner: makeRunner([VALID_BATCH]), sentencesFile: file, db, dry: true, log: ... })`
  - 「データ不足時は…」テストの `genSentences({ runner: makeRunner([VALID_BATCH]), sentencesFile: file, db, dry: false, log: ... })`

いずれも `db,` の後に `stage: 2,` を足す。例（1件目）:

```typescript
await genSentences({ runner: makeRunner([VALID_BATCH]), sentencesFile: file, db, stage: 2, dry: false, log: (s) => logs.push(s) });
```

(3) `describe("content-gen / genSentences", ...)` の閉じ括弧 `});` の直前に語彙テストを追加する:

```typescript
  test("低ステージは systemPrompt に高頻度語彙制約(word families)が入る", async () => {
    const { dir, file, db } = setup();
    const { runner, seen } = makeCapturingRunner([VALID_BATCH]);
    // dry=true でもプロンプト構築と runner 呼び出しは走る（書き込みだけをスキップ）
    await genSentences({ runner, sentencesFile: file, db, stage: 2, dry: true });
    expect(seen[0].systemPrompt).toContain("word families");
    rmSync(dir, { recursive: true, force: true });
  });
```

(4) `describe("content-gen / genTopics", ...)` の閉じ括弧 `});` の直前に語彙テストを追加する:

```typescript
  test("低ステージは topic 生成 systemPrompt に高頻度語彙制約が入る", async () => {
    const dirs = tempDirs();
    const { runner, seen } = makeCapturingRunner([
      contentJson("topic-one", "daily"), contentJson("topic-two", "it"), contentJson("scenario-one", "business"),
    ]);
    await genTopics({ runner, topicsDir: dirs.topicsDir, scenariosDir: dirs.scenariosDir, stage: 2, dry: true });
    expect(seen[0].systemPrompt).toContain("word families");
    cleanup(dirs);
  });
```

- [ ] **Step 10: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/content-gen.test.ts`
Expected: FAIL（`GenSentencesDeps` に `stage` が無い型エラー、または新テストの語彙 assert 不成立）

- [ ] **Step 11: content-gen.ts を実装**

`app/server/content-gen.ts` の import 群（先頭の import 群）に1行追加する（`import { categoryBadRates, pickWorstCategories } from "./srs-analytics";` の直後など）:

```typescript
import { vocabConstraint } from "./progression";
```

`GenSentencesDeps` 型に `stage` を追加する:

```typescript
export type GenSentencesDeps = {
  runner: ClaudeRunner;
  sentencesFile: string;
  db: Database;
  stage: number;
  dry: boolean;
  log?: (s: string) => void;
};
```

`genSentences` 内の `const system = ...` テンプレート（`Domains: ...` 行と `${ORIGINALITY}` 行の間）に `${vocabConstraint(deps.stage)}` 行を挿入する。差し替え後:

```typescript
    const system = `You write original English example sentences for a Japanese learner (CEFR B1-B2).
Write exactly 4 spoken-register sentences practicing the grammar category "${w.category}".
Domains: one "daily", one "business", one "it", and one of your choice. 6-14 words each. Contractions welcome.
${vocabConstraint(deps.stage)}
${ORIGINALITY}
Avoid these existing sentences (do not duplicate or closely paraphrase):
${inCategory.slice(0, 12).map((s) => `- ${s.en}`).join("\n")}
Reply with STRICT JSON only: {"sentences":[{"domain":"daily|business|it","en":"...","ja":"自然な和訳","note":"文法ポイント1行(日本語)"}]}
Do not use any tools — reply directly with text only.`;
```

`genTopics` 内の `const system = ...` テンプレートで、`Each hint line: ...` 行の直後（`Do NOT reuse these existing ids:` 行の前）に `${vocabConstraint(deps.stage)}` 行を挿入する。差し替え後:

```typescript
    const system = `You create one original ${p.kind} for an English speaking practice app (Japanese learner, difficulty stage ${deps.stage} of 6).
${p.kind === "topic"
  ? "A topic gives 4 talking-point hints for a monologue."
  : "A scenario sets up a roleplay: who the AI plays, who the learner is, the goal, and useful moves."}
Each hint line: English phrase — 日本語の補足. Spoken register. ${ORIGINALITY}
${vocabConstraint(deps.stage)}
Do NOT reuse these existing ids: ${existing}
Reply with STRICT JSON only:
{"id":"kebab-case-id","title":"English title","titleJa":"日本語タイトル","domain":"daily|business|it","level":[min,max],"hints":["English — 日本語", ...4 items]}
level must be within 1..6 and include stage ${deps.stage}.
Do not use any tools — reply directly with text only.`;
```

- [ ] **Step 12: content-gen テストが通ることを確認**

Run: `cd app && bun test server/__tests__/content-gen.test.ts`
Expected: PASS

- [ ] **Step 13: CLI ラッパを更新（scripts/generate-content.ts）**

`scripts/generate-content.ts` の `main` 関数を差し替える（`stage` を先頭で1度計算して両ブランチに供給する）:

```typescript
async function main(): Promise<void> {
  const db = openDb();
  const stage = stageOf(makeProgressStore(db).getLevel());
  if (sub === "sentences") {
    await genSentences({ runner, sentencesFile: SENTENCES_FILE, db, stage, dry, log: console.log });
  } else if (sub === "topics") {
    await genTopics({ runner, topicsDir: TOPICS_DIR, scenariosDir: SCENARIOS_DIR, stage, dry, log: console.log });
  } else {
    console.error("使い方: bun scripts/generate-content.ts <sentences|topics> [--dry]");
    process.exit(1);
  }
}
```

> `stageOf` と `makeProgressStore` は既に import 済み。scripts は `cd app && bun run typecheck` の対象外なので、`GenSentencesDeps` に `stage` を渡していること・引数名の一致を目視で確認する。

### Task 1 のコミット判断

このタスクは coach.ts の呼び出し元（`index.ts`）を Task 2 で更新するまで `cd app && bun run typecheck` が **通らない**（`roleplayPrompt`/`generateModelTalk`/`generatePrepPack` の引数不足）。したがって Task 1 と Task 2 は「サーバの型が閉じる」単位では連続している。

- [ ] **Step 14: Task 1 の全 server テストがグリーンなことを確認**

Run: `cd app && bun test server/__tests__/progression.test.ts server/__tests__/coach.test.ts server/__tests__/content-gen.test.ts`
Expected: PASS（3ファイルとも）

- [ ] **Step 15: コミット**

```bash
git add app/server/progression.ts app/server/coach.ts app/server/content-gen.ts scripts/generate-content.ts \
  app/server/__tests__/progression.test.ts app/server/__tests__/coach.test.ts app/server/__tests__/content-gen.test.ts
git commit -m "feat: 生成プロンプトの語彙をステージ別に高頻度語彙へレベリング（P6-1 直呼び経路）"
```

> このコミット時点では `cd app && bun run typecheck` は index.ts の呼び出し未更新により失敗する。**全ゲート（typecheck / client build 含む）の通過確認は Task 2 完了後にまとめて行う。** 中間コミットが型不整合を含むことを避けたい場合は Task 1・Task 2 を1つのブランチ上で連続実行し、Step 15 を Task 2 の Step 24 と統合してもよい（その場合コミットは2本→2本のまま、順序のみ変更）。

---

## Task 2: 自由会話 override 経路の新設（converse / routes / index 配線）

自由会話は現状 `PARTNER_SYSTEM_PROMPT` 定数にフォールバックし、stage を受け取る経路が無い。builder 化＋deps に stage 供給＋route で override 組み立ての3点セットで対応する。あわせて Task 1 で stage 引数化した coach 関数の呼び出し元（`index.ts`）を配線し、サーバ全体の型を閉じる。

**Files:**
- Modify: `app/server/converse.ts`
- Modify: `app/server/routes/converse.ts`
- Modify: `app/server/index.ts`
- Test: `app/server/__tests__/converse.test.ts`, `app/server/__tests__/routes-converse.test.ts`, `app/server/__tests__/helpers/route-deps.ts`

**Interfaces:**
- Produces: `partnerSystemPrompt(stage: number): string`（`converse.ts` から export）。`stage <= 3` で "…word families…"、`stage >= 4` で "…B1 level…" を含む。
- Produces: `PARTNER_SYSTEM_PROMPT`（既存 export を維持・値は `partnerSystemPrompt(1)`）。runner の override 未指定時フォールバック。
- Produces: `ConverseRoutesDeps` に `conversationStage: () => number` を追加。
- Consumes: `vocabConstraint`（`progression.ts`）、`stageOf`（`progression.ts`）、`roleplayPrompt`/`generateModelTalk`/`generatePrepPack`（Task 1 の新署名）。

### 2a. `partnerSystemPrompt` builder（TDD）

- [ ] **Step 16: 失敗するテストを書く（converse.test.ts）**

`app/server/__tests__/converse.test.ts` の import 行（5行目）に `partnerSystemPrompt` を追加する:

```typescript
import { converseTurn, makeClaudeRunner, PARTNER_SYSTEM_PROMPT, partnerSystemPrompt } from "../converse";
```

ファイル末尾に describe を追加する:

```typescript
describe("partnerSystemPrompt", () => {
  test("低ステージ(1〜3)は高頻度語彙制約(word families)を課す", () => {
    const p = partnerSystemPrompt(2);
    expect(p).toContain("word families");
    expect(p).not.toContain("B1 level");
    expect(p).toContain("Never switch to Japanese");
  });

  test("stage 4+ は従来の B1 目安を維持する", () => {
    const p = partnerSystemPrompt(5);
    expect(p).toContain("B1 level");
    expect(p).not.toContain("word families");
  });

  test("PARTNER_SYSTEM_PROMPT はフォールバック既定として存在し続ける", () => {
    expect(PARTNER_SYSTEM_PROMPT).toBe(partnerSystemPrompt(1));
  });
});
```

- [ ] **Step 17: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/converse.test.ts`
Expected: FAIL（`partnerSystemPrompt` が未 export）

- [ ] **Step 18: converse.ts を実装**

`app/server/converse.ts` の import 群（先頭）に1行追加する:

```typescript
import { vocabConstraint } from "./progression";
```

`export const PARTNER_SYSTEM_PROMPT = \`...\`;`（定数定義ブロック全体）を builder + フォールバック定数に差し替える:

```typescript
export function partnerSystemPrompt(stage: number): string {
  return `You are an English conversation partner for a Japanese IT professional (CEFR A2-B1).
- You are a friendly colleague. Talk about tech work, identity management, security, AI — or whatever the learner brings up.
- Keep every reply SHORT: 2-4 sentences, then ask ONE follow-up question.
- ${vocabConstraint(stage)}
- Do NOT correct errors explicitly in this mode; just respond naturally (recast briefly only when meaning is unclear).
- Never switch to Japanese.
- Do not use any tools — reply directly with text only.`;
}

/** runner の override 未指定時フォールバック既定。自由会話 route は常に stage 付き override を組む（routes/converse.ts） */
export const PARTNER_SYSTEM_PROMPT = partnerSystemPrompt(1);
```

> `makeClaudeRunner` 内の `opts?.systemPrompt ?? PARTNER_SYSTEM_PROMPT` はそのまま。定数を builder(1) で保つことで既存の「規定オプションが query に渡る」テスト（`systemPrompt: PARTNER_SYSTEM_PROMPT` を assert）も変更不要。

- [ ] **Step 19: converse テストが通ることを確認**

Run: `cd app && bun test server/__tests__/converse.test.ts`
Expected: PASS

### 2b. route の override 組み立て + deps 追加（TDD）

- [ ] **Step 20: 失敗するテストを書く（routes-converse.test.ts + route-deps.ts）**

まず `app/server/__tests__/helpers/route-deps.ts` の `deps` オブジェクトに `conversationStage` を追加する。`scenarioPrompt: (id: string) => (id === "known-scenario" ? "ROLEPLAY PROMPT" : null),` の直後に1行足す:

```typescript
    scenarioPrompt: (id: string) => (id === "known-scenario" ? "ROLEPLAY PROMPT" : null),
    conversationStage: () => 2,
```

次に `app/server/__tests__/routes-converse.test.ts` の **「scenarioId なしは従来どおり（override は undefined）」テスト（`test("scenarioId なしは従来どおり（override は undefined）", ...)` ブロック全体）** を、自由会話が override を渡す新挙動に差し替える:

```typescript
  test("scenarioId なしは自由会話プロンプト（stage 別語彙制約）を override として渡す", async () => {
    const seen: Array<{ systemPromptOverride?: string }> = [];
    const { deps } = makeTestDeps({
      converse: async (args) => {
        seen.push({ systemPromptOverride: args.systemPromptOverride });
        return { replyText: "ok", sessionId: "s1" };
      },
    });
    const handler = makeFetchHandler(deps);
    await handler(postJson("/api/converse", { userText: "hi" }));
    // route-deps の conversationStage() は 2（低ステージ）→ 高頻度語彙制約が入る
    expect(seen[0].systemPromptOverride).toContain("word families");
  });
```

- [ ] **Step 21: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/routes-converse.test.ts`
Expected: FAIL（`ConverseRoutesDeps` に `conversationStage` が無い型エラー、または自由会話 override が undefined のまま assert 不成立）

- [ ] **Step 22: routes/converse.ts を実装**

`app/server/routes/converse.ts` の全体を差し替える:

```typescript
import { converseTurn, partnerSystemPrompt } from "../converse";
import { json, parseJsonBody, exact, type RouteEntry } from "./http";

export type ConverseRoutesDeps = {
  converse: typeof converseTurn;
  /** 未知の scenarioId は null（ルートは400を返す） */
  scenarioPrompt: (scenarioId: string) => string | null;
  /** 自由会話の語彙レベリング用: 現在の学習ステージ(1..6)を供給する */
  conversationStage: () => number;
};

async function handleConverse(req: Request, deps: ConverseRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ userText?: string; sessionId?: string; scenarioId?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!body.userText?.trim()) return json({ error: "userText is required" }, 400);
  let systemPromptOverride: string;
  if (body.scenarioId) {
    const p = deps.scenarioPrompt(body.scenarioId);
    if (!p) return json({ error: "unknown scenarioId" }, 400);
    systemPromptOverride = p;
  } else {
    // 自由会話: stage 別の語彙レベリング付きパートナープロンプトを毎回組み立てる
    systemPromptOverride = partnerSystemPrompt(deps.conversationStage());
  }
  const r = await deps.converse({ userText: body.userText, sessionId: body.sessionId, systemPromptOverride });
  return json(r);
}

export function makeConverseRoutes(deps: ConverseRoutesDeps): RouteEntry[] {
  return [exact("POST", "/api/converse", (req) => handleConverse(req, deps))];
}
```

> `systemPromptOverride` は常に `string`（自由会話でもフォールバックせず明示 override）。`converseTurn` は `systemPromptOverride?: string` を受けるため互換。

- [ ] **Step 23: routes-converse テストが通ることを確認**

Run: `cd app && bun test server/__tests__/routes-converse.test.ts`
Expected: PASS（`既知の scenarioId は…`・`未知の scenarioId は400`・差し替えた自由会話テストすべて）

### 2c. index.ts の実配線

- [ ] **Step 24: index.ts の realDeps を配線**

`app/server/index.ts` の `realDeps` 内、`scenarioPrompt` / `modelTalk` / `prepPack` の各クロージャを stage 付きに差し替え、`conversationStage` を追加する。

`scenarioPrompt` クロージャを差し替える:

```typescript
  scenarioPrompt: (scenarioId) => {
    const sc = findScenario(scenarioId);
    return sc ? roleplayPrompt(sc, stageOf(progressStore.getLevel())) : null;
  },
  conversationStage: () => stageOf(progressStore.getLevel()),
```

`modelTalk` クロージャを差し替える:

```typescript
  modelTalk: async (topicId) => {
    const topic = findTopic(topicId);
    if (!topic) return null;
    const talk = await generateModelTalk({ topicTitle: topic.title, hints: topic.hints, stage: stageOf(progressStore.getLevel()) });
    return { text: talk.text, topicTitle: topic.title };
  },
```

`prepPack` クロージャを差し替える（stage を1度計算し prepParams と generatePrepPack で共用）:

```typescript
  prepPack: async (topicId) => {
    const topic = findTopic(topicId);
    if (!topic) return null;
    const stage = stageOf(progressStore.getLevel());
    const p = prepParams(stage);
    return generatePrepPack({ topicTitle: topic.title, hints: topic.hints, chunkCount: p.chunkCount, hintLang: p.hintLang, stage });
  },
```

> `stageOf` / `prepParams` / `findScenario` / `findTopic` / `roleplayPrompt` / `generateModelTalk` / `generatePrepPack` は既に import 済み。

- [ ] **Step 25: サーバ全テストと型を確認**

Run: `cd app && bun test`
Expected: PASS（全ファイル）

Run: `cd app && bun run typecheck`
Expected: エラーなし（Task 1 で開いた index.ts の引数不足がここで閉じる）

Run: `cd app/client && bun run build`
Expected: 成功（クライアント無変更のため影響なし・回帰確認）

- [ ] **Step 26: コミット**

```bash
git add app/server/converse.ts app/server/routes/converse.ts app/server/index.ts \
  app/server/__tests__/converse.test.ts app/server/__tests__/routes-converse.test.ts app/server/__tests__/helpers/route-deps.ts
git commit -m "feat: 自由会話プロンプトにステージ別語彙レベリングのoverride経路を新設（P6-1）"
```

---

## Task 3: 就寝前レビュー案内（StartScreen hero 直下・P6-4）

ローカル時刻20時以降のとき、ホーム画面の hero 直下に情報的な一文を出す。通知・強制・未達表示なし。i18n は `HeroStrings` に1キー（EN/JA）を追加。

**Files:**
- Modify: `app/client/src/screens/StartScreen.tsx`
- Modify: `app/client/src/i18n.ts`

**Interfaces:**
- Consumes: `STR[lang].hero.bedtime`（i18n の新キー）。
- Produces: なし（画面内 UI のみ）。

> クライアントには React 画面向けのテストランナーが無い（既存 client テストは `cloze` / `support` / `blockTitle` / `api/progress` の純ロジックのみ）。20時ゲート＋文字列表示という自明な変更のため、専用テストは追加せず `tsc --noEmit`（build 前段）＋ `vite build` を検証ゲートとする。

### 3a. i18n に bedtime キーを追加

- [ ] **Step 27: `HeroStrings` 型に bedtime を追加**

`app/client/src/i18n.ts` の型定義（`type HeroStrings = ...` の行）を差し替える:

```typescript
type HeroStrings = { hero: { title: string; date: (d: Date) => string; bedtime: string } };
```

- [ ] **Step 28: EN の hero 辞書に文言を追加**

EN 辞書の `hero:` ブロック（`title: "Ready to practice your English?"` を含む方）を差し替える:

```typescript
    hero: {
      title: "Ready to practice your English?",
      date: (d) => `${WEEKDAYS_EN[d.getDay()]}, ${MONTHS_EN[d.getMonth()]} ${d.getDate()}`,
      bedtime: "A little review before bed helps it stick.",
    },
```

- [ ] **Step 29: JA の hero 辞書に文言を追加**

JA 辞書の `hero:` ブロック（`title: "今日も英語を話しましょう"` を含む方）を差し替える:

```typescript
    hero: {
      title: "今日も英語を話しましょう",
      date: (d) => `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS_JA[d.getDay()]}）`,
      bedtime: "寝る前の少しの復習は、記憶の定着に少し有利です。",
    },
```

- [ ] **Step 30: 型だけ先に確認（キー欠落の検出）**

Run: `cd app/client && bunx tsc --noEmit`
Expected: この時点では `StartScreen` はまだ `bedtime` を使わない。EN/JA 両方に `bedtime` が揃っていれば型エラーなし（片方だけだと `STR` の型不一致で FAIL するので、両方追加済みであることの確認になる）。

### 3b. StartScreen に就寝前案内を表示

- [ ] **Step 31: hero 直下にゲート付き1文を追加**

`app/client/src/screens/StartScreen.tsx` の `StartScreen` 関数内。既存の日付ラベル計算（`const today = new Date();` と `const dateLabel = t.hero.date(today);`）の直後に1行足す:

```typescript
  const today = new Date();
  const dateLabel = t.hero.date(today);
  // 就寝前レビュー案内（P6-4）: ローカル20時以降のみ・情報的な一言。通知/強制/未達表示はしない
  const showBedtime = today.getHours() >= 20;
```

`return (...)` 内、hero の `<div className="hero">...</div>` ブロックの **直後** に、就寝前案内を挿入する（既存の測定導線コメント `{/* 未測定の測定導線... */}` の前）:

```tsx
      <div className="hero">
        <p className="hero-greet">👋 {dateLabel}</p>
        <h2 className="hero-title">{t.hero.title}</h2>
      </div>

      {showBedtime && <p className="hero-bedtime text-sm text-muted">{t.hero.bedtime}</p>}

      {/* 未測定の測定導線は「最初の一歩」なのでヒーロー直下。練習メニュー群とは別物として扱う */}
```

> `text-sm` / `text-muted` は既存の共有ユーティリティクラス（同ファイルの cal-legend / ProposalCard で使用実績あり）。`hero-bedtime` はスタイル未定義でも無害な hook。新規 CSS は追加不要。

- [ ] **Step 32: クライアントの型とビルドを確認**

Run: `cd app/client && bun run build`
Expected: 成功（`tsc --noEmit` で `hero.bedtime` 参照が型解決し、`vite build` が完了）

- [ ] **Step 33: サーバ側の回帰確認（無変更の担保）**

Run: `cd app && bun test`
Expected: PASS（Task 3 はサーバ無変更・回帰なし）

- [ ] **Step 34: コミット**

```bash
git add app/client/src/screens/StartScreen.tsx app/client/src/i18n.ts
git commit -m "feat: 夜間（ローカル20時以降）にホームへ就寝前レビュー案内を表示（P6-4）"
```

---

## Self-Review

**1. Spec coverage（P6-1 / P6-4 のみ・P6-2/P6-3 は対象外）**

| spec 要件 | 実装タスク |
|---|---|
| P6-1: 既存 "high-frequency English (B1)" 行を stage 条件付きで強化 | `vocabConstraint`（Task 1a）＋各プロンプト差し替え |
| P6-1: coach.ts の roleplayPrompt / MODEL_TALK_SYSTEM / prepSystem に stage | Task 1b（Step 7）＋ index 配線 Task 2c（Step 24） |
| P6-1: 自由会話 override 経路の3点セット（builder化・deps・route組み立て） | Task 2a/2b（Step 18/22）＋ index `conversationStage`（Step 24） |
| P6-1: content-gen.ts（例文・お題生成 CLI）にも同制約 | Task 1c（Step 11・13） |
| P6-1: フェイク runner で opts.systemPrompt に制約文言を assert | coach.test（Step 5）・content-gen.test の `makeCapturingRunner`（Step 9）・routes-converse.test（Step 20）・converse.test（Step 16） |
| P6-1: stage 4+ は現行文言維持（低ステージのみ変更） | `vocabConstraint` の分岐＋各 stage 4+ テスト |
| P6-1 やらないこと: NGSL 同梱の機械的カバレッジ検証 | 実装しない（Global Constraints に明記） |
| P6-4: StartScreen hero 直下・ローカル20時以降のみ | Task 3b（Step 31） |
| P6-4: 情報的一言・通知/強制/未達表示なし | `showBedtime` の単純ゲート＋文字列のみ |
| P6-4: HeroStrings に1キー（EN/JA） | Task 3a（Step 27〜29） |
| P6-4 やらないこと: home への due 件数表示 | 実装しない |

ギャップなし。

**2. Placeholder scan**

"TBD"・"適切に処理"・"必要に応じて"・「Task N と同様」等は不使用。各コード変更は完全なコード塊で提示。テストの既存呼び出し更新（generatePrepPack ×7・genSentences ×5）は左→右の具体差し替えで列挙済み（読み手がタスクを前後どちらから読んでも自己完結）。

**3. Type consistency**

- `vocabConstraint(stage: number): string` — 定義（progression.ts）と全参照（coach.ts・converse.ts・content-gen.ts）で一致。
- `roleplayPrompt(scenario, stage)` — coach.ts 定義・coach.test・index.ts 呼び出しで2引数一致。
- `generateModelTalk({..., stage})` / `generatePrepPack({..., stage})` — 定義・coach.test・index.ts で `stage` フィールド一致。
- `partnerSystemPrompt(stage)` / `PARTNER_SYSTEM_PROMPT = partnerSystemPrompt(1)` — converse.ts 定義・converse.test・routes/converse.ts import で一致。
- `ConverseRoutesDeps.conversationStage: () => number` — routes/converse.ts 定義・route-deps フェイク（`() => 2`）・index.ts 実配線（`() => stageOf(progressStore.getLevel())`）で一致。
- `GenSentencesDeps.stage: number` — content-gen.ts 定義・content-gen.test 呼び出し・CLI 供給で一致。
- `HeroStrings.hero.bedtime: string` — i18n 型・EN/JA 辞書・StartScreen 参照で一致。

**判定に効く設計メモ（実装者向け）:**
- 語彙 assert は em/en dash 依存を避けるため `"word families"`（低）・`"B1 level"`（高）の安定部分文字列で行う。`prepSystem` は形状ヒントに恒常的に "B1 level" を含むため prep のみ `word families` の有無だけで判定する。
- Task 1 単独では `index.ts` 未更新で `cd app && bun run typecheck` が失敗する（設計上の連続性）。全ゲート通過は Task 2 完了時（Step 25）。中間型不整合を嫌う場合は Task 1・2 を同ブランチで連続実行する。
