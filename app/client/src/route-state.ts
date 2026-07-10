/** 再読込しても復元できる、セッション以外の画面状態。進行中セッションは意図的に含めない。 */
export type RouteMode =
  | { kind: "start" }
  | { kind: "free" }
  | { kind: "library" }
  | { kind: "sentences"; tab?: "practice" | "browse" }
  | { kind: "listening" }
  | { kind: "placement" }
  | { kind: "progress" }
  | { kind: "feedback" }
  | { kind: "settings" }
  | { kind: "about" };

export type RouteNotice = "unknown" | "session-not-restored";

export type ParsedRoute = { mode: RouteMode; notice: RouteNotice | null };

const HOME: RouteMode = { kind: "start" };

/** hash router を使うため、静的配信サーバーに任意pathのfallbackを要求しない。 */
export function parseRouteHash(hash: string): ParsedRoute {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  let url: URL;
  try {
    url = new URL(value.startsWith("/") ? value : `/${value}`, "https://routes.invalid");
  } catch {
    return { mode: HOME, notice: "unknown" };
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";
  switch (path) {
    case "/": return { mode: HOME, notice: null };
    case "/free-talk": return { mode: { kind: "free" }, notice: null };
    case "/library": return { mode: { kind: "library" }, notice: null };
    case "/sentences": return {
      mode: { kind: "sentences", tab: url.searchParams.get("tab") === "browse" ? "browse" : "practice" },
      notice: null,
    };
    case "/listening": return { mode: { kind: "listening" }, notice: null };
    case "/placement": return { mode: { kind: "placement" }, notice: null };
    case "/progress": return { mode: { kind: "progress" }, notice: null };
    case "/feedback": return { mode: { kind: "feedback" }, notice: null };
    case "/settings": return { mode: { kind: "settings" }, notice: null };
    case "/about": return { mode: { kind: "about" }, notice: null };
    // セッションIDや途中状態をURLに置かない。再読込で安全に復元できないためHomeへ戻す。
    case "/session": return { mode: HOME, notice: "session-not-restored" };
    default: return { mode: HOME, notice: "unknown" };
  }
}

export function routeHash(mode: RouteMode): string {
  switch (mode.kind) {
    case "start": return "#/";
    case "free": return "#/free-talk";
    case "library": return "#/library";
    case "sentences": return mode.tab === "browse" ? "#/sentences?tab=browse" : "#/sentences";
    case "listening": return "#/listening";
    case "placement": return "#/placement";
    case "progress": return "#/progress";
    case "feedback": return "#/feedback";
    case "settings": return "#/settings";
    case "about": return "#/about";
  }
}
