# v0.24 プロバイダ大改修 Plan A（サーバ基盤） Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude/Codex の対称アーキテクチャ（claude -p フォールバック・型付きエラー・タイムアウト統一・重複解消）、assist 第5ロール、ロール別チューニング（model/effort/tier）のサーバ基盤を作る（spec: `docs/superpowers/specs/2026-07-08-provider-overhaul-design.md` §1-§3。UI/認証/リリースは Plan B）。

**Architecture:** `providers/errors.ts`（中立 TransportError）と `providers/transcript.ts`（共有ヘルパ）を土台に、`withTimeout`/`withFallback` デコレータで ClaudeRunner 契約のまま横断関心を重ね、`claude-print.ts`（`claude -p` ワンショット・ネイティブ resume）を Claude のフォールバックに配線する。ロールは5値（assist 新設・行不在は coaching へ連鎖）、チューニングは新テーブル `llm_role_tuning` + ロール cfg として selectRunner→ランナーへ流し、codex は単一常駐プロセスのまま thread/start・resume の per-thread パラメータで受ける。

**Tech Stack:** Bun + TypeScript、bun:sqlite、bun:test（フェイク注入 seam）。

## Global Constraints

- 検証ゲート（全タスク）: `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build` 全緑
- `ClaudeRunner` 型は不変: `(prompt: string, resumeId?: string, opts?: { systemPrompt?: string }) => Promise<{ text: string; sessionId: string }>`
- **設定を変えなければ挙動完全同一**（工場既定 sonnet・SDK 単一参照・assist 連鎖・tuning センチネルで保証）。「claude/env に戻すと module-level claudeRunner と同一参照」回帰基準を維持
- サーバ新ロジックは TDD（赤→緑）。実プロセス（spawn）部分は単体テスト対象外・手動スモーク（`realCodexExec`/`realSpawnAppServer` の先例コメント様式）
- スキーマは `CREATE TABLE IF NOT EXISTS` の新テーブルのみ（列追加・マイグレーション禁止）
- タイムアウト既定 180_000ms・タイムアウト/接続系失敗は `TransportError`・モデル起因（subtype エラー・空応答）はフォールバックしない
- effort 語彙: `"low" | "medium" | "high" | "xhigh"`（claude/codex 共通）。claude model 語彙: `"haiku" | "sonnet" | "opus"`（エイリアス）。tier 語彙: `"fast" | "standard"`（codex のみ）
- 優先順位: **ロール tuning > env（CODEX_REASONING_EFFORT / CODEX_SERVICE_TIER / 新設 CLAUDE_MODEL / CLAUDE_EFFORT）> コード既定（claude: sonnet + effort 未指定 / codex: medium + fast）**
- ブランチ: `feat/provider-overhaul`（main から作成）。リリースは Plan B 末尾で v0.24.0 一括

## 事前に読むべき現行コード（実装者向けアンカー）

- `app/server/converse.ts`: ClaudeRunner 型(:29-33)・makeClaudeRunner(:35-71・query options に systemPrompt/model:"sonnet"/tools:[]/maxTurns:1/resume)・module-level claudeRunner(:85)・currentRunners/roleWrappers/runnerFor/applyLlmRoleSettings(:100-150)
- `app/server/llm-provider.ts`: selectRunner(:63-98・codex 分岐は getCodexAppServerRunner+execFallback)・settingsToEnv(:112-124)・LLM_ROLES
- `app/server/providers/codex-app-server.ts`: TransportError(:6-16 付近)・CodexAppServerClient・threadParams・buildRunner・registry（単一スロット・connectionKey）・DEFAULT_REQUEST_TIMEOUT_MS
- `app/server/providers/codex.ts` / `openai-compat.ts`: インメモリ Map + `resumeId && store.has(resumeId) ? resumeId : crypto.randomUUID()` パターン（transcript 抽出対象）
- `app/server/llm-role-settings-store.ts` + `routes/llm-settings.ts`（parseSettingsInput 2パス・ROLE_PROVIDERS）・`app/server/index.ts:58-104`（runnerFor 配線・coach 系の注入）
- `app/server/coach.ts`: generateUtteranceTranslation(:95)・generatePhraseHints(:115)・generateFixExplanation(:147) — assist へ付替える3箇所
- `app/server/paths.ts`（DATA_DIR / ensureDirs）・`app/server/db.ts`（openDb の ensure 配線）

