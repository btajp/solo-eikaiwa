# P2 学習サポート設定の統一 + P3 段階的ステップの横展開 Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** サーバの「データ削除による表示制御」をやめて ja を常に返し、サイドバーの統一サポート設定（おまかせ/多め/少なめ＋個別トグル）で表示既定をクライアントが決める仕組みにし、その設定基盤の上にシャドーイング・音読ウォームアップ・振り返り/AE の段階的ステップを横展開する。

**Architecture:** サーバは stage 駆動を「表示既定の供給者」に格下げする（`hintLang` は PrepPack の `hintDefault` として同梱し、`ja` は常に実データで返す）。クライアントに localStorage 永続の `support.ts`（preset＋個別トグルの純粋リゾルバ＋pub/sub フック）を新設し、各画面が `resolveSupport(override, preset, stageDefault)` で最終表示を決める。P3 の「もっと詳しく」は既存の phrase-hint と同じ「キャッシュしない軽量エンドポイント」パターンで新設する。

**Tech Stack:** Bun（サーバ/テスト: `bun:test`）、React + Vite + TypeScript（クライアント）、既存の R1 機能別ルータ規約（`routes/*.ts` の `makeXxxRoutes(deps)` + `exact()` テーブル）、R2 の `useLoad` フック、決定的 cloze（`app/client/src/cloze.ts` の `clozeText`）。

## Global Constraints

- コミット規約: Conventional Commits（`feat:` / `fix:` / `refactor:` / `test:` / `docs:`）。1タスク1コミット。
- 研究制約（binding）: 情報的フィードバックのみ。サポート「少なめ」でもデータは常に届くので、ユーザーがトグルを オン にすれば必ず見られる。訂正・判定・警告調の文言は書かない。
- UI 文言は日本語ハードコード（i18n 追加は P4 で行う。二重作業を避ける）。**唯一の例外はサイドバーのサポート設定 UI** で、これは `app/client/src/i18n.ts` に EN/JA 両方を追加する（サイドバーは既に i18n 済み領域のため）。
- HTTP 契約は additive: 既存レスポンスキーを削除しない。`ja` を空文字にしていた箇所が実データを返すのは「充実」方向で契約互換。新レスポンスフィールド（`hintDefault`）の追加のみ。
- 既存テストの期待値変更は「仕様変更による意図的更新」として扱う（弱体化ではない）。対象テストは各タスクに明記する。
- サーバ変更は R1 ルータ規約（`routes/coach.ts` の1ハンドラ＋1エントリ、プロンプトは `coach.ts` に置く、副作用は `bestEffort`）に従う。新エンドポイントはテストファースト。
- クライアント設定は localStorage（キーは既存慣例に合わせ短い文字列。既存: `"lang"` / `"ui.scale"` / `"sentences.hideNote"`）。
- 検証ゲート（各タスク末尾で必ず実行）: `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build`。
- リポジトリ規約: `data/` や royal300 データには触れない。`00-` 始まりのディレクトリには一切言及しない。

---

## File Structure

**新規作成**
- `app/client/src/support.ts` — サポート設定の型・localStorage 永続・pub/sub・`useSupport()` フック・純粋リゾルバ `resolveSupport`。
- `app/client/src/support.test.ts` — `resolveSupport` の純粋ロジックテスト（`cd app && bun test` が拾う）。

**変更**
- `app/server/progression.ts` — `ModelTalkMode` から `"none"` を削除、`PREP_TABLE` stage6 を `button` に。
- `app/server/coach.ts` — `PrepPack` に `hintDefault` を追加、`generatePrepPack` の ja 空文字化を撤廃、`generateFixExplanation`＋`FIX_EXPLAIN_SYSTEM` を追加。
- `app/server/routes/coach.ts` — `CoachRoutesDeps` に `fixExplain`、`handleFixExplain` ハンドラと `/api/coach/fix-explain` エントリを追加。
- `app/server/index.ts` — `prepPack`（変更なし: `hintLang` を渡し続ける）、`fixExplain` を realDeps に配線。
- `app/server/__tests__/progression.test.ts` / `coach.test.ts` / `menu.test.ts` / `routes-coach.test.ts` / `helpers/route-deps.ts` — 仕様変更に伴う期待値更新と新規テスト。
- `app/client/src/api.ts` — `PrepPack` に `hintDefault`、`MenuBlock.modelTalkMode` から `"none"` 削除、`fetchFixExplanation` 追加。
- `app/client/src/i18n.ts` — `Strings.support` と EN/JA を追加。
- `app/client/src/App.tsx` — サイドバーに `SupportPanel`。
- `app/client/src/ui/ChunkList.tsx` — `showJa` プロップ。
- `app/client/src/screens/WarmupReadingScreen.tsx` — jaHint 反映（P2）＋歯抜け音読2周目（P3）。
- `app/client/src/screens/FourThreeTwoScreen.tsx` — jaHint・modelTalk 反映（P2）＋AE の「もっと詳しく」（P3）。
- `app/client/src/screens/SentencesScreen.tsx` — cloze 既定（P2）。
- `app/client/src/screens/ShadowingScreen.tsx` — スクリプト隠し既定＋表示ボタン（P3）。
- `app/client/src/screens/ReflectionScreen.tsx` — fixes の「もっと詳しく」（P3）。

---

## Task 1: サーバ — ja を常に返し、モデルトーク none を廃止（P2 サーバ設計是正）

spec §2-2（表示制御をデータ削除で実装している問題）と §3 P2 のサーバ修正。`ja` を常に実データで返し、stage 由来の表示既定を `hintDefault` として同梱する。`modelTalk` mode `"none"` を廃止し `"button"` に統一する。既存テストの期待値は仕様変更として更新する。

**Files:**
- Modify: `app/server/progression.ts:7`（`ModelTalkMode`）, `app/server/progression.ts:45-52`（`PREP_TABLE`）
- Modify: `app/server/coach.ts:165`（`PrepPack` 型）, `app/server/coach.ts:183-206`（`generatePrepPack`）
- Modify: `app/client/src/api.ts:94`（`MenuBlock`）, `app/client/src/api.ts:99`（`PrepPack`）
- Test: `app/server/__tests__/progression.test.ts:52-57`
- Test: `app/server/__tests__/coach.test.ts:92-155`
- Test: `app/server/__tests__/menu.test.ts:421-429`
- Test: `app/server/__tests__/helpers/route-deps.ts:134`

**Interfaces:**
- Produces: `type HintLang = "ja" | "en"`（既存 `progression.ts:6`）, `type ModelTalkMode = "auto" | "button"`（`"none"` 削除後）, `type PrepPack = { chunks: Array<{ en: string; ja: string }>; outline: string[]; hintDefault: HintLang }`（`coach.ts` と `api.ts` の両方でこの形にそろえる。`api.ts` 側は `hintDefault: "ja" | "en"` とインラインで書く）。

- [ ] **Step 1: 既存テストを新しい契約へ更新（仕様変更・ここで一時的に赤になる）**

`app/server/__tests__/progression.test.ts` の該当 test を差し替え（stage6 の `modelTalk` を `"none"` → `"button"`）:

```ts
describe("progression: prepParams", () => {
  test("stage 1..6 の支援パラメータ表", () => {
    expect(prepParams(1)).toEqual({ chunkCount: 8, hintLang: "ja", modelTalk: "auto" });
    expect(prepParams(3)).toEqual({ chunkCount: 6, hintLang: "ja", modelTalk: "auto" });
    expect(prepParams(4)).toEqual({ chunkCount: 5, hintLang: "en", modelTalk: "auto" });
    expect(prepParams(5)).toEqual({ chunkCount: 4, hintLang: "en", modelTalk: "button" });
    expect(prepParams(6)).toEqual({ chunkCount: 4, hintLang: "en", modelTalk: "button" });
  });
});
```

