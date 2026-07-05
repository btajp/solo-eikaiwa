# クイックドリル導線 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 5〜10分で完結する単品ドリル（音読ウォームアップ/4/3/2ミニ/ロールプレイ/シャドーイング）を日次のデフォルト導線にし、60/30分は「強化セッション」に再定義。スタート画面に練習日カレンダー（情報表示のみ）と if-then アンカー1行を追加する。

**Architecture:** サーバは `menu.ts` に `buildQuickMenu(kind)`（既存の pickNext/markUsed ローテーションを共有する1ブロックメニュー、キャッシュなし）、`settings.ts`（アンカー永続化）、`session-log.ts` に練習日一覧を追加し、`routes.ts` の RouteDeps を additive に拡張（`GET /api/menu/quick`・`GET /api/progress/days`・`GET|PUT /api/settings`）。クライアントは StartScreen を再構成し、SessionRunner のメニュー取得を `source` prop（daily / quick）で分岐。FourThreeTwoScreen は可変長 roundsSec（2ラウンド版 `[120, 90]`）対応にする。

**Tech Stack:** 既存と同一（Bun + TypeScript / React + Vite）。新規依存なし。

## Global Constraints

- 127.0.0.1:3111 / Claude は Agent SDK 注入パターン / データはリポジトリ内プレーンファイル
- **additive only**: 既存103テスト・既存HTTP契約は不変（StartScreen/App/SessionRunner の内部 prop・文言変更は sanctioned。`Menu.minutes` の型は `60 | 30` → `number` に広げる = 受け入れ側互換の widening で、クライアント型は既に `number`）
- **ゲーミフィケーションは情報的フィードバックのみ**: バッジ・ポイント・連続日数の喪失演出・比較要素を実装しない（第3弾リサーチの検証済み設計制約）。カレンダーは実施日ドットの表示だけ
- アンカーは1行のみ・詳細化させない（if-then 形式の実証設計則: 詳細化で効果半減）
- Conventional Commits（日本語可）
- ゲート: `cd app && bun test`・`bun run typecheck`・`cd app/client && bun run build`

## 実コード確認結果（Task 2 の前提）

`FourThreeTwoScreen.tsx` は現在 **roundsSec.length === 3 固定**（検証・transcripts 初期値 `["", "", ""]`・完了文言「3回」・LISTENERS 直接添字）。2ラウンド `[120, 90]` を渡すと検証で弾かれ 3 ラウンドにフォールバックしてしまうため、Task 2 で可変長対応（下記 Step 5）が必須。AE は `roundIndex === 0` の後・最終ラウンド判定は `roundIndex < roundsSec.length - 1` で既に長さ駆動なので、変更はスコープ最小で済む。

---

### Task 1: サーバ — クイックメニュー・練習日・設定API