---

### Task 1: providers/errors.ts — TransportError の中立化

**Files:**
- Create: `app/server/providers/errors.ts`
- Modify: `app/server/providers/codex-app-server.ts`（定義削除→import）
- Test: 既存 `app/server/__tests__/codex-app-server-*.test.ts` が緑のまま（import 元変更のみ）

**Interfaces:**
- Produces: `export class TransportError extends Error { constructor(message: string, opts?: { cause?: unknown }) }`（現定義を移設・拡張しない）

- [ ] **Step 1**: `errors.ts` を作成し codex-app-server.ts の `TransportError` 定義を移設（doc コメント「プロバイダ中立の транспорт層エラー。フォールバック判定の唯一の根拠」を付す）。codex-app-server.ts は `import { TransportError } from "./errors";` + `export { TransportError }`（既存テストの import 互換維持）
- [ ] **Step 2**: `cd app && bun test codex-app-server` → 全緑（挙動不変の確認）。全体 `bun test` + `typecheck`
- [ ] **Step 3**: Commit `refactor: TransportErrorをproviders/errors.tsへ中立化（依存方向の是正）`

### Task 2: providers/transcript.ts — 共有トランスクリプトヘルパ（TDD）

**Files:**
- Create: `app/server/providers/transcript.ts` / Test: `app/server/__tests__/transcript.test.ts`
- Modify: `app/server/providers/openai-compat.ts` / `codex.ts` / `codex-app-server.ts`（三重複を置換）

**Interfaces:**
- Produces（逐語）:

```ts
export type ChatTurn = { role: "user" | "assistant"; content: string };
/** resumeId が store に居ればそれ、いなければ新 UUID（未知IDは黙って新セッション＝既存3実装の共通規約） */
export function resolveSessionId(store: Map<string, ChatTurn[]>, resumeId: string | undefined): string;
/** user/assistant の1往復を末尾に追記した新配列を store に保存 */
export function appendTurn(store: Map<string, ChatTurn[]>, sessionId: string, userText: string, assistantText: string): void;
```

- [ ] **Step 1: 失敗するテスト**:

```ts
import { describe, expect, test } from "bun:test";
import { appendTurn, resolveSessionId, type ChatTurn } from "../providers/transcript";

describe("transcript helpers", () => {
  test("resolveSessionId: 既知IDはそのまま・未知/未指定は新UUID", () => {
    const store = new Map<string, ChatTurn[]>([["s1", []]]);
    expect(resolveSessionId(store, "s1")).toBe("s1");
    const fresh = resolveSessionId(store, "unknown");
    expect(fresh).not.toBe("unknown");
    expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveSessionId(store, undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
  test("appendTurn: 1往復を追記し既存履歴を保持", () => {
    const store = new Map<string, ChatTurn[]>();
    appendTurn(store, "s1", "hi", "hello");
    appendTurn(store, "s1", "how are you", "fine");
    expect(store.get("s1")).toEqual([
      { role: "user", content: "hi" }, { role: "assistant", content: "hello" },
      { role: "user", content: "how are you" }, { role: "assistant", content: "fine" },
    ]);
  });
});
```

- [ ] **Step 2**: 赤確認 → 実装（`CodexMsg`/`ChatMsg` は `ChatTurn` の型エイリアスとして残し既存 export 互換維持）→ 3ファイルの重複箇所を helper 呼び出しへ置換
- [ ] **Step 3**: `cd app && bun test` 全緑（既存 codex/openai-compat/app-server テストが回帰基準）+ typecheck
- [ ] **Step 4**: Commit `refactor: トランスクリプト追記/セッション解決の三重複をproviders/transcript.tsへ抽出`

### Task 3: claude SDK の2相エラー分類 + withTimeout（TDD）

**Files:**
- Modify: `app/server/converse.ts`（makeClaudeRunner）
- Create: `app/server/providers/decorators.ts`（withTimeout・Task 5 で withFallback を追加）
- Test: `app/server/__tests__/converse.test.ts`（追記）+ `app/server/__tests__/decorators.test.ts`

