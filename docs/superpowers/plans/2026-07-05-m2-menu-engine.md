# M2 メニューエンジン Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 起動すると「今日のメニュー」（60分/30分の5ブロック構成）が組まれ、画面がタイマー付きでブロックを先導し、4/3/2（AEフィードバック付き）・実務ロールプレイ・シャドーイング・振り返りを1セッションとして回せる状態にする。

**Architecture:** M1 の Bun サーバに `menu.ts`（メニュー構成＋トピックローテーション）と `coach.ts`（AEフィードバック・モデルトーク・振り返りの単発生成）を追加し、`routes.ts` の RouteDeps を additive に拡張する。コンテンツは `content/topics/*.md`・`content/scenarios/*.md` のプレーンファイル。クライアントは App.tsx をモード分岐（スタート画面 / セッション進行 / 自由会話）に再構成し、ブロックごとの画面を `src/screens/` に分割する。

**Tech Stack:** M1 と同一（Bun + TypeScript / React + Vite / whisper.cpp / OpenAI TTS + say / `@anthropic-ai/claude-agent-sdk` ^0.3.201）。新規依存なし。

## Global Constraints

- 設計スペック: `docs/superpowers/specs/2026-07-05-learn-english-system-design.md`（§5.2/§5.3 のブロック構成と分数が正: 60分版 = チャンク8/4-3-2 16/ロールプレイ20/シャドーイング8/振り返り5、30分版 = チャンク6/4-3-2 12/ロールプレイ10/振り返り2）
- サーバは 127.0.0.1:3111 固定。対話・生成 AI は Claude Agent SDK ^0.3.201（Max サブスク、API キー不使用）。TTS は OpenAI（キーあれば）→ `say` フォールバック
- 外部依存（SDK・サブプロセス・ファイルパス）は関数注入でモック可能に設計する（既存の RouteDeps / runner / spawnFn パターンを踏襲）
- **既存の HTTP 契約・既存テスト（42件）を壊さない。全変更は additive**。既存テストファイルの変更は「テスト追加」と「本計画が明示する強化（stt の toEqual 化）」のみ
- データはリポジトリ内プレーンファイル: コンテンツは `content/`、進捗は `data/progress/`（gitignore しない）
- チャンクブロックは M3 で実装するため、本計画では「説明＋タイマーのみのプレースホルダ」として扱う
- コミットは Conventional Commits（日本語可）
- クライアントのゲートは `cd app/client && bun run build`（tsc --noEmit && vite build）。サーバのゲートは `cd app && bun test` と `bun run typecheck`

## File Structure（このプランで作る/変えるもの）

```
app/server/
  spawn.ts                 # 新規: realSpawn/SpawnFn の共通化（Task 1）
  session-log.ts           # 変更: readEvents耐性・errorマーカー・イベント型追加（Task 1, 4）
  converse.ts              # 変更: runner第3引数 systemPrompt / converseTurn systemPromptOverride（Task 3）
  menu.ts                  # 新規: メニュー構成・コンテンツ読込・LRUローテーション（Task 2）
  coach.ts                 # 新規: AEフィードバック・モデルトーク・振り返り・ロールプレイプロンプト（Task 3）
  routes.ts                # 変更: 新ルート追加（Task 4）
  index.ts                 # 変更: realDeps 配線（Task 4）
  __tests__/menu.test.ts   # 新規
  __tests__/coach.test.ts  # 新規
  __tests__/{converse,session-log,paths,stt,routes}.test.ts  # 追加/強化
content/
  topics/*.md              # 新規: 12トピック（Task 2）
  scenarios/*.md           # 新規: 8シナリオ（Task 2）
app/client/src/
  api.ts                   # 変更: 新APIヘルパ（Task 1, 5）
  App.tsx                  # 変更: モード分岐に再構成（Task 5）
  useCountdown.ts          # 新規: 1秒間隔カウントダウンフック（Task 5）
  screens/StartScreen.tsx  # 新規（Task 5）
  screens/SessionRunner.tsx        # 新規
  screens/FreeTalkScreen.tsx       # 新規（M1のUIを抽出・ロールプレイと共用）
  screens/FourThreeTwoScreen.tsx   # 新規
  screens/RoleplayScreen.tsx       # 新規
  screens/ShadowingScreen.tsx      # 新規
  screens/ReflectionScreen.tsx     # 新規
  screens/ChunkPlaceholderScreen.tsx  # 新規
README.md                  # 変更（Task 6）
```

---

### Task 1: Hygiene バッチ（M1 最終レビューの M2 送り分）

**Files:**
- Create: `app/server/spawn.ts`
- Modify: `app/server/session-log.ts`, `app/server/converse.ts`, `app/server/routes.ts`, `app/server/stt.ts`, `app/server/tts.ts`
- Modify: `app/client/src/api.ts`, `app/client/src/App.tsx`
- Test: `app/server/__tests__/converse.test.ts`（追加）, `app/server/__tests__/session-log.test.ts`（追加）, `app/server/__tests__/paths.test.ts`（新規）, `app/server/__tests__/stt.test.ts`（強化）, `app/server/__tests__/routes.test.ts`（追加）

**Interfaces:**
- Consumes: 既存の全モジュール（M1 の公開シグネチャは不変）
- Produces:
  - `spawn.ts`: `export type SpawnFn = (cmd: string[]) => Promise<{ exitCode: number; stderr: string }>` / `export const realSpawn: SpawnFn`
  - `session-log.ts` 追加: `markErrorLogged(err: unknown): void` / `isErrorLogged(err: unknown): boolean`（Error に非列挙マーカーを付けて error イベントの二重記録を防ぐ）
  - `api.ts` 追加: `sessionEndKeepalive(sessionId: string): void`（pagehide 用・keepalive fetch）

- [ ] **Step 1: resume/オプションのパススルーを検証する失敗するテストを書く**

`app/server/__tests__/converse.test.ts` に追記（既存テストは触らない。既存 import に `makeClaudeRunner`, `PARTNER_SYSTEM_PROMPT` が無ければ追加する）:

```ts
import type { query } from "@anthropic-ai/claude-agent-sdk";

describe("makeClaudeRunner: SDK呼び出し引数のパススルー", () => {
  function capturingQuery() {
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const fakeQuery = ((args: { prompt: string; options: Record<string, unknown> }) => {
      calls.push(args);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-x" };
        yield { type: "result", subtype: "success", result: "ok" };
      })();
    }) as unknown as typeof query;
    return { calls, fakeQuery };
  }

  test("初回ターン: resume なし・規定オプションが query に渡る", async () => {
    const { calls, fakeQuery } = capturingQuery();
    const runner = makeClaudeRunner(fakeQuery);
    await runner("first turn");
    expect(calls[0].prompt).toBe("first turn");
    expect(calls[0].options).not.toHaveProperty("resume");
    expect(calls[0].options).toMatchObject({
      systemPrompt: PARTNER_SYSTEM_PROMPT,
      model: "sonnet",
      allowedTools: [],
      maxTurns: 1,
    });
  });

  test("2ターン目: resumeId が options.resume として渡る", async () => {
    const { calls, fakeQuery } = capturingQuery();
    const runner = makeClaudeRunner(fakeQuery);
    await runner("second turn", "sess-x");
    expect(calls[0].options).toMatchObject({ resume: "sess-x" });
  });
});
```

- [ ] **Step 2: テストが（現状のままで）通ることを確認し、退行検知になっていることを確かめる**

Run: `cd app && bun test server/__tests__/converse.test.ts`
Expected: PASS（このテストは現実装の正しさを固定化するもの。確認のため `converse.ts` の `...(resumeId ? { resume: resumeId } : {})` を一時的に削除して再実行すると FAIL になることを確認し、元に戻す）

- [ ] **Step 3: readEvents 耐性の失敗するテストを書く**

`app/server/__tests__/session-log.test.ts` に追記:

