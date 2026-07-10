import { describe, expect, test } from "bun:test";
import { parseRouteHash, routeHash } from "./route-state";

describe("route-state", () => {
  test("通常画面と例文のBrowseタブをhash URLへ相互変換する", () => {
    expect(parseRouteHash("#/sentences?tab=browse")).toEqual({
      mode: { kind: "sentences", tab: "browse" }, notice: null,
    });
    expect(routeHash({ kind: "sentences", tab: "browse" })).toBe("#/sentences?tab=browse");
    expect(routeHash({ kind: "progress" })).toBe("#/progress");
  });

  test("不明なURLとセッションURLは説明対象を残してHomeへ戻す", () => {
    expect(parseRouteHash("#/not-a-screen")).toEqual({ mode: { kind: "start" }, notice: "unknown" });
    expect(parseRouteHash("#/session")).toEqual({ mode: { kind: "start" }, notice: "session-not-restored" });
  });
});
