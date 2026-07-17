# Phase C: プレースメント（初期レベル見極め・月次再測定） Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 約10分の測定セッション（自己紹介→状況説明→意見）を録音・文字起こしし、Claude が CEFR 記述子ベースのルーブリックで stage(1..6) と開始レベルを推定、利用者の確定操作で反映する。月次再測定の導線もホームに出す。

**Architecture:** サーバは `placement.ts`（タスク定義・評価・SQLite ストア）を新設し、routes/RouteDeps の既存 DI パターンに4エンドポイントを追加。評価は coach.ts と同じ ClaudeRunner 注入＋`extractJson` 耐性パターン。クライアントは `PlacementScreen` を新設し、既存の Recorder / `/api/stt` / TimerChip / i18n 辞書の規約に従う。レベル反映は progress-store に `placementSet`（level_events kind: `placement-set`）を追加して行う。

**Tech Stack:** Bun + TypeScript / bun:sqlite / Claude Agent SDK（ClaudeRunner 注入） / React + Vite

## Global Constraints

- スペック `docs/superpowers/specs/2026-07-06-adaptive-progression-design.md` §6 が正。§2 研究制約: **測定結果は利用者が確定するまで反映しない**・根拠は開示・情報トーン（欠損・失敗を責める文言禁止）
- プレースメントの3タスク文面（instruction / promptText）は**毎回同一**（月次比較のため定数化）。文面は完全オリジナル
- 音声はローカル STT（既存 `/api/stt`）でテキスト化し、Claude 評価は**テキストのみ**を送る
- 開始レベル `startLevel = (stage - 1) * 10 + 3`（スペック §6.2）
- 測定完了 XP は 10 固定（スペック §4.1。progress-store の `XP_CAPS.placement` 実装済み）。**HTTP の /api/progress/xp は kind="placement" を拒否したまま**（付与はサーバ内部のみ）
- 月次再測定は**レベルに自動反映しない**（§6.3。確定操作も新規測定と同じ confirm を通る）
- 追加のみ: 既存 210 サーバテスト・既存 HTTP 契約は不変。RouteDeps 追加フィールドは必須にする
- 日付・経過日数の判定はサーバに新設しない（30日判定はクライアントで `ts` から計算）
- コミットは Conventional Commits（日本語）。ゲート: `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build`
- クライアント規約: alive-guard（StrictMode の mount リセット込み）・unmount で `stopPlayback()` と `Recorder.cancel()`・fetch 失敗の再試行導線・i18n 辞書は EN/JA 両方（デフォルト EN）
- App.tsx の保護行（`sessionId`/`startedRef`/lifecycle `useEffect` 本体/health バナー3種/`PracticeStat` 本体）は変更禁止。許可される変更は Task 2/3 の各ステップに列挙したもののみ

---

### Task 1: サーバ — placement タスク定義・評価・保存・API

**Files:**
- Create: `app/server/placement.ts`
- Create: `app/server/__tests__/placement.test.ts`
- Modify: `app/server/db.ts`（openDb に placement_results テーブル追加）
- Modify: `app/server/progress-store.ts`（`placementSet` 追加）
- Modify: `app/server/__tests__/progress-store.test.ts`（placementSet のテスト追加）
- Modify: `app/server/routes.ts`（RouteDeps 追加 + 4ルート）
- Modify: `app/server/__tests__/routes.test.ts`（makeTestDeps 拡張 + 契約テスト）
- Modify: `app/server/index.ts`（配線）

**Interfaces:**
- Consumes: `extractJson`（coach.ts）、`makeClaudeRunner`/`ClaudeRunner`（converse.ts — coach.ts と同じ呼び方 `runner(prompt, undefined, { systemPrompt })`。**実装前に converse.ts の実シグネチャを確認**し、coach.ts の defaultRunner 定義に合わせる）、`openDb`（db.ts）、progress-store の `getSummary`/`getLevel`/`addXp`
- Produces（Task 2/3 が依存）:
  - `PLACEMENT_TASKS: readonly PlacementTaskDef[]`（`{ id, durationSec, instructionEn, instructionJa, promptText }`）
  - `GET /api/placement/tasks` → `{ tasks: PlacementTaskDef[] }`
  - `POST /api/placement/submit` `{ tasks: [{ taskId, transcript, durationSec, wordCount }] }` → 200 `{ stage, startLevel, rationale }` / 400 / 502（評価パース不能）
  - `POST /api/placement/confirm` `{ accept: boolean, level?: number }` → `ProgressSummary`（accept=true & level 省略時は最新測定の startLevel を適用）
  - `GET /api/placement/latest` → `{ result: null | { id, ts, stage, startLevel, rationale } }`
  - `ProgressStore.placementSet(level, today?)` → `ProgressSummary | null`（level_events kind `placement-set`）

- [ ] **Step 1: placement.test.ts に失敗するテストを書く**

```typescript
import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import {
  evaluatePlacement, makePlacementStore, PLACEMENT_TASKS, startLevelForStage,
  type PlacementSubmission,
} from "../placement";
import type { ClaudeRunner } from "../converse";

/** 固定テキストを返すフェイク runner（coach.test.ts と同じ流儀） */
function runnerReturning(text: string): ClaudeRunner {
  return async () => ({ text, sessionId: "fake" });
}

const SUBS: PlacementSubmission[] = PLACEMENT_TASKS.map((t) => ({
  taskId: t.id, transcript: "I work as an engineer and I like coffee.", durationSec: 30, wordCount: 9,
}));

describe("placement: タスク定義", () => {
  test("3タスク・id一意・durationSec正・instruction両言語・promptText非空", () => {
    expect(PLACEMENT_TASKS).toHaveLength(3);
    expect(new Set(PLACEMENT_TASKS.map((t) => t.id)).size).toBe(3);
    for (const t of PLACEMENT_TASKS) {
      expect(t.durationSec).toBeGreaterThan(0);
      expect(t.instructionEn.length).toBeGreaterThan(0);
      expect(t.instructionJa.length).toBeGreaterThan(0);
      expect(t.promptText.length).toBeGreaterThan(0);
    }
  });
});

describe("placement: startLevelForStage", () => {
  test("スペック§6.2: (stage-1)*10+3", () => {
    expect(startLevelForStage(1)).toBe(3);
    expect(startLevelForStage(2)).toBe(13);
    expect(startLevelForStage(6)).toBe(53);
  });
});

describe("placement: evaluatePlacement", () => {
  test("正常JSONを stage/startLevel/rationaleJa に整形する", async () => {
    const r = await evaluatePlacement(SUBS, runnerReturning('{"stage": 2, "rationaleJa": "簡単な文は言えます。過去形が不安定です。"}'));
    expect(r).toEqual({ stage: 2, startLevel: 13, rationaleJa: "簡単な文は言えます。過去形が不安定です。" });
  });

  test("```jsonフェンス付きでもパースできる", async () => {
    const r = await evaluatePlacement(SUBS, runnerReturning('```json\n{"stage": 4, "rationaleJa": "説明が滑らかです。"}\n```'));
    expect(r?.stage).toBe(4);
    expect(r?.startLevel).toBe(33);
  });

  test("stage が範囲外・非整数・欠落なら null", async () => {
    expect(await evaluatePlacement(SUBS, runnerReturning('{"stage": 0, "rationaleJa": "x"}'))).toBeNull();
    expect(await evaluatePlacement(SUBS, runnerReturning('{"stage": 7, "rationaleJa": "x"}'))).toBeNull();
    expect(await evaluatePlacement(SUBS, runnerReturning('{"stage": 2.5, "rationaleJa": "x"}'))).toBeNull();
    expect(await evaluatePlacement(SUBS, runnerReturning('{"rationaleJa": "x"}'))).toBeNull();
  });

  test("rationaleJa が欠落・空なら null / 非JSONテキストなら null", async () => {
    expect(await evaluatePlacement(SUBS, runnerReturning('{"stage": 2}'))).toBeNull();
    expect(await evaluatePlacement(SUBS, runnerReturning('{"stage": 2, "rationaleJa": "  "}'))).toBeNull();
    expect(await evaluatePlacement(SUBS, runnerReturning("I think stage 2 is right."))).toBeNull();
  });

  test("プロンプトに客観指標（語数・密度）と全transcriptが入る", async () => {
    let seen = "";
    const spy: ClaudeRunner = async (prompt) => { seen = prompt; return { text: '{"stage":2,"rationaleJa":"x"}', sessionId: "s" }; };
    await evaluatePlacement(SUBS, spy);
    expect(seen).toContain("9 words in 30s");
    expect(seen).toContain("0.30 words/sec");
    expect(seen).toContain("I work as an engineer");
    for (const t of PLACEMENT_TASKS) expect(seen).toContain(t.promptText);
  });
});

