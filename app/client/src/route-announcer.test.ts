import { describe, expect, test } from "bun:test";
import { documentTitleFor, routeAnnouncement, screenLabel, shouldAnnounceRoute, type ScreenKind } from "./route-announcer";

describe("route-announcer", () => {
  test("document.title は画面名 + アプリ名になり、UI言語に追従する", () => {
    expect(documentTitleFor("start", "en")).toBe("Home — solo-eikaiwa");
    expect(documentTitleFor("start", "ja")).toBe("ホーム — solo-eikaiwa");
    expect(documentTitleFor("settings", "en")).toBe("Settings — solo-eikaiwa");
    expect(documentTitleFor("settings", "ja")).toBe("設定 — solo-eikaiwa");
    expect(documentTitleFor("session", "en")).toBe("Practice session — solo-eikaiwa");
    expect(documentTitleFor("session", "ja")).toBe("練習セッション — solo-eikaiwa");
  });

  test("全画面種別が両言語で空でない画面名を持つ", () => {
    const kinds: ScreenKind[] = [
      "start", "free", "library", "sentences", "listening",
      "placement", "progress", "feedback", "settings", "session",
    ];
    for (const kind of kinds) {
      expect(screenLabel(kind, "en").length).toBeGreaterThan(0);
      expect(screenLabel(kind, "ja").length).toBeGreaterThan(0);
    }
  });

  test("遷移通知文は画面名を含む", () => {
    expect(routeAnnouncement("progress", "en")).toBe("Moved to Progress.");
    expect(routeAnnouncement("progress", "ja")).toBe("進捗に移動しました。");
  });

  test("初回表示と同一画面内の変化では通知せず、画面が変わったときだけ通知する", () => {
    expect(shouldAnnounceRoute(null, "start")).toBe(false);
    expect(shouldAnnounceRoute("sentences", "sentences")).toBe(false);
    expect(shouldAnnounceRoute("start", "settings")).toBe(true);
    expect(shouldAnnounceRoute("settings", "start")).toBe(true);
  });
});
