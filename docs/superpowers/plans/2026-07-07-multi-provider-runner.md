# マルチプロバイダ LLM runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** コーチ・会話・コンテンツ生成など全ドメインが使う唯一の LLM 実行器（`ClaudeRunner`）のバックエンドを、環境変数だけで Anthropic Claude Agent SDK / OpenAI 互換 API（Ollama・LM Studio・OpenAI・GitHub Models）/ OpenAI Codex CLI に切り替え可能にする。既定（未設定）は現行と完全に同一挙動。

**Architecture:** 差し替え点は `app/server/converse.ts` の `ClaudeRunner` 型と、その唯一の生成点 `defaultRunner`。`ClaudeRunner` 型は一切変えず、2つの新アダプタ（OpenAI 互換・Codex）が既存シグネチャに合わせる。プロバイダ選択は新モジュール `llm-provider.ts` の純関数 `selectRunner()` に集約し、`converse.ts` の `defaultRunner` がそれ経由で組み立てる。ステートレスな両アダプタは、SDK の `resume` セマンティクス（`resumeId`）を各自のインメモリ会話ストア（`sessionId → messages[]`）で再現する。消費側6ファイル（converse / coach / placement / assessment / content-gen / generate-content スクリプト）は全て注入済みの `defaultRunner` を使うため、生成点1箇所の変更で全体が切り替わる。

**Tech Stack:** Bun + TypeScript（サーバ実行環境）、`bun:test`（サーバTDD）、グローバル `fetch`（OpenAI互換）、`Bun.spawn`（Codex 子プロセス）、`crypto.randomUUID()`（セッションID）。新規npm依存は追加しない。

## Global Constraints

各タスクの要件はこのセクションを暗黙に含む。値は既存コード・codex CLI 実挙動からの写しである。

- **`ClaudeRunner` 型は不変。** シグネチャ `(prompt: string, resumeId?: string, opts?: { systemPrompt?: string }) => Promise<{ text: string; sessionId: string }>`（`app/server/converse.ts:23-27`）を変更しない。新アダプタが必ずこの型に合わせる。消費側6ファイルは一切変更しない。
- **既定は claude・未設定は現行と完全同一。** `LLM_PROVIDER` 未設定または `claude` のとき、`defaultRunner` は現行と同一の `makeClaudeRunner(query)` インスタンスをそのまま返す（同一参照）。これが回帰基準：既存の全テストと既存ユーザー挙動が無影響であること。
- **循環 import を作らない。** provider モジュール群（`llm-provider.ts` / `providers/*.ts`）は `converse.ts` から **type-only import のみ**（`import type { ClaudeRunner }`）。`converse.ts` の実行時に必要な値（Claude runner・既定 systemPrompt）は `selectRunner()` の**引数として渡す**。値レベルで converse を import し返す依存を作らない。
- **secrets をログ・plist に書かない。** `Authorization` ヘッダや API キーをログ出力しない。プロバイダ用の秘密情報は `app/.env`（`.gitignore` 済み・Bun が自動ロード）に置き、LaunchAgent の plist（`scripts/install-daemon.sh`）には書かない。
- **サーバ TDD。** テストは `bun:test`（`app/server/__tests__/*.test.ts`）。外部依存はコンストラクタ注入のフェイクで検証する：OpenAI互換は `fetchFn`（フェイク `fetch`）、Codex は `exec`（フェイク子プロセス実行関数）。`app/` から `bun test` と `bun run typecheck`（= `tsc --noEmit`）を通す。
- **STRICT JSON 弱モデル耐性は既存フォールバックに委ねる。** 各ドメインは `extractJson` 失敗時のフォールバック（coach: 素テキストを1itemに包む / placement・assessment: `null` → ルート502 / content-gen: 2回リトライ後 throw）を既に持つ。アダプタ側で JSON を整形・修復しない（責務分離）。この事実を README に明記するに留める。
- **GitHub Copilot は対象外。** 公式の汎用チャット API が存在せず、非公式プロキシは利用規約リスクがあるため実装しない。GitHub の LLM を使いたい場合は「GitHub Models」を OpenAI 互換アダプタで叩く（レート制限に注意）。
- **将来のUI設定化はスコープ外。** プロバイダ選択は env のみ。サイドバー等での切替は本計画に含めない。
- **git 操作は実行者向け。** 各タスク末尾の commit ステップはこの計画の実装者が行う。書き溜め計画の作成時点ではコミットしない。

---

## 主要設計判断

### 判断1: Codex は「app-server 常駐 JSON-RPC」ではなく「`codex exec` ワンショット＋自前トランスクリプトストア」を採る

当初案は Codex の `app-server`（JSON-RPC over stdio・常駐子プロセス・`conversationId` を `sessionId` に写像）だったが、codex CLI 0.142.5 の実挙動を調査した上で **`codex exec` ワンショット方式に決定**する。根拠：

1. **プロトコル安定性。** `codex app-server` はヘルプ上 `[experimental]` と明記されており、JSON-RPC のイベント/メソッド形状はバージョン間で破壊的に変わりうる。対して `codex exec` は非 experimental の安定サブコマンドで、本計画が依存するフラグ（`-o/--output-last-message`・`-s/--sandbox`・`--skip-git-repo-check`）はすべて安定した公開オプション。
2. **出力取得が単純・堅牢。** `codex exec -o <file>` は「エージェントの最終メッセージ」だけをファイルに書く（`--json` の JSONL イベント列をパースする必要がない）。JSONL イベント形状の版差リスクを負わずに、確定したテキストだけを読める。
3. **セッション写像を Codex に依存しない。** `resumeId` セマンティクスは OpenAI 互換アダプタと同じ「自前インメモリ・トランスクリプトストア」で再現し、毎ターン system + これまでの会話 + 新規発話を1つのプロンプトに畳んで `codex exec` に**ステートレスに**渡す。Codex 自身の session/`resume` を使わないため、session-id を stdout からパースする必要も、rollout ファイルを race して探す必要もない。両アダプタが同一メンタルモデルになる。
4. **プロセス寿命管理が不要。** 常駐子プロセスの health/再起動/ゾンビ回収を持ち込まない。個人開発・単一利用者・低頻度呼び出し（README 前提）では、呼び出しごとの `codex exec` 起動コストは許容範囲。