describe("placement: store", () => {
  test("save → latest が保存内容を返す（空DBでは null）", () => {
    const db = openDb(":memory:");
    const store = makePlacementStore(db);
    expect(store.latest()).toBeNull();
    const saved = store.save({ stage: 3, startLevel: 23, rationale: "理由", metrics: [{ taskId: "self-intro", wordCount: 9, durationSec: 30, density: 0.3 }] });
    expect(saved.id).toBeGreaterThan(0);
    const latest = store.latest();
    expect(latest).toMatchObject({ stage: 3, startLevel: 23, rationale: "理由" });
    expect(latest!.ts.length).toBeGreaterThan(0);
  });

  test("複数保存で latest は最後の1件", () => {
    const db = openDb(":memory:");
    const store = makePlacementStore(db);
    store.save({ stage: 2, startLevel: 13, rationale: "a", metrics: [] });
    store.save({ stage: 3, startLevel: 23, rationale: "b", metrics: [] });
    expect(store.latest()!.stage).toBe(3);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `cd app && bun test __tests__/placement.test.ts`
Expected: FAIL（`placement.ts` が存在しない）

- [ ] **Step 3: db.ts の openDb に placement_results を追加**

`app/server/db.ts` の `block_attempts` の CREATE 文の直後に追加（スペック §8.1 の DDL そのまま）:

```typescript
  db.run(`CREATE TABLE IF NOT EXISTS placement_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, stage INTEGER NOT NULL, start_level INTEGER NOT NULL,
    rationale TEXT NOT NULL, metrics TEXT NOT NULL
  )`);
```

- [ ] **Step 4: placement.ts を実装**

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "bun:sqlite";
import { extractJson } from "./coach";
import { makeClaudeRunner, type ClaudeRunner } from "./converse";

export type PlacementTaskDef = {
  id: string;
  durationSec: number;
  instructionEn: string;
  instructionJa: string;
  /** 画面に表示する状況・問いの本文。月次比較のため毎回同一（変更しないこと） */
  promptText: string;
};

/** スペック§6.1: 自己紹介1分 → 状況説明1.5分 → 意見1分（文面は固定・完全オリジナル） */
export const PLACEMENT_TASKS: readonly PlacementTaskDef[] = [
  {
    id: "self-intro",
    durationSec: 60,
    instructionEn: "Introduce yourself: your job and what you have been interested in lately.",
    instructionJa: "自己紹介: 仕事の内容と、最近関心を持っていることを話してください。",
    promptText: "Tell me about your work and something you have been into recently.",
  },
  {
    id: "describe-situation",
    durationSec: 90,
    instructionEn: "Read the situation below, then explain it in your own words in English.",
    instructionJa: "下の状況を読み、自分の言葉で英語で説明してください。",
    promptText:
      "This morning you had an online meeting, but you could not join for the first ten minutes because your laptop kept restarting. You finally joined from your phone, apologized, and asked a colleague to fill you in later. Explain what happened and how you handled it.",
  },
  {
    id: "give-opinion",
    durationSec: 60,
    instructionEn: "Say whether you agree or disagree, with one or two reasons.",
    instructionJa: "賛成か反対かを、理由を1〜2つ添えて述べてください。",
    promptText: "Some people say everyone should work from home most of the week. Do you agree or disagree?",
  },
];

export type PlacementSubmission = { taskId: string; transcript: string; durationSec: number; wordCount: number };
export type PlacementEvaluation = { stage: number; startLevel: number; rationaleJa: string };

/** スペック§6.2: 開始レベルはステージ中央やや下 */
export function startLevelForStage(stage: number): number {
  return (stage - 1) * 10 + 3;
}

const defaultRunner: ClaudeRunner = makeClaudeRunner(query);

/** stage 1..6 ↔ CEFR A2前半〜B2 の話し言葉記述子。プロンプトに明文で埋め込む（スペック§6.2） */
const RUBRIC = `Stage rubric (spoken production, CEFR-informed; stage 1-6):
- Stage 1 (~A2 low): Mostly short phrases and memorized patterns. Long searches for words. Present tense dominates; errors sometimes block understanding. Very little said for the time available.
- Stage 2 (~A2 high): Connected simple sentences with "and / but / because". Can describe work and daily life in plain terms. Errors are frequent but rarely block understanding.
- Stage 3 (~B1 low): Sustains a short monologue with a recognizable beginning and end. Uses past and future forms with partial control. Works around missing words; noticeable pauses.
- Stage 4 (~B1 high): Comfortable narration and explanation with varied connectors. Gives opinions with simple reasons. Occasional self-correction; errors persist but flow is smooth.
- Stage 5 (~B2 low): Clear, detailed descriptions. Develops an argument with supporting points. Good control of common structures; pace is close to natural.
- Stage 6 (~B2): Speaks fluently and spontaneously. Varies phrasing, handles complex sentences mostly accurately, and defends a viewpoint smoothly.`;

const EVAL_SYSTEM = `You are a CEFR-informed speaking assessor for a Japanese adult learner of English.
You receive transcripts of three short spoken tasks (self-introduction, situation explanation, opinion) with objective stats (word count, words per second).
${RUBRIC}
Judge the OVERALL spoken level across all three transcripts. The transcripts come from automatic speech recognition: ignore punctuation and casing; judge range, grammatical control, coherence, and how much the speaker managed to say in the time.
Reply with STRICT JSON only — no markdown fences, no commentary — exactly this shape:
{"stage": <integer 1-6>, "rationaleJa": "<2〜3行の簡潔な日本語。観察された強み・根拠と、次に伸ばすと良い点。責める表現は使わない>"}
Do not use any tools — reply directly with text only.`;

/** 3タスクの評価。LLM出力が不正形状なら null（ルートは502にして再試行を促す） */
export async function evaluatePlacement(
  submissions: PlacementSubmission[],
  runner: ClaudeRunner = defaultRunner,
): Promise<PlacementEvaluation | null> {
  const sections = submissions.map((s) => {
    const def = PLACEMENT_TASKS.find((t) => t.id === s.taskId);
    const density = s.durationSec > 0 ? (s.wordCount / s.durationSec).toFixed(2) : "0.00";
    return [
      `## Task: ${s.taskId}`,
      `Prompt: ${def?.promptText ?? ""}`,
      `Stats: ${s.wordCount} words in ${s.durationSec}s (${density} words/sec)`,
      `Transcript:`,
      s.transcript,
    ].join("\n");
  });
  const { text } = await runner(sections.join("\n\n"), undefined, { systemPrompt: EVAL_SYSTEM });
  const parsed = extractJson<{ stage?: unknown; rationaleJa?: unknown }>(text);
  if (!parsed) return null;
  const { stage, rationaleJa } = parsed;
  if (typeof stage !== "number" || !Number.isInteger(stage) || stage < 1 || stage > 6) return null;
  if (typeof rationaleJa !== "string" || !rationaleJa.trim()) return null;
  return { stage, startLevel: startLevelForStage(stage), rationaleJa };
}

export type PlacementResultRow = { id: number; ts: string; stage: number; startLevel: number; rationale: string };
export type PlacementStore = {
  save(r: { stage: number; startLevel: number; rationale: string; metrics: unknown }): PlacementResultRow;
  latest(): PlacementResultRow | null;
};

type DbRow = { id: number; ts: string; stage: number; start_level: number; rationale: string };

export function makePlacementStore(db: Database): PlacementStore {
  return {
    save(r) {
      const ts = new Date().toISOString();
      db.run(
        "INSERT INTO placement_results (ts, stage, start_level, rationale, metrics) VALUES (?, ?, ?, ?, ?)",
        [ts, r.stage, r.startLevel, r.rationale, JSON.stringify(r.metrics)],
      );
      const row = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!;
      return { id: row.id, ts, stage: r.stage, startLevel: r.startLevel, rationale: r.rationale };
    },
    latest() {
      const row = db
        .query<DbRow, []>("SELECT id, ts, stage, start_level, rationale FROM placement_results ORDER BY id DESC LIMIT 1")
        .get();
      if (!row) return null;
      return { id: row.id, ts: row.ts, stage: row.stage, startLevel: row.start_level, rationale: row.rationale };
    },
  };
}
```

注意: `ClaudeRunner` の実シグネチャが coach.ts の呼び方（`runner(prompt, undefined, { systemPrompt })`）と一致することを converse.ts で確認してから書くこと。違っていたら coach.ts の defaultRunner と同じ形に合わせる（テストのフェイクも同様）。

- [ ] **Step 5: placement.test.ts が通ることを確認**

Run: `cd app && bun test __tests__/placement.test.ts`
Expected: PASS（全件）

- [ ] **Step 6: progress-store.test.ts に placementSet のテストを追加**

既存の describe 群の末尾に追加（既存テストのヘルパ `makeDb`/日付固定の流儀に合わせる。実ファイルのヘルパ名を確認して合わせること）:

```typescript
describe("progress-store: placementSet", () => {
  test("レベルを変更し placement-set が level_events に記録される", () => {
    const db = openDb(":memory:");
    const store = makeProgressStore(db);
    store.getSummary("2026-07-06"); // ensureRow（Lv13）
    const s = store.placementSet(23, "2026-07-06");
    expect(s!.level).toBe(23);
    expect(s!.xpIntoLevel).toBe(0);
    const ev = db.query<{ kind: string; from_level: number; to_level: number }, []>(
      "SELECT kind, from_level, to_level FROM level_events ORDER BY id DESC LIMIT 1").get()!;
    expect(ev).toEqual({ kind: "placement-set", from_level: 13, to_level: 23 });
  });

  test("同一レベルは no-op（xp_into_level 維持・イベント無し）/ 不正値は null", () => {
    const db = openDb(":memory:");
    const store = makeProgressStore(db);
    store.addXp("block", 6, {}, "2026-07-06"); // xpIntoLevel=6
    const s = store.placementSet(13, "2026-07-06");
    expect(s!.xpIntoLevel).toBe(6);
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM level_events").get()!;
    expect(count.n).toBe(0);
    expect(store.placementSet(0, "2026-07-06")).toBeNull();
    expect(store.placementSet(2.5, "2026-07-06")).toBeNull();
  });
});
```

- [ ] **Step 7: 実行して失敗を確認 → placementSet を実装**

Run: `cd app && bun test __tests__/progress-store.test.ts` → FAIL（placementSet 不在）

`app/server/progress-store.ts`:
1. `ProgressStore` 型に追加: `/** プレースメント確定によるレベル設定（level_events kind: placement-set）。同一レベルは no-op */ placementSet(level: number, today?: string): ProgressSummary | null;`
2. 実装は `levelAction("set")` と同じ検証・同じ no-op 規則で、イベント kind だけ変える。重複を避けるため内部ヘルパに抽出する:

```typescript
  /** set系の共通処理。eventKind だけが異なる（manual-set / placement-set） */
  function setLevelTo(level: number | undefined, eventKind: "manual-set" | "placement-set", today: string): ProgressSummary | null {
    const row = ensureRow();
    if (level === undefined || !Number.isInteger(level) || level < 1 || level > 999) return null;
    // 同一レベルへの set は no-op（xp_into_level を維持し、level_events も記録しない）
    if (level === row.level) return summarize(row, today);
    recordLevelEvent(eventKind, row.level, level, null, today);
    row.level = level;
    row.xp_into_level = 0;
    save(row);
    return summarize(row, today);
  }
```

`levelAction` の `action === "set"` 分岐を `return setLevelTo(level, "manual-set", today);` に置き換え、公開メソッドに `placementSet(level, today = localYmd()) { return setLevelTo(level, "placement-set", today); }` を追加。

Run: `cd app && bun test __tests__/progress-store.test.ts` → PASS（既存含む全件）

- [ ] **Step 8: routes.test.ts に API 契約テストを追加**

まず `makeTestDeps` に必須フィールドを追加（`...overrides` より前）:

```typescript
    placementStore: {
      save: (r: { stage: number; startLevel: number; rationale: string; metrics: unknown }) =>
        ({ id: 1, ts: "2026-07-06T00:00:00.000Z", stage: r.stage, startLevel: r.startLevel, rationale: r.rationale }),
      latest: () => null,
    } as RouteDeps["placementStore"],
    evaluatePlacement: async () => ({ stage: 2, startLevel: 13, rationaleJa: "簡単な文は安定しています。" }),
```

progressStore フェイクに `placementSet` を追加（既存フェイクの levelAction と同じ流儀で、呼び出し記録を残せる形に）。テスト本体:

```typescript
describe("placement API", () => {
  const VALID_TASKS = [
    { taskId: "self-intro", transcript: "I am an engineer.", durationSec: 40, wordCount: 4 },
    { taskId: "describe-situation", transcript: "My laptop restarted before the meeting.", durationSec: 60, wordCount: 6 },
    { taskId: "give-opinion", transcript: "I agree because commuting takes time.", durationSec: 35, wordCount: 6 },
  ];

  test("GET /api/placement/tasks は3タスク定義を返す", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(new Request("http://x/api/placement/tasks"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ id: string; durationSec: number; instructionJa: string; promptText: string }> };
    expect(body.tasks).toHaveLength(3);
    expect(body.tasks.map((t) => t.id)).toEqual(["self-intro", "describe-situation", "give-opinion"]);
  });

  test("POST submit: 評価結果を保存して返し、placement XP(10) を内部付与する", async () => {
    const xpCalls: Array<{ kind: string; amount: number }> = [];
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      progressStore: {
        ...makeTestDeps().deps.progressStore,
        addXp: (kind: string, amount: number) => { xpCalls.push({ kind, amount }); return FAKE_SUMMARY; },
      } as RouteDeps["progressStore"],
      placementStore: {
        save: (r: unknown) => { saved.push(r); return { id: 1, ts: "t", stage: 2, startLevel: 13, rationale: "r" }; },
        latest: () => null,
      } as RouteDeps["placementStore"],
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/placement/submit", {
      method: "POST", body: JSON.stringify({ tasks: VALID_TASKS }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stage: 2, startLevel: 13, rationale: "簡単な文は安定しています。" });
    expect(saved).toHaveLength(1);
    expect(xpCalls).toEqual([{ kind: "placement", amount: 10 }]);
  });

  test("POST submit の400系: 件数不足・未知taskId・重複taskId・空transcript・不正duration/wordCount", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const post = (tasks: unknown) =>
      handler(new Request("http://x/api/placement/submit", { method: "POST", body: JSON.stringify({ tasks }) }));
    expect((await post(VALID_TASKS.slice(0, 2))).status).toBe(400);
    expect((await post([{ ...VALID_TASKS[0], taskId: "nope" }, VALID_TASKS[1], VALID_TASKS[2]])).status).toBe(400);
    expect((await post([VALID_TASKS[0], VALID_TASKS[0], VALID_TASKS[2]])).status).toBe(400);
    expect((await post([{ ...VALID_TASKS[0], transcript: "  " }, VALID_TASKS[1], VALID_TASKS[2]])).status).toBe(400);
    expect((await post([{ ...VALID_TASKS[0], durationSec: 0 }, VALID_TASKS[1], VALID_TASKS[2]])).status).toBe(400);
    expect((await post([{ ...VALID_TASKS[0], wordCount: -1 }, VALID_TASKS[1], VALID_TASKS[2]])).status).toBe(400);
  });

  test("POST submit: 評価が null なら 502 で保存しない", async () => {
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      evaluatePlacement: async () => null,
      placementStore: {
        save: (r: unknown) => { saved.push(r); return { id: 1, ts: "t", stage: 2, startLevel: 13, rationale: "r" }; },
        latest: () => null,
      } as RouteDeps["placementStore"],
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/placement/submit", {
      method: "POST", body: JSON.stringify({ tasks: VALID_TASKS }),
    }));
    expect(res.status).toBe(502);
    expect(saved).toHaveLength(0);
  });

  test("POST confirm: accept=false は summary を返すだけ（レベル操作なし・キャッシュ無効化なし）", async () => {
    const invalidated: string[] = [];
    const placementSetCalls: number[] = [];
    const { deps } = makeTestDeps({
      invalidateMenuCache: () => { invalidated.push("x"); },
    });
    (deps.progressStore as { placementSet: (l: number) => unknown }).placementSet =
      (l: number) => { placementSetCalls.push(l); return FAKE_SUMMARY; };
    const res = await makeFetchHandler(deps)(new Request("http://x/api/placement/confirm", {
      method: "POST", body: JSON.stringify({ accept: false }),
    }));
    expect(res.status).toBe(200);
    expect(placementSetCalls).toHaveLength(0);
    expect(invalidated).toHaveLength(0);
  });

  test("POST confirm: accept=true + level 省略は最新測定の startLevel を適用しキャッシュ無効化", async () => {
    const invalidated: string[] = [];
    const placementSetCalls: number[] = [];
    const { deps } = makeTestDeps({
      invalidateMenuCache: () => { invalidated.push("x"); },
      placementStore: {
        save: () => ({ id: 1, ts: "t", stage: 3, startLevel: 23, rationale: "r" }),
        latest: () => ({ id: 1, ts: "t", stage: 3, startLevel: 23, rationale: "r" }),
      } as RouteDeps["placementStore"],
    });
    (deps.progressStore as { placementSet: (l: number) => unknown }).placementSet =
      (l: number) => { placementSetCalls.push(l); return FAKE_SUMMARY; };
    const res = await makeFetchHandler(deps)(new Request("http://x/api/placement/confirm", {
      method: "POST", body: JSON.stringify({ accept: true }),
    }));
    expect(res.status).toBe(200);
    expect(placementSetCalls).toEqual([23]);
    expect(invalidated).toHaveLength(1);
  });

  test("POST confirm: accept=true + 明示 level はそれを適用 / 測定なし+level省略は400 / 不正bodyは400", async () => {
    const placementSetCalls: number[] = [];
    const { deps } = makeTestDeps();
    (deps.progressStore as { placementSet: (l: number) => unknown }).placementSet =
      (l: number) => { placementSetCalls.push(l); return FAKE_SUMMARY; };
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://x/api/placement/confirm", {
      method: "POST", body: JSON.stringify({ accept: true, level: 31 }),
    }));
    expect(ok.status).toBe(200);
    expect(placementSetCalls).toEqual([31]);
    // makeTestDeps デフォルトの latest() は null
    const noLatest = await handler(new Request("http://x/api/placement/confirm", {
      method: "POST", body: JSON.stringify({ accept: true }),
    }));
    expect(noLatest.status).toBe(400);
    const badAccept = await handler(new Request("http://x/api/placement/confirm", {
      method: "POST", body: JSON.stringify({ accept: "yes" }),
    }));
    expect(badAccept.status).toBe(400);
  });

  test("GET /api/placement/latest は {result: null} または最新1件", async () => {
    const { deps } = makeTestDeps();
    const res1 = await makeFetchHandler(deps)(new Request("http://x/api/placement/latest"));
    expect(await res1.json()).toEqual({ result: null });
    const { deps: deps2 } = makeTestDeps({
      placementStore: {
        save: () => ({ id: 1, ts: "t", stage: 3, startLevel: 23, rationale: "r" }),
        latest: () => ({ id: 9, ts: "2026-07-06T00:00:00.000Z", stage: 3, startLevel: 23, rationale: "r" }),
      } as RouteDeps["placementStore"],
    });
    const res2 = await makeFetchHandler(deps2)(new Request("http://x/api/placement/latest"));
    expect(await res2.json()).toEqual({ result: { id: 9, ts: "2026-07-06T00:00:00.000Z", stage: 3, startLevel: 23, rationale: "r" } });
  });
});
```

注意: `FAKE_SUMMARY` は routes.test.ts 既存のフェイク summary 定数名に合わせる（存在しなければ既存 progressStore フェイクが返している summary 値を再利用）。progressStore フェイクへの `placementSet` 追加は既存フェイク定義側にデフォルト実装（`() => FAKE_SUMMARY`）として追加し、テスト個別で上書きする形にすると型が単純になる — 実ファイルの構造を見て崩れない方を選ぶこと。

- [ ] **Step 9: 実行して失敗を確認 → routes.ts を実装**

Run: `cd app && bun test __tests__/routes.test.ts` → FAIL

`app/server/routes.ts`:
1. import 追加: `import { PLACEMENT_TASKS, type PlacementEvaluation, type PlacementStore, type PlacementSubmission } from "./placement";`
2. `RouteDeps` に必須フィールド追加（progressStore の下）:

```typescript
  /** プレースメント測定結果の保存と最新取得（実体は placement.ts、テストはフェイク） */
  placementStore: PlacementStore;
  /** 3タスクの評価。LLM出力が不正なら null（ルートは502で再試行を促す） */
  evaluatePlacement: (subs: PlacementSubmission[]) => Promise<PlacementEvaluation | null>;