```ts
test("readEvents は不正な行をスキップして残りを返す（クラッシュ耐性）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sess-"));
  const file = path.join(dir, "log.jsonl");
  const good1 = JSON.stringify({ ts: "t1", type: "session_start", sessionId: "s1" });
  const good2 = JSON.stringify({ ts: "t2", type: "user_utterance", sessionId: "s1", text: "hi" });
  writeFileSync(file, `${good1}\n{truncated...\n${good2}\n`, "utf8");
  const events = readEvents(file);
  expect(events).toHaveLength(2);
  expect(events[1].text).toBe("hi");
});
```

（`writeFileSync` を `node:fs` import に追加）

Run: `cd app && bun test server/__tests__/session-log.test.ts`
Expected: FAIL（`JSON.parse` が throw する）

- [ ] **Step 4: readEvents を修正し、error マーカーを追加**

`app/server/session-log.ts` の `readEvents` を置換し、マーカー関数を追加:

```ts
export function readEvents(file: string): SessionEvent[] {
  if (!existsSync(file)) return [];
  const events: SessionEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch {
      // 途中クラッシュ等による不正・途中切れ行は読み飛ばす（書き込みは追記型なので後続行は健全）
      console.warn(`session-log: skipping malformed line in ${file}`);
    }
  }
  return events;
}

const LOGGED_MARKER = Symbol.for("learn-english.errorLogged");

/** この Error は既に error イベントとして記録済み、という印を付ける（二重記録防止） */
export function markErrorLogged(err: unknown): void {
  if (err instanceof Error) (err as Error & Record<symbol, unknown>)[LOGGED_MARKER] = true;
}

export function isErrorLogged(err: unknown): boolean {
  return err instanceof Error && (err as Error & Record<symbol, unknown>)[LOGGED_MARKER] === true;
}
```

- [ ] **Step 5: dedupe の失敗するテストを書く**

`app/server/__tests__/converse.test.ts` の「runner が throw すると error イベント」系テストの近くに追記:

```ts
test("converseTurn が記録した error は isErrorLogged マーカーが付く", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "conv-"));
  const logFile = path.join(dir, "log.jsonl");
  const failingRunner = async () => { throw new Error("runner down"); };
  let caught: unknown;
  try {
    await converseTurn({ userText: "hi", runner: failingRunner, logFile });
  } catch (err) {
    caught = err;
  }
  expect(isErrorLogged(caught)).toBe(true);
});
```

`app/server/__tests__/routes.test.ts` に追記:

```ts
test("マーカー付きエラー（converseTurnが記録済み）は最上位catchで二重記録しない", async () => {
  const { deps, logFile } = makeTestDeps({
    converse: (async () => {
      const err = new Error("already logged downstream");
      markErrorLogged(err);
      throw err;
    }) as RouteDeps["converse"],
  });
  const handler = makeFetchHandler(deps);
  const res = await handler(
    new Request("http://localhost/api/converse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userText: "hi" }),
    }),
  );
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "already logged downstream" });
  expect(readEvents(logFile)).toEqual([]); // 二重記録されていない
});
```

（両ファイルの import に `markErrorLogged` / `isErrorLogged` を追加）

Run: `cd app && bun test server/__tests__/converse.test.ts server/__tests__/routes.test.ts`
Expected: FAIL（マーカー未実装のため）

- [ ] **Step 6: converse.ts と routes.ts に dedupe を実装**

`app/server/converse.ts` の catch 節（`appendEvent` の直後）に1行追加:

```ts
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendEvent(logFile, {
      ts: now(), type: "error", sessionId: args.sessionId ?? "pending", text: message,
    });
    markErrorLogged(err);
    throw err;
  }
```

（import に `markErrorLogged` を追加: `import { appendEvent, markErrorLogged } from "./session-log";`）

`app/server/routes.ts` の最上位 catch を修正:

```ts
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isErrorLogged(err)) {
        try {
          appendEvent(deps.logFile(), {
            ts: new Date().toISOString(), type: "error", sessionId: "server", text: message,
          });
        } catch (logErr) {
          // ロギング自体の失敗で「常に{error}JSONを返す」保証を崩さないためのガード
          console.error(`routes: failed to append error event: ${String(logErr)}`);
        }
      }
      return json({ error: message }, 500);
    }
```

（import に `isErrorLogged` を追加）

Run: `cd app && bun test server/__tests__/converse.test.ts server/__tests__/routes.test.ts`
Expected: PASS（既存の「依存が例外を投げると500…errorイベントがログに残る」テストはマーカー無しエラーなので従来どおり PASS）

- [ ] **Step 7: paths.ts の基本テストを書く（現実装で通るはず）**

`app/server/__tests__/paths.test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { ensureDirs, SESSIONS_DIR, RECORDINGS_DIR, TTS_CACHE_DIR, MODELS_DIR, sessionLogPath } from "../paths";

describe("paths", () => {
  test("sessionLogPath は SESSIONS_DIR 配下の YYYY-MM-DD.jsonl を返す", () => {
    const p = sessionLogPath(new Date("2026-07-05T12:34:56Z"));
    expect(p).toBe(path.join(SESSIONS_DIR, "2026-07-05.jsonl"));
  });

  test("ensureDirs 後は全データディレクトリが存在する", () => {
    ensureDirs();
    for (const d of [SESSIONS_DIR, RECORDINGS_DIR, TTS_CACHE_DIR, MODELS_DIR]) {
      expect(existsSync(d)).toBe(true);
    }
  });
});
```

Run: `cd app && bun test server/__tests__/paths.test.ts`
Expected: PASS

- [ ] **Step 8: spawn.ts を抽出**

`app/server/spawn.ts` を新規作成:

```ts
export type SpawnFn = (cmd: string[]) => Promise<{ exitCode: number; stderr: string }>;

export const realSpawn: SpawnFn = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
};
```

`app/server/stt.ts`: 内部の `realSpawn` 定義と `export type SpawnFn` を削除し、先頭を以下に変更（後方互換のため型は再エクスポート。`tts.ts` が `./stt` から import している既存関係を保つ）:

```ts
import { realSpawn, type SpawnFn } from "./spawn";
export type { SpawnFn } from "./spawn";
```

（`transcribeAudio` 内の `opts.spawnFn ?? realSpawn` はそのまま動く）

`app/server/tts.ts`: 内部の `realSpawn` 定義を削除し、import を変更:

```ts
import { realSpawn, type SpawnFn } from "./spawn";
```

（`import type { SpawnFn } from "./stt";` の行は削除）

- [ ] **Step 9: stt テストの ffmpeg argv を完全一致に強化**

`app/server/__tests__/stt.test.ts` の transcribeAudio ハッピーパステスト内の ffmpeg コマンド assertion（`toContain` 系）を、以下の完全一致に置き換える（`inputPath` はそのテストで transcribeAudio に渡している実際の変数名に合わせる）:

```ts
expect(calls[0]).toEqual([
  "ffmpeg", "-i", inputPath,
  "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
  expect.stringMatching(/in\.wav$/),
  "-y",
]);
```

Run: `cd app && bun test server/__tests__/stt.test.ts`
Expected: PASS（`-ac 1` や `pcm_s16le` を落とす退行が今後 FAIL になる）

- [ ] **Step 10: 全サーバテスト＋typecheck**

Run: `cd app && bun test && bun run typecheck`
Expected: 既存42件＋本タスク追加分がすべて PASS、typecheck 0 エラー

- [ ] **Step 11: サーバ側 hygiene をコミット**

```bash
git add app/server/
git commit -m "fix: hygieneバッチ（resume固定化テスト・JSONL耐性・error二重記録排除・spawn共通化・argv完全一致テスト）"
```

- [ ] **Step 12: クライアントの session_end を pagehide + keepalive で送る**

`app/client/src/api.ts` に追記:

```ts
/**
 * タブを閉じる/リロード時にも session_end を届けるための keepalive 送信。
 * pagehide からの呼び出し想定なので await しない（fire-and-forget）。
 */
export function sessionEndKeepalive(sessionId: string): void {
  void fetch("/api/session/end", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
    keepalive: true,
  });
}
```

`app/client/src/App.tsx` の useEffect を修正（React の effect cleanup はタブクローズで走らないため）:

```tsx
  useEffect(() => {
    getHealth()
      .then((h) => { setHealth(h); setServerDown(false); })
      .catch(() => { setHealth(null); setServerDown(true); });
    sessionStart();
    const onPageHide = () => {
      if (sessionIdRef.current) sessionEndKeepalive(sessionIdRef.current);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      if (sessionIdRef.current) sessionEnd(sessionIdRef.current);
    };
  }, []);
```

（import に `sessionEndKeepalive` を追加）

- [ ] **Step 13: クライアントビルド確認とコミット**

Run: `cd app/client && bun run build`
Expected: tsc + vite とも成功

```bash
git add app/client/
git commit -m "fix: pagehide+keepaliveでsession_endを確実に記録"
```

---

### Task 2: メニューエンジンとコンテンツシード

**Files:**
- Create: `app/server/menu.ts`, `content/topics/*.md`（12ファイル）, `content/scenarios/*.md`（8ファイル）
- Modify: `app/server/paths.ts`（CONTENT/PROGRESS パス追加）
- Test: `app/server/__tests__/menu.test.ts`

**Interfaces:**
- Consumes: `paths.ts`
- Produces（Task 4/5 が依存）:
  - `paths.ts` 追加: `CONTENT_DIR` / `TOPICS_DIR` / `SCENARIOS_DIR` / `PROGRESS_DIR`（`ensureDirs()` が PROGRESS_DIR も作る）
  - `menu.ts`:
    - `type BlockKind = "chunk-placeholder" | "four-three-two" | "roleplay" | "shadowing" | "reflection"`
    - `type ContentItem = { id: string; kind: "topic" | "scenario"; title: string; titleJa: string; hints: string[] }`
    - `type MenuBlock = { id: string; kind: BlockKind; title: string; minutes: number; params: Record<string, unknown> }`
    - `type Menu = { minutes: 60 | 30; date: string; blocks: MenuBlock[] }`
    - `type UsageMap = Record<string, string[]>`（id → 使用日 ymd の配列、新しい日付が末尾、最大7件）
    - `parseContentFile(text: string): ContentItem | null`
    - `loadContent(dir: string): ContentItem[]`
    - `pickNext(items: ContentItem[], usage: UsageMap, todayYmd: string): ContentItem`
    - `type MenuDeps = { topicsDir?: string; scenariosDir?: string; usageFile?: string; menuCacheDir?: string; today?: () => Date }`
    - `buildTodayMenu(minutes: 60 | 30, deps?: MenuDeps): Menu`（同日同 minutes は日次キャッシュから同一メニューを返す）

- [ ] **Step 1: paths.ts にコンテンツ/進捗パスを追加**

`app/server/paths.ts` に追記し、`ensureDirs` の配列に `PROGRESS_DIR` を追加:

```ts
export const CONTENT_DIR = path.join(REPO_ROOT, "content");
export const TOPICS_DIR = path.join(CONTENT_DIR, "topics");
export const SCENARIOS_DIR = path.join(CONTENT_DIR, "scenarios");
export const PROGRESS_DIR = path.join(DATA_DIR, "progress");
```

```ts
export function ensureDirs(): void {
  for (const d of [SESSIONS_DIR, RECORDINGS_DIR, TTS_CACHE_DIR, MODELS_DIR, PROGRESS_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}
```

- [ ] **Step 2: menu の失敗するテストを書く**

`app/server/__tests__/menu.test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildTodayMenu, loadContent, parseContentFile, pickNext,
  type ContentItem, type MenuDeps, type UsageMap,
} from "../menu";

function makeContentDirs(): { topicsDir: string; scenariosDir: string; usageFile: string; menuCacheDir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "menu-"));
  const topicsDir = path.join(dir, "topics");
  const scenariosDir = path.join(dir, "scenarios");
  const menuCacheDir = path.join(dir, "cache");
  mkdirSync(topicsDir, { recursive: true });
  mkdirSync(scenariosDir, { recursive: true });
  const topic = (id: string, title: string) =>
    `---\nid: ${id}\nkind: topic\ntitle: "${title}"\ntitle_ja: "ja-${id}"\n---\nHints:\n- hint one\n- hint two\n- hint three\n`;
  const scenario = (id: string, title: string) =>
    `---\nid: ${id}\nkind: scenario\ntitle: "${title}"\ntitle_ja: "ja-${id}"\n---\nSetup:\n- You are the IT lead\n- Goal: agree next steps\n`;
  writeFileSync(path.join(topicsDir, "t1.md"), topic("t1", "Topic One"));
  writeFileSync(path.join(topicsDir, "t2.md"), topic("t2", "Topic Two"));
  writeFileSync(path.join(topicsDir, "t3.md"), topic("t3", "Topic Three"));
  writeFileSync(path.join(scenariosDir, "s1.md"), scenario("s1", "Scenario One"));
  writeFileSync(path.join(scenariosDir, "s2.md"), scenario("s2", "Scenario Two"));
  return { topicsDir, scenariosDir, usageFile: path.join(dir, "usage.json"), menuCacheDir };
}

const JULY5 = () => new Date("2026-07-05T09:00:00Z");

describe("parseContentFile / loadContent", () => {
  test("frontmatter と hints を抽出する", () => {
    const item = parseContentFile(
      `---\nid: abc\nkind: topic\ntitle: "Hello Title"\ntitle_ja: "こんにちは"\n---\nbody\n- first hint\n- second hint\n`,
    );
    expect(item).toEqual({
      id: "abc", kind: "topic", title: "Hello Title", titleJa: "こんにちは",
      hints: ["first hint", "second hint"],
    });
  });

  test("frontmatter が無い・必須キー欠落は null", () => {
    expect(parseContentFile("just text")).toBeNull();
    expect(parseContentFile("---\nkind: topic\n---\n")).toBeNull();
  });

  test("loadContent は .md をソート順に読み、壊れたファイルを除外する", () => {
    const { topicsDir } = makeContentDirs();
    writeFileSync(path.join(topicsDir, "broken.md"), "no frontmatter");
    const items = loadContent(topicsDir);
    expect(items.map((i) => i.id)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("pickNext", () => {
  const items: ContentItem[] = [
    { id: "a", kind: "topic", title: "A", titleJa: "", hints: [] },
    { id: "b", kind: "topic", title: "B", titleJa: "", hints: [] },
    { id: "c", kind: "topic", title: "C", titleJa: "", hints: [] },
  ];

  test("未使用が最優先、同着は id 順", () => {
    const usage: UsageMap = { a: ["2026-07-01"] };
    expect(pickNext(items, usage, "2026-07-05").id).toBe("b");
  });

  test("全部使用済みなら最終使用が最も古いものを選ぶ", () => {
    const usage: UsageMap = { a: ["2026-07-01"], b: ["2026-07-03"], c: ["2026-07-02"] };
    expect(pickNext(items, usage, "2026-07-05").id).toBe("a");
  });

  test("前日と前々日の両方に使ったアイテムは避ける（3日連続回避）", () => {
    const usage: UsageMap = { a: ["2026-07-03", "2026-07-04"], b: ["2026-07-04"], c: ["2026-07-04"] };
    // a は最終使用が古い側だが 7/3・7/4 連続使用なので除外され、b/c から id 順で b
    expect(pickNext(items, usage, "2026-07-05").id).toBe("b");
  });

  test("空配列は throw", () => {
    expect(() => pickNext([], {}, "2026-07-05")).toThrow();
  });
});

describe("buildTodayMenu", () => {
  test("60分版: spec §5.2 の5ブロック構成・分数で、topic/scenario が params に入る", () => {
    const dirs = makeContentDirs();
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(menu.date).toBe("2026-07-05");
    expect(menu.blocks.map((b) => [b.kind, b.minutes])).toEqual([
      ["chunk-placeholder", 8],
      ["four-three-two", 16],
      ["roleplay", 20],
      ["shadowing", 8],
      ["reflection", 5],
    ]);
    const ftt = menu.blocks[1].params.topic as ContentItem;
    const rp = menu.blocks[2].params.scenario as ContentItem;
    const shadow = menu.blocks[3].params.topic as ContentItem;
    expect(ftt.id).toBe("t1");
    expect(rp.id).toBe("s1");
    expect(shadow.id).not.toBe(ftt.id); // シャドーイングは別トピック（次のローテーション候補）
  });

  test("30分版: spec §5.3 の4ブロック構成・分数", () => {
    const dirs = makeContentDirs();
    const menu = buildTodayMenu(30, { ...dirs, today: JULY5 });
    expect(menu.blocks.map((b) => [b.kind, b.minutes])).toEqual([
      ["chunk-placeholder", 6],
      ["four-three-two", 12],
      ["roleplay", 10],
      ["reflection", 2],
    ]);
  });

  test("使用記録: 4/3/2とロールプレイのみ記録され、シャドーイングのプレビューは記録されない", () => {
    const dirs = makeContentDirs();
    buildTodayMenu(60, { ...dirs, today: JULY5 });
    const usage = JSON.parse(readFileSync(dirs.usageFile, "utf8")) as UsageMap;
    expect(usage.t1).toEqual(["2026-07-05"]);
    expect(usage.s1).toEqual(["2026-07-05"]);
    expect(usage.t2).toBeUndefined();
  });

  test("同日同minutesの再呼び出しは日次キャッシュから同一メニューを返し、使用記録を重ねない", () => {
    const dirs = makeContentDirs();
    const first = buildTodayMenu(60, { ...dirs, today: JULY5 });
    const second = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(second).toEqual(first);
    const usage = JSON.parse(readFileSync(dirs.usageFile, "utf8")) as UsageMap;
    expect(usage.t1).toEqual(["2026-07-05"]); // 1回だけ
    expect(existsSync(path.join(dirs.menuCacheDir, "menu-2026-07-05-60.json"))).toBe(true);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/menu.test.ts`
Expected: FAIL（`menu` モジュールが存在しない）

- [ ] **Step 4: menu.ts を実装**

`app/server/menu.ts` を新規作成:

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROGRESS_DIR, SCENARIOS_DIR, TOPICS_DIR } from "./paths";

