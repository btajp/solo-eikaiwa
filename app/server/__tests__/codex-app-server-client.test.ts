import { describe, expect, test } from "bun:test";
import { CodexAppServerClient, type SpawnAppServer } from "../providers/codex-app-server";
import { makeFakeProc } from "./helpers/fake-app-server";

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

  test("turn/start応答前にexitしても未処理rejectionを起こさずrunTurnがTransportErrorでrejectする", async () => {
    const f = makeFakeProc();
    const client = new CodexAppServerClient((() => f.proc) as SpawnAppServer);
    const first = client.request("thread/start", {});
    await Bun.sleep(0);
    f.emit({ id: f.sent[0]!.id, result: {} });
    await Bun.sleep(0);
    f.emit({ id: f.sent[2]!.id, result: { thread: { id: "t-1" } } });
    await first;

    const turn = client.runTurn("t-1", "Hello");
    await Bun.sleep(0); // turn/start は送信済みだが応答はまだ届いていない
    f.exit(1);
    // ここで unhandled rejection が発生していれば bun test 自体がエラーを報告する（テスト成功が証拠）。
    await expect(turn).rejects.toThrow(/exited/);
  });

  test("ハンドシェイク失敗でclientが永久に汚染されず次のrequestで自己修復（再spawn・再ハンドシェイク）する", async () => {
    const fakes: ReturnType<typeof makeFakeProc>[] = [];
    const spawn: SpawnAppServer = () => {
      const f = makeFakeProc();
      fakes.push(f);
      return f.proc;
    };
    const client = new CodexAppServerClient(spawn);

    const first = client.request("thread/start", {});
    await Bun.sleep(0);
    expect(fakes.length).toBe(1);
    fakes[0]!.exit(1); // initialize 応答前にexit → ハンドシェイク失敗
    await expect(first).rejects.toThrow(/exited/);
    expect(client.alive()).toBe(false);

    const second = client.request("thread/start", {});
    await Bun.sleep(0);
    expect(fakes.length).toBe(2); // 自己修復で2回目のspawnが発生する
    expect(fakes[1]!.sent[0]?.method).toBe("initialize"); // 新プロセスで再ハンドシェイク
    fakes[1]!.emit({ id: fakes[1]!.sent[0]!.id, result: {} });
    await Bun.sleep(0);
    expect(fakes[1]!.sent[1]).toEqual({ method: "initialized" });
    expect(fakes[1]!.sent[2]?.method).toBe("thread/start");
    fakes[1]!.emit({ id: fakes[1]!.sent[2]!.id, result: { thread: { id: "t-2" } } });
    expect((await second).thread).toEqual({ id: "t-2" });
    expect(client.alive()).toBe(true);
  });

  test("異なるthreadIdのrunTurnは並行実行でき通知をインターリーブしてもそれぞれ正しく解決する", async () => {
    const f = makeFakeProc();
    const client = new CodexAppServerClient((() => f.proc) as SpawnAppServer);
    const first = client.request("thread/start", {});
    await Bun.sleep(0);
    f.emit({ id: f.sent[0]!.id, result: {} });
    await Bun.sleep(0);
    f.emit({ id: f.sent[2]!.id, result: { thread: { id: "t-1" } } });
    await first;

    const turnA = client.runTurn("t-1", "Hello A");
    await Bun.sleep(0);
    const turnB = client.runTurn("t-2", "Hello B");
    await Bun.sleep(0);

    const turnAReq = f.sent.find(
      (m) => m.method === "turn/start" && (m.params as Record<string, unknown>)?.threadId === "t-1",
    )!;
    const turnBReq = f.sent.find(
      (m) => m.method === "turn/start" && (m.params as Record<string, unknown>)?.threadId === "t-2",
    )!;
    expect(turnAReq).toBeDefined();
    expect(turnBReq).toBeDefined();

    f.emit({ id: turnAReq.id, result: { turn: { id: "turn-a" } } });
    f.emit({ id: turnBReq.id, result: { turn: { id: "turn-b" } } });

    // 通知をインターリーブして届ける（B→A→B→A の順）
    f.emit({ method: "item/completed", params: { threadId: "t-2", item: { type: "agentMessage", id: "ib", text: "Hi B" } } });
    f.emit({ method: "item/completed", params: { threadId: "t-1", item: { type: "agentMessage", id: "ia", text: "Hi A" } } });
    f.emit({ method: "turn/completed", params: { threadId: "t-2", turn: { status: "completed" } } });
    f.emit({ method: "turn/completed", params: { threadId: "t-1", turn: { status: "completed" } } });

    expect(await turnA).toBe("Hi A");
    expect(await turnB).toBe("Hi B");
  });

  test("exit後に届く遅延ServerRequestは無視される（throwも送信もしない）", async () => {
    const f = makeFakeProc();
    const client = new CodexAppServerClient((() => f.proc) as SpawnAppServer);
    const p = client.request("thread/start", {});
    await Bun.sleep(0);
    f.exit(1);
    await expect(p).rejects.toThrow(/exited/);
    const sentBefore = f.sent.length;
    // 死んだプロセスからの遅延 ServerRequest: 世代ガードで無視される（proc.send への応答で throw しない）
    expect(() => f.emit({ id: 7, method: "item/commandExecution/requestApproval", params: {} })).not.toThrow();
    await Bun.sleep(0);
    expect(f.sent.length).toBe(sentBefore);
  });
});