**コスト（許容と判断）:** (a) 呼び出しごとにプロセス起動レイテンシが乗る。(b) 会話継続時、毎ターン過去トランスクリプトを再送するためトークンが増える。会話は「2〜4文＋質問1つ」の短い往復で、対象が個人利用のため実用上問題にならない。以上を計画内に明記して採用する。

**サンドボックス／承認の固定（安全上必須）:** 調査で判明した通り、ユーザーのグローバル `~/.codex/config.toml` は `sandbox_mode = "danger-full-access"` / `approval_policy = "never"` になっている。アダプタは **CLI フラグでこれを必ず上書き**し、`-s read-only`（CLIフラグは config より優先）＋ `-c approval_policy="never"`（非対話で昇格せず失敗させる）＋ 中立な作業ディレクトリ（`tmpdir()`）＋ `--skip-git-repo-check` で起動する。翻訳・JSON生成のようなテキストタスクではモデルはツールを呼ばないが、万一シェル実行を試みても read-only サンドボックスが書き込みを機構的に禁止する。「ツール実行なし・テキスト応答のみ」を完全にフラグで無効化する専用オプションは codex exec には無いため、**read-only サンドボックスが硬い安全境界**である旨を明記する。

### 判断2: プロバイダ対応表（OpenAI 互換1本で主要ローカル/クラウドを網羅）

| プロバイダ | `LLM_PROVIDER` | 追加設定 | 備考 |
|---|---|---|---|
| Anthropic Claude Agent SDK | 未設定 or `claude` | なし | 現行と同一。回帰基準。 |
| Ollama（ローカル本命） | `openai-compat` | `OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1`・`OPENAI_COMPAT_MODEL=<tag>` | APIキー不要 |
| LM Studio（ローカル） | `openai-compat` | `OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1`・`OPENAI_COMPAT_MODEL=<id>` | APIキー不要 |
| OpenAI API | `openai-compat` | `OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1`・`OPENAI_COMPAT_API_KEY=…`・`OPENAI_COMPAT_MODEL=gpt-4o-mini` 等 | |
| GitHub Models | `openai-compat` | `OPENAI_COMPAT_BASE_URL=https://models.github.ai/inference`・`OPENAI_COMPAT_API_KEY=<PAT>`・`OPENAI_COMPAT_MODEL=…` | 厳しめのレート制限に注意 |
| OpenAI Codex CLI | `codex` | 任意 `CODEX_MODEL=…`（未指定は codex config 既定） | 判断1参照 |
| GitHub Copilot | — | — | **対象外**（公式汎用API無し・非公式プロキシは規約リスク） |

### 判断3: 品質差の前提（プロンプトは Claude 向けにチューニング済み）

各ドメインの system プロンプトは Claude 向けに調整されており、多くが「STRICT JSON のみで返す」ことを要求する。弱いモデルでは JSON 逸脱や品質低下が起きうるが、**全ドメインが既にパース失敗フォールバックを持つ**（Global Constraints 参照）ため、アプリはクラッシュせず degrade する。アダプタ側で JSON を修復しない。README にこの前提と、ローカル小モデル利用時の品質期待値を明記する。

---

## File Structure

**新規（サーバ）**
- `app/server/providers/openai-compat.ts` — `makeOpenAICompatRunner(cfg)`。OpenAI 互換 `POST {baseUrl}/chat/completions` を叩く `ClaudeRunner`。`resumeId` はインメモリ `Map<sessionId, ChatMsg[]>` で再現。`fetchFn` 注入可。
- `app/server/providers/codex.ts` — `composeCodexPrompt()`（純関数）＋ `makeCodexRunner(cfg)`（`ClaudeRunner`）＋ `realCodexExec`（`codex exec` を叩く薄い実装）＋ `CodexExec` 型。`exec` 注入可。
- `app/server/llm-provider.ts` — `selectRunner(args)`（純関数のプロバイダ選択器）。`converse.ts` から type-only import のみ。

**変更（サーバ）**
- `app/server/converse.ts` — `defaultRunner` の定義を `makeClaudeRunner(query)` 直書きから `selectRunner({ claudeRunner: makeClaudeRunner(query), defaultSystemPrompt: PARTNER_SYSTEM_PROMPT })` に差し替える（唯一の生成点）。`ClaudeRunner` 型・`makeClaudeRunner`・`PARTNER_SYSTEM_PROMPT` はそのまま。
- `scripts/generate-content.ts` — 自前の `makeClaudeRunner(query)` をやめ、`converse.ts` の provider-selected な `defaultRunner` を import して使う（CLI もプロバイダ選択に追従）。

**新規（テスト）**
- `app/server/__tests__/openai-compat.test.ts`
- `app/server/__tests__/codex.test.ts`
- `app/server/__tests__/llm-provider.test.ts`

**変更（ドキュメント）**
- `app/.env.example` — provider 用 env のテンプレを追記。
- `README.md` — 「LLM プロバイダの切替」節を追加（対応表・env・品質前提・Codex 安全設定・Copilot 対象外）。

---

## Task 1: OpenAI 互換アダプタ

**Files:**
- Create: `app/server/providers/openai-compat.ts`
- Test: `app/server/__tests__/openai-compat.test.ts`

**Interfaces:**
- Consumes: `import type { ClaudeRunner } from "../converse"`（型のみ・実行時依存なし）。
- Produces:
  - `export type OpenAICompatConfig = { baseUrl: string; apiKey?: string; model: string; defaultSystemPrompt: string; fetchFn?: typeof fetch }`
  - `export function makeOpenAICompatRunner(cfg: OpenAICompatConfig): ClaudeRunner`

- [ ] **Step 1: Write the failing test**

