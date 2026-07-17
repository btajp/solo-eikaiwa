# アプリUI改善パック（フィードバック一括対応 A） Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 練習カレンダーを日別XPの濃淡5段階に強化し、設定を3タブに分割、サイドバーに言語/文字サイズ切替を常設、プリセットをドロップダウン+現在値自動判定に変更、バランスプリセットの生成をClaudeへ、用途別推奨理由を表示、メニュー文言を改善する（v0.22.0・spec: `docs/superpowers/specs/2026-07-08-ui-feedback-pack-design.md`）。

**Architecture:** サーバは `GET /api/progress/days` の後方互換フィールド追加（`xpByDay`）と `days` の和集合化のみ。クライアントは純ロジック（`calendarLevel` / `matchPreset`）を lib に切り出して TDD し、UI は既存部品（`.lang-toggle` セグメント・`support-panel` カード）を再利用する。

**Tech Stack:** Bun + TypeScript（`app/server`）、React + Vite（`app/client`）、bun:sqlite、bun:test。

## Global Constraints

- **検証ゲート（全タスク完了時に3種すべて緑）:** `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build`
- **サーバ新ロジックは TDD（赤→緑）**。テストは `app/server/__tests__/`、フェイクは `helpers/route-deps.ts` の `satisfies` パターン、HTTP は `getReq` で `makeFetchHandler(deps)` を直接叩く。クライアント純ロジックも TDD（`*.test.ts`）。
- **i18n（改定後ルール・Task 8 で AGENTS.md にも反映）**: named 型辞書。型 + `STR.en` + `STR.ja` の3点同時変更。文言は利用者のわかりやすさ優先で改善してよいが **EN/JA を必ず同時更新**し、ユーザーに見える文言変更はコミットメッセージに明示。文字列の直書き禁止。
- **プロダクト制約（binding）**: 情報的フィードバックのみ。ノルマ・警告・叱責・喪失演出なし。XP は減らない。ユーザーデータを削除する機能を作らない。
- **日付**: サーバは `dates.ts` の `localYmd`/`addDaysYmd` を使い `toISOString().slice` 禁止。日別集計は `xp_events.ymd` 列で行う（`ts` から導出しない）。
- **ブランチ**: `feat/ui-feedback-pack` で作業。リリース（CHANGELOG・タグ）はパックB完了後に v0.22.0 として一括（このプランでは行わない。README 更新のみ Task 7 に含む）。

---

### Task 1: サーバ — 日別XP集計と /api/progress/days 拡張（TDD）

**Files:**
- Modify: `app/server/progress-store.ts`（型 `ProgressStore`・`ensureProgressSchema`・`makeProgressStore`）
- Modify: `app/server/routes/progress.ts:5-11,60`
- Modify: `app/server/index.ts:85` 付近（配線）
- Modify: `app/server/__tests__/helpers/route-deps.ts:65-79`（`makeFakeProgressStore`）
- Test: `app/server/__tests__/progress-store.test.ts`（追記）
- Test: `app/server/__tests__/routes-progress.test.ts:14-20`（更新+追加）

**Interfaces:**
- Produces: `ProgressStore.xpByDay(): Record<string, number>`（ymd → その日の全kind XP合計）
- Produces: `GET /api/progress/days` → `{ days: string[], xpByDay: Record<string, number> }`。`days` = `practiceDays()`（ログ日）と `Object.keys(xpByDay)` の**和集合を昇順ソート・重複除去**したもの

- [ ] **Step 1: progress-store のテストを書く（赤）** — `progress-store.test.ts` に追記。既存のストア生成・`seedBlockXpDay`（94行付近）のパターンに合わせる:

```ts
test("xpByDay は日別・全kind合計を返す", () => {
  const { db, store } = makeStore(); // 既存テストのストア生成ヘルパに合わせる
  db.run("INSERT INTO xp_events (ts, ymd, kind, amount, meta) VALUES (?, ?, ?, ?, NULL)",
    ["2026-07-01T00:00:00.000Z", "2026-07-01", "block", 30]);
  db.run("INSERT INTO xp_events (ts, ymd, kind, amount, meta) VALUES (?, ?, ?, ?, NULL)",
    ["2026-07-01T01:00:00.000Z", "2026-07-01", "srs-grade", 2]);
  db.run("INSERT INTO xp_events (ts, ymd, kind, amount, meta) VALUES (?, ?, ?, ?, NULL)",
    ["2026-07-03T00:00:00.000Z", "2026-07-03", "placement", 10]);
  expect(store.xpByDay()).toEqual({ "2026-07-01": 32, "2026-07-03": 10 });
});
test("xpByDay はイベントが無ければ空オブジェクト", () => {
  const { store } = makeStore();
  expect(store.xpByDay()).toEqual({});
});
```

