# Codex App Server 統合 + 優先クラウド設定 Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex を app-server（常駐 JSON-RPC・ネイティブ thread 継続・再起動復元）で動かして Claude とのセッション永続化パリティを実現し、プリセットのクラウド枠を「優先クラウド（Claude/Codex）」で選べるようにする（v0.23.0・spec: `docs/superpowers/specs/2026-07-08-codex-app-server-design.md`）。

**Architecture:** 新規 `providers/codex-app-server.ts` に transport（注入 seam）/ client（JSON-RPC）/ runner（ClaudeRunner 適合）の3層。セッションは `sessionId = threadId`、階梯は turn/start → thread/resume → 新スレッド+履歴畳み込み → exec フォールバック。常駐プロセスは接続設定キー付き singleton でデデュープ。優先クラウドはクライアント専用（localStorage）で `presetTargets(id, cloud)` がプリセットの claude 枠を置換する。

**Tech Stack:** Bun（`Bun.spawn` stdio パイプ）+ TypeScript。改行区切り JSON-RPC は自前実装（レスポンスに `jsonrpc` フィールドが無い実測仕様のため既製ライブラリ不可）。

## Global Constraints

- **検証ゲート（全タスク）:** `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build` すべて緑
- **`ClaudeRunner` 型は不変**: `(prompt: string, resumeId?: string, opts?: { systemPrompt?: string }) => Promise<{ text: string; sessionId: string }>`（converse.ts:29-33）。消費側6ファイル（converse/coach/placement/assessment/content-gen/generate-content）は変更しない
- **exec アダプタ（providers/codex.ts）は削除しない**（フォールバック層として恒久維持）。既定プロバイダは Claude のまま・設定を変えなければ挙動完全同一
- サーバ新ロジックは TDD（赤→緑）。実プロセス（spawn/CLI）部分は単体テスト対象外・手動スモーク（realCodexExec と同じ流儀・codex.ts:92-94 の先例）
- 安全境界: `thread/start` に `sandbox: "read-only"` + `approvalPolicy: "never"` をプロトコル指定。承認系 ServerRequest には decline 応答。cwd は `tmpdir()`
- 検証済み codex バージョン: **0.142.5**。プロトコルは v2 thread/turn API のみ使用（v1 newConversation 系は消滅済み）
- i18n: 型 + `STR.en` + `STR.ja` 3点同時。文言はわかりやすさ優先で変更可・EN/JA 同時更新・ユーザー可視変更はコミット本文に明示。文字列直書き禁止
- APIキーは `app/.env` のみ。PUBLIC リポジトリ。研究制約（情報的フィードバックのみ）維持
- ブランチ: `feat/codex-app-server`。リリースは Task 7 で v0.23.0

## プロトコル要点（0.142.5 実測・全タスク共通の前提）

- 改行区切り JSON-RPC over stdio。リクエスト `{"method":"…","id":N,"params":{…}}`（1行）。レスポンス `{"id":N,"result":{…}}` または `{"id":N,"error":{…}}`（`jsonrpc` フィールド無し）。通知 `{"method":"…","params":{…}}`（id 無し）。**stdin close でプロセスは即・正常終了**
- ハンドシェイク: `initialize {clientInfo:{name,title,version}, capabilities:{}}` → 応答後にクライアントから通知 `{"method":"initialized"}`
- `thread/start` params（生成型で確認済み）: `{model?, serviceTier?, cwd?, approvalPolicy?, sandbox?, config?: {[k]: JsonValue}, developerInstructions?, …}` → result `{thread: {id: string(UUID), …}, …}`。reasoning effort は `config: {"model_reasoning_effort": "<effort>"}` で渡す
- `turn/start` params: `{threadId: string, input: [{type:"text", text: string}]}` → result `{turn: {…}}` は開始応答。**最終テキストは通知で届く**: `item/completed {item}`（`item.type === "agentMessage"` の `item.text`）→ `turn/completed {threadId, turn:{status: "completed"|"failed"|…, error?}}`
- `thread/resume` params: `{threadId: string, model?, serviceTier?, approvalPolicy?, sandbox?, config?, …}` — ディスク rollout からの復元（サーバ再起動後も可）
- 承認系 ServerRequest（`item/commandExecution/requestApproval` 等）はサーバ→クライアントのリクエスト（id 付き）: `{"id":<same>,"result":{"decision":"decline"}}` を返す
- 未知の通知メソッドは必ず無視する（initialize 直後に `remoteControl/status/changed` 等が飛んでくる）

