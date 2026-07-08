import { tmpdir } from "node:os";
import type { ClaudeRunner } from "../converse";
import { composeCodexPrompt, type CodexMsg } from "./codex";
import { TransportError } from "./errors";
import { appendTurn } from "./transcript";
import { getActiveAuthModes } from "../llm-auth-store";
import { codexSpawnEnv } from "../codex-auth";

// 既存の import 元（このモジュールから TransportError を import しているテスト等）との互換のため re-export する。
export { TransportError };

/** codex app-server プロセスとの1行JSONメッセージの送受信を抽象化した transport seam。 */
export type AppServerProc = {
  send: (msg: Record<string, unknown>) => void; // 1行JSONとして書き込む
  onMessage: (cb: (msg: Record<string, unknown>) => void) => void;
  onExit: (cb: (code: number | null) => void) => void;
  kill: () => void;
};

export type SpawnAppServer = () => AppServerProc;

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

/** listModels() のページネーション上限。異常に多いページ数（無限ループするサーバ実装など）から
 * 「知らないうちに部分リストを返し続ける」ことを防ぐための安全弁。 */
const MAX_MODEL_LIST_PAGES = 10;

type Pending = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** turn/start に応じて収集する item/completed の agentMessage テキスト（threadId ごとに最後勝ち）。 */
type TurnCollector = {
  threadId: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  lastAgentMessage: string | undefined;
};

/**
 * codex app-server（`codex app-server`）と改行区切り JSON-RPC で対話するクライアント。
 * - 初回 request で lazy に spawn + initialize/initialized ハンドシェイクを行う（並行初回 request は1回のハンドシェイクを共有）
 * - **自己修復設計**: プロセスが exit すると保留中の request/turn を全て reject した上で内部状態（proc/handshake）を
 *   リセットする。プロセスが生きたままハンドシェイクに失敗した場合（initialize の error 応答・timeout）も、
 *   そのプロセスを kill（孤児化防止）して同様に内部状態をリセットする（失敗した handshakePromise を再利用しない）。
 *   いずれも次に `request()` が呼ばれた時点で新プロセスを lazy に再 spawn し、initialize/initialized から
 *   ハンドシェイクをやり直す。バックオフは行わない（呼び出しは常にユーザー起点であり、失敗時は TransportError が
 *   呼び出し元まで伝播して runner 側の exec フォールバックへ自然に間隔があくため）。よって1回の失敗が
 *   インスタンスを永久に汚染することはない。
 * - id 付き result/error は pending request を解決、id 付き method（ServerRequest）は承認/elicitation を decline、
 *   それ以外は空 result で応答する
 * - id なし method（通知）は該当 threadId の runTurn 実行中のみ収集し、それ以外は無視する
 *   （threadId ごとに独立した収集器を持つため、異なる threadId の runTurn は並行実行できる。
 *   同一 threadId での多重 runTurn 呼び出しは拒否する）
 */
export class CodexAppServerClient {
  private readonly spawn: SpawnAppServer;
  private readonly requestTimeoutMs: number;
  private proc: AppServerProc | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private handshakeDone = false;
  private handshakePromise: Promise<void> | undefined;
  private isAlive = true;
  /** プロセス世代。spawn（初回含む）と exit のたびに進む。generation() 参照。 */
  private gen = 0;
  /** threadId ごとの turn 収集器。同一 threadId につき同時に1つのみ、異なる threadId は並行可。 */
  private readonly turnCollectors = new Map<string, TurnCollector>();

