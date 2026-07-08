import type { AppServerProc } from "../../providers/codex-app-server";

/**
 * codex app-server transport の代替フェイク。送信メッセージを記録し（sent）、
 * 応答・通知はテストから emit で手動発火、プロセス終了は exit で発火できる。
 */
export function makeFakeProc() {
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

export type FakeProcHandle = ReturnType<typeof makeFakeProc>;

/**
 * method 別スクリプトで自動応答するフェイク。send された各リクエストに対し、handler が返した
 * メッセージ列（id 付き応答・id なし通知の混在可）を microtask で順に emit する。
 * initialize には既定で `{id, result:{}}` を応答する（handlers の "initialize" で上書き可）。
 * 手動 emit / exit / sent の検査は makeFakeProc と同様に使える。
 */
export function makeScriptedProc(
  handlers: Record<string, (msg: Record<string, unknown>) => Record<string, unknown>[]>,
): FakeProcHandle {
  const f = makeFakeProc();
  const record = f.proc.send;
  f.proc.send = (m) => {
    record(m);
    if (typeof m.method !== "string") return; // ServerRequest への応答等はスクリプト対象外
    const handler = handlers[m.method] ?? (m.method === "initialize" ? initOk : undefined);
    if (!handler) return;
    for (const out of handler(m)) {
      queueMicrotask(() => f.emit(out));
    }
  };
  return f;
}

const initOk = (m: Record<string, unknown>): Record<string, unknown>[] => [{ id: m.id, result: {} }];
