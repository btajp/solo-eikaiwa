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