```

3. ハンドラ2つ（handleProgressLevel の下に配置）:

```typescript
async function handlePlacementSubmit(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ tasks?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const tasks = parsed.body.tasks;
  if (!Array.isArray(tasks) || tasks.length !== PLACEMENT_TASKS.length) {
    return json({ error: `tasks must be an array of ${PLACEMENT_TASKS.length} submissions` }, 400);
  }
  const subs: PlacementSubmission[] = [];
  for (const raw of tasks as Array<Record<string, unknown>>) {
    const def = PLACEMENT_TASKS.find((d) => d.id === raw?.taskId);
    if (!def) return json({ error: "unknown taskId" }, 400);
    if (subs.some((s) => s.taskId === def.id)) return json({ error: "duplicate taskId" }, 400);
    if (typeof raw.transcript !== "string" || !raw.transcript.trim()) {
      return json({ error: "transcript is required for every task" }, 400);
    }
    if (typeof raw.durationSec !== "number" || raw.durationSec <= 0 || raw.durationSec > 600) {
      return json({ error: "durationSec must be between 1 and 600" }, 400);
    }
    if (typeof raw.wordCount !== "number" || !Number.isInteger(raw.wordCount) || raw.wordCount < 0 || raw.wordCount > 2000) {
      return json({ error: "wordCount must be an integer between 0 and 2000" }, 400);
    }
    subs.push({ taskId: def.id, transcript: raw.transcript, durationSec: raw.durationSec, wordCount: raw.wordCount });
  }
  const ev = await deps.evaluatePlacement(subs);
  if (!ev) return json({ error: "evaluation failed — please try submitting again" }, 502);
  deps.placementStore.save({
    stage: ev.stage, startLevel: ev.startLevel, rationale: ev.rationaleJa,
    metrics: subs.map((s) => ({
      taskId: s.taskId, wordCount: s.wordCount, durationSec: s.durationSec,
      density: s.durationSec > 0 ? s.wordCount / s.durationSec : 0,
    })),
  });
  // 測定完了XP（スペック§4.1: 10固定）。付与失敗で測定結果は失敗させない
  try {
    deps.progressStore.addXp("placement", 10, {});
  } catch (err) {
    console.warn("[placement] xp grant failed, continuing:", String(err));
  }
  return json({ stage: ev.stage, startLevel: ev.startLevel, rationale: ev.rationaleJa });
}