**Files:**
- Modify: `app/server/menu.ts`（Menu型 widening・usage ヘルパー抽出・buildQuickMenu 追加）
- Create: `app/server/settings.ts`
- Modify: `app/server/session-log.ts`（listPracticeDays 追加）
- Modify: `app/server/routes.ts`（RouteDeps 4フィールド・3ルート追加、PUT メソッド対応）
- Modify: `app/server/index.ts`（実 deps 配線）
- Test: `app/server/__tests__/menu.test.ts`・`app/server/__tests__/settings.test.ts`（新規）・`app/server/__tests__/session-log.test.ts`・`app/server/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `menu.ts` の既存 `pickNext/markUsed/loadContent/readJsonSafe`、`paths.ts` の `SESSIONS_DIR/PROGRESS_DIR`
- Produces（Task 2 が依存）:
  - `menu.ts`: `type QuickKind = "warmup" | "ftt-mini" | "roleplay" | "shadowing"` / `QUICK_KINDS: readonly QuickKind[]` / `FTT_MINI_ROUNDS_SEC: readonly number[] = [120, 90]` / `buildQuickMenu(kind: QuickKind, deps?: MenuDeps): Menu`（1ブロック・キャッシュなし・usage共有）/ `Menu.minutes: number`
  - `settings.ts`: `type Settings = { anchor: string }` / `readSettings(file?): Settings` / `writeSettings(s: Settings, file?): void`
  - `session-log.ts`: `listPracticeDays(dir?: string): string[]`（YYYY-MM-DD 昇順）
  - HTTP: `GET /api/menu/quick?kind=<QuickKind>` → Menu（400 invalid kind） / `GET /api/progress/days` → `{days: string[]}` / `GET /api/settings` → `{anchor}` / `PUT /api/settings {anchor}` → `{ok:true}`（400: anchor が string でない・201字以上）
  - `RouteDeps` 追加必須フィールド: `buildQuick: (kind: QuickKind) => Menu` / `practiceDays: () => string[]` / `getSettings: () => Settings` / `saveSettings: (s: Settings) => void`

- [ ] **Step 1: menu の失敗するテストを書く**

`app/server/__tests__/menu.test.ts` の import に `buildQuickMenu, FTT_MINI_ROUNDS_SEC, QUICK_KINDS, type QuickKind` を追加し、末尾に追記:

```ts
describe("buildQuickMenu", () => {
  test("warmup: 1ブロック・6分・topic埋め込み・usage記録", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5 };
    const m = buildQuickMenu("warmup", deps);
    expect(m.minutes).toBe(6);
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0].kind).toBe("warmup-reading");
    expect(m.blocks[0].minutes).toBe(6);
    expect((m.blocks[0].params.topic as { id: string }).id).toBe("t1");
    const usage = JSON.parse(readFileSync(usageFile, "utf8"));
    expect(usage.t1).toEqual(["2026-07-05"]);
  });

  test("ftt-mini: four-three-two・8分・roundsSec=[120,90]", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5 };
    const m = buildQuickMenu("ftt-mini", deps);
    expect(m.minutes).toBe(8);
    expect(m.blocks[0].kind).toBe("four-three-two");
    expect(m.blocks[0].params.roundsSec).toEqual([...FTT_MINI_ROUNDS_SEC]);
    expect(FTT_MINI_ROUNDS_SEC).toEqual([120, 90]);
  });

  test("roleplay: scenario・10分 / shadowing: topic・5分", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5 };
    const r = buildQuickMenu("roleplay", deps);
    expect(r.minutes).toBe(10);
    expect(r.blocks[0].kind).toBe("roleplay");
    expect((r.blocks[0].params.scenario as { id: string }).id).toBe("s1");
    const s = buildQuickMenu("shadowing", deps);
    expect(s.minutes).toBe(5);
    expect(s.blocks[0].kind).toBe("shadowing");
  });

  test("ローテーションを buildTodayMenu と共有する（同日の再実行は次のアイテム）", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5 };
    const first = buildQuickMenu("warmup", deps);
    const second = buildQuickMenu("warmup", deps);
    expect((first.blocks[0].params.topic as { id: string }).id).toBe("t1");
    expect((second.blocks[0].params.topic as { id: string }).id).toBe("t2");
    // キャッシュファイルは作らない
    expect(readdirSync(menuCacheDir).filter((f) => f.startsWith("menu-"))).toHaveLength(0);
  });

  test("QUICK_KINDS は4種", () => {
    expect(QUICK_KINDS).toEqual(["warmup", "ftt-mini", "roleplay", "shadowing"]);
  });
});
```

`readdirSync` を `node:fs` の import に追加（既存 import 行に足す）。

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/menu.test.ts`
Expected: FAIL（`buildQuickMenu` 等が export されていない）

- [ ] **Step 3: menu.ts を実装**

`app/server/menu.ts` に以下の変更:

(a) `Menu` 型の widening（8行目）:

```ts
export type Menu = { minutes: number; date: string; blocks: MenuBlock[] };
```

（`buildTodayMenu(minutes: 60 | 30, ...)` の引数型は不変。）

(b) `FTT_ROUNDS_SEC` の直後に追加:

```ts
/** クイックドリル（4/3/2ミニ）のラウンド秒数。2ラウンドで反復メカニズムを保ちつつ短縮 */
export const FTT_MINI_ROUNDS_SEC: readonly number[] = [120, 90];

export type QuickKind = "warmup" | "ftt-mini" | "roleplay" | "shadowing";
export const QUICK_KINDS: readonly QuickKind[] = ["warmup", "ftt-mini", "roleplay", "shadowing"];
```

(c) usage の読み書きをヘルパーに抽出（`readJsonSafe` の直後に追加し、`buildTodayMenu` 内の該当2箇所を置き換える）:

```ts
function loadUsage(usageFile: string): UsageMap {
  return readJsonSafe<UsageMap>(usageFile) ?? {};
}

function saveUsage(usageFile: string, usage: UsageMap): void {
  mkdirSync(path.dirname(usageFile), { recursive: true });
  writeFileSync(usageFile, JSON.stringify(usage, null, 2));
}
```

`buildTodayMenu` 内:
- `const usage: UsageMap = readJsonSafe<UsageMap>(usageFile) ?? {};` → `const usage = loadUsage(usageFile);`
- `mkdirSync(path.dirname(usageFile), { recursive: true }); writeFileSync(usageFile, JSON.stringify(usage, null, 2));` → `saveUsage(usageFile, usage);`

(d) ファイル末尾に `buildQuickMenu` を追加:

```ts
/**
 * 5〜10分の単品ドリルメニュー。日次のデフォルト導線（第3弾リサーチ: 総時間より頻度・完了数が効く）。
 * トピック/シナリオのローテーションと使用記録は buildTodayMenu と共有する。
 * 通しメニューと違いキャッシュしない（同日の再実行は次のアイテムが出る＝意図どおり）。
 */
export function buildQuickMenu(kind: QuickKind, deps: MenuDeps = {}): Menu {
  const topicsDir = deps.topicsDir ?? TOPICS_DIR;
  const scenariosDir = deps.scenariosDir ?? SCENARIOS_DIR;
  const usageFile = deps.usageFile ?? path.join(PROGRESS_DIR, "topic-usage.json");
  const ymd = (deps.today ?? (() => new Date()))().toISOString().slice(0, 10);
  const usage = loadUsage(usageFile);

  let block: MenuBlock;
  if (kind === "roleplay") {
    const scenario = pickNext(loadContent(scenariosDir), usage, ymd);
    markUsed(usage, scenario.id, ymd);
    block = { id: "q1", kind: "roleplay", title: `実務ロールプレイ: ${scenario.title}`, minutes: 10, params: { scenario } };
  } else {
    const topic = pickNext(loadContent(topicsDir), usage, ymd);
    markUsed(usage, topic.id, ymd);
    if (kind === "warmup") {
      block = { id: "q1", kind: "warmup-reading", title: "音読ウォームアップ", minutes: 6, params: { topic } };
    } else if (kind === "ftt-mini") {
      block = {
        id: "q1", kind: "four-three-two", title: `4/3/2ミニ: ${topic.title}`, minutes: 8,
        params: { topic, roundsSec: [...FTT_MINI_ROUNDS_SEC] },
      };
    } else {
      block = { id: "q1", kind: "shadowing", title: `シャドーイング: ${topic.title}`, minutes: 5, params: { topic } };
    }
  }

  saveUsage(usageFile, usage);
  return { minutes: block.minutes, date: ymd, blocks: [block] };
}
```

- [ ] **Step 4: menu テストが通ることを確認**

Run: `cd app && bun test server/__tests__/menu.test.ts`
Expected: PASS（既存含め全件）

- [ ] **Step 5: settings の失敗するテストを書く**

`app/server/__tests__/settings.test.ts`（新規）:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSettings, writeSettings } from "../settings";

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "settings-")), "settings.json");
}

describe("settings", () => {
  test("未作成なら anchor は空文字", () => {
    expect(readSettings(tmpFile())).toEqual({ anchor: "" });
  });

  test("write → read ラウンドトリップ", () => {
    const file = tmpFile();
    writeSettings({ anchor: "朝コーヒーを淹れたら1ドリル" }, file);
    expect(readSettings(file)).toEqual({ anchor: "朝コーヒーを淹れたら1ドリル" });
  });

  test("破損JSONと不正形状はデフォルトにフォールバック", () => {
    const file = tmpFile();
    writeFileSync(file, "{broken");
    expect(readSettings(file)).toEqual({ anchor: "" });
    writeFileSync(file, JSON.stringify({ anchor: 42 }));
    expect(readSettings(file)).toEqual({ anchor: "" });
  });
});
```

- [ ] **Step 6: settings.ts を実装**

`app/server/settings.ts`（新規）:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROGRESS_DIR } from "./paths";

/** ユーザー設定。anchor は if-then 形式の1行（例:「朝コーヒーを淹れたら1ドリル」） */
export type Settings = { anchor: string };

const DEFAULT_SETTINGS: Settings = { anchor: "" };

function defaultFile(): string {
  return path.join(PROGRESS_DIR, "settings.json");
}

/** 存在しない・破損・不正形状はデフォルトにフォールバック（menu.ts の readJsonSafe と同方針） */
export function readSettings(file: string = defaultFile()): Settings {
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Settings>;
    if (typeof parsed?.anchor === "string") return { anchor: parsed.anchor };
  } catch {
    console.warn(`[settings] failed to parse JSON, using defaults: ${file}`);
  }
  return { ...DEFAULT_SETTINGS };
}

export function writeSettings(s: Settings, file: string = defaultFile()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2));
}
```