**Interfaces:**
- Produces: `export function withTimeout(runner: ClaudeRunner, ms?: number): ClaudeRunner`（既定 180_000。超過で `TransportError("runner timed out after Nms")`。**タイマーは finally で必ず clear**）
- makeClaudeRunner の2相分類: SDK の async iterator から**最初のメッセージを受け取る前**に throw した例外 → `TransportError` に包み cause を保持。最初のメッセージ以後の失敗（result subtype エラー・空 text）→ 現行どおり plain Error

- [ ] **Step 1: 失敗するテスト** — converse.test.ts の既存 fakeQuery（async generator seam）パターンで:

```ts
test("SDK が最初のメッセージ前に落ちたら TransportError", async () => {
  const runner = makeClaudeRunner({ query: async function* () { throw new Error("spawn ENOENT"); } as any });
  expect(runner("hi")).rejects.toBeInstanceOf(TransportError);
});
test("result subtype エラーは plain Error のまま（フォールバック対象外）", async () => {
  // 既存の fakeQuery で system/init → result(subtype:"error_during_execution") を流す
  expect(...).rejects.toThrow(/Claude result error/);
  // かつ TransportError では「ない」ことを検証
});
```

  decorators.test.ts:

```ts
test("withTimeout: 期限内はそのまま・超過で TransportError", async () => {
  const slow: ClaudeRunner = () => new Promise((r) => setTimeout(() => r({ text: "ok", sessionId: "s" }), 50));
  expect((await withTimeout(slow, 1000)("x")).text).toBe("ok");
  expect(withTimeout(slow, 10)("x")).rejects.toBeInstanceOf(TransportError);
});
test("withTimeout: 解決後にタイマーが残らない（unref/clearの検証はタイマーIDのモックで）", ...);
```

  ※ makeClaudeRunner が query 関数を注入できる形かを converse.ts で確認し、seam が無ければ `makeClaudeRunner(deps?: { query?: typeof query })` の注入引数を追加（既定は SDK 実体・既存呼び出しは無変更）
- [ ] **Step 2**: 赤 → 実装 → 緑。**適用はまだしない**（withTimeout の全経路適用は Task 5 の配線で一括・挙動変更を1コミットに束ねる）
- [ ] **Step 3**: Commit `feat: claude SDK失敗の2相分類（transport/モデル起因）とwithTimeoutデコレータを追加`

### Task 4: providers/claude-print.ts — `claude -p` フォールバックランナー（TDD）

**Files:**
- Create: `app/server/providers/claude-print.ts` / Test: `app/server/__tests__/claude-print.test.ts`
- Modify: `app/server/paths.ts`（`CLAUDE_PRINT_DIR = path.join(DATA_DIR, "claude-print")` を ensureDirs 対象に追加）

**Interfaces:**
- Produces（逐語）:

```ts
export type ClaudePrintExec = (args: {
  prompt: string; systemPrompt: string; model?: string; effort?: string;
  resumeId?: string; cwd: string; bare?: boolean;  // bare は Plan B の APIキー認証で使用
}) => Promise<string>;  // stdout の生JSON文字列を返す
export type ClaudePrintConfig = {
  model?: string; effort?: string; defaultSystemPrompt: string;
  cwd?: string;              // 既定 CLAUDE_PRINT_DIR（固定。resume が cwd キーのため毎回変えない）
  exec?: ClaudePrintExec;    // テスト注入。既定 realClaudePrintExec
};
export function makeClaudePrintRunner(cfg: ClaudePrintConfig): ClaudeRunner;
export const realClaudePrintExec: ClaudePrintExec;  // 単体テスト対象外（先例コメント様式）
```

- 実行形（realClaudePrintExec・binding）: `Bun.spawn(["claude", "-p", "--output-format", "json", "--tools", "", "--max-turns", "1", ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), "--system-prompt", systemPrompt, ...(resumeId ? ["--resume", resumeId] : []), ...(bare ? ["--bare"] : [])], { cwd, stdin: prompt, stderr: "pipe" })`。exit≠0 → `TransportError`（stderr 末尾500字）
- runner の JSON 解釈: `JSON.parse` 失敗 → `TransportError`。`is_error === true || subtype !== "success"` → plain Error(`claude -p error (${subtype}): …`)。`result` 空 → plain Error("Claude returned empty result")。成功 → `{ text: result.trim(), sessionId: session_id }`（**ネイティブ resume 任せ・インメモリ Map 不要**）