`app/server/__tests__/openai-compat.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeOpenAICompatRunner, type OpenAICompatConfig } from "../providers/openai-compat";

type CapturedReq = { url: string; body: any; headers: Record<string, string> };

/** choices[0].message.content = reply を返すフェイク fetch。呼び出し内容を captured に記録する。 */
function fakeChatFetch(reply: string, captured: CapturedReq[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    captured.push({ url, body: JSON.parse(String(init.body)), headers });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function baseCfg(over: Partial<OpenAICompatConfig> = {}): OpenAICompatConfig {
  return {
    baseUrl: "http://localhost:11434/v1",
    model: "test-model",
    defaultSystemPrompt: "DEFAULT SYS",
    fetchFn: fakeChatFetch("hi there", []),
    ...over,
  };
}

describe("makeOpenAICompatRunner", () => {
  test("初回ターン: /chat/completions を叩き、system+user を送り、text と非空 sessionId を返す", async () => {
    const captured: CapturedReq[] = [];
    const runner = makeOpenAICompatRunner(baseCfg({ fetchFn: fakeChatFetch("hi there", captured) }));

    const r = await runner("Hello", undefined, { systemPrompt: "PARTNER SYS" });

    expect(r.text).toBe("hi there");
    expect(r.sessionId).toBeTruthy();
    expect(captured[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(captured[0].body.model).toBe("test-model");
    expect(captured[0].body.messages).toEqual([
      { role: "system", content: "PARTNER SYS" },
      { role: "user", content: "Hello" },
    ]);
  });

  test("systemPrompt 未指定時は defaultSystemPrompt を使う", async () => {
    const captured: CapturedReq[] = [];
    const runner = makeOpenAICompatRunner(baseCfg({ fetchFn: fakeChatFetch("x", captured) }));
    await runner("Hello");
    expect(captured[0].body.messages[0]).toEqual({ role: "system", content: "DEFAULT SYS" });
  });

  test("resume: 返ってきた sessionId を渡すと直前の user/assistant が履歴として送られる", async () => {
    const captured: CapturedReq[] = [];
    const runner = makeOpenAICompatRunner(baseCfg({ fetchFn: fakeChatFetch("reply-1", captured) }));
    const first = await runner("turn one", undefined, { systemPrompt: "S" });
    await runner("turn two", first.sessionId, { systemPrompt: "S" });

    expect(captured[1].body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "turn one" },
      { role: "assistant", content: "reply-1" },
      { role: "user", content: "turn two" },
    ]);
  });

  test("resume miss: 未知の sessionId は履歴なしの新セッションになり、新しい id を返す", async () => {
    const captured: CapturedReq[] = [];
    const runner = makeOpenAICompatRunner(baseCfg({ fetchFn: fakeChatFetch("y", captured) }));
    const r = await runner("hi", "nonexistent-session", { systemPrompt: "S" });
    expect(r.sessionId).not.toBe("nonexistent-session");
    expect(captured[0].body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "hi" },
    ]);
  });

  test("apiKey あり: Authorization ヘッダを付ける / なし: 付けない", async () => {
    const withKey: CapturedReq[] = [];
    await makeOpenAICompatRunner(baseCfg({ apiKey: "sk-test", fetchFn: fakeChatFetch("z", withKey) }))("hi");
    expect(withKey[0].headers["authorization"]).toBe("Bearer sk-test");

    const noKey: CapturedReq[] = [];
    await makeOpenAICompatRunner(baseCfg({ fetchFn: fakeChatFetch("z", noKey) }))("hi");
    expect(noKey[0].headers["authorization"]).toBeUndefined();
  });

  test("baseUrl 末尾スラッシュを正規化する", async () => {
    const captured: CapturedReq[] = [];
    const runner = makeOpenAICompatRunner(baseCfg({ baseUrl: "http://localhost:1234/v1/", fetchFn: fakeChatFetch("z", captured) }));
    await runner("hi");
    expect(captured[0].url).toBe("http://localhost:1234/v1/chat/completions");
  });

  test("非2xx応答: ステータスを含めて throw する", async () => {
    const badFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const runner = makeOpenAICompatRunner(baseCfg({ fetchFn: badFetch }));
    await expect(runner("hi")).rejects.toThrow(/500/);
  });

  test("空 content: empty で throw する", async () => {
    const emptyFetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 })) as unknown as typeof fetch;
    const runner = makeOpenAICompatRunner(baseCfg({ fetchFn: emptyFetch }));
    await expect(runner("hi")).rejects.toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && bun test server/__tests__/openai-compat.test.ts`
Expected: FAIL — `Cannot find module "../providers/openai-compat"`。

- [ ] **Step 3: Write minimal implementation**

`app/server/providers/openai-compat.ts`:

```ts
import type { ClaudeRunner } from "../converse";

/** OpenAI 互換 chat completions で ClaudeRunner を実現する設定。 */
export type OpenAICompatConfig = {
  /** 例: http://localhost:11434/v1 （末尾の /chat/completions は付けない） */
  baseUrl: string;
  /** Ollama/LM Studio では不要。設定時のみ Authorization: Bearer を付与する */
  apiKey?: string;
  model: string;
  /** opts.systemPrompt 未指定時に使う既定 system プロンプト（Claude の PARTNER_SYSTEM_PROMPT 相当） */
  defaultSystemPrompt: string;
  /** テスト用の注入 seam。既定はグローバル fetch */
  fetchFn?: typeof fetch;
};

type ChatMsg = { role: "user" | "assistant"; content: string };

type ChatResponse = { choices?: Array<{ message?: { content?: string } }> };

/**
 * OpenAI 互換 API を叩く ClaudeRunner。chat completions はステートレスなので、
 * SDK の resume セマンティクスを sessionId → 会話履歴(system を除く) のインメモリ Map で再現する。
 * プロセス再起動で履歴が消えるのは既存 SDK セッションも同様（許容）。
 */
export function makeOpenAICompatRunner(cfg: OpenAICompatConfig): ClaudeRunner {
  const fetchFn = cfg.fetchFn ?? fetch;
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const store = new Map<string, ChatMsg[]>();

  return async (prompt, resumeId, opts) => {
    const sessionId = resumeId && store.has(resumeId) ? resumeId : crypto.randomUUID();
    const history = store.get(sessionId) ?? [];
    const system = opts?.systemPrompt ?? cfg.defaultSystemPrompt;

    const messages = [
      { role: "system" as const, content: system },
      ...history,
      { role: "user" as const, content: prompt },
    ];

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

    const res = await fetchFn(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, messages, stream: false }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI-compat chat failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as ChatResponse;
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("OpenAI-compat returned empty result");

    store.set(sessionId, [
      ...history,
      { role: "user", content: prompt },
      { role: "assistant", content: text },
    ]);
    return { text, sessionId };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && bun test server/__tests__/openai-compat.test.ts`