---

### Task 1: プロトコルスナップショット + 破壊的変更検出スクリプト

**Files:**
- Create: `app/server/providers/codex-protocol.snapshot.json`
- Create: `scripts/check-codex-protocol.sh`

**Interfaces:**
- Produces: スナップショット（Task 2-4 の型の正・破壊的変更検出の基準）

- [ ] **Step 1: スキーマ生成** — `codex app-server generate-json-schema --help` で出力先指定方法を確認し、一時ディレクトリに生成。バンドルされた v2 スキーマ（調査時の名前: `codex_app_server_protocol.v2.schemas.json`。名前が違えば生成物から v2 プロトコル全体を含む JSON を特定）を `app/server/providers/codex-protocol.snapshot.json` へコピー
- [ ] **Step 2: 検出スクリプト** — `scripts/check-codex-protocol.sh`:

```bash
#!/bin/bash
# codex app-server プロトコルの破壊的変更検出（手動/リリース前実行・CI非依存）。
# 使い方: ./scripts/check-codex-protocol.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SNAPSHOT="app/server/providers/codex-protocol.snapshot.json"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
codex app-server generate-json-schema --out "$TMP" >/dev/null 2>&1 || codex app-server generate-json-schema "$TMP" >/dev/null
GENERATED=$(find "$TMP" -name '*v2*.json' | head -1)
[ -n "$GENERATED" ] || { echo "生成物にv2スキーマが見つかりません"; exit 2; }
if diff -q "$SNAPSHOT" "$GENERATED" >/dev/null; then
  echo "OK: プロトコルはスナップショット($(codex --version))と一致"
else
  echo "WARN: プロトコルがスナップショットから変化しています。diff を確認し、アダプタ検証後にスナップショットを更新してください:"
  diff "$SNAPSHOT" "$GENERATED" | head -40
  exit 1
fi
```

  （`generate-json-schema` の実引数は Step 1 で確認した形に合わせて修正すること）
- [ ] **Step 3: 実行確認** — `chmod +x scripts/check-codex-protocol.sh && ./scripts/check-codex-protocol.sh` → `OK` 出力
- [ ] **Step 4: Commit** — `git commit -m "feat: codex app-serverプロトコルのスナップショットと破壊的変更検出スクリプトを追加"`

### Task 2: transport seam + JSON-RPC クライアント層（TDD）

**Files:**
- Create: `app/server/providers/codex-app-server.ts`（このタスクでは transport 型と client まで）
- Test: `app/server/__tests__/codex-app-server-client.test.ts`

**Interfaces:**
- Produces（Task 3 が使用・逐語）:

```ts
export type AppServerProc = {
  send: (msg: Record<string, unknown>) => void;          // 1行JSONとして書き込む
  onMessage: (cb: (msg: Record<string, unknown>) => void) => void;
  onExit: (cb: (code: number | null) => void) => void;
  kill: () => void;
};
export type SpawnAppServer = () => AppServerProc;
export class CodexAppServerClient {
  constructor(spawn: SpawnAppServer, opts?: { requestTimeoutMs?: number });
  /** lazy: 初回 request 時に spawn + initialize/initialized ハンドシェイク */
  request(method: string, params: Record<string, unknown> | undefined): Promise<Record<string, unknown>>;
  /** turn/start を送り、turn/completed まで通知を収集して最終 agentMessage テキストを返す */
  runTurn(threadId: string, text: string): Promise<string>;
  alive(): boolean;
  kill(): void;
}
```

- [ ] **Step 1: 失敗するテストを書く** — フェイク transport（送信メッセージを記録し、スクリプトに従って onMessage/onExit を発火する）で:

```ts
import { describe, expect, test } from "bun:test";
import { CodexAppServerClient, type AppServerProc, type SpawnAppServer } from "../providers/codex-app-server";

/** 送信を記録し、応答スクリプトを手動発火できるフェイク */
function makeFakeProc() {
  const sent: Record<string, unknown>[] = [];
  let onMsg: (m: Record<string, unknown>) => void = () => {};
  let onExit: (c: number | null) => void = () => {};
  const proc: AppServerProc = {
    send: (m) => sent.push(m),
    onMessage: (cb) => { onMsg = cb; },
    onExit: (cb) => { onExit = cb; },
    kill: () => {},
  };
  return { proc, sent, emit: (m: Record<string, unknown>) => onMsg(m), exit: (c: number | null) => onExit(c) };
}

describe("CodexAppServerClient", () => {
  test("初回requestでinitializeハンドシェイクを行いid対応でレスポンスを返す", async () => {
    const f = makeFakeProc();
    const client = new CodexAppServerClient((() => f.proc) as SpawnAppServer);
    const p = client.request("thread/start", { sandbox: "read-only" });
    await Bun.sleep(0);
    // 1通目= initialize
    expect(f.sent[0]?.method).toBe("initialize");
    f.emit({ id: f.sent[0]!.id, result: { userAgent: "codex" } });
    await Bun.sleep(0);
    // 2通目= initialized 通知（id無し）、3通目= thread/start
    expect(f.sent[1]).toEqual({ method: "initialized" });
    expect(f.sent[2]?.method).toBe("thread/start");
    f.emit({ id: f.sent[2]!.id, result: { thread: { id: "t-1" } } });
    expect((await p).thread).toEqual({ id: "t-1" });
  });

  test("runTurnはitem/completedのagentMessageを集めturn/completedで解決する", async () => {
    const f = makeFakeProc();
    const client = new CodexAppServerClient((() => f.proc) as SpawnAppServer);
    const first = client.request("thread/start", {});
    await Bun.sleep(0);
    f.emit({ id: f.sent[0]!.id, result: {} });
    await Bun.sleep(0);
    f.emit({ id: f.sent[2]!.id, result: { thread: { id: "t-1" } } });
    await first;

    const turn = client.runTurn("t-1", "Hello");
    await Bun.sleep(0);
    const turnReq = f.sent.find((m) => m.method === "turn/start")!;
    expect(turnReq.params).toEqual({ threadId: "t-1", input: [{ type: "text", text: "Hello" }] });
    f.emit({ id: turnReq.id, result: { turn: { id: "turn-1" } } });
    f.emit({ method: "unknown/notification", params: {} }); // 未知通知は無視
    f.emit({ method: "item/completed", params: { threadId: "t-1", item: { type: "agentMessage", id: "i1", text: "Hi there" } } });
    f.emit({ method: "turn/completed", params: { threadId: "t-1", turn: { status: "completed" } } });
    expect(await turn).toBe("Hi there");
  });

  test("turn失敗はエラーになりエラー内容を含む", async () => {
    const f = makeFakeProc();
    const client = new CodexAppServerClient((() => f.proc) as SpawnAppServer);
    const first = client.request("thread/start", {});
    await Bun.sleep(0);
    f.emit({ id: f.sent[0]!.id, result: {} });
    await Bun.sleep(0);
    f.emit({ id: f.sent[2]!.id, result: { thread: { id: "t-1" } } });
    await first;
    const turn = client.runTurn("t-1", "Hello");
    await Bun.sleep(0);
    const turnReq = f.sent.find((m) => m.method === "turn/start")!;
    f.emit({ id: turnReq.id, result: { turn: {} } });
    f.emit({ method: "turn/completed", params: { threadId: "t-1", turn: { status: "failed", error: { message: "boom" } } } });
    expect(turn).rejects.toThrow(/boom|failed/);
  });

  test("承認系ServerRequestにはdeclineを返す", async () => {
    const f = makeFakeProc();
    const client = new CodexAppServerClient((() => f.proc) as SpawnAppServer);
    const first = client.request("thread/start", {});
    await Bun.sleep(0);
    f.emit({ id: f.sent[0]!.id, result: {} });
    await Bun.sleep(0);
    f.emit({ id: f.sent[2]!.id, result: { thread: { id: "t-1" } } });
    await first;
    f.emit({ id: 99, method: "item/commandExecution/requestApproval", params: {} });
    await Bun.sleep(0);
    expect(f.sent.find((m) => m.id === 99)).toEqual({ id: 99, result: { decision: "decline" } });
  });

  test("プロセスexitで保留中requestはrejectしalive()=false", async () => {
    const f = makeFakeProc();
    const client = new CodexAppServerClient((() => f.proc) as SpawnAppServer);
    const p = client.request("thread/start", {});
    await Bun.sleep(0);
    f.exit(1);
    expect(p).rejects.toThrow(/exited/);
    expect(client.alive()).toBe(false);
  });
});
```

