# セッション再開（強化セッションの中断復帰）Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 強化セッション（60分/30分の通しメニュー）を当日中に中断（リロード・誤操作・メニュー離脱）しても、スタート画面に「続きから（ブロック n/m）」の情報的な導線を出し、押せば途中のブロックから再開できるようにする（押さなければ従来どおり最初から）。

**Architecture:** 再開状態はクライアントに新しく持たせず、**サーバの当日セッションログ（`data/sessions/<ymd>.jsonl`）の `block_end` イベント＋当日キャッシュ済みメニューから復元する**。ブロックの完了・XP付与は既に非aborted `block_end` を単一の起点にしているため、ここを真実源にすれば XP台帳とずれない。復元結果は新規 `GET /api/session/resume` が返し、`StartScreen` が中立な callout を出す。`SessionRunner` は開始インデックスを受け取って途中から始める。

**Tech Stack:** Bun + TypeScript（サーバ）、React 18 + Vite（クライアント）、bun:test（TDD）。DB・外部依存の追加なし。

## 主要設計判断: なぜ localStorage ではなくサーバログ復元か

監査スペック（`docs/superpowers/specs/2026-07-07-onboarding-progression-review.md`）の C3/Major-5 は「`block_end` イベントから当日の完了済みブロックを見て『続きから（ブロック3/5）』を提示」を推奨している。実コードを読んだ上で、以下の理由で **サーバログ復元** を採用する。

1. **材料が既にサーバ側にある（DRY）。** 完了ブロックは非aborted `block_end`（`SessionRunner.nextBlock`）として、メニューは決定論的な当日キャッシュ（`menu-<ymd>-<minutes>.json`）として既に永続化されている。localStorage は「アプリが既に持っている永続」を作り直すことになる。
2. **単一の真実源＝XP台帳と一致する。** ブロック完了マーカー（非aborted `block_end`）は XP付与（`progressBlockXp`）と同じ起点。ここから再開位置を出せば「XPは付いたのに再開位置は前」「再開位置は進んだのにXP未付与」のような二重台帳のドリフトが原理的に起きない。localStorage を別に持つとこのドリフトが発生しうる。
3. **実際の障害モードに強い。** 本課題の中心はハードリロード/タブ閉じで `useState` の index が消えること。React のアンマウント cleanup（`block_end(aborted:true)`）はハードリロードでは発火しないが、サーバログには既に完了ブロックが記録済みで、クライアント側 cleanup の発火に依存せず位置を復元できる。
4. **既存規約（makeXRoutes・サーバTDD）に素直に載る。** 復元は純関数＋1ルートで表現でき、`makeFetchHandler` 経由の統合テストとフェイク deps（`route-deps.ts`）でフルにテストできる。React コンポーネントのテスト文化がこのリポジトリには無い（純ロジックは `blockTitle.ts` / `practicePhase.ts` のように別モジュールに切り出してテストする）ため、正しさをサーバ側に寄せられるこの方式が規約に合う。

**唯一のコスト（許容範囲）:** 30分版と60分版のメニューは同日に同じブロックID（`b1`/`b2`/`b3`）を共有するため、`block_end` イベントに `minutes`（メニュー識別子）を additive に付ける必要がある。これが無いと「30分版を完了しただけ」で「60分版がブロック4から再開可能」という誤検出が出る（種別 `kind` だけでも `b1`〜`b3` は一致するため識別できない）。加えて新規ルート1本と純粋なキャッシュ読み出しヘルパ1つ。いずれも小さく局所的。

---

## Global Constraints

各タスクの要件はこのセクションを暗黙に含む。値は spec / 既存コードからの写しである。

- **研究制約（最優先）:** 情報的フィードバックのみ。判定・ノルマ・警告・強制・連続日数演出は禁止。再開導線は「押さなくてよい・押さなければ最初から」という中立トーンにする（`赤バッジ`・`未消化`・`やり残し` 等の督促語は使わない）。
- **named型 i18n（EN/JA 両方必須）:** ユーザー可視文言は `app/client/src/i18n.ts` の `...Strings` 型に追加し、`STR.en` と `STR.ja` の両方に定義する（型で強制され、片方欠落はコンパイルエラー）。コンポーネント内へのハードコード文言は禁止。
- **サーバ TDD:** テストは `bun:test`。ルートは `makeFetchHandler(deps)` 経由の統合テスト、純関数は単体テスト。フェイク deps は `app/server/__tests__/helpers/route-deps.ts` の `makeTestDeps` を使う。
- **makeXRoutes パターン:** エンドポイント追加はドメインモジュール（`routes/session.ts`）に「1ハンドラ＋1 `RouteEntry`」。新しい副作用依存は狭い `SessionRoutesDeps` 型に追加し、`index.ts`（実装）と `route-deps.ts`（フェイク）の両方に配線する。
- **当日内のみ:** 再開はサーバの当日ログ（`sessionLogPath(new Date())` = `<ymd>.jsonl`）からの復元に限る。翌日は自然に対象外になる（別ファイル）。
- **前提:** README 明記の個人開発・単一利用者・単一端末。永続はサーバ側の既存資産を単一の真実源とする。
- **additive・後方互換:** 既存イベント形状・XP台帳・メニューキャッシュ仕様を壊さない。`meta` はサーバでは自由形式（`Record<string, unknown>` パススルー）なので `minutes` 追加にルート側の変更は不要。
- **スコープ外（別項目）:** B3（未実施ブロックのスキップを aborted 化）と C4（降格提案の再設計）は Major-5/6 と関連するが本計画には**含めない**。現行 UI に「スキップ」ボタンは無く（唯一の前進ボタンは正当な完了として `block_end`＋XP を送る）、本計画は C3「中断からの再開」に限定する。
- **git 操作:** 各タスク末尾の commit ステップは**実行者向け**。コミットは小さくタスク単位で。

---

## File Structure

**サーバ（変更）**
- `app/server/session-log.ts` — 純関数 `completedDailyBlockIds(events, minutes)` を追加（非aborted `block_end` の blockId 集合）。`fttOutputSignals` と同じ「ログ解析ヘルパ」の並び。
- `app/server/menu.ts` — `readTodayMenuCache(minutes, deps)` を追加（当日キャッシュを**構築せず**読むだけ・shape 検証込みで `Menu | null`）。
- `app/server/routes/session.ts` — `GET /api/session/resume` ハンドラ＋エントリ。`SessionRoutesDeps` に `readMenuCache` を追加。
- `app/server/index.ts` — 実 deps に `readMenuCache` を配線。
- `app/server/__tests__/helpers/route-deps.ts` — フェイク deps に `readMenuCache` を追加。