Run: `cd app && bun test server/__tests__/settings.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 7: listPracticeDays の失敗するテストを書く**

`app/server/__tests__/session-log.test.ts` の import に `listPracticeDays` を追加し、末尾に追記:

```ts
describe("listPracticeDays", () => {
  test("YYYY-MM-DD.jsonl のみを昇順で返す（拡張子なし）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "days-"));
    writeFileSync(path.join(dir, "2026-07-03.jsonl"), "");
    writeFileSync(path.join(dir, "2026-07-01.jsonl"), "");
    writeFileSync(path.join(dir, "notes.txt"), "");
    writeFileSync(path.join(dir, "bad-name.jsonl"), "");
    expect(listPracticeDays(dir)).toEqual(["2026-07-01", "2026-07-03"]);
  });

  test("ディレクトリが無ければ空配列", () => {
    expect(listPracticeDays("/nonexistent/nope")).toEqual([]);
  });
});
```

（`writeFileSync` が未 import なら import 行に追加。）

- [ ] **Step 8: session-log.ts に listPracticeDays を実装**

`app/server/session-log.ts` に追加（import に `readdirSync` と `SESSIONS_DIR` を追加。`SESSIONS_DIR` は `./paths` から）:

```ts
/** 練習を実施した日（セッションログが存在する日）の一覧。カレンダー表示用の情報的フィードバック */
export function listPracticeDays(dir: string = SESSIONS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .map((f) => f.slice(0, -6))
    .sort();
}
```

Run: `cd app && bun test server/__tests__/session-log.test.ts`
Expected: PASS

- [ ] **Step 9: routes の失敗するテストを書く**

`app/server/__tests__/routes.test.ts` — `makeTestDeps` の deps リテラルに（`...overrides` より前に）追加:

```ts
    buildQuick: ((_kind: QuickKind) => FAKE_QUICK_MENU) as RouteDeps["buildQuick"],
    practiceDays: () => ["2026-07-01", "2026-07-03"],
    getSettings: () => ({ anchor: "" }),
    saveSettings: (_s: { anchor: string }) => {},
```

ファイル上部に追加（import に `type QuickKind` を `../menu` から）:

```ts
const FAKE_QUICK_MENU = {
  minutes: 6,
  date: "2026-07-05",
  blocks: [{ id: "q1", kind: "warmup-reading", title: "音読ウォームアップ", minutes: 6, params: {} }],
};
```

末尾に追記:

```ts
describe("routes: quick menu / progress / settings", () => {
  test("GET /api/menu/quick?kind=warmup は200でメニューを返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/menu/quick?kind=warmup"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_QUICK_MENU);
  });

  test("GET /api/menu/quick の不正kindとkind欠落は400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    for (const q of ["?kind=bogus", ""]) {
      const res = await handler(new Request(`http://localhost/api/menu/quick${q}`));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("kind");
    }
  });

  test("GET /api/progress/days は {days} を返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/progress/days"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ days: ["2026-07-01", "2026-07-03"] });
  });

  test("GET /api/settings と PUT /api/settings のラウンドトリップ", async () => {
    let stored = { anchor: "" };
    const { deps } = makeTestDeps({
      getSettings: () => stored,
      saveSettings: (s) => { stored = s; },
    });
    const handler = makeFetchHandler(deps);
    const put = await handler(new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchor: "朝コーヒーを淹れたら1ドリル" }),
    }));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });
    const got = await handler(new Request("http://localhost/api/settings"));
    expect(await got.json()).toEqual({ anchor: "朝コーヒーを淹れたら1ドリル" });
  });

  test("PUT /api/settings は anchor が string でない・200字超・不正JSONで400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const bad1 = await handler(new Request("http://localhost/api/settings", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: 42 }),
    }));
    expect(bad1.status).toBe(400);
    const bad2 = await handler(new Request("http://localhost/api/settings", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "x".repeat(201) }),
    }));
    expect(bad2.status).toBe(400);
    const bad3 = await handler(new Request("http://localhost/api/settings", {
      method: "PUT", headers: { "content-type": "application/json" }, body: "{broken",
    }));
    expect(bad3.status).toBe(400);
  });
});
```

Run: `cd app && bun test server/__tests__/routes.test.ts`
Expected: FAIL（typecheck エラー含む — RouteDeps に新フィールドが無い）

- [ ] **Step 10: routes.ts を実装**

`app/server/routes.ts`:

(a) import に追加: `import { QUICK_KINDS, type Menu, type QuickKind } from "./menu";`（既存の `type Menu` import を統合）と `import type { Settings } from "./settings";`

(b) `RouteDeps` に必須フィールドを追加:

```ts
  buildQuick: (kind: QuickKind) => Menu;
  practiceDays: () => string[];
  getSettings: () => Settings;
  saveSettings: (s: Settings) => void;