- [ ] **Step 2: 赤を確認** — Run: `cd app && bun test codex-app-server-client` → FAIL（モジュール未実装）
- [ ] **Step 3: 実装** — `codex-app-server.ts` に上記 Interfaces の型と `CodexAppServerClient` を実装:
  - `request`: 連番 id 発行 → `pending Map<id, {resolve, reject, timer}>`。初回のみ handshake（`initialize {clientInfo:{name:"solo-eikaiwa",title:"solo-eikaiwa",version:"0"},capabilities:{}}` → 応答受領 → `{method:"initialized"}` 送信）を直列に済ませてから本リクエスト
  - `onMessage` ディスパッチ: `id`あり+`result|error` → pending 解決 / `id`あり+`method`あり → ServerRequest（メソッド名に `requestApproval` を含む or `elicitation` → `{id, result:{decision:"decline"}}` 送信。それ以外は `{id, result:{}}`）/ `id`なし → 通知（`runTurn` 中のみ収集・他は無視）
  - `runTurn`: `turn/start` を request → 該当 threadId の `item/completed`（`item.type==="agentMessage"` の `text` を最後勝ちで保持）を収集 → `turn/completed` で status==="completed" なら解決・それ以外は `turn.error?.message` 付きで reject
  - `onExit`: 保留中 pending を全 reject（`codex app-server exited (code N)`）+ `alive=false`
  - タイムアウト: request 単位 `requestTimeoutMs`（既定 180000）。超過で reject
  - **実プロセス**: `export const realSpawnAppServer: SpawnAppServer` — `Bun.spawn(["codex","app-server"], {stdin:"pipe",stdout:"pipe",stderr:"pipe", cwd: tmpdir()})`、stdout を行分割して JSON.parse（失敗行は無視）、`send` は `proc.stdin.write(JSON.stringify(msg)+"\n")` + flush。`kill()` は stdin close + proc.kill()。**単体テスト対象外**（codex.ts:92-94 の先例どおりコメントで明記・Task 7 手動スモークで確認）
- [ ] **Step 4: 緑を確認** — Run: `cd app && bun test codex-app-server-client` → PASS。全体 `bun test` + `bun run typecheck` も緑
- [ ] **Step 5: Commit** — `git commit -m "feat: codex app-server の改行区切りJSON-RPCクライアント（transport注入seam・承認decline・turn収集）を追加"`

### Task 3: runner 層 — セッション階梯 + exec フォールバック（TDD）

**Files:**
- Modify: `app/server/providers/codex-app-server.ts`（runner 追加）
- Test: `app/server/__tests__/codex-app-server-runner.test.ts`

**Interfaces:**
- Consumes: Task 2 の `CodexAppServerClient` / `SpawnAppServer`、既存 `composeCodexPrompt`・`CodexMsg`（providers/codex.ts）、`ClaudeRunner`（converse.ts）
- Produces（Task 4 が使用・逐語）:

```ts
export type CodexAppServerConfig = {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  defaultSystemPrompt: string;
  spawn?: SpawnAppServer;          // テスト注入。既定 realSpawnAppServer
  execFallback?: ClaudeRunner;     // transport障害時のフォールバック（既定なし=そのままthrow）
};
export function makeCodexAppServerRunner(cfg: CodexAppServerConfig): ClaudeRunner;
```

- [ ] **Step 1: 失敗するテストを書く** — Task 2 のフェイク transport を再利用（テストヘルパとして copy でなく export/共有: `__tests__/helpers/fake-app-server.ts` に `makeFakeProc` を移して両テストから import）。ケース:

```ts
test("新規セッション: thread/start(sandbox/approval/model/config/developerInstructions) → turn/start → sessionId=threadId", ...);
// thread/start params の検証（逐語）:
// { model: "gpt-5.5", serviceTier: "fast", sandbox: "read-only", approvalPolicy: "never",
//   cwd: <string>, developerInstructions: "SYS", config: { model_reasoning_effort: "medium" } }
test("既知sessionIdの継続: thread/startせずturn/startのみ・履歴Mapにも追記される", ...);
test("未知sessionId（プロセス再起動想定）: thread/resume成功→turn/start（パリティ経路）", ...);
test("thread/resume失敗: 新thread/start + 保険トランスクリプトをcomposeCodexPromptで畳んだinputを送る", ...);
test("同一sessionIdでsystemPromptが変わったら新スレッド（fold）", ...);
test("spawn失敗/exit: execFallbackが同じ(prompt,resumeId,opts)で呼ばれ結果が返る", ...);
test("turn.status=failed はフォールバックせずthrow", ...);
test("空のagentMessageはthrow('Codex returned empty result')", ...);
```

  各テストは Task 2 と同じ発火手順（sent 配列の検査 + emit）で書く。フェイク exec フォールバックは `async () => ({ text: "fallback", sessionId: "s" })` を記録付きで注入
- [ ] **Step 2: 赤を確認** — `cd app && bun test codex-app-server-runner` → FAIL
- [ ] **Step 3: 実装** — runner closure に `threads Map<sessionId, { systemPrompt: string }>`（sessionId===threadId）と保険の `transcript Map<sessionId, CodexMsg[]>` を持つ:
  1. `system = opts?.systemPrompt ?? cfg.defaultSystemPrompt`
  2. `resumeId` が threads に有り system 一致 → `runTurn(resumeId, prompt)`
  3. threads に有るが system 不一致 → fold: 新 `thread/start`（developerInstructions=system）+ `runTurn(newId, composeCodexPrompt("", transcript, prompt) の会話部分 …実装は composeCodexPrompt(system="", history, prompt) ではなく履歴ブロックのみ埋め込み: `composeCodexPrompt` をそのまま使い system は developerInstructions に入れたため空文字で呼ぶ)
  4. `resumeId` 有るが threads に無い → `thread/resume {threadId: resumeId, …同じ安全パラメータ}` を試行 → 成功なら threads 登録 + `runTurn`。失敗（request reject）なら 3 と同じ fold（transcript が空なら素の prompt）
  5. `resumeId` 無し → 新 `thread/start` → `runTurn`
  6. 例外分類: `runTurn` の reject のうち **transport 起因**（spawn 失敗・exited・timeout・handshake 失敗 = client が投げる Error に `transport` マーカーを持たせる。実装: `class TransportError extends Error`）→ `cfg.execFallback` があればそれで実行（warn ログ `console.warn("codex app-server unavailable, falling back to exec:", err)`）。**モデル起因**（turn failed・空応答）→ そのまま throw
  7. 成功時 transcript に user/assistant を追記し `{ text, sessionId: threadId }`
  - `thread/start`/`thread/resume` の共通パラメータ組み立てはヘルパ `threadParams(cfg, system)` に切り出す（Step 1 の逐語 params）
- [ ] **Step 4: 緑を確認** — `cd app && bun test codex-app-server` → 両ファイル PASS。全体 `bun test` + `typecheck` 緑
- [ ] **Step 5: Commit** — `git commit -m "feat: codex app-serverランナー（thread/resume再起動復元・履歴畳み込み・execフォールバック）を追加"`

### Task 4: 寿命管理 singleton + selectRunner 配線 + 版チェック（TDD）

**Files:**
- Modify: `app/server/providers/codex-app-server.ts`（registry 追加）
- Modify: `app/server/llm-provider.ts:80-88` 付近（codex 分岐）
- Test: `app/server/__tests__/codex-app-server-runner.test.ts`（追記）+ `app/server/__tests__/llm-provider.test.ts:46-50`（更新）

**Interfaces:**
- Produces: `export function getCodexAppServerRunner(cfg: CodexAppServerConfig): ClaudeRunner` — 接続設定キー（`JSON.stringify({model, reasoningEffort, serviceTier})`）でクライアント（=常駐プロセス）をデデュープするモジュールレベル registry。キー変化時は旧クライアントを `kill()` して差し替え

- [ ] **Step 1: 失敗するテストを書く**:

```ts
test("同一設定でrunnerを2回作ってもspawnは1回（プロセス共有）", ...);   // spawn呼び出し回数を数えるフェイク
test("設定キーが変わると旧プロセスがkillされ新プロセスをspawnする", ...); // kill記録フェイク
```

- [ ] **Step 2: 赤確認** — `bun test codex-app-server-runner` → FAIL
- [ ] **Step 3: 実装** — module-level `let registry: { key: string; client: CodexAppServerClient } | null`。`getCodexAppServerRunner` はキー一致なら既存 client を使う runner を返し、不一致なら `registry.client.kill()` → 新規。テスト用に `export function __resetCodexAppServerRegistry(): void` を用意（テスト間の分離）
- [ ] **Step 4: selectRunner 配線** — `llm-provider.ts` の codex 分岐を差し替え:

```ts
    case "codex":
      return getCodexAppServerRunner({
        model: env.CODEX_MODEL || undefined,
        reasoningEffort: env.CODEX_REASONING_EFFORT || "medium",
        serviceTier: env.CODEX_SERVICE_TIER || "fast",
        defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,  // 既存の値をそのまま使う（現行 makeCodexRunner に渡している値）
        execFallback: makeCodexRunner({
          model: env.CODEX_MODEL || undefined,
          reasoningEffort: env.CODEX_REASONING_EFFORT || "medium",
          serviceTier: env.CODEX_SERVICE_TIER || "fast",
          defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
        }),
      });
