# Phase B: レベル/XPエンジン 実装計画

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** レベル（1〜∞）と XP がメニューの難易度（4/3/2秒数・準備支援・お題帯域）を駆動し、ステージ境界の昇格/降格を提案＋承認で行う進行エンジンを実装する。

**Architecture:** 純粋計算（progression.ts）と永続化（progress-store.ts + SQLite）を分離し、既存の RouteDeps 注入境界に progressStore を追加。menu.ts は `level` を受け取り stage 由来のつまみでメニューを組む。クライアントはサイドバーのレベルゲージ・ホームの提案カード・ブロック開始/完了の記録送信を追加する。

**Tech Stack:** Bun + TypeScript / bun:sqlite / React + Vite（既存構成に追加のみ）

**Authority:** `docs/superpowers/specs/2026-07-06-adaptive-progression-design.md` §3〜§5, §8, §9（§6 プレースメントは Phase C で、本計画のスコープ外）

## Global Constraints

- **研究制約（スペック§2）**: XP は減らない。自動降格しない（降格は中立表現の提案＋承認のみ）。喪失感を煽る演出（ストリーク・減点・比較）を実装しない。昇格/降格の判定根拠は実値で開示する
- **数値の一元定義**: ステージ表・秒数式・XPカーブはすべて `app/server/progression.ts` の定数/関数として定義（他ファイルへの数値の複製禁止）
- **追加のみ**: 既存 HTTP 契約は「params の値変化とフィールド追加」のみ許容。既存 159 サーバテストは（本計画が明示する期待値更新を除き）そのまま通ること
- **日付はサーバのローカル日付**（`localYmd` を使う。`toISOString().slice(0,10)` による UTC 日付を新規コードで使わない）
- **コミットは Conventional Commits（日本語）**
- **ゲート**: `cd app && bun test && bun run typecheck`、Task 4 は `cd app/client && bun run build` も
- **Phase A からの持ち越し4件**は Task 3 で回収する: ①v2 rotation の usage 未検証キャスト → sanitize ②帯域フィルタfallbackの3箇所重複 → `filterInBand` ヘルパ ③部分的v2形状のテスト追加 ④旧キャッシュメニュー（domain/level無し・旧ファイル名）はキャッシュキー変更で自然に無効化

## 確定数値（スペック§3〜§5 より。progression.ts が唯一の定義場所）

- `stageOf(level) = min(6, ceil(level / 10))`
- `round5(x) = Math.round(x / 5) * 5`（JS の Math.round: .5 は切り上げ）
- `fttFirstSec(level) = round5(90 + (min(level, 60) - 1) * 1.5)`
- **丸め順序（固定）**: まず first を round5 で確定し、**丸めた first** に 0.75 / 0.5 を掛けてから再度 round5。`fttRoundsSec(level) = [first, round5(first * 0.75), round5(first * 0.5)]`。ミニ版は先頭2要素
- 検算値: Lv1→[90,70,45] / Lv10→[105,80,55] / Lv11→[105,80,55] / Lv13→[110,85,55] / Lv21→[120,90,60]（現行値と一致） / Lv60→[180,135,90] / Lv61,100→[180,135,90]
- `needXp(level) = 15 + 5 * stageOf(level)`（stage1..6 → 20,25,30,35,40,45。Lv61+ は stageOf=6 なので自動的に45固定）
- 準備支援（stage 1..6）: チャンク数 `[8,7,6,5,4,4]`・ヒント言語 `["ja","ja","ja","en","en","en"]`・モデルトーク `["auto","auto","auto","auto","button","none"]`
- `DEFAULT_LEVEL = 13`（プレースメント未実施時。stage 2）
- ステージ境界レベル `BOUNDARY_LEVELS = [10, 20, 30, 40, 50]`（60→61 は同stageなので自動昇格）
- 昇格提案条件（§5.1、3つすべて）: 境界レベルで xpIntoLevel ≥ needXp(level) ／ 直近14日（今日含む）の練習日 ≥ 5 ／ 直近20ブロックの完了率 ≥ 70%（試行0件なら不成立）。却下後7日間は再提案しない
- 降格提案条件（§5.2、いずれか）: 直近7日の完了率 < 40%（**試行5件以上あるときのみ**判定 — 1件中断だけで提案しない） ／ 直近5回の 4/3/2 中断 ≥ 3回（記録が3件未満なら不成立）。stage1 では提案しない。却下後7日間は再提案しない。**降格提案は昇格提案より優先**（直近シグナルを重視）
- 昇格承認: level+1・xpIntoLevel から needXp(旧level) を消費（余剰は持ち越し、続けて自動昇格ループ）。降格承認: `level = (stageOf(level)-1)*10`・xpIntoLevel=0。手動set: 指定レベル・xpIntoLevel=0
- `difficultyMaxed = level >= 61`
- XP上限（kind別）: block ≤ 60 / srs-grade ≤ 2 / placement = 10（POST /api/progress/xp が受けるのは kind="block" のみ。srs-grade はサーバ内部で付与、placement は Phase C）

## スペックからの明示的逸脱（承認済み設計判断）

1. `user_progress` に `xp_into_level` 列を追加（§8.1に無い）。手動レベル変更・却下で累積XPからの逆算が壊れるため、レベル内XPを直接持つ。xp は従来どおり累積・減らない
2. `xp_events` / `level_events` / `block_attempts` に `ymd` 列（ローカル日付）を追加。練習日・完了率のシグナル計算を UTC 罠なしで行うため
3. `block_attempts` テーブルを新設（§8.1に無い）。§5.1/5.2 の「完了率」「中断」シグナルは開始の記録なしに計算できない
4. `level_events.kind` の `propose-up/propose-down` は**永続化しない**（提案は getSummary 時に計算。summary を読むたびに行が増えるのを避ける）。永続化するのは accept-up/decline-up/accept-down/decline-down/manual-set
5. proposal の `rationale` は表示文字列でなく**構造化オブジェクト**（クライアントが i18n で整形）。level_events には JSON 文字列で保存

## File Structure

- Create: `app/server/progression.ts`（純粋計算）+ `app/server/__tests__/progression.test.ts`
- Create: `app/server/progress-store.ts`（SQLite ストア）+ `app/server/__tests__/progress-store.test.ts`
- Modify: `app/server/db.ts`（テーブル3つ追加）
- Modify: `app/server/routes.ts`（progress ルート4本 + sentence grade への XP フック）
- Modify: `app/server/__tests__/routes.test.ts`（makeTestDeps + 契約テスト）
- Modify: `app/server/menu.ts`（level 駆動・キャッシュキー・filterInBand・rotation sanitize）
- Modify: `app/server/__tests__/menu.test.ts`（期待値更新 + 新テスト）
- Modify: `app/server/coach.ts`（generatePrepPack のパラメータ化）
- Modify: `app/server/index.ts`（配線）
- Modify: `app/client/src/api.ts` / `App.tsx` / `i18n.ts` / `screens/SessionRunner.tsx` / `screens/FourThreeTwoScreen.tsx` / `screens/StartScreen.tsx` / `styles/app.css`

---

### Task 1: progression.ts — 純粋計算

**Files:**
- Create: `app/server/progression.ts`
- Test: `app/server/__tests__/progression.test.ts`

**Interfaces:**
- Produces（Task 2/3 が依存）: `stageOf(level: number): number` / `fttRoundsSec(level: number): number[]` / `fttMiniRoundsSec(level: number): number[]` / `needXp(level: number): number` / `prepParams(stage: number): PrepSupport` / `DEFAULT_LEVEL: 13` / `BOUNDARY_LEVELS: readonly number[]` / `demotionTargetLevel(level: number): number` / 型 `PrepSupport = { chunkCount: number; hintLang: "ja" | "en"; modelTalk: "auto" | "button" | "none" }`

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/progression.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  BOUNDARY_LEVELS, DEFAULT_LEVEL, demotionTargetLevel, fttMiniRoundsSec, fttRoundsSec,
  needXp, prepParams, stageOf,
} from "../progression";

describe("progression: stageOf", () => {
  test("境界値: Lv1,10,11,20,21,60,61,100", () => {
    expect(stageOf(1)).toBe(1);
    expect(stageOf(10)).toBe(1);
    expect(stageOf(11)).toBe(2);
    expect(stageOf(20)).toBe(2);
    expect(stageOf(21)).toBe(3);
    expect(stageOf(60)).toBe(6);
    expect(stageOf(61)).toBe(6);
    expect(stageOf(100)).toBe(6);
  });
});

describe("progression: fttRoundsSec", () => {
  test("丸め順序込みの検算値（丸めたfirstに0.75/0.5を掛けて再round5）", () => {
    expect(fttRoundsSec(1)).toEqual([90, 70, 45]);
    expect(fttRoundsSec(10)).toEqual([105, 80, 55]);
    expect(fttRoundsSec(11)).toEqual([105, 80, 55]);
    expect(fttRoundsSec(13)).toEqual([110, 85, 55]);
    expect(fttRoundsSec(21)).toEqual([120, 90, 60]); // 現行固定値と一致
    expect(fttRoundsSec(60)).toEqual([180, 135, 90]);
  });
  test("Lv61以降は難易度据え置き（Lv60と同値）", () => {
    expect(fttRoundsSec(61)).toEqual(fttRoundsSec(60));
    expect(fttRoundsSec(100)).toEqual(fttRoundsSec(60));
  });
  test("ミニ版は先頭2ラウンド", () => {
    expect(fttMiniRoundsSec(13)).toEqual([110, 85]);
    expect(fttMiniRoundsSec(21)).toEqual([120, 90]);
  });
});