`app/server/__tests__/menu.test.ts:421-429` の test を差し替え（level 55 の期待を `"none"` → `"button"`）:

```ts
  test("modelTalkMode が stage に応じて params に載る（level 45 → button, 55 → button, 13 → auto）", () => {
    // キャッシュは level を問わず同日1本なので、level ごとに別ディレクトリ（別キャッシュ）を使う
    for (const [level, mode] of [[45, "button"], [55, "button"], [13, "auto"]] as const) {
      const dirs = makeContentDirs();
      const m = buildTodayMenu(60, { ...dirs, level, today: () => new Date("2026-07-06T09:00:00") });
      const ftt = m.blocks.find((b) => b.kind === "four-three-two")!;
      expect(ftt.params.modelTalkMode).toBe(mode);
    }
  });
```

`app/server/__tests__/coach.test.ts:104` の正常系 test の1行を、`hintDefault` 同梱に更新:

```ts
    expect(result).toEqual({ ...valid, hintDefault: "ja" });
```

`app/server/__tests__/coach.test.ts:124-130` の「hintLang "en" は全chunkのjaを空にする」test を、新契約（ja は常にデータ・hintDefault で既定だけ伝える）に差し替え:

```ts
  test("hintLang \"en\" でも ja はデータとして残し、hintDefault で表示既定だけを伝える（データ削除しない）", async () => {
    const { runner } = runnerReturning(JSON.stringify(valid));
    const result = await generatePrepPack({ topicTitle: "t", hints: [], hintLang: "en" }, runner);
    expect(result.chunks.map((c) => c.ja)).toEqual(valid.chunks.map((c) => c.ja)); // ja は空にしない
    expect(result.hintDefault).toBe("en"); // 表示既定は en（上級者は既定で英語のみ表示）
  });

  test("hintLang 省略時の hintDefault は ja（最大サポート側の既定）", async () => {
    const { runner } = runnerReturning(JSON.stringify(valid));
    const result = await generatePrepPack({ topicTitle: "t", hints: [] }, runner);
    expect(result.hintDefault).toBe("ja");
  });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/progression.test.ts server/__tests__/coach.test.ts server/__tests__/menu.test.ts`
Expected: FAIL（`prepParams(6)` が `"none"` を返す・`generatePrepPack` に `hintDefault` が無い・`result.chunks[].ja` が空、で不一致）

- [ ] **Step 3: `progression.ts` を更新（none 廃止・stage6 を button に）**

`app/server/progression.ts:7` を差し替え:

```ts
export type ModelTalkMode = "auto" | "button";
```

`app/server/progression.ts:45-52` の `PREP_TABLE` 末尾行（stage 6）を差し替え:

```ts
const PREP_TABLE: readonly PrepSupport[] = [
  { chunkCount: 8, hintLang: "ja", modelTalk: "auto" },   // stage 1
  { chunkCount: 7, hintLang: "ja", modelTalk: "auto" },   // stage 2
  { chunkCount: 6, hintLang: "ja", modelTalk: "auto" },   // stage 3
  { chunkCount: 5, hintLang: "en", modelTalk: "auto" },   // stage 4
  { chunkCount: 4, hintLang: "en", modelTalk: "button" }, // stage 5
  { chunkCount: 4, hintLang: "en", modelTalk: "button" }, // stage 6（none 廃止: stage6 でも聞く手段を残す）
];
```

- [ ] **Step 4: `coach.ts` の `PrepPack` 型と `generatePrepPack` を更新（ja 常時・hintDefault 同梱）**

`app/server/coach.ts:1`（先頭の import 群）に `HintLang` の import を追加:

```ts
import type { HintLang } from "./progression";
```

`app/server/coach.ts:165` の `PrepPack` 型を差し替え:

```ts
export type PrepPack = { chunks: Array<{ en: string; ja: string }>; outline: string[]; hintDefault: HintLang };
```

`app/server/coach.ts:183-206` の `generatePrepPack` を差し替え（ja 空文字化を撤廃し、`hintDefault` を成功時・フォールバック時の両方に付ける）:

```ts
export async function generatePrepPack(
  args: { topicTitle: string; hints: string[]; chunkCount?: number; hintLang?: HintLang },
  runner: ClaudeRunner = defaultRunner,
): Promise<PrepPack> {
  const chunkCount = args.chunkCount ?? 6;
  // hintLang は「表示既定の供給者」。ja のデータ自体は常に返し、表示するかはクライアントが決める。
  const hintDefault: HintLang = args.hintLang ?? "ja";
  const prompt = `Topic: ${args.topicTitle}\nHint angles:\n${args.hints.map((h) => `- ${h}`).join("\n")}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: prepSystem(chunkCount) });
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

- [ ] **Step 5: サーバテストが緑になることを確認**

Run: `cd app && bun test server/__tests__/progression.test.ts server/__tests__/coach.test.ts server/__tests__/menu.test.ts`
Expected: PASS

- [ ] **Step 6: テストフェイクとクライアント型を新契約へ更新**

`app/server/__tests__/helpers/route-deps.ts:134` の `prepPack` フェイクに `hintDefault` を追加:

```ts
    prepPack: async () => ({ chunks: [{ en: "The main problem was ...", ja: "一番の問題は…" }], outline: ["Opening"], hintDefault: "ja" }),
```

`app/client/src/api.ts:94` の `MenuBlock` から `"none"` を削除:

```ts
export type MenuBlock = { id: string; kind: string; title: string; minutes: number; params: { topic?: ContentItem; scenario?: ContentItem; roundsSec?: number[]; modelTalkMode?: "auto" | "button" } };
```

`app/client/src/api.ts:99` の `PrepPack` に `hintDefault` を追加:

```ts
export type PrepPack = { chunks: Array<{ en: string; ja: string }>; outline: string[]; hintDefault: "ja" | "en" };
```

- [ ] **Step 7: 全ゲートを実行**

Run: `cd app && bun test`
Expected: PASS（全テスト緑）
Run: `cd app && bun run typecheck`
Expected: PASS
Run: `cd app/client && bun run build`
Expected: PASS（`FourThreeTwoScreen` は自身のプロップ型に `"none"` を残しているが、`"auto"|"button"` 値を受けるのは互換なのでエラーにならない。none 分岐の掃除は Task 3 で行う）

- [ ] **Step 8: コミット**

```bash
git add app/server/progression.ts app/server/coach.ts app/client/src/api.ts \
  app/server/__tests__/progression.test.ts app/server/__tests__/coach.test.ts \
  app/server/__tests__/menu.test.ts app/server/__tests__/helpers/route-deps.ts
git commit -m "refactor: prepのjaを常時データで返しhintDefaultで表示既定を伝える（modelTalk noneを廃止）"
```

---

## Task 2: クライアント — サポート設定モジュール＋i18n＋サイドバー常設パネル（P2 設定基盤）

spec §3 P2 の設定基盤。localStorage 永続の設定モジュールと、サイドバー常設の UI を作る。この時点では設定は保存・購読できるが、まだ画面には反映しない（反映は Task 3）。純粋リゾルバをテストする。