Expected: PASS（8 test）。

- [ ] **Step 5: Typecheck**

Run: `cd app && bun run typecheck`
Expected: エラーなし。

- [ ] **Step 6: Commit**

```bash
git add app/server/providers/openai-compat.ts app/server/__tests__/openai-compat.test.ts
git commit -m "feat: OpenAI互換 LLM ランナー（Ollama/LM Studio/OpenAI/GitHub Models 対応）"
```

---

## Task 2: Codex アダプタ

**Files:**
- Create: `app/server/providers/codex.ts`
- Test: `app/server/__tests__/codex.test.ts`

**Interfaces:**
- Consumes: `import type { ClaudeRunner } from "../converse"`（型のみ）。
- Produces:
  - `export type CodexMsg = { role: "user" | "assistant"; content: string }`
  - `export function composeCodexPrompt(system: string, history: CodexMsg[], userPrompt: string): string`
  - `export type CodexExec = (args: { prompt: string; model?: string; cwd: string }) => Promise<string>`
  - `export type CodexConfig = { model?: string; cwd?: string; defaultSystemPrompt: string; exec?: CodexExec }`
  - `export function makeCodexRunner(cfg: CodexConfig): ClaudeRunner`
  - `export const realCodexExec: CodexExec`

- [ ] **Step 1: Write the failing test**

`app/server/__tests__/codex.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { composeCodexPrompt, makeCodexRunner, type CodexConfig, type CodexExec } from "../providers/codex";

describe("composeCodexPrompt", () => {
  test("履歴なし: system と最終 user プロンプトを含み、会話ブロックは出さない", () => {
    const out = composeCodexPrompt("SYS", [], "hello");
    expect(out).toContain("SYS");
    expect(out).toContain("hello");
    expect(out).not.toContain("CONVERSATION SO FAR");
  });

  test("履歴あり: 過去の User/Assistant を会話ブロックに順序どおり畳む", () => {
    const out = composeCodexPrompt("SYS", [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ], "q2");
    expect(out).toContain("CONVERSATION SO FAR");
    const iUser = out.indexOf("q1");
    const iAsst = out.indexOf("a1");
    const iNew = out.indexOf("q2");
    expect(iUser).toBeGreaterThanOrEqual(0);
    expect(iAsst).toBeGreaterThan(iUser);
    expect(iNew).toBeGreaterThan(iAsst);
  });
});

/** exec 呼び出しを記録し、canned テキストを返すフェイク。 */
function fakeExec(reply: string, seen: Array<{ prompt: string; model?: string; cwd: string }>): CodexExec {
  return async (args) => {
    seen.push(args);
    return reply;
  };
}

function baseCfg(over: Partial<CodexConfig> = {}): CodexConfig {
  return { defaultSystemPrompt: "DEFAULT SYS", exec: fakeExec("codex reply", []), ...over };
}

describe("makeCodexRunner", () => {
  test("初回ターン: composed プロンプトに system と user を含めて exec し、text と非空 sessionId を返す", async () => {
    const seen: Array<{ prompt: string; model?: string; cwd: string }> = [];
    const runner = makeCodexRunner(baseCfg({ exec: fakeExec("codex reply", seen), model: "gpt-5.5" }));

    const r = await runner("Hello there", undefined, { systemPrompt: "PARTNER SYS" });

    expect(r.text).toBe("codex reply");
    expect(r.sessionId).toBeTruthy();
    expect(seen[0].prompt).toContain("PARTNER SYS");
    expect(seen[0].prompt).toContain("Hello there");
    expect(seen[0].model).toBe("gpt-5.5");
  });

  test("systemPrompt 未指定時は defaultSystemPrompt を composed に使う", async () => {
    const seen: Array<{ prompt: string; model?: string; cwd: string }> = [];
    const runner = makeCodexRunner(baseCfg({ exec: fakeExec("x", seen) }));
    await runner("hi");
    expect(seen[0].prompt).toContain("DEFAULT SYS");
  });

  test("resume: 返った sessionId で再呼び出しすると過去の往復が composed に入る", async () => {
    const seen: Array<{ prompt: string; model?: string; cwd: string }> = [];
    const runner = makeCodexRunner(baseCfg({ exec: fakeExec("reply-1", seen) }));
    const first = await runner("turn one", undefined, { systemPrompt: "S" });
    await runner("turn two", first.sessionId, { systemPrompt: "S" });

    expect(seen[1].prompt).toContain("turn one");
    expect(seen[1].prompt).toContain("reply-1");
    expect(seen[1].prompt).toContain("turn two");
  });

  test("空出力: empty で throw する", async () => {
    const runner = makeCodexRunner(baseCfg({ exec: fakeExec("   ", []) }));
    await expect(runner("hi")).rejects.toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && bun test server/__tests__/codex.test.ts`
Expected: FAIL — `Cannot find module "../providers/codex"`。

- [ ] **Step 3: Write minimal implementation**