  constructor(spawn: SpawnAppServer, opts?: { requestTimeoutMs?: number }) {
    this.spawn = spawn;
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  alive(): boolean {
    return this.isAlive;
  }

  /**
   * 現在のプロセス世代。spawn（初回含む）と exit の**両方**で進むため、記録時と値が違えば
   * 「その記録を作ったプロセスはもう居ない（exit 済み・または再spawnを跨いだ）」ことを意味する。
   * exit 側でも進めるのは、exit 直後〜次の spawn までの dead-window（in-flight なしの自発終了で
   * エラーが誰にも観測されないケース）でも記録が確実に古くなるようにするため。
   * runner がスレッド記憶（threadId → developerInstructions）の鮮度判定に使う。
   * 大域フラグの alive() では「1セッションの復元が再spawnした後、他セッションの古い記憶が
   * 生きているように見える」問題を検出できない（レビュー指摘）。
   */
  generation(): number {
    return this.gen;
  }

  kill(): void {
    this.proc?.kill();
  }

  /** lazy: 初回 request 時に spawn + initialize/initialized ハンドシェイク */
  async request(method: string, params: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    this.ensureStarted();
    if (!this.handshakeDone) {
      await this.ensureHandshake();
    }
    return this.sendRequest(method, params);
  }

  /**
   * モデルカタログ取得（Task 3）用: 常駐プロセスへ `model/list` を投げ、全ページの data を連結して返す。
   * プロトコルのマッピング（CatalogModel への写像）はこのクライアントの責務ではなく呼び出し側
   * （providers/model-catalog.ts）が担う。exec フォールバックは経由しない（呼び出し元が available:false に変換する）。
   *
   * ページネーション（レビュー指摘・binding）: ModelListResponse は nextCursor を返しうる。1ページ目だけ
   * 読んで available:true を返すと、モデル数がページサイズを超えた瞬間に「一部だけなのに全部であるかのように
   * 見せる」— このカタログ機能が防ごうとしている「UI への嘘」そのものになる。nextCursor が string で
   * 存在する限り cursor を渡して追い読みし、全ページの data を連結する。MAX_MODEL_LIST_PAGES を超えても
   * 終端しない場合は「知らないうちに部分リストを返す」よりは失敗を明示する方が安全なため throw する
   * （呼び出し元 providers/model-catalog.ts の makeCodexCatalogFetcher が catch して available:false + reason
   * に変換する。ここでは変換しない — exec フォールバック同様、変換は呼び出し元の責務）。
   */
  async listModels(): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MODEL_LIST_PAGES; page++) {
      const res = await this.request("model/list", cursor !== undefined ? { cursor } : {});
      if (Array.isArray(res.data)) rows.push(...(res.data as Record<string, unknown>[]));
      const next = res.nextCursor;
      if (typeof next !== "string" || next.length === 0) return rows;
      cursor = next;
    }
    throw new Error(`codex model/list: pagination did not terminate within ${MAX_MODEL_LIST_PAGES} pages`);
  }

  /** turn/start を送り、turn/completed まで通知を収集して最終 agentMessage テキストを返す */
  async runTurn(threadId: string, text: string): Promise<string> {
    if (this.turnCollectors.has(threadId)) {
      throw new Error("codex-app-server: runTurn は同一threadIdで同時に1つのみ実行できます");
    }
    const startResult = this.request("turn/start", { threadId, input: [{ type: "text", text }] });
    const collected = new Promise<string>((resolve, reject) => {
      this.turnCollectors.set(threadId, { threadId, resolve, reject, lastAgentMessage: undefined });
    });
    // startResult が先に reject した場合（turn/start 応答前の exit 等）でも collected 自体が
    // 未処理のまま放置されて unhandled rejection にならないよう、ここで一旦 handled にしておく
    // （下の await collected は独立して本来のエラー伝播を担う）。
    collected.catch(() => {});
    try {
      await startResult;
      return await collected;
    } finally {
      this.turnCollectors.delete(threadId);
    }
  }

  private ensureStarted(): void {
    if (this.proc) return;
    let proc: AppServerProc;
    try {
      proc = this.spawn();
    } catch (err) {
      throw new TransportError(`codex app-server spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.proc = proc;
    this.isAlive = true; // 自己修復: 新規spawnした時点でこのインスタンスは新プロセスに対して有効
    this.gen++; // 新世代の開始（初回 spawn も再spawnも）
    // 世代ガード: exit 済み・差し替え済みの旧プロセスから遅延して届くメッセージ/exit は無視する。
    // 特に遅延 ServerRequest は this.proc.send での応答を伴うため、ガード無しでは exit 後に throw する。
    proc.onMessage((msg) => {
      if (this.proc !== proc) return;
      this.handleMessage(msg);
    });
    proc.onExit((code) => {
      if (this.proc !== proc) return;
      this.handleExit(code);
    });
  }

  private ensureHandshake(): Promise<void> {
    if (this.handshakeDone) return Promise.resolve();
    if (!this.handshakePromise) {
      this.handshakePromise = (async () => {
        try {
          await this.sendRequest("initialize", {
            clientInfo: { name: "solo-eikaiwa", title: "solo-eikaiwa", version: "0" },
            capabilities: {},
          });
        } catch (err) {
          // 失敗した handshakePromise を永久にキャッシュしない: プロセスが生きたまま initialize が
          // error 応答/timeout した場合はプロセスを kill して内部状態をリセットし、次の request() が
          // 再spawn + 再ハンドシェイクできるようにする（exit 経由の失敗は handleExit がリセット済みで no-op）。
          this.resetAfterHandshakeFailure();
          // 例外（error応答・exit・timeout）はすべて transport 起因として TransportError に揃える。
          throw err instanceof TransportError
            ? err
            : new TransportError(`codex app-server handshake failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.sendNotification("initialized");
        this.handshakeDone = true;
      })();
    }
    return this.handshakePromise;
  }

  /**
   * ハンドシェイク失敗時の自己回復。exit を経由しない失敗（プロセス生存のままの initialize error 応答・
   * timeout）では handleExit が走らないため、ここで生きているプロセスを kill（孤児化防止）した上で
   * 内部状態をリセットする。先に this.proc を undefined にして世代ガードを外すことで、kill に伴う
   * exit イベントが handleExit を二重実行しないようにする。exit 経由の失敗では handleExit が
   * リセット済み（proc undefined）なので何もしない（二重リセットガード）。
   */
  private resetAfterHandshakeFailure(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    this.isAlive = false;
    this.gen++; // このプロセス世代の終了（handleExit と同じ意味論）
    this.handshakeDone = false;
    this.handshakePromise = undefined;
    proc.kill();
  }

  private sendRequest(method: string, params: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    if (!this.isAlive) {
      return Promise.reject(new TransportError("codex app-server exited"));
    }
    const id = this.nextId++;
    const msg: Record<string, unknown> = { method, id };
    if (params !== undefined) msg.params = params;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TransportError(`codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.send(msg);
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const msg: Record<string, unknown> = { method };
    if (params !== undefined) msg.params = params;
    this.proc!.send(msg);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const id = msg.id;
    const method = msg.method;
    if ((typeof id === "number" || typeof id === "string") && method === undefined) {
      // レスポンス（result/error）
      const pending = this.pending.get(id as number);
      if (!pending) return;
      this.pending.delete(id as number);
      clearTimeout(pending.timer);
      if ("error" in msg) {
        const err = msg.error as Record<string, unknown> | undefined;
        const message = typeof err?.message === "string" ? err.message : JSON.stringify(err);
        pending.reject(new Error(message));
      } else {
        pending.resolve((msg.result as Record<string, unknown>) ?? {});
      }
      return;
    }
    if ((typeof id === "number" || typeof id === "string") && typeof method === "string") {
      // ServerRequest（承認/elicitation など）
      const isApproval = method.includes("requestApproval") || method.includes("elicitation");
      this.proc!.send(isApproval ? { id, result: { decision: "decline" } } : { id, result: {} });
      return;
    }
    if (id === undefined && typeof method === "string") {
      // 通知: runTurn 実行中のみ収集、それ以外は無視
      this.handleNotification(method, msg.params as Record<string, unknown> | undefined);
    }
  }

  private handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    const threadId = params?.threadId;
    if (typeof threadId !== "string") return;
    const collector = this.turnCollectors.get(threadId);
    if (!collector) return;
    if (method === "item/completed") {
      const item = params?.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        collector.lastAgentMessage = item.text;
      }
      return;
    }
    if (method === "turn/completed") {
      const turn = params?.turn as Record<string, unknown> | undefined;
      if (turn?.status === "completed") {
        collector.resolve(collector.lastAgentMessage ?? "");
      } else {
        const error = turn?.error as Record<string, unknown> | undefined;
        const message = typeof error?.message === "string" ? error.message : `turn status: ${String(turn?.status)}`;
        collector.reject(new Error(message));
      }
    }
  }

  private handleExit(code: number | null): void {
    this.isAlive = false;
    this.gen++; // プロセス死亡の時点で世代を進め、dead-window 中でも古い記録が鮮度判定を通らないようにする
    const err = new TransportError(`codex app-server exited (code ${code})`);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
    for (const collector of this.turnCollectors.values()) {
      collector.reject(err);
    }
    this.turnCollectors.clear();
    // 自己修復: 次の request() が新プロセスを lazy に再spawnし、initialize からハンドシェイクをやり直せるように
    // 内部状態をリセットする（このインスタンスを永久に汚染しない）。
    this.proc = undefined;
    this.handshakeDone = false;
    this.handshakePromise = undefined;
  }
}

/** 動作確認済みの codex CLI バージョン。乖離時は警告のみ（動作は継続）。 */
export const TESTED_CODEX_VERSION = "0.142.5";

/**
 * `codex --version` の出力が動作確認済みバージョンと一致するか判定する純関数（単体テスト対象）。
 * 実際の出力は `codex-cli 0.142.5` のように name + version が空白区切りになりうるため、
 * 末尾の空白区切りトークンだけを版として見る。単純な前方一致だと "0.142.5" は "0.142.50" にも
 * マッチしてしまう（別バージョンを誤って一致扱いする）ため、前方一致した残り部分が空文字列
 * または非数字で始まることまで境界チェックする（"0.142.5" のみ一致・"0.142.50" は不一致）。
 */
export function isTestedCodexVersion(actual: string): boolean {
  const token = actual.trim().split(/\s+/).pop() ?? "";
  if (!token.startsWith(TESTED_CODEX_VERSION)) return false;
  const rest = token.slice(TESTED_CODEX_VERSION.length);
  return rest === "" || !/^\d/.test(rest);
}

/** 版チェックはプロセス起動のたびではなく、実プロセスの初回 spawn 時に一度だけ行う（module-level フラグ）。 */
let versionChecked = false;

/**
 * `codex --version` を1回だけ実行し、動作確認済みバージョンと異なれば警告を出す。
 * バージョン取得自体が失敗しても（codex 未インストール等）ここでは無視する
 * — 本体の spawn がすぐ後に続き、そちらで実際の失敗が顕在化するため。
 */
function checkCodexVersionOnce(): void {
  if (versionChecked) return;
  versionChecked = true;
  try {
    const result = Bun.spawnSync(["codex", "--version"]);
    const actual = new TextDecoder().decode(result.stdout).trim();
    if (!isTestedCodexVersion(actual)) {
      console.warn(
        `codex ${actual} はテスト済み ${TESTED_CODEX_VERSION} と異なります（動作は継続・異常時はexecフォールバック）`,
      );
    }
  } catch {
    // 版チェック自体の失敗は無視（本体 spawn で改めて顕在化する）
  }
}

/**
 * 実際に `codex app-server` を起動する transport。stdout を改行区切りで JSON.parse し（失敗行は無視）、
 * stdin へ1行JSONを書き込む。プロセス起動・実IOに依存するため単体テスト対象外
 *（providers/codex.ts の realCodexExec と同じ理由・同じ扱い。CodexAppServerClient は注入した fake transport で検証し、
 * ここは Task 7 の手動スモークで確認する）。
 */
export const realSpawnAppServer: SpawnAppServer = () => {
  checkCodexVersionOnce();
  const env = codexSpawnEnv(getActiveAuthModes().codex);
  const proc = Bun.spawn(["codex", "app-server"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: tmpdir(),
    ...(env ? { env } : {}),
  });

  let onMessage: (msg: Record<string, unknown>) => void = () => {};
  let onExit: (code: number | null) => void = () => {};

  (async () => {
    let buf = "";
    // chunk 境界をまたぐマルチバイト文字（日本語等）を壊さないよう、decoder はループ外で使い回し
    // { stream: true } でチャンク跨ぎの未完了バイト列を内部保持させる。
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          onMessage(JSON.parse(line));
        } catch {
          // 不正な行は無視
        }
      }
    }
  })().catch((err) => {
    // stdout ストリームの異常終了を unhandled rejection にしない（プロセス自体の終了は onExit が扱う）。
    console.warn("codex app-server stdout reader failed:", err);
  });

  proc.exited.then((code) => onExit(code));

  return {
    send: (msg) => {
      proc.stdin.write(JSON.stringify(msg) + "\n");
      proc.stdin.flush();
    },
    onMessage: (cb) => { onMessage = cb; },
    onExit: (cb) => { onExit = cb; },
    kill: () => {
      try {
        proc.stdin.end();
      } catch {
        // すでに閉じている場合は無視
      }
      proc.kill();
    },
  };
};

// ---------------------------------------------------------------------------
// runner 層: ClaudeRunner 適合（sessionId = threadId）
// ---------------------------------------------------------------------------

export type CodexAppServerConfig = {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  defaultSystemPrompt: string;
  spawn?: SpawnAppServer;          // テスト注入。既定 realSpawnAppServer
};

/**
 * thread/start / thread/resume に毎回渡す共通パラメータ。
 * 安全境界はプロトコルレベルで固定する: sandbox=read-only + approvalPolicy=never（config.toml に依存しない）。
 * cwd は中立な tmpdir、system プロンプトは developerInstructions として渡す。
 */
function threadParams(cfg: CodexAppServerConfig, system: string): Record<string, unknown> {
  return {
    ...(cfg.model !== undefined ? { model: cfg.model } : {}),
    ...(cfg.serviceTier !== undefined ? { serviceTier: cfg.serviceTier } : {}),
    sandbox: "read-only",
    approvalPolicy: "never",
    cwd: tmpdir(),
    developerInstructions: system,
    ...(cfg.reasoningEffort !== undefined ? { config: { model_reasoning_effort: cfg.reasoningEffort } } : {}),
  };
}

/**
 * 保険トランスクリプトを新スレッドの初回入力へ畳む。system はスレッド作成時に
 * developerInstructions として渡し済みのため composeCodexPrompt には空文字を渡し、
 * 空の [SYSTEM INSTRUCTIONS] ヘッダ（見出し行 + 空本文の空行）はノイズになるので取り除く。
 * 履歴が空なら素の prompt を返す。
 */
function foldPrompt(history: CodexMsg[], prompt: string): string {
  if (history.length === 0) return prompt;
  return composeCodexPrompt("", history, prompt).replace(/^\[SYSTEM INSTRUCTIONS\]\n+/, "");
}

/**
 * codex app-server を常駐プロセスとして使う ClaudeRunner。セッション解決の階梯（上から順に試す）:
 * 1. 既知の threadId（同一プロセス世代・systemPrompt 一致）→ そのまま turn/start
 * 2. 未知の threadId / 世代が古い threadId（サーバ・プロセス再起動後）→ thread/resume
 *    （ディスク rollout からの復元 = パリティ経路）
 * 3. resume がリクエストレベルで失敗 / systemPrompt が変わった → 新 thread/start + 保険トランスクリプトの畳み込み
 * 4. transport 障害（spawn 失敗・exit・timeout・handshake 失敗 = TransportError）→ 死んだスレッド記憶を
 *    threads.clear() で掃除した上でそのまま rethrow する（この runner 自体はもう exec アダプタへ
 *    フォールバックしない。フォールバックの合成は呼び出し側 llm-provider.ts の selectRunner が
 *    providers/decorators.ts の withFallback を使って行う）。
 * モデル起因の失敗（turn failed・空応答）は TransportError ではないため、withFallback 側でも
 * フォールバック対象にならず、そのまま呼び出し元へ伝播する（exec アダプタと同じ挙動）。
 */
export function makeCodexAppServerRunner(cfg: CodexAppServerConfig): ClaudeRunner {
  return buildRunner(new CodexAppServerClient(cfg.spawn ?? realSpawnAppServer), cfg);
}

/** makeCodexAppServerRunner の本体。client を外部から受け取れるように分離し、registry（下記）が
 * 常駐プロセスを設定キー単位で使い回せるようにする（同じ client を複数回 buildRunner しても
 * 新規プロセスは spawn されない＝ CodexAppServerClient.ensureStarted の lazy 判定に従う）。
 * maps を渡すと threads/transcript もそのまま再利用する（registry 経由の呼び出しが、設定保存の
 * たびの再構築でも保険トランスクリプトをリセットしないようにするため。Fix 1）。省略時（直接
 * makeCodexAppServerRunner を呼ぶ場合）は従来どおり呼び出しごとに空の Map を新規に持つ。
 */
function buildRunner(
  client: CodexAppServerClient,
  cfg: CodexAppServerConfig,
  maps?: { threads: Map<string, { systemPrompt: string; generation: number }>; transcript: Map<string, CodexMsg[]> },
): ClaudeRunner {
  /**
   * sessionId(=threadId) → スレッド作成/復元時に採用した systemPrompt と、その時点のプロセス世代。
   * 世代が client.generation() と一致するエントリだけが「今のプロセスが知っているスレッド」。
   * 大域の alive() 判定では不十分（別セッションの復元が再spawnすると alive() は true に戻り、
   * 新プロセスが知らないスレッドの古い記憶が生きているように見える）ため、エントリごとに世代を持つ。
   */
  const threads = maps?.threads ?? new Map<string, { systemPrompt: string; generation: number }>();
  /** 保険のインメモリ・トランスクリプト（resume 不能時の畳み込み再投入用。exec アダプタの store と同様に保持し続ける）。 */
  const transcript = maps?.transcript ?? new Map<string, CodexMsg[]>();

  async function startThread(system: string): Promise<string> {
    const res = await client.request("thread/start", threadParams(cfg, system));
    const id = (res.thread as Record<string, unknown> | undefined)?.id;
    if (typeof id !== "string" || !id) {
      throw new Error("codex app-server: thread/start が thread.id を返しませんでした");
    }
    threads.set(id, { systemPrompt: system, generation: client.generation() });
    return id;
  }

  /** 旧セッションの履歴を初回入力に畳み込んだ新スレッドを作る（fold）。 */
  async function startFolded(oldId: string, system: string, prompt: string) {
    const history = transcript.get(oldId) ?? [];
    const threadId = await startThread(system);
    // 新スレッドの transcript エントリを旧履歴で先に播種しておく。こうすることで、この後
    // appendTurn(transcript, threadId, ...) が内部で読む transcript.get(threadId) が旧履歴を
    // 引き継いだ状態になり、[...history, 新往復] を書き戻す従来の挙動と一致する
    // （新スレッドIDには当然まだ何も入っていないため、播種しないと旧履歴が失われる）。
    transcript.set(threadId, history);
    return { threadId, turnText: foldPrompt(history, prompt) };
  }

  /** セッション階梯の 1〜3 段目を解決し、turn を打つ先のスレッドと入力テキストを決める。 */
  async function resolveThread(resumeId: string | undefined, system: string, prompt: string):
    Promise<{ threadId: string; turnText: string }> {
    if (!resumeId) {
      return { threadId: await startThread(system), turnText: prompt };
    }
    const known = threads.get(resumeId);
    if (known) {
      if (known.systemPrompt !== system) {
        // developerInstructions はスレッド作成時に固定済みのため、systemPrompt が変わったら新スレッドへ畳み込む
        threads.delete(resumeId);
        return startFolded(resumeId, system, prompt);
      }
      if (known.generation === client.generation()) {
        return { threadId: resumeId, turnText: prompt };
      }
      // 世代が古い = このスレッドを知っているプロセスはもう居ない（自発exitの dead-window、
      // または他セッション起点の再spawn後の残留記憶）。素の turn/start は実サーバでは
      // invalid_request（plain error → fold もフォールバックもされない）で恒久失敗するため、
      // 記憶を捨てて resume 経路で復元する。世代比較は exit でも進むカウンタなので、
      // 「プロセス死亡〜再spawn前」「再spawn後」の両方を1つの判定で包含する（alive() 判定は不要）。
      threads.delete(resumeId);
    }
    try {
      await client.request("thread/resume", { threadId: resumeId, ...threadParams(cfg, system) });
      threads.set(resumeId, { systemPrompt: system, generation: client.generation() });
      return { threadId: resumeId, turnText: prompt };
    } catch (err) {
      if (err instanceof TransportError) throw err; // transport 障害は exec フォールバック判定へ
      // リクエストレベルの resume 失敗（未知スレッド等）→ 新スレッド + 畳み込み（transcript が空なら素の prompt）
      return startFolded(resumeId, system, prompt);
    }
  }

  return async (prompt, resumeId, opts) => {
    const system = opts?.systemPrompt ?? cfg.defaultSystemPrompt;
    try {
      const { threadId, turnText } = await resolveThread(resumeId, system, prompt);
      const text = (await client.runTurn(threadId, turnText)).trim();
      if (!text) throw new Error("Codex returned empty result");
      appendTurn(transcript, threadId, prompt, text);
      return { text, sessionId: threadId };
    } catch (err) {
      if (err instanceof TransportError) {
        // プロセスは死んだ（または起動できなかった）。世代比較でも遅延検出されるが、死んだ記憶を
        // eager に掃除しておく（次の呼び出しは thread/resume＝ディスク復元から入り直す）。
        // transcript は保険として残す。フォールバックの合成はここでは行わない
        // （呼び出し側 selectRunner が withFallback で担う）。
        threads.clear();
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// registry 層: 単一の常駐プロセス（client）を全ロールで共有する（model/reasoningEffort/serviceTier は
// per-thread パラメータへ移行済み・Task 8）
// ---------------------------------------------------------------------------

/**
 * 前提（binding・Task 8 でプロセス1本化）: このレジストリは「単一の正準接続」を1スロットだけ保持する
 * 設計である。model/reasoningEffort/serviceTier は spawn 引数ではなく thread/start・thread/resume の
 * リクエストパラメータであることが判明したため（codex CLI 実測）、これらは connectionKey から外し、
 * 呼び出しごとの cfg として `threadParams()`（下記 buildRunner 内）へ per-thread に反映する形にした。
 * これにより、ロールごとに異なる model/effort/tier を選んでも常駐プロセスは1本のまま共有され続け、
 * 以前あった「ロール解決のたびに connectionKey が入れ替わり旧 client を kill して再spawnする
 * eviction ping-pong」（設定保存のたびに複数ロールを順に再解決する applyLlmRoleSettings の構造に起因）
 * が構造的に解消されている。同一 client を共有する複数ロールの runner は、それぞれが自分の呼び出し時点の
 * cfg（buildRunner のクロージャ引数）を保持するため、同じプロセス上でもスレッドごとに異なる
 * model/effort/tier で thread/start・thread/resume できる（下記の交互切替テスト参照）。
 *
 * connectionKey は現時点では実質定数（区別する接続属性が無い）。Plan B で API キー認証の隔離
 * CODEX_HOME 等、プロセスの起動条件そのものを分ける属性が入れば、その時点で改めてキーに含める。
 */
type CodexAppServerRegistryEntry = {
  key: string;
  client: CodexAppServerClient;
  /** buildRunner の threads/transcript と同じ形。設定保存で registry を再取得しても保険トランスクリプトが
   * リセットされないよう、client と同居させて同一キーである限り使い回す（Fix 1）。 */
  threads: Map<string, { systemPrompt: string; generation: number }>;
  transcript: Map<string, CodexMsg[]>;
};

/** module-level singleton。applyLlmRoleSettings が設定保存のたびに selectRunner → getCodexAppServerRunner
 * を再実行しても、接続設定が変わらない限り既存プロセスを使い回すための唯一の保持場所。 */
let registry: CodexAppServerRegistryEntry | null = null;

/** 接続識別用のキー。Task 8 時点では model/reasoningEffort/serviceTier が per-thread パラメータへ
 * 移行したため接続の同一性には関与せず、区別すべき接続属性が他に無いので実質定数を返す
 * （Plan B で API キー認証の隔離 CODEX_HOME 等が入れば、その時点でキーに含める）。 */
function connectionKey(): string {
  return "default";
}

/**
 * registry の spawn-or-reuse 本体。同一キー（実質定数）である限り、既存の client と threads/transcript
 * （=既に spawn 済みかもしれない常駐プロセスと、そのセッション記憶）をそのまま返す（新規プロセスは
 * spawn されない。Fix 1）。キーが変わった場合（将来 API キー認証の隔離 CODEX_HOME 等が入った場合）や
 * __resetCodexAppServerRegistry() 後だけ、旧 client を kill() して新規の空 Map から作り直す。
 * getCodexAppServerRunner（ClaudeRunner 合成）と getCodexAppServerClient（Task 3: カタログ直接アクセス）
 * の両方がこの唯一の spawn-or-reuse ロジックを共有する。
 */
function ensureRegistryEntry(spawn?: SpawnAppServer): CodexAppServerRegistryEntry {
  const key = connectionKey();
  if (!registry || registry.key !== key) {
    registry?.client.kill();
    registry = {
      key,
      client: new CodexAppServerClient(spawn ?? realSpawnAppServer),
      threads: new Map(),
      transcript: new Map(),
    };
  }
  return registry;
}

/**
 * codex app-server 常駐プロセスを接続単位でデデュープする ClaudeRunner ファクトリ。
 * - 通常呼び出しでは常に同一キー（実質定数）になるため、既存の client と threads/transcript を
 *   そのまま使う新しい runner を返す（設定保存のたびの再解決でも保険トランスクリプトはリセットされない）。
 *   ロールごとに異なる model/reasoningEffort/serviceTier を渡しても、この共有は維持される
 *   （各呼び出しの cfg は buildRunner のクロージャに個別に残るため、thread/start・thread/resume には
 *   呼び出し元の cfg がそのまま per-thread に反映される。プロセス自体は1本のまま＝Task 8）。
 * - defaultSystemPrompt は呼び出しごとの cfg をそのまま使う（値は実運用では固定だが、
 *   仮に変わっても次回呼び出しの runner に反映される）。
 */
export function getCodexAppServerRunner(cfg: CodexAppServerConfig): ClaudeRunner {
  const entry = ensureRegistryEntry(cfg.spawn);
  return buildRunner(entry.client, cfg, { threads: entry.threads, transcript: entry.transcript });
}

/**
 * モデルカタログ取得（Task 3）専用: getCodexAppServerRunner と同じ常駐プロセスをそのまま共有して返す
 * （新規 spawn を増やさない）。runner 合成（withFallback による exec フォールバック）は経由しない直接
 * アクセスのため、呼び出し元（providers/model-catalog.ts）は request 失敗もそのまま available:false へ
 * 変換するだけで、フォールバックの対象にはしない（カタログは app-server 専用というプロダクト仕様）。
 */
export function getCodexAppServerClient(spawn?: SpawnAppServer): CodexAppServerClient {
  return ensureRegistryEntry(spawn).client;
}

/** テスト用: registry をリセットする（現在の client があれば kill してから破棄）。テスト間の分離用。 */
export function __resetCodexAppServerRegistry(): void {
  registry?.client.kill();
  registry = null;
}
