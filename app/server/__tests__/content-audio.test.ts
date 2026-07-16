import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectListeningAudioTargets, collectModelTalkAudioTargets } from "../content-audio";

describe("collectListeningAudioTargets（v0.26 wave5: 音声同梱の対象収集）", () => {
  test("各素材の段落を、ListeningScreen が実際にTTSへ渡す文字列そのまま・出現順で収集する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "listening-audio-"));
    writeFileSync(
      path.join(dir, "a.md"),
      `---\nid: a\ntitle: "A"\ntitle_ja: "エー"\ndomain: daily\nlevel: [1, 3]\n---\n\nFirst paragraph here.\n\nSecond paragraph here.`,
    );
    writeFileSync(
      path.join(dir, "b.md"),
      `---\nid: b\ntitle: "B"\ntitle_ja: "ビー"\ndomain: it\nlevel: [1, 6]\n---\n\nOnly one paragraph.`,
    );
    const targets = collectListeningAudioTargets(dir);
    expect(targets.map((t) => t.text)).toEqual([
      "First paragraph here.", "Second paragraph here.", "Only one paragraph.",
    ]);
    expect(targets[0].source).toBe("listening:a#0");
    expect(targets[1].source).toBe("listening:a#1");
  });

  test("素材が0件のディレクトリは空配列", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "listening-audio-empty-"));
    expect(collectListeningAudioTargets(dir)).toEqual([]);
  });

  test("dialogue素材はスキップする（単一voice一括生成が話者別voiceの同梱キーを先取りしないため — 生成はgenerate-dialogue-audio.tsの担当）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "listening-audio-dialogue-"));
    writeFileSync(
      path.join(dir, "mono.md"),
      `---\nid: mono\ntitle: "Mono"\ntitle_ja: "モノ"\ndomain: daily\nlevel: [1, 3]\n---\n\nA paragraph here.\n\nAnother paragraph.`,
    );
    writeFileSync(
      path.join(dir, "duo.md"),
      `---\nid: duo\ntitle: "Duo"\ntitle_ja: "対話"\ndomain: daily\nlevel: [1, 2]\nformat: dialogue\nspeakers: "Ken, Emma"\n---\n\nKen: Hi, how's it going?\n\nEmma: Pretty good, thanks.`,
    );
    const targets = collectListeningAudioTargets(dir);
    expect(targets.map((t) => t.source)).toEqual(["listening:mono#0", "listening:mono#1"]);
  });
});

describe("collectModelTalkAudioTargets（v0.26 wave5: 音声同梱の対象収集）", () => {
  function writeAsset(dir: string, topicId: string, byStage: Record<string, { modelTalk?: { text: string } }>): void {
    writeFileSync(
      path.join(dir, `${topicId}.json`),
      JSON.stringify({ topicId, sourceHash: "h", promptVersion: "v1", byStage }),
    );
  }

  test("全 topic-assets JSON の modelTalk.text を、ShadowingScreen が実際にTTSへ渡す文字列そのままで収集する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "topic-assets-audio-"));
    writeAsset(dir, "topic-a", {
      "1": { modelTalk: { text: "Model talk for topic-a stage1." } },
      "2": { modelTalk: { text: "Model talk for topic-a stage2." } },
    });
    writeAsset(dir, "topic-b", { "3": { modelTalk: { text: "Model talk for topic-b stage3." } } });
    const targets = collectModelTalkAudioTargets(dir);
    expect(targets.map((t) => t.text).sort()).toEqual([
      "Model talk for topic-a stage1.", "Model talk for topic-a stage2.", "Model talk for topic-b stage3.",
    ]);
    expect(targets.find((t) => t.text.includes("topic-a stage1"))?.source).toBe("model-talk:topic-a#stage1");
  });

  test("modelTalk が無い stage（prepPackのみ）はスキップする", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "topic-assets-audio-noprep-"));
    writeAsset(dir, "topic-c", {
      "1": { modelTalk: { text: "Has a talk." } },
      "2": {},
    });
    const targets = collectModelTalkAudioTargets(dir);
    expect(targets).toHaveLength(1);
    expect(targets[0].text).toBe("Has a talk.");
  });

  test("不正なJSON（検証NG）のファイルは無視して続行する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "topic-assets-audio-broken-"));
    writeFileSync(path.join(dir, "broken.json"), "{ not valid json");
    writeAsset(dir, "topic-ok", { "1": { modelTalk: { text: "OK talk." } } });
    const targets = collectModelTalkAudioTargets(dir);
    expect(targets).toEqual([{ text: "OK talk.", source: "model-talk:topic-ok#stage1" }]);
  });

  test("ディレクトリが存在しなければ空配列", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "topic-assets-audio-parent-"));
    expect(collectModelTalkAudioTargets(path.join(dir, "does-not-exist"))).toEqual([]);
  });
});
