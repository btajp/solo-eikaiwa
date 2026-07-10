import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  writeContentCandidates,
  writeListeningCandidates,
  type GeneratedContentCandidate,
  type GeneratedListeningCandidate,
} from "../content-gen-markdown";

describe("content generation markdown round-trip gate", () => {
  test("hintの改行で読み戻し結果が変わる候補は、何も書かず拒否する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "content-roundtrip-"));
    const candidate: GeneratedContentCandidate = {
      id: "broken-topic",
      kind: "topic",
      title: "Broken topic",
      titleJa: "壊れたお題",
      domain: "daily",
      level: [1, 2],
      hints: ["First part\n> injected starter"],
    };

    expect(() => writeContentCandidates([candidate], () => dir)).toThrow(/ラウンドトリップ/);
    expect(readdirSync(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("正常なtopic/scenario候補は全フィールド一致後に一括書き込みする", () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "content-roundtrip-topics-"));
    const scenariosDir = mkdtempSync(path.join(tmpdir(), "content-roundtrip-scenarios-"));
    const candidates: GeneratedContentCandidate[] = [
      {
        id: "morning-routine",
        kind: "topic",
        title: "My morning routine",
        titleJa: "朝の日課",
        domain: "daily",
        level: [1, 2],
        hints: ["What I do first — 最初にすること"],
        experienceAnchor: "毎朝の経験から話せる",
        memoryCue: "今日の朝を思い出す",
        commonObjectsOrActions: ["alarm clock", "coffee mug"],
      },
      {
        id: "meeting-room",
        kind: "scenario",
        title: "Booking a meeting room",
        titleJa: "会議室の予約",
        domain: "business",
        level: [3, 4],
        hints: ["You need a room.", "The AI plays a coworker.", "Goal: book the room."],
        starters: ["Can I book this room?", "Is this room free?", "Could you help me?"],
      },
    ];

    const written = writeContentCandidates(
      candidates,
      (candidate) => candidate.kind === "topic" ? topicsDir : scenariosDir,
    );
    expect(written).toHaveLength(2);
    expect(readdirSync(topicsDir)).toEqual(["morning-routine.md"]);
    expect(readdirSync(scenariosDir)).toEqual(["meeting-room.md"]);
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(scenariosDir, { recursive: true, force: true });
  });

  test("listeningもparagraphsを含む全フィールド一致後だけ書き込む", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "listening-roundtrip-"));
    const candidate: GeneratedListeningCandidate = {
      id: "morning-train",
      title: "The morning train",
      titleJa: "朝の電車",
      domain: "daily",
      level: [3, 4],
      paragraphs: ["I'm waiting for my train.", "It's a little late today."],
    };

    expect(writeListeningCandidates([candidate], dir)).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(["morning-train.md"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