export type BlockKind = "chunk-placeholder" | "four-three-two" | "roleplay" | "shadowing" | "reflection";
export type ContentItem = { id: string; kind: "topic" | "scenario"; title: string; titleJa: string; hints: string[] };
export type MenuBlock = { id: string; kind: BlockKind; title: string; minutes: number; params: Record<string, unknown> };
export type Menu = { minutes: 60 | 30; date: string; blocks: MenuBlock[] };
/** id → 使用日(YYYY-MM-DD)の配列。新しい日付が末尾、最大7件保持 */
export type UsageMap = Record<string, string[]>;

export function parseContentFile(text: string): ContentItem | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  if (!fields.id || !fields.title || (fields.kind !== "topic" && fields.kind !== "scenario")) return null;
  const hints = text.slice(m[0].length).split("\n")
    .filter((l) => l.trim().startsWith("- "))
    .map((l) => l.trim().slice(2));
  return { id: fields.id, kind: fields.kind, title: fields.title, titleJa: fields.title_ja ?? "", hints };
}

export function loadContent(dir: string): ContentItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseContentFile(readFileSync(path.join(dir, f), "utf8")))
    .filter((c): c is ContentItem => c !== null);
}

function ymdOffset(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * least-recently-used ローテーション。未使用が最優先、次に最終使用が古い順（同着はid順）。
 * 前日・前々日の両方に使ったアイテムは除外する（3日連続の同一素材を避ける。
 * ただし全アイテムが除外される場合は全体から選ぶ）。
 */
export function pickNext(items: ContentItem[], usage: UsageMap, todayYmd: string): ContentItem {
  if (items.length === 0) throw new Error("no content items available");
  const y1 = ymdOffset(todayYmd, -1);
  const y2 = ymdOffset(todayYmd, -2);
  const eligible = items.filter((it) => {
    const dates = usage[it.id] ?? [];
    return !(dates.includes(y1) && dates.includes(y2));
  });
  const pool = eligible.length > 0 ? eligible : items;
  const lastUsed = (it: ContentItem) => {
    const d = usage[it.id] ?? [];
    return d.length ? d[d.length - 1] : "";
  };
  return [...pool].sort((a, b) => {
    const la = lastUsed(a);
    const lb = lastUsed(b);
    if (la !== lb) return la < lb ? -1 : 1;
    return a.id.localeCompare(b.id);
  })[0];
}

function markUsed(usage: UsageMap, id: string, ymd: string): void {
  const dates = usage[id] ?? [];
  if (dates[dates.length - 1] !== ymd) dates.push(ymd);
  usage[id] = dates.slice(-7);
}

export type MenuDeps = {
  topicsDir?: string;
  scenariosDir?: string;
  usageFile?: string;
  menuCacheDir?: string;
  today?: () => Date;
};

export function buildTodayMenu(minutes: 60 | 30, deps: MenuDeps = {}): Menu {
  const topicsDir = deps.topicsDir ?? TOPICS_DIR;
  const scenariosDir = deps.scenariosDir ?? SCENARIOS_DIR;
  const usageFile = deps.usageFile ?? path.join(PROGRESS_DIR, "topic-usage.json");
  const menuCacheDir = deps.menuCacheDir ?? PROGRESS_DIR;
  const ymd = (deps.today ?? (() => new Date()))().toISOString().slice(0, 10);

  // 同日・同構成なら同一メニューを返す（リロードでトピックが変わらない・使用記録が重ならない）
  const cacheFile = path.join(menuCacheDir, `menu-${ymd}-${minutes}.json`);
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, "utf8")) as Menu;
  }

  const usage: UsageMap = existsSync(usageFile)
    ? (JSON.parse(readFileSync(usageFile, "utf8")) as UsageMap)
    : {};
  const topics = loadContent(topicsDir);
  const scenarios = loadContent(scenariosDir);

  const mainTopic = pickNext(topics, usage, ymd);
  const scenario = pickNext(scenarios, usage, ymd);
  // シャドーイング素材は「次にローテーションが選ぶトピック」のプレビュー。
  // 使用済みマークはしない（近日中に 4/3/2 で回ってくる＝spec §5.2 の「翌日の下敷き」の近似）
  const others = topics.filter((t) => t.id !== mainTopic.id);
  const shadowTopic = others.length > 0 ? pickNext(others, usage, ymd) : mainTopic;

  markUsed(usage, mainTopic.id, ymd);
  markUsed(usage, scenario.id, ymd);
  mkdirSync(path.dirname(usageFile), { recursive: true });
  writeFileSync(usageFile, JSON.stringify(usage, null, 2));

  const chunkTitle = "チャンク産出リトリーバル（M3で実装予定。今日は最近覚えた表現を思い出して口に出す時間）";
  const blocks: MenuBlock[] =
    minutes === 60
      ? [
          { id: "b1", kind: "chunk-placeholder", title: chunkTitle, minutes: 8, params: {} },
          { id: "b2", kind: "four-three-two", title: `4/3/2: ${mainTopic.title}`, minutes: 16, params: { topic: mainTopic } },
          { id: "b3", kind: "roleplay", title: `実務ロールプレイ: ${scenario.title}`, minutes: 20, params: { scenario } },
          { id: "b4", kind: "shadowing", title: `シャドーイング: ${shadowTopic.title}`, minutes: 8, params: { topic: shadowTopic } },
          { id: "b5", kind: "reflection", title: "振り返り", minutes: 5, params: {} },
        ]
      : [
          { id: "b1", kind: "chunk-placeholder", title: chunkTitle, minutes: 6, params: {} },
          { id: "b2", kind: "four-three-two", title: `4/3/2: ${mainTopic.title}`, minutes: 12, params: { topic: mainTopic } },
          { id: "b3", kind: "roleplay", title: `実務ロールプレイ: ${scenario.title}`, minutes: 10, params: { scenario } },
          { id: "b4", kind: "reflection", title: "振り返り", minutes: 2, params: {} },
        ];

  const menu: Menu = { minutes, date: ymd, blocks };
  mkdirSync(menuCacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(menu, null, 2));
  return menu;
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd app && bun test server/__tests__/menu.test.ts`
Expected: PASS（全ケース）

- [ ] **Step 6: トピックシード12件を作成**

`content/topics/` に以下の12ファイルを作成（frontmatter の書式はテストと同じ。本文の hints は「4分話すための観点」）:

`content/topics/abac-okta.md`
```markdown
---
id: abac-okta
kind: topic
title: "Designing attribute-based access control with Okta"
title_ja: "OktaでのABACアクセス制御の設計"
---
Talk for 4 minutes. Hints:
- What problem does ABAC solve that role-based access control cannot?
- How do device state and user attributes change an access decision?
- A real example from your work: which apps, which policies?
- What was hard to explain to stakeholders?
```

`content/topics/zero-trust.md`
```markdown
---
id: zero-trust
kind: topic
title: "What zero trust means in practice"
title_ja: "実務におけるゼロトラスト"
---
Talk for 4 minutes. Hints:
- Your one-sentence definition of zero trust
- What you stopped trusting: network location, devices, or accounts?
- One concrete control you introduced and what changed
- A common misunderstanding you often correct
```

`content/topics/ai-agent-governance.md`
```markdown
---
id: ai-agent-governance
kind: topic
title: "Governing AI agents at work"
title_ja: "業務におけるAIエージェントのガバナンス"
---
Talk for 4 minutes. Hints:
- What AI agents do in your company today
- What could go wrong: permissions, data access, or actions?
- How identity and access control apply to non-human actors
- One rule you would set for every AI agent
```

`content/topics/ai-data-governance.md`
```markdown
---
id: ai-data-governance
kind: topic
title: "Data governance in the AI era"
title_ja: "AI時代のデータガバナンス"
---
Talk for 4 minutes. Hints:
- Which data is safe to give to AI tools, and which is not
- How you decide: classification, contracts, or gut feeling?
- A policy or guideline you wrote or want to write
- What most companies get wrong about this
```

`content/topics/blog-workflow.md`
```markdown
---
id: blog-workflow
kind: topic
title: "How I write and review technical blog posts"
title_ja: "技術ブログの執筆・レビューの進め方"
---
Talk for 4 minutes. Hints:
- Your writing pipeline from idea to published post
- How you use AI tools in research, drafting, and fact-checking
- What makes a technical article trustworthy
- One article you are proud of and why
```

`content/topics/recruiting.md`
```markdown
---
id: recruiting
kind: topic
title: "Recruiting engineers: what actually works"
title_ja: "エンジニア採用で実際に効くこと"
---
Talk for 4 minutes. Hints:
- What you look for when you read a candidate profile
- How you write a scout message that gets a reply
- A hiring mistake you have seen or made
- How interviews should really be run
```

`content/topics/corporate-it.md`
```markdown
---
id: corporate-it
kind: topic
title: "What a modern corporate IT team does"
title_ja: "モダンな情シスの仕事とは"
---
Talk for 4 minutes. Hints:
- How you explain your job to someone outside IT
- SaaS management, identity, devices: which matters most and why
- One project that changed how your company works
- What people misunderstand about corporate IT
```

`content/topics/incident-response.md`
```markdown
---
id: incident-response
kind: topic
title: "Handling a security or IT incident"
title_ja: "セキュリティ/ITインシデント対応"
---
Talk for 4 minutes. Hints:
- Walk through an incident timeline: detect, triage, contain, review
- Who you inform, when, and in what words
- A real (or realistic) example you can describe safely
- What a good post-incident review looks like
```

`content/topics/tech-selection.md`
```markdown
---
id: tech-selection
kind: topic
title: "How I choose tools and technologies"
title_ja: "技術・ツール選定の考え方"
---
Talk for 4 minutes. Hints:
- Your criteria: cost, security, lock-in, team fit?
- A recent selection you made and the trade-offs
- When you say no to a shiny new tool
- How you get buy-in from the team or management
```

`content/topics/my-career.md`
```markdown
---
id: my-career
kind: topic
title: "My career so far and where I am going"
title_ja: "これまでのキャリアとこれから"
---
Talk for 4 minutes. Hints:
- The short version of your career story
- A turning point and what you learned
- What you want to be doing in three years
- Advice you would give your younger self
```

`content/topics/this-week-work.md`
```markdown
---
id: this-week-work
kind: topic
title: "What I worked on this week"
title_ja: "今週やった仕事"
---
Talk for 4 minutes. Hints:
- The main thing you worked on and its goal
- One problem you hit and how you handled it
- Who you worked with and how you communicated
- What you will do next week
```

`content/topics/recent-article.md`
```markdown
---
id: recent-article
kind: topic
title: "A technical article or news I read recently"
title_ja: "最近読んだ技術記事・ニュース"
---
Talk for 4 minutes. Hints:
- What the article said, in your own words
- Why it caught your attention
- Do you agree? What would you push back on?
- How it connects to your own work
```

- [ ] **Step 7: シナリオシード8件を作成**

`content/scenarios/` に以下の8ファイルを作成（hints は「役割・相手・ゴール」）:

`content/scenarios/vendor-meeting.md`
```markdown
---
id: vendor-meeting
kind: scenario
title: "Regular meeting with a SaaS vendor"
title_ja: "SaaSベンダーとの定例ミーティング"
---
Roleplay setup:
- You are the customer-side IT lead
- The AI plays the vendor's customer success manager
- Goal: review open issues, ask about a delayed feature, agree next steps
```

`content/scenarios/tech-discussion.md`
```markdown
---
id: tech-discussion
kind: scenario
title: "Technical discussion about a design choice"
title_ja: "設計判断についての技術討議"
---
Roleplay setup:
- You are proposing a design (pick one from your real work)
- The AI plays a skeptical senior engineer who asks why
- Goal: explain trade-offs and reach a shared decision
```

`content/scenarios/incident-report.md`
```markdown
---
id: incident-report
kind: scenario
title: "Reporting an incident to a manager"
title_ja: "上司への障害報告"
---
Roleplay setup:
- You discovered an incident an hour ago (invent details)
- The AI plays your manager who wants facts, impact, next actions
- Goal: report clearly: what happened, impact, what you are doing
```

`content/scenarios/daily-standup.md`
```markdown
---
id: daily-standup
kind: scenario
title: "Daily standup with a global team"
title_ja: "グローバルチームのデイリースタンドアップ"
---
Roleplay setup:
- You give your update: yesterday, today, blockers
- The AI plays a teammate who asks one or two follow-ups
- Goal: keep it under two minutes, answer follow-ups directly
```

`content/scenarios/casual-interview.md`
```markdown
---
id: casual-interview
kind: scenario
title: "Casual interview with an engineering candidate"
title_ja: "エンジニア候補者とのカジュアル面談（会社側）"
---
Roleplay setup:
- You represent your company; the AI plays the candidate
- Goal: introduce the company and role, ask about their background, answer their questions
```

`content/scenarios/conference-qa.md`
```markdown
---
id: conference-qa
kind: scenario
title: "Q&A after your conference talk"
title_ja: "カンファレンス登壇後のQ&A"
---
Roleplay setup:
- You just gave a talk (pick a topic from your articles)
- The AI plays audience members asking questions, one at a time
- Goal: answer clearly; it is fine to say "good question, I don't know"
```

`content/scenarios/customer-hearing.md`
```markdown
---
id: customer-hearing
kind: scenario
title: "Hearing a customer's IT problems"
title_ja: "顧客のIT課題ヒアリング"
---
Roleplay setup:
- You are the consultant; the AI plays a customer with messy IT
- Goal: ask questions to understand their identity/SaaS/device problems, summarize back
```

`content/scenarios/security-review.md`
```markdown
---
id: security-review
kind: scenario
title: "Security review meeting for a new tool"
title_ja: "新規ツール導入のセキュリティレビュー会議"
---
Roleplay setup:
- A team wants to adopt a new SaaS tool; the AI plays the requesting team lead
- Goal: ask about data handled, auth method, admin controls; give a conditional approval
```

- [ ] **Step 8: 全テスト＋コミット**

Run: `cd app && bun test && bun run typecheck`
Expected: 全 PASS

```bash
git add app/server/ content/
git commit -m "feat: メニューエンジンとトピック/シナリオのシードを追加"
```

---

### Task 3: コーチ生成（AEフィードバック・モデルトーク・振り返り・ロールプレイ）

**Files:**
- Create: `app/server/coach.ts`
- Modify: `app/server/converse.ts`
- Test: `app/server/__tests__/coach.test.ts`（新規）, `app/server/__tests__/converse.test.ts`（追加）

**Interfaces:**
- Consumes: `converse.ts` の `makeClaudeRunner`, `ClaudeRunner` / `session-log.ts` の `SessionEvent`
- Produces（Task 4/5 が依存）:
  - `converse.ts` 変更（additive）:
    - `type ClaudeRunner = (prompt: string, resumeId?: string, opts?: { systemPrompt?: string }) => Promise<{ text: string; sessionId: string }>`（第3引数追加。既存の2引数フェイクはそのまま型互換）
    - `makeClaudeRunner` は `opts?.systemPrompt ?? PARTNER_SYSTEM_PROMPT` を options.systemPrompt に渡す
    - `converseTurn(args: { userText; sessionId?; runner?; logFile?; systemPromptOverride?: string })` — override は runner の第3引数に渡す
  - `coach.ts`:
    - `type AeItem = { quote: string; issue: string; better: string; why_ja: string }`
    - `type AeFeedback = { items: AeItem[]; praise: string }`
    - `type Reflection = { goodPhrases: string[]; fixes: Array<{ original: string; better: string }>; noteForTomorrow_ja: string }`
    - `extractJson<T>(text: string): T | null`
    - `generateAeFeedback(args: { transcript: string; topicTitle: string }, runner?: ClaudeRunner): Promise<AeFeedback>`
    - `generateModelTalk(args: { topicTitle: string; hints: string[] }, runner?: ClaudeRunner): Promise<{ text: string }>`
    - `generateReflection(args: { events: SessionEvent[] }, runner?: ClaudeRunner): Promise<Reflection>`
    - `roleplayPrompt(scenario: { title: string; hints: string[] }): string`

- [ ] **Step 1: converse.ts 拡張の失敗するテストを書く**

`app/server/__tests__/converse.test.ts` に追記:

```ts
test("makeClaudeRunner: 第3引数の systemPrompt が options に渡る", async () => {
  const { calls, fakeQuery } = capturingQuery();
  const runner = makeClaudeRunner(fakeQuery);
  await runner("prompt", undefined, { systemPrompt: "CUSTOM PROMPT" });
  expect(calls[0].options).toMatchObject({ systemPrompt: "CUSTOM PROMPT" });
});