- [ ] **Step 2: 赤を確認** — Run: `cd app && bun test progress-store` → FAIL（`xpByDay is not a function`）。※この時点で `satisfies ProgressStore` の型エラーはまだ出ない（型追加前）
- [ ] **Step 3: 実装** — `progress-store.ts`:
  - 型に1行追加（`placementSet` の下）: `/** 日別XP合計（全kind・ymd昇順は呼び出し側で不要） */ xpByDay(): Record<string, number>;`
  - `ensureProgressSchema` 末尾に: `db.run("CREATE INDEX IF NOT EXISTS idx_xp_events_ymd ON xp_events(ymd)");`
  - `makeProgressStore` の return オブジェクトに:

```ts
    xpByDay() {
      const rows = db.query<{ ymd: string; total: number }, []>(
        "SELECT ymd, SUM(amount) AS total FROM xp_events GROUP BY ymd").all();
      return Object.fromEntries(rows.map((r) => [r.ymd, r.total]));
    },
```

- [ ] **Step 4: フェイク更新** — `helpers/route-deps.ts` の `makeFakeProgressStore` に `xpByDay: () => ({ "2026-07-01": 32 }),` を追加（`satisfies` の型エラーがここで解消される）
- [ ] **Step 5: 緑を確認** — Run: `cd app && bun test progress-store` → PASS
- [ ] **Step 6: ルートのテストを更新（赤）** — `routes-progress.test.ts:14-20` を置換 + 和集合ケース:

```ts
  test("GET /api/progress/days は ログ日∪XP日 と xpByDay を返す", async () => {
    const { deps } = makeTestDeps(); // practiceDays: 2026-07-01, 2026-07-03 / xpByDay: {2026-07-01: 32}
    const res = await makeFetchHandler(deps)(getReq("/api/progress/days"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      days: ["2026-07-01", "2026-07-03"],
      xpByDay: { "2026-07-01": 32 },
    });
  });
  test("GET /api/progress/days: XPのみの日（SRS採点等）も days に含まれる", async () => {
    const { deps } = makeTestDeps({
      progressStore: makeFakeProgressStore({ xpByDay: () => ({ "2026-07-02": 4, "2026-07-01": 32 }) }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/progress/days"));
    expect(await res.json()).toEqual({
      days: ["2026-07-01", "2026-07-02", "2026-07-03"],
      xpByDay: { "2026-07-01": 32, "2026-07-02": 4 },
    });
  });
```

- [ ] **Step 7: 赤を確認** — Run: `cd app && bun test routes-progress` → FAIL（xpByDay フィールドなし・和集合されない）
- [ ] **Step 8: ルート実装** — `routes/progress.ts`:

```ts
exact("GET", "/api/progress/days", () => {
  const xpByDay = deps.progressStore.xpByDay();
  const days = [...new Set([...deps.practiceDays(), ...Object.keys(xpByDay)])].sort();
  return json({ days, xpByDay });
}),
```

  ※ `ProgressRoutesDeps` は既に `progressStore` を持つため deps 追加は不要。`index.ts` の変更も不要（実ストアが xpByDay を持つ）。
- [ ] **Step 9: 緑を確認して全体テスト** — Run: `cd app && bun test` → 全緑
- [ ] **Step 10: Commit** — `git commit -m "feat: 日別XP集計を追加し /api/progress/days を ログ日∪XP日 + xpByDay に拡張"`

### Task 2: クライアント — カレンダー濃淡5段階（純ロジックTDD + UI + CSS + i18n）

**Files:**
- Create: `app/client/src/lib/calendar-level.ts` / Test: `app/client/src/lib/calendar-level.test.ts`
- Modify: `app/client/src/api/progress.ts:71-75`
- Modify: `app/client/src/App.tsx:221-239`（PracticeStat）
- Modify: `app/client/src/screens/StartScreen.tsx:36-109,114,126,225`
- Modify: `app/client/src/styles/tokens.css`（`--cal-l1..l4`）/ `app/client/src/styles/app.css:169-174`
- Modify: `app/client/src/i18n.ts:119`（型）+ EN `:394` + JA `:712`

**Interfaces:**
- Consumes: Task 1 の `{ days, xpByDay }`
- Produces: `calendarLevel(done: boolean, xp: number | undefined): 0 | 1 | 2 | 3 | 4`、`fetchPracticeDays(): Promise<PracticeDaysView>`（`type PracticeDaysView = { days: string[]; xpByDay: Record<string, number> }`）

- [ ] **Step 1: 純ロジックのテスト（赤）** — `calendar-level.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { calendarLevel } from "./calendar-level";

describe("calendarLevel", () => {
  test("活動なし→0 / 活動のみXP0→1", () => {
    expect(calendarLevel(false, undefined)).toBe(0);
    expect(calendarLevel(true, undefined)).toBe(1);
    expect(calendarLevel(true, 0)).toBe(1);
  });
  test("XP帯: 1–19→2 / 20–49→3 / 50+→4（done不問）", () => {
    expect(calendarLevel(true, 1)).toBe(2);
    expect(calendarLevel(false, 19)).toBe(2);
    expect(calendarLevel(true, 20)).toBe(3);
    expect(calendarLevel(true, 49)).toBe(3);
    expect(calendarLevel(true, 50)).toBe(4);
    expect(calendarLevel(false, 100)).toBe(4);
  });
});
```