describe("progression: needXp", () => {
  test("stage別の必要XPとLv61+の一定値", () => {
    expect(needXp(1)).toBe(20);
    expect(needXp(10)).toBe(20);
    expect(needXp(11)).toBe(25);
    expect(needXp(60)).toBe(45);
    expect(needXp(61)).toBe(45);
    expect(needXp(100)).toBe(45);
  });
});

describe("progression: prepParams", () => {
  test("stage 1..6 の支援パラメータ表", () => {
    expect(prepParams(1)).toEqual({ chunkCount: 8, hintLang: "ja", modelTalk: "auto" });
    expect(prepParams(3)).toEqual({ chunkCount: 6, hintLang: "ja", modelTalk: "auto" });
    expect(prepParams(4)).toEqual({ chunkCount: 5, hintLang: "en", modelTalk: "auto" });
    expect(prepParams(5)).toEqual({ chunkCount: 4, hintLang: "en", modelTalk: "button" });
    expect(prepParams(6)).toEqual({ chunkCount: 4, hintLang: "en", modelTalk: "none" });
  });
});

describe("progression: 定数と降格先", () => {
  test("DEFAULT_LEVEL は 13（stage 2）", () => {
    expect(DEFAULT_LEVEL).toBe(13);
    expect(stageOf(DEFAULT_LEVEL)).toBe(2);
  });
  test("境界レベルは 10,20,30,40,50（60は含まない: 60→61は同stage）", () => {
    expect([...BOUNDARY_LEVELS]).toEqual([10, 20, 30, 40, 50]);
  });
  test("降格先は現ステージ最下端の1つ下（例: Lv23→20、Lv75→50）", () => {
    expect(demotionTargetLevel(23)).toBe(20);
    expect(demotionTargetLevel(11)).toBe(10);
    expect(demotionTargetLevel(75)).toBe(50);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `cd app && bun test __tests__/progression.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 実装**

`app/server/progression.ts`:

```ts
/**
 * レベル/XP/難易度つまみの純粋計算（スペック §3〜§5）。
 * 数値はすべてここで一元定義する — 他ファイルに複製しない。
 */

export type HintLang = "ja" | "en";
export type ModelTalkMode = "auto" | "button" | "none";
export type PrepSupport = { chunkCount: number; hintLang: HintLang; modelTalk: ModelTalkMode };

/** プレースメント未実施時の開始レベル（stage 2 のやや下 — 既存の「難しすぎた」フィードバック反映） */
export const DEFAULT_LEVEL = 13;

/** ステージ境界レベル（この level で自動昇格が止まり、提案＋承認になる）。60→61 は同stageなので境界ではない */
export const BOUNDARY_LEVELS: readonly number[] = [10, 20, 30, 40, 50];

/** stage 1..6。Lv61+ は 6 に張り付く（難易度据え置きのおまけレベル帯） */
export function stageOf(level: number): number {
  return Math.min(6, Math.ceil(level / 10));
}

function round5(x: number): number {
  return Math.round(x / 5) * 5;
}

/** 4/3/2 の初回ラウンド秒。Lv1=90 から 1.5秒/レベルで線形、Lv60=180 で頭打ち */
function fttFirstSec(level: number): number {
  return round5(90 + (Math.min(level, 60) - 1) * 1.5);
}

/** 丸め順序は固定: 丸めた first に 0.75/0.5 を掛けてから再度 round5 */
export function fttRoundsSec(level: number): number[] {
  const first = fttFirstSec(level);
  return [first, round5(first * 0.75), round5(first * 0.5)];
}

export function fttMiniRoundsSec(level: number): number[] {
  return fttRoundsSec(level).slice(0, 2);
}

/** 次レベルに必要なXP。stage1..6 → 20,25,30,35,40,45（Lv61+ は 45 のまま） */
export function needXp(level: number): number {
  return 15 + 5 * stageOf(level);
}

const PREP_TABLE: readonly PrepSupport[] = [
  { chunkCount: 8, hintLang: "ja", modelTalk: "auto" },   // stage 1
  { chunkCount: 7, hintLang: "ja", modelTalk: "auto" },   // stage 2
  { chunkCount: 6, hintLang: "ja", modelTalk: "auto" },   // stage 3
  { chunkCount: 5, hintLang: "en", modelTalk: "auto" },   // stage 4
  { chunkCount: 4, hintLang: "en", modelTalk: "button" }, // stage 5
  { chunkCount: 4, hintLang: "en", modelTalk: "none" },   // stage 6
];

/** stage(1..6) → 準備支援パラメータ。範囲外は端にクランプ */
export function prepParams(stage: number): PrepSupport {
  const i = Math.min(Math.max(Math.trunc(stage), 1), 6) - 1;
  return { ...PREP_TABLE[i] };
}

/** 降格承認時の移動先: 現ステージ最下端の1つ下（例 Lv23→20）。stage1 では呼ばない前提（提案側で抑止） */
export function demotionTargetLevel(level: number): number {
  return (stageOf(level) - 1) * 10;
}
```

- [ ] **Step 4: テスト通過と全体ゲートを確認**

Run: `cd app && bun test && bun run typecheck`
Expected: 全テスト PASS（159 + 新規）、typecheck 0

- [ ] **Step 5: コミット**

```bash
git add app/server/progression.ts app/server/__tests__/progression.test.ts
git commit -m "feat: レベル/XP/難易度つまみの純粋計算モジュールを追加"
```

---

### Task 2: SQLite + progress-store + API

**Files:**
- Modify: `app/server/db.ts`
- Create: `app/server/progress-store.ts`
- Test: `app/server/__tests__/progress-store.test.ts`
- Modify: `app/server/routes.ts`, `app/server/__tests__/routes.test.ts`
- Modify: `app/server/index.ts`

**Interfaces:**
- Consumes: Task 1 の `DEFAULT_LEVEL, BOUNDARY_LEVELS, needXp, stageOf, demotionTargetLevel`、`sentences.ts` の `localYmd, addDaysYmd`
- Produces（Task 3/4 が依存）:
  - `ProgressStore = { getLevel(): number; getSummary(today?): ProgressSummary; addXp(kind, amount, meta?, today?): ProgressSummary | null; blockStart(kind, today?): { attemptId: number }; levelAction(action, level?, today?): ProgressSummary | null }`
  - `ProgressSummary = { level: number; xp: number; xpIntoLevel: number; xpToNext: number; stage: number; difficultyMaxed: boolean; proposal: Proposal | null }`
  - `Proposal = { kind: "up" | "down"; toLevel: number; rationale: UpRationale | DownRationale }`、`UpRationale = { xpReached: true; practicedDays14: number; completionRate: number }`、`DownRationale = { completionRate: number | null; fttAborts: number }`
  - HTTP: `GET /api/progress/summary` → ProgressSummary ／ `POST /api/progress/xp` `{kind:"block", amount, attemptId?}` → ProgressSummary ／ `POST /api/progress/block-start` `{kind}` → `{attemptId}` ／ `POST /api/progress/level` `{action, level?}` → ProgressSummary

- [ ] **Step 1: db.ts にテーブルを追加**

`app/server/db.ts` の `openDb` 内、`sentence_srs` の CREATE の直後に追加:

```ts
  db.run(`CREATE TABLE IF NOT EXISTS user_progress (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    level INTEGER NOT NULL,
    xp INTEGER NOT NULL,
    xp_into_level INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS xp_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, ymd TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, meta TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS level_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, ymd TEXT NOT NULL, kind TEXT NOT NULL,
    from_level INTEGER NOT NULL, to_level INTEGER NOT NULL, rationale TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS block_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, ymd TEXT NOT NULL, kind TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0
  )`);
```

- [ ] **Step 2: 失敗するストアテストを書く**

`app/server/__tests__/progress-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import { makeProgressStore } from "../progress-store";

const T = "2026-07-06"; // 固定のテスト日付

function freshStore() {
  const db = openDb(":memory:");
  return { db, store: makeProgressStore(db) };
}

describe("progress-store: 初期化とsummary", () => {
  test("初回は DEFAULT_LEVEL=13・xp0 で初期化される", () => {
    const { store } = freshStore();
    const s = store.getSummary(T);
    expect(s.level).toBe(13);
    expect(s.xp).toBe(0);
    expect(s.xpIntoLevel).toBe(0);
    expect(s.xpToNext).toBe(25); // needXp(13)
    expect(s.stage).toBe(2);
    expect(s.difficultyMaxed).toBe(false);
    expect(s.proposal).toBeNull();
    expect(store.getLevel()).toBe(13);
  });
});

describe("progress-store: addXp とステージ内自動昇格", () => {
  test("XP到達でレベルが自動で上がる（余剰は持ち越し）", () => {
    const { store } = freshStore();
    const s = store.addXp("block", 30, {}, T)!; // need(13)=25 → Lv14, into=5
    expect(s.level).toBe(14);
    expect(s.xpIntoLevel).toBe(5);
    expect(s.xp).toBe(30); // 累積は減らない
  });
  test("複数レベルの一括昇格", () => {
    const { store } = freshStore();
    const s = store.addXp("block", 60, {}, T)!; // 25+25=50消費 → Lv15, into=10
    expect(s.level).toBe(15);
    expect(s.xpIntoLevel).toBe(10);
  });
  test("ステージ境界では自動昇格が止まる（Lv20で停止・xpToNextは0まで下がる）", () => {
    const { store } = freshStore();
    store.levelAction("set", 19, T);
    const s = store.addXp("block", 60, {}, T)!; // need(19)=25 → Lv20, into=35 ≥ need(20)=25 だが境界で停止
    expect(s.level).toBe(20);
    expect(s.xpIntoLevel).toBe(35);
    expect(s.xpToNext).toBe(0);
  });
  test("60→61 は境界ではなく自動昇格し difficultyMaxed になる", () => {
    const { store } = freshStore();
    store.levelAction("set", 60, T);
    const s = store.addXp("block", 45, {}, T)!;
    expect(s.level).toBe(61);
    expect(s.difficultyMaxed).toBe(true);
  });
  test("上限検証: block>60・srs-grade>2・placement≠10・非整数・0以下は null", () => {
    const { store } = freshStore();
    expect(store.addXp("block", 61, {}, T)).toBeNull();
    expect(store.addXp("srs-grade", 3, {}, T)).toBeNull();
    expect(store.addXp("placement", 9, {}, T)).toBeNull();
    expect(store.addXp("block", 0, {}, T)).toBeNull();
    expect(store.addXp("block", 1.5, {}, T)).toBeNull();
    expect(store.addXp("bogus" as never, 1, {}, T)).toBeNull();
  });
});

describe("progress-store: ブロック試行と完了率", () => {
  test("blockStart→addXp(attemptId) で completed になる", () => {
    const { db, store } = freshStore();
    const { attemptId } = store.blockStart("warmup-reading", T);
    store.addXp("block", 6, { attemptId }, T);
    const row = db.query<{ completed: number }, [number]>(
      "SELECT completed FROM block_attempts WHERE id = ?").get(attemptId)!;
    expect(row.completed).toBe(1);
  });
});

/** シグナル素材を直接仕込むヘルパ */
function seedAttempt(db: ReturnType<typeof openDb>, ymd: string, kind: string, completed: 0 | 1) {
  db.run("INSERT INTO block_attempts (ts, ymd, kind, completed) VALUES (?, ?, ?, ?)",
    [`${ymd}T09:00:00`, ymd, kind, completed]);
}
function seedBlockXpDay(db: ReturnType<typeof openDb>, ymd: string) {
  db.run("INSERT INTO xp_events (ts, ymd, kind, amount, meta) VALUES (?, ?, 'block', 6, NULL)",
    [`${ymd}T09:00:00`, ymd]);
}

describe("progress-store: 昇格提案（3条件すべて）", () => {
  function boundaryReady() {
    const { db, store } = freshStore();
    store.levelAction("set", 20, T);
    // set は into=0 にするので、境界XP到達まで直接加算（need(20)=25）
    store.addXp("block", 25, {}, T);
    return { db, store };
  }
  test("XP到達だけでは提案しない（練習日・完了率不足）", () => {
    const { store } = boundaryReady();
    expect(store.getSummary(T).proposal).toBeNull();
  });
  test("3条件成立で up 提案（根拠に実値）", () => {
    const { db, store } = boundaryReady();
    for (const d of ["2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-05"]) seedBlockXpDay(db, d);
    for (let i = 0; i < 8; i++) seedAttempt(db, "2026-07-05", "warmup-reading", 1);
    seedAttempt(db, "2026-07-05", "warmup-reading", 0);
    const p = store.getSummary(T).proposal!;
    expect(p.kind).toBe("up");
    expect(p.toLevel).toBe(21);
    expect(p.rationale).toMatchObject({ xpReached: true, practicedDays14: 6 }); // seed5日+addXpの当日
    expect((p.rationale as { completionRate: number }).completionRate).toBeGreaterThanOrEqual(0.7);
  });
  test("却下から7日間は再提案しない・8日目に再提案", () => {
    const { db, store } = boundaryReady();
    for (const d of ["2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-05"]) seedBlockXpDay(db, d);
    for (let i = 0; i < 10; i++) seedAttempt(db, "2026-07-05", "warmup-reading", 1);
    expect(store.getSummary(T).proposal?.kind).toBe("up");
    store.levelAction("decline", undefined, T);
    expect(store.getSummary(T).proposal).toBeNull();
    expect(store.getSummary("2026-07-12").proposal).toBeNull();  // 6日後
    // 8日目: 14日窓に入る練習日を追加で確保
    for (const d of ["2026-07-08", "2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"]) seedBlockXpDay(db, d);
    expect(store.getSummary("2026-07-14").proposal?.kind).toBe("up");
  });
  test("承認で境界を越え、余剰XPで自動昇格も走る", () => {
    const { db, store } = boundaryReady();
    for (const d of ["2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-05"]) seedBlockXpDay(db, d);
    for (let i = 0; i < 10; i++) seedAttempt(db, "2026-07-05", "warmup-reading", 1);
    store.addXp("block", 30, {}, T); // into=55（境界で停止中）
    const s = store.levelAction("accept", undefined, T)!;
    expect(s.level).toBe(22); // 21へ昇格後、余剰30 ≥ need(21)=30 → 22
    expect(s.xpIntoLevel).toBe(0);
  });
});

describe("progress-store: 降格提案", () => {
  test("直近7日の完了率<40%（試行5件以上）で down 提案", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 23, T);
    for (let i = 0; i < 5; i++) seedAttempt(db, "2026-07-04", "roleplay", i === 0 ? 1 : 0); // 1/5=20%
    const p = store.getSummary(T).proposal!;
    expect(p.kind).toBe("down");
    expect(p.toLevel).toBe(20);
  });
  test("試行4件以下なら完了率条件では提案しない", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 23, T);
    for (let i = 0; i < 4; i++) seedAttempt(db, "2026-07-04", "roleplay", 0);
    expect(store.getSummary(T).proposal).toBeNull();
  });
  test("直近5回の4/3/2中断が3回以上で down 提案", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 23, T);
    // 完了率条件を踏まないよう7日窓の外に置く
    for (const c of [0, 0, 0, 1, 1] as const) seedAttempt(db, "2026-06-20", "four-three-two", c);
    const p = store.getSummary(T).proposal!;
    expect(p.kind).toBe("down");
    expect((p.rationale as { fttAborts: number }).fttAborts).toBe(3);
  });
  test("stage1 では降格提案しない", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 5, T);
    for (let i = 0; i < 6; i++) seedAttempt(db, "2026-07-04", "roleplay", 0);
    expect(store.getSummary(T).proposal).toBeNull();
  });
  test("承認で現ステージ最下端の1つ下へ・XPは減らない", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 23, T);
    store.addXp("block", 10, {}, T);
    for (let i = 0; i < 5; i++) seedAttempt(db, "2026-07-04", "roleplay", 0);
    const s = store.levelAction("accept", undefined, T)!;
    expect(s.level).toBe(20);
    expect(s.xp).toBe(10); // 累積XPは不変
    expect(s.xpIntoLevel).toBe(0);
  });
  test("降格条件と昇格条件が同時成立したら降格を優先", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 20, T);
    store.addXp("block", 25, {}, T);
    for (const d of ["2026-06-25", "2026-06-26", "2026-06-27", "2026-06-28", "2026-06-29"]) seedBlockXpDay(db, d);
    // 20ブロック窓は高完了率、7日窓は低完了率
    for (let i = 0; i < 15; i++) seedAttempt(db, "2026-06-25", "warmup-reading", 1);
    for (let i = 0; i < 5; i++) seedAttempt(db, "2026-07-04", "roleplay", 0);
    expect(store.getSummary(T).proposal?.kind).toBe("down");
  });
});