`app/server/providers/codex.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeRunner } from "../converse";

export type CodexMsg = { role: "user" | "assistant"; content: string };

/**
 * system 指示・これまでの会話・新しい user 発話を、codex exec が読む1つのプロンプト文字列に畳む。
 * codex exec には Claude の systemPrompt に相当する別チャンネルが無いため、先頭に指示ブロックとして埋め込む。
 * 純関数（副作用なし）。
 */
export function composeCodexPrompt(system: string, history: CodexMsg[], userPrompt: string): string {
  const parts: string[] = [
    "[SYSTEM INSTRUCTIONS]",
    system,
  ];
  if (history.length > 0) {
    parts.push("", "[CONVERSATION SO FAR]");
    for (const m of history) {
      parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
    }
  }
  parts.push(
    "",
    "[RESPOND TO THE FOLLOWING — output only the reply text, no preamble, no tool calls]",
    `User: ${userPrompt}`,
  );
  return parts.join("\n");
}

/** codex exec を1回実行し、エージェントの最終メッセージ本文を返す関数の型（テスト用 seam）。 */
export type CodexExec = (args: { prompt: string; model?: string; cwd: string }) => Promise<string>;

export type CodexConfig = {
  /** 省略時は codex config の既定モデル（-m を渡さない） */
  model?: string;
  /** codex を起動する作業ディレクトリ。既定は tmpdir()（read-only サンドボックスなので無害な中立ディレクトリ） */
  cwd?: string;
  /** opts.systemPrompt 未指定時の既定 system プロンプト */
  defaultSystemPrompt: string;
  /** テスト用の注入 seam。既定は realCodexExec */
  exec?: CodexExec;
};

/**
 * `codex exec` をワンショットで叩く ClaudeRunner。
 * resume セマンティクスは sessionId → 会話履歴 のインメモリ Map で再現し、毎ターン全文を composeCodexPrompt で
 * 畳んで渡す（codex 自身の session/resume は使わない）。プロセス再起動で履歴が消えるのは既存 SDK と同様（許容）。
 */
export function makeCodexRunner(cfg: CodexConfig): ClaudeRunner {
  const exec = cfg.exec ?? realCodexExec;
  const cwd = cfg.cwd ?? tmpdir();
  const store = new Map<string, CodexMsg[]>();

  return async (prompt, resumeId, opts) => {
    const sessionId = resumeId && store.has(resumeId) ? resumeId : crypto.randomUUID();
    const history = store.get(sessionId) ?? [];
    const system = opts?.systemPrompt ?? cfg.defaultSystemPrompt;

    const composed = composeCodexPrompt(system, history, prompt);
    const text = (await exec({ prompt: composed, model: cfg.model, cwd })).trim();
    if (!text) throw new Error("Codex returned empty result");

    store.set(sessionId, [
      ...history,
      { role: "user", content: prompt },
      { role: "assistant", content: text },
    ]);
    return { text, sessionId };
  };
}

/**
 * 実際の `codex exec` 実行。安全のため CLI フラグでユーザー config を必ず上書きする:
 * - `-s read-only`   : サンドボックスを read-only に固定（config の danger-full-access を上書き。CLI が優先）
 * - `-c approval_policy="never"` : 非対話で昇格せず失敗させる（承認プロンプトで固まらない）
 * - `--skip-git-repo-check` / `-C tmpdir` : 中立な作業ディレクトリで git チェックを回避
 * - `-o <file>`      : エージェントの最終メッセージだけをファイルに書かせ、そこから読む（JSONL パース不要）
 * プロンプトは argv ではなく stdin から渡す（長文と "-" 始まりの argv injection を避ける）。
 * この関数は codex CLI に依存するため単体テスト対象外。makeCodexRunner は注入した exec フェイクで検証し、
 * ここは Task 5 の手動スモークで確認する。
 */
export const realCodexExec: CodexExec = async ({ prompt, model, cwd }) => {
  const work = mkdtempSync(path.join(tmpdir(), "codex-run-"));
  try {
    const outFile = path.join(work, "last.txt");
    const args = [
      "exec",
      "--skip-git-repo-check",
      "-s", "read-only",
      "-c", 'approval_policy="never"',
      "-C", cwd,
      "--color", "never",
      "-o", outFile,
      ...(model ? ["-m", model] : []),
      "-", // プロンプトは stdin から読む
    ];
    const proc = Bun.spawn(["codex", ...args], {
      cwd,
      stdin: new TextEncoder().encode(prompt),
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`codex exec failed (exit ${exitCode}): ${stderr.slice(-500)}`);
    }
    return readFileSync(outFile, "utf8");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && bun test server/__tests__/codex.test.ts`
Expected: PASS（6 test）。

- [ ] **Step 5: Typecheck**

Run: `cd app && bun run typecheck`
Expected: エラーなし。

- [ ] **Step 6: Commit**

```bash
git add app/server/providers/codex.ts app/server/__tests__/codex.test.ts
git commit -m "feat: Codex CLI LLM ランナー（codex exec ワンショット・read-only固定・自前トランスクリプト）"
```

---

## Task 3: プロバイダ選択器（selectRunner）

**Files:**
- Create: `app/server/llm-provider.ts`
- Test: `app/server/__tests__/llm-provider.test.ts`

**Interfaces:**
- Consumes:
  - `import type { ClaudeRunner } from "./converse"`（型のみ・実行時の循環を作らない）。
  - Task 1 の `makeOpenAICompatRunner`、Task 2 の `makeCodexRunner`。
- Produces:
  - `export type SelectRunnerArgs = { claudeRunner: ClaudeRunner; defaultSystemPrompt: string; env?: Record<string, string | undefined> }`
  - `export function selectRunner(args: SelectRunnerArgs): ClaudeRunner`

- [ ] **Step 1: Write the failing test**

`app/server/__tests__/llm-provider.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { selectRunner } from "../llm-provider";
import type { ClaudeRunner } from "../converse";

/** 参照比較用のセンチネル runner（呼ばれない） */
const sentinel: ClaudeRunner = async () => ({ text: "sentinel", sessionId: "s" });

function args(env: Record<string, string | undefined>) {
  return { claudeRunner: sentinel, defaultSystemPrompt: "DEFAULT SYS", env };
}

describe("selectRunner", () => {
  test("LLM_PROVIDER 未設定: claudeRunner をそのまま返す（同一参照＝現行と完全同一）", () => {
    expect(selectRunner(args({}))).toBe(sentinel);
  });

  test("LLM_PROVIDER=claude: claudeRunner をそのまま返す", () => {
    expect(selectRunner(args({ LLM_PROVIDER: "claude" }))).toBe(sentinel);
  });

  test("大文字・前後空白を許容する", () => {
    expect(selectRunner(args({ LLM_PROVIDER: "  Claude  " }))).toBe(sentinel);
  });

  test("openai-compat: claudeRunner とは別の runner を返す", () => {
    const r = selectRunner(args({
      LLM_PROVIDER: "openai-compat",
      OPENAI_COMPAT_BASE_URL: "http://localhost:11434/v1",
      OPENAI_COMPAT_MODEL: "m",
    }));
    expect(r).not.toBe(sentinel);
    expect(typeof r).toBe("function");
  });

  test("openai-compat: BASE_URL 欠落は明示エラー", () => {
    expect(() => selectRunner(args({ LLM_PROVIDER: "openai-compat", OPENAI_COMPAT_MODEL: "m" })))
      .toThrow(/OPENAI_COMPAT_BASE_URL/);
  });

  test("openai-compat: MODEL 欠落は明示エラー", () => {
    expect(() => selectRunner(args({ LLM_PROVIDER: "openai-compat", OPENAI_COMPAT_BASE_URL: "http://x/v1" })))
      .toThrow(/OPENAI_COMPAT_MODEL/);
  });

  test("codex: claudeRunner とは別の runner を返す", () => {
    const r = selectRunner(args({ LLM_PROVIDER: "codex" }));
    expect(r).not.toBe(sentinel);
    expect(typeof r).toBe("function");
  });

  test("未知プロバイダ: 明示エラー", () => {
    expect(() => selectRunner(args({ LLM_PROVIDER: "gemini" }))).toThrow(/Unknown LLM_PROVIDER/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && bun test server/__tests__/llm-provider.test.ts`