- [ ] **Step 2: 赤確認** — Run: `cd app && bun test calendar-level` → FAIL
- [ ] **Step 3: 実装** — `calendar-level.ts`:

```ts
/**
 * 練習カレンダーの濃淡レベル（0=活動なし〜4=最濃）。しきい値の根拠:
 * クイック1本5–10XP / 30分メニュー30XP / フル完走57XP（spec A-1）。
 * 情報表示のみ — レベルを条件に警告・演出を出さないこと（プロダクト制約）。
 */
export function calendarLevel(done: boolean, xp: number | undefined): 0 | 1 | 2 | 3 | 4 {
  const v = xp ?? 0;
  if (v >= 50) return 4;
  if (v >= 20) return 3;
  if (v >= 1) return 2;
  return done ? 1 : 0;
}
```

- [ ] **Step 4: 緑確認** — Run: `cd app && bun test calendar-level` → PASS。Commit: `feat: カレンダー濃淡レベルの純ロジックを追加`
- [ ] **Step 5: API 追随** — `api/progress.ts` の `fetchPracticeDays` を置換:

```ts
export type PracticeDaysView = { days: string[]; xpByDay: Record<string, number> };

export async function fetchPracticeDays(): Promise<PracticeDaysView> {
  const res = await fetch("/api/progress/days");
  if (!res.ok) throw new Error(`practice days failed: ${await extractErrorMessage(res)}`);
  const body = (await res.json()) as { days: string[]; xpByDay?: Record<string, number> };
  return { days: body.days, xpByDay: body.xpByDay ?? {} };
}
```

  `api/index.ts` バレルに `PracticeDaysView` の型再エクスポートを追加。
- [ ] **Step 6: 消費側3箇所を追随** — `App.tsx` PracticeStat: `const [days, setDays] = useState<string[]>([])` はそのまま、`fetchPracticeDays().then((v) => setDays(v.days))` に変更。`StartScreen.tsx`: `const [daysView, setDaysView] = useState<PracticeDaysView>({ days: [], xpByDay: {} })` にし、`<PracticeCalendar days={daysView.days} xpByDay={daysView.xpByDay} lang={props.lang} />`
- [ ] **Step 7: PracticeCalendar を濃淡化** — `StartScreen.tsx`。セル生成（96行付近）を置換:

```tsx
{col.map((c) => {
  const level = calendarLevel(c.done, xpByDay[c.ymd]);
  const xp = xpByDay[c.ymd] ?? 0;
  return (
    <div
      key={c.ymd}
      title={c.isFuture ? undefined : xp > 0 ? `${c.ymd} · ${xp} XP` : c.ymd}
      data-level={level > 0 ? level : undefined}
      className={`day${c.isToday ? " is-today" : ""}${c.isFuture ? " is-future" : ""}`}
    />
  );
})}
```

  凡例（103-106行）を置換（`is-done` クラスは廃止）:

```tsx
<div className="cal-legend text-sm text-muted">
  {t.calendar.legendLess}
  {[1, 2, 3, 4].map((lv) => (<span key={lv} className="day" data-level={lv} />))}
  {t.calendar.legendMore}
</div>
```

- [ ] **Step 8: CSS** — `tokens.css` の `:root`（ライト）に追加し、ダークブロックにも同じ4行を追加（`--accent`/`--surface` 参照なので値は自動でテーマ追従するが、規約「値の変更はこのファイルでのみ」に合わせ両所に明記）:

```css
  /* 練習カレンダー濃淡（L1=活動のみ〜L4=最濃。--accent と --surface の混色） */
  --cal-l1: color-mix(in srgb, var(--accent) 25%, var(--surface));
  --cal-l2: color-mix(in srgb, var(--accent) 50%, var(--surface));
  --cal-l3: color-mix(in srgb, var(--accent) 75%, var(--surface));
  --cal-l4: var(--accent);
```

  `app.css:170` の `.day.is-done { background: var(--accent); }` を削除し、代わりに:

```css
.day[data-level="1"] { background: var(--cal-l1); }
.day[data-level="2"] { background: var(--cal-l2); }
.day[data-level="3"] { background: var(--cal-l3); }
.day[data-level="4"] { background: var(--cal-l4); }
```

- [ ] **Step 9: i18n** — 型 `:119` を `type CalendarStrings = { calendar: { title: string; legendLess: string; legendMore: string } };` に変更。EN `:394` → `calendar: { title: "Practice days", legendLess: "Less", legendMore: "More" },`。JA `:712` → `calendar: { title: "練習日", legendLess: "少", legendMore: "多" },`（旧 `practiced`/`notYet` は EN/JA とも削除。コミットメッセージに文言変更を明示）
- [ ] **Step 10: 検証** — Run: `cd app && bun test && cd app && bun run typecheck && cd app/client && bun run build` → 全緑。Commit: `feat: 練習カレンダーを日別XPの濃淡5段階にし SRSのみの日も草を表示`

