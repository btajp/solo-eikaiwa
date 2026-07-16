/**
 * 習慣アンカー（if-then の一文）設定フォームの状態遷移（#184）。
 * 読込・編集・保存・失敗・再試行を純ロジックで持ち、UI はこの結果を表示するだけにする。
 * v0.2.0 で撤去された旧UIの反省から、任意・控えめ・個人差の明示を前提にした再導入であり、
 * 通知・ノルマ・警告は持たない（プロダクト制約: 情報的フィードバックのみ）。
 */

/** サーバ側の検証（routes/settings.ts: anchor は200文字以内）と一致させる */
export const ANCHOR_MAX_CHARS = 200;

export type HabitAnchorForm = {
  load: "loading" | "error" | "ready";
  /** サーバに確定済みの一文（空文字 = 未設定） */
  saved: string;
  /** 編集中の一文 */
  draft: string;
  save: "idle" | "saving" | "saved" | "error";
};

export function initialHabitAnchorForm(): HabitAnchorForm {
  return { load: "loading", saved: "", draft: "", save: "idle" };
}

export function anchorLoaded(form: HabitAnchorForm, anchor: string | null | undefined): HabitAnchorForm {
  // 旧DBや異常応答では anchor フィールド自体が無いことがある。未設定(空文字)として扱う。
  const saved = typeof anchor === "string" ? anchor : "";
  return { ...form, load: "ready", saved, draft: saved, save: "idle" };
}

export function anchorLoadFailed(form: HabitAnchorForm): HabitAnchorForm {
  return { ...form, load: "error" };
}

export function retryAnchorLoad(form: HabitAnchorForm): HabitAnchorForm {
  return { ...form, load: "loading" };
}

/** 編集を再開したら保存結果表示（saved/error）は消す。saving 中の編集は呼び出し側で input を無効化する。 */
export function editAnchorDraft(form: HabitAnchorForm, draft: string): HabitAnchorForm {
  return { ...form, draft, save: "idle" };
}

/** 保存時にサーバへ送る値。前後の空白は一文の一部ではないためトリムする。 */
export function savedAnchorText(form: HabitAnchorForm): string {
  return form.draft.trim();
}

export function anchorDirty(form: HabitAnchorForm): boolean {
  return savedAnchorText(form) !== form.saved;
}

export function anchorDraftTooLong(form: HabitAnchorForm): boolean {
  return savedAnchorText(form).length > ANCHOR_MAX_CHARS;
}

export function canSaveAnchor(form: HabitAnchorForm): boolean {
  return form.load === "ready" && form.save !== "saving" && anchorDirty(form) && !anchorDraftTooLong(form);
}

export function beginAnchorSave(form: HabitAnchorForm): HabitAnchorForm {
  return { ...form, save: "saving" };
}

export function anchorSaveSucceeded(form: HabitAnchorForm): HabitAnchorForm {
  const value = savedAnchorText(form);
  return { ...form, saved: value, draft: value, save: "saved" };
}

/** 失敗しても下書きを保持し、同じ内容でそのまま再試行できるようにする。 */
export function anchorSaveFailed(form: HabitAnchorForm): HabitAnchorForm {
  return { ...form, save: "error" };
}