**クライアント（変更・追加）**
- `app/client/src/screens/resume.ts`（新規） — 純関数 `resumeStartIndex(startIndex, blocksLength)`（クランプ）。`SessionRunner` から使う。テスト可能な唯一の非自明ロジックをコンポーネントから切り出す。
- `app/client/src/api/converse.ts` — `ResumeInfo` 型＋`fetchResumable()` を追加（セッション系関数はこのファイルに集約されている。barrel `api/index.ts` が `export *` で再公開する）。
- `app/client/src/screens/SessionRunner.tsx` — `MenuSource` daily に `startIndex?` を追加。daily のブロックイベント `meta` に `minutes` を付与。`resumeStartIndex` で開始ブロックを決める。
- `app/client/src/screens/StartScreen.tsx` — 起動時に `fetchResumable()`。中立な `ResumeCallout` を強化セッションの直前に描画。
- `app/client/src/i18n.ts` — `ResumeStrings` を追加し `Strings` 交差に合成、EN/JA 両方に `resume` を定義。

**テスト（追加）**
- `app/server/__tests__/session-log.test.ts`（既存に追記）
- `app/server/__tests__/menu.test.ts`（既存に追記）
- `app/server/__tests__/routes-session.test.ts`（既存に追記）
- `app/client/src/screens/resume.test.ts`（新規）
- `app/client/src/api/converse.test.ts`（新規）

---

## Task 1: サーバ純関数 `completedDailyBlockIds`

当日ログから「非aborted `block_end` かつ `meta.minutes` が指定分数と一致するブロックID」の集合を返す純関数。再開位置の土台。

**Files:**
- Modify: `app/server/session-log.ts`（`fttOutputSignals` の後ろに追加）
- Test: `app/server/__tests__/session-log.test.ts`（既存に `describe` を追記）

**Interfaces:**
- Consumes: 既存 `SessionEvent`（`app/server/session-log.ts` で定義済み: `{ ts; type; sessionId; text?; meta? }`）。
- Produces: `completedDailyBlockIds(events: SessionEvent[], minutes: number): Set<string>`

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/session-log.test.ts` の末尾（最終行 `}` の後）に追記する。ファイル先頭の import は既存のものを流用し、`completedDailyBlockIds` と `type SessionEvent` を `../session-log` からの import に加える。既存 import 行を次に置き換える。

```ts
import { fttOutputSignals, listPracticeDays, readEvents, completedDailyBlockIds, type SessionEvent } from "../session-log";
```

（既存ファイルが `fttOutputSignals` などを別々に import している場合は、`completedDailyBlockIds` と `type SessionEvent` を同じ `../session-log` の import に足すだけでよい。）

ファイル末尾に次の describe を追加する。

```ts
describe("completedDailyBlockIds", () => {
  const ev = (blockId: string, minutes: number, aborted?: boolean): SessionEvent => ({
    ts: "2026-07-07T00:00:00.000Z",
    type: "block_end",
    sessionId: "s1",
    meta: { blockId, kind: "reflection", minutes, ...(aborted ? { aborted: true } : {}) },
  });

  test("非aborted block_end の blockId を集める", () => {
    const events = [ev("b1", 60), ev("b2", 60)];
    expect([...completedDailyBlockIds(events, 60)].sort()).toEqual(["b1", "b2"]);
  });

  test("aborted:true は除外する", () => {
    const events = [ev("b1", 60), ev("b2", 60, true)];
    expect([...completedDailyBlockIds(events, 60)]).toEqual(["b1"]);
  });

  test("minutes が一致しないブロックは除外する（30分版は60分の集合に入らない）", () => {
    const events = [ev("b1", 30), ev("b2", 60)];
    expect([...completedDailyBlockIds(events, 60)]).toEqual(["b2"]);
  });

  test("block_end 以外のイベントと meta 欠落は無視する", () => {
    const events: SessionEvent[] = [
      { ts: "t", type: "block_start", sessionId: "s1", meta: { blockId: "b1", minutes: 60 } },
      { ts: "t", type: "block_end", sessionId: "s1" },
      ...[ev("b3", 60)],
    ];
    expect([...completedDailyBlockIds(events, 60)]).toEqual(["b3"]);
  });

  test("同一 blockId の重複はまとめる", () => {
    const events = [ev("b1", 60, true), ev("b1", 60)];
    expect([...completedDailyBlockIds(events, 60)]).toEqual(["b1"]);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd app && bun test server/__tests__/session-log.test.ts`
Expected: FAIL（`completedDailyBlockIds is not a function` / import 解決不可）

- [ ] **Step 3: 最小実装を書く**

`app/server/session-log.ts` の `fttOutputSignals` 関数の閉じ `}` の直後（ファイル末尾）に追加する。新規 import は不要（`SessionEvent` は同ファイル定義済み）。

```ts
/**
 * 当日ログから「非aborted block_end かつ meta.minutes が一致するブロックID」の集合を返す。
 * セッション再開の完了ブロック判定に使う（純関数・当日ログ前提）。
 * minutes は 30分版/60分版のメニューを識別するための判別子（両者は同日に blockId を共有するため）。
 */
export function completedDailyBlockIds(events: SessionEvent[], minutes: number): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type !== "block_end") continue;
    const m = e.meta as { blockId?: string; minutes?: number; aborted?: boolean } | undefined;
    if (!m || m.aborted === true || m.minutes !== minutes) continue;
    if (typeof m.blockId === "string") ids.add(m.blockId);
  }
  return ids;
}
```

- [ ] **Step 4: テストを実行して通過を確認する**

Run: `cd app && bun test server/__tests__/session-log.test.ts`
Expected: PASS（既存テストも含めて green）

- [ ] **Step 5: コミット**

```bash
git add app/server/session-log.ts app/server/__tests__/session-log.test.ts
git commit -m "feat: セッション再開の土台となる completedDailyBlockIds を追加"
```

---

## Task 2: サーバ純関数 `readTodayMenuCache`

当日のメニューキャッシュを**構築せずに**読むだけのヘルパ。再開ルートが「ユーザーが未開始のメニューを副作用で作ってしまう」ことを防ぐ。

**Files:**
- Modify: `app/server/menu.ts`（`invalidateTodayMenuCache` の近く／`buildQuickMenu` の前後どちらでも可。ここでは `invalidateTodayMenuCache` の直後に置く）
- Test: `app/server/__tests__/menu.test.ts`（既存に `describe` を追記）

**Interfaces:**
- Consumes: 既存の private `isValidMenuShape`、`readJsonSafe`（`./rotation`）、`localYmd`（`./dates`）、`PROGRESS_DIR`（`./paths`）— すべて `menu.ts` で import 済み。既存 `Menu` 型。
- Produces: `readTodayMenuCache(minutes: 60 | 30, deps?: { menuCacheDir?: string; today?: () => Date }): Menu | null`

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/menu.test.ts` の先頭 import に `readTodayMenuCache` を足す。既存の menu import 行を次に置き換える。