test("converseTurn: systemPromptOverride が runner の第3引数に渡る", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "conv-"));
  const logFile = path.join(dir, "log.jsonl");
  const seen: Array<{ prompt: string; resumeId?: string; opts?: { systemPrompt?: string } }> = [];
  const fakeRunner = async (prompt: string, resumeId?: string, opts?: { systemPrompt?: string }) => {
    seen.push({ prompt, resumeId, opts });
    return { text: "ok", sessionId: "s1" };
  };
  await converseTurn({ userText: "hi", runner: fakeRunner, logFile, systemPromptOverride: "ROLEPLAY" });
  expect(seen[0].opts).toEqual({ systemPrompt: "ROLEPLAY" });
});
```

（`capturingQuery` は Task 1 Step 1 で定義済みのヘルパを describe 外に移動して共用する）

Run: `cd app && bun test server/__tests__/converse.test.ts`
Expected: FAIL（第3引数未実装）

- [ ] **Step 2: converse.ts を拡張**

`app/server/converse.ts` の該当部分を以下に変更:

```ts
export type ClaudeRunner = (
  prompt: string,
  resumeId?: string,
  opts?: { systemPrompt?: string },
) => Promise<{ text: string; sessionId: string }>;

export function makeClaudeRunner(queryFn: typeof query): ClaudeRunner {
  return async (prompt, resumeId, opts) => {
    let sessionId = resumeId ?? "";
    let text = "";
    for await (const msg of queryFn({
      prompt,
      options: {
        systemPrompt: opts?.systemPrompt ?? PARTNER_SYSTEM_PROMPT,
        model: "sonnet",
        allowedTools: [],
        maxTurns: 1,
        ...(resumeId ? { resume: resumeId } : {}),
      },
    })) {
      // （ループ本体は既存のまま変更しない）
```

`converseTurn` の args 型に `systemPromptOverride?: string` を追加し、runner 呼び出しを変更:

```ts
    ({ text, sessionId } = await runner(
      args.userText,
      args.sessionId,
      args.systemPromptOverride ? { systemPrompt: args.systemPromptOverride } : undefined,
    ));
```

Run: `cd app && bun test server/__tests__/converse.test.ts`
Expected: PASS（既存テスト含む全件）

- [ ] **Step 3: coach の失敗するテストを書く**

`app/server/__tests__/coach.test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import {
  extractJson, generateAeFeedback, generateModelTalk, generateReflection, roleplayPrompt,
  type AeFeedback,
} from "../coach";
import type { ClaudeRunner } from "../converse";
import type { SessionEvent } from "../session-log";

function runnerReturning(text: string): { runner: ClaudeRunner; seen: Array<{ prompt: string; systemPrompt?: string }> } {
  const seen: Array<{ prompt: string; systemPrompt?: string }> = [];
  const runner: ClaudeRunner = async (prompt, _resumeId, opts) => {
    seen.push({ prompt, systemPrompt: opts?.systemPrompt });
    return { text, sessionId: "coach-sess" };
  };
  return { runner, seen };
}

describe("extractJson", () => {
  test("素のJSONを取り出す", () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  test("```json フェンス付きでも取り出す", () => {
    expect(extractJson<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  test("前後に文が付いていても最初の{から最後の}までを試す", () => {
    expect(extractJson<{ a: number }>('Here you go: {"a":1} hope it helps')).toEqual({ a: 1 });
  });
  test("JSONが無ければ null", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("generateAeFeedback", () => {
  const valid: AeFeedback = {
    items: [{ quote: "I go yesterday", issue: "past tense", better: "I went yesterday", why_ja: "過去の出来事はwent。" }],
    praise: "Clear structure!",
  };

  test("正常系: JSONを構造化して返し、transcriptとtopicがプロンプトに入る", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    const result = await generateAeFeedback({ transcript: "I go yesterday to office", topicTitle: "My week" }, runner);
    expect(result).toEqual(valid);
    expect(seen[0].prompt).toContain("I go yesterday to office");
    expect(seen[0].prompt).toContain("My week");
    expect(seen[0].systemPrompt).toBeTruthy(); // AE専用プロンプトで呼ばれている
  });

  test("JSONパース失敗時は素のテキストを1itemに包むフォールバック", async () => {
    const { runner } = runnerReturning("Sorry, here is some prose feedback instead.");
    const result = await generateAeFeedback({ transcript: "t", topicTitle: "x" }, runner);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].why_ja).toContain("prose feedback");
  });
});

describe("generateModelTalk", () => {
  test("topicTitleとhintsがプロンプトに入り、textを返す", async () => {
    const { runner, seen } = runnerReturning("This is a model talk.");
    const result = await generateModelTalk({ topicTitle: "Zero trust", hints: ["definition", "example"] }, runner);
    expect(result.text).toBe("This is a model talk.");
    expect(seen[0].prompt).toContain("Zero trust");
    expect(seen[0].prompt).toContain("definition");
  });
});

describe("generateReflection", () => {
  test("user_utterance がプロンプトに入り、構造化して返す", async () => {
    const reflection = {
      goodPhrases: ["agree next steps"],
      fixes: [{ original: "I go", better: "I went" }],
      noteForTomorrow_ja: "過去形に注意。",
    };
    const { runner, seen } = runnerReturning(JSON.stringify(reflection));
    const events: SessionEvent[] = [
      { ts: "t1", type: "session_start", sessionId: "s1" },
      { ts: "t2", type: "user_utterance", sessionId: "s1", text: "I go to the meeting yesterday" },
      { ts: "t3", type: "assistant_reply", sessionId: "s1", text: "Oh, how was it?" },
    ];
    const result = await generateReflection({ events }, runner);
    expect(result).toEqual(reflection);
    expect(seen[0].prompt).toContain("I go to the meeting yesterday");
  });

  test("パース失敗時はフォールバック（noteに素のテキスト）", async () => {
    const { runner } = runnerReturning("just prose");
    const result = await generateReflection({ events: [] }, runner);
    expect(result.goodPhrases).toEqual([]);
    expect(result.noteForTomorrow_ja).toContain("just prose");
  });
});

describe("roleplayPrompt", () => {
  test("シナリオのタイトルとセットアップ・B1/短文/日本語禁止ルールを含む", () => {
    const p = roleplayPrompt({ title: "Vendor meeting", hints: ["You are the customer", "Goal: agree next steps"] });
    expect(p).toContain("Vendor meeting");
    expect(p).toContain("You are the customer");
    expect(p).toContain("B1");
    expect(p).toContain("Never switch to Japanese");
  });
});
```

- [ ] **Step 4: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/coach.test.ts`
Expected: FAIL（`coach` モジュールが存在しない）

- [ ] **Step 5: coach.ts を実装**

`app/server/coach.ts` を新規作成:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeClaudeRunner, type ClaudeRunner } from "./converse";
import type { SessionEvent } from "./session-log";

export type AeItem = { quote: string; issue: string; better: string; why_ja: string };
export type AeFeedback = { items: AeItem[]; praise: string };
export type Reflection = {
  goodPhrases: string[];
  fixes: Array<{ original: string; better: string }>;
  noteForTomorrow_ja: string;
};

const defaultRunner: ClaudeRunner = makeClaudeRunner(query);

/** LLM出力からJSONを取り出す。```フェンス除去→最初の{から最後の}までをparse。失敗はnull */
export function extractJson<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

const AE_SYSTEM = `You are an English error-correction coach for a Japanese IT professional (CEFR A2-B1).
You receive the transcript of the learner's spoken monologue (round 1 of a 4/3/2 fluency task).
Pick the 3-5 most impactful language problems (grammar, word choice, unnatural phrasing). Ignore filler words and small slips.
Reply with STRICT JSON only — no markdown fences, no commentary — exactly this shape:
{"items":[{"quote":"<the learner's exact words>","issue":"<short English label>","better":"<corrected natural version>","why_ja":"<1〜2文の簡潔な日本語解説>"}],"praise":"<one short encouraging sentence in English>"}`;

export async function generateAeFeedback(
  args: { transcript: string; topicTitle: string },
  runner: ClaudeRunner = defaultRunner,
): Promise<AeFeedback> {
  const prompt = `Topic: ${args.topicTitle}\n\nLearner's transcript:\n${args.transcript}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: AE_SYSTEM });
  const parsed = extractJson<AeFeedback>(text);
  if (parsed && Array.isArray(parsed.items)) return parsed;
  // パース失敗時のフォールバック: 素のテキストを1itemに包んでUIに出せる形にする
  return { items: [{ quote: "", issue: "feedback", better: "", why_ja: text }], praise: "" };
}

const MODEL_TALK_SYSTEM = `You produce a model monologue for an English learner (CEFR B1) to shadow.
Rules: 120-150 words, spoken register, first person, plain high-frequency vocabulary, short sentences.
No headings, no lists — just the monologue text.`;

export async function generateModelTalk(
  args: { topicTitle: string; hints: string[] },
  runner: ClaudeRunner = defaultRunner,
): Promise<{ text: string }> {
  const prompt = `Topic: ${args.topicTitle}\nCover these angles:\n${args.hints.map((h) => `- ${h}`).join("\n")}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: MODEL_TALK_SYSTEM });
  return { text };
}

const REFLECTION_SYSTEM = `You review one day of an English learner's speaking practice (CEFR A2-B1, Japanese IT professional).
You receive the learner's utterances from today's session log.
Reply with STRICT JSON only — no markdown fences — exactly this shape:
{"goodPhrases":["<up to 3 phrases the learner used well>"],"fixes":[{"original":"<learner's words>","better":"<natural version>"}],"noteForTomorrow_ja":"<明日に向けた1〜2文の日本語メモ>"}
Keep fixes to the 3 most useful items.`;

export async function generateReflection(
  args: { events: SessionEvent[] },
  runner: ClaudeRunner = defaultRunner,
): Promise<Reflection> {
  const utterances = args.events
    .filter((e) => e.type === "user_utterance" && e.text)
    .map((e) => `- ${e.text}`)
    .join("\n");
  const prompt = `Today's learner utterances:\n${utterances || "(none)"}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: REFLECTION_SYSTEM });
  const parsed = extractJson<Reflection>(text);
  if (parsed && Array.isArray(parsed.goodPhrases)) return parsed;
  return { goodPhrases: [], fixes: [], noteForTomorrow_ja: text };
}

export function roleplayPrompt(scenario: { title: string; hints: string[] }): string {
  return `You are an English roleplay partner for a Japanese IT professional (CEFR A2-B1).
Scenario: ${scenario.title}
Setup:
${scenario.hints.map((h) => `- ${h}`).join("\n")}
Rules:
- Stay in your assigned role for the whole conversation. Do not break character.
- Keep every reply SHORT: 2-4 sentences, then ask ONE question or make ONE request.
- Use plain, high-frequency English (B1 level). No rare idioms.
- Do NOT correct the learner's errors explicitly; respond naturally.
- Never switch to Japanese.`;
}
```

- [ ] **Step 6: テストが通ることを確認**

Run: `cd app && bun test server/__tests__/coach.test.ts && bun test`
Expected: coach 全 PASS、全体も PASS

- [ ] **Step 7: コミット**

```bash
git add app/server/coach.ts app/server/converse.ts app/server/__tests__/coach.test.ts app/server/__tests__/converse.test.ts
git commit -m "feat: コーチ生成（AEフィードバック・モデルトーク・振り返り）とロールプレイ用プロンプト切替を追加"
```

---

### Task 4: HTTP 拡張（メニュー・コーチ・セッションイベント）

**Files:**
- Modify: `app/server/routes.ts`, `app/server/index.ts`, `app/server/session-log.ts`（イベント型追加）
- Test: `app/server/__tests__/routes.test.ts`（追加）

**Interfaces:**
- Consumes: `menu.ts` の `buildTodayMenu`, `loadContent`, `Menu` / `coach.ts` の各生成関数と `roleplayPrompt` / `converse.ts` の `systemPromptOverride`
- Produces（Task 5 のクライアントが依存する HTTP 契約）:
  - `session-log.ts` の `SessionEvent["type"]` に `"block_start" | "block_end" | "round_start" | "round_end"` を追加
  - `RouteDeps` 追加フィールド:
    - `buildMenu: (minutes: 60 | 30) => Menu`
    - `aeFeedback: (args: { transcript: string; topicTitle: string }) => Promise<AeFeedback>`
    - `modelTalk: (topicId: string) => Promise<{ text: string } | null>`（未知IDは null）
    - `reflection: () => Promise<Reflection>`
    - `scenarioPrompt: (scenarioId: string) => string | null`（未知IDは null）
  - 新ルート:
    - `GET /api/menu/today?minutes=60|30`（省略時60、それ以外は400）→ Menu JSON
    - `POST /api/feedback/ae {transcript, topicTitle}` → AeFeedback（transcript 空は400）
    - `POST /api/coach/model-talk {topicId}` → `{text}`（topicId 欠落400、未知404）
    - `POST /api/coach/reflection {}` → Reflection
    - `POST /api/session/event {type, sessionId?, meta?}` → `{ok:true}`（type はホワイトリスト4種以外400）
    - `POST /api/converse` に optional `scenarioId`（未知IDは400、既知なら systemPromptOverride で converse）
  - 既存ルートの挙動・レスポンス形は一切変更しない

- [ ] **Step 1: SessionEvent 型にブロックイベントを追加**

`app/server/session-log.ts` の type union を変更:

```ts
export type SessionEvent = {
  ts: string;
  type:
    | "session_start" | "session_end"
    | "user_utterance" | "assistant_reply" | "error"
    | "block_start" | "block_end" | "round_start" | "round_end";
  sessionId: string;
  text?: string;
  meta?: Record<string, unknown>;
};
```

- [ ] **Step 2: 新ルートの失敗するテストを書く**

`app/server/__tests__/routes.test.ts` の `makeTestDeps` に新依存のフェイクを追加:

```ts
const FAKE_MENU = {
  minutes: 60 as const,
  date: "2026-07-05",
  blocks: [{ id: "b1", kind: "reflection", title: "振り返り", minutes: 5, params: {} }],
};
const FAKE_AE = { items: [{ quote: "q", issue: "i", better: "b", why_ja: "w" }], praise: "p" };
const FAKE_REFLECTION = { goodPhrases: ["g"], fixes: [], noteForTomorrow_ja: "n" };
```

`deps` オブジェクトに追加（既存フィールドの後ろ）:

```ts
    buildMenu: ((_minutes: 60 | 30) => FAKE_MENU) as RouteDeps["buildMenu"],
    aeFeedback: (async () => FAKE_AE) as RouteDeps["aeFeedback"],
    modelTalk: (async (topicId: string) =>
      topicId === "known-topic" ? { text: "model talk" } : null) as RouteDeps["modelTalk"],
    reflection: (async () => FAKE_REFLECTION) as RouteDeps["reflection"],
    scenarioPrompt: ((id: string) => (id === "known-scenario" ? "ROLEPLAY PROMPT" : null)) as RouteDeps["scenarioPrompt"],
```

（注意: 必ず `...overrides` スプレッドより**前**に置く。テストごとの override が新フィールドにも効くようにするため）

新しい describe 群を追記:

```ts
describe("routes: menu", () => {
  test("GET /api/menu/today はデフォルト60分のメニューを返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/menu/today"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_MENU);
  });

  test("minutes=30 が渡る / 不正値は400", async () => {
    const seen: number[] = [];
    const { deps } = makeTestDeps({
      buildMenu: ((m: 60 | 30) => { seen.push(m); return { ...FAKE_MENU, minutes: m }; }) as RouteDeps["buildMenu"],
    });
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/menu/today?minutes=30"));
    expect(ok.status).toBe(200);
    expect(seen).toEqual([30]);
    const bad = await handler(new Request("http://localhost/api/menu/today?minutes=45"));
    expect(bad.status).toBe(400);
  });
});

describe("routes: coach", () => {
  test("POST /api/feedback/ae: 正常系とtranscript空400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/feedback/ae", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "I go yesterday", topicTitle: "My week" }),
    }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(FAKE_AE);
    const bad = await handler(new Request("http://localhost/api/feedback/ae", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topicTitle: "x" }),
    }));
    expect(bad.status).toBe(400);
  });

  test("POST /api/coach/model-talk: 既知ID 200 / 欠落400 / 未知404", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/coach/model-talk", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ topicId: "known-topic" }),
    }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ text: "model talk" });
    const missing = await handler(new Request("http://localhost/api/coach/model-talk", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    }));
    expect(missing.status).toBe(400);
    const unknown = await handler(new Request("http://localhost/api/coach/model-talk", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ topicId: "nope" }),
    }));
    expect(unknown.status).toBe(404);
  });

  test("POST /api/coach/reflection は Reflection を返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/coach/reflection", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_REFLECTION);
  });
});

describe("routes: session/event", () => {
  test("ホワイトリストのtypeはログされ {ok:true}", async () => {
    const { deps, logFile } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/session/event", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "block_start", meta: { blockId: "b2", kind: "four-three-two" } }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const events = readEvents(logFile);
    expect(events).toEqual([
      expect.objectContaining({ type: "block_start", meta: { blockId: "b2", kind: "four-three-two" } }),
    ]);
  });

  test("ホワイトリスト外のtypeは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/session/event", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "session_start" }),
    }));
    expect(res.status).toBe(400);
  });
});

describe("routes: converse + scenarioId", () => {
  test("既知の scenarioId は systemPromptOverride 付きで converse に渡る", async () => {
    const seen: Array<{ systemPromptOverride?: string }> = [];
    const { deps } = makeTestDeps({
      converse: (async (args: { userText: string; sessionId?: string; systemPromptOverride?: string }) => {
        seen.push({ systemPromptOverride: args.systemPromptOverride });
        return { replyText: "ok", sessionId: "s1" };
      }) as RouteDeps["converse"],
    });
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/converse", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userText: "hi", scenarioId: "known-scenario" }),
    }));
    expect(res.status).toBe(200);
    expect(seen[0].systemPromptOverride).toBe("ROLEPLAY PROMPT");
  });

  test("未知の scenarioId は400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/converse", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userText: "hi", scenarioId: "nope" }),
    }));
    expect(res.status).toBe(400);
  });

  test("scenarioId なしは従来どおり（override は undefined）", async () => {
    const seen: Array<{ systemPromptOverride?: string }> = [];
    const { deps } = makeTestDeps({
      converse: (async (args: { userText: string; systemPromptOverride?: string }) => {
        seen.push({ systemPromptOverride: args.systemPromptOverride });
        return { replyText: "ok", sessionId: "s1" };
      }) as RouteDeps["converse"],
    });
    const handler = makeFetchHandler(deps);
    await handler(new Request("http://localhost/api/converse", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userText: "hi" }),
    }));
    expect(seen[0].systemPromptOverride).toBeUndefined();
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/routes.test.ts`
Expected: FAIL（RouteDeps に新フィールドが無く型エラー / 新ルート404）

- [ ] **Step 4: routes.ts を拡張**

`app/server/routes.ts` に import を追加:

```ts
import { isErrorLogged } from "./session-log";  // Task 1 で追加済みならそのまま
import type { Menu } from "./menu";
import type { AeFeedback, Reflection } from "./coach";
```

`RouteDeps` に追加:

```ts
  buildMenu: (minutes: 60 | 30) => Menu;
  aeFeedback: (args: { transcript: string; topicTitle: string }) => Promise<AeFeedback>;
  /** 未知の topicId は null（ルートは404を返す） */
  modelTalk: (topicId: string) => Promise<{ text: string } | null>;
  reflection: () => Promise<Reflection>;
  /** 未知の scenarioId は null（ルートは400を返す） */
  scenarioPrompt: (scenarioId: string) => string | null;
```

ハンドラを追加:

```ts
function handleMenuToday(url: URL, deps: RouteDeps): Response {
  const raw = url.searchParams.get("minutes") ?? "60";
  if (raw !== "60" && raw !== "30") return json({ error: "minutes must be 60 or 30" }, 400);
  const minutes = Number(raw) as 60 | 30;
  return json(deps.buildMenu(minutes));
}

async function handleAeFeedback(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ transcript?: string; topicTitle?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const { transcript, topicTitle } = parsed.body;
  if (!transcript?.trim()) return json({ error: "transcript is required" }, 400);
  return json(await deps.aeFeedback({ transcript, topicTitle: topicTitle ?? "" }));
}

async function handleModelTalk(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ topicId?: string }>(req);
  if (!parsed.ok) return parsed.response;
  if (!parsed.body.topicId?.trim()) return json({ error: "topicId is required" }, 400);
  const talk = await deps.modelTalk(parsed.body.topicId);
  if (!talk) return json({ error: "unknown topicId" }, 404);
  return json(talk);
}

const BLOCK_EVENT_TYPES = ["block_start", "block_end", "round_start", "round_end"] as const;
type BlockEventType = (typeof BLOCK_EVENT_TYPES)[number];

async function handleSessionEvent(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ type?: string; sessionId?: string; meta?: Record<string, unknown> }>(req);
  if (!parsed.ok) return parsed.response;
  const t = parsed.body.type;
  if (!t || !(BLOCK_EVENT_TYPES as readonly string[]).includes(t)) {
    return json({ error: `type must be one of: ${BLOCK_EVENT_TYPES.join(", ")}` }, 400);
  }
  appendEvent(deps.logFile(), {
    ts: new Date().toISOString(),
    type: t as BlockEventType,
    sessionId: parsed.body.sessionId ?? "pending",
    meta: parsed.body.meta,
  });
  return json({ ok: true });
}
```

`handleConverse` を scenarioId 対応に変更:

```ts
async function handleConverse(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ userText?: string; sessionId?: string; scenarioId?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!body.userText?.trim()) return json({ error: "userText is required" }, 400);
  let systemPromptOverride: string | undefined;
  if (body.scenarioId) {
    const p = deps.scenarioPrompt(body.scenarioId);
    if (!p) return json({ error: "unknown scenarioId" }, 400);
    systemPromptOverride = p;
  }
  const r = await deps.converse({ userText: body.userText, sessionId: body.sessionId, systemPromptOverride });
  return json(r);
}
```

`makeFetchHandler` のルーティングに追加（`/api/session/end` の行の後）:

```ts
      if (req.method === "GET" && url.pathname === "/api/menu/today") return handleMenuToday(url, deps);
      if (req.method === "POST" && url.pathname === "/api/feedback/ae") return await handleAeFeedback(req, deps);
      if (req.method === "POST" && url.pathname === "/api/coach/model-talk") return await handleModelTalk(req, deps);
      if (req.method === "POST" && url.pathname === "/api/coach/reflection") return json(await deps.reflection());
      if (req.method === "POST" && url.pathname === "/api/session/event") return await handleSessionEvent(req, deps);
```

- [ ] **Step 5: index.ts の realDeps を配線**

`app/server/index.ts` を以下に更新:

```ts
import { ensureDirs, RECORDINGS_DIR, SCENARIOS_DIR, TOPICS_DIR, sessionLogPath } from "./paths";
import { transcribeAudio } from "./stt";
import { synthesize } from "./tts";
import { converseTurn } from "./converse";
import { checkHealth } from "./health";
import { buildTodayMenu, loadContent } from "./menu";
import { generateAeFeedback, generateModelTalk, generateReflection, roleplayPrompt } from "./coach";
import { readEvents } from "./session-log";
import { makeFetchHandler, type RouteDeps } from "./routes";

ensureDirs();
const PORT = 3111;
const HOSTNAME = "127.0.0.1";

const realDeps: RouteDeps = {
  transcribe: transcribeAudio,
  synthesize,
  converse: converseTurn,
  health: () => checkHealth(),
  logFile: () => sessionLogPath(new Date()),
  recordingsDir: RECORDINGS_DIR,
  buildMenu: (minutes) => buildTodayMenu(minutes),
  aeFeedback: (args) => generateAeFeedback(args),
  modelTalk: async (topicId) => {
    const topic = loadContent(TOPICS_DIR).find((t) => t.id === topicId);
    if (!topic) return null;
    return generateModelTalk({ topicTitle: topic.title, hints: topic.hints });
  },
  reflection: () => generateReflection({ events: readEvents(sessionLogPath(new Date())) }),
  scenarioPrompt: (scenarioId) => {
    const sc = loadContent(SCENARIOS_DIR).find((s) => s.id === scenarioId);
    return sc ? roleplayPrompt(sc) : null;
  },
};

Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  idleTimeout: 120,
  // 2分程度の音声Blobに十分な余裕を持たせた上限（DoS的な巨大ボディを拒否する）
  maxRequestBodySize: 32 * 1024 * 1024,
  fetch: makeFetchHandler(realDeps),
});

console.log(`learn-english server: http://${HOSTNAME}:${PORT} (health: /api/health)`);
```

- [ ] **Step 6: 全テスト＋typecheck**

Run: `cd app && bun test && bun run typecheck`
Expected: 全 PASS（既存42件＋Task1-4追加分）、typecheck 0 エラー

- [ ] **Step 7: コミット**

```bash
git add app/server/
git commit -m "feat: メニュー・コーチ・セッションイベントのAPIルートを追加"
```

---

### Task 5: クライアント — セッションフローUI

**Files:**
- Create: `app/client/src/useCountdown.ts`, `app/client/src/screens/StartScreen.tsx`, `app/client/src/screens/SessionRunner.tsx`, `app/client/src/screens/FreeTalkScreen.tsx`, `app/client/src/screens/FourThreeTwoScreen.tsx`, `app/client/src/screens/RoleplayScreen.tsx`, `app/client/src/screens/ShadowingScreen.tsx`, `app/client/src/screens/ReflectionScreen.tsx`, `app/client/src/screens/ChunkPlaceholderScreen.tsx`
- Modify: `app/client/src/api.ts`, `app/client/src/App.tsx`

**Interfaces:**
- Consumes: Task 4 の HTTP 契約（正確な形は Task 4 の Produces を参照）
- Produces: なし（最終消費者）。ゲートは `bun run build`（tsc --noEmit && vite build）

- [ ] **Step 1: api.ts に新ヘルパを追加**

`app/client/src/api.ts` に追記:

```ts
export type ContentItem = { id: string; kind: "topic" | "scenario"; title: string; titleJa: string; hints: string[] };
export type MenuBlock = { id: string; kind: string; title: string; minutes: number; params: { topic?: ContentItem; scenario?: ContentItem } };
export type Menu = { minutes: number; date: string; blocks: MenuBlock[] };
export type AeItem = { quote: string; issue: string; better: string; why_ja: string };
export type AeFeedback = { items: AeItem[]; praise: string };
export type Reflection = { goodPhrases: string[]; fixes: Array<{ original: string; better: string }>; noteForTomorrow_ja: string };

export async function fetchMenu(minutes: 60 | 30): Promise<Menu> {
  const res = await fetch(`/api/menu/today?minutes=${minutes}`);
  if (!res.ok) throw new Error(`menu failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function fetchAeFeedback(transcript: string, topicTitle: string): Promise<AeFeedback> {
  const res = await fetch("/api/feedback/ae", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript, topicTitle }),
  });
  if (!res.ok) throw new Error(`AE feedback failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function fetchModelTalk(topicId: string): Promise<string> {
  const res = await fetch("/api/coach/model-talk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topicId }),
  });
  if (!res.ok) throw new Error(`model talk failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}

export async function fetchReflection(): Promise<Reflection> {
  const res = await fetch("/api/coach/reflection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`reflection failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export function sendSessionEvent(
  type: "block_start" | "block_end" | "round_start" | "round_end",
  meta?: Record<string, unknown>,
): void {
  // 進行イベントは fire-and-forget（記録失敗でセッションを止めない）
  void fetch("/api/session/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, meta }),
  });
}
```

既存 `converse` を scenarioId 対応に変更（呼び出し互換）:

```ts
export async function converse(
  userText: string,
  sessionId?: string,
  scenarioId?: string,
): Promise<{ replyText: string; sessionId: string }> {
  const res = await fetch("/api/converse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userText, sessionId, scenarioId }),
  });
  if (!res.ok) throw new Error(`converse failed: ${await extractErrorMessage(res)}`);
  return res.json();
}
```

- [ ] **Step 2: useCountdown フックを作成**

`app/client/src/useCountdown.ts`:

```ts
import { useEffect, useState } from "react";

/** 1秒刻みのカウントダウン。0で自動停止。start/pause/reset を提供 */
export function useCountdown(initialSeconds: number) {
  const [remaining, setRemaining] = useState(initialSeconds);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setRemaining((r) => (r > 0 ? r - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (remaining === 0 && running) setRunning(false);
  }, [remaining, running]);

  return {
    remaining,
    running,
    expired: remaining === 0,
    start: () => setRunning(true),
    pause: () => setRunning(false),
    reset: (seconds: number) => {
      setRunning(false);
      setRemaining(seconds);
    },
  };
}

export function formatMmSs(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
```

- [ ] **Step 3: FreeTalkScreen を抽出（M1 のUIを移設・ロールプレイ共用）**

`app/client/src/screens/FreeTalkScreen.tsx`:

```tsx
import { useRef, useState } from "react";
import { converse, sttUpload, ttsFetch } from "../api";
import { playBlob, Recorder } from "../audio";

type Turn = { role: "you" | "ai"; text: string };
type Status = "idle" | "recording" | "transcribing" | "thinking" | "speaking" | "error";

const LABELS: Record<Status, string> = {
  idle: "🎙 話す（クリックで録音開始）",
  recording: "⏹ 録音中…（クリックで送信）",
  transcribing: "📝 文字起こし中…",
  thinking: "🤔 考え中…",
  speaking: "🔊 再生中…",
  error: "🎙 もう一度話す",
};

/** 会話ループ画面。scenarioId を渡すとロールプレイモードになる（M1の自由会話UIを抽出したもの） */
export function FreeTalkScreen(props: { scenarioId?: string; onSessionId?: (id: string) => void }) {
  const [status, setStatus] = useState<Status>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const sessionIdRef = useRef<string | undefined>(undefined);
  const recorderRef = useRef(new Recorder());

  async function onMainButton() {
    setErrorMsg("");
    if (status === "idle" || status === "error") {
      try {
        await recorderRef.current.start();
        setStatus("recording");
      } catch (err) {
        setErrorMsg(`マイクにアクセスできません: ${err instanceof Error ? err.message : String(err)}`);
        setStatus("error");
      }
      return;
    }
    if (status !== "recording") return;
    try {
      setStatus("transcribing");
      const blob = await recorderRef.current.stop();
      const text = await sttUpload(blob);
      if (!text) {
        setErrorMsg("音声を聞き取れませんでした。もう一度話してください。");
        setStatus("error");
        return;
      }
      setTurns((t) => [...t, { role: "you", text }]);

      setStatus("thinking");
      const { replyText, sessionId } = await converse(text, sessionIdRef.current, props.scenarioId);
      sessionIdRef.current = sessionId;
      props.onSessionId?.(sessionId);
      setTurns((t) => [...t, { role: "ai", text: replyText }]);

      setStatus("speaking");
      await playBlob(await ttsFetch(replyText));
      setStatus("idle");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  return (
    <div>
      <div style={{ margin: "1rem 0" }}>
        <button
          onClick={onMainButton}
          disabled={status === "transcribing" || status === "thinking" || status === "speaking"}
          style={{ fontSize: "1.1rem", padding: "0.8rem 1.4rem", cursor: "pointer" }}
        >
          {LABELS[status]}
        </button>
      </div>
      {errorMsg && <p style={{ color: "crimson" }}>{errorMsg}</p>}
      <section>
        {turns.map((t, i) => (
          <p key={i} style={{ whiteSpace: "pre-wrap" }}>
            <strong>{t.role === "you" ? "You" : "AI"}:</strong> {t.text}
          </p>
        ))}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: 各ブロック画面を作成**

`app/client/src/screens/ChunkPlaceholderScreen.tsx`:

```tsx
export function ChunkPlaceholderScreen() {
  return (
    <div>
      <p>このブロックは M3（チャンクSRS）で本実装されます。</p>
      <p>今日は: 最近の仕事で使った/使いたかった英語表現を思い出して、声に出して3回言ってみてください。</p>
    </div>
  );
}
```

`app/client/src/screens/FourThreeTwoScreen.tsx`:

```tsx
import { useRef, useState } from "react";
import { fetchAeFeedback, sendSessionEvent, sttUpload, type AeFeedback, type ContentItem } from "../api";
import { Recorder } from "../audio";
import { formatMmSs, useCountdown } from "../useCountdown";

const ROUNDS = [
  { seconds: 240, label: "Round 1（4分）", listener: "Listener: a colleague who doesn't know this topic yet." },
  { seconds: 180, label: "Round 2（3分）", listener: "New listener: your manager. Tell the same story, faster." },
  { seconds: 120, label: "Round 3（2分）", listener: "New listener: someone at a conference. Same story, 2 minutes." },
] as const;

type Phase = { kind: "round"; index: number } | { kind: "ae" } | { kind: "done" };
type RecState = "idle" | "recording" | "transcribing";

/** 4/3/2 流暢性ブロック: 同じ話を4分→(AE)→3分→2分。時間圧タイマー＋ラウンド間の遅延明示フィードバック */
export function FourThreeTwoScreen(props: { topic: ContentItem; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "round", index: 0 });
  const [recState, setRecState] = useState<RecState>("idle");
  const [transcripts, setTranscripts] = useState<string[]>(["", "", ""]);
  // setState は非同期に反映されるため、finishRound が直後に読む用の同期ミラーを持つ
  // （これが無いと Round 1 直後の AE フィードバックが最後の発話を取りこぼす）
  const transcriptsRef = useRef<string[]>(["", "", ""]);
  const [ae, setAe] = useState<AeFeedback | null>(null);
  const [aeLoading, setAeLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const recorderRef = useRef(new Recorder());
  const timer = useCountdown(ROUNDS[0].seconds);

  const roundIndex = phase.kind === "round" ? phase.index : 0;

  async function toggleRecording() {
    setErrorMsg("");
    if (recState === "idle") {
      try {
        await recorderRef.current.start();
        setRecState("recording");
        if (!timer.running && !timer.expired) {
          timer.start();
          sendSessionEvent("round_start", { block: "four-three-two", round: roundIndex + 1 });
        }
      } catch (err) {
        setErrorMsg(`マイクにアクセスできません: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (recState !== "recording") return;
    try {
      setRecState("transcribing");
      const blob = await recorderRef.current.stop();
      const text = await sttUpload(blob);
      transcriptsRef.current[roundIndex] = [transcriptsRef.current[roundIndex], text]
        .filter(Boolean)
        .join(" ");
      setTranscripts([...transcriptsRef.current]);
      setRecState("idle");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setRecState("idle");
    }
  }

  async function finishRound() {
    if (recState === "recording") await toggleRecording();
    timer.pause();
    sendSessionEvent("round_end", { block: "four-three-two", round: roundIndex + 1 });
    if (roundIndex === 0) {
      setPhase({ kind: "ae" });
      setAeLoading(true);
      try {
        setAe(await fetchAeFeedback(transcriptsRef.current[0], props.topic.title));
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setAeLoading(false);
      }
    } else if (roundIndex < ROUNDS.length - 1) {
      startRound(roundIndex + 1);
    } else {
      setPhase({ kind: "done" });
      props.onDone();
    }
  }

  function startRound(index: number) {
    setPhase({ kind: "round", index });
    timer.reset(ROUNDS[index].seconds);
  }

  if (phase.kind === "ae") {
    return (
      <div>
        <h3>フィードバック（読んだら Round 2 へ）</h3>
        {aeLoading && <p>コーチがフィードバックを書いています…</p>}
        {ae && (
          <div>
            {ae.praise && <p>👏 {ae.praise}</p>}
            <ul>
              {ae.items.map((item, i) => (
                <li key={i} style={{ marginBottom: "0.6rem" }}>
                  {item.quote && (
                    <div>
                      <s>{item.quote}</s> → <strong>{item.better}</strong> <em>({item.issue})</em>
                    </div>
                  )}
                  <div>{item.why_ja}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {errorMsg && <p style={{ color: "crimson" }}>{errorMsg}</p>}
        <button onClick={() => startRound(1)} disabled={aeLoading} style={{ padding: "0.6rem 1.2rem" }}>
          Round 2 を始める（3分）
        </button>
      </div>
    );
  }

  if (phase.kind === "done") {
    return <p>4/3/2 完了！同じ話を3回、少しずつ速く話せました。</p>;
  }

  const round = ROUNDS[roundIndex];
  return (
    <div>
      <h3>{round.label} — {props.topic.title}</h3>
      <p style={{ color: "#666" }}>{round.listener}</p>
      <ul>
        {props.topic.hints.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
      <p style={{ fontSize: "2rem", fontVariantNumeric: "tabular-nums" }}>
        ⏱ {formatMmSs(timer.remaining)} {timer.expired && "— 時間切れ！"}
      </p>
      <button onClick={toggleRecording} disabled={recState === "transcribing"} style={{ padding: "0.6rem 1.2rem" }}>
        {recState === "recording" ? "⏹ 録音を止める" : recState === "transcribing" ? "📝 文字起こし中…" : "🎙 話し始める"}
      </button>{" "}
      <button onClick={finishRound} disabled={recState === "transcribing"} style={{ padding: "0.6rem 1.2rem" }}>
        このラウンドを終える →
      </button>
      {errorMsg && <p style={{ color: "crimson" }}>{errorMsg}</p>}
      {transcripts[roundIndex] && (
        <p style={{ whiteSpace: "pre-wrap" }}>
          <strong>You:</strong> {transcripts[roundIndex]}
        </p>
      )}
    </div>
  );
}
```

`app/client/src/screens/RoleplayScreen.tsx`:

```tsx
import { type ContentItem } from "../api";
import { FreeTalkScreen } from "./FreeTalkScreen";

export function RoleplayScreen(props: { scenario: ContentItem }) {
  return (
    <div>
      <p style={{ color: "#666" }}>{props.scenario.titleJa}</p>
      <ul>
        {props.scenario.hints.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
      <FreeTalkScreen scenarioId={props.scenario.id} />
    </div>
  );
}
```

`app/client/src/screens/ShadowingScreen.tsx`:

```tsx
import { useState } from "react";
import { fetchModelTalk, ttsFetch, type ContentItem } from "../api";
import { playBlob } from "../audio";

type State = "init" | "loading" | "ready" | "playing" | "error";

/** モデルトークをTTSで聞きながら重ねて音読するシャドーイングブロック（知覚ドリル） */
export function ShadowingScreen(props: { topic: ContentItem }) {
  const [state, setState] = useState<State>("init");
  const [text, setText] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  async function prepare() {
    setState("loading");
    setErrorMsg("");
    try {
      const talk = await fetchModelTalk(props.topic.id);
      setText(talk);
      setAudioBlob(await ttsFetch(talk));
      setState("ready");
    } catch (err) {
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
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
    setState("ready");
  }

  return (
    <div>
      <p style={{ color: "#666" }}>
        音声に少し遅れてかぶせるように声に出して繰り返します（シャドーイング）。まず1回聞くだけでもOK。
      </p>
      {(state === "init" || state === "error") && (
        <button onClick={prepare} style={{ padding: "0.6rem 1.2rem" }}>モデルトークを生成する</button>
      )}
      {state === "loading" && <p>コーチがモデルトークを書いています…</p>}
      {(state === "ready" || state === "playing") && (
        <div>
          <button onClick={play} disabled={state === "playing"} style={{ padding: "0.6rem 1.2rem" }}>
            {state === "playing" ? "🔊 再生中…" : "▶ 再生（何度でも）"}
          </button>
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.8 }}>{text}</p>
        </div>
      )}
      {errorMsg && <p style={{ color: "crimson" }}>{errorMsg}</p>}
    </div>
  );
}
```

`app/client/src/screens/ReflectionScreen.tsx`:

```tsx
import { useEffect, useState } from "react";
import { fetchReflection, type Reflection } from "../api";

export function ReflectionScreen() {
  const [reflection, setReflection] = useState<Reflection | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    fetchReflection()
      .then(setReflection)
      .catch((err) => setErrorMsg(err instanceof Error ? err.message : String(err)));
  }, []);

  if (errorMsg) return <p style={{ color: "crimson" }}>{errorMsg}</p>;
  if (!reflection) return <p>コーチが今日のセッションを振り返っています…</p>;

  return (
    <div>
      {reflection.goodPhrases.length > 0 && (
        <div>
          <h3>👏 良かった表現</h3>
          <ul>{reflection.goodPhrases.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}
      {reflection.fixes.length > 0 && (
        <div>
          <h3>✏️ 直したい表現</h3>
          <ul>
            {reflection.fixes.map((f, i) => (
              <li key={i}><s>{f.original}</s> → <strong>{f.better}</strong></li>
            ))}
          </ul>
        </div>
      )}
      <h3>📝 明日へ</h3>
      <p>{reflection.noteForTomorrow_ja}</p>
    </div>
  );
}
```

`app/client/src/screens/StartScreen.tsx`:

```tsx
export function StartScreen(props: { onSelect: (mode: "session60" | "session30" | "free") => void }) {
  const btn = { display: "block", width: "100%", fontSize: "1.1rem", padding: "1rem", marginBottom: "0.8rem", cursor: "pointer" } as const;
  return (
    <div>
      <p>今日のトレーニングを選んでください:</p>
      <button style={btn} onClick={() => props.onSelect("session60")}>📋 今日のセッション（60分）</button>
      <button style={btn} onClick={() => props.onSelect("session30")}>📋 今日のセッション（30分・短縮版）</button>
      <button style={btn} onClick={() => props.onSelect("free")}>💬 自由会話のみ</button>
    </div>
  );
}
```

`app/client/src/screens/SessionRunner.tsx`:

```tsx
import { useEffect, useState } from "react";
import { fetchMenu, sendSessionEvent, type Menu, type MenuBlock } from "../api";
import { formatMmSs, useCountdown } from "../useCountdown";
import { ChunkPlaceholderScreen } from "./ChunkPlaceholderScreen";
import { FourThreeTwoScreen } from "./FourThreeTwoScreen";
import { ReflectionScreen } from "./ReflectionScreen";
import { RoleplayScreen } from "./RoleplayScreen";
import { ShadowingScreen } from "./ShadowingScreen";

/** メニューを取得し、ブロックを順番に進行させる。ブロックタイマーと進行イベント記録を持つ */
export function SessionRunner(props: { minutes: 60 | 30; onExit: () => void }) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [index, setIndex] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const timer = useCountdown(0);

  useEffect(() => {
    fetchMenu(props.minutes)
      .then((m) => {
        setMenu(m);
        const first = m.blocks[0];
        timer.reset(first.minutes * 60);
        timer.start();
        sendSessionEvent("block_start", { blockId: first.id, kind: first.kind });
      })
      .catch((err) => setErrorMsg(err instanceof Error ? err.message : String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.minutes]);

  if (errorMsg) return <p style={{ color: "crimson" }}>{errorMsg}</p>;
  if (!menu) return <p>今日のメニューを組んでいます…</p>;

  const block = menu.blocks[index];
  const isLast = index === menu.blocks.length - 1;

  function nextBlock() {
    sendSessionEvent("block_end", { blockId: block.id, kind: block.kind });
    if (isLast) {
      props.onExit();
      return;
    }
    const next = menu!.blocks[index + 1];
    setIndex(index + 1);
    timer.reset(next.minutes * 60);
    timer.start();
    sendSessionEvent("block_start", { blockId: next.id, kind: next.kind });
  }

  return (
    <div>
      <p style={{ color: "#666" }}>
        ブロック {index + 1}/{menu.blocks.length} ・ ⏱ {formatMmSs(timer.remaining)}
        {timer.expired && " — 時間切れ（キリのいいところで次へ）"}
      </p>
      <h2 style={{ fontSize: "1.1rem" }}>{block.title}</h2>
      <BlockBody block={block} />
      <hr style={{ margin: "1.5rem 0" }} />
      <button onClick={nextBlock} style={{ padding: "0.8rem 1.4rem", fontSize: "1rem", cursor: "pointer" }}>
        {isLast ? "✅ セッションを終える" : "次のブロックへ →"}
      </button>
    </div>
  );
}

function BlockBody({ block }: { block: MenuBlock }) {
  switch (block.kind) {
    case "chunk-placeholder":
      return <ChunkPlaceholderScreen />;
    case "four-three-two":
      return block.params.topic ? (
        <FourThreeTwoScreen topic={block.params.topic} onDone={() => undefined} />
      ) : (
        <p>トピックがありません</p>
      );
    case "roleplay":
      return block.params.scenario ? <RoleplayScreen scenario={block.params.scenario} /> : <p>シナリオがありません</p>;
    case "shadowing":
      return block.params.topic ? <ShadowingScreen topic={block.params.topic} /> : <p>トピックがありません</p>;
    case "reflection":
      return <ReflectionScreen />;
    default:
      return <p>未知のブロック: {block.kind}</p>;
  }
}
```

- [ ] **Step 5: App.tsx をモード分岐に再構成**

`app/client/src/App.tsx` を全置換:

```tsx
import { useEffect, useRef, useState } from "react";
import { getHealth, sessionEnd, sessionEndKeepalive, sessionStart, type Health } from "./api";
import { FreeTalkScreen } from "./screens/FreeTalkScreen";
import { SessionRunner } from "./screens/SessionRunner";
import { StartScreen } from "./screens/StartScreen";

type Mode = "start" | "session60" | "session30" | "free";

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [mode, setMode] = useState<Mode>("start");
  const sessionIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    getHealth()
      .then((h) => { setHealth(h); setServerDown(false); })
      .catch(() => { setHealth(null); setServerDown(true); });
    sessionStart();
    const onPageHide = () => {
      if (sessionIdRef.current) sessionEndKeepalive(sessionIdRef.current);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      if (sessionIdRef.current) sessionEnd(sessionIdRef.current);
    };
  }, []);

  return (
    <main style={{ maxWidth: 640, margin: "2rem auto", fontFamily: "system-ui", padding: "0 1rem" }}>
      <h1 style={{ fontSize: "1.2rem" }}>
        learn-english
        {mode !== "start" && (
          <button
            onClick={() => setMode("start")}
            style={{ marginLeft: "1rem", fontSize: "0.8rem", cursor: "pointer" }}
          >
            ← メニューに戻る
          </button>
        )}
      </h1>
      {serverDown && (
        <p style={{ color: "crimson" }}>
          APIサーバに接続できません — `cd app && bun run dev` で起動してください
        </p>
      )}
      {!serverDown && health && !health.ok && (
        <p style={{ color: "crimson" }}>
          依存が不足しています: {JSON.stringify(health)} — `scripts/setup.sh` を実行してください
        </p>
      )}
      {!serverDown && health && health.ok && !health.ttsKey && (
        <p style={{ color: "darkorange" }}>OPENAI_API_KEY 未設定のため TTS は say フォールバックです</p>
      )}
      {mode === "start" && <StartScreen onSelect={setMode} />}
      {mode === "session60" && <SessionRunner minutes={60} onExit={() => setMode("start")} />}
      {mode === "session30" && <SessionRunner minutes={30} onExit={() => setMode("start")} />}
      {mode === "free" && <FreeTalkScreen onSessionId={(id) => { sessionIdRef.current = id; }} />}
    </main>
  );
}
```

（注: M1 の録音/会話ロジックは FreeTalkScreen へ移設。App の sessionIdRef は session_end 送信用で、FreeTalkScreen の `onSessionId` コールバック経由で更新される。SessionRunner 内の各ブロックの会話 sessionId はブロックローカルで、session_end には紐づけない — M2 の割り切りとして許容）

- [ ] **Step 6: ビルドで検証**

Run: `cd app/client && bun run build`
Expected: tsc --noEmit と vite build がともに成功

- [ ] **Step 7: 実サーバで動作スモーク**

Run（ターミナル1）: `cd app && bun run dev`
Run（ターミナル2）: `cd app/client && bun run dev` → ブラウザで `http://localhost:5173`

確認（Claude を実呼び出しするのは AE/モデルトーク/振り返り/会話のみ。数秒かかる）:
1. スタート画面に3択が出る
2. 「60分」でメニューが組まれ、ブロック1（チャンクプレースホルダ）にタイマーが出る
3. 「次のブロックへ」で 4/3/2 に進み、トピックと hints が表示される。録音→停止でトランスクリプトが出る→「このラウンドを終える」でAEフィードバックが表示される
4. ロールプレイでシナリオ設定が表示され、AIがロールを維持して返す
5. `data/sessions/$(date +%F).jsonl` に block_start/block_end/round_start/round_end が記録されている
6. `data/progress/menu-<today>-60.json` と `topic-usage.json` が生成されている

Run（両ターミナル）: Ctrl+C でサーバ停止

- [ ] **Step 8: コミット**

```bash
git add app/client/
git commit -m "feat: セッションフローUI（メニュー進行・4/3/2・ロールプレイ・シャドーイング・振り返り）を追加"
```

---

### Task 6: 仕上げ（README・最終検証）

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1〜5 の成果すべて
- Produces: なし（ドキュメントと検証）

- [ ] **Step 1: README を更新**

`README.md` の「起動」セクションの後に以下を追加（既存の記述は保持）:

```markdown
## 使い方

ブラウザで http://localhost:5173 を開くと3つのモードを選べます:

- **今日のセッション（60分）** — 研究ベースの5ブロック構成: チャンク(8分・M3で本実装) → 4/3/2 流暢性トレーニング(16分) → 実務ロールプレイ(20分) → シャドーイング(8分) → 振り返り(5分)
- **今日のセッション（30分・短縮版）** — チャンク(6分) → 4/3/2(12分) → ロールプレイ(10分) → 振り返り(2分)
- **自由会話のみ** — M1 の会話ループ

トピックは `content/topics/*.md`、ロールプレイのシナリオは `content/scenarios/*.md` にあり、
Markdown ファイルを追加するだけでローテーションに入ります（frontmatter: id / kind / title / title_ja、本文の `- ` 行がヒント）。
選択は least-recently-used で自動ローテーションされ、`data/progress/` に使用履歴と当日メニューが記録されます。

方法論の根拠は [設計ドキュメント](docs/superpowers/specs/2026-07-05-learn-english-system-design.md) §5 を参照。
```

- [ ] **Step 2: 最終検証（全ゲート）**

Run:

```bash
cd app && bun test && bun run typecheck
cd client && bun run build
```

Expected: サーバ全テスト PASS / typecheck 0 エラー / クライアントビルド成功

Run（実サーバ・新ルートの契約スモーク。Claude 呼び出しを伴わないものだけ）:

```bash
cd app && bun run dev &
sleep 2
curl -s "http://127.0.0.1:3111/api/menu/today?minutes=60" | head -c 400; echo
curl -s -X POST http://127.0.0.1:3111/api/session/event \
  -H 'content-type: application/json' \
  -d '{"type":"block_start","meta":{"blockId":"b1"}}'
curl -s "http://127.0.0.1:3111/api/menu/today?minutes=45"
kill %1
```

Expected: メニューJSON（blocks 5件）/ `{"ok":true}` / `{"error":"minutes must be 60 or 30"}`

- [ ] **Step 3: コミット**

```bash
git add README.md
git commit -m "docs: READMEにセッションフローとコンテンツの増やし方を追記"
```

---

## Self-Review 結果（プラン作成時に実施済み）

- **スペック対応**: §5.2/§5.3 のブロック構成・分数は `buildTodayMenu` のテストで数値まで固定。§6.2 M2 の定義（メニューエンジン＋ブロックタイマー＋4/3/2の時間圧タイマーとAEフィードバック）を Task 2/4/5 でカバー。AE方式（発話中は止めず、ラウンド間で明示フィードバック＋日本語メタ言語説明）は Tran & Saito 2021 の検証形式に一致
- **スコープ判断（意図的な逸脱）**: (1) `generateListenerReaction` は不採用 — spec の要求は「毎回別の聞き手」であり、静的なリスナーペルソナ表示で満たせるため（YAGNI）。(2) メニューの日次キャッシュ（`menu-<ymd>-<minutes>.json`）を追加 — リロードで当日メニューが変わる/使用記録が重複する実害を防ぐため
- **型整合**: `ClaudeRunner` の第3引数は Task 1 のパススルーテスト・Task 3 の実装・Task 4 の routes 経由呼び出しで同一シグネチャ。`RouteDeps` 追加フィールドの型は Task 4 の Produces と routes.test.ts のフェイクで一致。クライアント `api.ts` の型はサーバの `Menu`/`AeFeedback`/`Reflection` の JSON 形と一致
- **プレースホルダなし**: 全コードステップに完全なコードを記載。チャンクブロックの「プレースホルダ」は M3 までの仕様上の設計であり計画の穴ではない