async function handlePlacementConfirm(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ accept?: unknown; level?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { accept, level } = parsed.body;
  if (typeof accept !== "boolean") return json({ error: "accept must be a boolean" }, 400);
  // 「今回は反映しない」— 測定履歴は submit 時点で保存済みなので何も変更しない（スペック§6.3）
  if (!accept) return json(deps.progressStore.getSummary());
  let target: number;
  if (level !== undefined) {
    if (typeof level !== "number") return json({ error: "level must be a number" }, 400);
    target = level;
  } else {
    const latest = deps.placementStore.latest();
    if (!latest) return json({ error: "no placement result to accept" }, 400);
    target = latest.startLevel;
  }
  const previous = deps.progressStore.getLevel();
  const s = deps.progressStore.placementSet(target);
  if (!s) return json({ error: "level must be an integer between 1 and 999" }, 400);
  // レベルが実際に変わったときだけ当日メニューを再構築する（manual-set と同じ規則）
  if (previous !== target) deps.invalidateMenuCache();
  return json(s);
}
```

4. `makeFetchHandler` のルート表（progress 系の下）に追加:

```typescript
      if (req.method === "GET" && url.pathname === "/api/placement/tasks") return json({ tasks: PLACEMENT_TASKS });
      if (req.method === "POST" && url.pathname === "/api/placement/submit") return await handlePlacementSubmit(req, deps);
      if (req.method === "POST" && url.pathname === "/api/placement/confirm") return await handlePlacementConfirm(req, deps);
      if (req.method === "GET" && url.pathname === "/api/placement/latest") return json({ result: deps.placementStore.latest() });
