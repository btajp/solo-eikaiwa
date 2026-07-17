# Phase A: コンテンツ3ドメイン化 実装計画

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** topics/scenarios に `domain`（日常/一般ビジネス/IT実務）と `level`（適合ステージ範囲）を導入し、メニュー選択を「帯域フィルタ → ドメインラウンドロビン → LRU」に拡張、日常4本＋一般ビジネス4本のシナリオを追加する。

**Architecture:** 既存 `app/server/menu.ts` の `parseContentFile` / `pickNext` / rotation 永続化を後方互換のまま拡張する。難易度ステージは Phase B までは定数 `DEFAULT_STAGE = 2` 固定（スペック §3.2: デフォルト Lv13 = stage 2）。HTTP 契約（/api/menu/today, /api/menu/quick のリクエスト/レスポンス形）は不変。

**Tech Stack:** Bun + TypeScript、bun:test。新規依存なし。

**Authority:** `docs/superpowers/specs/2026-07-06-adaptive-progression-design.md` §7（§2 研究制約・§11 テスト方針を含む）

## Global Constraints

- 追加のみ: 既存146テストが（型リテラル・永続化形式の更新を除き）そのまま通ること。HTTP 契約不変
- rotation 永続化（usageFile）は後方互換: 旧形式（UsageMap 直置き）を読んだら新形式へ移行する
- 情報的フィードバックのみ（本フェーズは UI 変更なし）
- コンテンツは完全オリジナル（既存教材の複製・改変は禁止）。話し言葉。実在の企業名・人名を使わない
- コミットは Conventional Commits（日本語）
- ゲート: `cd app && bun test` 全パス、`cd app && bun run typecheck` エラー0
- 定数（DOMAINS, DEFAULT_STAGE）は `app/server/menu.ts` に一元定義

---

### Task 1: frontmatter 拡張（domain / level）とローダ

**Files:**
- Modify: `app/server/menu.ts`
- Test: `app/server/__tests__/menu.test.ts`

**Interfaces:**
- Consumes: 既存 `parseContentFile(text): ContentItem | null`、`ContentItem` 型
- Produces（Task 2 と Phase B が依存）:
  - `export type Domain = "daily" | "business" | "it"`
  - `export const DOMAINS: readonly Domain[] = ["daily", "business", "it"]`（ラウンドロビンの巡回順）
  - `ContentItem` に必須フィールド `domain: Domain` と `level: [number, number]` を追加
  - パース規則: `domain` 省略時 `"it"`（警告なし）、不正値は警告して `"it"`。`level` 省略時 `[1, 6]`（警告なし）、`[min, max]` 形式で 1 ≤ min ≤ max ≤ 6 以外は警告して `[1, 6]`

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/menu.test.ts` の `describe("parseContentFile / loadContent")` ブロック内に追加:

```typescript
  test("domain と level をパースする", () => {
    const item = parseContentFile(
      `---\nid: abc\nkind: topic\ntitle: "T"\ntitle_ja: "t"\ndomain: daily\nlevel: [2, 4]\n---\n- hint\n`,
    );
    expect(item?.domain).toBe("daily");
    expect(item?.level).toEqual([2, 4]);
  });

  test("domain / level 省略時はデフォルト（it / [1,6]）", () => {
    const item = parseContentFile(
      `---\nid: abc\nkind: topic\ntitle: "T"\ntitle_ja: "t"\n---\n- hint\n`,
    );
    expect(item?.domain).toBe("it");
    expect(item?.level).toEqual([1, 6]);
  });

  test("不正な domain / level は警告してデフォルトにフォールバック", () => {
    const bad = parseContentFile(
      `---\nid: abc\nkind: topic\ntitle: "T"\ntitle_ja: "t"\ndomain: cooking\nlevel: [0, 9]\n---\n- hint\n`,
    );
    expect(bad?.domain).toBe("it");
    expect(bad?.level).toEqual([1, 6]);
    const reversed = parseContentFile(
      `---\nid: abc\nkind: topic\ntitle: "T"\ntitle_ja: "t"\nlevel: [5, 2]\n---\n- hint\n`,
    );
    expect(reversed?.level).toEqual([1, 6]);
  });
