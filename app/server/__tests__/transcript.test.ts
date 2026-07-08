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