```

- [ ] **Step 10: index.ts を配線**

```typescript
// import に追加
import { evaluatePlacement, makePlacementStore } from "./placement";
// ストア生成（progressStore の下）
const placementStore = makePlacementStore(db);
// realDeps に追加（progressStore の下）
  placementStore,
  evaluatePlacement: (subs) => evaluatePlacement(subs),
```

- [ ] **Step 11: 全ゲート**

Run: `cd app && bun test` → 全件 PASS（210 + 新規）
Run: `cd app && bun run typecheck` → 0 errors

- [ ] **Step 12: コミット**

```bash
git add app/server/placement.ts app/server/__tests__/placement.test.ts app/server/db.ts \
  app/server/progress-store.ts app/server/__tests__/progress-store.test.ts \
  app/server/routes.ts app/server/__tests__/routes.test.ts app/server/index.ts
git commit -m "feat: プレースメント評価・保存・APIのサーバ基盤を追加"
```

---

### Task 2: クライアント — プレースメント測定画面

**Files:**
- Create: `app/client/src/screens/PlacementScreen.tsx`
- Modify: `app/client/src/api.ts`（型と4関数）
- Modify: `app/client/src/i18n.ts`（placement 辞書 EN/JA）
- Modify: `app/client/src/App.tsx`（Mode 追加・画面分岐のみ — 保護行に触れない）

**Interfaces:**
- Consumes: Task 1 の4エンドポイント / 既存 `Recorder`・`stopPlayback`（audio.ts）・`sttUpload`・`useCountdown`/`formatMmSs`・`TimerChip`/`Card`/`Button`/`Banner`・`notifyProgress`/`fetchProgressSummary`
- Produces（Task 3 が依存）: `Mode` union の `{ kind: "placement" }` と `<PlacementScreen lang onExit>`、api.ts の `fetchPlacementLatest()`（StartScreen 導線カードが使用）

- [ ] **Step 1: api.ts に型と関数を追加**

`gradeSentence` の下に追加:

```typescript
export type PlacementTaskDef = {
  id: string; durationSec: number; instructionEn: string; instructionJa: string; promptText: string;
};
export type PlacementResult = { stage: number; startLevel: number; rationale: string };
export type PlacementLatest = { id: number; ts: string; stage: number; startLevel: number; rationale: string } | null;

export async function fetchPlacementTasks(): Promise<PlacementTaskDef[]> {
  const res = await fetch("/api/placement/tasks");
  if (!res.ok) throw new Error(`placement tasks failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { tasks: PlacementTaskDef[] }).tasks;
}

export async function submitPlacement(
  tasks: Array<{ taskId: string; transcript: string; durationSec: number; wordCount: number }>,
): Promise<PlacementResult> {
  const res = await fetch("/api/placement/submit", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tasks }),
  });
  if (!res.ok) throw new Error(`placement submit failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function confirmPlacement(accept: boolean, level?: number): Promise<ProgressSummary> {
  const res = await fetch("/api/placement/confirm", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept, level }),
  });
  if (!res.ok) throw new Error(`placement confirm failed: ${await extractErrorMessage(res)}`);
  const summary = (await res.json()) as ProgressSummary;
  notifyProgress(summary);
  return summary;
}