Expected: FAIL — `Cannot find module "../llm-provider"`。

- [ ] **Step 3: Write minimal implementation**

`app/server/llm-provider.ts`:

```ts
import type { ClaudeRunner } from "./converse";
import { makeOpenAICompatRunner } from "./providers/openai-compat";
import { makeCodexRunner } from "./providers/codex";

export type SelectRunnerArgs = {
  /** 既定（claude）で返す、事前構築済みの Claude SDK runner。converse.ts から渡す（循環回避のため） */
  claudeRunner: ClaudeRunner;
  /** アダプタが systemPrompt 未指定時に使う既定プロンプト（PARTNER_SYSTEM_PROMPT） */
  defaultSystemPrompt: string;
  /** テスト用の注入 seam。既定は Bun.env */
  env?: Record<string, string | undefined>;
};

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v || !v.trim()) throw new Error(`${key} is required when LLM_PROVIDER=openai-compat`);
  return v.trim();
}

/**
 * LLM_PROVIDER に応じて ClaudeRunner を選ぶ純関数。
 * 未設定/claude は渡された claudeRunner をそのまま返す（現行と完全同一＝回帰基準）。
 * converse.ts の defaultRunner 生成点から1度だけ呼ばれる。
 */
export function selectRunner(args: SelectRunnerArgs): ClaudeRunner {
  const env = args.env ?? Bun.env;
  const provider = (env.LLM_PROVIDER ?? "claude").trim().toLowerCase();

  switch (provider) {
    case "":
    case "claude":
      return args.claudeRunner;

    case "openai-compat":
      return makeOpenAICompatRunner({
        baseUrl: requireEnv(env, "OPENAI_COMPAT_BASE_URL"),
        apiKey: env.OPENAI_COMPAT_API_KEY?.trim() || undefined,
        model: requireEnv(env, "OPENAI_COMPAT_MODEL"),
        defaultSystemPrompt: args.defaultSystemPrompt,
      });

    case "codex":
      return makeCodexRunner({
        model: env.CODEX_MODEL?.trim() || undefined,
        defaultSystemPrompt: args.defaultSystemPrompt,
      });

    default:
      throw new Error(`Unknown LLM_PROVIDER: ${provider} (expected claude | openai-compat | codex)`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && bun test server/__tests__/llm-provider.test.ts`
Expected: PASS（8 test）。

- [ ] **Step 5: Typecheck**

Run: `cd app && bun run typecheck`
Expected: エラーなし。

- [ ] **Step 6: Commit**

```bash
git add app/server/llm-provider.ts app/server/__tests__/llm-provider.test.ts
git commit -m "feat: LLM_PROVIDER による runner 選択器 selectRunner を追加"
```

---

## Task 4: 生成点の配線（converse.ts と generate-content.ts）＋ 回帰

**Files:**
- Modify: `app/server/converse.ts:67-73`（`defaultRunner` の定義）
- Modify: `scripts/generate-content.ts:12-22`（自前 runner をやめ provider-selected な defaultRunner を使う）

**Interfaces:**
- Consumes: Task 3 の `selectRunner`、既存の `makeClaudeRunner` / `PARTNER_SYSTEM_PROMPT`（`converse.ts` 内）。
- Produces: `export const defaultRunner: ClaudeRunner`（型・エクスポート名は不変。中身が provider-selected になる）。

このタスクは「生成点の差し替え」で、副作用は全消費側に及ぶが、既定（env 未設定）では返る runner が現行と同一参照のため挙動は変わらない。専用の新規テストは追加せず、**既存テスト全通過＋typecheck＋手動スモーク**を検証手段とする。

- [ ] **Step 1: 事前に現行のグリーンを確認する（回帰ベースライン）**

Run: `cd app && bun test`
Expected: PASS（全既存テスト）。ここでの合格数を控えておく（差分比較用）。

- [ ] **Step 2: `converse.ts` の import を追加する**

`app/server/converse.ts` の先頭 import 群（1行目 `import { query } ...` の直後）に追加する:

```ts
import { selectRunner } from "./llm-provider";
```

- [ ] **Step 3: `defaultRunner` の定義を差し替える**

`app/server/converse.ts` の現行:

```ts
export const defaultRunner: ClaudeRunner = makeClaudeRunner(query);
```

を、次に置き換える（直前の JSDoc コメントブロックは残す）:

```ts
export const defaultRunner: ClaudeRunner = selectRunner({
  claudeRunner: makeClaudeRunner(query),
  defaultSystemPrompt: PARTNER_SYSTEM_PROMPT,
});
```

補足（実装者向け・コードには書かない）: この行は `PARTNER_SYSTEM_PROMPT`（同ファイル21行目で初期化済み）より後で評価されるため、`selectRunner` 実行時に `PARTNER_SYSTEM_PROMPT` は必ず初期化済み。`llm-provider.ts` は `converse.ts` を type-only import のみ参照するため実行時の循環は発生しない。

- [ ] **Step 4: 既存テスト全通過を確認する**