describe("progress-store: levelAction", () => {
  test("set はレベルを変更し xpIntoLevel を0にする（1未満・非整数は null）", () => {
    const { store } = freshStore();
    const s = store.levelAction("set", 40, T)!;
    expect(s.level).toBe(40);
    expect(s.xpIntoLevel).toBe(0);
    expect(store.levelAction("set", 0, T)).toBeNull();
    expect(store.levelAction("set", 2.5, T)).toBeNull();
    expect(store.levelAction("set", undefined, T)).toBeNull();
  });
  test("提案がないときの accept / decline は null", () => {
    const { store } = freshStore();
    expect(store.levelAction("accept", undefined, T)).toBeNull();
    expect(store.levelAction("decline", undefined, T)).toBeNull();
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `cd app && bun test __tests__/progress-store.test.ts`
Expected: FAIL（progress-store not found）

- [ ] **Step 4: progress-store.ts を実装**

`app/server/progress-store.ts`:

```ts
import type { Database } from "bun:sqlite";
import {
  BOUNDARY_LEVELS, DEFAULT_LEVEL, demotionTargetLevel, needXp, stageOf,
} from "./progression";
import { addDaysYmd, localYmd } from "./sentences";

export type XpKind = "block" | "srs-grade" | "placement";
export type UpRationale = { xpReached: true; practicedDays14: number; completionRate: number };
export type DownRationale = { completionRate: number | null; fttAborts: number };
export type Proposal = { kind: "up" | "down"; toLevel: number; rationale: UpRationale | DownRationale };
export type ProgressSummary = {
  level: number; xp: number; xpIntoLevel: number; xpToNext: number;
  stage: number; difficultyMaxed: boolean; proposal: Proposal | null;
};
export type ProgressStore = {
  getLevel(): number;
  getSummary(today?: string): ProgressSummary;
  /** 不正な kind/amount は null（ルートは400にする）。meta.attemptId があれば該当試行を完了にする */
  addXp(kind: XpKind, amount: number, meta?: Record<string, unknown>, today?: string): ProgressSummary | null;
  blockStart(kind: string, today?: string): { attemptId: number };
  /** accept/decline は提案が無ければ null。set は不正レベルで null */
  levelAction(action: "accept" | "decline" | "set", level?: number, today?: string): ProgressSummary | null;
};

/** XP上限（kind別）。placement は固定値10のみ許容 */
const XP_CAPS: Record<XpKind, number> = { block: 60, "srs-grade": 2, placement: 10 };

/** 昇格: 14日窓の練習日下限 / 20試行窓の完了率下限。降格: 7日窓の完了率上限（最少試行数）/ 4/3/2中断 */
const PROMOTE_MIN_PRACTICE_DAYS = 5;
const PROMOTE_MIN_COMPLETION = 0.7;
const DEMOTE_MAX_COMPLETION = 0.4;
const DEMOTE_MIN_ATTEMPTS = 5;
const DEMOTE_FTT_ABORTS = 3;
const DECLINE_COOLDOWN_DAYS = 7;

type ProgressRow = { level: number; xp: number; xp_into_level: number };

export function makeProgressStore(db: Database): ProgressStore {
  function nowTs(): string {
    return new Date().toISOString();
  }

  function ensureRow(): ProgressRow {
    db.run(
      "INSERT OR IGNORE INTO user_progress (id, level, xp, xp_into_level, updated_at) VALUES (1, ?, 0, 0, ?)",
      [DEFAULT_LEVEL, nowTs()],
    );
    return db.query<ProgressRow, []>("SELECT level, xp, xp_into_level FROM user_progress WHERE id = 1").get()!;
  }

  function save(row: ProgressRow): void {
    db.run("UPDATE user_progress SET level = ?, xp = ?, xp_into_level = ?, updated_at = ? WHERE id = 1",
      [row.level, row.xp, row.xp_into_level, nowTs()]);
  }

  /** ステージ内の自動昇格（境界レベルで停止。60→61 は境界でないので進む） */
  function autoLevelUp(row: ProgressRow): void {
    while (row.xp_into_level >= needXp(row.level) && !BOUNDARY_LEVELS.includes(row.level)) {
      row.xp_into_level -= needXp(row.level);
      row.level += 1;
    }
  }

  function lastDeclineYmd(kind: "decline-up" | "decline-down"): string | null {
    const r = db.query<{ ymd: string }, [string]>(
      "SELECT ymd FROM level_events WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind);
    return r?.ymd ?? null;
  }

  function inCooldown(kind: "decline-up" | "decline-down", today: string): boolean {
    const last = lastDeclineYmd(kind);
    return last !== null && last > addDaysYmd(today, -DECLINE_COOLDOWN_DAYS);
  }

  function practicedDays14(today: string): number {
    const since = addDaysYmd(today, -13);
    const r = db.query<{ n: number }, [string, string]>(
      "SELECT COUNT(DISTINCT ymd) AS n FROM xp_events WHERE kind = 'block' AND ymd >= ? AND ymd <= ?",
    ).get(since, today)!;
    return r.n;
  }

  /** 直近 limit 試行の完了率。試行0件は null */
  function completionRateLastN(limit: number): number | null {
    const rows = db.query<{ completed: number }, [number]>(
      "SELECT completed FROM block_attempts ORDER BY id DESC LIMIT ?").all(limit);
    if (rows.length === 0) return null;
    return rows.filter((r) => r.completed === 1).length / rows.length;
  }

  /** 直近7日窓の完了率と試行数 */
  function completionRate7d(today: string): { rate: number | null; count: number } {
    const since = addDaysYmd(today, -6);
    const rows = db.query<{ completed: number }, [string, string]>(
      "SELECT completed FROM block_attempts WHERE ymd >= ? AND ymd <= ?").all(since, today);
    if (rows.length === 0) return { rate: null, count: 0 };
    return { rate: rows.filter((r) => r.completed === 1).length / rows.length, count: rows.length };
  }

  function fttAbortsLast5(): { aborts: number; count: number } {
    const rows = db.query<{ completed: number }, []>(
      "SELECT completed FROM block_attempts WHERE kind = 'four-three-two' ORDER BY id DESC LIMIT 5").all();
    return { aborts: rows.filter((r) => r.completed === 0).length, count: rows.length };
  }

  /** 提案の計算（永続化しない）。降格を優先（直近シグナル重視） */
  function computeProposal(row: ProgressRow, today: string): Proposal | null {
    // 降格（§5.2）
    if (stageOf(row.level) >= 2 && !inCooldown("decline-down", today)) {
      const week = completionRate7d(today);
      const ftt = fttAbortsLast5();
      const lowCompletion = week.count >= DEMOTE_MIN_ATTEMPTS && week.rate !== null && week.rate < DEMOTE_MAX_COMPLETION;
      const manyAborts = ftt.count >= DEMOTE_FTT_ABORTS && ftt.aborts >= DEMOTE_FTT_ABORTS;
      if (lowCompletion || manyAborts) {
        return {
          kind: "down",
          toLevel: demotionTargetLevel(row.level),
          rationale: { completionRate: week.rate, fttAborts: ftt.aborts },
        };
      }
    }
    // 昇格（§5.1）
    if (BOUNDARY_LEVELS.includes(row.level) && row.xp_into_level >= needXp(row.level) && !inCooldown("decline-up", today)) {
      const days = practicedDays14(today);
      const rate = completionRateLastN(20);
      if (days >= PROMOTE_MIN_PRACTICE_DAYS && rate !== null && rate >= PROMOTE_MIN_COMPLETION) {
        return {
          kind: "up",
          toLevel: row.level + 1,
          rationale: { xpReached: true, practicedDays14: days, completionRate: rate },
        };
      }
    }
    return null;
  }

  function summarize(row: ProgressRow, today: string): ProgressSummary {
    return {
      level: row.level,
      xp: row.xp,
      xpIntoLevel: row.xp_into_level,
      xpToNext: Math.max(0, needXp(row.level) - row.xp_into_level),
      stage: stageOf(row.level),
      difficultyMaxed: row.level >= 61,
      proposal: computeProposal(row, today),
    };
  }

  function recordLevelEvent(kind: string, from: number, to: number, rationale: unknown, ymd: string): void {
    db.run("INSERT INTO level_events (ts, ymd, kind, from_level, to_level, rationale) VALUES (?, ?, ?, ?, ?, ?)",
      [nowTs(), ymd, kind, from, to, rationale == null ? null : JSON.stringify(rationale)]);
  }

  return {
    getLevel() {
      return ensureRow().level;
    },

    getSummary(today = localYmd()) {
      return summarize(ensureRow(), today);
    },

    addXp(kind, amount, meta = {}, today = localYmd()) {
      if (!(kind in XP_CAPS)) return null;
      if (!Number.isInteger(amount) || amount < 1 || amount > XP_CAPS[kind]) return null;
      if (kind === "placement" && amount !== XP_CAPS.placement) return null;
      const row = ensureRow();
      db.run("INSERT INTO xp_events (ts, ymd, kind, amount, meta) VALUES (?, ?, ?, ?, ?)",
        [nowTs(), today, kind, amount, Object.keys(meta).length ? JSON.stringify(meta) : null]);
      const attemptId = (meta as { attemptId?: unknown }).attemptId;
      if (kind === "block" && Number.isInteger(attemptId)) {
        db.run("UPDATE block_attempts SET completed = 1 WHERE id = ?", [attemptId as number]);
      }
      row.xp += amount;
      row.xp_into_level += amount;
      autoLevelUp(row);
      save(row);
      return summarize(row, today);
    },

    blockStart(kind, today = localYmd()) {
      db.run("INSERT INTO block_attempts (ts, ymd, kind, completed) VALUES (?, ?, ?, 0)", [nowTs(), today, kind]);
      const r = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!;
      return { attemptId: r.id };
    },

    levelAction(action, level, today = localYmd()) {
      const row = ensureRow();
      if (action === "set") {
        if (level === undefined || !Number.isInteger(level) || level < 1 || level > 999) return null;
        recordLevelEvent("manual-set", row.level, level, null, today);
        row.level = level;
        row.xp_into_level = 0;
        save(row);
        return summarize(row, today);
      }
      const proposal = computeProposal(row, today);
      if (!proposal) return null;
      if (action === "decline") {
        recordLevelEvent(proposal.kind === "up" ? "decline-up" : "decline-down", row.level, proposal.toLevel, proposal.rationale, today);
        return summarize(row, today);
      }
      // accept
      if (proposal.kind === "up") {
        row.xp_into_level -= needXp(row.level);
        row.level += 1;
        autoLevelUp(row);
      } else {
        row.level = proposal.toLevel;
        row.xp_into_level = 0;
      }
      recordLevelEvent(proposal.kind === "up" ? "accept-up" : "accept-down", proposal.kind === "up" ? row.level - 1 : row.level, row.level, proposal.rationale, today);
      save(row);
      return summarize(row, today);
    },
  };
}
```

注意: `accept-up` の from_level 記録は昇格前レベル。autoLevelUp で複数上がった場合 from/to の差が1超になるが、それが事実（イベントは実際の遷移を記録する）。

- [ ] **Step 5: ストアテスト通過を確認**

Run: `cd app && bun test __tests__/progress-store.test.ts`
Expected: PASS

- [ ] **Step 6: routes.ts にルートを追加**

`app/server/routes.ts`:

imports に追加:

```ts
import type { ProgressStore, XpKind } from "./progress-store";
```

`RouteDeps` の `sentenceStore` の下に追加:

```ts
  /** レベル/XPの進行状態（実体は progress-store.ts、テストはフェイク） */
  progressStore: ProgressStore;
```

`GRADES` 定義の下にハンドラ群を追加:

```ts
const BLOCK_KINDS = ["chunk-placeholder", "warmup-reading", "four-three-two", "roleplay", "shadowing", "reflection"] as const;

async function handleProgressXp(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ kind?: unknown; amount?: unknown; attemptId?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { kind, amount, attemptId } = parsed.body;
  // HTTP経由で受けるのは block のみ（srs-grade はサーバ内部、placement は Phase C のサーバ内部付与）
  if (kind !== "block") return json({ error: "kind must be \"block\"" }, 400);
  if (typeof amount !== "number") return json({ error: "amount must be a number" }, 400);
  if (attemptId !== undefined && !Number.isInteger(attemptId)) {
    return json({ error: "attemptId must be an integer" }, 400);
  }
  const s = deps.progressStore.addXp(kind as XpKind, amount, attemptId !== undefined ? { attemptId } : {});
  if (!s) return json({ error: "invalid amount for kind" }, 400);
  return json(s);
}

async function handleProgressBlockStart(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ kind?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const kind = parsed.body.kind;
  if (typeof kind !== "string" || !(BLOCK_KINDS as readonly string[]).includes(kind)) {
    return json({ error: `kind must be one of: ${BLOCK_KINDS.join(", ")}` }, 400);
  }
  return json(deps.progressStore.blockStart(kind));
}

const LEVEL_ACTIONS = ["accept", "decline", "set"] as const;

async function handleProgressLevel(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ action?: unknown; level?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { action, level } = parsed.body;
  if (!(LEVEL_ACTIONS as readonly string[]).includes(action as string)) {
    return json({ error: `action must be one of: ${LEVEL_ACTIONS.join(", ")}` }, 400);
  }
  if (level !== undefined && typeof level !== "number") return json({ error: "level must be a number" }, 400);
  const s = deps.progressStore.levelAction(action as "accept" | "decline" | "set", level as number | undefined);
  if (!s) {
    return json({ error: action === "set" ? "level must be an integer between 1 and 999" : "no active proposal" }, 400);
  }
  return json(s);
}
```

`handleSentenceGrade` の成功パスに XP フックを追加（`return json(r);` の直前）:

```ts
  // 自己評価1枚ごとの努力XP（good=2 / soso=1 / bad=1）。付与失敗で採点自体は失敗させない
  try {
    deps.progressStore.addXp("srs-grade", grade === "good" ? 2 : 1, { no });
  } catch (err) {
    console.warn("[progress] srs-grade xp failed, continuing:", String(err));
  }
```

`makeFetchHandler` のルート表、`/api/progress/days` の行の下に追加:

```ts
      if (req.method === "GET" && url.pathname === "/api/progress/summary") return json(deps.progressStore.getSummary());
      if (req.method === "POST" && url.pathname === "/api/progress/xp") return await handleProgressXp(req, deps);
      if (req.method === "POST" && url.pathname === "/api/progress/block-start") return await handleProgressBlockStart(req, deps);
      if (req.method === "POST" && url.pathname === "/api/progress/level") return await handleProgressLevel(req, deps);
```

- [ ] **Step 7: routes.test.ts を更新**

`makeTestDeps` に必須フィールドを追加（`sentenceStore` の下、`...overrides` の前）。ファイル冒頭の FAKE 定義群に追加:

```ts
const FAKE_SUMMARY = {
  level: 13, xp: 0, xpIntoLevel: 0, xpToNext: 25, stage: 2, difficultyMaxed: false, proposal: null,
};
```

makeTestDeps 内:

```ts
    progressStore: {
      getLevel: () => 13,
      getSummary: () => FAKE_SUMMARY,
      addXp: (kind: string, amount: number) =>
        kind === "block" && Number.isInteger(amount) && amount >= 1 && amount <= 60 ? FAKE_SUMMARY
        : kind === "srs-grade" ? FAKE_SUMMARY : null,
      blockStart: (_kind: string) => ({ attemptId: 7 }),
      levelAction: (action: string, level?: number) =>
        action === "set" && Number.isInteger(level) && (level as number) >= 1 ? FAKE_SUMMARY : null,
    } as RouteDeps["progressStore"],
```

契約テストを追加（ファイル末尾）:

```ts
describe("routes: progress", () => {
  test("GET /api/progress/summary は summary を返す", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(new Request("http://localhost/api/progress/summary"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_SUMMARY);
  });
  test("POST /api/progress/xp: block のみ受け付け、上限超過・不正kindは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", body: JSON.stringify({ kind: "block", amount: 6, attemptId: 7 }) }));
    expect(ok.status).toBe(200);
    const badKind = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", body: JSON.stringify({ kind: "srs-grade", amount: 2 }) }));
    expect(badKind.status).toBe(400);
    const tooBig = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", body: JSON.stringify({ kind: "block", amount: 61 }) }));
    expect(tooBig.status).toBe(400);
    const badAttempt = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", body: JSON.stringify({ kind: "block", amount: 6, attemptId: "x" }) }));
    expect(badAttempt.status).toBe(400);
  });
  test("POST /api/progress/block-start: 有効kindで attemptId、不正kindは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/progress/block-start", {
      method: "POST", body: JSON.stringify({ kind: "warmup-reading" }) }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ attemptId: 7 });
    const bad = await handler(new Request("http://localhost/api/progress/block-start", {
      method: "POST", body: JSON.stringify({ kind: "bogus" }) }));
    expect(bad.status).toBe(400);
  });
  test("POST /api/progress/level: set 成功・提案なしaccept/declineは400・不正actionは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", body: JSON.stringify({ action: "set", level: 20 }) }));
    expect(ok.status).toBe(200);
    const noProposal = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", body: JSON.stringify({ action: "accept" }) }));
    expect(noProposal.status).toBe(400);
    const badAction = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", body: JSON.stringify({ action: "reset" }) }));
    expect(badAction.status).toBe(400);
  });
  test("POST /api/sentences/grade は srs-grade XP を付与する（good=2, soso=1）", async () => {
    const calls: Array<{ kind: string; amount: number }> = [];
    const { deps } = makeTestDeps({
      progressStore: {
        getLevel: () => 13, getSummary: () => FAKE_SUMMARY,
        addXp: (kind: string, amount: number) => { calls.push({ kind, amount }); return FAKE_SUMMARY; },
        blockStart: () => ({ attemptId: 1 }), levelAction: () => null,
      } as RouteDeps["progressStore"],
    });
    const handler = makeFetchHandler(deps);
    await handler(new Request("http://localhost/api/sentences/grade", {
      method: "POST", body: JSON.stringify({ no: 1, grade: "good" }) }));
    await handler(new Request("http://localhost/api/sentences/grade", {
      method: "POST", body: JSON.stringify({ no: 1, grade: "soso" }) }));
    expect(calls).toEqual([{ kind: "srs-grade", amount: 2 }, { kind: "srs-grade", amount: 1 }]);
  });
});
```

- [ ] **Step 8: index.ts に配線**

`app/server/index.ts`: import に `makeProgressStore` を追加し、`sentenceStore` の下で生成、realDeps に渡す:

```ts
import { makeProgressStore } from "./progress-store";
// ...
const progressStore = makeProgressStore(db);
// realDeps に追加:
  progressStore,
```

- [ ] **Step 9: ゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: 全 PASS

- [ ] **Step 10: コミット**

```bash
git add app/server/db.ts app/server/progress-store.ts app/server/routes.ts app/server/index.ts app/server/__tests__/progress-store.test.ts app/server/__tests__/routes.test.ts
git commit -m "feat: レベル/XPストアとprogress APIを追加しSRS評価にXPを連動"
```

---

### Task 3: menu.ts のレベル駆動化 + Phase A 持ち越し回収

**Files:**
- Modify: `app/server/menu.ts`, `app/server/coach.ts`, `app/server/index.ts`
- Test: `app/server/__tests__/menu.test.ts`, `app/server/__tests__/coach.test.ts`（プロンプト文字列を assert している場合のみ）

**Interfaces:**
- Consumes: Task 1 の `DEFAULT_LEVEL, stageOf, fttRoundsSec, fttMiniRoundsSec, prepParams`、Task 2 の `progressStore.getLevel()`
- Produces（Task 4 が依存）: four-three-two ブロックの `params.modelTalkMode: "auto" | "button" | "none"`（クライアントは無い場合 "auto" 扱い）。`generatePrepPack(args: { topicTitle; hints; chunkCount?; hintLang? })`

- [ ] **Step 1: menu.test.ts の期待値更新と新テストを書く**

既存テストの機械的更新（実装前に一括で書き換え、レッド状態にする）:

1. `FTT_ROUNDS_SEC` / `FTT_MINI_ROUNDS_SEC` / `DEFAULT_STAGE` の import・assert を削除し、`DEFAULT_LEVEL`（progression.ts から）に置き換え
2. roundsSec 期待値: `[120, 90, 60]` → `[110, 85, 55]`（DEFAULT_LEVEL=13）、ftt-mini `[120, 90]` → `[110, 85]`
3. `deps.stage` を渡しているテストは `deps.level` へ（stage n → level `(n-1)*10+3`。例: stage 1→3, stage 2→13, stage 3→23）。`pickNextByDomain` の直接ユニットテスト（stage 引数）は変更不要
4. メニューキャッシュのファイル名を assert しているテストがあれば `menu-<ymd>-<minutes>-lv13.json` に更新

新テストを追加:

```ts
import { DEFAULT_LEVEL } from "../progression";

describe("menu: レベル駆動", () => {
  test("roundsSec はレベルから計算される（level 21 → [120,90,60]）", () => {
    const dirs = makeTmpContent(); // 既存テストのヘルパ流用（実名はファイル内の既存ヘルパに合わせる）
    const m = buildTodayMenu(60, { ...dirs, level: 21, today: () => new Date("2026-07-06T09:00:00") });
    const ftt = m.blocks.find((b) => b.kind === "four-three-two")!;
    expect(ftt.params.roundsSec).toEqual([120, 90, 60]);
  });
  test("modelTalkMode が stage に応じて params に載る（level 45 → button, 55 → none, 13 → auto）", () => {
    const dirs = makeTmpContent();
    for (const [level, mode] of [[45, "button"], [55, "none"], [13, "auto"]] as const) {
      const m = buildTodayMenu(60, { ...dirs, level, today: () => new Date("2026-07-06T09:00:00") });
      const ftt = m.blocks.find((b) => b.kind === "four-three-two")!;
      expect(ftt.params.modelTalkMode).toBe(mode);
    }
  });
  test("キャッシュキーに level を含む: レベルが変わると同日でも再構築される", () => {
    const dirs = makeTmpContent();
    const today = () => new Date("2026-07-06T09:00:00");
    const m13 = buildTodayMenu(60, { ...dirs, level: 13, today });
    const m21 = buildTodayMenu(60, { ...dirs, level: 21, today });
    const f13 = m13.blocks.find((b) => b.kind === "four-three-two")!;
    const f21 = m21.blocks.find((b) => b.kind === "four-three-two")!;
    expect(f13.params.roundsSec).toEqual([110, 85, 55]);
    expect(f21.params.roundsSec).toEqual([120, 90, 60]);
  });
});

describe("menu: rotation state の防御（Phase A 持ち越し）", () => {
  test("v2 の usage に配列でない値が混ざっていたら該当エントリだけ捨てる", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "menu-"));
    const usageFile = path.join(dir, "u.json");
    writeFileSync(usageFile, JSON.stringify({
      version: 2,
      usage: { good: ["2026-07-01"], broken: 42, alsoBad: "x" },
      lastDomain: { topic: "", scenario: "" },
    }));
    const dirs = makeTmpContent();
    // クラッシュせずメニューが組めること（markUsed が dates.push で落ちない）
    const m = buildTodayMenu(60, { ...dirs, usageFile, level: 13, today: () => new Date("2026-07-06T09:00:00") });
    expect(m.blocks.length).toBeGreaterThan(0);
  });
  test("部分的な v2 形状（usage欠落）は初期状態から開始する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "menu-"));
    const usageFile = path.join(dir, "u.json");
    writeFileSync(usageFile, JSON.stringify({ version: 2 }));
    const dirs = makeTmpContent();
    const m = buildTodayMenu(60, { ...dirs, usageFile, level: 13, today: () => new Date("2026-07-06T09:00:00") });
    expect(m.blocks.length).toBeGreaterThan(0);
  });
});
```

（`makeTmpContent` は menu.test.ts 既存の temp コンテンツ生成ヘルパの実名に合わせること。存在しない場合は既存テストが temp dir を組み立てているパターンをそのまま流用する。）

- [ ] **Step 2: レッド確認**

Run: `cd app && bun test __tests__/menu.test.ts`
Expected: FAIL

- [ ] **Step 3: menu.ts を実装**

変更点（完全なコード）:

1. import と定数:

```ts
import { DEFAULT_LEVEL, fttMiniRoundsSec, fttRoundsSec, prepParams, stageOf } from "./progression";
```

`FTT_ROUNDS_SEC` / `FTT_MINI_ROUNDS_SEC` / `DEFAULT_STAGE` の定義（および doc コメント）を**削除**。

2. `MenuDeps`: `stage?: number` を `level?: number` に置き換え:

```ts
export type MenuDeps = {
  topicsDir?: string;
  scenariosDir?: string;
  usageFile?: string;
  menuCacheDir?: string;
  today?: () => Date;
  /** 利用者レベル（1〜）。省略時 DEFAULT_LEVEL。stage・4/3/2秒数・準備支援を駆動する */
  level?: number;
};
```

3. 帯域フィルタヘルパを追加し、`pickNextByDomain` とシャドー素材選択の重複を置き換え:

```ts
/** stage 適合プール（空なら全体にフォールバック） */
export function filterInBand(items: ContentItem[], stage: number): ContentItem[] {
  const inBand = items.filter((it) => it.level[0] <= stage && stage <= it.level[1]);
  return inBand.length > 0 ? inBand : items;
}
```

`pickNextByDomain` 内の2行（`const inBand = ...; const pool = ...`）を `const pool = filterInBand(items, stage);` に、buildTodayMenu のシャドープール2行を `const shadowPool = others.length > 0 ? filterInBand(others, stage) : others;` に置き換え（others が空のときの `shadowTopic ?? mainTopic` フォールバックは既存のまま）。

4. `loadRotation` の v2 分岐に usage サニタイズ（Phase A 持ち越し①③）:

```ts
/** 値が string[] のエントリだけ残す（手動編集で混入した不正値で markUsed が落ちないように） */
function sanitizeUsage(raw: unknown): UsageMap {
  if (typeof raw !== "object" || raw === null) return {};
  const out: UsageMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v) && v.every((d) => typeof d === "string")) out[k] = v as string[];
  }
  return out;
}
```

v2 分岐の `usage: raw.usage as UsageMap` を `usage: sanitizeUsage(raw.usage)` に、旧形式分岐の `usage: raw as UsageMap` を `usage: sanitizeUsage(raw)` に置き換え。

5. `buildTodayMenu`: level 解決・キャッシュキー・roundsSec・modelTalkMode:

```ts
  const level = deps.level ?? DEFAULT_LEVEL;
  const stage = stageOf(level);
  // キャッシュキーに level を含める: レベル変更時は同日でも再構築（旧形式ファイル名は自然に無効化）
  const cacheFile = path.join(menuCacheDir, `menu-${ymd}-${minutes}-lv${level}.json`);
```

（既存の `const stage = deps.stage ?? DEFAULT_STAGE;` 行は削除。キャッシュ読み込みは既存のまま。）

blocks 内の four-three-two params を両構成（60/30）で:

```ts
params: { topic: mainTopic, roundsSec: fttRoundsSec(level), modelTalkMode: prepParams(stage).modelTalk }
```

6. `buildQuickMenu`: 同様に `const level = deps.level ?? DEFAULT_LEVEL; const stage = stageOf(level);`、ftt-mini の params を:

```ts
params: { topic, roundsSec: fttMiniRoundsSec(level), modelTalkMode: prepParams(stage).modelTalk }
```

- [ ] **Step 4: coach.ts の generatePrepPack をパラメータ化**

`PREP_SYSTEM` 定数を関数に変更:

```ts
function prepSystem(chunkCount: number): string {
  return `You prepare a Japanese IT professional (CEFR A2-B1) for a short English monologue.
You receive a topic and hint angles. Reply with STRICT JSON only — no markdown fences, no commentary — exactly this shape:
{"chunks":[{"en":"<complete, speakable sentence, B1 level>","ja":"<自然な日本語訳>"}],"outline":["<short English bullet>"]}
Rules:
- Exactly ${chunkCount} chunks. Each "en" MUST be a complete, speakable sentence of roughly 8-16 words that the learner can read aloud as-is.
  No ellipses ("..."), no blanks, and no placeholders like [X] — always fill the slot with a concrete, topic-relevant
  example a B1-level IT professional could plausibly say, using the given topic and hints for the content
  (e.g. "The main problem we had was a slow database query.", "What worked well was splitting the task into smaller steps.").
- Keep the reusable sentence frame recognizable at the START of each sentence (sentence-starter + filled example), so the
  learner can reuse that same frame with their own content in the next exercise.
- ja: the natural full-sentence Japanese translation of "en" (not a fragment).
- outline: 3-4 bullets forming a simple talk skeleton (opening → 1-2 points → wrap-up), tied to the given hints.
Do not use any tools — reply directly with text only.`;
}
```

`generatePrepPack` のシグネチャと本文:

```ts
export async function generatePrepPack(
  args: { topicTitle: string; hints: string[]; chunkCount?: number; hintLang?: "ja" | "en" },
  runner: ClaudeRunner = defaultRunner,
): Promise<PrepPack> {
  const chunkCount = args.chunkCount ?? 6;
  const prompt = `Topic: ${args.topicTitle}\nHint angles:\n${args.hints.map((h) => `- ${h}`).join("\n")}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: prepSystem(chunkCount) });
  const parsed = extractJson<PrepPack>(text);
  if (parsed && Array.isArray(parsed.chunks) && Array.isArray(parsed.outline)) {
    // （既存の sanitize ロジックはそのまま）
    // hintLang "en"（stage4+）は日本語併記をやめる。LLM出力に頼らずサーバ側で決定的に空にする
    const chunks = args.hintLang === "en"
      ? sanitizedChunks.map((c) => ({ ...c, ja: "" }))
      : sanitizedChunks;
    return { chunks, outline: sanitizedOutline };
  }
  return { chunks: [], outline: [text] };
}
```

（既存の sanitize 変数名はファイルの実物に合わせる。coach.test.ts が旧 `PREP_SYSTEM` の文言や「6-8 chunks」を assert していたら期待値を更新。）

- [ ] **Step 5: index.ts の配線を level 駆動に**

```ts
import { prepParams, stageOf } from "./progression";
// realDeps 内:
  buildMenu: (minutes) => buildTodayMenu(minutes, { level: progressStore.getLevel() }),
  buildQuick: (kind) => buildQuickMenu(kind, { level: progressStore.getLevel() }),
  prepPack: async (topicId) => {
    const topic = loadContent(TOPICS_DIR).find((t) => t.id === topicId);
    if (!topic) return null;
    const p = prepParams(stageOf(progressStore.getLevel()));
    return generatePrepPack({ topicTitle: topic.title, hints: topic.hints, chunkCount: p.chunkCount, hintLang: p.hintLang });
  },
```

- [ ] **Step 6: ゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: 全 PASS（menu の新テスト含む）

- [ ] **Step 7: コミット**

```bash
git add app/server/menu.ts app/server/coach.ts app/server/index.ts app/server/__tests__/menu.test.ts app/server/__tests__/coach.test.ts
git commit -m "feat: メニュー構築をレベル駆動化し準備支援パラメータを伝搬"
```

---

### Task 4: クライアントUI（ゲージ・提案カード・記録送信・モデルトークモード）

**Files:**
- Modify: `app/client/src/api.ts`, `App.tsx`, `i18n.ts`, `screens/SessionRunner.tsx`, `screens/FourThreeTwoScreen.tsx`, `screens/StartScreen.tsx`, `styles/app.css`

**Interfaces:**
- Consumes: Task 2 の HTTP 契約、Task 3 の `params.modelTalkMode`
- 変えてはいけない行: App.tsx の sessionId/startedRef/useEffect 本体・health バナー3種・navItems・lang トグル。SessionRunner の block_start/block_end セッションイベント送信（XP記録はイベント送信と**並存**させる — 置き換えない）

- [ ] **Step 1: api.ts に型と関数を追加**

`Settings` 型の手前（`fetchPracticeDays` の下）に追加:

```ts
export type LevelProposal = {
  kind: "up" | "down";
  toLevel: number;
  rationale: { xpReached?: boolean; practicedDays14?: number; completionRate?: number | null; fttAborts?: number };
};
export type ProgressSummary = {
  level: number; xp: number; xpIntoLevel: number; xpToNext: number;
  stage: number; difficultyMaxed: boolean; proposal: LevelProposal | null;
};

export async function fetchProgressSummary(): Promise<ProgressSummary> {
  const res = await fetch("/api/progress/summary");
  if (!res.ok) throw new Error(`progress summary failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function progressBlockStart(kind: string): Promise<number> {
  const res = await fetch("/api/progress/block-start", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }),
  });
  if (!res.ok) throw new Error(`block-start failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { attemptId: number }).attemptId;
}

export async function progressBlockXp(amount: number, attemptId: number | null): Promise<ProgressSummary> {
  const res = await fetch("/api/progress/xp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "block", amount, attemptId: attemptId ?? undefined }),
  });
  if (!res.ok) throw new Error(`xp failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function progressLevelAction(
  action: "accept" | "decline" | "set", level?: number,
): Promise<ProgressSummary> {
  const res = await fetch("/api/progress/level", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, level }),
  });
  if (!res.ok) throw new Error(`level action failed: ${await extractErrorMessage(res)}`);
  return res.json();
}
```

`MenuBlock` の params 型に `modelTalkMode?: "auto" | "button" | "none"` を追加:

```ts
export type MenuBlock = { id: string; kind: string; title: string; minutes: number; params: { topic?: ContentItem; scenario?: ContentItem; roundsSec?: number[]; modelTalkMode?: "auto" | "button" | "none" } };
```

- [ ] **Step 2: i18n.ts に文言を追加**

`Strings` 型に追加:

```ts
  progress: {
    levelLabel: (n: number) => string;
    toNext: (xp: number) => string;
    maxed: string;
    editTitle: string; editSave: string; editCancel: string;
    upTitle: string; upBody: (toLevel: number) => string;
    downTitle: string; downBody: (toLevel: number) => string;
    xpReached: string;
    practicedDays: (n: number) => string;
    completionRate: (pct: number) => string;
    fttAborts: (n: number) => string;
    acceptUp: string; acceptDown: string; decline: string;
  };
```

en:

```ts
    progress: {
      levelLabel: (n) => `Lv ${n}`,
      toNext: (xp) => `${xp} XP to next level`,
      maxed: "Difficulty is at max — levels are just for fun now",
      editTitle: "Set your level", editSave: "Save", editCancel: "Cancel",
      upTitle: "Ready for the next stage?",
      upBody: (toLevel) => `Your recent practice looks solid. Move up to Lv ${toLevel}?`,
      downTitle: "An easier option",
      downBody: (toLevel) => `You could drop to Lv ${toLevel} to rebuild momentum — your XP stays.`,
      xpReached: "XP threshold reached",
      practicedDays: (n) => `${n} practice days in the last 14`,
      completionRate: (pct) => `${pct}% of recent blocks completed`,
      fttAborts: (n) => `${n} of the last five 4/3/2 blocks were cut short`,
      acceptUp: "Level up", acceptDown: "Move down", decline: "Not now",
    },
```

ja:

```ts
    progress: {
      levelLabel: (n) => `Lv ${n}`,
      toNext: (xp) => `次のレベルまで ${xp} XP`,
      maxed: "難易度は最大です — 以降のレベルはおまけ",
      editTitle: "レベルを変更", editSave: "保存", editCancel: "キャンセル",
      upTitle: "次のステージに進みませんか？",
      upBody: (toLevel) => `最近の練習は好調です。Lv ${toLevel} に上げますか？`,
      downTitle: "難易度の調整もできます",
      downBody: (toLevel) => `Lv ${toLevel} に戻して基礎を固め直すこともできます（XPは減りません）。`,
      xpReached: "必要XPに到達",
      practicedDays: (n) => `直近14日間の練習日 ${n}日`,
      completionRate: (pct) => `直近ブロックの完了率 ${pct}%`,
      fttAborts: (n) => `直近5回の4/3/2のうち${n}回が中断`,
      acceptUp: "レベルアップ", acceptDown: "レベルを下げる", decline: "今はしない",
    },
```

- [ ] **Step 3: SessionRunner に記録送信を追加**

import に `progressBlockStart, progressBlockXp` を追加。コンポーネント内:

```ts
  // XP用のブロック試行ID（サーバの block_attempts）。取得失敗は記録なしで練習は続行
  const attemptIdRef = useRef<number | null>(null);

  function beginAttempt(kind: string) {
    attemptIdRef.current = null;
    progressBlockStart(kind)
      .then((id) => { attemptIdRef.current = id; })
      .catch((err) => console.warn("block-start failed:", err));
  }
```

`loadMenu` の `.then` 内、`sendSessionEvent("block_start", ...)` の直後に `beginAttempt(first.kind);` を追加。

`nextBlock` の先頭、`sendSessionEvent("block_end", ...)` の直後に追加:

```ts
    progressBlockXp(block.minutes, attemptIdRef.current)
      .catch((err) => console.warn("xp post failed:", err));
```

同関数内、次ブロックの `sendSessionEvent("block_start", ...)` の直後に `beginAttempt(next.kind);` を追加。

（アンマウント時の aborted パスでは XP を送らない — attempt は未完了のまま残り、完了率シグナルの分母になる。これが意図。）

- [ ] **Step 4: FourThreeTwoScreen に modelTalkMode を追加**

props に `modelTalkMode?: "auto" | "button" | "none"` を追加し、既定は "auto"（旧キャッシュメニュー互換）:

```ts
export function FourThreeTwoScreen(props: {
  topic: ContentItem; sessionId: string; blockId: string; roundsSec?: number[];
  modelTalkMode?: "auto" | "button" | "none";
}) {
  const modelTalkMode = props.modelTalkMode ?? "auto";
```

`ModelState` に `"idle"` を追加: `type ModelState = "idle" | "script" | "audio" | "ready" | "playing" | "error";`、初期値を `modelTalkMode === "auto" ? "script" : "idle"` に。

マウント時 useEffect の prefetch を auto のみ実行:

```ts
      if (modelTalkMode === "auto") {
        prefetchModelTalkAudio(props.topic.id, (stage) => {
          if (aliveRef.current) setModelState(stage);
        })
          .then(({ text }) => {
            if (!aliveRef.current) return;
            setModelText(text);
            setModelState("ready");
          })
          .catch(() => {
            if (aliveRef.current) setModelState("error");
          });
      }
```

prep 画面のモデルトークUI（`<div className="start-row">` 内のボタンと `{modelText && ...}`）を `modelTalkMode !== "none"` で囲み、ボタンのラベル分岐に idle を追加:

```tsx
          {modelTalkMode !== "none" && (
            <Button onClick={playModelTalk} disabled={modelState === "script" || modelState === "audio" || modelState === "playing"}>
              {modelState === "idle" && "🎧 モデルトークを聞く（任意）"}
              {modelState === "script" && "✍ 原稿を作成中…"}
              {modelState === "audio" && "🎙 音声を生成中…"}
              {modelState === "ready" && "🎧 モデルトークを聞く（任意）"}
              {modelState === "playing" && "🔊 再生中…"}
              {modelState === "error" && "🎧 モデルトーク（再試行）"}
            </Button>
          )}
```

`SessionRunner.tsx` の `BlockBody` で four-three-two に `modelTalkMode={block.params.modelTalkMode}` を渡す。

- [ ] **Step 5: PracticeStat をレベルゲージ付きに拡張（App.tsx）**

import に `fetchProgressSummary, progressLevelAction, type ProgressSummary` を追加。`PracticeStat` を置き換え:

```tsx
/** サイドバー下部の練習実績＋レベル（情報表示のみ — 連続日数・喪失演出は置かない） */
function PracticeStat({ lang }: { lang: Lang }) {
  const [days, setDays] = useState<string[]>([]);
  const [summary, setSummary] = useState<ProgressSummary | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const fetchedRef = useRef(false);
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchPracticeDays().then(setDays).catch(() => {});
    fetchProgressSummary().then(setSummary).catch(() => {});
  }, []);
  const t = STR[lang];
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 6);
  const p = (n: number) => String(n).padStart(2, "0");
  const ymd = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const thisWeek = days.filter((d) => d >= ymd(weekAgo) && d <= ymd(now)).length;

  async function saveLevel() {
    const n = Number(editValue);
    if (!Number.isInteger(n) || n < 1) return;
    try {
      setSummary(await progressLevelAction("set", n));
    } catch (err) {
      console.warn("level set failed:", err);
    }
    setEditing(false);
  }

  const need = summary ? summary.xpIntoLevel + summary.xpToNext : 0;
  const pct = summary && need > 0 ? Math.min(100, Math.round((summary.xpIntoLevel / need) * 100)) : 0;

  return (
    <div className="stat-box">
      {summary && (
        <div className="stat-level-wrap">
          {editing ? (
            <div className="level-edit">
              <input
                className="level-input" type="number" min={1} value={editValue} autoFocus
                onChange={(e) => setEditValue(e.target.value)}
                aria-label={t.progress.editTitle}
              />
              <button className="level-edit-btn" onClick={saveLevel}>{t.progress.editSave}</button>
              <button className="level-edit-btn" onClick={() => setEditing(false)}>{t.progress.editCancel}</button>
            </div>
          ) : (
            <button
              className="stat-level" title={t.progress.editTitle}
              onClick={() => { setEditValue(String(summary.level)); setEditing(true); }}
            >
              {t.progress.levelLabel(summary.level)}
            </button>
          )}
          <div className="gauge" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="gauge-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="stat-sub">{summary.difficultyMaxed ? t.progress.maxed : t.progress.toNext(summary.xpToNext)}</div>
        </div>
      )}
      <div className="stat-title">{t.stat.title}</div>
      <div className="stat-main">{thisWeek}<span className="stat-unit">{t.stat.thisWeekUnit}</span></div>
      <div className="stat-sub">{t.stat.total(days.length)}</div>
    </div>
  );
}
```

- [ ] **Step 6: StartScreen に提案カードを追加**

import に `fetchProgressSummary, progressLevelAction, type LevelProposal, type ProgressSummary` を追加。`StartScreen` 内（days の useState の下）:

```ts
  const [summary, setSummary] = useState<ProgressSummary | null>(null);
```

既存 useEffect のフェッチに追加（fetchPracticeDays の下）:

```ts
      fetchProgressSummary().then((s) => { if (aliveRef.current) setSummary(s); }).catch(() => {});
```

コンポーネント末尾（PracticeCalendar の上）に描画を追加:

```tsx
      {summary?.proposal && (
        <ProposalCard
          proposal={summary.proposal} lang={props.lang}
          onAction={async (action) => {
            try {
              setSummary(await progressLevelAction(action));
            } catch (err) {
              console.warn("level action failed:", err);
            }
          }}
        />
      )}
```

同ファイルに追加コンポーネント:

```tsx
/** 昇格/降格の提案カード。根拠を実値で開示する（研究制約: 情報的フィードバック・中立トーン） */
function ProposalCard(props: {
  proposal: LevelProposal; lang: Lang;
  onAction: (action: "accept" | "decline") => void;
}) {
  const t = STR[props.lang].progress;
  const { proposal } = props;
  const r = proposal.rationale;
  const lines: string[] = [];
  if (r.xpReached) lines.push(t.xpReached);
  if (typeof r.practicedDays14 === "number") lines.push(t.practicedDays(r.practicedDays14));
  if (typeof r.completionRate === "number") lines.push(t.completionRate(Math.round(r.completionRate * 100)));
  if (typeof r.fttAborts === "number" && proposal.kind === "down") lines.push(t.fttAborts(r.fttAborts));
  return (
    <div className="card proposal-card">
      <h3>{proposal.kind === "up" ? t.upTitle : t.downTitle}</h3>
      <p>{proposal.kind === "up" ? t.upBody(proposal.toLevel) : t.downBody(proposal.toLevel)}</p>
      <ul className="text-sm text-muted">
        {lines.map((l, i) => (<li key={i}>{l}</li>))}
      </ul>
      <div className="proposal-actions">
        <Button variant="primary" onClick={() => props.onAction("accept")}>
          {proposal.kind === "up" ? t.acceptUp : t.acceptDown}
        </Button>
        <Button variant="secondary" onClick={() => props.onAction("decline")}>{t.decline}</Button>
      </div>
    </div>
  );
}
```

（StartScreen が `Button` を import していなければ `import { Button } from "../ui/Button";` を追加。）

- [ ] **Step 7: app.css にスタイルを追加**

`.stat-box` ルール群の下に:

```css
.stat-level-wrap { margin-bottom: var(--sp-2); padding-bottom: var(--sp-2); border-bottom: 1px solid var(--border); }
.stat-level { font: inherit; font-size: 20px; font-weight: 750; background: none; border: none; padding: 0; cursor: pointer; color: var(--text); }
.stat-level:hover { color: var(--accent); }
.gauge { height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; margin: var(--sp-1) 0; }
.gauge-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width 300ms ease; }
.level-edit { display: flex; gap: 4px; align-items: center; }
.level-input { width: 56px; font: inherit; padding: 2px 4px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); }
.level-edit-btn { font: inherit; font-size: var(--fs-sm); background: none; border: none; color: var(--accent); cursor: pointer; padding: 2px; }
.proposal-card { border-color: var(--accent); }
.proposal-card h3 { margin-top: 0; }
.proposal-actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-2); }
```

- [ ] **Step 8: ゲート**

Run: `cd app/client && bun run build` → PASS、`cd app && bun test && bun run typecheck` → 全 PASS（サーバ不変の確認）

- [ ] **Step 9: コミット**

```bash
git add app/client/src
git commit -m "feat: レベルゲージ・昇格降格提案カード・ブロック記録送信をクライアントに追加"
```

---

## Self-Review（執筆時に実施済み）

**スペックカバレッジ（§3〜§5, §8, §9）:**
- §3.1 レベル/ステージ/61+据え置き → Task 1（stageOf, fttRoundsSec cap）＋ Task 2（difficultyMaxed）
- §3.2 つまみ表・線形補間・DEFAULT Lv13 → Task 1（prepParams, fttRoundsSec, DEFAULT_LEVEL）＋ Task 3（menu/coach 伝搬）
- §4.1/4.2 XP獲得・カーブ・ステージ内自動昇格 → Task 2（addXp/autoLevelUp）＋ Task 4（ブロック完了送信）。SRS評価XPはサーバ内部付与（routes の grade ハンドラ）
- §5.1 昇格3条件・却下7日 → Task 2 computeProposal（テストで実値を固定）
- §5.2 降格2条件・中立文言・自動降格なし → Task 2（提案のみ）＋ Task 4（i18n 中立トーン）
- §5.3 手動変更 → Task 2 set ＋ Task 4 レベル編集UI
- §8.1 テーブル → Task 2（placement_results は Phase C に送り、逸脱リストに明記）
- §8.2 API4本＋メニューのlevel駆動 → Task 2/3（placement系は Phase C）
- §9 サイドバーゲージ・提案カード・手動変更・i18n EN/JA → Task 4

**プレースホルダ:** なし（全ステップに実コード）。menu.test の `makeTmpContent` のみ「既存ヘルパの実名に合わせる」と明示（実装者がファイル内で確認する指示付き）
**型整合:** ProgressSummary/Proposal は server（progress-store.ts）と client（api.ts）で同形。modelTalkMode のリテラルは progression.ts の ModelTalkMode と一致。MenuDeps.stage→level の変更は menu.test の更新リストに反映
**既存テストへの影響:** menu.test（roundsSec 期待値・DEFAULT_STAGE・stage→level・キャッシュ名）/ coach.test（PREP_SYSTEM を assert していれば）/ routes.test（makeTestDeps 必須フィールド追加）— すべて該当タスクの Step に列挙
**Phase A 持ち越し4件:** ①sanitizeUsage（Task 3 Step 3-4）②filterInBand（同）③部分v2テスト（Task 3 Step 1）④キャッシュキー変更で旧キャッシュ無効化（同）