```

同ファイルの `describe("pickNext")` 内の `items` リテラルは型エラーになるため、以下に置き換える（挙動は不変）:

```typescript
  const items: ContentItem[] = [
    { id: "a", kind: "topic", title: "A", titleJa: "", hints: [], domain: "it", level: [1, 6] },
    { id: "b", kind: "topic", title: "B", titleJa: "", hints: [], domain: "it", level: [1, 6] },
    { id: "c", kind: "topic", title: "C", titleJa: "", hints: [], domain: "it", level: [1, 6] },
  ];
```

また「frontmatter と hints を抽出する」テストの `toEqual` 期待値オブジェクトに `domain: "it", level: [1, 6]` を追加する。

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd app && bun test __tests__/menu.test.ts`
Expected: FAIL（`domain` プロパティ不存在の型エラー or アサーション失敗）

- [ ] **Step 3: 最小実装**

`app/server/menu.ts` — 型と定数（`ContentItem` 定義の位置を置き換え）:

```typescript
export type Domain = "daily" | "business" | "it";
/** ドメインの巡回順（ラウンドロビンはこの順で次を探す） */
export const DOMAINS: readonly Domain[] = ["daily", "business", "it"];
export type ContentItem = {
  id: string; kind: "topic" | "scenario"; title: string; titleJa: string; hints: string[];
  domain: Domain; level: [number, number];
};
```

パースヘルパ（`parseContentFile` の直前に追加）:

```typescript
function parseDomain(raw: string | undefined): Domain {
  if (raw === undefined) return "it";
  if ((DOMAINS as readonly string[]).includes(raw)) return raw as Domain;
  console.warn(`[menu] invalid domain "${raw}", falling back to "it"`);
  return "it";
}

/** level: [min, max]（1..6, min<=max）。省略はデフォルト、不正は警告してデフォルト */
function parseLevelRange(raw: string | undefined): [number, number] {
  if (raw === undefined) return [1, 6];
  const m = raw.match(/^\[\s*(\d+)\s*,\s*(\d+)\s*\]$/);
  if (m) {
    const min = Number(m[1]);
    const max = Number(m[2]);
    if (min >= 1 && max <= 6 && min <= max) return [min, max];
  }
  console.warn(`[menu] invalid level "${raw}", falling back to [1, 6]`);
  return [1, 6];
}
```

`parseContentFile` の return を変更:

```typescript
  return {
    id: fields.id, kind: fields.kind, title: fields.title, titleJa: fields.title_ja ?? "", hints,
    domain: parseDomain(fields.domain), level: parseLevelRange(fields.level),
  };
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test __tests__/menu.test.ts`
Expected: PASS（全件）

- [ ] **Step 5: 全ゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: 全テスト PASS・型エラー0

- [ ] **Step 6: コミット**

```bash
git add app/server/menu.ts app/server/__tests__/menu.test.ts
git commit -m "feat: コンテンツfrontmatterにdomainとlevelを追加"
```

---

### Task 2: ドメインラウンドロビン選択と rotation 永続化 v2

**Files:**
- Modify: `app/server/menu.ts`
- Test: `app/server/__tests__/menu.test.ts`

**Interfaces:**
- Consumes: Task 1 の `Domain` / `DOMAINS` / `ContentItem.domain` / `ContentItem.level`
- Produces（Phase B が依存）:
  - `export const DEFAULT_STAGE = 2`（Phase B がレベル駆動の stage に差し替えるまでの固定値）
  - `MenuDeps` に `stage?: number` 追加（省略時 `DEFAULT_STAGE`）
  - `export type RotationState = { version: 2; usage: UsageMap; lastDomain: { topic: Domain | ""; scenario: Domain | "" } }`
  - `export function pickNextByDomain(items: ContentItem[], state: RotationState, todayYmd: string, stage: number, kind: "topic" | "scenario"): ContentItem`
  - usageFile の永続化形式は RotationState（v2）。旧形式（UsageMap 直置き）は読み込み時に移行
- 選択規則（スペック §7.3）: ①stage 適合プール（`level[0] <= stage <= level[1]`。空なら全 items にフォールバック）②前回ドメインの**次**から `DOMAINS` 巡回順で、プール内に存在する最初のドメイン ③ドメイン内は既存 `pickNext`（LRU + 3日連続回避）④選んだドメインを `lastDomain[kind]` に記録

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/menu.test.ts` に追加:

```typescript
import { DEFAULT_STAGE, pickNextByDomain, type RotationState } from "../menu";

