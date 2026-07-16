import { describe, expect, test } from "bun:test";
import {
  canConfirmSpoken,
  confirmSpoken,
  initialShadowingProgress,
  markListened,
  resolveShadowingPlaybackOutcome,
} from "./shadowingPlayback";

describe("resolveShadowingPlaybackOutcome", () => {
  test("最後まで聞けたときは「聞いた」として扱う（有効練習にはしない・#181）", () => {
    expect(resolveShadowingPlaybackOutcome("completed")).toEqual({
      nextState: "ready", listened: true, showRetry: false,
    });
  });

  test("停止時は待機に戻り、失敗案内を出さない", () => {
    expect(resolveShadowingPlaybackOutcome("stopped")).toEqual({
      nextState: "ready", listened: false, showRetry: false,
    });
  });

  test("失敗時はキャッシュ済み音声を再試行できる待機状態に戻す", () => {
    expect(resolveShadowingPlaybackOutcome("failed")).toEqual({
      nextState: "ready", listened: false, showRetry: true,
    });
  });
});

describe("シャドーイングの実施区別（聞いた/声に出した・#181）", () => {
  test("初期状態では自己確認できない（再生完了だけでは有効試行にならない）", () => {
    const progress = initialShadowingProgress();
    expect(progress).toEqual({ listened: false, spokenConfirmed: false });
    expect(canConfirmSpoken(progress)).toBe(false);
    // 聞き終える前の確認操作は無視され、有効試行を発火しない
    expect(confirmSpoken(progress)).toEqual({ progress, firstConfirmation: false });
  });

  test("全編再生後は自己確認でき、初回だけ有効試行として発火する", () => {
    const listened = markListened(initialShadowingProgress());
    expect(listened).toEqual({ listened: true, spokenConfirmed: false });
    expect(canConfirmSpoken(listened)).toBe(true);

    const first = confirmSpoken(listened);
    expect(first.firstConfirmation).toBe(true);
    expect(first.progress).toEqual({ listened: true, spokenConfirmed: true });

    // 2回目の確認は重複発火しない
    const second = confirmSpoken(first.progress);
    expect(second.firstConfirmation).toBe(false);
    expect(second.progress).toEqual(first.progress);
  });

  test("聞いた記録は再確認しても巻き戻らない（追加の全編再生は状態を変えない）", () => {
    const listened = markListened(markListened(initialShadowingProgress()));
    expect(listened).toEqual({ listened: true, spokenConfirmed: false });
    const confirmed = confirmSpoken(listened).progress;
    expect(markListened(confirmed)).toEqual(confirmed);
  });
});