```ts
import {
  buildQuickMenu, buildTodayMenu, invalidateTodayMenuCache, readTodayMenuCache,
  QUICK_KINDS, type MenuDeps, type QuickKind,
} from "../menu";
```

ファイル末尾に次の describe を追加する。

```ts
describe("readTodayMenuCache", () => {
  test("当日キャッシュがあれば構築せずに読み出す", () => {
    const dirs = makeContentDirs();
    const built = buildTodayMenu(60, { ...dirs, today: JULY5 });
    const read = readTodayMenuCache(60, { menuCacheDir: dirs.menuCacheDir, today: JULY5 });
    expect(read).toEqual(built);
  });

  test("キャッシュが無ければ null（構築しない・キャッシュファイルも作らない）", () => {
    const dirs = makeContentDirs();
    const read = readTodayMenuCache(60, { menuCacheDir: dirs.menuCacheDir, today: JULY5 });
    expect(read).toBeNull();
    expect(existsSync(path.join(dirs.menuCacheDir, "menu-2026-07-05-60.json"))).toBe(false);
  });

  test("minutes 違いのキャッシュは読まない（30を要求したら30のファイルだけ見る）", () => {
    const dirs = makeContentDirs();
    buildTodayMenu(60, { ...dirs, today: JULY5 }); // 60だけ作る
    expect(readTodayMenuCache(30, { menuCacheDir: dirs.menuCacheDir, today: JULY5 })).toBeNull();
    expect(readTodayMenuCache(60, { menuCacheDir: dirs.menuCacheDir, today: JULY5 })).not.toBeNull();
  });

  test("shape 不正なキャッシュは null（level 欠落の旧形式を弾く）", () => {
    const dirs = makeContentDirs();
    mkdirSync(dirs.menuCacheDir, { recursive: true });
    writeFileSync(
      path.join(dirs.menuCacheDir, "menu-2026-07-05-60.json"),
      JSON.stringify({ minutes: 60, date: "2026-07-05", blocks: [{ id: "b1", kind: "reflection", title: "x", minutes: 5, params: {} }] }),
    );
    expect(readTodayMenuCache(60, { menuCacheDir: dirs.menuCacheDir, today: JULY5 })).toBeNull();
  });
});
```

（`existsSync`・`mkdirSync`・`writeFileSync`・`path` は `menu.test.ts` の先頭で既に import 済み。`JULY5` と `makeContentDirs` も同ファイルに定義済み。）

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd app && bun test server/__tests__/menu.test.ts`
Expected: FAIL（`readTodayMenuCache is not a function`）

- [ ] **Step 3: 最小実装を書く**

`app/server/menu.ts` の `invalidateTodayMenuCache` 関数の閉じ `}` の直後に追加する。新規 import は不要。

```ts
/**
 * 当日分のメニューキャッシュ（menu-<ymd>-<minutes>.json）を構築せずに読むだけのヘルパ。
 * セッション再開ルートが未開始のメニューを副作用で作らないようにするため、buildTodayMenu とは別に用意する。
 * shape 不正・未存在は null（＝再開対象なし）。
 */
export function readTodayMenuCache(
  minutes: 60 | 30,
  deps: { menuCacheDir?: string; today?: () => Date } = {},
): Menu | null {
  const menuCacheDir = deps.menuCacheDir ?? PROGRESS_DIR;
  const ymd = localYmd((deps.today ?? (() => new Date()))());
  const cacheFile = path.join(menuCacheDir, `menu-${ymd}-${minutes}.json`);
  const cached = readJsonSafe<Menu>(cacheFile);
  return cached && isValidMenuShape(cached) ? cached : null;
}
```

- [ ] **Step 4: テストを実行して通過を確認する**

Run: `cd app && bun test server/__tests__/menu.test.ts`
Expected: PASS（既存の menu テストも green）

- [ ] **Step 5: コミット**

```bash
git add app/server/menu.ts app/server/__tests__/menu.test.ts
git commit -m "feat: 当日メニューを構築せず読む readTodayMenuCache を追加"
```

---

## Task 3: `GET /api/session/resume` ルート＋deps 配線

Task 1・2 を組み合わせ、当日ログとキャッシュ済みメニューから再開可能なセッションを返すルート。60分/30分それぞれについて「先頭から連続で完了しているブロック数」を数え、`0 < completed < total` のものだけを返す。

**Files:**
- Modify: `app/server/routes/session.ts`（`SessionRoutesDeps` 拡張＋ハンドラ＋エントリ）
- Modify: `app/server/index.ts`（実 deps に `readMenuCache`）
- Modify: `app/server/__tests__/helpers/route-deps.ts`（フェイク deps に `readMenuCache`）
- Test: `app/server/__tests__/routes-session.test.ts`（既存に `describe` を追記）

**Interfaces:**
- Consumes: `completedDailyBlockIds`（Task 1）、`readEvents`（既存）、`readTodayMenuCache`（Task 2）、`Menu`（`../menu`）。
- Produces:
  - `SessionRoutesDeps.readMenuCache: (minutes: 60 | 30) => Menu | null`
  - `GET /api/session/resume` → `{ resumable: Array<{ minutes: 60 | 30; completed: number; total: number }> }`

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/routes-session.test.ts` の末尾に追記する。先頭 import に `type Menu` を追加する（`../menu` から）。既存 import 群の下に次を足す。

```ts
import type { Menu } from "../menu";
```

ファイル末尾に次の describe を追加する。