function freshState(): RotationState {
  return { version: 2, usage: {}, lastDomain: { topic: "", scenario: "" } };
}

describe("pickNextByDomain", () => {
  const mk = (id: string, domain: "daily" | "business" | "it", level: [number, number]): ContentItem =>
    ({ id, kind: "topic", title: id, titleJa: "", hints: [], domain, level });
  const items = [
    mk("d1", "daily", [1, 6]), mk("d2", "daily", [1, 6]),
    mk("b1", "business", [1, 6]),
    mk("i1", "it", [1, 6]), mk("i2", "it", [4, 6]),
  ];

  test("ドメインを daily→business→it→daily の順に巡回する", () => {
    expect(DEFAULT_STAGE).toBe(2); // Phase B までの既定ステージ（スペック §3.2）
    const state = freshState();
    expect(pickNextByDomain(items, state, "2026-07-06", 2, "topic").domain).toBe("daily");
    expect(pickNextByDomain(items, state, "2026-07-06", 2, "topic").domain).toBe("business");
    expect(pickNextByDomain(items, state, "2026-07-06", 2, "topic").domain).toBe("it");
    expect(pickNextByDomain(items, state, "2026-07-06", 2, "topic").domain).toBe("daily");
  });

  test("stage 適合プールでフィルタする（stage2 は level [4,6] を除外）", () => {
    const state = freshState();
    state.lastDomain.topic = "business"; // 次は it
    const picked = pickNextByDomain(items, state, "2026-07-06", 2, "topic");
    expect(picked.id).toBe("i1"); // i2 は [4,6] で stage2 に不適合
  });

  test("プールが空になるドメインはスキップする", () => {
    const noBusiness = items.filter((it) => it.domain !== "business");
    const state = freshState();
    state.lastDomain.topic = "daily"; // 次は business → 無いので it へ
    expect(pickNextByDomain(noBusiness, state, "2026-07-06", 2, "topic").domain).toBe("it");
    expect(state.lastDomain.topic).toBe("it");
  });

  test("全アイテムが stage 不適合なら全体にフォールバックする", () => {
    const hard = [mk("x1", "it", [5, 6]), mk("x2", "daily", [4, 6])];
    const state = freshState();
    const picked = pickNextByDomain(hard, state, "2026-07-06", 1, "topic");
    expect(["x1", "x2"]).toContain(picked.id);
  });

  test("topic と scenario は別々のドメインカーソルを持つ", () => {
    const state = freshState();
    pickNextByDomain(items, state, "2026-07-06", 2, "topic");
    expect(state.lastDomain.topic).toBe("daily");
    expect(state.lastDomain.scenario).toBe("");
  });
});

describe("rotation 永続化の後方互換", () => {
  test("旧形式（UsageMap 直置き）を読んだら v2 に移行し LRU を引き継ぐ", () => {
    const dirs = makeContentDirs();
    // 旧形式: id → 日付配列 の直置き
    writeFileSync(dirs.usageFile, JSON.stringify({ t1: ["2026-07-04"] }));
    const m = buildQuickMenu("warmup", { ...dirs, today: JULY5 });
    // t1 は使用済みなので LRU により t2 が選ばれる（旧 usage が引き継がれている証拠）
    expect((m.blocks[0].params.topic as { id: string }).id).toBe("t2");
    const saved = JSON.parse(readFileSync(dirs.usageFile, "utf8")) as RotationState;
    expect(saved.version).toBe(2);
    expect(saved.usage.t1).toEqual(["2026-07-04"]);
    expect(saved.lastDomain.topic).toBe("it"); // フィクスチャは全て domain 省略 = it
  });
});
```

既存テストのうち usageFile を直接 JSON.parse している箇所を v2 形式に更新する（**挙動の期待は不変、形式だけ変更**）。対象と変更:

1. `使用記録: 4/3/2とロールプレイのみ記録され…`: `const usage = JSON.parse(...) as UsageMap` → `const state = JSON.parse(...) as RotationState` とし、`usage.t1` → `state.usage.t1`、`usage.s1` → `state.usage.s1`、`usage.t2` → `state.usage.t2`
2. `同日同minutesの再呼び出し…`: 同様に `state.usage.t1`
3. `破損した使用状況ファイルは空として扱い…`: 同様に `state.usage.t1` / `state.usage.s1`
4. `同日に60分版→30分版…`: `Object.values(usage)` → `Object.values(state.usage)`
5. `buildQuickMenu` の `warmup: …usage記録`: `usage.t1` → `state.usage.t1`

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd app && bun test __tests__/menu.test.ts`
Expected: FAIL（pickNextByDomain 未定義）