Run: `cd app && bun test`
Expected: PASS（Step 1 と同じ合格数。converse 系・全ドメイン系が無影響で通ること）。

- [ ] **Step 5: `generate-content.ts` を provider-selected runner に切り替える**

`scripts/generate-content.ts` の現行 import・runner 生成:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { openDb } from "../app/server/db";
import { genSentences, genTopics, genScenarios, genListening } from "../app/server/content-gen";
import { makeClaudeRunner } from "../app/server/converse";
import { makeProgressStore } from "../app/server/progress-store";
import { stageOf } from "../app/server/progression";
import { SENTENCES_FILE, SCENARIOS_DIR, TOPICS_DIR, LISTENING_DIR } from "../app/server/paths";

const sub = process.argv[2];
const dry = process.argv.includes("--dry");
const runner = makeClaudeRunner(query);
```

を次に置き換える（`query` と `makeClaudeRunner` の import を削除し、`defaultRunner` を使う）:

```ts
import { openDb } from "../app/server/db";
import { genSentences, genTopics, genScenarios, genListening } from "../app/server/content-gen";
import { defaultRunner } from "../app/server/converse";
import { makeProgressStore } from "../app/server/progress-store";
import { stageOf } from "../app/server/progression";
import { SENTENCES_FILE, SCENARIOS_DIR, TOPICS_DIR, LISTENING_DIR } from "../app/server/paths";

const sub = process.argv[2];
const dry = process.argv.includes("--dry");
const runner = defaultRunner;
```

ヘッダ JSDoc の「対話AIは Claude Agent SDK（サブスクリプション認証）を使う。」の行は、次に更新する:

```ts
 * 既定は Claude Agent SDK（サブスクリプション認証）。LLM_PROVIDER で openai-compat / codex に切替可能。
```

- [ ] **Step 6: スクリプトの typecheck / 起動時パースを確認する**

Run: `cd app && bun run typecheck`
Expected: エラーなし。

Run: `cd <repo-root> && bun scripts/generate-content.ts 2>&1 | head -3`
Expected: 使い方メッセージ（`使い方: bun scripts/generate-content.ts <sentences|topics|scenarios|listening> [--dry]`）が出て exit 1。import 解決と runner 構築が壊れていないことの確認（LLM は呼ばれない）。

- [ ] **Step 7: 手動スモーク（任意・実行者が判断） — 各プロバイダ疎通**

以下は自動テスト対象外の実疎通確認。CI では走らせない。ローカルで任意に実施する。

claude（既定・回帰）:
```bash
cd app && LLM_PROVIDER= bun -e '
import { defaultRunner } from "./server/converse";
console.log((await defaultRunner("Say hello in one short sentence.")).text);
'
```

openai-compat（Ollama 起動時の例。モデルは手元の tag に合わせる）:
```bash
cd app && LLM_PROVIDER=openai-compat \
  OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1 \
  OPENAI_COMPAT_MODEL=llama3.1:8b \
  bun -e '
import { defaultRunner } from "./server/converse";
console.log((await defaultRunner("Say hello in one short sentence.")).text);
'
```

codex（ChatGPT サブスク・read-only 固定を確認）:
```bash
cd app && LLM_PROVIDER=codex bun -e '
import { defaultRunner } from "./server/converse";
console.log((await defaultRunner("Say hello in one short sentence.")).text);
'
```
Expected: いずれも1文の英語が返る。codex はプロセス起動分だけ遅い。失敗時は stderr のエラーメッセージで原因を確認する（認証切れ・モデル名誤り等）。

- [ ] **Step 8: Commit**

```bash
git add app/server/converse.ts scripts/generate-content.ts
git commit -m "feat: defaultRunner を LLM_PROVIDER で切替（既定は現行と同一・生成点1箇所）"
```

---

## Task 5: ドキュメント（.env.example と README）

**Files:**
- Modify: `app/.env.example`
- Modify: `README.md`（「LLM プロバイダの切替」節を追加）

このタスクはコード挙動を変えない。テストは無く、内容の正確さ（env 名・既定・安全設定・対象外）で判断する。

- [ ] **Step 1: `.env.example` にプロバイダ設定を追記する**

`app/.env.example` の現行:

```
OPENAI_API_KEY=
```

を次に置き換える:

```
# TTS/STT 用（既存）
OPENAI_API_KEY=

# LLM プロバイダ選択（未設定 or claude が既定＝現行と完全同一）
# claude | openai-compat | codex
LLM_PROVIDER=

# LLM_PROVIDER=openai-compat のとき（Ollama / LM Studio / OpenAI / GitHub Models）
# 例(Ollama):   http://localhost:11434/v1
# 例(LM Studio): http://localhost:1234/v1
# 例(OpenAI):    https://api.openai.com/v1
OPENAI_COMPAT_BASE_URL=
# ローカル(Ollama/LM Studio)は不要。OpenAI/GitHub Models は必須
OPENAI_COMPAT_API_KEY=
OPENAI_COMPAT_MODEL=

# LLM_PROVIDER=codex のとき（任意・未指定は codex config の既定モデル）
CODEX_MODEL=
```

- [ ] **Step 2: README に「LLM プロバイダの切替」節を追加する**

`README.md` の適切な位置（環境変数やセットアップに関する節の近く）に、次の節を追加する:

```markdown
## LLM プロバイダの切替

コーチ・会話・コンテンツ生成が使う LLM バックエンドは環境変数 `LLM_PROVIDER` で切り替えられる。既定（未設定 or `claude`）は Anthropic Claude Agent SDK で、現行と完全に同一の挙動。設定は `app/.env`（gitignore 済み）に置く。LaunchAgent の plist には秘密情報を書かない。

| プロバイダ | `LLM_PROVIDER` | 必要な env |
|---|---|---|
| Claude Agent SDK（既定） | 未設定 or `claude` | なし |
| Ollama | `openai-compat` | `OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1`, `OPENAI_COMPAT_MODEL` |
| LM Studio | `openai-compat` | `OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1`, `OPENAI_COMPAT_MODEL` |
| OpenAI API | `openai-compat` | `OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1`, `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_MODEL` |
| GitHub Models | `openai-compat` | `OPENAI_COMPAT_BASE_URL=https://models.github.ai/inference`, `OPENAI_COMPAT_API_KEY`(PAT), `OPENAI_COMPAT_MODEL`（レート制限に注意） |
| OpenAI Codex CLI | `codex` | 任意 `CODEX_MODEL`（未指定は codex config 既定） |

