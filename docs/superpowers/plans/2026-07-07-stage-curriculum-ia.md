# Stage別カリキュラム + 情報設計（IA）再設計 Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 日替わりメニューのブロック構成を stage 帯で変え（Four Strands の配分を stage 連動化）、サイドバーを目的別セクション + 「今のあなた向け」推奨マークに整理し、ホームに「今日はこれ→これ」のガイド付きパスを追加して、「どれがメインでどれがサブか・順番が分からない」を解消する。

**Architecture:** サーバは `stageOf(level)` を 3 帯（foundation=1-2 / development=3-4 / fluency=5-6）にまとめる純関数 `stageBand` を追加し、`buildTodayMenu` を「stage帯 × セッション長 → 順序付きブロック構成表」を引く形に refactor する。ブロックの**実装（画面・params 生成）は完全に再利用**し、変えるのは各ブロックの**分数と並び**だけ（種類の出現/非出現は現行と同一＝移行が安全）。クライアントは `/api/progress/summary` が既に返す `stage` を単一ソースにし、`stageBand` の写し + 推奨マップ（純関数 + テスト）を持ち、サイドバーのセクション化・推奨バッジ・ホームのガイドパス・例文の「卒業」表示を描画する。全ての stage 連動は「メニュー構成」と「推奨表示」に限定し、モードの削除・ロックは一切しない（研究制約: 情報的・非強制）。

**Tech Stack:** Bun + TypeScript（サーバ: `app/server`、テスト `bun test`）、React 18 + Vite（クライアント: `app/client`）、named-type i18n（`app/client/src/i18n.ts` の `STR`）。

## Global Constraints

- **消さない・ロックしない**: 全モード（自由会話・ロールプレイ・例文・多聴・ライブラリ・進捗・レベル測定）は常に到達可能。stage 連動は「メニュー構成の分数/並び」と「推奨表示（バッジ・ガイドパス・卒業の一言）」だけで行う。難易度で機能を隠さない。
- **メニューエンジンの変更範囲**: `menu.ts`/`rotation.ts` の変更は「ブロック構成表の追加」と「`buildTodayMenu` の構成表参照化」に留める。ブロックの画面実装・params 生成ロジック・`buildQuickMenu`・ローテーション（`rotation.ts`）は変えない。
- **キャッシュ互換**: 通しメニューのキャッシュキーは現行どおり `menu-<ymd>-<minutes>.json`（level を含めない）。`isValidMenuShape`（`blocks` が非空配列 かつ `level` が number）は変えない。**当日すでに構築済みのメニューは、旧コードが書いた構成でもその日のうちは維持し、新構成は翌日の初回ビルドから反映する**（「当日メニューは固定」の既存契約を踏襲＝途中離脱ユーザーの体験を壊さない）。同日反映が必要な明示的レベル変更（accept/set）は既存の `invalidateTodayMenuCache` がカバー済み。
- **named-type i18n**: UI 文言はすべて `STR` 経由で EN/JA 両方を用意し、新規グループは `type XStrings` を定義して `Strings` 交差型に追加する。ASCII 代替を使わず日本語の表記を正しく保つ。
- **サーバ TDD**: サーバの純関数・`buildTodayMenu` は Red→Green→Commit。ルート層（`makeMenuRoutes` 等）は変更しない（メニュールートは既に `buildMenu`/`buildQuick` に level を注入済み: `index.ts` が `progressStore.getLevel()` を渡す）。
- **クライアントのテスト方針**: このリポジトリの client テストは純ロジックの `*.test.ts` のみ（React レンダリングテストは無い）。**推奨マップ・帯判定は純関数として `.test.ts` で TDD し、React コンポーネントはテスト済みヘルパの薄いラッパにする**。
- **メニュー構成表（このプランで確定する値）**:

  60分:
  | ブロック | foundation(1-2) | development(3-4) | fluency(5-6) |
  |---|---|---|---|
  | warmup-reading | 10 | 8 | 6 |
  | shadowing | 12 | 6 | 5 |
  | four-three-two | 16 | 18 | 14 |
  | roleplay | 12 | 20 | 26 |
  | reflection | 7 | 5 | 5 |
  | 並び順 | 音読→シャドー→4/3/2→RP→振返り | 音読→4/3/2→RP→シャドー→振返り | 音読→4/3/2→RP→シャドー→振返り |

  30分（全帯 4 ブロック・シャドーイングなし＝現行踏襲）:
  | ブロック | foundation | development | fluency |
  |---|---|---|---|
  | warmup-reading | 8 | 6 | 4 |
  | four-three-two | 12 | 12 | 10 |
  | roleplay | 8 | 10 | 14 |
  | reflection | 2 | 2 | 2 |

- **検証コマンド**: `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build`（`bun test` は app 直下から server と client/src の両方の `*.test.ts` を収集する）。

---

## File Structure

**サーバ（メニュー構成）**
- `app/server/progression.ts` — 変更: `StageBand` 型と `stageBand(stage)` 純関数を追加（stageOf の隣、数値定義の単一ソースに集約）。
- `app/server/menu.ts` — 変更: `MENU_COMPOSITIONS` 構成表と `blockFromSpec` を追加し、`buildTodayMenu` のブロック生成を構成表参照に refactor。`buildQuickMenu` は不変。
- `app/server/__tests__/progression.test.ts` — 変更: `stageBand` の describe を追加。
- `app/server/__tests__/menu.test.ts` — 変更: 既存の構成アサーション（60/30分・titleKey）を新構成に更新し、development/fluency 帯・移行キャッシュのテストを追加。

**クライアント（共有 stage プランビング）**
- `app/client/src/stage.ts` — 新規: `StageBand`・`stageBand`・`NavKey`・`navRecommendations`・`GuidedStepId`・`guidedPath` の純ロジック。
- `app/client/src/stage.test.ts` — 新規: 上記純関数のテスト。
- `app/client/src/api/progress.ts` — 変更: 直近 summary のキャッシュ（`getCachedSummary`/`ensureSummaryLoaded`）と `fetchProgressSummary` の通知結線を追加。
- `app/client/src/api/index.ts` — 変更: `getCachedSummary`/`ensureSummaryLoaded` を再エクスポート。
- `app/client/src/api/progress.test.ts` — 変更: キャッシュ + 通知のテストを追加。
- `app/client/src/useStage.ts` — 新規: `useStage(): number | null` フック（summary キャッシュ購読）。

**クライアント（IA・ガイドパス・卒業表示）**
- `app/client/src/i18n.ts` — 変更: `IaStrings`/`GuidedStrings` 型 + `sentences.graduationNote` を追加し EN/JA を実装。
- `app/client/src/App.tsx` — 変更: サイドバーをセクション化 + 推奨バッジ（`useStage` 駆動）。
- `app/client/src/screens/StartScreen.tsx` — 変更: `StartSelection` を `sentences`/`listening` に拡張、`GuidedPath` コンポーネントを追加。
- `app/client/src/screens/SentencesScreen.tsx` — 変更: fluency 帯で「卒業」の一言を表示。
- `app/client/src/styles/app.css` — 変更: サイドバーセクション見出し・推奨バッジ・ガイドパスの最小スタイル。