```

  （現行コードの defaultSystemPrompt の実際の渡し方を読んで同じ値を渡すこと。`llm-provider.test.ts` の codex 選択テストは「app-server runner が返る」ことに更新 — 関数参照の同一性ではなく `typeof === "function"` と registry デデュープの観察で検証）
- [ ] **Step 5: 版チェック** — `realSpawnAppServer` 内の初回 spawn 直前に一度だけ（module フラグ）`Bun.spawnSync(["codex","--version"])` を実行し、`TESTED_CODEX_VERSION = "0.142.5"` と前方一致しなければ `console.warn("codex \${actual} はテスト済み \${TESTED_CODEX_VERSION} と異なります（動作は継続・異常時はexecフォールバック）")`
- [ ] **Step 6: 緑確認 + 全体ゲート** — `cd app && bun test && bun run typecheck && cd client && bun run build` → 全緑
- [ ] **Step 7: Commit** — `git commit -m "feat: codexロールをapp-serverランナーへ切替（接続設定キーでプロセス共有・版チェック・exec自動フォールバック）"`

### Task 5: 優先クラウド純ロジック（TDD）

**Files:**
- Modify: `app/client/src/lib/llm-assignments.ts`
- Test: `app/client/src/lib/llm-assignments.test.ts`

**Interfaces:**
- Produces（Task 6 が使用・逐語）:

```ts
export type CloudTarget = "claude" | "codex";
export function presetTargets(id: PresetId, cloud: CloudTarget): RoleTargets;
export function matchPreset(targets: RoleTargets): { id: PresetId; cloud: CloudTarget } | "custom";
export function buildRolesPayload(targets: RoleTargets, conn: Connection, cloud?: CloudTarget): {...};  // cloud 既定 "claude"
```

- [ ] **Step 1: テスト先行（赤）** — 既存 matchPreset テストを新シグネチャへ書き換え + 追加:

```ts
test("presetTargets: claude枠が優先クラウドに置換される（localは不変）", () => {
  expect(presetTargets("balanced", "codex")).toEqual(
    { conversation: "local", coaching: "codex", generation: "local", assessment: "codex" });
  expect(presetTargets("balanced", "claude")).toEqual(PRESETS.balanced);
});
test("matchPreset: 両クラウドを試す緩い一致（{id, cloud}を返す）", () => {
  expect(matchPreset(PRESETS.balanced)).toEqual({ id: "balanced", cloud: "claude" });
  expect(matchPreset(presetTargets("balanced", "codex"))).toEqual({ id: "balanced", cloud: "codex" });
  expect(matchPreset(presetTargets("high-quality", "codex"))).toEqual({ id: "high-quality", cloud: "codex" });
});
test("matchPreset: クラウド混在はcustom", () => {
  expect(matchPreset({ conversation: "local", coaching: "claude", generation: "local", assessment: "codex" })).toBe("custom");
});
test("buildRolesPayload: ローカル未定義時のフォールバック先は優先クラウド", () => {
  const conn = { baseUrl: "", model: "", codexModel: "" };
  const payload = buildRolesPayload(presetTargets("all-local", "codex"), conn, "codex");
  expect(payload.roles.conversation).toEqual({ provider: "codex", codexModel: null });
});
test("buildRolesPayload: cloud省略時は従来どおりclaudeフォールバック", ...);  // 既存ケースの互換確認
```

  既存の往復整合テスト（buildRolesPayload→hydrateTargets→matchPreset）は `matchPreset(...)` の期待値を `{id, cloud}` 形に更新
- [ ] **Step 2: 赤確認** — `cd app && bun test llm-assignments` → FAIL
- [ ] **Step 3: 実装** — Interfaces のとおり。`presetTargets` は `PRESETS[id]` の `"claude"` 値を `cloud` に写像。`matchPreset` は `(Object.keys(PRESETS) as PresetId[])` × `["claude","codex"]` の総当たり一致（all-local は cloud 枠が無いため `{id:"all-local", cloud:"claude"}` で最初に一致 — 仕様として許容しコメントに明記）。`buildRolesPayload` の local フォールバック行 `targets[role] === "local" ? "claude"` を `? cloud` に変更（第3引数 `cloud: CloudTarget = "claude"`）
- [ ] **Step 4: 緑確認 + Commit** — `bun test llm-assignments` PASS → `git commit -m "feat: presetTargets/matchPresetを優先クラウド対応にしローカル未定義フォールバック先を優先クラウドへ"`

### Task 6: 優先クラウド UI + i18n

**Files:**
- Create: `app/client/src/lib/preferred-cloud.ts`
- Modify: `app/client/src/screens/SettingsScreen.tsx`（roles タブのプリセットブロック）
- Modify: `app/client/src/i18n.ts`（settings 型 + EN + JA）

**Interfaces:**
- Consumes: Task 5 の `presetTargets` / `matchPreset` / `buildRolesPayload` / `CloudTarget`
- Produces: `loadPreferredCloud(): CloudTarget` / `savePreferredCloud(c: CloudTarget): void`（localStorage キー `llm.preferredCloud`・不正値は `"claude"`）

- [ ] **Step 1: preferred-cloud.ts**:

```ts
import type { CloudTarget } from "./llm-assignments";