**Files:**
- Create: `app/client/src/support.ts`
- Create: `app/client/src/support.test.ts`
- Modify: `app/client/src/i18n.ts:13-93`（`Strings` 型）, `app/client/src/i18n.ts:100-102`（EN）, `app/client/src/i18n.ts:208-210`（JA）
- Modify: `app/client/src/App.tsx:1-16`（import）, `app/client/src/App.tsx:92-103`（サイドバー）, `app/client/src/App.tsx:136`（`SupportPanel` 定義追加）

**Interfaces:**
- Produces:
  - `type SupportPreset = "auto" | "more" | "less"`
  - `type SupportToggle = boolean | null`（`null` = 「おまかせ」= preset に従う）
  - `type SupportSettings = { preset: SupportPreset; jaHint: SupportToggle; modelTalk: SupportToggle; cloze: SupportToggle }`
  - `loadSupport(): SupportSettings` / `getSupport(): SupportSettings` / `saveSupport(next: SupportSettings): void`
  - `onSupportChange(fn: (s: SupportSettings) => void): () => void`
  - `useSupport(): SupportSettings`
  - `resolveSupport(override: SupportToggle, preset: SupportPreset, autoDefault: boolean): boolean`

- [ ] **Step 1: リゾルバの失敗するテストを書く**

Create `app/client/src/support.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveSupport } from "./support";

describe("resolveSupport", () => {
  test("override が非nullなら preset/既定より優先される", () => {
    expect(resolveSupport(true, "less", false)).toBe(true);
    expect(resolveSupport(false, "more", true)).toBe(false);
  });
  test("override が null: more は常にオン、less は常にオフ", () => {
    expect(resolveSupport(null, "more", false)).toBe(true);
    expect(resolveSupport(null, "less", true)).toBe(false);
  });
  test("override が null かつ auto なら stage 既定（autoDefault）に従う", () => {
    expect(resolveSupport(null, "auto", true)).toBe(true);
    expect(resolveSupport(null, "auto", false)).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd app && bun test client/src/support.test.ts`
Expected: FAIL（`Cannot find module './support'` / `resolveSupport is not defined`）

- [ ] **Step 3: `support.ts` を実装**

Create `app/client/src/support.ts`:

```ts
/**
 * 学習サポート設定（サイドバー常設の「おまかせ/多め/少なめ」＋個別トグル）。
 * localStorage に保存し、変更は購読者（開いている画面）へ通知する。
 * サーバの stage 駆動は「表示既定の供給者」に格下げされ、最終的な表示可否はここで決める。
 * データ（チャンクの ja 等）は常にサーバから届くので、「少なめ」でもトグルを オン にすれば見られる。
 */
import { useEffect, useState } from "react";

export type SupportPreset = "auto" | "more" | "less";
/** 個別トグルの値。null = 「おまかせ」（preset に従う）、true = 常にオン、false = 常にオフ */
export type SupportToggle = boolean | null;

export type SupportSettings = {
  preset: SupportPreset;
  jaHint: SupportToggle;
  modelTalk: SupportToggle;
  cloze: SupportToggle;
};

const STORAGE_KEY = "support";

export const DEFAULT_SUPPORT: SupportSettings = {
  preset: "auto", jaHint: null, modelTalk: null, cloze: null,
};

function isPreset(v: unknown): v is SupportPreset {
  return v === "auto" || v === "more" || v === "less";
}
function isToggle(v: unknown): v is SupportToggle {
  return v === null || v === true || v === false;
}

export function loadSupport(): SupportSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SUPPORT };
    const p = JSON.parse(raw) as Partial<SupportSettings>;
    return {
      preset: isPreset(p.preset) ? p.preset : "auto",
      jaHint: isToggle(p.jaHint) ? p.jaHint : null,
      modelTalk: isToggle(p.modelTalk) ? p.modelTalk : null,
      cloze: isToggle(p.cloze) ? p.cloze : null,
    };
  } catch {
    return { ...DEFAULT_SUPPORT };
  }
}

let current: SupportSettings = loadSupport();
let listeners: Array<(s: SupportSettings) => void> = [];

/** 現在の設定（同期取得。effect のマウント時初期化に使う） */
export function getSupport(): SupportSettings {
  return current;
}

export function saveSupport(next: SupportSettings): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage 不可（プライベートモード等）でもアプリは続行する
  }
  for (const fn of listeners) fn(next);
}

/** 購読する。戻り値を呼ぶと購読解除される */
export function onSupportChange(fn: (s: SupportSettings) => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((f) => f !== fn); };
}

/** サイドバー・各画面で購読して最新設定に追従する React フック */
export function useSupport(): SupportSettings {
  const [s, setS] = useState<SupportSettings>(current);
  useEffect(() => onSupportChange(setS), []);
  return s;
}

/**
 * 個別トグル → preset → stage 既定 の順で解決した最終ブール。
 * override が非 null ならそれを採用。null なら preset（more=常にオン / less=常にオフ / auto=stage既定）。
 */
export function resolveSupport(override: SupportToggle, preset: SupportPreset, autoDefault: boolean): boolean {
  if (override !== null) return override;
  if (preset === "more") return true;
  if (preset === "less") return false;
  return autoDefault;
}
```

- [ ] **Step 4: リゾルバのテストが緑になることを確認**

Run: `cd app && bun test client/src/support.test.ts`
Expected: PASS

- [ ] **Step 5: i18n に support ブロックを追加**

`app/client/src/i18n.ts` の `Strings` 型で、`uiScale: { small: string; medium: string; large: string; xlarge: string };`（15行目）の直後に追加:

```ts
  support: {
    title: string;
    presetAuto: string; presetMore: string; presetLess: string;
    jaHint: string; modelTalk: string; cloze: string;
    optAuto: string; optOn: string; optOff: string;
  };
```

EN STR で `uiScale: { small: "A−", medium: "A", large: "A＋", xlarge: "A＋＋" },`（102行目）の直後に追加:

```ts
    support: {
      title: "Support",
      presetAuto: "Auto", presetMore: "More", presetLess: "Less",
      jaHint: "Japanese hints", modelTalk: "Model talk", cloze: "Fill-in-the-blank",
      optAuto: "Auto", optOn: "On", optOff: "Off",
    },
```

JA STR で `uiScale: { small: "小", medium: "中", large: "大", xlarge: "特大" },`（210行目）の直後に追加:

```ts
    support: {
      title: "サポート",
      presetAuto: "おまかせ", presetMore: "多め", presetLess: "少なめ",
      jaHint: "日本語ヒント", modelTalk: "モデルトーク", cloze: "歯抜け既定",
      optAuto: "おまかせ", optOn: "オン", optOff: "オフ",
    },
```

- [ ] **Step 6: `App.tsx` に import と `SupportPanel` を追加**

`app/client/src/App.tsx:16`（`import { localYmd } from "./dates";` の直後）に追加:

```ts
import { saveSupport, useSupport, type SupportPreset, type SupportToggle } from "./support";
```

`app/client/src/App.tsx:99-102`（`<div className="lang-toggle" role="group" aria-label="Language">…</div>` のブロック）の直後、`<PracticeStat lang={lang} />`（103行目）の直前に、パネルの呼び出しを挿入:

```tsx
        <SupportPanel lang={lang} />
```

`app/client/src/App.tsx:136`（`/** サイドバー下部の練習実績… */` の `function PracticeStat` 定義の直前）に、新コンポーネントを追加:

