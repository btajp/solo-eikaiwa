/**
 * 学習サポート設定（サイドバー常設の個別トグル3つ）。
 * localStorage に保存し、変更は購読者（開いている画面）へ通知する。
 * サーバの stage 駆動は「表示既定の供給者」に格下げされ、最終的な表示可否はここで決める。
 * データ（チャンクの ja 等）は常にサーバから届くので、オフ既定の項目でもトグルを オン にすれば見られる。
 */
import { useSyncExternalStore } from "react";

/** 個別トグルの値。null = 「自動」（レベル連動の既定に従う）、true = 常にオン、false = 常にオフ */
export type SupportToggle = boolean | null;

export type SupportSettings = {
  jaHint: SupportToggle;
  modelTalk: SupportToggle;
  cloze: SupportToggle;
};

const STORAGE_KEY = "support";

export const DEFAULT_SUPPORT: SupportSettings = {
  jaHint: null, modelTalk: null, cloze: null,
};

function isToggle(v: unknown): v is SupportToggle {
  return v === null || v === true || v === false;
}

export function loadSupport(): SupportSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SUPPORT };
    // 旧バージョンの preset フィールドが残っていても読み捨てる（個別3フィールドのみ検証する）
    const p = JSON.parse(raw) as Partial<SupportSettings>;
    return {
      jaHint: isToggle(p.jaHint) ? p.jaHint : null,
      modelTalk: isToggle(p.modelTalk) ? p.modelTalk : null,
      cloze: isToggle(p.cloze) ? p.cloze : null,
    };
  } catch {
    return { ...DEFAULT_SUPPORT };
  }
}

let current: SupportSettings = loadSupport();
let listeners: Array<(s: SupportSettings) => void> = [];

/** 現在の設定（同期取得。effect のマウント時初期化に使う） */
export function getSupport(): SupportSettings {
  return current;
}

export function saveSupport(next: SupportSettings): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage 不可（プライベートモード等）でもアプリは続行する
  }
  for (const fn of listeners) fn(next);
}

/** 購読する。戻り値を呼ぶと購読解除される */
export function onSupportChange(fn: (s: SupportSettings) => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((f) => f !== fn); };
}

/** サイドバー・各画面で購読して最新設定に追従する React フック */
export function useSupport(): SupportSettings {
  // onSupportChange(subscribe) は () => void 引数のコールバックとしても呼べる。getSupport は
  // 変更まで同一参照（current）を返すため getSnapshot として安全（再レンダーループを起こさない）。
  return useSyncExternalStore(onSupportChange, getSupport, getSupport);
}

/**
 * 個別トグル → stage 既定 の順で解決した最終ブール。
 * override が非 null ならそれを採用。null なら stage 既定（autoDefault）に従う。
 */
export function resolveSupport(override: SupportToggle, autoDefault: boolean): boolean {
  if (override !== null) return override;
  return autoDefault;
}

/**
 * 準備パックの日本語表示可否。個別トグル → サーバの stage 既定（hintDefault）で解決する。
 * hintDefault の "ja"/"en" 反転ミスを1箇所に封じるための薄いヘルパ。
 */
export function showJaFromPrep(support: SupportSettings, prep: { hintDefault: "ja" | "en" }): boolean {
  return resolveSupport(support.jaHint, prep.hintDefault === "ja");
}