- [ ] **Step 1: 失敗するテスト**（exec フェイク注入・codex.test.ts の流儀）:

```ts
const okJson = (text: string, sid = "sess-1") => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: sid });
test("成功: composeなしの素プロンプト+system/model/effort/resumeが引数に乗る", async () => {
  const calls: any[] = [];
  const runner = makeClaudePrintRunner({ model: "haiku", effort: "low", defaultSystemPrompt: "SYS", cwd: "/tmp/x",
    exec: async (a) => { calls.push(a); return okJson("hello"); } });
  const r = await runner("hi", "sess-9", { systemPrompt: "OVERRIDE" });
  expect(r).toEqual({ text: "hello", sessionId: "sess-1" });
  expect(calls[0]).toMatchObject({ prompt: "hi", systemPrompt: "OVERRIDE", model: "haiku", effort: "low", resumeId: "sess-9", cwd: "/tmp/x" });
});
test("is_error/subtype失敗はplain Error・JSON破損とexec throwはTransportError", async () => {
  const r1 = makeClaudePrintRunner({ defaultSystemPrompt: "S", exec: async () => JSON.stringify({ subtype: "error_max_turns", is_error: true, result: "", session_id: "s" }) });
  expect(r1("x")).rejects.toThrow(/error_max_turns/);
  await r1("x").catch((e) => expect(e).not.toBeInstanceOf(TransportError));
  const r2 = makeClaudePrintRunner({ defaultSystemPrompt: "S", exec: async () => "not-json" });
  expect(r2("x")).rejects.toBeInstanceOf(TransportError);
  const r3 = makeClaudePrintRunner({ defaultSystemPrompt: "S", exec: async () => { throw new TransportError("exit 1"); } });
  expect(r3("x")).rejects.toBeInstanceOf(TransportError);
});
test("空resultはplain Error('Claude returned empty result')", ...);
```

- [ ] **Step 2**: 赤 → 実装（paths.ts の CLAUDE_PRINT_DIR 追加含む）→ 緑 → 全体ゲート
- [ ] **Step 3**: Commit `feat: claude -p ワンショットランナー（ネイティブresume・固定cwd・execシーム）を追加`

### Task 5: withFallback 抽出と両プロバイダ配線

**Files:**
- Modify: `app/server/providers/decorators.ts`（withFallback 追加）+ Test: `decorators.test.ts` 追記
- Modify: `app/server/providers/codex-app-server.ts`（内蔵フォールバック分岐を「掃除して rethrow」へ縮退）
- Modify: `app/server/llm-provider.ts`（selectRunner: codex = withFallback(withTimeout(appServer), exec) / claude = withFallback(withTimeout(sdk), claudePrint)。openai-compat = withTimeout のみ）

**Interfaces:**
- Produces: `export function withFallback(primary: ClaudeRunner, fallback: ClaudeRunner): ClaudeRunner` — `err instanceof TransportError` のときのみ `console.warn("primary runner unavailable, falling back:", err)` して fallback を同一引数で実行。他は rethrow

- [ ] **Step 1: テスト先行** — withFallback（TransportError で委譲・plain Error は素通し・fallback の結果が返る）。codex-app-server-runner.test.ts の既存フォールバックテストを「runner は threads.clear() + TransportError rethrow」検証へ書き換え、委譲は withFallback 側のテストで担保（既存の統合的フォールバックテストは selectRunner 相当の合成で1本残す）
- [ ] **Step 2**: 実装。codex-app-server.ts の `cfg.execFallback` 分岐を削除し TransportError を rethrow（`execFallback` フィールドは型から削除・getCodexAppServerRunner の呼び出し側で合成）。selectRunner:

```ts
    case "codex": {
      const conn = { model: env.CODEX_MODEL?.trim() || undefined, reasoningEffort: ..., serviceTier: ..., defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT };
      return withFallback(withTimeout(getCodexAppServerRunner(conn)), makeCodexRunner(conn));
    }
    case "claude":
    default: {
      // tuning 未指定時は既存単一参照を維持するため、ここでの合成は Task 8 の resolveClaudeRunner に集約する
    }
```

  claude 側の合成は Task 8 と衝突するため、**このタスクでは codex 側 + withTimeout(openai-compat) のみ配線**し、claude への withFallback/withTimeout 適用は Task 8 の resolveClaudeRunner 内で行う（二重改変防止・タスク境界コメントを selectRunner に残す）