**ドキュメント**
- `CHANGELOG.md` — 変更: `Unreleased`/次バージョンに本変更を追記。

---

## Task 1: サーバ `stageBand` 純関数

**Files:**
- Modify: `app/server/progression.ts`（`stageOf` の直後に追加）
- Test: `app/server/__tests__/progression.test.ts`

**Interfaces:**
- Produces: `export type StageBand = "foundation" | "development" | "fluency"` / `export function stageBand(stage: number): StageBand`
- Consumes: なし（純関数）

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/progression.test.ts` の import 行（1〜5行目）に `stageBand` を加える:

```ts
import {
  BOUNDARY_LEVELS, DEFAULT_LEVEL, demotionTargetLevel, fttMiniRoundsSec, fttRoundsSec,
  needXp, PLACEMENT_XP, prepParams, stageAnchorLevel, stageBand, stageOf, syntaxConstraint, vocabConstraint, xpForGrade,
} from "../progression";
```

ファイル末尾に describe を追加:

```ts
describe("progression: stageBand", () => {
  test("stage1-2 は foundation", () => {
    expect(stageBand(1)).toBe("foundation");
    expect(stageBand(2)).toBe("foundation");
  });
  test("stage3-4 は development", () => {
    expect(stageBand(3)).toBe("development");
    expect(stageBand(4)).toBe("development");
  });
  test("stage5-6 は fluency", () => {
    expect(stageBand(5)).toBe("fluency");
    expect(stageBand(6)).toBe("fluency");
  });
  test("範囲外・端数は端にクランプ", () => {
    expect(stageBand(0)).toBe("foundation");
    expect(stageBand(2.9)).toBe("foundation");
    expect(stageBand(99)).toBe("fluency");
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `cd app && bun test __tests__/progression.test.ts`
Expected: FAIL（`stageBand` is not exported / not a function）

- [ ] **Step 3: 実装を書く**

`app/server/progression.ts` の `stageOf`（17〜19行目）の直後に追加:

```ts
/** stage 帯（メニュー構成と推奨表示の粒度）。1-2=foundation / 3-4=development / 5-6=fluency。 */
export type StageBand = "foundation" | "development" | "fluency";

/** stage(1..6) → 帯。範囲外・端数は端にクランプする。 */
export function stageBand(stage: number): StageBand {
  const s = Math.min(Math.max(Math.trunc(stage), 1), 6);
  if (s <= 2) return "foundation";
  if (s <= 4) return "development";
  return "fluency";
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test __tests__/progression.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/server/progression.ts app/server/__tests__/progression.test.ts
git commit -m "feat: stage帯判定 stageBand を追加（1-2/3-4/5-6）"
```

---

## Task 2: サーバ メニュー構成の stage 連動化（`buildTodayMenu`）

**Files:**
- Modify: `app/server/menu.ts:64-120`（`buildTodayMenu` の import と本体）
- Test: `app/server/__tests__/menu.test.ts`

**Interfaces:**
- Consumes: `stageBand`（Task 1）, `stageOf`/`fttRoundsSec`/`prepParams`/`DEFAULT_LEVEL`（既存）, `pickNextByDomain`/`pickNext`/`filterInBand`/`markUsed`/`saveRotation`（既存）, `roleplayTitle`/`roleplayTitleKey`（既存）
- Produces: `buildTodayMenu(minutes, deps)` は同一シグネチャのまま、帯に応じたブロック並び・分数を返す。ブロックの `id` は `b1..bN`、`kind`/`title`/`titleKey`/`topicTitle`/`params` は現行と同一の生成則。

- [ ] **Step 1: 既存テストを新構成へ更新し、失敗させる**

`app/server/__tests__/menu.test.ts` の import（10行目）に `stageOf` は不要。以下の3テストを**置き換える**。

置き換え1 — 124〜143行目「60分版」を:

```ts
  test("60分・stage1（foundation帯）: 音読・シャドーイングを厚く＋4/3/2＋ロールプレイ＋振り返り", () => {
    const dirs = makeContentDirs();
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(menu.date).toBe("2026-07-05");
    expect(menu.blocks.map((b) => [b.kind, b.minutes])).toEqual([
      ["warmup-reading", 10],
      ["shadowing", 12],
      ["four-three-two", 16],
      ["roleplay", 12],
      ["reflection", 7],
    ]);
    const warmup = menu.blocks[0].params.topic as ContentItem;
    const ftt = menu.blocks[2].params.topic as ContentItem;
    const rp = menu.blocks[3].params.scenario as ContentItem;
    const shadow = menu.blocks[1].params.topic as ContentItem;
    expect(ftt.id).toBe("t1");
    expect(rp.id).toBe("s1");
    expect(shadow.id).not.toBe(ftt.id); // シャドーイングは別トピック（次のローテーション候補）
    expect(warmup).toBe(ftt); // 音読ウォームアップは4/3/2と同じトピックオブジェクト
  });
```

置き換え2 — 145〜154行目「30分版」を:

```ts
  test("30分・stage1（foundation帯）: 音読・4/3/2・ロールプレイ・振り返りの4ブロック", () => {
    const dirs = makeContentDirs();
    const menu = buildTodayMenu(30, { ...dirs, today: JULY5 });
    expect(menu.blocks.map((b) => [b.kind, b.minutes])).toEqual([
      ["warmup-reading", 8],
      ["four-three-two", 12],
      ["roleplay", 8],
      ["reflection", 2],
    ]);
  });
```

置き換え3 — 246〜258行目「各ブロックが titleKey を持ち…」を:

```ts
  test("各ブロックが titleKey を持ち、topic 系は topicTitle を返す（stage1=foundation帯の並び）", () => {
    const dirs = makeContentDirs();
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    // makeContentDirs の s1 は domain 省略＝既定 "it" なので roleplay-it になる
    expect(menu.blocks.map((b) => b.titleKey)).toEqual([
      "warmup", "shadowing", "ftt", "roleplay-it", "reflection",
    ]);
    const ftt = menu.blocks[2];
    expect(ftt.topicTitle).toBe("Topic One");
    expect(ftt.title).toBe("4/3/2: Topic One"); // title(JA) は据え置き
    expect(menu.blocks[0].topicTitle).toBeUndefined(); // warmup は topicTitle なし
    expect(menu.blocks[4].topicTitle).toBeUndefined(); // reflection も無し
  });
```

Run: `cd app && bun test __tests__/menu.test.ts`
Expected: FAIL（現行は stage 非依存の固定並び `[8,16,20,8,5]` を返すため、新期待値と不一致）

- [ ] **Step 2: 構成表とブロック生成を実装する**

`app/server/menu.ts` の import（5行目）に `stageBand` と型 `StageBand` を追加:

```ts
import { DEFAULT_LEVEL, fttMiniRoundsSec, fttRoundsSec, prepParams, stageBand, stageOf, type StageBand } from "./progression";
```

`Menu` 型定義（26行目）の直後に構成表と生成関数を追加:

```ts
/** 1ブロックの種類と割当分（分）。順序は配列の並びが提示順。 */
type BlockSpec = { kind: BlockKind; minutes: number };

/**
 * stage 帯 × セッション長 → 順序付きブロック構成表。
 * Four Strands の配分を stage で変える。研究制約（情報的・非強制）を守るため
 * 「消さない・並べ替えと分数で表現」する: どの帯でもブロックの"種類"は現行と同一で、
 * 出現/非出現は変えず分数と並びだけ変える（＝当日キャッシュの互換を壊さず移行できる）。
 * - foundation(1-2): 音読＋シャドーイングを厚く（language-focused/form）、ロールプレイ控えめ
 * - development(3-4): 4/3/2＋ロールプレイ主役（fluency＋meaning-focused output）
 * - fluency(5-6): ロールプレイ主役（開かれた産出）、音読・シャドーイングは最小
 */
const MENU_COMPOSITIONS: Record<StageBand, Record<60 | 30, readonly BlockSpec[]>> = {
  foundation: {
    60: [
      { kind: "warmup-reading", minutes: 10 },
      { kind: "shadowing", minutes: 12 },
      { kind: "four-three-two", minutes: 16 },
      { kind: "roleplay", minutes: 12 },
      { kind: "reflection", minutes: 7 },
    ],
    30: [
      { kind: "warmup-reading", minutes: 8 },
      { kind: "four-three-two", minutes: 12 },
      { kind: "roleplay", minutes: 8 },
      { kind: "reflection", minutes: 2 },
    ],
  },
  development: {
    60: [
      { kind: "warmup-reading", minutes: 8 },
      { kind: "four-three-two", minutes: 18 },
      { kind: "roleplay", minutes: 20 },
      { kind: "shadowing", minutes: 6 },
      { kind: "reflection", minutes: 5 },
    ],
    30: [
      { kind: "warmup-reading", minutes: 6 },
      { kind: "four-three-two", minutes: 12 },
      { kind: "roleplay", minutes: 10 },
      { kind: "reflection", minutes: 2 },
    ],
  },
  fluency: {
    60: [
      { kind: "warmup-reading", minutes: 6 },
      { kind: "four-three-two", minutes: 14 },
      { kind: "roleplay", minutes: 26 },
      { kind: "shadowing", minutes: 5 },
      { kind: "reflection", minutes: 5 },
    ],
    30: [
      { kind: "warmup-reading", minutes: 4 },
      { kind: "four-three-two", minutes: 10 },
      { kind: "roleplay", minutes: 14 },
      { kind: "reflection", minutes: 2 },
    ],
  },
};

/** 選んだ素材からブロックを1つ生成する。title/titleKey/params は現行 buildTodayMenu と同一の生成則。 */
function blockFromSpec(
  spec: BlockSpec,
  index: number,
  ctx: { mainTopic: ContentItem; scenario: ContentItem; shadowTopic: ContentItem; level: number; stage: number },
): MenuBlock {
  const id = `b${index + 1}`;
  switch (spec.kind) {
    case "warmup-reading":
      return { id, kind: spec.kind, title: "音読ウォームアップ", titleKey: "warmup", minutes: spec.minutes, params: { topic: ctx.mainTopic } };
    case "four-three-two":
      return {
        id, kind: spec.kind, title: `4/3/2: ${ctx.mainTopic.title}`, titleKey: "ftt", topicTitle: ctx.mainTopic.title,
        minutes: spec.minutes, params: { topic: ctx.mainTopic, roundsSec: fttRoundsSec(ctx.level), modelTalkMode: prepParams(ctx.stage).modelTalk },
      };
    case "roleplay":
      return {
        id, kind: spec.kind, title: roleplayTitle(ctx.scenario), titleKey: roleplayTitleKey(ctx.scenario), topicTitle: ctx.scenario.title,
        minutes: spec.minutes, params: { scenario: ctx.scenario },
      };
    case "shadowing":
      return { id, kind: spec.kind, title: `シャドーイング: ${ctx.shadowTopic.title}`, titleKey: "shadowing", topicTitle: ctx.shadowTopic.title, minutes: spec.minutes, params: { topic: ctx.shadowTopic } };
    case "reflection":
      return { id, kind: spec.kind, title: "振り返り", titleKey: "reflection", minutes: spec.minutes, params: {} };
    default:
      // chunk-placeholder は構成表に含めない（存在すれば構成表の設定ミス）
      throw new Error(`buildTodayMenu: unsupported block kind in composition: ${spec.kind}`);
  }
}
```

`buildTodayMenu` 本体のブロック生成部（99〜116行目、`const warmupTitle = ...` から `const menu: Menu = ...` の直前まで）を次で置き換える。素材選択の順序（main→scenario→shadow→markUsed→save）は現行の rotation 挙動を保つため厳密に維持する:

```ts
  const band = stageBand(stage);
  const specs = MENU_COMPOSITIONS[band][minutes];
  const kinds = new Set(specs.map((s) => s.kind));

  // mainTopic は音読ウォームアップと 4/3/2 で共用（同一トピックで音読→4/3/2 が繋がる）
  const mainTopic = pickNextByDomain(topics, state, ymd, stage, "topic");
  const scenario = pickNextByDomain(scenarios, state, ymd, stage, "scenario");
  // シャドーイング素材は「次にローテーションが選ぶトピック」のプレビュー。使用済みマーク・カーソル前進はしない。
  // 構成にシャドーイングが無い帯（30分など）では選ばない（無駄なローテーション参照を避ける）。
  let shadowTopic = mainTopic;
  if (kinds.has("shadowing")) {
    const others = topics.filter((t) => t.id !== mainTopic.id);
    const shadowPool = others.length > 0 ? filterInBand(others, stage) : others;
    shadowTopic = shadowPool.length > 0 ? pickNext(shadowPool, state.usage, ymd) : mainTopic;
  }

  markUsed(state.usage, mainTopic.id, ymd);
  markUsed(state.usage, scenario.id, ymd);
  saveRotation(usageFile, state);

  const blocks: MenuBlock[] = specs.map((spec, i) =>
    blockFromSpec(spec, i, { mainTopic, scenario, shadowTopic, level, stage }));
```

（`const menu: Menu = { minutes, date: ymd, level, blocks };` 以降のキャッシュ書き込みは現行のまま残す。）

- [ ] **Step 3: 更新した既存テストが通ることを確認**

Run: `cd app && bun test __tests__/menu.test.ts`
Expected: PASS（60分=`[10,12,16,12,7]`、30分=`[8,12,8,2]`、titleKey=`["warmup","shadowing","ftt","roleplay-it","reflection"]`）

- [ ] **Step 4: development/fluency 帯と移行キャッシュのテストを追加して落ちないことを確認**

`app/server/__tests__/menu.test.ts` の `describe("menu: レベル駆動", ...)` ブロック内の末尾（466行目 `});` の直前）に追加:

```ts
  test("stage3（development帯）: 4/3/2＋ロールプレイ主役の並び・分数（level 25）", () => {
    const dirs = makeContentDirs();
    const m = buildTodayMenu(60, { ...dirs, level: 25, today: () => new Date("2026-07-06T09:00:00") });
    expect(m.blocks.map((b) => [b.kind, b.minutes])).toEqual([
      ["warmup-reading", 8],
      ["four-three-two", 18],
      ["roleplay", 20],
      ["shadowing", 6],
      ["reflection", 5],
    ]);
  });
  test("stage5（fluency帯）: ロールプレイ主役・音読/シャドーイング最小（level 45）", () => {
    const dirs = makeContentDirs();
    const m = buildTodayMenu(60, { ...dirs, level: 45, today: () => new Date("2026-07-06T09:00:00") });
    expect(m.blocks.map((b) => [b.kind, b.minutes])).toEqual([
      ["warmup-reading", 6],
      ["four-three-two", 14],
      ["roleplay", 26],
      ["shadowing", 5],
      ["reflection", 5],
    ]);
  });
  test("30分も帯で分数が変わる（development=level25 / fluency=level45）", () => {
    const dev = buildTodayMenu(30, { ...makeContentDirs(), level: 25, today: () => new Date("2026-07-06T09:00:00") });
    expect(dev.blocks.map((b) => [b.kind, b.minutes])).toEqual([
      ["warmup-reading", 6], ["four-three-two", 12], ["roleplay", 10], ["reflection", 2],
    ]);
    const flu = buildTodayMenu(30, { ...makeContentDirs(), level: 45, today: () => new Date("2026-07-06T09:00:00") });
    expect(flu.blocks.map((b) => [b.kind, b.minutes])).toEqual([
      ["warmup-reading", 4], ["four-three-two", 10], ["roleplay", 14], ["reflection", 2],
    ]);
  });
```

`describe("buildTodayMenu", ...)` ブロックの末尾（259行目 `});` の直前）に移行テストを追加:

```ts
  test("移行: 旧構成で作られた当日キャッシュ（level付き）はそのまま返し、新構成へ再構築しない", () => {
    const dirs = makeContentDirs();
    mkdirSync(dirs.menuCacheDir, { recursive: true });
    const cacheFile = path.join(dirs.menuCacheDir, "menu-2026-07-05-60.json");
    // 旧コードが書いた形（現行と異なるブロック並び [8,16,20,8,5]）でも level と blocks を持てば当日は維持される
    const legacy = {
      minutes: 60, date: "2026-07-05", level: DEFAULT_LEVEL,
      blocks: [
        { id: "b1", kind: "warmup-reading", title: "音読ウォームアップ", titleKey: "warmup", minutes: 8, params: {} },
        { id: "b2", kind: "four-three-two", title: "4/3/2: X", titleKey: "ftt", minutes: 16, params: {} },
        { id: "b3", kind: "roleplay", title: "RP", titleKey: "roleplay-it", minutes: 20, params: {} },
        { id: "b4", kind: "shadowing", title: "S", titleKey: "shadowing", minutes: 8, params: {} },
        { id: "b5", kind: "reflection", title: "振り返り", titleKey: "reflection", minutes: 5, params: {} },
      ],
    };
    writeFileSync(cacheFile, JSON.stringify(legacy));
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(menu.blocks.map((b) => b.minutes)).toEqual([8, 16, 20, 8, 5]); // 当日は旧構成のまま
  });
```

Run: `cd app && bun test __tests__/menu.test.ts`
Expected: PASS（追加分含む全 PASS）

- [ ] **Step 5: メニュー関連の全テスト + typecheck を確認**

Run: `cd app && bun test __tests__/menu.test.ts __tests__/routes-menu.test.ts && bun run typecheck`
Expected: PASS（`routes-menu` はフェイク注入なので影響なし。typecheck も通る）

- [ ] **Step 6: コミット**

```bash
git add app/server/menu.ts app/server/__tests__/menu.test.ts
git commit -m "feat: 日替わりメニューのブロック構成をstage帯連動に（構成表参照化）"
```

---

## Task 3: クライアント stage 推奨ロジック（純関数）

**Files:**
- Create: `app/client/src/stage.ts`
- Test: `app/client/src/stage.test.ts`

**Interfaces:**
- Produces:
  - `export type StageBand = "foundation" | "development" | "fluency"`
  - `export function stageBand(stage: number): StageBand`
  - `export type NavKey = "home" | "placement" | "free" | "library" | "sentences" | "listening" | "progress"`
  - `export function navRecommendations(band: StageBand): NavKey[]`
  - `export type GuidedStepId = "sentences" | "shadowing" | "warmup" | "ftt-mini" | "roleplay-daily" | "roleplay-business" | "free" | "listening" | "session-30"`
  - `export function guidedPath(band: StageBand): GuidedStepId[]`
- Consumes: なし（サーバ `stageBand` の写し。値は同一に保つ）

- [ ] **Step 1: 失敗するテストを書く**

`app/client/src/stage.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { guidedPath, navRecommendations, stageBand } from "./stage";

describe("stageBand", () => {
  test("1-2=foundation / 3-4=development / 5-6=fluency・範囲外クランプ", () => {
    expect(stageBand(1)).toBe("foundation");
    expect(stageBand(2)).toBe("foundation");
    expect(stageBand(3)).toBe("development");
    expect(stageBand(4)).toBe("development");
    expect(stageBand(5)).toBe("fluency");
    expect(stageBand(6)).toBe("fluency");
    expect(stageBand(0)).toBe("foundation");
    expect(stageBand(99)).toBe("fluency");
  });
});

describe("navRecommendations", () => {
  test("foundation は暗記例文を推す", () => {
    expect(navRecommendations("foundation")).toEqual(["sentences"]);
  });
  test("development は自由会話を推す", () => {
    expect(navRecommendations("development")).toEqual(["free"]);
  });
  test("fluency は自由会話と多聴を推す", () => {
    expect(navRecommendations("fluency")).toEqual(["free", "listening"]);
  });
});

describe("guidedPath", () => {
  test("各帯は3ステップで、既存モード/ドリルの id のみを使う", () => {
    expect(guidedPath("foundation")).toEqual(["sentences", "shadowing", "warmup"]);
    expect(guidedPath("development")).toEqual(["ftt-mini", "roleplay-daily", "session-30"]);
    expect(guidedPath("fluency")).toEqual(["free", "roleplay-business", "listening"]);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `cd app && bun test client/src/stage.test.ts`
Expected: FAIL（`./stage` が存在しない）

- [ ] **Step 3: 実装を書く**

`app/client/src/stage.ts`:

```ts
/**
 * stage（1..6）を帯に落とし、帯ごとの「今のあなた向け」推奨を返す純ロジック。
 * サーバ progression.ts の stageBand の写し（値は同一に保つ）。stage 自体は
 * /api/progress/summary の summary.stage を単一ソースにする（このモジュールは判定のみ）。
 * すべて情報的・非強制: 推奨はマーク/並びに使うだけで、モードの削除・ロックはしない。
 */
export type StageBand = "foundation" | "development" | "fluency";

export function stageBand(stage: number): StageBand {
  const s = Math.min(Math.max(Math.trunc(stage), 1), 6);
  if (s <= 2) return "foundation";
  if (s <= 4) return "development";
  return "fluency";
}

/** サイドバーのナビ項目キー（App.tsx の navItems.key と一致させる）。 */
export type NavKey = "home" | "placement" | "free" | "library" | "sentences" | "listening" | "progress";

/** 帯ごとに「今のあなた向け」バッジを付けるサイドバー自主練モード。 */
export function navRecommendations(band: StageBand): NavKey[] {
  switch (band) {
    case "foundation":
      return ["sentences"]; // 暗記例文で表現の在庫を作る段階
    case "development":
      return ["free"]; // 覚えた表現を会話で使い始める段階
    case "fluency":
      return ["free", "listening"]; // 開かれた産出＋レベル適合の多聴
  }
}

/** ホームのガイドパスのステップ id（既存のクイックドリル/モードに1対1で対応）。 */
export type GuidedStepId =
  | "sentences" | "shadowing" | "warmup"
  | "ftt-mini" | "roleplay-daily" | "roleplay-business"
  | "free" | "listening" | "session-30";

/** 「今日はこれ→これ」の3ステップ。帯ごとに Four Strands の主役を先頭に置く。 */
export function guidedPath(band: StageBand): GuidedStepId[] {
  switch (band) {
    case "foundation":
      return ["sentences", "shadowing", "warmup"];
    case "development":
      return ["ftt-mini", "roleplay-daily", "session-30"];
    case "fluency":
      return ["free", "roleplay-business", "listening"];
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test client/src/stage.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/client/src/stage.ts app/client/src/stage.test.ts
git commit -m "feat: クライアントの stage帯・推奨・ガイドパスの純ロジックを追加"
```

---

## Task 4: クライアント summary キャッシュ + `useStage` フック

**Files:**
- Modify: `app/client/src/api/progress.ts`
- Modify: `app/client/src/api/index.ts:7-17`（progress の名前付き再エクスポート）
- Create: `app/client/src/useStage.ts`
- Test: `app/client/src/api/progress.test.ts`

**Interfaces:**
- Produces:
  - `export function getCachedSummary(): ProgressSummary | null`
  - `export function ensureSummaryLoaded(): void`
  - `export function useStage(): number | null`（`useStage.ts`）
  - `fetchProgressSummary` は取得成功時に `notifyProgress` を呼ぶ（キャッシュ更新 + 購読者通知）
- Consumes: 既存 `onProgressUpdate`/`notifyProgress`/`ProgressSummary`

- [ ] **Step 1: 失敗するテストを書く**

`app/client/src/api/progress.test.ts` の import（2行目）を差し替え:

```ts
import { ensureSummaryLoaded, fetchProgressSummary, getCachedSummary, onProgressUpdate, progressBlockXp, progressLevelAction, type ProgressSummary } from "./progress";
```

ファイル末尾に describe を追加:

```ts
describe("progress の summary キャッシュ", () => {
  test("fetchProgressSummary は cache に載せ、購読者へ通知する", async () => {
    stubFetchOk(SUMMARY);
    const seen: ProgressSummary[] = [];
    const unsub = onProgressUpdate((s) => seen.push(s));
    const got = await fetchProgressSummary();
    unsub();
    expect(got).toEqual(SUMMARY);
    expect(seen).toEqual([SUMMARY]);
    expect(getCachedSummary()).toEqual(SUMMARY);
  });

  test("ensureSummaryLoaded は cache 済みなら再取得しない", async () => {
    stubFetchOk(SUMMARY);
    await fetchProgressSummary(); // cache を温める
    let calls = 0;
    globalThis.fetch = mock(async () => { calls += 1; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    ensureSummaryLoaded();
    expect(calls).toBe(0); // 既に cache 済みなので fetch しない
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `cd app && bun test client/src/api/progress.test.ts`
Expected: FAIL（`getCachedSummary`/`ensureSummaryLoaded` が export されていない）

- [ ] **Step 3: 実装を書く**

`app/client/src/api/progress.ts` の `notifyProgress`（29〜31行目）を置き換え、直前にキャッシュ変数を追加:

```ts
/** 直近に観測した summary。stage 等を再取得なしで参照するための軽量キャッシュ。 */
let lastSummary: ProgressSummary | null = null;

/** 直近の summary（未取得なら null）。useStage 等の同期スナップショットに使う。 */
export function getCachedSummary(): ProgressSummary | null {
  return lastSummary;
}

export function notifyProgress(s: ProgressSummary): void {
  lastSummary = s;
  for (const fn of progressListeners) fn(s);
}
```

`fetchProgressSummary`（47〜51行目）を、取得結果をキャッシュ + 通知する形に置き換え、直後に `ensureSummaryLoaded` を追加:

```ts
export async function fetchProgressSummary(): Promise<ProgressSummary> {
  const res = await fetch("/api/progress/summary");
  if (!res.ok) throw new Error(`progress summary failed: ${await extractErrorMessage(res)}`);
  const summary = (await res.json()) as ProgressSummary;
  notifyProgress(summary);
  return summary;
}

let summaryFetchStarted = false;
/** cache が空なら summary を一度だけ取得する（多重取得を避ける。失敗時は次回再試行できるよう解除）。 */
export function ensureSummaryLoaded(): void {
  if (summaryFetchStarted || lastSummary !== null) return;
  summaryFetchStarted = true;
  fetchProgressSummary().catch(() => { summaryFetchStarted = false; });
}
```

`app/client/src/api/index.ts` の progress 再エクスポート（7〜17行目）に2つ追加:

```ts
export {
  type LevelProposal,
  type ProgressSummary,
  onProgressUpdate,
  notifyProgress,
  fetchProgressSummary,
  getCachedSummary,
  ensureSummaryLoaded,
  progressBlockStart,
  progressBlockXp,
  progressLevelAction,
  fetchPracticeDays,
} from "./progress";
```

`app/client/src/useStage.ts`（新規）:

```ts
import { useEffect, useSyncExternalStore } from "react";
import { ensureSummaryLoaded, getCachedSummary, onProgressUpdate } from "./api";

// onProgressUpdate(subscribe) は () => void 引数のコールバックとしても呼べる。
// getStageSnapshot は number|null のプリミティブを返すため getSnapshot として安全
// （変化が無ければ Object.is で同値と判定され再レンダーループを起こさない）。
function subscribe(cb: () => void): () => void {
  return onProgressUpdate(cb);
}
function getStageSnapshot(): number | null {
  return getCachedSummary()?.stage ?? null;
}

/** 現在の stage（1..6）。未取得なら null を返し、マウント時に一度だけ取得を促す。 */
export function useStage(): number | null {
  const stage = useSyncExternalStore(subscribe, getStageSnapshot, getStageSnapshot);
  useEffect(() => { ensureSummaryLoaded(); }, []);
  return stage;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test client/src/api/progress.test.ts`
Expected: PASS

- [ ] **Step 5: クライアント型チェックを確認**

Run: `cd app/client && bun run build`
Expected: PASS（tsc --noEmit + vite build が通る）

- [ ] **Step 6: コミット**

```bash
git add app/client/src/api/progress.ts app/client/src/api/index.ts app/client/src/useStage.ts app/client/src/api/progress.test.ts
git commit -m "feat: summaryキャッシュとuseStageフックを追加（stageの単一ソース）"
```

---

## Task 5: サイドバー IA（目的別セクション + 「今のあなた向け」バッジ）

**Files:**
- Modify: `app/client/src/i18n.ts`（`IaStrings` 型 + EN/JA）
- Modify: `app/client/src/App.tsx:70-108`（navItems → セクション描画 + バッジ）
- Modify: `app/client/src/styles/app.css`（セクション見出し・バッジ・モバイル）

**Interfaces:**
- Consumes: `useStage`（Task 4）, `stageBand`/`navRecommendations`/`NavKey`（Task 3）, `STR[lang].ia`
- Produces: サイドバーが「今日の練習 / 自主練 / 記録」の3セクションになり、帯に応じた自主練モードに `t.ia.forYou` バッジが付く。項目・アイコン・遷移は現行と同一。

- [ ] **Step 1: i18n に `ia` グループを追加**

`app/client/src/i18n.ts` の `type NavStrings`（31行目）の直後に型を追加:

```ts
type IaStrings = { ia: { sectionToday: string; sectionSelf: string; sectionRecords: string; forYou: string } };
```

`Strings` 交差型（192〜198行目）に `& IaStrings` を追加（例: `NavStrings` の隣）:

```ts
type Strings =
  & NavStrings & IaStrings & UiScaleStrings & AppShellStrings & SupportStrings & StatStrings & HeroStrings
  & QuickStrings & IntensiveStrings & DrillsStrings & SessionCardStrings
  & CalendarStrings & FreeTalkHeaderStrings & ProgressStrings & PlacementStrings & SentencesStrings
  & MenuTitleStrings & SessionStrings
  & WarmupStrings & Ftt432Strings & ReflectionStrings & ChunkListStrings
  & ShadowingStrings & LibraryStrings & RoleplayStrings & FreeTalkScreenStrings & ListeningScreenStrings;
```

`STR.en` の `nav: {...}`（206行目）の直後に:

```ts
    ia: { sectionToday: "Today", sectionSelf: "Self-study", sectionRecords: "Records", forYou: "For you" },
```

`STR.ja` の `nav: {...}`（429行目）の直後に:

```ts
    ia: { sectionToday: "今日の練習", sectionSelf: "自主練", sectionRecords: "記録", forYou: "今のあなた向け" },
```

- [ ] **Step 2: App.tsx のサイドバーをセクション化**

`app/client/src/App.tsx` の import に `useStage` と stage ロジックを追加（18行目の下）:

```ts
import { useStage } from "./useStage";
import { navRecommendations, stageBand, type NavKey } from "./stage";
```

`App` 本体の `const t = STR[lang];`（27行目）の直後に stage を購読:

```ts
  const stage = useStage();
```

`navItems`（70〜78行目）の直後に、セクション定義と推奨集合・キー引きを追加:

```ts
  const navByKey = new Map(navItems.map((n) => [n.key as NavKey, n]));
  const navSections: Array<{ titleKey: "sectionToday" | "sectionSelf" | "sectionRecords"; keys: NavKey[] }> = [
    { titleKey: "sectionToday", keys: ["home"] },
    { titleKey: "sectionSelf", keys: ["free", "sentences", "listening", "library"] },
    { titleKey: "sectionRecords", keys: ["progress", "placement"] },
  ];
  const recSet = stage === null ? new Set<NavKey>() : new Set<NavKey>(navRecommendations(stageBand(stage)));
```

`<nav className="side-nav"> ... </nav>`（84〜91行目）を、セクション描画に置き換え:

```tsx
        <nav className="side-nav">
          {navSections.map((sec) => (
            <div key={sec.titleKey} className="side-section">
              <div className="side-section-title">{t.ia[sec.titleKey]}</div>
              {sec.keys.map((key) => {
                const n = navByKey.get(key);
                if (!n) return null;
                return (
                  <button key={n.key} className={`side-item${n.active ? " is-active" : ""}`} onClick={n.go}>
                    <span className="side-icon" aria-hidden="true">{n.icon}</span>
                    {n.label}
                    {recSet.has(key) && <span className="side-badge">{t.ia.forYou}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
```

- [ ] **Step 3: CSS を追加**

`app/client/src/styles/app.css` の `.side-nav { ... }`（185行目）の直後に追加:

```css
.side-section { display: flex; flex-direction: column; gap: 2px; }
.side-section + .side-section { margin-top: var(--sp-3); }
.side-section-title { font-size: var(--fs-sm); font-weight: 650; color: var(--text-muted); padding: 0 var(--sp-3); margin: 0 0 var(--sp-1); letter-spacing: 0.02em; }
.side-badge { margin-left: auto; font-size: 11px; font-weight: 650; color: var(--accent); background: var(--accent-soft); padding: 1px 6px; border-radius: 999px; }
```

モバイルのメディアクエリ（234〜236行目 `.sidebar { width: 100% ... }` の並び）に、セクションを行方向へ畳む指定を追加:

```css
  .side-section { flex-direction: row; align-items: center; }
  .side-section + .side-section { margin-top: 0; }
  .side-section-title { display: none; }
  .side-badge { display: none; }
```

- [ ] **Step 4: 型チェックとビルドを確認**

Run: `cd app/client && bun run build`
Expected: PASS（`t.ia.sectionToday` 等が型解決し、`NavKey` の網羅で `navByKey.get` が型付く）

- [ ] **Step 5: コミット**

```bash
git add app/client/src/i18n.ts app/client/src/App.tsx app/client/src/styles/app.css
git commit -m "feat: サイドバーを目的別セクション化し stage連動の推奨バッジを追加"
```

---

## Task 6: ホームのガイド付きパス（今日はこれ→これ）

**Files:**
- Modify: `app/client/src/i18n.ts`（`GuidedStrings` 型 + EN/JA）
- Modify: `app/client/src/App.tsx:20,63-68`（`Mode` と `onSelect` を sentences/listening 対応に）
- Modify: `app/client/src/screens/StartScreen.tsx`（`StartSelection` 拡張 + `GuidedPath`）

**Interfaces:**
- Consumes: `guidedPath`/`stageBand`/`GuidedStepId`（Task 3）, `summary.stage`（StartScreen が既に取得）, `STR[lang].guided`
- Produces: `StartSelection` に `{ type: "sentences" }` と `{ type: "listening" }` を追加。App の `onSelect` がそれらを `setMode` で受ける。ホームのヒーロー直下（未測定測定導線の下、クイックドリルの上）に3ステップのガイドパスが出る。

- [ ] **Step 1: i18n に `guided` グループを追加**

`app/client/src/i18n.ts` の `type QuickStrings`（45行目）の直後に型を追加:

```ts
type GuidedStrings = { guided: { title: string; note: string } };
```

`Strings` 交差型に `& GuidedStrings` を追加（`QuickStrings` の隣）:

```ts
  & QuickStrings & GuidedStrings & IntensiveStrings & DrillsStrings & SessionCardStrings
```

`STR.en` の `quick: {...}`（224行目）の直後に:

```ts
    guided: { title: "Today's suggested path", note: "tuned to your level — every mode stays open" },
```

`STR.ja` の `quick: {...}`（447行目）の直後に:

```ts
    guided: { title: "今日のおすすめ", note: "あなたのレベルに合わせた順番です（すべてのメニューはいつでも使えます）" },
```

- [ ] **Step 2: App の Mode / onSelect を sentences・listening に拡張**

`app/client/src/App.tsx` の `onSelect`（63〜68行目）を拡張:

```ts
  function onSelect(sel: StartSelection) {
    if (sel.type === "free") setMode({ kind: "free" });
    else if (sel.type === "library") setMode({ kind: "library" });
    else if (sel.type === "placement") setMode({ kind: "placement" });
    else if (sel.type === "sentences") setMode({ kind: "sentences" });
    else if (sel.type === "listening") setMode({ kind: "listening" });
    else setMode({ kind: "session", source: sel.source });
  }
```

（`Mode` 型（20行目）には既に `sentences`/`listening` があるため変更不要。）

- [ ] **Step 3: StartScreen に GuidedPath を実装**

`app/client/src/screens/StartScreen.tsx` の `StartSelection`（11〜15行目）を拡張:

```ts
export type StartSelection =
  | { type: "session"; source: MenuSource }
  | { type: "free" }
  | { type: "library" }
  | { type: "placement" }
  | { type: "sentences" }
  | { type: "listening" };
```

import に stage ロジックを追加（9行目 `import { localYmd } ...` の下）:

```ts
import { guidedPath, stageBand, type GuidedStepId } from "../stage";
```

`PracticeCalendar` コンポーネント定義（109行目）の直後に、ガイドパスのアクション表・ラベル・コンポーネントを追加:

```tsx
/** ガイドパスの各ステップ → 実際の遷移。すべて既存のクイックドリル/モードに1対1で対応する。 */
const GUIDED_STEP_ACTIONS: Record<GuidedStepId, StartSelection> = {
  sentences: { type: "sentences" },
  shadowing: { type: "session", source: { type: "quick", drill: "shadowing" } },
  warmup: { type: "session", source: { type: "quick", drill: "warmup" } },
  "ftt-mini": { type: "session", source: { type: "quick", drill: "ftt-mini" } },
  "roleplay-daily": { type: "session", source: { type: "quick", drill: "roleplay", domain: "daily" } },
  "roleplay-business": { type: "session", source: { type: "quick", drill: "roleplay", domain: "business" } },
  free: { type: "free" },
  listening: { type: "listening" },
  "session-30": { type: "session", source: { type: "daily", minutes: 30 } },
};

/** ステップのラベルは既存の i18n を再利用する（新規文言を増やさない）。 */
function guidedStepLabel(id: GuidedStepId, t: (typeof STR)["en"]): string {
  switch (id) {
    case "sentences": return t.nav.sentences;
    case "shadowing": return t.drills.shadowing.title;
    case "warmup": return t.drills.warmup.title;
    case "ftt-mini": return t.drills["ftt-mini"].title;
    case "roleplay-daily": return t.drills["roleplay-daily"].title;
    case "roleplay-business": return t.drills["roleplay-business"].title;
    case "free": return t.nav.free;
    case "listening": return t.nav.listening;
    case "session-30": return t.shortSession.title;
  }
}

/** 「今日はこれ→これ」の3ステップ導線。帯に応じた主役を先頭に置く（推奨＝情報的で、全メニューは常時到達可能）。 */
function GuidedPath(props: { stage: number; onSelect: (sel: StartSelection) => void; lang: Lang }) {
  const t = STR[props.lang];
  const steps = guidedPath(stageBand(props.stage));
  return (
    <div>
      <p className="section-label">{t.guided.title} <span className="section-note">{t.guided.note}</span></p>
      <div className="guided-path">
        {steps.map((id, i) => (
          <button key={id} className="guided-step" onClick={() => props.onSelect(GUIDED_STEP_ACTIONS[id])}>
            <span className="guided-num" aria-hidden="true">{i + 1}</span>
            <span className="guided-label">{guidedStepLabel(id, t)}</span>
            <span className="drill-arrow" aria-hidden="true">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

StartScreen 本体（146行目以降の JSX）で、未測定測定導線（`{placementCard === "new" && ...}`、156〜158行目）の直後、クイックドリルの `<div>`（160行目）の前にガイドパスを挿入:

```tsx
      {typeof summary?.stage === "number" && (
        <GuidedPath stage={summary.stage} onSelect={props.onSelect} lang={props.lang} />
      )}
```

- [ ] **Step 4: CSS を追加**

`app/client/src/styles/app.css` の `.section-note { ... }`（45行目）の直後に追加:

```css
.guided-path { display: flex; flex-direction: column; gap: var(--sp-2); }
.guided-step {
  display: flex; align-items: center; gap: var(--sp-3); width: 100%;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: var(--sp-3) var(--sp-4); cursor: pointer; font: inherit; text-align: left;
  transition: border-color var(--ease), box-shadow var(--ease), transform var(--ease);
}
.guided-step:hover { border-color: var(--accent); box-shadow: var(--shadow-1); transform: translateY(-1px); }
.guided-num { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 999px; flex: none; background: var(--accent-soft); color: var(--accent); font-size: var(--fs-sm); font-weight: 700; }
.guided-label { flex: 1; font-weight: 600; }
.guided-step .drill-arrow { color: var(--text-muted); }
```

- [ ] **Step 5: 型チェックとビルドを確認**

Run: `cd app/client && bun run build`
Expected: PASS（`StartSelection` 拡張が App の `onSelect` と整合し、`GUIDED_STEP_ACTIONS` の網羅で型が通る）

- [ ] **Step 6: コミット**

```bash
git add app/client/src/i18n.ts app/client/src/App.tsx app/client/src/screens/StartScreen.tsx app/client/src/styles/app.css
git commit -m "feat: ホームにstage連動のガイド付きパス（今日はこれ→これ）を追加"
```

---

## Task 7: 例文の「卒業」表示（fluency 帯で新規は控えめ）

**Files:**
- Modify: `app/client/src/i18n.ts`（`SentencesStrings` に `graduationNote` 追加 + EN/JA）
- Modify: `app/client/src/screens/SentencesScreen.tsx`

**Interfaces:**
- Consumes: `useStage`（Task 4）, `STR[lang].sentences.graduationNote`
- Produces: stage>=5（fluency 帯）のとき、例文画面のヒーローに「新規は控えめでOK・復習は継続」の情報的な一言を出す（設定は自動変更しない＝非強制）。

- [ ] **Step 1: i18n に `graduationNote` を追加**

`app/client/src/i18n.ts` の `SentencesStrings` 型（103〜137行目）の `playChunkAria: (id: number) => string;` の直後（`};` の前）に追加:

```ts
    graduationNote: string;
```

`STR.en.sentences` の `playChunkAria: ...`（334行目付近）の直後に:

```ts
      graduationNote: "You're at an advanced level — no need to add many new sentences; keeping reviews going is what pays off.",
```

`STR.ja.sentences` の `playChunkAria: ...`（557行目付近）の直後に:

```ts
      graduationNote: "上級レベルに到達しています。新しい例文を無理に増やす必要はありません — 復習を続けることが効果的です。",
```

- [ ] **Step 2: SentencesScreen に卒業表示を追加**

`app/client/src/screens/SentencesScreen.tsx` の import（1〜5行目）に `useStage` を追加:

```ts
import { useStage } from "../useStage";
```

`SentencesScreen` 本体の `const t = STR[lang].sentences;`（39行目）の直後に stage を取得:

```ts
  const stage = useStage();
```

ヒーローの `<div className="hero">...</div>`（64〜67行目）の直後に卒業表示を挿入:

```tsx
      {typeof stage === "number" && stage >= 5 && (
        <p className="text-sm text-muted">{t.graduationNote}</p>
      )}
```

- [ ] **Step 3: 型チェックとビルドを確認**

Run: `cd app/client && bun run build`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add app/client/src/i18n.ts app/client/src/screens/SentencesScreen.tsx
git commit -m "feat: 上級帯で例文の卒業案内（新規は控えめ・復習継続）を表示"
```

---

## Task 8: 全体検証 + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

**Interfaces:** なし（検証とドキュメント）

- [ ] **Step 1: サーバ全テストを実行**

Run: `cd app && bun test`
Expected: PASS（server + client の全 `*.test.ts`。特に `progression.test.ts` / `menu.test.ts` / `stage.test.ts` / `api/progress.test.ts`）

- [ ] **Step 2: サーバ型チェック**

Run: `cd app && bun run typecheck`
Expected: PASS

- [ ] **Step 3: クライアントビルド（型チェック込み）**

Run: `cd app/client && bun run build`
Expected: PASS

- [ ] **Step 4: CHANGELOG を追記**

`CHANGELOG.md` の最上部（`## [0.13.0] - 2026-07-07` の直前）に新エントリを追加:

```markdown
## [0.14.0] - 2026-07-07

### Added

- **ホームのガイド付きパス**: レベル帯に応じた「今日はこれ→これ」の3ステップ導線をホーム上部に追加（すべてのメニューは従来どおり常時到達可能）
- **サイドバーの情報設計**: ナビを「今日の練習 / 自主練 / 記録」の3セクションに整理し、レベル帯に合う自主練モードに「今のあなた向け」バッジを表示
- **例文の卒業案内**: 上級帯（ステージ5-6）で「新規の例文は無理に増やさなくてよい・復習は継続」の情報的な一言を例文画面に表示

### Changed

- **日替わりメニューのブロック構成をレベル帯連動に**: Four Strands の配分をステージで変える（1-2=音読・シャドーイングを厚く / 3-4=4/3/2＋ロールプレイ主役 / 5-6=ロールプレイ主役）。ブロックの種類は不変で分数と並びのみ変更。当日すでに構築済みのメニューはその日のうちは維持し、新構成は翌日から反映
```

- [ ] **Step 5: コミット**

```bash
git add CHANGELOG.md
git commit -m "docs: v0.14.0（stage別カリキュラム+IA再設計）をCHANGELOGに追記"
```

---

## Self-Review

**1. Spec coverage（骨子4点との対応）:**
- 骨子1「日替わりメニューの stage 連動化」→ Task 1（`stageBand`）+ Task 2（`MENU_COMPOSITIONS` + `buildTodayMenu` refactor）。構成表は研究資産（Four Strands 評価・Fit&Gap）に基づき、foundation=language-focused/fluency 厚め・development=fluency+output・fluency=meaning-focused output 主役、という配分の根拠を構成表コメントに明記。
- 骨子2「消さない・ロックしない」→ Global Constraints に明記。ブロックの"種類"は不変（分数/並びのみ）、サイドバーは項目を消さずセクション化 + バッジ、例文卒業は表示のみ（設定自動変更なし）。全て情報的・非強制。
- 骨子3「サイドバー IA」→ Task 5（3セクション + 帯連動バッジ）+ Task 7（例文卒業表示）。「軽量版（セクション見出し+調整チップ）の上に載る差分」については、本プランは現行の flat な `navItems` を起点にセクション構造を**自己完結で**定義しているため、軽量版が先に landed 済みでも「セクション構造 + 帯連動バッジ」という到達状態は同一 → 実行時に既存セクションがあればそれを活かして差分適用すればよい（下記リスク参照）。
- 骨子4「ホームのガイド付きパス」→ Task 6（`GuidedPath` + `StartSelection` 拡張 + `onSelect` 拡張）。既存の強化セッション/クイックドリルは再配置せず残し、その上に3ステップの要約導線を足す（再利用優先）。

**2. Placeholder scan:** 各コード手順に完全なコードを記載（TBD/等の記載なし）。テストは実アサーション付き。i18n は EN/JA 両方を実文言で記載。

**3. Type consistency:**
- `StageBand` はサーバ（progression.ts）とクライアント（stage.ts）で同一の3値・同一境界（<=2/<=4/else）。値の一致を Task 1/Task 3 のテストで担保。
- `NavKey` の集合は App の `navItems.key`（home/placement/free/library/sentences/listening/progress）と一致。`navByKey.get(key)` の網羅で型安全。
- `GuidedStepId` は `guidedPath` の返り値・`GUIDED_STEP_ACTIONS` のキー・`guidedStepLabel` の switch で完全一致（9値）。
- `StartSelection` 拡張（+sentences/+listening）は App の `onSelect` 分岐・`Mode`（既存に sentences/listening あり）と整合。
- `MenuBlock` の生成則（`blockFromSpec`）は現行 `buildTodayMenu` と同一の title/titleKey/topicTitle/params。`fttRoundsSec(level)`/`prepParams(stage).modelTalk` を維持し、既存の roundsSec/modelTalkMode テスト（menu.test.ts 440-467）を壊さない。

**4. 移行・キャッシュ（重点確認）:** キャッシュキー・`isValidMenuShape` は不変。当日既存キャッシュは旧構成でも維持（Task 2 Step 4 の移行テストで固定）。新構成は翌日ビルドから。明示的レベル変更の同日反映は既存 `invalidateTodayMenuCache` が担保。ローテーション（main→scenario→shadow→markUsed→save の順）を厳密維持し、`buildQuickMenu`・`rotation.ts` は無変更。

**残リスク・実行時に確認すべき点:**
- **軽量版サイドバーとの整合**: フィードバック期間中に「軽量版（セクション見出し+調整チップ）」が別途 landed する前提。実行時に `App.tsx` が既にセクション構造/チップを持つ場合、Task 5 は**現行 flat 構造を置換するのではなく、既存セクションに `side-badge`（帯連動バッジ）を足す差分**へ読み替える（到達状態＝3セクション + 帯連動バッジは不変）。行番号は landed 後にずれるため、シンボル（`side-nav`/`navItems`/`onSelect`）基準で適用する。
- **placement の配置**: 本プランは「レベル測定」を`記録`セクションに置いた（測定→記録を生む導線という整理。timely な促しはホームの placement callout が担当）。直近コミットは「レベル測定をサイドバーに常設（ホーム直下）」だったため、ここは意図的な再配置。フィードバックで「測定はもっと上に」となれば `sectionToday` の keys に `placement` を移すだけで対応可能（1行）。
- **development 帯の推奨**: サイドバー自主練の推奨は development で `free` のみ（4/3/2・ロールプレイの主役はホームのガイドパス/強化セッション側にあるため）。バッジが全帯で意味を持つよう `free` を採用したが、体感次第で `navRecommendations("development")` を空配列にする選択も可能（純関数1箇所 + テスト1本の修正）。
- **分数配分の値**: 構成表の分数は研究の「配分の向き」を反映した設計値（一次研究による最適秒数の裏付けはない領域）。フィードバックで微調整する場合も `MENU_COMPOSITIONS` の数値と menu.test.ts の期待値の同時更新で完結する。