- [ ] **Step 3: 実装**

`app/server/menu.ts` — 定数と型（FTT 定数群の近くに追加）:

```typescript
/** Phase B でレベル駆動になるまでの既定ステージ（スペック §3.2: デフォルト Lv13 = stage 2） */
export const DEFAULT_STAGE = 2;

/** rotation 永続化 v2。旧形式（UsageMap 直置き）は読み込み時に移行する */
export type RotationState = {
  version: 2;
  usage: UsageMap;
  lastDomain: { topic: Domain | ""; scenario: Domain | "" };
};
```

`loadUsage` / `saveUsage` を置き換え:

```typescript
function freshRotation(): RotationState {
  return { version: 2, usage: {}, lastDomain: { topic: "", scenario: "" } };
}

/** v2 を読む。旧形式（id→日付配列の直置き）は usage として移行。不明形状は初期状態 */
function loadRotation(usageFile: string): RotationState {
  const raw = readJsonSafe<Record<string, unknown>>(usageFile);
  if (raw === undefined) return freshRotation();
  if (raw.version === 2 && typeof raw.usage === "object" && raw.usage !== null) {
    const last = (raw.lastDomain ?? {}) as Partial<RotationState["lastDomain"]>;
    const valid = (v: unknown): v is Domain | "" => v === "" || (DOMAINS as readonly string[]).includes(v as string);
    return {
      version: 2,
      usage: raw.usage as UsageMap,
      lastDomain: { topic: valid(last.topic) ? last.topic : "", scenario: valid(last.scenario) ? last.scenario : "" },
    };
  }
  // 旧形式: すべての値が配列なら UsageMap とみなして移行
  if (Object.values(raw).every((v) => Array.isArray(v))) {
    return { ...freshRotation(), usage: raw as UsageMap };
  }
  console.warn(`[menu] unknown rotation state shape, starting fresh: ${usageFile}`);
  return freshRotation();
}

function saveRotation(usageFile: string, state: RotationState): void {
  mkdirSync(path.dirname(usageFile), { recursive: true });
  writeFileSync(usageFile, JSON.stringify(state, null, 2));
}
```

セレクタ（`pickNext` の直後に追加。`pickNext` 自体は不変）:

```typescript
/**
 * 帯域フィルタ → ドメインラウンドロビン → LRU の選択（スペック §7.3）。
 * stage 適合プール（空なら全体にフォールバック）から、前回ドメインの次を優先して
 * 存在する最初のドメインを選び、ドメイン内は pickNext（LRU + 3日連続回避）。
 */
export function pickNextByDomain(
  items: ContentItem[], state: RotationState, todayYmd: string, stage: number, kind: "topic" | "scenario",
): ContentItem {
  if (items.length === 0) throw new Error("no content items available");
  const inBand = items.filter((it) => it.level[0] <= stage && stage <= it.level[1]);
  const pool = inBand.length > 0 ? inBand : items;
  const last = state.lastDomain[kind];
  const start = last === "" ? 0 : (DOMAINS.indexOf(last) + 1) % DOMAINS.length;
  for (let i = 0; i < DOMAINS.length; i++) {
    const domain = DOMAINS[(start + i) % DOMAINS.length];
    const sub = pool.filter((it) => it.domain === domain);
    if (sub.length === 0) continue;
    const picked = pickNext(sub, state.usage, todayYmd);
    state.lastDomain[kind] = domain;
    return picked;
  }
  return pickNext(pool, state.usage, todayYmd); // 論理上到達しない安全網
}
```

`MenuDeps` に `stage?: number;` を追加。

`buildTodayMenu` の該当部分を置き換え:

```typescript
  const stage = deps.stage ?? DEFAULT_STAGE;
  const state = loadRotation(usageFile);
  const topics = loadContent(topicsDir);
  const scenarios = loadContent(scenariosDir);

  const mainTopic = pickNextByDomain(topics, state, ymd, stage, "topic");
  const scenario = pickNextByDomain(scenarios, state, ymd, stage, "scenario");
  // シャドーイング素材は「次にローテーションが選ぶトピック」のプレビュー。
  // 使用済みマーク・ドメインカーソルの前進はしない（帯域フィルタだけ適用）
  const others = topics.filter((t) => t.id !== mainTopic.id);
  const othersInBand = others.filter((it) => it.level[0] <= stage && stage <= it.level[1]);
  const shadowPool = othersInBand.length > 0 ? othersInBand : others;
  const shadowTopic = shadowPool.length > 0 ? pickNext(shadowPool, state.usage, ymd) : mainTopic;

  markUsed(state.usage, mainTopic.id, ymd);
  markUsed(state.usage, scenario.id, ymd);
  saveRotation(usageFile, state);
```

`buildQuickMenu` の該当部分を置き換え:

```typescript
  const stage = deps.stage ?? DEFAULT_STAGE;
  const state = loadRotation(usageFile);

  let block: MenuBlock;
  if (kind === "roleplay") {
    const scenario = pickNextByDomain(loadContent(scenariosDir), state, ymd, stage, "scenario");
    markUsed(state.usage, scenario.id, ymd);
    block = { id: "q1", kind: "roleplay", title: `実務ロールプレイ: ${scenario.title}`, minutes: 10, params: { scenario } };
  } else {
    const topic = pickNextByDomain(loadContent(topicsDir), state, ymd, stage, "topic");
    markUsed(state.usage, topic.id, ymd);
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

  saveRotation(usageFile, state);
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test __tests__/menu.test.ts`
Expected: PASS（既存＋新規全件。フィクスチャは全て domain 省略=it なので、ラウンドロビンは毎回 it に落ちて既存の LRU 期待値がそのまま成立する）

- [ ] **Step 5: 全ゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: 全テスト PASS・型エラー0（routes.test.ts はメニューAPI契約が不変のためそのまま通る）

- [ ] **Step 6: コミット**

```bash
git add app/server/menu.ts app/server/__tests__/menu.test.ts
git commit -m "feat: メニュー選択をドメインラウンドロビンと帯域フィルタに拡張"
```

---

### Task 3: シナリオ8本の追加と既存コンテンツへのタグ付け

**Files:**
- Create: `content/scenarios/travel-trouble.md`, `content/scenarios/restaurant-order.md`, `content/scenarios/pharmacy-visit.md`, `content/scenarios/neighbor-chat.md`, `content/scenarios/reschedule-deadline.md`, `content/scenarios/progress-update.md`, `content/scenarios/customer-complaint.md`, `content/scenarios/job-interview.md`
- Modify: `content/topics/*.md`（22本）と `content/scenarios/*.md`（既存8本）の frontmatter に `domain` / `level` を追加
- Test: `app/server/__tests__/content.test.ts`（新規）

**Interfaces:**
- Consumes: Task 1 のパース規則（`domain` / `level` frontmatter）
- Produces: 3ドメイン体制の実コンテンツ（scenarios 16本・topics 22本）。Phase B/C はこのタグを前提にする

- [ ] **Step 1: 失敗するテスト（コンテンツ整合性）を書く**

`app/server/__tests__/content.test.ts` を新規作成:

```typescript
import { describe, expect, test } from "bun:test";
import { DOMAINS, loadContent } from "../menu";
import { SCENARIOS_DIR, TOPICS_DIR } from "../paths";

/** リポジトリ実コンテンツの整合性（frontmatter タグの網羅チェック） */
describe("content integrity", () => {
  const topics = loadContent(TOPICS_DIR);
  const scenarios = loadContent(SCENARIOS_DIR);

  test("topics は22本以上・scenarios は16本以上パースできる", () => {
    expect(topics.length).toBeGreaterThanOrEqual(22);
    expect(scenarios.length).toBeGreaterThanOrEqual(16);
  });

  test("topics / scenarios とも3ドメインすべてに1本以上ある", () => {
    for (const domain of DOMAINS) {
      expect(topics.filter((t) => t.domain === domain).length).toBeGreaterThanOrEqual(1);
      expect(scenarios.filter((s) => s.domain === domain).length).toBeGreaterThanOrEqual(1);
    }
  });

  test("全アイテムの level が 1..6 の有効範囲", () => {
    for (const it of [...topics, ...scenarios]) {
      expect(it.level[0]).toBeGreaterThanOrEqual(1);
      expect(it.level[1]).toBeLessThanOrEqual(6);
      expect(it.level[0]).toBeLessThanOrEqual(it.level[1]);
    }
  });

  test("どの stage(1..6) にも topics / scenarios の適合プールが3本以上ある", () => {
    for (let stage = 1; stage <= 6; stage++) {
      const tPool = topics.filter((t) => t.level[0] <= stage && stage <= t.level[1]);
      const sPool = scenarios.filter((s) => s.level[0] <= stage && stage <= s.level[1]);
      expect(tPool.length).toBeGreaterThanOrEqual(3);
      expect(sPool.length).toBeGreaterThanOrEqual(3);
    }
  });
});
```

Run: `cd app && bun test __tests__/content.test.ts`
Expected: FAIL（scenarios 16本未満・business/daily シナリオ0本）

- [ ] **Step 2: 新規シナリオ8本を作成（完全な本文・このまま書き込む）**

`content/scenarios/travel-trouble.md`:

```markdown
---
id: travel-trouble
kind: scenario
title: "Hotel check-in problem while traveling"
title_ja: "旅行先のホテルでチェックイントラブル"
domain: daily
level: [1, 4]
---
Roleplay setup:
- You are a traveler checking in after a long flight
- The AI plays the front desk clerk who cannot find your reservation
- Goal: stay calm, show your booking confirmation, and agree on a solution
- Useful moves: explain when and how you booked, ask what options they have
```

`content/scenarios/restaurant-order.md`:

```markdown
---
id: restaurant-order
kind: scenario
title: "Ordering at a restaurant and fixing a mix-up"
title_ja: "レストランでの注文と間違い対応"
domain: daily
level: [1, 3]
---
Roleplay setup:
- You are a customer at a casual restaurant abroad
- The AI plays the server; later your order arrives wrong
- Goal: ask questions about the menu, order, then politely point out the mix-up
- Useful moves: ask for recommendations, mention what you cannot eat
```

`content/scenarios/pharmacy-visit.md`:

```markdown
---
id: pharmacy-visit
kind: scenario
title: "Explaining symptoms at a pharmacy"
title_ja: "薬局で症状を説明する"
domain: daily
level: [2, 4]
---
Roleplay setup:
- You are not feeling well while traveling and visit a pharmacy
- The AI plays the pharmacist who asks about your symptoms
- Goal: describe your symptoms, answer questions, and understand the instructions
- Useful moves: say when it started, how strong it is, and ask about side effects
```

`content/scenarios/neighbor-chat.md`:

```markdown
---
id: neighbor-chat
kind: scenario
title: "Small talk with a neighbor"
title_ja: "近所の人との立ち話"
domain: daily
level: [1, 3]
---
Roleplay setup:
- You run into your neighbor in front of your building
- The AI plays the friendly neighbor who likes to chat
- Goal: keep a light conversation going for a few minutes
- Useful moves: weather, weekend plans, local news, and asking questions back
```

`content/scenarios/reschedule-deadline.md`:

```markdown
---
id: reschedule-deadline
kind: scenario
title: "Renegotiating a deadline"
title_ja: "締切の再交渉"
domain: business
level: [2, 5]
---
Roleplay setup:
- You need one more week for a deliverable
- The AI plays the counterpart who wants to keep the original date
- Goal: explain the reason honestly, propose a new date, and reach an agreement
- Useful moves: offer a partial delivery earlier, confirm the agreement clearly
```

`content/scenarios/progress-update.md`:

```markdown
---
id: progress-update
kind: scenario
title: "Giving a progress update with a delay"
title_ja: "遅延を含む進捗報告"
domain: business
level: [2, 5]
---
Roleplay setup:
- You report progress on a project in a weekly check-in
- The AI plays your manager who asks follow-up questions
- Goal: report what is done, explain one delay without excuses, and share the recovery plan
- Useful moves: numbers first, cause in one sentence, next steps with dates
```