> 再改訂（2026-07-08 ユーザー再判断・Task 3 実装後にフォローアップ適用）: 性能要求の序列（測定>コーチング>生成）を確認のうえ、**バランスの generation は `"local"` に差し戻し**（= v0.21.0 定義を維持）。presetBalancedDesc も v0.21.0 原文を復元。Task 7 の生成の推奨理由は「推奨: ローカル（品質を上げたいときは Claude）」に変更。README:162 は変更不要になり、CHANGELOG にプリセット変更は載せない。

### Task 3: matchPreset 純関数 + バランス変更（TDD）

**Files:**
- Modify: `app/client/src/lib/llm-assignments.ts:13-21`（コメント+balanced）+ 末尾に matchPreset
- Test: `app/client/src/lib/llm-assignments.test.ts`（balanced 期待値更新 + matchPreset 追加）
- Modify: `app/client/src/i18n.ts:341`（EN presetBalancedDesc）+ `:659`（JA 同）

**Interfaces:**
- Produces: `matchPreset(targets: RoleTargets): PresetId | "custom"`（Task 4 が使用）
- Produces: `PRESETS.balanced = { conversation: "local", coaching: "claude", generation: "claude", assessment: "claude" }`

- [ ] **Step 1: テスト先行（赤）** — `llm-assignments.test.ts` の balanced を期待する既存ケース（37-95行の buildRolesPayload 3プリセットケース内）で `generation` の期待を `openai-compat` → `claude` に変更。matchPreset テストを追加:

```ts
import { matchPreset, PRESETS } from "./llm-assignments";

describe("matchPreset", () => {
  test("3プリセットの完全一致を判定する", () => {
    expect(matchPreset(PRESETS["all-local"])).toBe("all-local");
    expect(matchPreset(PRESETS.balanced)).toBe("balanced");
    expect(matchPreset(PRESETS["high-quality"])).toBe("high-quality");
  });
  test("1ロールでも異なれば custom", () => {
    expect(matchPreset({ ...PRESETS.balanced, generation: "codex" })).toBe("custom");
  });
  test("旧バランス（生成=ローカル）は custom になる（定義変更の明示仕様）", () => {
    expect(matchPreset({ conversation: "local", coaching: "claude", generation: "local", assessment: "claude" })).toBe("custom");
  });
  test("往復整合: buildRolesPayload→hydrateTargets→matchPreset が元に戻る", () => {
    const conn = { baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "" };
    const payload = buildRolesPayload(PRESETS.balanced, conn);
    const view = fakeViewFromPayload(payload); // 既存テストの view 組み立てパターンに合わせて作る
    expect(matchPreset(hydrateTargets(view))).toBe("balanced");
  });
});
```

  ※ `fakeViewFromPayload` は既存 hydrateTargets テスト（97-120行）の `LlmSettingsView` 組み立てを関数化して共用する。
- [ ] **Step 2: 赤確認** — Run: `cd app && bun test llm-assignments` → FAIL
- [ ] **Step 3: 実装** — `llm-assignments.ts`。balanced と 13-16行コメントを更新:

```ts
/**
 * プリセットのロール割当（固定）。バランスは会話のみローカル（速度優先）、
 * コーチング・教材生成・測定は品質優先で Claude（生成・測定は低頻度なため）。
 */
export const PRESETS: Record<PresetId, RoleTargets> = {
  "all-local": { conversation: "local", coaching: "local", generation: "local", assessment: "local" },
  balanced: { conversation: "local", coaching: "claude", generation: "claude", assessment: "claude" },
  "high-quality": { conversation: "claude", coaching: "claude", generation: "claude", assessment: "claude" },
};

/** 現在の割当が一致するプリセット（値一致・適用履歴ではない）。どれとも一致しなければ "custom"。 */
export function matchPreset(targets: RoleTargets): PresetId | "custom" {
  return (Object.keys(PRESETS) as PresetId[])
    .find((id) => LLM_ROLES.every((r) => PRESETS[id][r] === targets[r])) ?? "custom";
}
```

- [ ] **Step 4: i18n 文言更新** — EN `:341`: `presetBalancedDesc: "Conversation runs locally for speed; coaching, content generation, and assessment use Claude for quality.",` / JA `:659`: `presetBalancedDesc: "会話はローカルで速さを、コーチング・教材生成・測定は品質を優先して Claude を使います。",`
- [ ] **Step 5: 緑確認 + Commit** — Run: `cd app && bun test llm-assignments` → PASS。`git commit -m "feat: バランスの生成をClaudeへ変更し matchPreset（現在値→プリセット逆引き）を追加"`（文言変更を本文に明示）