```tsx
/** サイドバー常設の学習サポート設定（おまかせ/多め/少なめ＋個別トグル）。設定は support.ts が localStorage に永続化する */
function SupportPanel({ lang }: { lang: Lang }) {
  const s = useSupport();
  const t = STR[lang].support;
  function setPreset(preset: SupportPreset) {
    // preset を変えたら個別オーバーライドはクリアして preset に主導権を戻す
    saveSupport({ preset, jaHint: null, modelTalk: null, cloze: null });
  }
  function setToggle(key: "jaHint" | "modelTalk" | "cloze", value: SupportToggle) {
    saveSupport({ ...s, [key]: value });
  }
  const toggles: Array<{ key: "jaHint" | "modelTalk" | "cloze"; label: string }> = [
    { key: "jaHint", label: t.jaHint },
    { key: "modelTalk", label: t.modelTalk },
    { key: "cloze", label: t.cloze },
  ];
  return (
    <div className="support-panel stack">
      <div className="stat-title">{t.title}</div>
      <div className="lang-toggle" role="group" aria-label={t.title}>
        <button className={s.preset === "auto" ? "is-active" : ""} onClick={() => setPreset("auto")}>{t.presetAuto}</button>
        <button className={s.preset === "more" ? "is-active" : ""} onClick={() => setPreset("more")}>{t.presetMore}</button>
        <button className={s.preset === "less" ? "is-active" : ""} onClick={() => setPreset("less")}>{t.presetLess}</button>
      </div>
      {toggles.map((tg) => (
        <div key={tg.key}>
          <div className="text-sm text-muted">{tg.label}</div>
          <div className="lang-toggle" role="group" aria-label={tg.label}>
            <button className={s[tg.key] === null ? "is-active" : ""} onClick={() => setToggle(tg.key, null)}>{t.optAuto}</button>
            <button className={s[tg.key] === true ? "is-active" : ""} onClick={() => setToggle(tg.key, true)}>{t.optOn}</button>
            <button className={s[tg.key] === false ? "is-active" : ""} onClick={() => setToggle(tg.key, false)}>{t.optOff}</button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

（注: 既存の `.lang-toggle` / `.stat-title` / `.text-sm text-muted` / `.stack` クラスを再利用するので CSS 変更は不要）

- [ ] **Step 7: 全ゲートを実行**

Run: `cd app && bun test`
Expected: PASS
Run: `cd app && bun run typecheck`
Expected: PASS
Run: `cd app/client && bun run build`
Expected: PASS

- [ ] **Step 8: コミット**

```bash
git add app/client/src/support.ts app/client/src/support.test.ts app/client/src/i18n.ts app/client/src/App.tsx
git commit -m "feat: 学習サポート設定（おまかせ/多め/少なめ＋個別トグル）をサイドバーに常設"
```

---

## Task 3: クライアント — サポート設定を各画面に反映（P2 消費側）

spec §3 P2。Task 1 の `hintDefault` と Task 2 の `resolveSupport` を使い、チャンク ja 表示・モデルトーク自動再生・cloze 既定フェーズを設定に従わせる。表示ゲーティングのみで純粋ロジックは Task 2 で検証済みのため、このタスクは build/typecheck で検証する。

**Files:**
- Modify: `app/client/src/ui/ChunkList.tsx`（全体）
- Modify: `app/client/src/screens/WarmupReadingScreen.tsx:1-9`（import）, `:38-39`（`prep`/`chunks` 導出）, `:62`（`ChunkList`）
- Modify: `app/client/src/screens/FourThreeTwoScreen.tsx:1-12`（import）, `:41-43`（プロップ型・modelTalk 解決）, `:62`, `:84`, `:270-309`（prep 表示・モデルトークボタン）
- Modify: `app/client/src/screens/SentencesScreen.tsx:1-13`（import）, `:30-34`, `:86`, `:329-359`

**Interfaces:**
- Consumes: `resolveSupport`, `useSupport`, `getSupport`（`support.ts`）, `PrepPack.hintDefault`（`api.ts`）, `MenuBlock.modelTalkMode: "auto" | "button"`。
- Produces: `ChunkList` に `showJa?: boolean`（省略時 `true` で後方互換）。

- [ ] **Step 1: `ChunkList` に `showJa` プロップを追加**

`app/client/src/ui/ChunkList.tsx` を全面差し替え:

```tsx
import { Button } from "./Button";

type Chunk = { en: string; ja?: string };