const KEY = "llm.preferredCloud";

/** プリセット適用時のクラウド枠に使う優先クラウド（クライアント専用・localStorage永続）。 */
export function loadPreferredCloud(): CloudTarget {
  return localStorage.getItem(KEY) === "codex" ? "codex" : "claude";
}
export function savePreferredCloud(c: CloudTarget): void {
  localStorage.setItem(KEY, c);
}
```

- [ ] **Step 2: i18n** — settings 型に追加: `preferredCloudLabel: string; preferredCloudNote: string;`、`presetHighQualityDesc`/`presetBalancedDesc` を `(cloud: "claude" | "codex") => string` へ型変更（関数値エントリの先例: `llm.notApplied`/`llm.envNote`）:
  - EN: `preferredCloudLabel: "Preferred cloud"`, `preferredCloudNote: "Used for the cloud slots when you apply a preset — pick the provider you subscribe to."`, `presetBalancedDesc: (cloud) => cloud === "claude" ? "Conversation and content generation run locally; coaching and assessment use Claude, where the quality gap is largest and the usage least frequent." : "Conversation and content generation run locally; coaching and assessment use Codex, where the quality gap is largest and the usage least frequent."`, `presetHighQualityDesc: (cloud) => cloud === "claude" ? "Every role uses Claude, the tested baseline." : "Every role uses Codex."`
  - JA: `preferredCloudLabel: "優先クラウド"`, `preferredCloudNote: "プリセット適用時のクラウド枠に使われます。課金しているサービスに合わせてください。"`, `presetBalancedDesc: (cloud) => cloud === "claude" ? "会話・教材生成はローカル、コーチング・測定は品質差が最も大きく実行頻度も低いため Claude を使います。" : "会話・教材生成はローカル、コーチング・測定は品質差が最も大きく実行頻度も低いため Codex を使います。"`, `presetHighQualityDesc: (cloud) => cloud === "claude" ? "すべての用途を Claude（動作確認済みの基準）で動かします。" : "すべての用途を Codex で動かします。"`（「動作確認済みの基準」は Claude のみ）
  - `llm.help` の EN "the default (Claude) is the tested baseline" / JA 「既定（Claude）が動作確認済みの基準です」を EN "Claude is the tested baseline" / JA 「Claude は動作確認済みの基準です」へ調整（現文言を読んで最小差分で）
- [ ] **Step 3: SettingsScreen** — roles タブのプリセットブロックを更新:
  - `const [preferredCloud, setPreferredCloud] = useState<CloudTarget>(() => loadPreferredCloud());` + 変更ハンドラで `savePreferredCloud`
  - プリセット select の直上に: ラベル `preferredCloudLabel` + `.lang-toggle` セグメント（`Claude` / `Codex` のボタン。ブランド名は直書き可）+ `text-sm text-muted` で `preferredCloudNote`
  - `applyPreset(id)` は `presetTargets(id, preferredCloud)` を適用（従来の `PRESETS[id]`を置換）
  - `const m = matchPreset(targets);` — select の value は `m === "custom" ? "custom" : m.id`。説明文は `m !== "custom"` のとき `presetBalancedDesc(m.cloud)` / `presetHighQualityDesc(m.cloud)` / all-local は従来キー。`buildRolesPayload(nextTargets, conn, preferredCloud)` へ第3引数を渡す（`persist` のシグネチャに `cloud` を通すか、コンポーネント内で直接参照）
  - 優先クラウドの変更は**既存割当を書き換えない**（適用ボタン/プリセット選択から効く）
- [ ] **Step 4: 検証 + Commit** — `cd app && bun test && bun run typecheck && cd client && bun run build` → 緑。`git commit -m "feat: 優先クラウド設定（Claude/Codex）を追加しプリセットのクラウド枠を課金先で選べるように"`（i18n 文言変更を本文に列挙）

### Task 7: ドキュメント + 手動スモーク + リリース v0.23.0

**Files:**
- Modify: `README.md`（セッション継続・安全設定・優先クラウド・できること）
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README** — (a) セッション継続節を3分化: Claude=SDK ディスク永続 / Codex=**app-server ネイティブ継続（サーバ再起動後も thread/resume で復元。app-server 不調時は exec ワンショット+インメモリへ自動フォールバック）** / OpenAI 互換=インメモリ (b) Codex 安全設定節: プロトコルレベルで `sandbox:"read-only"`+`approvalPolicy:"never"` を毎スレッド指定・承認要求は自動 decline・exec フォールバック時は従来の CLI フラグ、と書き換え (c) LLM 設定節に「優先クラウド」説明を追加 (d)「できること」の設定記述に優先クラウドを反映 (e) `scripts/check-codex-protocol.sh` の存在をカスタマイズ節に1行
- [ ] **Step 2: CHANGELOG v0.23.0** — Codex のセッション永続化（再起動復元）/ 自動フォールバック / 優先クラウド設定 / プロトコルスナップショット、をユーザー視点で
- [ ] **Step 3: 手動スモーク（マージ前・実 codex 使用）**:
  1. `cd app && bun run dev` を起動し設定で会話ロール=Codex に一時変更 → 自由会話1往復（app-server 経路のログ確認）
  2. サーバ再起動 → 同一セッションで続きを送信 → 文脈が維持されている（thread/resume 経路）
  3. `codex` を PATH から外す or 名前変更して1往復 → exec フォールバック（それも失敗すれば通常のエラー応答）→ 元に戻す
  4. 設定をオールローカルへ戻す（ユーザーの常用構成）
- [ ] **Step 4: 統合検証** — 3ゲート全緑 + `./scripts/check-codex-protocol.sh` → OK
- [ ] **Step 5: マージ + リリース** — `git checkout main && git merge --no-ff feat/codex-app-server -m "Merge branch 'feat/codex-app-server': Codexセッション永続化と優先クラウド設定"` → タグ `v0.23.0` → `git push origin main --tags` → デプロイ: `cd app/client && bun run build && launchctl kickstart -k gui/$(id -u)/com.local.solo-eikaiwa.server` → `https://solo-eikaiwa/api/health` 200 確認