```ts
describe("routes: session/resume", () => {
  const menuOf = (minutes: 60 | 30, ids: string[]): Menu => ({
    minutes, date: "2026-07-07", level: 13,
    blocks: ids.map((id) => ({ id, kind: "reflection" as const, title: id, titleKey: "reflection" as const, minutes: 5, params: {} })),
  });
  const endBlock = (blockId: string, minutes: number, aborted?: boolean) =>
    postJson("/api/session/event", { type: "block_end", sessionId: "s1", meta: { blockId, kind: "reflection", minutes, ...(aborted ? { aborted: true } : {}) } });

  test("何も開始していなければ resumable は空", async () => {
    const { deps } = makeTestDeps({ readMenuCache: (m) => (m === 60 ? menuOf(60, ["b1", "b2", "b3", "b4", "b5"]) : null) });
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/api/session/resume"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resumable: [] });
  });

  test("60分版で2/5完了なら {minutes:60, completed:2, total:5}", async () => {
    const { deps } = makeTestDeps({ readMenuCache: (m) => (m === 60 ? menuOf(60, ["b1", "b2", "b3", "b4", "b5"]) : null) });
    const handler = makeFetchHandler(deps);
    await handler(endBlock("b1", 60));
    await handler(endBlock("b2", 60));
    const res = await handler(getReq("/api/session/resume"));
    expect(await res.json()).toEqual({ resumable: [{ minutes: 60, completed: 2, total: 5 }] });
  });

  test("aborted な block_end は完了に数えない", async () => {
    const { deps } = makeTestDeps({ readMenuCache: (m) => (m === 60 ? menuOf(60, ["b1", "b2", "b3", "b4", "b5"]) : null) });
    const handler = makeFetchHandler(deps);
    await handler(endBlock("b1", 60));
    await handler(endBlock("b2", 60, true));
    const res = await handler(getReq("/api/session/resume"));
    expect(await res.json()).toEqual({ resumable: [{ minutes: 60, completed: 1, total: 5 }] });
  });

  test("30分版の完了は60分版の再開に影響しない（minutes 判別子）", async () => {
    const { deps } = makeTestDeps({
      readMenuCache: (m) => (m === 60 ? menuOf(60, ["b1", "b2", "b3", "b4", "b5"]) : menuOf(30, ["b1", "b2", "b3", "b4"])),
    });
    const handler = makeFetchHandler(deps);
    // 30分版を全完了（b1..b4, minutes:30）
    for (const id of ["b1", "b2", "b3", "b4"]) await handler(endBlock(id, 30));
    const res = await handler(getReq("/api/session/resume"));
    // 30は完了==total(4)で除外、60は minutes:30 のイベントを数えないので0 → どちらも出ない
    expect(await res.json()).toEqual({ resumable: [] });
  });

  test("全ブロック完了は resumable に含めない", async () => {
    const { deps } = makeTestDeps({ readMenuCache: (m) => (m === 60 ? menuOf(60, ["b1", "b2", "b3", "b4", "b5"]) : null) });
    const handler = makeFetchHandler(deps);
    for (const id of ["b1", "b2", "b3", "b4", "b5"]) await handler(endBlock(id, 60));
    const res = await handler(getReq("/api/session/resume"));
    expect(await res.json()).toEqual({ resumable: [] });
  });
});
```

先頭で `getReq` が未 import の場合は import に足す。既存の http ヘルパ import 行を次に置き換える。

```ts
import { postJson, getReq } from "./helpers/http";
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd app && bun test server/__tests__/routes-session.test.ts`
Expected: FAIL（`/api/session/resume` が 404、かつ `readMenuCache` が `RouteDeps` に無く型エラー）

- [ ] **Step 3: `SessionRoutesDeps` 拡張とハンドラを実装する**

`app/server/routes/session.ts` を編集する。まず import を差し替える。

先頭の

```ts
import { appendEvent } from "../session-log";
import { json, parseJsonBody, exact, type RouteEntry } from "./http";
```

を次に置き換える。

```ts
import { appendEvent, completedDailyBlockIds, readEvents, type SessionEvent } from "../session-log";
import type { Menu } from "../menu";
import { json, parseJsonBody, exact, type RouteEntry } from "./http";
```

`SessionRoutesDeps` 型を次に置き換える。

```ts
export type SessionRoutesDeps = {
  logFile: () => string;
  /** 当日のメニューキャッシュを構築せず読むだけ（再開位置の total と blockId 順序に使う） */
  readMenuCache: (minutes: 60 | 30) => Menu | null;
};
```

`makeSessionRoutes` の直前（`handleSessionEnd` の後）に、再開の純ロジックとハンドラを追加する。

```ts
type DailyMinutes = 60 | 30;
const DAILY_MINUTES: readonly DailyMinutes[] = [60, 30];

/**
 * メニュー先頭から「完了済みブロックが連続する数」を返す。
 * 進行は「次のブロックへ」一択で必ず順番に完了するため、完了ブロックは常に先頭からの連続前置。
 * 0 < completed < total（着手済みかつ未完了）のときだけ再開対象として返す。
 */
function resumeInfoFor(
  events: SessionEvent[], menu: Menu, minutes: DailyMinutes,
): { minutes: DailyMinutes; completed: number; total: number } | null {
  const done = completedDailyBlockIds(events, minutes);
  const total = menu.blocks.length;
  let completed = 0;
  for (const b of menu.blocks) {
    if (!done.has(b.id)) break;
    completed++;
  }
  return completed > 0 && completed < total ? { minutes, completed, total } : null;
}

function handleSessionResume(deps: SessionRoutesDeps): Response {
  const events = readEvents(deps.logFile());
  const resumable: Array<{ minutes: DailyMinutes; completed: number; total: number }> = [];
  for (const minutes of DAILY_MINUTES) {
    const menu = deps.readMenuCache(minutes);
    if (!menu) continue;
    const info = resumeInfoFor(events, menu, minutes);
    if (info) resumable.push(info);
  }
  return json({ resumable });
}
```

`makeSessionRoutes` のエントリ配列に1行足す。

```ts
export function makeSessionRoutes(deps: SessionRoutesDeps): RouteEntry[] {
  return [
    exact("POST", "/api/session/start", (req) => handleSessionStart(req, deps)),
    exact("POST", "/api/session/end", (req) => handleSessionEnd(req, deps)),
    exact("POST", "/api/session/event", (req) => handleSessionEvent(req, deps)),
    exact("GET", "/api/session/resume", () => handleSessionResume(deps)),
  ];
}
```

- [ ] **Step 4: フェイク deps に `readMenuCache` を追加する**

`app/server/__tests__/helpers/route-deps.ts` の `makeTestDeps` 内 deps オブジェクトに1行足す。`logFile: () => logFile,` の直後に置く。

```ts
    logFile: () => logFile,
    readMenuCache: (_minutes) => null,
```

（既定は `null` ＝ 再開対象なし。resume テストは `makeTestDeps({ readMenuCache: ... })` で上書きする。`type Menu` は同ファイルで import 済み。）

- [ ] **Step 5: 実 deps に `readMenuCache` を配線する**

`app/server/index.ts` を編集する。import 行

```ts
import { buildQuickMenu, buildTodayMenu, invalidateTodayMenuCache } from "./menu";
```

を次に置き換える。

```ts
import { buildQuickMenu, buildTodayMenu, invalidateTodayMenuCache, readTodayMenuCache } from "./menu";
```

