import { tmpdir } from "node:os";

/** transport 層（spawn/handshake/exit/timeout）で発生したエラー。モデル起因のエラー（turn failed 等）とは区別するために使う。 */
export class TransportError extends Error {}

/** codex app-server プロセスとの1行JSONメッセージの送受信を抽象化した transport seam。 */
export type AppServerProc = {
  send: (msg: Record<string, unknown>) => void; // 1行JSONとして書き込む
  onMessage: (cb: (msg: Record<string, unknown>) => void) => void;
  onExit: (cb: (code: number | null) => void) => void;
  kill: () => void;
};

export type SpawnAppServer = () => AppServerProc;

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

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
 * - id 付き result/error は pending request を解決、id 付き method（ServerRequest）は承認/elicitation を decline、
 *   それ以外は空 result で応答する
 * - id なし method（通知）は runTurn 実行中のみ収集し、それ以外は無視する
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
  private turnCollector: TurnCollector | undefined;

  constructor(spawn: SpawnAppServer, opts?: { requestTimeoutMs?: number }) {
    this.spawn = spawn;
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  alive(): boolean {
    return this.isAlive;
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

  /** turn/start を送り、turn/completed まで通知を収集して最終 agentMessage テキストを返す */
  async runTurn(threadId: string, text: string): Promise<string> {
    if (this.turnCollector) {
      throw new Error("codex-app-server: runTurn は同時に1つのみ実行できます");
    }
    const startResult = this.request("turn/start", { threadId, input: [{ type: "text", text }] });
    const collected = new Promise<string>((resolve, reject) => {
      this.turnCollector = { threadId, resolve, reject, lastAgentMessage: undefined };
    });
    try {
      await startResult;
      return await collected;
    } finally {
      this.turnCollector = undefined;
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
    proc.onMessage((msg) => this.handleMessage(msg));
    proc.onExit((code) => this.handleExit(code));
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
    const collector = this.turnCollector;
    if (!collector) return;
    if (method === "item/completed") {
      const item = params?.item as Record<string, unknown> | undefined;
      const threadId = params?.threadId;
      if (threadId === collector.threadId && item?.type === "agentMessage" && typeof item.text === "string") {
        collector.lastAgentMessage = item.text;
      }
      return;
    }
    if (method === "turn/completed") {
      const threadId = params?.threadId;
      if (threadId !== collector.threadId) return;
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
    const err = new TransportError(`codex app-server exited (code ${code})`);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
    this.turnCollector?.reject(err);
    this.turnCollector = undefined;
  }
}

/**
 * 実際に `codex app-server` を起動する transport。stdout を改行区切りで JSON.parse し（失敗行は無視）、
 * stdin へ1行JSONを書き込む。プロセス起動・実IOに依存するため単体テスト対象外
 *（providers/codex.ts の realCodexExec と同じ理由・同じ扱い。CodexAppServerClient は注入した fake transport で検証し、
 * ここは Task 7 の手動スモークで確認する）。
 */
export const realSpawnAppServer: SpawnAppServer = () => {
  const proc = Bun.spawn(["codex", "app-server"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: tmpdir(),
  });

  let onMessage: (msg: Record<string, unknown>) => void = () => {};
  let onExit: (code: number | null) => void = () => {};

  (async () => {
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += new TextDecoder().decode(chunk);
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
  })();

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