### Task 4: プリセットのドロップダウンUI + 適用失敗時の巻き戻し

**Files:**
- Modify: `app/client/src/screens/SettingsScreen.tsx:8,118-129,179-190`
- Modify: `app/client/src/i18n.ts`（settings 型 + EN + JA に `presetCustom`・`presetBalancedOption` を追加）

**Interfaces:**
- Consumes: `matchPreset`（Task 3）、既存 `presetEnabled` / `applyPreset` / `PRESETS`
- Produces: なし（UI 最終消費）

- [ ] **Step 1: i18n キー追加** — 型（`presetLocalRequired` の下）: `presetCustom: string; presetBalancedOption: string;`。EN: `presetCustom: "Custom", presetBalancedOption: "Balanced (Recommended)",`。JA: `presetCustom: "カスタム", presetBalancedOption: "バランス（推奨）",`
- [ ] **Step 2: persist を成功可否返しに変更** — `SettingsScreen.tsx:118-129` を置換:

```tsx
  async function persist(nextTargets: RoleTargets, nextConn: Connection): Promise<boolean> {
    setSaving(true); setResult(null);
    try {
      applyResult(await saveLlmRoleSettings(buildRolesPayload(nextTargets, nextConn)));
      return true;
    } catch { setResult(s.llm.saveFailed); return false; } finally { setSaving(false); }
  }

  async function applyPreset(id: PresetId) {
    const prev = targets;
    const next = PRESETS[id];
    setTargets(next);
    if (!(await persist(next, conn))) setTargets(prev); // 失敗時は楽観更新を巻き戻す
  }
```

  ※ 他の `persist` 呼び出し（接続保存 `:216`・割当保存 `:237`）は戻り値を無視してよい（`void persist(...)` に変更）。
- [ ] **Step 3: プリセットブロックをドロップダウン化** — `:179-190` を置換:

```tsx
        {/* プリセット（現在の割当から逆引き表示。手動変更でカスタムに落ちる） */}
        <div className="stack">
          <div className="stat-title">{s.settings.presetSection}</div>
          {(() => {
            const current = matchPreset(targets);
            return (
              <>
                <select
                  className="llm-input" value={current} disabled={saving || !view}
                  aria-label={s.settings.presetSection}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "all-local" || v === "balanced" || v === "high-quality") void applyPreset(v);
                  }}
                >
                  {current === "custom" && <option value="custom" disabled>{s.settings.presetCustom}</option>}
                  <option value="all-local" disabled={!presetEnabled("all-local", conn)}>{s.settings.presetAllLocal}</option>
                  <option value="balanced" disabled={!presetEnabled("balanced", conn)}>{s.settings.presetBalancedOption}</option>
                  <option value="high-quality">{s.settings.presetHighQuality}</option>
                </select>
                {current === "all-local" && <div className="text-sm text-muted">{s.settings.presetAllLocalDesc}</div>}
                {current === "balanced" && <div className="text-sm text-muted">{s.settings.presetBalancedDesc}</div>}
                {current === "high-quality" && <div className="text-sm text-muted">{s.settings.presetHighQualityDesc}</div>}
                {!localDefined && <div className="text-sm text-muted">{s.settings.presetLocalRequired}</div>}
              </>
            );
          })()}
        </div>
```

  import に `matchPreset` を追加。`presetBalancedBadge` キーは未使用になるが**残置**（他画面流用の可能性より削除は Task 8 の文言整理と切り離す。未使用キーは無害）。
- [ ] **Step 4: 検証 + Commit** — `cd app && bun test && cd app/client && bun run build` → 緑。`git commit -m "feat: プリセットを現在値表示つきドロップダウンに変更し適用失敗時に巻き戻す"`

### Task 5: 設定画面のタブ分割（4タブ・2026-07-08 ユーザー指示で改訂）

> 改訂: 当初は「言語モデル（接続+割当）/音声/表示」の3タブだったが、ユーザー指示「モデルのURLを指定する画面と用途ごとのモデルを設定する画面はタブで分ける」により **接続 / 用途ごとのモデル / 音声 / 表示 の4タブ**に変更。state は全て親（SettingsScreen）にあるため接続⇔割当の結合は保存ロジック側で完結しており、タブ分割は表示だけの問題。
>
> 再改訂（ユーザー指示2・Task 5 実装後のフォローアップとして適用）: 音声（TTS）は独立タブにせず**接続タブへ統合**し、最終形は **接続（LLM+Codex+TTS）/ 用途ごとのモデル / 表示 の3タブ**。TTS の設定内容（baseUrl/モデル/声）は接続情報そのもののため。tab union は `"conn" | "roles" | "display"`、TTS ブロックは接続タブ内のサブ見出し（`ttsSection` の stat-title）として置き、ttsResult は TTS ブロック末尾に表示。