export async function fetchPlacementLatest(): Promise<PlacementLatest> {
  const res = await fetch("/api/placement/latest");
  if (!res.ok) throw new Error(`placement latest failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { result: PlacementLatest }).result;
}
```

- [ ] **Step 2: i18n.ts に placement 辞書を追加**

`Strings` 型の `progress` の下に追加:

```typescript
  placement: {
    cardTitleNew: string; cardBodyNew: string;
    cardTitleMonthly: string; cardBodyMonthly: string;
    introTitle: string; introBody: string; introStart: string;
    taskLabel: (i: number, total: number) => string;
    promptLabel: string;
    recordStart: string; recordStop: string; transcribing: string;
    yourAnswer: string; redo: string; next: string; submit: string;
    submitting: string; submitError: string; retry: string;
    resultTitle: string; resultStage: (stage: number) => string;
    resultStartAt: (level: number) => string; chooseOwn: string; notNow: string;
    chooseLabel: string; apply: string; confirmError: string;
    xpNote: string;
  };
```

EN 辞書（`progress` の下）:

```typescript
    placement: {
      cardTitleNew: "Find your level (10 min)",
      cardBodyNew: "Three short speaking tasks set your starting level",
      cardTitleMonthly: "Monthly level check",
      cardBodyMonthly: "It's been a month — see how your speaking has moved",
      introTitle: "Level check",
      introBody: "You'll do three short speaking tasks: introduce yourself (1 min), explain a situation (1.5 min), and give an opinion (1 min). Record each one — the result only applies if you accept it.",
      introStart: "Start task 1",
      taskLabel: (i, total) => `Task ${i} of ${total}`,
      promptLabel: "Your prompt",
      recordStart: "🎙 Start speaking", recordStop: "⏹ Stop recording", transcribing: "📝 Transcribing…",
      yourAnswer: "Your answer", redo: "Record again", next: "Next task →", submit: "Get my result →",
      submitting: "Scoring your three tasks…",
      submitError: "Scoring didn't come back cleanly. Your recordings are kept — just submit again.",
      retry: "Submit again",
      resultTitle: "Your result",
      resultStage: (stage) => `Estimated stage: ${stage} of 6`,
      resultStartAt: (level) => `Start at Lv ${level}`,
      chooseOwn: "Choose my own level", notNow: "Not this time",
      chooseLabel: "Level (1–999)", apply: "Apply",
      confirmError: "Couldn't apply. Please try again.",
      xpNote: "+10 XP for completing the check",
    },
```

JA 辞書:

```typescript
    placement: {
      cardTitleNew: "レベル測定（10分）",
      cardBodyNew: "3つの短いスピーキングで開始レベルを決めます",
      cardTitleMonthly: "月次レベル測定",
      cardBodyMonthly: "前回から1ヶ月 — 話す力の変化を見てみましょう",
      introTitle: "レベル測定",
      introBody: "3つの短いスピーキングを行います: 自己紹介（1分）→ 状況説明（1.5分）→ 意見（1分）。それぞれ録音してください。結果はあなたが承認したときだけ反映されます。",
      introStart: "タスク1を始める",
      taskLabel: (i, total) => `タスク ${i} / ${total}`,
      promptLabel: "お題",
      recordStart: "🎙 話し始める", recordStop: "⏹ 録音を止める", transcribing: "📝 文字起こし中…",
      yourAnswer: "あなたの回答", redo: "録音し直す", next: "次のタスクへ →", submit: "結果を見る →",
      submitting: "3つのタスクを採点しています…",
      submitError: "採点結果をうまく受け取れませんでした。録音は保持されています — もう一度送信してください。",
      retry: "もう一度送信",
      resultTitle: "測定結果",
      resultStage: (stage) => `推定ステージ: ${stage} / 6`,
      resultStartAt: (level) => `Lv ${level} から始める`,
      chooseOwn: "自分でレベルを選ぶ", notNow: "今回は反映しない",
      chooseLabel: "レベル（1〜999）", apply: "適用",
      confirmError: "適用できませんでした。もう一度お試しください",
      xpNote: "測定完了で +10 XP",
    },
```

- [ ] **Step 3: PlacementScreen.tsx を実装**

```tsx
import { useEffect, useRef, useState } from "react";
import {
  confirmPlacement, fetchPlacementTasks, sttUpload, submitPlacement,
  type PlacementResult, type PlacementTaskDef,
} from "../api";
import { Recorder, stopPlayback } from "../audio";
import { STR, type Lang } from "../i18n";
import { formatMmSs, useCountdown } from "../useCountdown";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { TimerChip } from "../ui/TimerChip";

type Step =
  | { kind: "loading" }
  | { kind: "load-error"; message: string }
  | { kind: "intro" }
  | { kind: "task"; index: number }
  | { kind: "submitting" }
  | { kind: "submit-error"; message: string }
  | { kind: "result"; result: PlacementResult };
type RecState = "idle" | "recording" | "transcribing";

function wordCountOf(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * プレースメント測定（スペック§6）: 3タスクを順に録音→STT→全件そろったら評価に送る。
 * 結果は利用者が確定操作をするまでレベルに反映しない（研究制約§2）。
 */
export function PlacementScreen(props: { lang: Lang; onExit: () => void }) {
  const t = STR[props.lang].placement;
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [tasks, setTasks] = useState<PlacementTaskDef[]>([]);
  const [recState, setRecState] = useState<RecState>("idle");
  const [transcripts, setTranscripts] = useState<string[]>([]);
  const [durations, setDurations] = useState<number[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  // 結果画面の確定操作
  const [choosing, setChoosing] = useState(false);
  const [chooseValue, setChooseValue] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState(false);

  const recorderRef = useRef(new Recorder());
  const recordStartRef = useRef(0);
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);
  const timer = useCountdown(60);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      loadTasks();
    }
    return () => {
      aliveRef.current = false;
      recorderRef.current.cancel();
      stopPlayback();
    };
  }, []);

  async function loadTasks() {
    setStep({ kind: "loading" });
    try {
      const defs = await fetchPlacementTasks();
      if (!aliveRef.current) return;
      setTasks(defs);
      setTranscripts(Array(defs.length).fill(""));
      setDurations(Array(defs.length).fill(0));
      setStep({ kind: "intro" });
    } catch (err) {
      if (!aliveRef.current) return;
      setStep({ kind: "load-error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function startTask(index: number) {
    setErrorMsg("");
    setRecState("idle");
    timer.reset(tasks[index].durationSec);
    setStep({ kind: "task", index });
  }

  async function toggleRecording(index: number) {
    setErrorMsg("");
    if (recState === "idle") {
      try {
        await recorderRef.current.start();
        recordStartRef.current = Date.now();
        setRecState("recording");
        if (!timer.running && !timer.expired) timer.start();
      } catch (err) {
        setErrorMsg(`マイクにアクセスできません: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (recState !== "recording") return;
    try {
      setRecState("transcribing");
      const blob = await recorderRef.current.stop();
      const elapsed = Math.max(1, Math.round((Date.now() - recordStartRef.current) / 1000));
      if (!aliveRef.current) return;
      const text = await sttUpload(blob);
      if (!aliveRef.current) return;
      // 測定なので録り直しは「置き換え」（追記しない）
      setTranscripts((prev) => prev.map((v, i) => (i === index ? text : v)));
      setDurations((prev) => prev.map((v, i) => (i === index ? elapsed : v)));
      setRecState("idle");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setRecState("idle");
    }
  }

  function redo(index: number) {
    setTranscripts((prev) => prev.map((v, i) => (i === index ? "" : v)));
    setDurations((prev) => prev.map((v, i) => (i === index ? 0 : v)));
    timer.reset(tasks[index].durationSec);
  }

  async function submitAll() {
    setStep({ kind: "submitting" });
    try {
      const result = await submitPlacement(tasks.map((def, i) => ({
        taskId: def.id,
        transcript: transcripts[i],
        durationSec: durations[i],
        wordCount: wordCountOf(transcripts[i]),
      })));
      if (!aliveRef.current) return;
      setStep({ kind: "result", result });
    } catch (err) {
      if (!aliveRef.current) return;
      setStep({ kind: "submit-error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function confirm(accept: boolean, level?: number) {
    setConfirmBusy(true);
    setConfirmError(false);
    try {
      await confirmPlacement(accept, level);
      if (!aliveRef.current) return;
      props.onExit();
    } catch (err) {
      if (!aliveRef.current) return;
      console.warn("placement confirm failed:", err);
      setConfirmError(true);
    } finally {
      if (aliveRef.current) setConfirmBusy(false);
    }
  }

  if (step.kind === "loading") return <p>…</p>;

  if (step.kind === "load-error") {
    return (
      <Banner kind="error" action={<Button onClick={loadTasks}>↻</Button>}>
        {step.message}
      </Banner>
    );
  }

  if (step.kind === "intro") {
    return (
      <div className="stack">
        <Card header={t.introTitle}>
          <p className="text-muted">{t.introBody}</p>
          <p className="text-sm text-muted">{t.xpNote}</p>
        </Card>
        <Button variant="primary" size="lg" onClick={() => startTask(0)}>{t.introStart}</Button>
      </div>
    );
  }

  if (step.kind === "task") {
    const i = step.index;
    const def = tasks[i];
    const instruction = props.lang === "ja" ? def.instructionJa : def.instructionEn;
    const hasAnswer = transcripts[i].trim().length > 0;
    const isLast = i === tasks.length - 1;
    return (
      <div className="stack">
        <Card header={`${t.taskLabel(i + 1, tasks.length)} — ${instruction}`}>
          <p className="text-sm text-muted">{t.promptLabel}:</p>
          <p className="reading-text">{def.promptText}</p>
          <TimerChip remaining={timer.remaining} expired={timer.expired} />
        </Card>
        <div className="start-row">
          <button
            className={`btn btn-primary btn-lg record-btn${recState === "recording" ? " is-recording" : ""}`}
            onClick={() => toggleRecording(i)}
            disabled={recState === "transcribing"}
          >
            {recState === "recording" ? t.recordStop : recState === "transcribing" ? t.transcribing : t.recordStart}
          </button>
          {hasAnswer && recState === "idle" && (
            <Button onClick={() => redo(i)}>{t.redo}</Button>
          )}
          {hasAnswer && recState === "idle" && (
            <Button variant="primary" onClick={() => (isLast ? submitAll() : startTask(i + 1))}>
              {isLast ? t.submit : t.next}
            </Button>
          )}
        </div>
        {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
        {hasAnswer && (
          <Card header={t.yourAnswer}>
            <p className="reading-text">{transcripts[i]}</p>
          </Card>
        )}
      </div>
    );
  }

  if (step.kind === "submitting") {
    return <p>{t.submitting}</p>;
  }

  if (step.kind === "submit-error") {
    return (
      <div className="stack">
        <Banner kind="error">{t.submitError}</Banner>
        <p className="text-sm text-muted">{step.message}</p>
        <Button variant="primary" onClick={submitAll}>{t.retry}</Button>
      </div>
    );
  }

  // result
  const { result } = step;
  return (
    <div className="stack">
      <Card header={t.resultTitle}>
        <p><strong>{t.resultStage(result.stage)}</strong></p>
        <p className="reading-text">{result.rationale}</p>
        <p className="text-sm text-muted">{t.xpNote}</p>
      </Card>
      {confirmError && <Banner kind="error">{t.confirmError}</Banner>}
      {!choosing ? (
        <div className="start-row">
          <Button variant="primary" onClick={() => confirm(true, result.startLevel)} disabled={confirmBusy}>
            {t.resultStartAt(result.startLevel)}
          </Button>
          <Button onClick={() => { setChooseValue(String(result.startLevel)); setChoosing(true); }} disabled={confirmBusy}>
            {t.chooseOwn}
          </Button>
          <Button variant="ghost" onClick={() => confirm(false)} disabled={confirmBusy}>{t.notNow}</Button>
        </div>
      ) : (
        <div className="start-row">
          <label className="text-sm text-muted">
            {t.chooseLabel}{" "}
            <input
              className="level-input" type="number" min={1} max={999} value={chooseValue} autoFocus
              onChange={(e) => setChooseValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm(true, Number(chooseValue));
                else if (e.key === "Escape") setChoosing(false);
              }}
            />
          </label>
          <Button variant="primary" onClick={() => confirm(true, Number(chooseValue))} disabled={confirmBusy}>
            {t.apply}
          </Button>
          <Button variant="ghost" onClick={() => setChoosing(false)} disabled={confirmBusy}>{t.notNow}</Button>
        </div>
      )}
    </div>
  );
}
```

注意:
- `Button` の `size` prop の実名（`size="lg"` か `variant` 併用の別 prop か）は `ui/Button.tsx` を確認して合わせる。無ければ `size` を渡さない
- `TimerChip` の props（`remaining`/`expired`/`note`）は実装を確認して合わせる
- `timer.reset(seconds)` は `useCountdown` の実 API を確認（FourThreeTwoScreen が `timer.reset(roundsSec[index])` を使っているのでこの形で良いはず）

- [ ] **Step 4: App.tsx に Mode と画面分岐を追加（許可された変更のみ）**

許可される変更は次の3点のみ。**それ以外の行（sessionId/startedRef/useEffect 本体/health バナー/PracticeStat/navItems/lang toggle）には触れない**:

1. import 追加: `import { PlacementScreen } from "./screens/PlacementScreen";`
2. Mode union に追加:

```typescript
type Mode = { kind: "start" } | { kind: "free" } | { kind: "session"; source: MenuSource } | { kind: "library" } | { kind: "sentences" } | { kind: "placement" };
```

3. `{mode.kind === "sentences" && <SentencesScreen />}` の下に分岐追加:

```tsx
      {mode.kind === "placement" && <PlacementScreen lang={lang} onExit={() => setMode({ kind: "start" })} />}
```

（導線は Task 3 の StartScreen カードから。Task 2 時点では UI から到達できないが、ビルド健全性はこの時点で担保する）

- [ ] **Step 5: ゲート**

Run: `cd app/client && bun run build` → PASS
Run: `cd app && bun test` → Task 1 完了時点と同数 PASS（クライアント変更でサーバは不変）

- [ ] **Step 6: コミット**

```bash
git add app/client/src/screens/PlacementScreen.tsx app/client/src/api.ts app/client/src/i18n.ts app/client/src/App.tsx
git commit -m "feat: プレースメント測定画面を追加"
```

---

### Task 3: 導線・ドキュメント仕上げ

**Files:**
- Modify: `app/client/src/screens/StartScreen.tsx`（導線カード）
- Modify: `README.md`（できること: レベル/XP/プレースメント）
- Modify: `CHANGELOG.md`（0.3.0）

**Interfaces:**
- Consumes: `fetchPlacementLatest`（Task 2）、`StartSelection`/`onSelect`（既存）、i18n placement 辞書（Task 2）
- Produces: `StartSelection` union に `{ type: "placement" }`（App.tsx の onSelect 分岐追加を含む）

- [ ] **Step 1: StartScreen に導線カードを追加**

1. `StartSelection` union に `| { type: "placement" }` を追加
2. App.tsx の `onSelect` に分岐を1行追加（これも Task 3 の許可変更）:

```typescript
    else if (sel.type === "placement") setMode({ kind: "placement" });
```

（`sel.type === "library"` の分岐の下に置く）

3. StartScreen 本体: import に `fetchPlacementLatest, type PlacementLatest` を追加し、state と初回フェッチに追加:

```typescript
  const [placementLatest, setPlacementLatest] = useState<PlacementLatest | "unloaded">("unloaded");
```

初回 useEffect 内（既存の fetchProgressSummary の下）:

```typescript
      fetchPlacementLatest().then((r) => { if (aliveRef.current) setPlacementLatest(r); }).catch(() => {});
```

4. カード種別の導出（コンポーネント本体・return の前）:

```typescript
  // プレースメント導線: 未測定→初回測定 / 前回から30日以上→月次測定 / それ以外は出さない（スペック§6.3, §9）
  const placementCard: "new" | "monthly" | "none" = (() => {
    if (placementLatest === "unloaded") return "none";
    if (placementLatest === null) return "new";
    const days = Math.floor((Date.now() - new Date(placementLatest.ts).getTime()) / 86400000);
    return days >= 30 ? "monthly" : "none";
  })();
```

5. JSX: 提案カード（`{summary?.proposal && ...}`）の直前に追加:

```tsx
      {placementCard !== "none" && (
        <button className="drill-card" onClick={() => props.onSelect({ type: "placement" })}>
          <span className="drill-icon c-purple" aria-hidden="true">📐</span>
          <span className="drill-body">
            <span className="drill-title">{placementCard === "new" ? tp.cardTitleNew : tp.cardTitleMonthly}</span>
            <span className="drill-desc">{placementCard === "new" ? tp.cardBodyNew : tp.cardBodyMonthly}</span>
          </span>
          <span className="drill-arrow" aria-hidden="true">→</span>
        </button>
      )}
```

（`const tp = STR[props.lang].placement;` を `const t = STR[props.lang];` の下に追加）

- [ ] **Step 2: ゲート（クライアント）**

Run: `cd app/client && bun run build` → PASS

- [ ] **Step 3: コミット（機能分）**

```bash
git add app/client/src/screens/StartScreen.tsx app/client/src/App.tsx
git commit -m "feat: ホームにプレースメント導線カードを追加（初回・月次30日）"
```

- [ ] **Step 4: README 更新**

「できること」の「📚 ライブラリと練習記録」セクションの前に追加:

```markdown
### 📐 レベルとプレースメント

練習の難易度はレベル（Lv1〜、上限なし）が駆動します。4/3/2 の持ち時間・準備支援の厚さ・お題の帯域がレベルに応じてなだらかに変化し、ブロック完了や例文の自己評価で貯まる XP がレベルを押し上げます。ステージ境界（Lv10/20/…）だけは自動で跨がず、実績（練習日数・完了率）を根拠つきで提示して承認制で昇格します。降格も「調整の提案」としてのみ出ます — XP は減らず、自動降格もありません（動機づけ研究の知見に沿った情報的フィードバック設計です）。

初回は**レベル測定（約10分）**がおすすめ: 自己紹介 → 状況説明 → 意見の3タスクを録音すると、CEFR 記述子ベースのルーブリックで開始レベルが提示されます（反映するかはあなたが決めます）。以後は30日ごとに月次測定の導線が出て、話す力の変化を定点観測できます。
```

- [ ] **Step 5: CHANGELOG に 0.3.0 を追加**

`## [0.2.0]` の前に挿入:

```markdown
## [0.3.0] - 2026-07-06

### Added

- **レベル・XP システム**: レベル（Lv1〜・上限なし）が 4/3/2 の持ち時間、準備チャンク数、ヒント言語、モデルトーク表示、お題の帯域を駆動。ブロック完了・例文自己評価・測定完了で XP が貯まり、ステージ内は自動レベルアップ、ステージ境界（Lv10/20/30/40/50）は実績根拠つきの提案＋承認制。降格は中立表現の提案のみ（自動降格なし・XP は減らない）
- **プレースメント（レベル測定）**: 自己紹介→状況説明→意見の3タスク（約10分）を録音し、CEFR 記述子ベースのルーブリックで開始レベルを提示。反映は利用者の確定操作制。30日ごとに月次測定の導線をホームに表示
- **コンテンツの3ドメイン化**: お題・シナリオに `domain`（daily/business/it）と `level`（適合ステージ範囲）タグを追加し、選択はドメインのラウンドロビン＋帯域フィルタ＋LRU。日常会話4本・一般ビジネス4本のロールプレイシナリオを新規追加（計16本）
- サイドバーにレベルゲージ（クリックで手動変更）、ホームに昇格/降格提案カード

### Changed

- 4/3/2 のラウンド秒数が固定値（120/90/60）からレベル連動（90〜180秒の線形）に。デフォルト開始は Lv13（従来よりやや易しい）
- 日次メニューは日内固定になり、手動レベル変更時のみ当日再構築

[0.3.0]: https://github.com/okash1n/learn-english/compare/v0.2.0...v0.3.0
```

（既存のリンク定義セクションに `[0.3.0]` 行を移すこと — Keep a Changelog の既存形式ではリンク定義はファイル末尾に集約されているため、本文には入れず末尾の `[0.2.0]:` の上の行に置く）

- [ ] **Step 6: 全ゲート**

Run: `cd app && bun test` → 全件 PASS
Run: `cd app && bun run typecheck` → 0 errors
Run: `cd app/client && bun run build` → PASS

- [ ] **Step 7: コミット（ドキュメント分）**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: READMEとCHANGELOGにレベル・プレースメント（0.3.0）を追記"
```

---

## 手動E2Eスモーク（マージ前にコントローラがブラウザで実施）

1. ホームに「Find your level (10 min)」カードが出る（未測定 DB の場合）
2. カード→intro→タスク1で録音→停止→文字起こしが表示され「Record again」「Next task」が出る
3. タスク3まで進めて submit → 結果画面に stage・日本語の根拠・3ボタンが出る
4. 「Start at Lv N」→ ホームに戻り、サイドバーのレベルが N に更新・ゲージ反映（pub-sub 経由）
5. ホームのプレースメントカードが消えている（30日以内なので）
6. 日英トグルで placement 系文言が切り替わる（promptText は英語のまま＝仕様）
7. `data/learn-english.db` の placement_results に1行、level_events に placement-set、xp_events に placement 10 が入っている

## Self-Review チェックリスト（計画筆者向け・完了済み）

- スペック §6 全要件がタスクに割当て済み（6.1 タスク構成=Task1 定数/6.2 評価・ルーブリック・startLevel=Task1/確定操作制=Task1 confirm+Task2 結果画面/6.3 月次30日導線・自動反映なし=Task3 カード+confirm 経由）
- プレースホルダなし（全ステップに実コード）。型整合: PlacementSubmission/PlacementEvaluation/PlacementStore は routes・api.ts・PlacementScreen で同形
- ルーブリック記述子は stage1〜6 すべて具体的（発話量・時制制御・接続詞・自己修正・密度）
- 既存テストへの影響: routes.test.ts の makeTestDeps に必須2フィールド追加のみ（既存テストは修正不要）。progress-store は追加メソッドのみ
- 研究制約: 評価プロンプトに「責める表現は使わない」を明記。confirm は accept=false を第一級で用意。エラーメッセージも中立