`realDeps` の `logFile: () => sessionLogPath(new Date()),` の直後に1行足す。

```ts
  logFile: () => sessionLogPath(new Date()),
  readMenuCache: (minutes) => readTodayMenuCache(minutes),
```

- [ ] **Step 6: テストと型チェックを実行して通過を確認する**

Run: `cd app && bun test server/__tests__/routes-session.test.ts && bun run typecheck`
Expected: PASS（resume の5テスト green）＋ typecheck エラーなし

- [ ] **Step 7: コミット**

```bash
git add app/server/routes/session.ts app/server/index.ts app/server/__tests__/helpers/route-deps.ts app/server/__tests__/routes-session.test.ts
git commit -m "feat: GET /api/session/resume で当日ログから再開可能セッションを返す"
```

---

## Task 4: クライアント純関数 `resumeStartIndex`

`SessionRunner` が受け取る `startIndex` を安全にクランプする純関数。React コンポーネントから唯一の非自明ロジックを切り出してテストする（リポジトリの慣習: 純ロジックは別モジュールでテスト）。

**Files:**
- Create: `app/client/src/screens/resume.ts`
- Test: `app/client/src/screens/resume.test.ts`

**Interfaces:**
- Produces: `resumeStartIndex(startIndex: number | undefined, blocksLength: number): number`（`undefined`→0、範囲 `[0, blocksLength-1]` にクランプ）

- [ ] **Step 1: 失敗するテストを書く**

`app/client/src/screens/resume.test.ts` を新規作成する。

```ts
import { describe, expect, test } from "bun:test";
import { resumeStartIndex } from "./resume";

describe("resumeStartIndex", () => {
  test("undefined は 0（＝最初から）", () => {
    expect(resumeStartIndex(undefined, 5)).toBe(0);
  });

  test("範囲内の startIndex はそのまま", () => {
    expect(resumeStartIndex(2, 5)).toBe(2);
  });

  test("blocksLength 以上は末尾ブロックにクランプ", () => {
    expect(resumeStartIndex(9, 5)).toBe(4);
  });

  test("負値は 0 にクランプ", () => {
    expect(resumeStartIndex(-3, 5)).toBe(0);
  });

  test("blocksLength が 0 でも負にならない", () => {
    expect(resumeStartIndex(3, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd app && bun test client/src/screens/resume.test.ts`
Expected: FAIL（`Cannot find module './resume'`）

- [ ] **Step 3: 最小実装を書く**

`app/client/src/screens/resume.ts` を新規作成する。

```ts
/**
 * 再開開始インデックスを安全域にクランプする。
 * startIndex 未指定（quick ドリルや通常開始）は 0。
 * 範囲は [0, blocksLength-1]（サーバ側で 0 < completed < total を保証するが、
 * メニュー再構築などでブロック数が変わった場合の防御としてもクランプする）。
 */
export function resumeStartIndex(startIndex: number | undefined, blocksLength: number): number {
  if (startIndex == null) return 0;
  const max = Math.max(0, blocksLength - 1);
  return Math.min(Math.max(0, startIndex), max);
}
```

- [ ] **Step 4: テストを実行して通過を確認する**

Run: `cd app && bun test client/src/screens/resume.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/client/src/screens/resume.ts app/client/src/screens/resume.test.ts
git commit -m "feat: 再開開始インデックスをクランプする resumeStartIndex を追加"
```

---

## Task 5: クライアント API `fetchResumable`

`GET /api/session/resume` を呼ぶクライアント関数と型。セッション系関数が集約されている `api/converse.ts` に置く（barrel が再公開する）。

**Files:**
- Modify: `app/client/src/api/converse.ts`（末尾に追加）
- Test: `app/client/src/api/converse.test.ts`（新規）

**Interfaces:**
- Consumes: Task 3 の `GET /api/session/resume` レスポンス `{ resumable: ResumeInfo[] }`、既存 `extractErrorMessage`（`./http`・import 済み）。
- Produces:
  - `export type ResumeInfo = { minutes: 60 | 30; completed: number; total: number }`
  - `export async function fetchResumable(): Promise<ResumeInfo[]>`

- [ ] **Step 1: 失敗するテストを書く**

`app/client/src/api/converse.test.ts` を新規作成する（`progress.test.ts` の fetch スタブ様式に合わせる）。

```ts
import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchResumable, type ResumeInfo } from "./converse";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(body: unknown, status = 200): void {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
}

describe("fetchResumable", () => {
  test("resumable 配列を取り出して返す", async () => {
    const info: ResumeInfo[] = [{ minutes: 60, completed: 2, total: 5 }];
    stubFetch({ resumable: info });
    expect(await fetchResumable()).toEqual(info);
  });

  test("空配列も素直に返す", async () => {
    stubFetch({ resumable: [] });
    expect(await fetchResumable()).toEqual([]);
  });

  test("非 ok レスポンスは throw する", async () => {
    stubFetch({ error: "boom" }, 500);
    await expect(fetchResumable()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd app && bun test client/src/api/converse.test.ts`
Expected: FAIL（`fetchResumable` が export されていない）

- [ ] **Step 3: 最小実装を書く**

`app/client/src/api/converse.ts` の末尾（`sendSessionEvent` の後）に追加する。import 追加は不要（`extractErrorMessage` は先頭で import 済み）。

```ts
export type ResumeInfo = { minutes: 60 | 30; completed: number; total: number };

/**
 * 当日の強化セッションで着手済みかつ未完了のものを返す（情報的な再開導線用）。
 * 対象は当日ログ由来のみで、翌日は自然に空になる。
 */
export async function fetchResumable(): Promise<ResumeInfo[]> {
  const res = await fetch("/api/session/resume");
  if (!res.ok) throw new Error(`resume failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { resumable: ResumeInfo[] }).resumable;
}
```

- [ ] **Step 4: テストを実行して通過を確認する**

Run: `cd app && bun test client/src/api/converse.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/client/src/api/converse.ts app/client/src/api/converse.test.ts
git commit -m "feat: 再開情報を取得する fetchResumable クライアントAPIを追加"
```

---

## Task 6: `SessionRunner` を再開対応にする（minutes 付与＋開始インデックス）

daily のブロックイベント `meta` に `minutes` を付け（再開判別子）、`startIndex` を受け取って途中のブロックから開始する。開始前のブロックには一切イベント/XP を送らない（既に前セッションで完了・XP付与済み）。

**Files:**
- Modify: `app/client/src/screens/SessionRunner.tsx`
- 検証: `cd app/client && bun run build`（tsc --noEmit + vite build）。React コンポーネントの自動テストはリポジトリ慣習上持たない（純ロジックは Task 4 で担保済み）。

**Interfaces:**
- Consumes: `resumeStartIndex`（Task 4）。
- Produces: `MenuSource` の daily バリアントに `startIndex?: number` を追加（`StartScreen`・`App` が経由する）。`App.tsx` は `source` をそのまま渡すため変更不要。

- [ ] **Step 1: `MenuSource` に `startIndex?` を追加する**

`app/client/src/screens/SessionRunner.tsx` の型定義を置き換える。

```ts
export type MenuSource =
  | { type: "daily"; minutes: 60 | 30 }
  | { type: "quick"; drill: QuickDrillKind; domain?: RoleplayDomain };