**Files:**
- Modify: `app/client/src/screens/SettingsScreen.tsx:66-73,169-290`
- Modify: `app/client/src/styles/app.css`（`.settings-tabs` 追加）
- Modify: `app/client/src/i18n.ts`（`presetLocalRequired` / `targetLocalDisabled` の文言をタブ参照に更新・EN/JA同時）

**Interfaces:**
- Consumes: 既存キー `settings.connectionSection` / `settings.roleAssignSection` / `settings.ttsSection` / `settings.displaySection`（タブラベルに流用・新キー不要）

- [ ] **Step 1: タブ state と result 分離** — `result` を `llmResult` / `ttsResult` の2つに分離（`persist`/`applyResult` は `setLlmResult`、`onSaveTts`/`onResetTts` は `setTtsResult` を使う）。タブ state を追加: `const [tab, setTab] = useState<"conn" | "roles" | "voice" | "display">("conn");`
- [ ] **Step 2: タブバー描画** — hero 直下に:

```tsx
      <div className="lang-toggle settings-tabs" role="tablist" aria-label={s.settings.title}>
        <button role="tab" aria-selected={tab === "conn"} className={tab === "conn" ? "is-active" : ""} onClick={() => setTab("conn")}>{s.settings.connectionSection}</button>
        <button role="tab" aria-selected={tab === "roles"} className={tab === "roles" ? "is-active" : ""} onClick={() => setTab("roles")}>{s.settings.roleAssignSection}</button>
        <button role="tab" aria-selected={tab === "voice"} className={tab === "voice" ? "is-active" : ""} onClick={() => setTab("voice")}>{s.settings.ttsSection}</button>
        <button role="tab" aria-selected={tab === "display"} className={tab === "display" ? "is-active" : ""} onClick={() => setTab("display")}>{s.settings.displaySection}</button>
      </div>
```

  セクション構成を再編する（**state は全て親にあるためタブ切替で入力は消えない**）:
  - `{tab === "conn" && ...}`: 接続セクション（claudeNoSetup 注記・ローカルLLM入力・Codex入力・APIキー注記・help・「接続を保存」ボタン）+ 末尾に `{llmResult && <div className="info-pop" role="status">{llmResult}</div>}`
  - `{tab === "roles" && ...}`: **プリセット（Task 4 のドロップダウン）を最上部**に置き、続けて用途別割当（4ロールのトグル + roleDesc）+「割当を保存」ボタン + 末尾に llmResult 表示（接続タブと同じ式を両タブに描画してよい）
  - `{tab === "voice" && ...}`: 音声（TTS）セクション + 末尾に `{ttsResult && ...}`（既存バグ修正: TTS の保存結果がタブ内に出る）
  - `{tab === "display" && ...}`: 表示セクション
  - 旧「言語モデル」見出し（`s.settings.llmSection` の `stat-title`）は不要になるが、**キーは残置**（削除しない）
- [ ] **Step 3: タブまたぎ案内文の更新（EN/JA同時・コミットに明示）** — 接続と割当が別タブになるため位置参照が壊れる:
  - `presetLocalRequired` EN: `"Set up a local LLM connection in the Connections tab to enable the local presets."` / JA: `"「接続」タブでローカル LLM の接続先を設定すると、ローカルを使うプリセットが選べます。"`
  - `targetLocalDisabled` EN: `"Set up a local LLM connection in the Connections tab to choose Local."` / JA: `"「接続」タブでローカル LLM の接続先を設定すると「ローカル」を選べます。"`
- [ ] **Step 4: CSS** — `app.css` の `.lang-toggle` 定義群の後に: `.settings-tabs { align-self: flex-start; }`（幅いっぱいに伸びるのを防ぐ。色・寸法は `.lang-toggle` を継承）
- [ ] **Step 5: 検証 + Commit** — `cd app/client && bun run build` → 緑。目視: タブ切替で入力保持・TTS保存結果が音声タブに出る・プリセット適用が用途ごとのモデルタブで完結する。`git commit -m "feat: 設定画面を接続/用途ごとのモデル/音声/表示の4タブに分割し保存結果表示をタブ別に修正"`

### Task 6: サイドバーに言語・文字サイズ切替を常設

**Files:**
- Modify: `app/client/src/App.tsx:129-131`（sidebar-spacer 直後）
- Modify: `app/client/src/styles/app.css:247-253`（860px メディアクエリ）

**Interfaces:**
- Consumes: App 既存の `lang/switchLang/uiScale/setUiScale`、i18n 既存キー `appShell.textSize`（"Text size"/"文字サイズ"）・`appShell.language`・`uiScale.*`（EN: A−/A/A＋/A＋＋、JA: 小/中/大/特大）

- [ ] **Step 1: 実装** — `App.tsx` の `<div className="sidebar-spacer" />` と `<SupportPanel .../>` の間に:

```tsx
        <div className="sidebar-quick">
          <div className="lang-toggle" role="group" aria-label={t.appShell.textSize}>
            {(["small", "medium", "large", "xlarge"] as const).map((sc) => (
              <button key={sc} className={uiScale === sc ? "is-active" : ""} onClick={() => setUiScale(sc)}>{t.uiScale[sc]}</button>
            ))}
          </div>
          <div className="lang-toggle" role="group" aria-label={t.appShell.language}>
            <button className={lang === "en" ? "is-active" : ""} onClick={() => switchLang("en")}>EN</button>
            <button className={lang === "ja" ? "is-active" : ""} onClick={() => switchLang("ja")}>日本語</button>
          </div>
        </div>
```

- [ ] **Step 2: CSS** — `app.css`: `.sidebar-quick { display: flex; flex-direction: column; gap: var(--sp-2); }` を追加し、860px メディアクエリ内（`.sidebar-spacer { display: none; }` の隣）に `.sidebar-quick { display: none; }`
- [ ] **Step 3: 検証 + Commit** — `cd app/client && bun run build` → 緑。`git commit -m "feat: サイドバー下部に言語と文字サイズの切替を常設"`

### Task 7: 用途ごとの推奨理由の表示 + README 更新

**Files:**
- Modify: `app/client/src/i18n.ts:74`（型: roleDesc の下に `roleReason: Record<LlmRole, string>;`）+ EN `:335` の後 + JA `:653` の後
- Modify: `app/client/src/screens/SettingsScreen.tsx:226`（roleDesc 行の直後）
- Modify: `README.md:153-158`（ロール表）・`:162`（バランス説明）・`:192`（使い分けの目安）

- [ ] **Step 1: i18n 追加** — EN:

```ts
      roleReason: {
        conversation: "Recommended: local — fastest responses. Switch to Claude or Codex if quality falls short.",
        coaching: "Recommended: Claude or Codex — writing quality matters more than speed.",
        generation: "Recommended: local — fairly templated output with modest quality demands. Switch to Claude for higher quality.",
        assessment: "Recommended: Claude — runs infrequently and quality matters most.",
      },
```

  JA:

```ts
      roleReason: {
        conversation: "推奨: ローカル — 応答が最も速いため。品質が物足りなければ Claude や Codex へ。",
        coaching: "推奨: Claude / Codex — 速度より文章の品質が重要なため。",
        generation: "推奨: ローカル — 出力が定型的で要求性能は低め。品質を上げたいときは Claude へ。",
        assessment: "推奨: Claude — 実行頻度が低く、質の高さが最優先のため。",
      },
```

  さらに「性能が効く順」の目立つ表示（ユーザー指示・2026-07-08）: 新キー `roleQualityNote` を追加し、用途ごとのモデルタブの最上部（プリセットの上）に `.info-pop` で表示する:
  - 型: `roleQualityNote: string;`（roleReason の下）
  - EN: `"Where model quality matters most: Assessment > Coaching > Content generation. Conversation benefits more from response speed."`
  - JA: `"モデル性能が効く順: 測定 > コーチング > 教材生成。会話は性能より応答の速さが効きます。"`
  - JSX（roles タブ先頭・プリセットの stat-title の直前）: `<div className="info-pop">{s.settings.roleQualityNote}</div>`

- [ ] **Step 2: 表示** — `SettingsScreen.tsx` の `roleDesc` 行直後に: `<div className="text-sm text-muted">{s.settings.roleReason[role]}</div>`
- [ ] **Step 3: README** — ロール表に「推奨」列を追加（会話=ローカル / コーチング=Claude・Codex / 教材生成=Claude / 測定=Claude、理由を1行ずつ）。`:162` のバランス説明を「会話=ローカル、コーチング・教材生成・測定=Claude」に更新。`:192` の使い分けの目安を同内容に更新。Codex の但し書き（手動割当のみ・プロンプトは Claude 向け調整）は既存記述を維持
- [ ] **Step 4: 検証 + Commit** — `cd app/client && bun run build` → 緑。`git commit -m "feat: 用途ごとのモデル推奨と理由を設定画面とREADMEに追加"`

### Task 8: メニュー文言見直し + AGENTS.md 規約改定

**Files:**
- Modify: `app/client/src/i18n.ts`（EN `:386,393` / JA 対応行）
- Modify: `AGENTS.md`（クライアント規約の i18n 行）

- [ ] **Step 1: 文言変更（EN/JA 同時）** — spec A-7 の対照表どおり:
  - `drills["ftt-mini"]` EN: `{ title: "Repeat Talk (4/3/2)", minutes: "8 min", desc: "Tell the same story twice, faster each time" }` / JA: `{ title: "くり返しトーク（4/3/2）", minutes: "8分", desc: "同じ話を2回、制限時間を短くしながら流暢に" }`
  - `nav.listening` JA: `"リスニング（多聴）"`（EN "Listening" は明瞭なので不変）
  - `shortSession` EN title は "Short Session" のまま / JA title: `"短縮セッション"`（desc は両言語とも不変）
