import { describe, expect, test } from "bun:test";
import {
  ANCHOR_MAX_CHARS,
  anchorDirty,
  anchorDraftTooLong,
  anchorLoadFailed,
  anchorLoaded,
  anchorSaveFailed,
  anchorSaveSucceeded,
  beginAnchorSave,
  canSaveAnchor,
  editAnchorDraft,
  initialHabitAnchorForm,
  retryAnchorLoad,
  savedAnchorText,
} from "./habit-anchor-form";

describe("習慣アンカー設定フォーム（#184）", () => {
  test("読込: 初期状態は loading、成功で保存値と下書きが揃う", () => {
    const initial = initialHabitAnchorForm();
    expect(initial.load).toBe("loading");
    const loaded = anchorLoaded(initial, "朝コーヒーを淹れたら、その直後に英会話を始める");
    expect(loaded.load).toBe("ready");
    expect(loaded.saved).toBe("朝コーヒーを淹れたら、その直後に英会話を始める");
    expect(loaded.draft).toBe(loaded.saved);
    expect(anchorDirty(loaded)).toBe(false);
    expect(canSaveAnchor(loaded)).toBe(false);
  });

  test("読込失敗: error になり、再試行で loading へ戻る", () => {
    const failed = anchorLoadFailed(initialHabitAnchorForm());
    expect(failed.load).toBe("error");
    expect(retryAnchorLoad(failed).load).toBe("loading");
  });

  test("編集: 下書きだけ変わり、変更があれば保存できる", () => {
    const loaded = anchorLoaded(initialHabitAnchorForm(), "");
    const edited = editAnchorDraft(loaded, "歯を磨いたら、その直後に英会話を始める");
    expect(edited.saved).toBe("");
    expect(anchorDirty(edited)).toBe(true);
    expect(canSaveAnchor(edited)).toBe(true);
    // 前後の空白だけの違いは変更として扱わない
    expect(anchorDirty(editAnchorDraft(loaded, "  "))).toBe(false);
  });

  test("上限超過はサーバ制限と同じ200文字で保存不可", () => {
    expect(ANCHOR_MAX_CHARS).toBe(200);
    const loaded = anchorLoaded(initialHabitAnchorForm(), "");
    const long = editAnchorDraft(loaded, "あ".repeat(ANCHOR_MAX_CHARS + 1));
    expect(anchorDraftTooLong(long)).toBe(true);
    expect(canSaveAnchor(long)).toBe(false);
    const max = editAnchorDraft(loaded, "a".repeat(ANCHOR_MAX_CHARS));
    expect(anchorDraftTooLong(max)).toBe(false);
    expect(canSaveAnchor(max)).toBe(true);
  });

  test("保存: saving 中は再送不可、成功で保存値が確定して saved 表示", () => {
    const edited = editAnchorDraft(anchorLoaded(initialHabitAnchorForm(), ""), " 朝コーヒーを淹れたら、その直後に英会話を始める ");
    const saving = beginAnchorSave(edited);
    expect(saving.save).toBe("saving");
    expect(canSaveAnchor(saving)).toBe(false);
    // 送信値は前後空白をトリムした一文
    expect(savedAnchorText(saving)).toBe("朝コーヒーを淹れたら、その直後に英会話を始める");
    const saved = anchorSaveSucceeded(saving);
    expect(saved.save).toBe("saved");
    expect(saved.saved).toBe("朝コーヒーを淹れたら、その直後に英会話を始める");
    expect(anchorDirty(saved)).toBe(false);
  });

  test("保存失敗: 下書きを保持したまま error になり、そのまま再試行できる", () => {
    const edited = editAnchorDraft(anchorLoaded(initialHabitAnchorForm(), "旧アンカー"), "新アンカー");
    const failed = anchorSaveFailed(beginAnchorSave(edited));
    expect(failed.save).toBe("error");
    expect(failed.draft).toBe("新アンカー");
    expect(failed.saved).toBe("旧アンカー");
    expect(canSaveAnchor(failed)).toBe(true);
    // 再試行 → 成功
    const retried = anchorSaveSucceeded(beginAnchorSave(failed));
    expect(retried.saved).toBe("新アンカー");
  });

  test("編集を再開すると保存結果表示（saved/error）は消える", () => {
    const saved = anchorSaveSucceeded(beginAnchorSave(editAnchorDraft(anchorLoaded(initialHabitAnchorForm(), ""), "x")));
    expect(editAnchorDraft(saved, "xy").save).toBe("idle");
  });

  test("空欄で保存すると表示をやめられる（データ削除ではなく表示制御）", () => {
    const cleared = editAnchorDraft(anchorLoaded(initialHabitAnchorForm(), "旧アンカー"), "");
    expect(canSaveAnchor(cleared)).toBe(true);
    const saved = anchorSaveSucceeded(beginAnchorSave(cleared));
    expect(saved.saved).toBe("");
  });
});

describe("anchorLoaded の入力正規化", () => {
  test("設定応答にanchorが無い(undefined)場合も空文字として扱い、後続の判定が落ちない", () => {
    const form = anchorLoaded(initialHabitAnchorForm(), undefined);
    expect(form.load).toBe("ready");
    expect(savedAnchorText(form)).toBe("");
    expect(anchorDraftTooLong(form)).toBe(false);
  });

  test("anchorがnullでも同様に空文字として扱う", () => {
    const form = anchorLoaded(initialHabitAnchorForm(), null);
    expect(savedAnchorText(form)).toBe("");
  });
});