- **GitHub Copilot は非対応**: 公式の汎用チャット API が無く、非公式プロキシは規約リスクがあるため。GitHub の LLM を使う場合は上記「GitHub Models」を利用する。
- **品質の前提**: 各ドメインのプロンプトは Claude 向けに調整されており、多くが「STRICT JSON のみ」を要求する。弱いモデルでは JSON 逸脱や品質低下が起きうるが、全ドメインがパース失敗フォールバックを持つためアプリはクラッシュせず degrade する。ローカル小モデルでは出力品質が落ちる前提で使う。
- **セッション継続**: OpenAI 互換・Codex はステートレスなため、会話の継続はサーバのインメモリ・トランスクリプトで再現する。サーバ再起動で会話履歴は失われる（Claude SDK セッションも同様）。
- **Codex の安全設定**: Codex アダプタは常に read-only サンドボックス（`-s read-only`）・非対話（`approval_policy="never"`）・中立な作業ディレクトリで `codex exec` を起動し、ユーザーの `~/.codex/config.toml`（`danger-full-access` 等）を CLI フラグで上書きする。テキスト応答のみを取得し、ファイル書き込みは機構的に禁止される。
```

- [ ] **Step 3: 追記の妥当性を目視確認する**

Run: `cd <repo-root> && grep -n "LLM プロバイダの切替\|LLM_PROVIDER\|OPENAI_COMPAT_BASE_URL" README.md app/.env.example`
Expected: 追記した見出し・env 名が両ファイルに出る。

- [ ] **Step 4: Commit**

```bash
git add app/.env.example README.md
git commit -m "docs: LLM プロバイダ切替（openai-compat / codex）の設定と前提を追記"
```

---

## 最終検証（全タスク後）

- [ ] **全テスト＋typecheck を通す**

Run: `cd app && bun test && bun run typecheck`
Expected: 既存テスト＋新規22 test（openai-compat 8 / codex 6 / llm-provider 8）が全て PASS、型エラーなし。

- [ ] **回帰の要（既定挙動の同一性）を確認する**

`LLM_PROVIDER` 未設定で `selectRunner` が `claudeRunner`（＝`makeClaudeRunner(query)`）を同一参照で返すことは Task 3 のテストで担保済み。既存の converse/coach/placement/assessment/content-gen 系テストが Task 4 の配線後も無変更で通ることが、既定挙動不変の実証となる。

---

## Self-Review

**1. Spec coverage（team lead の指示との突合）:**
- 差し替え点 `ClaudeRunner` 型・唯一の生成点 `defaultRunner` → Task 4 で生成点1箇所を差し替え。型は不変（Global Constraints）。✓
- 消費側6ファイルが注入受け取り → 変更不要。既定同一参照で無影響（Task 4 Step 4）。✓
- アダプタ2つ（OpenAI互換／Codex）→ Task 1 / Task 2。✓
- OpenAI互換1本で Ollama / LM Studio / OpenAI / GitHub Models → 対応表（判断2）＋ README。✓
- resumeId をアダプタ内セッションストアで再現・再起動で消えるのは許容と明記 → 両アダプタの実装コメント＋ README。✓
- Codex の方式決定（app-server vs codex exec）と理由 → 判断1で `codex exec` 採用を根拠付きで決定。✓
- サンドボックス/承認を「テキスト応答のみ」に固定する設定を必ず含める → `realCodexExec`（`-s read-only`＋`approval_policy="never"`）＋ 判断1＋ README。✓
- プロバイダ選択は env から・既定 claude・未設定なら現行と完全同一 → Task 3 selectRunner＋回帰テスト。✓
- 将来のサイドバー設定化は out of scope → Global Constraints に明記。✓
- Copilot 対象外を計画冒頭に明記 → Global Constraints ＋判断2＋ README。✓
- GitHub Models のレート制限注意 → 対応表＋ README。✓
- STRICT JSON 弱モデルのフォールバックが全ドメインにあることを確認・記載 → 判断3＋ Global Constraints（coach/placement/assessment/content-gen の各フォールバックを実コードで確認済み）。✓
- 規約: サーバTDD（フェイク fetch/子プロセス）→ 各 Task の注入 seam（fetchFn / exec）。✓
- 既存 ClaudeRunner 型は変えずアダプタが合わせる → Global Constraints。✓
- secrets を plist やログに書かない → Global Constraints＋ README（Authorization 非ログ・.env 配置）。✓

**2. Placeholder scan:** 各コード step に完全な実装コード・完全なテストコードを記載。TBD/TODO/「適切に」等の曖昧表現なし。`realCodexExec` は単体テスト対象外である理由（codex CLI 依存）と、代替の検証手段（注入 exec フェイク＋手動スモーク）を明示。✓

**3. Type consistency:**
- `ClaudeRunner`（`(prompt, resumeId?, opts?:{systemPrompt?}) => Promise<{text, sessionId}>`）を全アダプタが返す。✓
- `makeOpenAICompatRunner(cfg: OpenAICompatConfig)` / `makeCodexRunner(cfg: CodexConfig)` / `selectRunner(args: SelectRunnerArgs)` の引数名・プロパティ名（`baseUrl`/`apiKey`/`model`/`defaultSystemPrompt`/`fetchFn`/`exec`/`cwd`/`claudeRunner`/`env`）を Task 1〜3 とテストで一致。✓
- `CodexExec` の引数 `{prompt, model?, cwd}` と戻り `Promise<string>` を `realCodexExec`・フェイク・`makeCodexRunner` で一致。✓
- `composeCodexPrompt(system, history, userPrompt)` の引数順を Task 2 テストと実装で一致。✓
- env 名（`LLM_PROVIDER`/`OPENAI_COMPAT_BASE_URL`/`OPENAI_COMPAT_API_KEY`/`OPENAI_COMPAT_MODEL`/`CODEX_MODEL`）を Task 3・`.env.example`・README で一致。✓