/** 英文太字＋日本語gloss＋🔊スロット。onPlay 省略時は再生ボタンなし。showJa=false で ja gloss を隠す（データは残す） */
export function ChunkList({ chunks, playingIdx, onPlay, showJa = true }: { chunks: Chunk[]; playingIdx: number | null; onPlay?: (i: number, en: string) => void; showJa?: boolean }) {
  return (
    <ul className={`chunk-list${onPlay ? "" : " no-audio"}`}>
      {chunks.map((c, i) => (
        <li key={i}>
          {onPlay && (
            <Button variant="ghost" onClick={() => onPlay(i, c.en)} disabled={playingIdx !== null} ariaLabel={`「${c.en}」を再生`}>
              {playingIdx === i ? "…" : "🔊"}
            </Button>
          )}
          <span className="chunk-en">{c.en}</span>
          {showJa && c.ja && <span className="chunk-ja">{c.ja}</span>}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: `WarmupReadingScreen` で jaHint を反映**

`app/client/src/screens/WarmupReadingScreen.tsx:1-9` の import 群に追加（`useLoad` の import 行の直後など）:

```ts
import { resolveSupport, useSupport } from "../support";
```

`app/client/src/screens/WarmupReadingScreen.tsx:38-39`（`const prep = …` / `const chunks = …`）の直後に `showJa` の導出を追加。差し替え後:

```tsx
  const support = useSupport();
  const prep = load.state.status === "ready" ? load.state.data : null;
  const chunks = prep?.chunks.filter((c) => typeof c.en === "string" && c.en) ?? [];
  // ja を表示するか: 個別トグル → preset → サーバの stage 既定（hintDefault）で解決
  const showJa = prep ? resolveSupport(support.jaHint, support.preset, prep.hintDefault === "ja") : true;
```

`app/client/src/screens/WarmupReadingScreen.tsx:62` の `ChunkList` 呼び出しに `showJa` を渡す:

```tsx
          {chunks.length > 0 && <ChunkList chunks={chunks} playingIdx={playingIdx} onPlay={playChunk} showJa={showJa} />}
```

- [ ] **Step 3: `FourThreeTwoScreen` で jaHint と modelTalk を反映（none 分岐を掃除）**

`app/client/src/screens/FourThreeTwoScreen.tsx:1-12` の import 群に追加:

```ts
import { getSupport, resolveSupport, useSupport } from "../support";
```

`app/client/src/screens/FourThreeTwoScreen.tsx:41` のプロップ型から `"none"` を削除:

```tsx
  modelTalkMode?: "auto" | "button";
```

`app/client/src/screens/FourThreeTwoScreen.tsx:43` の `const modelTalkMode = props.modelTalkMode ?? "auto";` を差し替え（jaHint 用の reactive な `support` と、effect が参照する固定の `autoPlay` を用意する）:

```tsx
  const support = useSupport();
  // モデルトーク自動再生の可否: 個別トグル → preset → メニューの stage 既定（auto か）で解決。
  // 初期 modelState と一度きりの prefetch effect が参照するため、マウント時に固定する。
  const [autoPlay] = useState(() =>
    resolveSupport(getSupport().modelTalk, getSupport().preset, (props.modelTalkMode ?? "auto") === "auto"),
  );
```

`app/client/src/screens/FourThreeTwoScreen.tsx:62` の `modelState` 初期値を差し替え:

```tsx
  const [modelState, setModelState] = useState<ModelState>(autoPlay ? "script" : "idle");
```

`app/client/src/screens/FourThreeTwoScreen.tsx:84` の `if (modelTalkMode === "auto") {` を差し替え:

```tsx
      if (autoPlay) {
```

`app/client/src/screens/FourThreeTwoScreen.tsx:270-288` の prep ready ブロック（`prepState === "ready" && prep && (() => { … })()`）内で、`filteredChunks` を定義している IIFE の中の `ChunkList` に `showJa` を渡す。該当箇所を差し替え:

```tsx
        {prepState === "ready" && prep && (() => {
          const filteredChunks = prep.chunks.filter((c) => typeof c.en === "string" && c.en);
          const showJa = resolveSupport(support.jaHint, support.preset, prep.hintDefault === "ja");
          return (
          <div className="stack">
            {filteredChunks.length > 0 && (
              <ChunkList chunks={filteredChunks} playingIdx={playingIdx} onPlay={playChunk} showJa={showJa} />
            )}
            {prep.outline.length > 0 && (
              <Card header="話の骨組み">
                <ol>
                  {prep.outline.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ol>
              </Card>
            )}
          </div>
          );
        })()}
```

`app/client/src/screens/FourThreeTwoScreen.tsx:289-303` のモデルトークボタン部（`<div className="start-row">…`）で、`modelTalkMode !== "none" &&` のガードを外す（ボタンは常に出す）。該当ブロックを差し替え:

```tsx
        <div className="start-row">
          <Button onClick={playModelTalk} disabled={modelState === "script" || modelState === "audio" || modelState === "playing"}>
            {modelState === "idle" && "🎧 モデルトークを聞く（任意）"}
            {modelState === "script" && "✍ 原稿を作成中…"}
            {modelState === "audio" && "🎙 音声を生成中…"}
            {modelState === "ready" && "🎧 モデルトークを聞く（任意）"}
            {modelState === "playing" && "🔊 再生中…"}
            {modelState === "error" && "🎧 モデルトーク（再試行）"}
          </Button>
          <Button variant="primary" onClick={() => startRound(0)}>
            Round 1 を始める（{minLabel(roundsSec[0])}）→
          </Button>
        </div>
```

`app/client/src/screens/FourThreeTwoScreen.tsx:304-309` の `{modelTalkMode !== "none" && modelText && (…)}` を差し替え:

```tsx
        {modelText && (
          <details open>
            <summary className="text-muted">モデルトーク本文</summary>
            <p className="reading-text">{modelText}</p>
          </details>
        )}
```

- [ ] **Step 4: `SentencesScreen` で cloze 既定を反映**

`app/client/src/screens/SentencesScreen.tsx:1-13` の import 群に追加:

```ts
import { resolveSupport, useSupport } from "../support";
```

`app/client/src/screens/SentencesScreen.tsx:30` の `PracticeTab` シグネチャに `clozeDefault` を追加:

```tsx
function PracticeTab({ lang, hideNote, clozeDefault }: { lang: Lang; hideNote: boolean; clozeDefault: boolean }) {
```

`app/client/src/screens/SentencesScreen.tsx:34` の phase 初期値を `clozeDefault` 起点に:

```tsx
  const [phase, setPhase] = useState<Phase>(clozeDefault ? "cloze" : "prompt");
```

`app/client/src/screens/SentencesScreen.tsx:86`（次カードへ進む際の `setPhase("prompt");`）を差し替え:

```tsx
      setPhase(clozeDefault ? "cloze" : "prompt");
```

`app/client/src/screens/SentencesScreen.tsx:329-332` の `SentencesScreen` 本体で `support` と `clozeDefault` を導出。`const [hideNote, setHideNote] = useState(() => loadHideNote());`（332行目）の直後に追加:

```tsx
  const support = useSupport();
  // cloze を最初から出すか: 個別トグル → preset → 既定 false（cloze は補助なので「多め/オン」でのみ既定表示）
  const clozeDefault = resolveSupport(support.cloze, support.preset, false);
```

`app/client/src/screens/SentencesScreen.tsx:359` の `PracticeTab` 呼び出しに `clozeDefault` を渡す:

```tsx
      {tab === "practice" ? <PracticeTab lang={lang} hideNote={hideNote} clozeDefault={clozeDefault} /> : <BrowseTab lang={lang} />}
```

- [ ] **Step 5: 全ゲートを実行**

Run: `cd app && bun test`
Expected: PASS
Run: `cd app && bun run typecheck`
Expected: PASS
Run: `cd app/client && bun run build`
Expected: PASS（`FourThreeTwoScreen` の `"none"` 分岐が消え、`modelTalkMode` 比較の型エラーもなくなる）

- [ ] **Step 6: コミット**

```bash
git add app/client/src/ui/ChunkList.tsx app/client/src/screens/WarmupReadingScreen.tsx \
  app/client/src/screens/FourThreeTwoScreen.tsx app/client/src/screens/SentencesScreen.tsx
git commit -m "feat: サポート設定をチャンクja・モデルトーク・cloze既定に反映"
```

---

## Task 4: P3 — シャドーイングのスクリプト隠し既定＋音読ウォームアップの歯抜け2周目

spec §3 P3。シャドーイングは「スクリプトを隠して聞く」を既定にし「スクリプトを表示」ボタンで開く（訳解説は表示後に出す）。既定値はサポート設定の preset に従う（多め=最初から表示）。音読ウォームアップは既存 `clozeText` を流用した「歯抜けで音読」2周目（任意・スキップ可）を足す。

**Files:**
- Modify: `app/client/src/screens/ShadowingScreen.tsx`（全体）
- Modify: `app/client/src/screens/WarmupReadingScreen.tsx:1-9`（import）, `:16-19`（state）, `:60-74`（ready ブロック）

**Interfaces:**
- Consumes: `getSupport`, `resolveSupport`（`support.ts`）, `clozeText`（`app/client/src/cloze.ts`）。

- [ ] **Step 1: `ShadowingScreen` をスクリプト隠し既定に書き換え**

`app/client/src/screens/ShadowingScreen.tsx` を全面差し替え:

```tsx
import { useEffect, useRef, useState } from "react";
import { fetchTalkExplanation, prefetchModelTalkAudio, type ContentItem } from "../api";
import { playBlob, stopPlayback } from "../audio";
import { getSupport, resolveSupport } from "../support";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

type State = "script" | "audio" | "ready" | "playing" | "error";

/** モデルトークをTTSで聞きながら重ねて音読するシャドーイングブロック（知覚ドリル）。既定はスクリプトを隠して聞く */
export function ShadowingScreen(props: { topic: ContentItem }) {
  const [state, setState] = useState<State>("script");
  const [text, setText] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  // スクリプト表示の既定は preset に従う（多め=最初から表示 / おまかせ・少なめ=隠して聞く）。
  // マウント時に固定し、ユーザーは「スクリプトを表示」ボタンでいつでも開ける。
  const [showScript, setShowScript] = useState(() => resolveSupport(null, getSupport().preset, false));
  // 日本語訳と解説: null=未取得, "loading"=生成中, それ以外=本文
  const [explain, setExplain] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      prepare();
    }
    return () => {
      aliveRef.current = false;
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function prepare() {
    setErrorMsg("");
    setState("script");
    try {
      const { text: t, blob } = await prefetchModelTalkAudio(props.topic.id, (stage) => {
        if (aliveRef.current) setState(stage);
      });
      if (!aliveRef.current) return;
      setText(t);
      setAudioBlob(blob);
      setState("ready");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  async function play() {
    if (!audioBlob) return;
    setState("playing");
    try {
      await playBlob(audioBlob);
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
    if (aliveRef.current) setState("ready");
  }

  return (
    <div className="stack">
      <p className="text-muted">
        まずはスクリプトを見ずに、音声に少し遅れてかぶせるように声に出して繰り返します（シャドーイング）。1回聞くだけでもOK。行き詰まったら「スクリプトを表示」で確認できます。
      </p>
      {state === "script" && <p className="text-muted">✍ コーチがモデルトークを書いています…</p>}
      {state === "audio" && <p className="text-muted">🎙 音声を生成しています…</p>}
      {state === "error" && (
        <Banner kind="error" action={<Button onClick={prepare}>再試行</Button>}>
          {errorMsg}
        </Banner>
      )}
      {(state === "ready" || state === "playing") && (
        <div className="stack">
          <Button variant="primary" onClick={play} disabled={state === "playing"}>
            {state === "playing" ? "🔊 再生中…" : "▶ 再生（何度でも）"}
          </Button>
          {!showScript && (
            <Button variant="secondary" onClick={() => setShowScript(true)}>📄 スクリプトを表示</Button>
          )}
          {showScript && (
            <>
              <Card className="reading-text">{text}</Card>
              {explain === null && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    setExplain("loading");
                    try {
                      const t = await fetchTalkExplanation(text);
                      if (aliveRef.current) setExplain(t);
                    } catch {
                      if (aliveRef.current) setExplain("解説を取得できませんでした。もう一度お試しください。");
                    }
                  }}
                >
                  💡 日本語訳と解説
                </Button>
              )}
              {explain === "loading" && <p className="text-sm text-muted">日本語訳と解説を書いています…</p>}
              {explain !== null && explain !== "loading" && (
                <p className="sentence-explain text-sm">{explain}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `WarmupReadingScreen` に歯抜け音読2周目を追加**

`app/client/src/screens/WarmupReadingScreen.tsx:1-9` の import 群に `clozeText` を追加（`../support` の import は Task 3 で追加済み）:

```ts
import { clozeText } from "../cloze";
```

`app/client/src/screens/WarmupReadingScreen.tsx:16-19` の state 宣言群（`const [playErr, …]` / `const [playingIdx, …]` / `const aliveRef = …`）に、歯抜けステップの state を追加。`const [playingIdx, setPlayingIdx] = useState<number | null>(null);` の直後に:

```tsx
  const [clozeStep, setClozeStep] = useState(false);
```

`app/client/src/screens/WarmupReadingScreen.tsx:60-74` の ready ブロック（`load.state.status === "ready" && prep && (…)`）を差し替え（`ChunkList` の `showJa` は Task 3 で入れた形を維持しつつ、歯抜け2周目を追加）:

```tsx
      {load.state.status === "ready" && prep && (
        <div className="stack">
          {chunks.length > 0 && <ChunkList chunks={chunks} playingIdx={playingIdx} onPlay={playChunk} showJa={showJa} />}
          {playErr && <Banner kind="error">{playErr}</Banner>}
          {chunks.length > 0 && !clozeStep && (
            <Button variant="secondary" onClick={() => setClozeStep(true)}>🔡 歯抜けで音読（2周目・任意）</Button>
          )}
          {clozeStep && (
            <Card header="歯抜けで音読（任意）">
              <p className="text-muted">今度は空欄を自分で埋めながら声に出しましょう。答えは上の一覧で確認できます。</p>
              <ul className="chunk-list no-audio">
                {chunks.map((c, i) => (
                  <li key={i}><span className="chunk-en">{clozeText(c.en, i + 1)}</span></li>
                ))}
              </ul>
            </Card>
          )}
          {prep.outline.length > 0 && (
            <Card header="今日の話の骨組み">
              <ol>
                {prep.outline.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ol>
            </Card>
          )}
        </div>
      )}
```

- [ ] **Step 3: 全ゲートを実行**

Run: `cd app && bun test`
Expected: PASS
Run: `cd app && bun run typecheck`
Expected: PASS
Run: `cd app/client && bun run build`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add app/client/src/screens/ShadowingScreen.tsx app/client/src/screens/WarmupReadingScreen.tsx
git commit -m "feat: シャドーイングをスクリプト隠し既定にし音読ウォームアップに歯抜け2周目を追加"
```

---

## Task 5: P3 — 訂正の詳しい解説エンドポイント（fix-explain・サーバ・TDD）

spec §3 P3。振り返り・AE の fixes（original→better）に「もっと詳しく」を出すためのバックエンド。**実装方式は「キャッシュしない軽量新エンドポイント」を選ぶ**（理由: ①`talk-explain` の `TALK_EXPLAIN_SYSTEM` はモノローグ向けで「日本語訳＋表現ポイント」を返すため、訂正ペアには意味的に不適切。②AE/振り返りの fixes はセッションごとに生成される一過性データで再出現がほぼ無く、ハッシュキャッシュ（＝新規DBテーブル）はヒット率がほぼゼロ。同一モジュールの `phrase-hint` も同じ理由でキャッシュしていない前例に倣う）。`routes/coach.ts` に1ハンドラ＋1エントリ、`coach.ts` に1生成関数＋1プロンプト、で完結する。

**Files:**
- Modify: `app/server/coach.ts`（`FIX_EXPLAIN_SYSTEM` と `generateFixExplanation` を追加。`generatePhraseHints` の直後あたり）
- Modify: `app/server/routes/coach.ts:8-29`（`CoachRoutesDeps`）, `:98-114`（新ハンドラ）, `:116-128`（`makeCoachRoutes`）
- Modify: `app/server/index.ts:8`（import）, `:84`（realDeps 配線）
- Modify: `app/server/__tests__/helpers/route-deps.ts:158`（フェイク）
- Modify: `app/client/src/api.ts`（`fetchFixExplanation`）
- Test: `app/server/__tests__/routes-coach.test.ts`（新規 describe）
- Test: `app/server/__tests__/coach.test.ts`（新規 describe）

**Interfaces:**
- Produces:
  - `generateFixExplanation(args: { original: string; better: string; note?: string }, runner?): Promise<{ text: string }>`（`coach.ts`）
  - `CoachRoutesDeps.fixExplain: (args: { original: string; better: string; note?: string }) => Promise<{ text: string }>`
  - `POST /api/coach/fix-explain`（body `{ original, better, note? }` → `{ text }`）
  - `fetchFixExplanation(original: string, better: string, note?: string): Promise<string>`（`api.ts`）

- [ ] **Step 1: ルートの失敗するテストを書く**

`app/server/__tests__/routes-coach.test.ts` の末尾（最後の `});` の後）に describe を追加:

```ts
describe("routes: 訂正の詳しい解説（fix-explain）", () => {
  test("POST /api/coach/fix-explain は解説テキストを返し original/note を渡す", async () => {
    let received: { original: string; better: string; note?: string } | null = null;
    const { deps } = makeTestDeps({
      fixExplain: async (args) => { received = args; return { text: "過去の出来事は went を使います。" }; },
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/coach/fix-explain", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ original: "I go yesterday", better: "I went yesterday", note: "past tense" }),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toContain("went");
    expect(received?.original).toBe("I go yesterday");
    expect(received?.note).toBe("past tense");
  });

  test("POST /api/coach/fix-explain は original/better が空で 400", async () => {
    const handler = makeFetchHandler(makeTestDeps().deps);
    const noOriginal = await handler(new Request("http://x/api/coach/fix-explain", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ better: "x" }),
    }));
    expect(noOriginal.status).toBe(400);
    const noBetter = await handler(new Request("http://x/api/coach/fix-explain", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ original: "x" }),
    }));
    expect(noBetter.status).toBe(400);
  });

  test("POST /api/coach/fix-explain は note を500字に切り詰める", async () => {
    let receivedLen = -1;
    const { deps } = makeTestDeps({
      fixExplain: async (args) => { receivedLen = args.note?.length ?? -1; return { text: "ok" }; },
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/coach/fix-explain", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ original: "a", better: "b", note: "n".repeat(1200) }),
    }));
    expect(res.status).toBe(200);
    expect(receivedLen).toBe(500);
  });
});
```

`app/server/__tests__/coach.test.ts` の import（`generatePhraseHints` などを import している2-5行目）に `generateFixExplanation` を追加し、ファイル末尾に describe を追加:

```ts
describe("generateFixExplanation", () => {
  test("original/better/note がプロンプトに入り、trim したテキストを返す", async () => {
    const { runner, seen } = runnerReturning("  過去形は went。  ");
    const result = await generateFixExplanation({ original: "I go", better: "I went", note: "past tense" }, runner);
    expect(result.text).toBe("過去形は went。");
    expect(seen[0].prompt).toContain("I go");
    expect(seen[0].prompt).toContain("I went");
    expect(seen[0].prompt).toContain("past tense");
    expect(seen[0].systemPrompt).toContain("JAPANESE");
  });

  test("note 省略時は Issue 行を含めない", async () => {
    const { runner, seen } = runnerReturning("x");
    await generateFixExplanation({ original: "a", better: "b" }, runner);
    expect(seen[0].prompt).not.toContain("Issue:");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/routes-coach.test.ts server/__tests__/coach.test.ts`
Expected: FAIL（`fixExplain` が `RouteDeps` に無い・`generateFixExplanation` 未定義・`/api/coach/fix-explain` が 404）

- [ ] **Step 3: `coach.ts` に `generateFixExplanation` を追加**

`app/server/coach.ts` の `generatePhraseHints`（127行目付近）の直後に追加:

```ts
const FIX_EXPLAIN_SYSTEM = `You are an English coach for a Japanese learner (CEFR A2-B1).
The learner said something that was corrected. You receive the original wording, the corrected ("better") version, and optionally a short note about the issue.
Explain IN JAPANESE, plain text (no markdown, no headings), within 8 lines, in this order:
1. なぜ better の言い方の方が自然・正しいのか（核心を1〜2文で）
2. 使い回し例: 同じ直し方が効く別の英文を1つ、日本語訳付きで
3. 覚え方のヒントを1文
Write English example sentences in English; everything else in Japanese. Do not scold the learner.
Do not use any tools — reply directly with text only.`;

/** 訂正（original→better）の詳しい日本語解説を生成する（プレーンテキスト・キャッシュしない・ボタン起点） */
export async function generateFixExplanation(
  args: { original: string; better: string; note?: string },
  runner: ClaudeRunner = defaultRunner,
): Promise<{ text: string }> {
  const noteLine = args.note?.trim() ? `\nIssue: ${args.note.trim()}` : "";
  const prompt = `Original: ${args.original}\nBetter: ${args.better}${noteLine}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: FIX_EXPLAIN_SYSTEM });
  return { text: text.trim() };
}
```

- [ ] **Step 4: `routes/coach.ts` にハンドラとルートを追加**

`app/server/routes/coach.ts:8-29` の `CoachRoutesDeps` 型に、`chunkStore` の項目の前あたりへ追加:

```ts
  /** 訂正（original→better）の詳しい日本語解説を生成（実体は coach.ts、テストはフェイク・キャッシュしない） */
  fixExplain: (args: { original: string; better: string; note?: string }) => Promise<{ text: string }>;
```

`app/server/routes/coach.ts` の `handlePhraseHint` 関数（98-114行目）の直後に新ハンドラを追加:

```ts
async function handleFixExplain(req: Request, deps: CoachRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ original?: unknown; better?: unknown; note?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { original, better, note } = parsed.body;
  if (typeof original !== "string" || original.trim().length === 0) return json({ error: "original must be a non-empty string" }, 400);
  if (typeof better !== "string" || better.trim().length === 0) return json({ error: "better must be a non-empty string" }, 400);
  if (original.length > 2000 || better.length > 2000) return json({ error: "text too long" }, 400);
  const safeNote = typeof note === "string" ? note.slice(0, 500) : undefined;
  const result = await deps.fixExplain({ original, better, note: safeNote });
  return json(result);
}
```

`app/server/routes/coach.ts:116-128` の `makeCoachRoutes` の返り値配列に、`phrase-hint` エントリの直後へ追加:

```ts
    exact("POST", "/api/coach/fix-explain", (req) => handleFixExplain(req, deps)),
```

- [ ] **Step 5: `index.ts` と テストフェイクに配線**

`app/server/index.ts:8` の coach からの import に `generateFixExplanation` を追加:

```ts
import { generateAeFeedback, generateFixExplanation, generateModelTalk, generatePhraseHints, generatePrepPack, generateReflection, generateSentenceExplanation, generateTalkExplanation, generateUtteranceTranslation, roleplayPrompt } from "./coach";
```

`app/server/index.ts:84`（`phraseHint: (args) => generatePhraseHints(args),` の行）の直後に追加:

```ts
  fixExplain: (args) => generateFixExplanation(args),
```

`app/server/__tests__/helpers/route-deps.ts:158`（`phraseHint: async () => (…),` の行）の直後に追加:

```ts
    fixExplain: async () => ({ text: "なぜ better の言い方が自然かの日本語解説。" }),
```

- [ ] **Step 6: `api.ts` にクライアント fetch を追加**

`app/client/src/api.ts` の `fetchPhraseHints`（427-438行目付近）の直後に追加:

```ts
/** 訂正（original→better）の詳しい日本語解説（キャッシュなし・ボタン起点のオンデマンド生成） */
export async function fetchFixExplanation(original: string, better: string, note?: string): Promise<string> {
  const res = await fetch("/api/coach/fix-explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ original, better, note }),
  });
  if (!res.ok) throw new Error(`fix explain failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}
```

- [ ] **Step 7: テストが緑になることと全ゲートを確認**

Run: `cd app && bun test server/__tests__/routes-coach.test.ts server/__tests__/coach.test.ts`
Expected: PASS
Run: `cd app && bun test`
Expected: PASS
Run: `cd app && bun run typecheck`
Expected: PASS
Run: `cd app/client && bun run build`
Expected: PASS

- [ ] **Step 8: コミット**

```bash
git add app/server/coach.ts app/server/routes/coach.ts app/server/index.ts \
  app/server/__tests__/helpers/route-deps.ts app/server/__tests__/routes-coach.test.ts \
  app/server/__tests__/coach.test.ts app/client/src/api.ts
git commit -m "feat: 訂正の詳しい解説エンドポイント（/api/coach/fix-explain）を追加"
```

---

## Task 6: P3 — 振り返り・AE フィードバックの fixes に「もっと詳しく」ボタン（クライアント）

spec §3 P3。Task 5 の `fetchFixExplanation` を使い、振り返りの fixes と AE フィードバックの各指摘に「もっと詳しく」を出す。解説は各項目のローカル state に保持し、押下後は同マウント内で再取得しない（キャッシュ不要の裏付け）。

**Files:**
- Modify: `app/client/src/screens/ReflectionScreen.tsx`（全体）
- Modify: `app/client/src/screens/FourThreeTwoScreen.tsx:1-12`（import）, `:315-343`（AE ブロック）

**Interfaces:**
- Consumes: `fetchFixExplanation`（`api.ts`）。

- [ ] **Step 1: `ReflectionScreen` の fixes に「もっと詳しく」を追加**

`app/client/src/screens/ReflectionScreen.tsx` を全面差し替え:

```tsx
import { useState } from "react";
import { fetchFixExplanation, fetchReflection } from "../api";
import { useLoad } from "../useLoad";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

/** 直したい表現1件。「もっと詳しく」で fetchFixExplanation を呼び、解説を自分の state に保持する */
function FixItem({ fix }: { fix: { original: string; better: string } }) {
  // null=未取得, "loading"=生成中, それ以外=解説テキスト
  const [explain, setExplain] = useState<string | null>(null);
  return (
    <li>
      <s>{fix.original}</s> → <strong>{fix.better}</strong>
      {explain === null && (
        <Button
          variant="ghost"
          onClick={async () => {
            setExplain("loading");
            try {
              setExplain(await fetchFixExplanation(fix.original, fix.better));
            } catch {
              setExplain("解説を取得できませんでした。もう一度お試しください。");
            }
          }}
        >
          💡 もっと詳しく
        </Button>
      )}
      {explain === "loading" && <p className="text-sm text-muted">解説を書いています…</p>}
      {explain !== null && explain !== "loading" && <p className="sentence-explain text-sm">{explain}</p>}
    </li>
  );
}

export function ReflectionScreen() {
  const { state, reload } = useLoad(fetchReflection);

  if (state.status === "error") {
    return (
      <div>
        <Banner kind="error" action={<Button onClick={reload}>再試行</Button>}>{state.error}</Banner>
      </div>
    );
  }
  if (state.status === "loading") return <p className="text-muted">コーチが今日のセッションを振り返っています…</p>;

  const reflection = state.data;
  return (
    <div className="stack">
      {reflection.goodPhrases.length > 0 && (
        <Card header={<h3>👏 良かった表現</h3>}>
          <ul>{reflection.goodPhrases.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </Card>
      )}
      {reflection.fixes.length > 0 && (
        <Card header={<h3>✏️ 直したい表現</h3>}>
          <ul>
            {reflection.fixes.map((f, i) => (
              <FixItem key={i} fix={f} />
            ))}
          </ul>
        </Card>
      )}
      <Card header={<h3>📝 明日へ</h3>}>
        <p>{reflection.noteForTomorrow_ja}</p>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: `FourThreeTwoScreen` の AE 指摘に「もっと詳しく」を追加**

`app/client/src/screens/FourThreeTwoScreen.tsx:1-12` の import 群の `../api` からの import に `fetchFixExplanation` を追加（既存の `fetchAeFeedback, fetchPrepPack, …` の行に足す）:

```ts
import {
  fetchAeFeedback, fetchFixExplanation, fetchPrepPack, playTtsCached, prefetchModelTalkAudio, sendSessionEvent, sttUpload,
  type AeFeedback, type ContentItem, type PrepPack,
} from "../api";
```

`app/client/src/screens/FourThreeTwoScreen.tsx` のコンポーネント本体の外（末尾の `}` の後）に、AE 指摘1件用のサブコンポーネントを追加:

```tsx
/** AE指摘1件。「もっと詳しく」で fetchFixExplanation を呼び、解説を自分の state に保持する */
function AeItemView({ item }: { item: { quote: string; issue: string; better: string; why_ja: string } }) {
  const [explain, setExplain] = useState<string | null>(null);
  return (
    <li className="ae-item">
      {item.quote && (
        <div>
          <s>{item.quote}</s> → <strong>{item.better}</strong> <em>({item.issue})</em>
        </div>
      )}
      <div className="ae-why">{item.why_ja}</div>
      {item.quote && item.better && explain === null && (
        <Button
          variant="ghost"
          onClick={async () => {
            setExplain("loading");
            try {
              setExplain(await fetchFixExplanation(item.quote, item.better, item.issue));
            } catch {
              setExplain("解説を取得できませんでした。もう一度お試しください。");
            }
          }}
        >
          💡 もっと詳しく
        </Button>
      )}
      {explain === "loading" && <p className="text-sm text-muted">解説を書いています…</p>}
      {explain !== null && explain !== "loading" && <p className="sentence-explain text-sm">{explain}</p>}
    </li>
  );
}
```

`app/client/src/screens/FourThreeTwoScreen.tsx:323-334`（AE ブロック内の `<ul>{ae.items.map(…)}</ul>`）を差し替え:

```tsx
            <ul>
              {ae.items.map((item, i) => (
                <AeItemView key={i} item={item} />
              ))}
            </ul>
```

- [ ] **Step 3: 全ゲートを実行**

Run: `cd app && bun test`
Expected: PASS
Run: `cd app && bun run typecheck`
Expected: PASS
Run: `cd app/client && bun run build`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add app/client/src/screens/ReflectionScreen.tsx app/client/src/screens/FourThreeTwoScreen.tsx
git commit -m "feat: 振り返り・AEフィードバックのfixesに「もっと詳しく」ボタンを追加"
```

---

## Self-Review

**1. Spec coverage（§3 P2 / §3 P3 / §2-2 / §4）**

| spec 要件 | 実装タスク |
|---|---|
| §2-2 表示制御をデータ削除でやめる（ja 常時・表示既定のみ stage） | Task 1（サーバ）＋ Task 3（表示ゲート） |
| §3 P2 サイドバーにサポート設定（セグメント＋個別トグル） | Task 2 |
| §3 P2 サーバ修正: ja を常にデータで返す | Task 1 |
| §3 P2 modelTalk mode=none 廃止 → button | Task 1（サーバ）＋ Task 3（クライアント掃除） |
| §3 P2 設定は localStorage・stage は既定値供給者 | Task 2（`support.ts`）＋ Task 1（`hintDefault`） |
| §3 P3 シャドーイング: スクリプト隠し既定＋表示ボタン | Task 4 |
| §3 P3 音読ウォームアップ: 歯抜け2周目（任意） | Task 4 |
| §3 P3 振り返り・AE の fixes に「もっと詳しく」 | Task 5（サーバ）＋ Task 6（クライアント） |
| §4 P3 は P2 の設定基盤の上に載せる（既定値を従わせる） | タスク順序 2→3→4 で担保 |

漏れなし。P4/P5 はスコープ外（含めていない）。

**2. Placeholder scan**: TBD / 「適切なエラー処理」等の曖昧表現なし。全コードステップは完全なコードを提示。i18n は EN/JA 全文記載。既存テストの期待値変更は「仕様変更」と明記。

**3. Type consistency**: `PrepPack.hintDefault: HintLang`（サーバ）と `"ja" | "en"`（`api.ts`）が一致。`ModelTalkMode = "auto" | "button"` を `progression.ts` / `menu` / `api.ts MenuBlock` / `FourThreeTwoScreen` プロップで一貫。`resolveSupport(override, preset, autoDefault)` の呼び出し（Warmup / FourThreeTwo / Sentences / Shadowing）は全て同シグネチャ。`fixExplain` の型（`{ original; better; note? } => { text }`）は `CoachRoutesDeps` / `route-deps` フェイク / `index.ts` 配線 / `generateFixExplanation` で一致。`showJa?: boolean`（省略時 true）で ChunkList 既存呼び出しは後方互換。