```

(c) ハンドラを追加（`handleMenuToday` の直後）:

```ts
function handleMenuQuick(url: URL, deps: RouteDeps): Response {
  const kind = url.searchParams.get("kind") ?? "";
  if (!(QUICK_KINDS as readonly string[]).includes(kind)) {
    return json({ error: `kind must be one of: ${QUICK_KINDS.join(", ")}` }, 400);
  }
  return json(deps.buildQuick(kind as QuickKind));
}

async function handleSettingsPut(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ anchor?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const anchor = parsed.body.anchor;
  if (typeof anchor !== "string" || anchor.length > 200) {
    return json({ error: "anchor must be a string of at most 200 characters" }, 400);
  }
  deps.saveSettings({ anchor });
  return json({ ok: true });
}
```

(d) `makeFetchHandler` のルーティングに追加（`/api/menu/today` の行の直後）:

```ts
      if (req.method === "GET" && url.pathname === "/api/menu/quick") return handleMenuQuick(url, deps);
      if (req.method === "GET" && url.pathname === "/api/progress/days") return json({ days: deps.practiceDays() });
      if (req.method === "GET" && url.pathname === "/api/settings") return json(deps.getSettings());
      if (req.method === "PUT" && url.pathname === "/api/settings") return await handleSettingsPut(req, deps);
```

- [ ] **Step 11: index.ts の実 deps を配線**

`app/server/index.ts`:
- import に追加: `buildQuickMenu`（`./menu`）、`listPracticeDays`（`./session-log`）、`readSettings, writeSettings`（`./settings`）
- `realDeps` に追加:

```ts
  buildQuick: (kind) => buildQuickMenu(kind),
  practiceDays: () => listPracticeDays(),
  getSettings: () => readSettings(),
  saveSettings: (s) => writeSettings(s),
```

- [ ] **Step 12: フルゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: 全テスト PASS（103 + 新規 ≈ 115前後）、typecheck 0

- [ ] **Step 13: コミット**

```bash
git add app/server/
git commit -m "feat: クイックドリルメニューと練習日・アンカー設定APIを追加"
```

---

### Task 2: クライアント — スタート画面再構成とドリル実行

**Files:**
- Modify: `app/client/src/api.ts`（QuickDrillKind・fetchQuickMenu・fetchPracticeDays・fetchSettings・saveSettings 追加）
- Modify: `app/client/src/App.tsx`（Mode 拡張・SessionRunner を source prop で起動）
- Modify: `app/client/src/screens/StartScreen.tsx`（全面書き換え）
- Modify: `app/client/src/screens/SessionRunner.tsx`（source prop 分岐）
- Modify: `app/client/src/screens/FourThreeTwoScreen.tsx`（可変長 roundsSec 対応）

**Interfaces:**
- Consumes: Task 1 の HTTP 契約（quick / progress/days / settings）と `params.roundsSec = [120, 90]`
- Produces: `type QuickDrillKind = "warmup" | "ftt-mini" | "roleplay" | "shadowing"` / `type MenuSource = { type: "daily"; minutes: 60 | 30 } | { type: "quick"; drill: QuickDrillKind }` / `SessionRunner` props は `{ source: MenuSource; sessionId: string; onExit: () => void }` に変更（App.tsx 内部でのみ使用 = sanctioned）

- [ ] **Step 1: api.ts にヘルパーを追加**

`app/client/src/api.ts` 末尾に追加:

```ts
export type QuickDrillKind = "warmup" | "ftt-mini" | "roleplay" | "shadowing";