```

を次に置き換える。

```ts
export type MenuSource =
  | { type: "daily"; minutes: 60 | 30; startIndex?: number }
  | { type: "quick"; drill: QuickDrillKind; domain?: RoleplayDomain };
```

- [ ] **Step 2: `resumeStartIndex` を import し、`menuMinutes` を用意する**

import 群（`import { blockTitle } from "./blockTitle";` の下）に追加する。

```ts
import { resumeStartIndex } from "./resume";
```

`openBlockRef` の型を `minutes` 込みに広げ、`menuMinutes` を関数コンポーネント本体先頭（`const t = STR[props.lang].session;` の直後）で計算する。

現在の

```ts
  const openBlockRef = useRef<{ id: string; kind: string } | null>(null);
```

を次に置き換える。

```ts
  // daily のブロックには minutes を持たせ、当日ログから 30分版/60分版を判別して再開位置を復元できるようにする
  const openBlockRef = useRef<{ id: string; kind: string; minutes?: number } | null>(null);
```

`const t = STR[props.lang].session;` の直後に追加する。

```ts
  const t = STR[props.lang].session;
  // daily セッションのみ minutes をイベントに刻む（quick は単一ブロックで再開対象外 → undefined）
  const menuMinutes = props.source.type === "daily" ? props.source.minutes : undefined;
```

- [ ] **Step 3: `loadMenu` を開始インデックス対応にする**

現在の `loadMenu` 内 `.then((m) => { ... })` ブロックを置き換える。

```ts
      .then((m) => {
        setMenu(m);
        const first = m.blocks[0];
        timer.reset(first.minutes * 60);
        timer.start();
        openBlockRef.current = { id: first.id, kind: first.kind };
        sendSessionEvent("block_start", props.sessionId, { blockId: first.id, kind: first.kind });
        beginAttempt(first.kind);
      })
```

を次に置き換える。

```ts
      .then((m) => {
        setMenu(m);
        const start = resumeStartIndex(
          props.source.type === "daily" ? props.source.startIndex : undefined,
          m.blocks.length,
        );
        setIndex(start);
        const first = m.blocks[start];
        timer.reset(first.minutes * 60);
        timer.start();
        openBlockRef.current = { id: first.id, kind: first.kind, minutes: menuMinutes };
        sendSessionEvent("block_start", props.sessionId, { blockId: first.id, kind: first.kind, minutes: menuMinutes });
        beginAttempt(first.kind);
      })
```

- [ ] **Step 4: アンマウント時の `block_end(aborted)` に minutes を載せる**

現在のアンマウント effect 内

```ts
        sendSessionEvent("block_end", props.sessionId, { blockId: open.id, kind: open.kind, aborted: true });
```

を次に置き換える。

```ts
        sendSessionEvent("block_end", props.sessionId, { blockId: open.id, kind: open.kind, minutes: open.minutes, aborted: true });
```

- [ ] **Step 5: `nextBlock` の block_end / block_start / openBlockRef に minutes を載せる**

現在の `nextBlock` 関数を置き換える。

```ts
  function nextBlock() {
    if (advancingRef.current) return;
    advancingRef.current = true;
    sendSessionEvent("block_end", props.sessionId, { blockId: block.id, kind: block.kind });
    progressBlockXp(block.minutes, attemptIdRef.current)
      .catch((err) => console.warn("xp post failed:", err));
    openBlockRef.current = null;
    if (isLast) {
      props.onExit();
      return;
    }
    const next = menu!.blocks[index + 1];
    setIndex(index + 1);
    timer.reset(next.minutes * 60);
    timer.start();
    openBlockRef.current = { id: next.id, kind: next.kind };
    sendSessionEvent("block_start", props.sessionId, { blockId: next.id, kind: next.kind });
    beginAttempt(next.kind);
    advancingRef.current = false;
  }
```

を次に置き換える。

```ts
  function nextBlock() {
    if (advancingRef.current) return;
    advancingRef.current = true;
    sendSessionEvent("block_end", props.sessionId, { blockId: block.id, kind: block.kind, minutes: menuMinutes });
    progressBlockXp(block.minutes, attemptIdRef.current)
      .catch((err) => console.warn("xp post failed:", err));
    openBlockRef.current = null;
    if (isLast) {
      props.onExit();
      return;
    }
    const next = menu!.blocks[index + 1];
    setIndex(index + 1);
    timer.reset(next.minutes * 60);
    timer.start();
    openBlockRef.current = { id: next.id, kind: next.kind, minutes: menuMinutes };
    sendSessionEvent("block_start", props.sessionId, { blockId: next.id, kind: next.kind, minutes: menuMinutes });
    beginAttempt(next.kind);
    advancingRef.current = false;
  }
