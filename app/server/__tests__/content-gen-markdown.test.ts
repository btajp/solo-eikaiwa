import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dialogueListeningToMarkdown,
  writeContentCandidates,
  writeDialogueListeningCandidates,
  writeListeningCandidates,
  type GeneratedContentCandidate,
  type GeneratedDialogueListeningCandidate,
  type GeneratedListeningCandidate,
} from "../content-gen-markdown";
import { parseListeningFile } from "../listening";

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

describe("dialogue listening markdown round-trip gate（#220）", () => {
  const candidate: GeneratedDialogueListeningCandidate = {
    id: "printer-trouble",
    title: "Printer Trouble",
    titleJa: "プリンターの不調",
    domain: "business",
    level: [1, 2],
    speakers: ["Ken", "Emma"],
    turns: [
      { speaker: "Ken", text: "Hey Emma, the printer's not working again." },
      { speaker: "Emma", text: "Oh no. Did you check the paper tray?" },
      { speaker: "Ken", text: "Yeah, it's full. I don't get it." },
      { speaker: "Emma", text: "Let's restart it, then." },
    ],
  };

  test("serialize → parseListeningFile の round-trip で format/speakers/turns が一致する", () => {
    const md = dialogueListeningToMarkdown(candidate);
    const parsed = parseListeningFile(md)!;
    expect(parsed.format).toBe("dialogue");
    expect(parsed.id).toBe("printer-trouble");
    expect(parsed.speakers).toEqual(["Ken", "Emma"]);
    expect(parsed.turns).toEqual(candidate.turns);
    expect(parsed.domain).toBe("business");
    expect(parsed.level).toEqual([1, 2]);
  });

  test("round-trip一致後だけ一括書き込みする", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dialogue-roundtrip-"));
    expect(writeDialogueListeningCandidates([candidate], dir)).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(["printer-trouble.md"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("段落分割を壊すターン（空行入りテキスト）は何も書かず拒否する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dialogue-roundtrip-broken-"));
    const broken: GeneratedDialogueListeningCandidate = {
      ...candidate,
      id: "broken-dialogue",
      turns: [
        { speaker: "Ken", text: "First line.\n\nSecond paragraph without a label." },
        { speaker: "Emma", text: "Sure." },
      ],
    };
    expect(() => writeDialogueListeningCandidates([broken], dir)).toThrow(/ラウンドトリップ/);
    expect(readdirSync(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