`content/scenarios/customer-complaint.md`:

```markdown
---
id: customer-complaint
kind: scenario
title: "Handling a customer complaint"
title_ja: "顧客からの苦情対応"
domain: business
level: [3, 6]
---
Roleplay setup:
- A customer is unhappy about a late delivery and a billing mistake
- The AI plays the frustrated but reasonable customer
- Goal: listen, apologize appropriately, clarify facts, and propose a concrete fix
- Useful moves: summarize their points back, avoid over-promising
```

`content/scenarios/job-interview.md`:

```markdown
---
id: job-interview
kind: scenario
title: "Being interviewed for a job"
title_ja: "面接を受ける側"
domain: business
level: [3, 6]
---
Roleplay setup:
- You are the candidate in a job interview
- The AI plays the interviewer asking about your experience and motivation
- Goal: introduce your background, give one concrete achievement story, and ask good questions
- Useful moves: structure answers as situation → action → result
```

- [ ] **Step 3: 既存コンテンツへのタグ付け（全30ファイル・この表のとおり frontmatter の `title_ja` 行の直後に2行追加）**

topics（22本）:

| ファイル | domain | level |
|---|---|---|
| weekend-plans.md | daily | [1, 3] |
| food-restaurants.md | daily | [1, 3] |
| travel-hometown.md | daily | [1, 4] |
| hobbies-recent.md | daily | [1, 4] |
| health-routine.md | daily | [2, 4] |
| small-talk-work.md | business | [1, 3] |
| team-intro.md | business | [2, 4] |
| schedule-negotiation.md | business | [2, 5] |
| explaining-delay.md | business | [3, 5] |
| meeting-facilitation.md | business | [3, 6] |
| this-week-work.md | it | [1, 4] |
| corporate-it.md | it | [2, 4] |
| my-career.md | it | [2, 5] |
| recent-article.md | it | [3, 5] |
| blog-workflow.md | it | [3, 5] |
| tech-selection.md | it | [3, 6] |
| recruiting.md | it | [3, 5] |
| incident-response.md | it | [4, 6] |
| abac-okta.md | it | [4, 6] |
| zero-trust.md | it | [4, 6] |
| ai-agent-governance.md | it | [4, 6] |
| ai-data-governance.md | it | [4, 6] |

scenarios（既存8本・スペック §7.2 のとおり全て it）:

| ファイル | domain | level |
|---|---|---|
| daily-standup.md | it | [2, 4] |
| vendor-meeting.md | it | [3, 5] |
| customer-hearing.md | it | [3, 5] |
| casual-interview.md | it | [3, 5] |
| tech-discussion.md | it | [3, 6] |
| incident-report.md | it | [4, 6] |
| security-review.md | it | [4, 6] |
| conference-qa.md | it | [4, 6] |

追加する2行の形式（例: weekend-plans.md）:

```yaml
domain: daily
level: [1, 3]
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test __tests__/content.test.ts`
Expected: PASS（4テスト全件。stage1 の scenarios プールは travel-trouble/restaurant-order/neighbor-chat の3本で充足）

- [ ] **Step 5: 全ゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: 全テスト PASS・型エラー0

- [ ] **Step 6: コミット**

```bash
git add content/ app/server/__tests__/content.test.ts
git commit -m "feat: 日常・一般ビジネスのシナリオ8本を追加し既存コンテンツにタグ付け"
```

---

## Phase B への引き継ぎメモ

- `MenuDeps.stage` は Phase B で `user_progress` 由来の `stage(level)` を渡す（`DEFAULT_STAGE` は未設定時のフォールバックとして残す）
- 日次メニューキャッシュ（`menu-YMD-{60,30}.json`）のキーに stage は含まれない。Phase B でレベルが日中に変わった場合のキャッシュ扱い（キーに stage を含める等）を Phase B の計画で決めること
- ロールプレイのブロックタイトルは現状「実務ロールプレイ: …」固定。ドメイン別の呼称（日常ロールプレイ等）にする場合は Phase B の UI 作業で扱う（本フェーズは契約不変を優先）