```

- [ ] **Step 6: 型チェック・ビルドを実行して通過を確認する**

Run: `cd app/client && bun run build`
Expected: PASS（tsc --noEmit エラーなし・vite build 成功）。`MenuSource` 変更後も `App.tsx`・`StartScreen.tsx` は `source` を素通ししているだけなので既存箇所は型エラーにならない。

- [ ] **Step 7: コミット**

```bash
git add app/client/src/screens/SessionRunner.tsx
git commit -m "feat: SessionRunner が minutes を刻み startIndex から再開できるようにする"
```

---

## Task 7: `StartScreen` に再開 callout を出す（＋i18n）

起動時に `fetchResumable()` を呼び、再開可能な強化セッションがあれば中立な callout を強化セッションの直前に出す。押すと途中のブロックから再開。押さなければ従来の 60/30 カードが最初から始める。

**Files:**
- Modify: `app/client/src/i18n.ts`（`ResumeStrings` 型＋EN/JA の `resume`）
- Modify: `app/client/src/screens/StartScreen.tsx`（fetch・状態・callout 描画・コンポーネント）
- 検証: `cd app/client && bun run build`

**Interfaces:**
- Consumes: `fetchResumable`・`ResumeInfo`（Task 5）、`MenuSource.startIndex`（Task 6）、`STR[lang].resume`（本タスクで追加）。
- Produces: 情報的な `ResumeCallout`。押下で `onSelect({ type: "session", source: { type: "daily", minutes, startIndex: completed } })`。

- [ ] **Step 1: i18n に `ResumeStrings` 型を追加する**

`app/client/src/i18n.ts` の `IntensiveStrings` 型定義の直後に追加する。

```ts
type IntensiveStrings = { intensive: { label: string; note: string } };
```

の直後に、

```ts
type ResumeStrings = {
  resume: {
    title: (minutes: number) => string;
    body: (nextBlock: number, total: number) => string;
  };
};
```

`Strings` の交差に `ResumeStrings` を足す。現在の

```ts
type Strings =
  & NavStrings & UiScaleStrings & AppShellStrings & SupportStrings & StatStrings & HeroStrings
  & QuickStrings & IntensiveStrings & DrillsStrings & SessionCardStrings
  & CalendarStrings & FreeTalkHeaderStrings & ProgressStrings & PlacementStrings & SentencesStrings
  & MenuTitleStrings & SessionStrings
  & WarmupStrings & Ftt432Strings & ReflectionStrings & ChunkListStrings
  & ShadowingStrings & LibraryStrings & RoleplayStrings & FreeTalkScreenStrings & ListeningScreenStrings;
```

を次に置き換える（`& IntensiveStrings` の直後に `& ResumeStrings` を挿入）。

```ts
type Strings =
  & NavStrings & UiScaleStrings & AppShellStrings & SupportStrings & StatStrings & HeroStrings
  & QuickStrings & IntensiveStrings & ResumeStrings & DrillsStrings & SessionCardStrings
  & CalendarStrings & FreeTalkHeaderStrings & ProgressStrings & PlacementStrings & SentencesStrings
  & MenuTitleStrings & SessionStrings
  & WarmupStrings & Ftt432Strings & ReflectionStrings & ChunkListStrings
  & ShadowingStrings & LibraryStrings & RoleplayStrings & FreeTalkScreenStrings & ListeningScreenStrings;
```

- [ ] **Step 2: EN/JA に `resume` 文言を追加する**

EN 側、`intensive: { label: "Intensive sessions", note: "1–2 times a week" },` の直後に追加する。

```ts
    intensive: { label: "Intensive sessions", note: "1–2 times a week" },
    resume: {
      title: (minutes) => `Continue your ${minutes}-min session`,
      body: (nextBlock, total) => `You left off at block ${nextBlock} of ${total}. Pick up here, or just start fresh below — either is fine.`,
    },
```

JA 側、`intensive: { label: "強化セッション", note: "週1〜2回おすすめ" },` の直後に追加する。

```ts
    intensive: { label: "強化セッション", note: "週1〜2回おすすめ" },
    resume: {
      title: (minutes) => `${minutes}分セッションの続きから`,
      body: (nextBlock, total) => `ブロック ${nextBlock}/${total} の途中です。ここから再開できます（下のカードから最初に戻っても構いません）。`,
    },
```

（トーンは中立・非強制。`nextBlock` は「次にやるブロック番号」＝ `completed + 1`。督促語は使わない。）

- [ ] **Step 3: `StartScreen` で再開情報を取得する**

`app/client/src/screens/StartScreen.tsx` の import に `fetchResumable` と `type ResumeInfo` を足す。先頭の api import ブロックを置き換える。

現在の

```ts
import {
  fetchPlacementLatest, fetchPracticeDays, fetchProgressSummary, progressLevelAction,
  type LevelProposal, type PlacementLatest, type ProgressSummary, type QuickDrillKind, type RoleplayDomain,
} from "../api";
```

を次に置き換える。

```ts
import {
  fetchPlacementLatest, fetchPracticeDays, fetchProgressSummary, fetchResumable, progressLevelAction,
  type LevelProposal, type PlacementLatest, type ProgressSummary, type QuickDrillKind, type RoleplayDomain, type ResumeInfo,
} from "../api";
```

`StartScreen` 関数内、`const [placementLatest, setPlacementLatest] = useState<PlacementLatest | "unloaded">("unloaded");` の直後に状態を追加する。

```ts
  const [placementLatest, setPlacementLatest] = useState<PlacementLatest | "unloaded">("unloaded");
  const [resumable, setResumable] = useState<ResumeInfo[]>([]);
```

mount effect の並列 fetch に1本足す。現在の

```ts
      fetchPracticeDays().then((d) => { if (aliveRef.current) setDays(d); }).catch(() => {});
      fetchProgressSummary().then((s) => { if (aliveRef.current) setSummary(s); }).catch(() => {});
      fetchPlacementLatest().then((r) => { if (aliveRef.current) setPlacementLatest(r); }).catch(() => {});
```

を次に置き換える。

```ts
      fetchPracticeDays().then((d) => { if (aliveRef.current) setDays(d); }).catch(() => {});
      fetchProgressSummary().then((s) => { if (aliveRef.current) setSummary(s); }).catch(() => {});
      fetchPlacementLatest().then((r) => { if (aliveRef.current) setPlacementLatest(r); }).catch(() => {});
      // 再開導線は補助情報 — 取得失敗でスタート画面を壊さない
      fetchResumable().then((r) => { if (aliveRef.current) setResumable(r); }).catch(() => {});
```

- [ ] **Step 4: 再開 callout を強化セッションの直前に描画する**

`StartScreen` の return 内、強化セッションのセクション（`<p className="section-label">{t.intensive.label} ...`）を含む `<div>` の直前に callout を挿入する。

現在の

```tsx
      <div>
        <p className="section-label">{t.intensive.label} <span className="section-note">{t.intensive.note}</span></p>
        <div className="drill-grid">
          {/* 負荷の軽い順（クイックドリル→30分→60分の流れに合わせる） */}
```

を次に置き換える（`{resumable.map(...)}` を intensive セクション `<div>` の直前に足す）。

```tsx
      {resumable.map((info) => (
        <ResumeCallout
          key={info.minutes}
          info={info}
          tr={t.resume}
          onGo={() => props.onSelect({ type: "session", source: { type: "daily", minutes: info.minutes, startIndex: info.completed } })}
        />
      ))}

      <div>
        <p className="section-label">{t.intensive.label} <span className="section-note">{t.intensive.note}</span></p>
        <div className="drill-grid">
          {/* 負荷の軽い順（クイックドリル→30分→60分の流れに合わせる） */}
