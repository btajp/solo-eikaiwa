import { describe, expect, test } from "bun:test";
import { STR } from "./i18n";

describe("設定と練習画面の用語", () => {
  test("歯抜け表示の設定と画面操作を同じ語系にする", () => {
    expect(STR.en.support.cloze).toBe("Start with gaps");
    expect(STR.en.support.helpCloze).toContain("starts with gaps");
    expect(STR.en.sentences.showCloze).toBe("Show gaps");
    expect(STR.en.warmup.clozeStepTitle).toContain("gaps");
    expect(STR.ja.support.cloze).toBe("歯抜けで開始");
    expect(STR.ja.support.helpCloze).toContain("歯抜け表示");
    expect(STR.ja.support.helpCloze).not.toContain("穴埋め");
    expect(STR.ja.sentences.showCloze).toBe("歯抜けを表示");
    expect(STR.ja.warmup.clozeStepTitle).toContain("歯抜け");
  });
});

describe("フィードバックと設定の意味", () => {
  test("日本語の難易度フィードバックは行き過ぎを明示する", () => {
    const expected = { hard: "難しすぎた", "just-right": "ちょうどよかった", easy: "簡単すぎた" };
    expect(STR.ja.feedbackRow.hard).toBe(expected.hard);
    expect(STR.ja.feedbackRow.justRight).toBe(expected["just-right"]);
    expect(STR.ja.feedbackRow.easy).toBe(expected.easy);
    expect(STR.ja.feedbackScreen.rating).toEqual(expected);
  });

  test("設定注記・配信・effortの表記を実画面と両言語で揃える", () => {
    expect(STR.en.settings.claudeGlobalModelNote).toContain(STR.en.settings.roleAssignSection);
    expect(STR.en.settings.tuningEffort).toContain("thinking depth");
    expect(STR.en.settings.tuningTierFast).toContain("priority delivery");
    expect(STR.en.settings.tuningTierStandard).toContain("cheaper");
    expect(STR.en.settings.roleReason.assessment).toContain("Standard delivery");
    expect(STR.ja.settings.tuningEffort).toContain("思考の深さ");
    expect(STR.ja.settings.tuningTierFast).toContain("優先配信");
    expect(STR.ja.settings.tuningTierStandard).toContain("安価");
    expect(STR.ja.settings.roleReason.assessment).toContain("Standard 配信");
  });

  test("練習の感想とコーチからのヒントを別の名称で案内する", () => {
    expect(STR.en.nav.feedback).toBe(STR.en.feedbackScreen.title);
    expect(STR.en.ftt432.aeTitle).toContain("Coach notes");
    expect(STR.en.ftt432.prepMicNote).toContain("coach notes");
    expect(STR.en.feedbackRow.target["free-talk"]).toContain("free-talk");
    expect(STR.ja.nav.feedback).toBe(STR.ja.feedbackScreen.title);
    expect(STR.ja.ftt432.aeTitle).toContain("コーチからのヒント");
    expect(STR.ja.ftt432.prepMicNote).toContain("コーチからのヒント");
    expect(STR.ja.feedbackRow.target["free-talk"]).toContain("自由会話");
  });
});

describe("画面導線と学習素材の呼称", () => {
  test("ホームへの戻り先とレベル測定の取消を別の文言にする", () => {
    expect(STR.en.appShell.backToHome).toBe("← Back to home");
    expect(STR.ja.appShell.backToHome).toBe("← ホームに戻る");
    expect(STR.en.placement.cancel).toBe("Cancel");
    expect(STR.ja.placement.cancel).toBe("キャンセル");
    expect(STR.en.placement.notNow).not.toBe(STR.en.placement.cancel);
    expect(STR.ja.placement.notNow).not.toBe(STR.ja.placement.cancel);
  });

  test("レベル測定はStageとLvの役割、入力条件、反映時点を両言語で示す", () => {
    expect(STR.en.placement.stageLevelNote(2, 13)).toContain("Stage 2");
    expect(STR.en.placement.stageLevelNote(2, 13)).toContain("Lv 13");
    expect(STR.en.placement.chooseInputHelp).toContain("1 to 999");
    expect(STR.en.placement.applyTiming).toContain("next practice");
    expect(STR.en.placement.levelApplied(13)).toContain("Lv 13");
    expect(STR.ja.placement.stageLevelNote(2, 13)).toContain("ステージ2");
    expect(STR.ja.placement.stageLevelNote(2, 13)).toContain("Lv13");
    expect(STR.ja.placement.chooseInputHelp).toContain("1〜999");
    expect(STR.ja.placement.applyTiming).toContain("次の練習");
    expect(STR.ja.placement.levelApplied(13)).toContain("Lv13");
  });

  test("レベル測定の読み込みと再試行は両言語でテキストとして示す", () => {
    expect(STR.en.placement.loading).toContain("Loading");
    expect(STR.en.placement.loadRetry).toBe("Retry");
    expect(STR.ja.placement.loading).toContain("読み込んで");
    expect(STR.ja.placement.loadRetry).toBe("再試行");
  });

  test("モデルトークとリスニングはナビ・画面・記録で対応する名称にする", () => {
    expect(STR.en.nav.library).toBe(STR.en.library.title);
    expect(STR.ja.nav.library).toBe(STR.ja.library.title);
    expect(STR.ja.nav.listening).toContain(STR.ja.listeningScreen.title);
    expect(STR.ja.llmNotice.body).toContain(STR.ja.listeningScreen.title);
    expect(STR.ja.feedbackScreen.block.listening).toBe(STR.ja.listeningScreen.title);
    expect(STR.ja.nav.selfStudyHint).toContain(STR.ja.listeningScreen.title);
  });

  test("収集フレーズと準備フレーズを概念ごとに一貫して呼ぶ", () => {
    expect(STR.en.sentences.chunkLabel).toBe("Your phrase");
    expect(STR.en.sentences.myChunks).toContain("My phrases");
    expect(STR.ja.sentences.chunkLabel).toBe("あなたのフレーズ");
    expect(STR.ja.sentences.myChunks).toContain("マイフレーズ");
    expect(STR.en.support.helpJaHint).toContain("practice phrases");
    expect(STR.ja.support.helpJaHint).toContain("練習フレーズ");
    expect(STR.ja.warmup.loading).toContain("準備フレーズ");
    expect(STR.ja.ftt432.roundChunksToggle).toBe("準備フレーズ");
  });
});