- [ ] **Step 2: AGENTS.md 改定** — 「**i18n は named 型辞書（`src/i18n.ts`）**: 型 + `STR.en` + `STR.ja` の3点を同時に追加。**既存キーの日本語文言は一字一句変更しない**（変更は明示の合意があるときのみ）。文字列の直書き禁止。」を次に置換:

```md
- **i18n は named 型辞書（`src/i18n.ts`）**: 型 + `STR.en` + `STR.ja` の3点を同時に追加・変更する。文言は利用者のわかりやすさ優先で改善してよいが、**EN/JA を必ず同時に更新**し、ユーザーに見える文言変更はコミットメッセージで明示する。文字列の直書き禁止。
```

- [ ] **Step 3: 検証 + Commit** — `cd app/client && bun run build` → 緑。`git commit -m "feat: メニュー文言を行為が伝わる表現へ改善し i18n 規約を改定（4/3/2ミニ→くり返しトーク等）"`

### Task 10: GitHubリンクと About 画面（2026-07-08 ユーザー追加要望・Task 8 の後、Task 9 の前に実施）

**Files:**
- Modify: `app/client/src/App.tsx`（Mode union に `{ kind: "about" }` 追加・サイドバー下部にリンク行・render 分岐）
- Create: `app/client/src/screens/AboutScreen.tsx`
- Modify: `app/client/src/i18n.ts`（`AboutStrings` ドメイン新設: 型 + EN + JA）
- Modify: `app/client/src/styles/app.css`（`.sidebar-links` / `.side-link`）

**Interfaces:**
- Produces: `AboutScreen({ lang }: { lang: Lang })`。リンク先は GitHub `https://github.com/okash1n/solo-eikaiwa` / LP `https://okash1n.github.io/solo-eikaiwa/`（外部リンクは `target="_blank" rel="noopener noreferrer"`）

- [ ] **Step 1: i18n** — 型 `type AboutStrings = { about: { title: string; desc: string; lpButton: string; githubButton: string; license: string } }` を交差型に追加し、EN/JA:
  - EN: `title: "About"`, `desc: "solo-eikaiwa is a local-first English speaking gym for daily self-study — recording, transcription, AI conversation, and speech all run on your Mac."`, `lpButton: "Visit the website"`, `githubButton: "View on GitHub"`, `license: "Open source under the MIT License."`
  - JA: `title: "このアプリについて"`, `desc: "solo-eikaiwa は、録音・文字起こし・AI 会話・音声合成まで自分の Mac の上で完結する、毎日のひとり英会話ジムです。"`, `lpButton: "紹介ページ（LP）を開く"`, `githubButton: "GitHub リポジトリを開く"`, `license: "MIT ライセンスのオープンソースです。"`
- [ ] **Step 2: AboutScreen** — hero 見出し（`about.title`）+ ブランド行（`app-brand` と同じ `brand-mark` + `solo-eikaiwa`）+ `about.desc` + ボタン2つ（LP=primary 相当の `<a class="cta">` か `Button` 内 `window.open` ではなく素の `<a>` にボタン風クラス）+ `about.license`（`text-sm text-muted`）。既存の `Screen`/`card` イディオムに合わせる
- [ ] **Step 3: サイドバー** — `PracticeStat` の下に:

```tsx
        <div className="sidebar-links">
          <a className="side-link" href="https://github.com/okash1n/solo-eikaiwa" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
          </a>
          <button className="side-link" onClick={() => setMode({ kind: "about" })}>{t.about.title}</button>
        </div>
```

  Mode union と render 分岐（`{mode.kind === "about" && <AboutScreen lang={lang} />}`）を追加。CSS: `.sidebar-links { display: flex; align-items: center; gap: var(--sp-3); } .side-link { display: inline-flex; align-items: center; gap: var(--sp-1); font: inherit; font-size: var(--fs-sm); color: var(--text-muted); background: none; border: none; padding: 0; cursor: pointer; text-decoration: none; } .side-link:hover { color: var(--text); }`。860px 以下では `.sidebar-links { display: none; }`（他のフッター要素と同じ扱い）
- [ ] **Step 4: 検証 + Commit** — 3ゲート緑。`git commit -m "feat: サイドバーにGitHubリンクとAbout画面（LPへの導線）を追加"`

### Task 9: 統合検証とマージ

- [ ] **Step 1: 3ゲート** — `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build` → 全緑
- [ ] **Step 2: 目視スモーク** — スタート画面: 濃淡カレンダー+凡例（ライト/ダーク）。設定: 3タブ・ドロップダウン現在値（オールローカル適用済み環境では「オールローカル」表示のはず）・推奨理由表示。サイドバー: 切替動作・860px 以下で非表示
- [ ] **Step 3: main へマージ** — `git checkout main && git merge --no-ff feat/ui-feedback-pack -m "Merge branch 'feat/ui-feedback-pack': フィードバック一括対応（アプリUI）"`（タグ・CHANGELOG・デプロイはパックB完了後の v0.22.0 で一括）