export async function fetchQuickMenu(kind: QuickDrillKind): Promise<Menu> {
  const res = await fetch(`/api/menu/quick?kind=${kind}`);
  if (!res.ok) throw new Error(`quick menu failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function fetchPracticeDays(): Promise<string[]> {
  const res = await fetch("/api/progress/days");
  if (!res.ok) throw new Error(`practice days failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { days: string[] }).days;
}

export type Settings = { anchor: string };

export async function fetchSettings(): Promise<Settings> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(`settings failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function saveSettings(s: Settings): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(s),
  });
  if (!res.ok) throw new Error(`settings save failed: ${await extractErrorMessage(res)}`);
}
```

- [ ] **Step 2: SessionRunner を source prop に変更**

`app/client/src/screens/SessionRunner.tsx`:

(a) import を変更: `import { fetchMenu, fetchQuickMenu, sendSessionEvent, type Menu, type MenuBlock, type QuickDrillKind } from "../api";`

(b) 型と props を変更:

```ts
export type MenuSource = { type: "daily"; minutes: 60 | 30 } | { type: "quick"; drill: QuickDrillKind };

/** メニューを取得し、ブロックを順番に進行させる。ブロックタイマーと進行イベント記録を持つ */
export function SessionRunner(props: { source: MenuSource; sessionId: string; onExit: () => void }) {
```

(c) `loadMenu` 内のフェッチを分岐（残りは不変）:

```ts
    const fetching = props.source.type === "daily" ? fetchMenu(props.source.minutes) : fetchQuickMenu(props.source.drill);
    fetching
      .then((m) => {
```

(d) mount effect の依存コメント行 `}, [props.minutes]);` → `}, []);`（initedRef ガードがあるため依存は不要。eslint-disable コメントは維持）

- [ ] **Step 3: FourThreeTwoScreen を可変長 roundsSec 対応にする**

`app/client/src/screens/FourThreeTwoScreen.tsx` に以下の変更（他は不変）:

(a) 検証（34-38行付近）: 長さ3固定 → 2以上:

```ts
  const roundsSec =
    props.roundsSec && props.roundsSec.length >= 2 && props.roundsSec.every((s) => s > 0)
      ? props.roundsSec
      : DEFAULT_ROUNDS_SEC;
```

(b) transcripts の初期値を長さ駆動に（42-44行付近）:

```ts
  const [transcripts, setTranscripts] = useState<string[]>(() => Array(roundsSec.length).fill(""));
  // setState は非同期に反映されるため、finishRound が直後に読む用の同期ミラーを持つ
  const transcriptsRef = useRef<string[]>(Array(roundsSec.length).fill(""));
```

(c) リスナーペルソナを mod で回す（306行付近）:

```ts
      <p style={{ color: "#666" }}>{LISTENERS[roundIndex % LISTENERS.length]}</p>
```

(d) 準備フェーズの文言（210行付近）: 「…で3回話します。」→ 回数を導出:

```ts
          これから同じ話を {roundsSec.map(minLabel).join("→")} で{roundsSec.length}回話します。まず使えそうな表現と骨組みを確認してください（目安 {minLabel(PREP_SECONDS)}）。
```

(e) 完了文言（298行付近）:

```ts
    return <p>4/3/2 完了！同じ話を{roundsSec.length}回、少しずつ速く話せました。</p>;
```

- [ ] **Step 4: StartScreen を再構成**

`app/client/src/screens/StartScreen.tsx` 全面書き換え:

```tsx
import { useEffect, useRef, useState } from "react";
import { fetchPracticeDays, fetchSettings, saveSettings, type QuickDrillKind } from "../api";

export type StartSelection =
  | { type: "quick"; drill: QuickDrillKind }
  | { type: "daily"; minutes: 60 | 30 }
  | { type: "free" };

const QUICK_BUTTONS: Array<{ drill: QuickDrillKind; label: string }> = [
  { drill: "warmup", label: "🔊 音読ウォームアップ（6分）" },
  { drill: "ftt-mini", label: "🗣 4/3/2ミニ（8分・2ラウンド）" },
  { drill: "roleplay", label: "💼 実務ロールプレイ（10分）" },
  { drill: "shadowing", label: "🎧 シャドーイング（5分）" },
];

/** ローカル日付の YYYY-MM-DD（カレンダー表示用） */
function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 直近8週（56日）の練習日カレンダー。実施日のドット表示のみ（情報的フィードバック — 演出・連続日数なし） */
function PracticeCalendar({ days }: { days: string[] }) {
  const set = new Set(days);
  const today = new Date();
  const cells: Array<{ ymd: string; done: boolean; isToday: boolean }> = [];
  for (let i = 55; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ymd = localYmd(d);
    cells.push({ ymd, done: set.has(ymd), isToday: i === 0 });
  }
  return (
    <div>
      <h3 style={{ fontSize: "0.9rem", color: "#666" }}>練習日（直近8週）</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(14, 14px)", gap: 3 }}>
        {cells.map((c) => (
          <div
            key={c.ymd}
            title={c.ymd}
            style={{
              width: 12, height: 12, borderRadius: 3,
              background: c.done ? "#2e7d32" : "#e0e0e0",
              outline: c.isToday ? "2px solid #666" : "none",
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function StartScreen(props: { onSelect: (sel: StartSelection) => void }) {
  const [days, setDays] = useState<string[]>([]);
  const [anchor, setAnchor] = useState("");
  const [anchorDraft, setAnchorDraft] = useState("");
  const [editingAnchor, setEditingAnchor] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      // カレンダー/アンカーは補助情報 — 取得失敗でスタート画面を壊さない
      fetchPracticeDays().then((d) => { if (aliveRef.current) setDays(d); }).catch(() => {});
      fetchSettings().then((s) => {
        if (aliveRef.current) { setAnchor(s.anchor); setAnchorDraft(s.anchor); }
      }).catch(() => {});
    }
    return () => { aliveRef.current = false; };
  }, []);

  async function onSaveAnchor() {
    setSaveMsg("");
    try {
      await saveSettings({ anchor: anchorDraft });
      if (!aliveRef.current) return;
      setAnchor(anchorDraft);
      setEditingAnchor(false);
    } catch (err) {
      if (!aliveRef.current) return;
      setSaveMsg(err instanceof Error ? err.message : String(err));
    }
  }

  const btn = { display: "block", width: "100%", fontSize: "1.05rem", padding: "0.9rem", marginBottom: "0.6rem", cursor: "pointer", textAlign: "left" } as const;

  return (
    <div>
      <h3 style={{ fontSize: "1rem" }}>クイックドリル（5〜10分）</h3>
      {QUICK_BUTTONS.map((q) => (
        <button key={q.drill} style={btn} onClick={() => props.onSelect({ type: "quick", drill: q.drill })}>
          {q.label}
        </button>
      ))}
      <h3 style={{ fontSize: "1rem", marginTop: "1.2rem" }}>強化セッション（週1〜2回おすすめ）</h3>
      <button style={btn} onClick={() => props.onSelect({ type: "daily", minutes: 60 })}>📋 通しセッション（60分）</button>
      <button style={btn} onClick={() => props.onSelect({ type: "daily", minutes: 30 })}>📋 通しセッション（30分・短縮版）</button>
      <button style={btn} onClick={() => props.onSelect({ type: "free" })}>💬 自由会話のみ</button>

      <div style={{ marginTop: "1.5rem" }}>
        <PracticeCalendar days={days} />
      </div>

      <div style={{ marginTop: "1rem", color: "#444" }}>
        {!editingAnchor && anchor && (
          <p>
            📌 {anchor}{" "}
            <button style={{ fontSize: "0.8rem", cursor: "pointer" }} onClick={() => setEditingAnchor(true)}>編集</button>
          </p>
        )}
        {!editingAnchor && !anchor && (
          <p style={{ color: "#888" }}>
            続けるコツ: 既にある日課に紐づけると忘れません（例: 朝コーヒーを淹れたら1ドリル）{" "}
            <button style={{ fontSize: "0.8rem", cursor: "pointer" }} onClick={() => setEditingAnchor(true)}>設定する</button>
          </p>
        )}
        {editingAnchor && (
          <p>
            <input
              value={anchorDraft}
              onChange={(e) => setAnchorDraft(e.target.value)}
              placeholder="朝コーヒーを淹れたら1ドリル"
              maxLength={200}
              style={{ width: "60%", padding: "0.4rem" }}
            />{" "}
            <button style={{ cursor: "pointer" }} onClick={onSaveAnchor}>保存</button>{" "}
            <button style={{ cursor: "pointer" }} onClick={() => { setEditingAnchor(false); setAnchorDraft(anchor); setSaveMsg(""); }}>やめる</button>
          </p>
        )}
        {saveMsg && <p style={{ color: "crimson" }}>{saveMsg}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: App.tsx のモード分岐を更新**

`app/client/src/App.tsx`:

(a) import を変更: `import { SessionRunner, type MenuSource } from "./screens/SessionRunner";` / `import { StartScreen, type StartSelection } from "./screens/StartScreen";`

(b) Mode 型と選択ハンドラ:

```ts
type Mode = { kind: "start" } | { kind: "free" } | { kind: "session"; source: MenuSource };
```

`const [mode, setMode] = useState<Mode>({ kind: "start" });`

```ts
  function onSelect(sel: StartSelection) {
    if (sel.type === "free") setMode({ kind: "free" });
    else if (sel.type === "daily") setMode({ kind: "session", source: { type: "daily", minutes: sel.minutes } });
    else setMode({ kind: "session", source: { type: "quick", drill: sel.drill } });
  }
```

(c) ヘッダの戻るボタン条件: `mode !== "start"` → `mode.kind !== "start"`、onClick は `setMode({ kind: "start" })`

(d) 描画分岐:

```tsx
      {mode.kind === "start" && <StartScreen onSelect={onSelect} />}
      {mode.kind === "session" && (
        <SessionRunner source={mode.source} sessionId={sessionId} onExit={() => setMode({ kind: "start" })} />
      )}
      {mode.kind === "free" && <FreeTalkScreen />}
```

注意: `SessionRunner` の `initedRef` は同一マウント内ガードなので、モードを変えて再マウントすれば新しいメニューを取得する（`key` は不要 — mode 切替で SessionRunner はアンマウント→再マウントされる。同種ドリルの連続実行も start 画面を経由するため問題ない）。

- [ ] **Step 6: ゲートと実プロキシスモーク**

Run: `cd app/client && bun run build` → PASS / `cd app && bun test` → 全件 PASS（サーバは Task 1 のまま）
実サーバ + Vite dev を起動し（バックグラウンド、済んだら必ず kill・ポート確認）:
- `curl -s "http://localhost:5173/api/menu/quick?kind=ftt-mini"` → `roundsSec:[120,90]` を含む1ブロックメニュー
- `curl -s "http://localhost:5173/api/progress/days"` → `{days:[...]}`（実 data/sessions の日付）
- `curl -s -X PUT http://localhost:5173/api/settings -H 'content-type: application/json' -d '{"anchor":"test"}'` → `{ok:true}`、GET で往復確認後、`-d '{"anchor":""}'` で空に戻す

- [ ] **Step 7: コミット**

```bash
git add app/client/
git commit -m "feat: スタート画面をクイックドリル中心に再構成し練習日カレンダーとアンカーを追加"
```

---

## Self-Review 結果（プラン作成時に実施済み）

- **スコープ**: 承認済み設計（クイック4種・強化セッション格下げ表記・カレンダー情報表示のみ・アンカー1行）を全てカバー。ゲーミフィケーション制約（バッジ/ポイント/喪失演出/比較なし）はカレンダー実装がドットのみであることで満たす
- **型整合**: `QuickKind`（server）と `QuickDrillKind`（client）は同一リテラル集合。`Menu.minutes` widening はクライアント既存型（`number`）と一致。`MenuSource` は SessionRunner が export し App が import。`FTT_MINI_ROUNDS_SEC=[120,90]` は FourThreeTwoScreen の新検証 `length >= 2` を通る
- **実コード適合**: FourThreeTwoScreen の可変長対応は実ファイルの該当行に対する具体的変更として記述（transcripts 初期値・LISTENERS mod・文言導出）。AE 後の遷移と最終ラウンド判定は既に長さ駆動で変更不要なことを確認済み
- **既知の限界（レビュー時に指摘不要）**: カレンダーはローカル日付、サーバのログファイル名は UTC 日付 — JST 朝9時前の練習は前日のセルに点く。既知の ymd-UTC 問題（M3 最優先バックログ）で一括修正する