- [ ] **Step 3**: 全体ゲート緑 → Commit `feat: withFallbackを抽出しcodex/openai-compat経路へタイムアウト・フォールバック合成を配線`

### Task 6: 5ロール再編（assist 新設・連鎖解決）

**Files:**
- Modify: `app/server/llm-provider.ts`（LLM_ROLES に "assist"）・`app/server/routes/llm-settings.ts`（ROLE_PROVIDERS 検証は既存流用・roles 応答に assist が乗ること）
- Modify: `app/server/converse.ts`（applyLlmRoleSettings: assist 行が無ければ coaching の解決結果を共有参照）
- Modify: `app/server/index.ts`（generateUtteranceTranslation / generatePhraseHints / generateFixExplanation への注入を `runnerFor("assist")` へ付替え）
- Modify: `app/client/src/api/llm-settings.ts`（LlmRole 5値 + LLM_ROLES）
- Test: `app/server/__tests__/llm-role-settings-store.test.ts` / `routes-llm-settings.test.ts` / `converse.test.ts` 追記

**Interfaces:**
- Produces: `LlmRole = "conversation" | "assist" | "coaching" | "generation" | "assessment"`（server/client 同値）。**連鎖規則（binding）**: assist のロール行が不在（DB に行なし=inherit 扱い）のとき assist は「coaching と同じ解決結果」になる。coaching も不在なら従来どおり global へ

- [ ] **Step 1: テスト先行**:
  - routes: GET /api/llm-settings の roles に assist が含まれ、行不在時 provider="inherit"
  - converse: `applyLlmRoleSettings` に coaching=codex(等) を与え assist 行なし → `runnerFor("assist")` が coaching と同一 runner 参照 / assist 行あり → 独立解決
  - 既存テストの LLM_ROLES 依存（4ロール前提の toEqual）を5ロールへ更新
- [ ] **Step 2**: 実装。連鎖は applyLlmRoleSettings 内で「assist の設定行が inherit のとき roles マップに coaching の解決済みランナーを set」する1点実装（resolveRunner の変更不要）。index.ts の3箇所を runnerFor("assist") へ
- [ ] **Step 3**: クライアント LlmRole 5値化に伴う `hydrateTargets`/`buildRolesPayload`/`presetTargets`/`matchPreset`/PRESETS の assist スロット追加（オールローカル=local / balanced=local / high-quality=cloud）と `llm-assignments.test.ts` 更新（テスト先行）。SettingsScreen はロール行が LLM_ROLES.map で自動的に5行になる（文言キー roleName/roleDesc/roleReason に assist を追加 — EN/JA、Plan B の文言確定までは仮でなく最終文言を入れる: JA name「クイック支援」desc「訳・言い方ヒント・ちょい解説」reason「推奨: ローカル — 単純で即答が欲しいタスクのため。品質を上げたいときは Claude / Codex へ。」EN 対応文）
- [ ] **Step 4**: 全体ゲート緑 → Commit `feat: クイック支援(assist)ロールを新設し訳/ヒント/ちょい解説を分離（未設定時はコーチングへ連鎖）`

### Task 7: llm_role_tuning テーブル + ストア + API 拡張（TDD）

**Files:**
- Create: `app/server/llm-role-tuning-store.ts` / Test: `app/server/__tests__/llm-role-tuning-store.test.ts`
- Modify: `app/server/db.ts`（ensure 1行）・`app/server/routes/llm-settings.ts`（PUT body の tuning 受理・検証・GET 応答へ additive に tuning を含める）・`__tests__/helpers/route-deps.ts`（フェイク）・`routes-llm-settings.test.ts`

**Interfaces:**
- Produces（逐語）:

```ts
export type RoleTuning = { claudeModel: string | null; effort: string | null; serviceTier: string | null };
export type LlmRoleTuningStore = {
  getAll(): Record<LlmRole, RoleTuning>;   // 行不在は全null
  setAll(t: Partial<Record<LlmRole, Partial<RoleTuning>>>): void;  // UPSERT・null=クリア
};
export function ensureLlmRoleTuningSchema(db: Database): void;
export function makeLlmRoleTuningStore(db: Database): LlmRoleTuningStore;
```

- 検証ホワイトリスト（routes 側・binding）: claudeModel ∈ {haiku, sonnet, opus} / effort ∈ {low, medium, high, xhigh} / serviceTier ∈ {fast, standard}（null は常に可・その他は 400）。PUT は既存2パス（全検証→一括保存）の第1パスに tuning 検証を統合し原子性維持
- [ ] Steps: ストアのテスト先行（UPSERT・全null既定・不正ロール名無視 or 400 は routes 層で）→ 実装 → routes テスト先行（tuning 込み PUT の往復・不正値400で何も保存されない・GET に tuning が additive）→ 実装 → 全体ゲート → Commit `feat: ロール別チューニング(llm_role_tuning)の永続化とAPIを追加`

### Task 8: チューニング配線（claude パラメータ化 + codex per-thread 化 + 優先順位）

**Files:**
- Modify: `app/server/converse.ts`（makeClaudeRunner の {model, effort} 受理・resolveClaudeRunner 新設・applyLlmRoleSettings に tuning 引数追加）
- Modify: `app/server/llm-provider.ts`（SelectRunnerArgs に tuning 構造体・env 新キー CLAUDE_MODEL/CLAUDE_EFFORT・優先順位式）
- Modify: `app/server/providers/codex-app-server.ts`（registry キーから model/effort/tier を除去=プロセス1本化・threadParams をロール cfg 由来に）
- Modify: `app/server/index.ts`（applyLlmSettings が tuningStore.getAll() を渡す）
- Test: `converse.test.ts` / `llm-provider.test.ts` / `codex-app-server-runner.test.ts` 追記

**Interfaces:**
- Produces: `resolveClaudeRunner(tuning: { model?: string; effort?: string } | undefined): ClaudeRunner` — **tuning が空なら module-level claudeRunner（withFallback/withTimeout 合成済みの単一参照）を返す**。指定ありなら `withFallback(withTimeout(makeClaudeRunner({query, model, effort})), makeClaudePrintRunner({model, effort, defaultSystemPrompt}))` を生成
- claude 経路の合成（Task 5 の持ち越し）: module-level `claudeRunner` 自体をこのタスクで `withFallback(withTimeout(sdk), claudePrint)` 合成へ差し替え（既定 model=env.CLAUDE_MODEL||"sonnet"・effort=env.CLAUDE_EFFORT||undefined）
- codex: `getCodexAppServerRunner(conn, roleTuning?)` — registry キーは接続同一性のみ（実質定数）になり、`threadParams` は `{model: conn.model, effort: roleTuning?.effort ?? conn.reasoningEffort, serviceTier: roleTuning?.serviceTier ?? conn.serviceTier}` で thread/start・thread/resume に per-thread 反映。exec フォールバックの `-c` も同値
- 優先順位テスト（binding）: tuning.effort > env.CODEX_REASONING_EFFORT > "medium"（claude 側: tuning.claudeModel > env.CLAUDE_MODEL > "sonnet"）

- [ ] Steps: テスト先行（①resolveClaudeRunner の単一参照回帰基準 ②tuning 指定時の query options に model/effort が乗る ③codex threadParams の per-thread 値 ④registry がプロセス1本のまま effort 違いを受ける=eviction 無し ⑤優先順位式）→ 実装 → 全体ゲート → Commit `feat: ロール別チューニングをclaude(model/effort)とcodex(per-threadパラメータ)へ配線しプロセス1本化`

### Task 9: 統合検証（Plan A 締め・マージなし）

- [ ] 3ゲート全緑 + `./scripts/check-codex-protocol.sh` OK
- [ ] 回帰確認の観点リスト: 既定挙動不変（tuning 全null・assist 行なし・LLM_PROVIDER 未設定で claudeRunner 単一参照）/ v0.23 の全テスト緑 / クライアント build 緑
- [ ] Commit（残があれば）して Plan B へ継続（ブランチ維持・マージ/タグは Plan B Task 6）
