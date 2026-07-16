import { STR, type Lang } from "./i18n";

/** App.tsx の Mode["kind"]（RouteMode + 進行中セッション）。遷移通知とタイトルはこの粒度で更新する。 */
export type ScreenKind =
  | "start" | "free" | "library" | "sentences" | "listening"
  | "placement" | "progress" | "feedback" | "settings" | "session";

const APP_NAME = "solo-eikaiwa";

/** 画面種別の表示名。サイドバー項目は nav 辞書と同一文言、セッションだけ専用の画面名を持つ。 */
export function screenLabel(kind: ScreenKind, lang: Lang): string {
  const nav = STR[lang].nav;
  switch (kind) {
    case "start": return nav.home;
    case "free": return nav.free;
    case "library": return nav.library;
    case "sentences": return nav.sentences;
    case "listening": return nav.listening;
    case "placement": return nav.placement;
    case "progress": return nav.progress;
    case "feedback": return nav.feedback;
    case "settings": return nav.settings;
    case "session": return nav.session;
  }
}

/** ブラウザタブ・履歴一覧で画面を区別できる document.title（#210）。UI言語切替にも追従させる。 */
export function documentTitleFor(kind: ScreenKind, lang: Lang): string {
  return `${screenLabel(kind, lang)} — ${APP_NAME}`;
}

/** live region に書き込む遷移通知文（#210）。 */
export function routeAnnouncement(kind: ScreenKind, lang: Lang): string {
  return STR[lang].routes.moved(screenLabel(kind, lang));
}

/**
 * 遷移通知（読み上げ・フォーカス移動）を行うべきか。
 * 初回表示（previous === null）はブラウザ自身がページ読み込みを伝えるため通知しない。
 * 同一画面内の状態変化（例: 例文タブの切替）でもフォーカスを奪わない。
 */
export function shouldAnnounceRoute(previous: ScreenKind | null, next: ScreenKind): boolean {
  return previous !== null && previous !== next;
}
