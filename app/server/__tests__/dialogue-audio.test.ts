import { describe, expect, test } from "bun:test";
import {
  buildDialogueConcatArgs,
  DIALOGUE_SPEAKER_VOICES,
  DIALOGUE_TEMPO_BY_BAND,
  DIALOGUE_TURN_PAD_SEC,
  dialogueBundledCacheKey,
  voiceForSpeaker,
} from "../dialogue-audio";
import { cacheKeyFor, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from "../tts";

describe("dialogue-audio / voiceForSpeaker（#220 話者別voice割当）", () => {
  test("名前の性別ヒントに合うvoiceを割り当てる（話者の順序に依存しない）", () => {
    // Ken が先でも Ken は男声系・Emma は女声系（初出順indexだけで割ると Mark=女声 のような不一致が起きる）
    expect(voiceForSpeaker(["Ken", "Emma"], "Ken")).toBe("onyx");
    expect(voiceForSpeaker(["Ken", "Emma"], "Emma")).toBe("nova");
    expect(voiceForSpeaker(["Mark", "Lucy"], "Mark")).toBe("onyx");
    expect(voiceForSpeaker(["Mark", "Lucy"], "Lucy")).toBe("nova");
  });

  test("同性ペアでも2話者のvoiceは必ず異なる", () => {
    const a = voiceForSpeaker(["Emma", "Lucy"], "Emma");
    const b = voiceForSpeaker(["Emma", "Lucy"], "Lucy");
    expect(a).not.toBe(b);
    const c = voiceForSpeaker(["Ken", "Tom"], "Ken");
    const d = voiceForSpeaker(["Ken", "Tom"], "Tom");
    expect(c).not.toBe(d);
  });

  test("性別ヒントが無い名前でも決定的に異なるvoiceが割り当たる", () => {
    const a = voiceForSpeaker(["Zorp", "Blip"], "Zorp");
    const b = voiceForSpeaker(["Zorp", "Blip"], "Blip");
    expect(a).not.toBe(b);
    expect(voiceForSpeaker(["Zorp", "Blip"], "Zorp")).toBe(a); // 再現性
  });

  test("voice候補はどれも既定voice（alloy・全教材共通）と異なる（単一voice過適応の解消が目的のため）", () => {
    for (const voice of DIALOGUE_SPEAKER_VOICES) {
      expect(voice).not.toBe(DEFAULT_TTS_VOICE);
    }
  });

  test("未知の話者はエラー（voice割当の取り違えを黙って進めない）", () => {
    expect(() => voiceForSpeaker(["Ken", "Emma"], "Bob")).toThrow();
  });
});

describe("dialogue-audio / DIALOGUE_TEMPO_BY_BAND（#194 帯別の話速）", () => {
  test("入門帯は実測約190WPMのTTSを140WPM以下へ落とす倍率（<=0.73）", () => {
    // 実測: 同梱monologue音声の平均話速 ≈ 189-190WPM（#194 の afinfo 集計）。
    // Griffiths (1992) の下位学習者向け閾値に合わせ 190 * tempo <= 140 を保証する。
    expect(190 * DIALOGUE_TEMPO_BY_BAND.beginner).toBeLessThanOrEqual(140);
  });

  test("帯間で単調な速度差（入門 < 中級 < 上級=等倍）", () => {
    expect(DIALOGUE_TEMPO_BY_BAND.beginner).toBeLessThan(DIALOGUE_TEMPO_BY_BAND.intermediate);
    expect(DIALOGUE_TEMPO_BY_BAND.intermediate).toBeLessThan(DIALOGUE_TEMPO_BY_BAND.advanced);
    expect(DIALOGUE_TEMPO_BY_BAND.advanced).toBe(1);
  });
});

describe("dialogue-audio / dialogueBundledCacheKey", () => {
  test("既定model/voice×ラベル抜き結合本文のキー（クライアントが再生時に送る文字列と一致させる契約）", () => {
    const turns = [
      { speaker: "Ken", text: "Hey, do you have a minute?" },
      { speaker: "Emma", text: "Sure, what's up?" },
    ];
    expect(dialogueBundledCacheKey(turns)).toBe(
      cacheKeyFor(DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, "Hey, do you have a minute?\n\nSure, what's up?"),
    );
  });
});

describe("dialogue-audio / buildDialogueConcatArgs（ffmpeg結合コマンドの純ロジック）", () => {
  test("入力順を保ち、ターン間ポーズ（apad）と結合（concat）を含む引数列を作る", () => {
    const args = buildDialogueConcatArgs(["/t/0.mp3", "/t/1.mp3", "/t/2.mp3"], "/t/out.mp3", { tempo: 1, padSec: 0.35 });
    expect(args[0]).toBe("ffmpeg");
    const inputIdxs = args.flatMap((a, i) => (a === "-i" ? [i] : []));
    expect(inputIdxs.map((i) => args[i + 1])).toEqual(["/t/0.mp3", "/t/1.mp3", "/t/2.mp3"]);
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("apad=pad_dur=0.35");
    expect(filter).toContain("concat=n=3:v=0:a=1");
    expect(args[args.length - 1]).toBe("/t/out.mp3");
  });

  test("tempo=1 のときは atempo を挿入しない（上級帯=等倍の音質劣化ゼロ）", () => {
    const args = buildDialogueConcatArgs(["/t/0.mp3"], "/t/out.mp3", { tempo: 1, padSec: DIALOGUE_TURN_PAD_SEC });
    expect(args.join(" ")).not.toContain("atempo");
  });

  test("tempo<1 のときは atempo で聞き取りやすい速度へ落とす（ピッチ保持の時間伸長）", () => {
    const args = buildDialogueConcatArgs(["/t/0.mp3", "/t/1.mp3"], "/t/out.mp3", { tempo: 0.7, padSec: 0.35 });
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("atempo=0.7");
  });

  test("入力0件と atempo の有効範囲(0.5..2)外はエラー", () => {
    expect(() => buildDialogueConcatArgs([], "/t/out.mp3", { tempo: 1, padSec: 0.35 })).toThrow();
    expect(() => buildDialogueConcatArgs(["/t/0.mp3"], "/t/out.mp3", { tempo: 0.4, padSec: 0.35 })).toThrow();
    expect(() => buildDialogueConcatArgs(["/t/0.mp3"], "/t/out.mp3", { tempo: 2.5, padSec: 0.35 })).toThrow();
  });
});