```

- [ ] **Step 5: `ResumeCallout` コンポーネントを追加する**

`StartScreen.tsx` の `PlacementCallout` 関数定義の直前（または `ProposalCard` の後・ファイル末尾でも可）に追加する。レイアウトは既存の `placement-callout` クラス群を再利用し CSS 追加を避ける（汎用の callout ボタンスタイル）。

```tsx
/** 中断した強化セッションの再開導線（情報的・非強制。押さなければ通常カードが最初から始まる） */
function ResumeCallout(props: {
  info: ResumeInfo;
  tr: (typeof STR)["en"]["resume"];
  onGo: () => void;
}) {
  const { info, tr } = props;
  return (
    <button className="placement-callout" onClick={props.onGo}>
      <span className="placement-callout-icon" aria-hidden="true">↩</span>
      <span className="drill-body">
        <span className="drill-title">{tr.title(info.minutes)}</span>
        <span className="drill-desc">{tr.body(info.completed + 1, info.total)}</span>
      </span>
      <span className="drill-arrow" aria-hidden="true">→</span>
    </button>
  );
}
```

（`info.completed + 1` ＝ 次にやるブロック番号。例: 2完了/全5 → 「ブロック 3/5 の途中です」。）

- [ ] **Step 6: 型チェック・ビルドを実行して通過を確認する**

Run: `cd app/client && bun run build`
Expected: PASS（EN/JA 両方に `resume` があるので `Strings` 型が満たされる。片方欠落ならここで型エラーになる）

- [ ] **Step 7: コミット**

```bash
git add app/client/src/i18n.ts app/client/src/screens/StartScreen.tsx
git commit -m "feat: スタート画面に中断セッションの再開導線を追加"
```

---

## Final Verification（全体ゲート＋手動スモーク）

- [ ] **Step 1: サーバ＋クライアントの全テストを実行**

Run: `cd app && bun test`
Expected: PASS（既存 + 追加分すべて green）

- [ ] **Step 2: サーバ型チェック**

Run: `cd app && bun run typecheck`
Expected: エラーなし

- [ ] **Step 3: クライアント型チェック＋ビルド**

Run: `cd app/client && bun run build`
Expected: 成功

- [ ] **Step 4: 手動スモーク（React 挙動は自動テストが無いため必須）**

`cd app && bun run dev` でサーバを起動し、クライアントを開いて確認する。

1. ホームから「60分（通しセッション）」を開始し、ブロック1・2を「次のブロックへ」で完了する（ブロック3が表示される状態にする）。
2. ブラウザをリロードする（＝ハードリロードで `useState` の index が消える状況を再現）。
3. スタート画面に「60分セッションの続きから — ブロック 3/5 の途中です」の callout が出ることを確認する。
4. callout を押すと、ブロック1・2をやり直さずブロック3から始まることを確認する（`ProgressDots` が 3/5 相当、タイマーがブロック3の分数）。
5. 代わりに通常の「60分」カードを押すと、従来どおりブロック1から始まる（＝再開は強制ではない）ことを確認する。
6. 60分を最後まで完了して再度スタート画面に戻ると、再開 callout が出ないことを確認する（完了==total は除外）。
7. サイドバーの XP ゲージが、再開時にブロック1・2の XP を二重加算していないことを確認する（再開後に増えるのはブロック3以降の完了分のみ）。

期待結果すべてを満たせば完了。満たさない項目があれば `superpowers:systematic-debugging` で原因を切り分ける。

---

## Self-Review（spec との突き合わせ）

**1. Spec coverage（C3 / Major-5）**
- C3「当日 block_end から『続きから（ブロック3/5）』を情報提示」→ Task 1（完了ブロック集合）+ Task 3（再開ルート）+ Task 7（中立 callout）。✓
- Major-5「中断＝全損」の中核（リロードで最初から）→ Task 3 の当日ログ復元 + Task 6 の startIndex 再開で解消。✓
- 「押さなければ最初から・強制しない」→ Task 7 は callout を追加するのみで既存 60/30 カード（startIndex なし＝0）を変えない。✓
- 「当日内のみで十分」→ Task 3 は `logFile()`（当日 `<ymd>.jsonl`）のみ読む。✓
- Major-5 の「スキップ連打で XP・統計汚染」(B3) は**本計画のスコープ外**（Global Constraints に明記）。現行 UI にスキップ導線は無く、C3 とは別項目。✓（意図的な非カバー）

**2. Placeholder scan**
- すべてのコードステップに実コードを記載。TBD / "適切に" / "同様に" などのプレースホルダなし。テストコードは実アサーション付きで記載。✓

**3. Type consistency**
- `completedDailyBlockIds(events, minutes): Set<string>`（Task 1 定義 → Task 3 使用）一致。✓
- `readTodayMenuCache(minutes, deps): Menu | null`（Task 2 定義 → Task 3 index.ts 使用 `readMenuCache: (minutes) => readTodayMenuCache(minutes)`）一致。✓
- `SessionRoutesDeps.readMenuCache: (minutes: 60|30) => Menu | null`（Task 3 定義 → route-deps.ts / index.ts で提供）一致。✓
- `ResumeInfo = { minutes: 60|30; completed; total }`（Task 3 レスポンス ↔ Task 5 型 ↔ Task 7 使用）一致。サーバは `{minutes, completed, total}` を返し、クライアント型も同一。✓
- `resumeStartIndex(startIndex: number | undefined, blocksLength: number)`（Task 4 定義 → Task 6 使用）一致。✓
- `MenuSource` daily に `startIndex?`（Task 6 定義 → Task 7 で設定・`App.tsx` は素通し）一致。✓
- i18n `resume.title(minutes)` / `resume.body(nextBlock, total)`（Task 7 型 ↔ EN/JA 実体 ↔ `ResumeCallout` 呼び出し `tr.body(info.completed + 1, info.total)`）一致。✓

**残リスク・前提**
- メニューが当日中に再構築された場合（明示的レベル変更 → `invalidateTodayMenuCache`）、`block_end` の blockId（`b1`..`bN` は位置ベースで内容非依存）は有効なままだが、再開先ブロックの内容は新レベルのものになる。ブロック数（60→5 / 30→4）はレベルで変わらないため位置は常に妥当。低頻度・許容とし、`resumeStartIndex` のクランプで防御済み。
- `block_start` はハードリロードで `block_end` を伴わず宙に浮くが、完了判定は非aborted `block_end` のみを数えるため、宙に浮いた `block_start` は「そのブロックは未完了 → そこから再開」に正しく落ちる。
- fire-and-forget な `block_end` 送信が失敗した場合、そのブロックは「未完了」として再開対象に残る（再度そのブロックからやり直し）。XP は非aborted 完了時にのみ付くため、二重加算にはならない（保守的側に倒れる）。
