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

  test("設定タブはdeep linkで直接開け、既定は学習者向けの表示タブになる", () => {
    expect(parseRouteHash("#/settings")).toEqual({ mode: { kind: "settings", tab: "display" }, notice: null });
    expect(parseRouteHash("#/settings?tab=keys")).toEqual({ mode: { kind: "settings", tab: "keys" }, notice: null });
    expect(parseRouteHash("#/settings?tab=conn")).toEqual({ mode: { kind: "settings", tab: "conn" }, notice: null });
    expect(parseRouteHash("#/settings?tab=roles")).toEqual({ mode: { kind: "settings", tab: "roles" }, notice: null });
    expect(parseRouteHash("#/settings?tab=unknown")).toEqual({ mode: { kind: "settings", tab: "display" }, notice: null });
    expect(routeHash({ kind: "settings" })).toBe("#/settings");
    expect(routeHash({ kind: "settings", tab: "display" })).toBe("#/settings");
    expect(routeHash({ kind: "settings", tab: "keys" })).toBe("#/settings?tab=keys");
  });

  test("不明なURLとセッションURLは説明対象を残してHomeへ戻す", () => {
    expect(parseRouteHash("#/not-a-screen")).toEqual({ mode: { kind: "start" }, notice: "unknown" });
    expect(parseRouteHash("#/about")).toEqual({ mode: { kind: "start" }, notice: "unknown" });
    expect(parseRouteHash("#/session")).toEqual({ mode: { kind: "start" }, notice: "session-not-restored" });
  });
});
