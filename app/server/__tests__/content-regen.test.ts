import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadContent, parseContentFile } from "../content";
import type { ClaudeRunner } from "../converse";
import {
  findNearDuplicateSentencePairs,
  genRegenTopics,
  genReplaceSentences,
  validateRegenTopicCandidate,
  validateReplacementSentence,
} from "../content-gen";
import { contentToMarkdown } from "../content-gen-markdown";
import { loadBundledExplanations, loadSentences, type Sentence } from "../sentences";

/** 呼び出し順にレスポンスを返す fake ClaudeRunner（実Claude呼び出し・実content/への書き込みは一切しない） */
function makeRunner(responses: string[]): ClaudeRunner {
  let i = 0;
  return async () => {
    const text = responses[Math.min(i, responses.length - 1)];
    i++;
    return { text, sessionId: "fake" };
  };
}

// #219 の実データ準重複ペアと同型のフィクスチャ（カテゴリをまたいだ準重複: #171(15)≒#332(26)と同じ構造）
const PAIR_KEEP: Sentence = {
  no: 171, category_no: 15, category: "疑問文・間接疑問", domain: "daily",
  en: "Would you mind watering the plants while I'm away?", ja: "留守の間、植物に水をあげてもらえますか？", note: "",
};
const PAIR_REPLACE: Sentence = {
  no: 332, category_no: 26, category: "会話機能: 依頼する", domain: "daily",
  en: "Would you mind watering my plants while I'm away?", ja: "留守の間、植物に水をあげてもらえませんか。", note: "",
  band: "development",
};
const OTHER: Sentence = {
  no: 5, category_no: 2, category: "過去形", domain: "it",
  en: "The server went down last night.", ja: "昨夜サーバが落ちた", note: "",
};

describe("content-gen / validateReplacementSentence（#219: 指定noの差し替え検証）", () => {
  const others = [PAIR_KEEP, OTHER];

  test("正常系: no/category_no/category/band を原文から引き継ぎ、trim して返す", () => {
    const out = validateReplacementSentence(
      { domain: "daily", en: " Could you feed my cat this weekend? It's easy. ", ja: " 今週末うちの猫にごはんをあげてくれない？ ", note: " 依頼 " },
      PAIR_REPLACE, others,
    )!;
    expect(out.no).toBe(332);
    expect(out.category_no).toBe(26);
    expect(out.category).toBe("会話機能: 依頼する");
    expect(out.band).toBe("development");
    expect(out.en).toBe("Could you feed my cat this weekend? It's easy.");
    expect(out.ja).toBe("今週末うちの猫にごはんをあげてくれない？");
    expect(out.note).toBe("依頼");
  });

  test("band の無い原文の差し替えは band を付けない", () => {
    const original: Sentence = { ...OTHER, no: 260 };
    const out = validateReplacementSentence(
      { domain: "it", en: "The deploy script failed again this morning, didn't it?", ja: "また朝からデプロイが失敗したよね？", note: "付加疑問" },
      original, [PAIR_KEEP],
    )!;
    expect(out.band).toBeUndefined();
    expect(out.no).toBe(260);
  });

  test("domain が原文と異なる候補は不採用（スロットのdomain分布を維持する）", () => {
    expect(validateReplacementSentence(
      { domain: "business", en: "Could you feed my cat this weekend? It's easy.", ja: "訳", note: "" },
      PAIR_REPLACE, others,
    )).toBeNull();
  });

  test("残存する他の文（別カテゴリのペア相手を含む）と正規化トークンJaccard>=0.8 なら不採用", () => {
    // ペア相手 #171 は別カテゴリだが others に含まれるため、原文とほぼ同じ文は拒否される
    expect(validateReplacementSentence(
      { domain: "daily", en: "Would you mind watering my plants while I'm away?", ja: "訳", note: "" },
      PAIR_REPLACE, others,
    )).toBeNull();
  });

  test("原文と正規化後に完全一致する候補は不採用（差し替えの意味がない）", () => {
    const original: Sentence = { ...OTHER, no: 9 };
    expect(validateReplacementSentence(
      { domain: "it", en: "The server went down last night!", ja: "訳", note: "" },
      original, [],
    )).toBeNull();
  });

  test("band 付き原文の差し替えは書き言葉語彙・帯別語数上限もゲートする", () => {
    // development の語数上限16語を超える文
    const tooLong = "Could you possibly help me carry all of these heavy boxes up to the third floor today?";
    expect(validateReplacementSentence(
      { domain: "daily", en: tooLong, ja: "訳", note: "" }, PAIR_REPLACE, others,
    )).toBeNull();
    // 書き言葉語彙（furthermore）を含む文
    expect(validateReplacementSentence(
      { domain: "daily", en: "Furthermore, could you water my garden?", ja: "訳", note: "" }, PAIR_REPLACE, others,
    )).toBeNull();
  });

  test("空 en / 空 ja / 不正 domain は不採用", () => {
    expect(validateReplacementSentence({ domain: "daily", en: "  ", ja: "訳", note: "" }, PAIR_REPLACE, others)).toBeNull();
    expect(validateReplacementSentence({ domain: "daily", en: "Could you help me out?", ja: " ", note: "" }, PAIR_REPLACE, others)).toBeNull();
    expect(validateReplacementSentence({ domain: "casual", en: "Could you help me out?", ja: "訳", note: "" }, PAIR_REPLACE, others)).toBeNull();
  });
});

describe("content-gen / findNearDuplicateSentencePairs（#219: 全文ペアの近似重複検出）", () => {
  test("Jaccard>=0.8 のペアだけを no の組で返す", () => {
    const pairs = findNearDuplicateSentencePairs([PAIR_KEEP, PAIR_REPLACE, OTHER]);
    expect(pairs).toEqual([[171, 332]]);
  });

  test("準重複が無ければ空配列", () => {
    expect(findNearDuplicateSentencePairs([PAIR_KEEP, OTHER])).toEqual([]);
  });

  test("実在の同梱例文 全390文で Jaccard>=0.8 のペアが0組（#219受け入れ条件）", () => {
    const sentences = loadSentences();
    expect(sentences.length).toBeGreaterThanOrEqual(390);
    expect(findNearDuplicateSentencePairs(sentences)).toEqual([]);
  });
});

type ReplaceFixture = { dir: string; file: string; explanationsFile: string };

function setupReplaceFixture(sentences: Sentence[]): ReplaceFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "regen-sent-"));
  const file = path.join(dir, "sentences.json");
  writeFileSync(file, JSON.stringify(sentences, null, 2) + "\n");
  const explanationsFile = path.join(dir, "explanations.json");
  writeFileSync(
    explanationsFile,
    JSON.stringify(sentences.map((s) => ({ no: s.no, text: `解説${s.no}` })), null, 2) + "\n",
  );
  return { dir, file, explanationsFile };
}

/** development帯の集計（checkSpokenRegister）をPASSさせるための短縮形入り band 文 */
const BAND_FILLER: Sentence = {
  no: 400, category_no: 27, category: "会話機能: 断る", domain: "business",
  en: "I'm sorry, but I can't make it today.", ja: "すみません、今日は無理です。", note: "",
  band: "development",
};

const REPLACEMENT_332 = JSON.stringify({
  sentences: [{ domain: "daily", en: "Could you feed my cat this weekend? It's easy.", ja: "今週末うちの猫にごはんをあげてくれない？", note: "依頼" }],
});
const REPLACEMENT_260 = JSON.stringify({
  sentences: [{ domain: "it", en: "The deploy script failed again this morning, didn't it?", ja: "また朝からデプロイが失敗したよね？", note: "付加疑問" }],
});

describe("content-gen / genReplaceSentences（#219: 準重複解消の正規再生成経路）", () => {
  test("正常系: 指定noだけを同じ位置・同じnoで差し替え、解説の陳腐化分を除去する", async () => {
    const original260: Sentence = { ...OTHER, no: 260 };
    const { dir, file, explanationsFile } = setupReplaceFixture([PAIR_KEEP, original260, PAIR_REPLACE, BAND_FILLER]);
    const logs: string[] = [];
    await genReplaceSentences({
      runner: makeRunner([REPLACEMENT_332, REPLACEMENT_260]),
      sentencesFile: file, explanationsFile, nos: [332, 260], stage: 3, dry: false, log: (s) => logs.push(s),
    });
    const after = loadSentences(file);
    expect(after.map((s) => s.no)).toEqual([171, 260, 332, 400]); // 並び・no は不変
    const replaced332 = after.find((s) => s.no === 332)!;
    expect(replaced332.en).toBe("Could you feed my cat this weekend? It's easy.");
    expect(replaced332.band).toBe("development");
    expect(replaced332.category_no).toBe(26);
    const replaced260 = after.find((s) => s.no === 260)!;
    expect(replaced260.en).toBe("The deploy script failed again this morning, didn't it?");
    expect(after.find((s) => s.no === 171)!.en).toBe(PAIR_KEEP.en); // 残す側は不変

    // 差し替えた no の解説だけが除去される（残りは温存 → genMissingSentenceExplanations で再生成する前提）
    const explanations = loadBundledExplanations(explanationsFile);
    expect(explanations.has(332)).toBe(false);
    expect(explanations.has(260)).toBe(false);
    expect(explanations.get(171)).toBe("解説171");
    expect(explanations.get(400)).toBe("解説400");

    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(logs.some((l) => l.startsWith("完了:"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("検証NGが2回続いても3回目で成功する（3ラウンド規律）", async () => {
    const { dir, file, explanationsFile } = setupReplaceFixture([PAIR_KEEP, PAIR_REPLACE, BAND_FILLER]);
    const nearDup = JSON.stringify({
      sentences: [{ domain: "daily", en: "Would you mind watering the plants while I'm out?", ja: "訳", note: "" }],
    });
    const logs: string[] = [];
    await genReplaceSentences({
      runner: makeRunner([nearDup, nearDup, REPLACEMENT_332]),
      sentencesFile: file, explanationsFile, nos: [332], stage: 3, dry: false, log: (s) => logs.push(s),
    });
    expect(loadSentences(file).find((s) => s.no === 332)!.en).toBe("Could you feed my cat this weekend? It's easy.");
    expect(logs.some((l) => l.includes("検証NG"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("3回とも検証NGなら書き込みゼロでthrow（例文・解説とも不変）", async () => {
    const { dir, file, explanationsFile } = setupReplaceFixture([PAIR_KEEP, PAIR_REPLACE, BAND_FILLER]);
    const before = readFileSync(file, "utf8");
    const beforeExp = readFileSync(explanationsFile, "utf8");
    const nearDup = JSON.stringify({
      sentences: [{ domain: "daily", en: "Would you mind watering the plants while I'm out?", ja: "訳", note: "" }],
    });
    await expect(genReplaceSentences({
      runner: makeRunner([nearDup]), sentencesFile: file, explanationsFile, nos: [332], stage: 3, dry: false,
    })).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readFileSync(explanationsFile, "utf8")).toBe(beforeExp);
    rmSync(dir, { recursive: true, force: true });
  });

  test("差し替え後も準重複ペアが残る場合は書き込みゼロでthrow（受け入れ条件: 全文でペア0組）", async () => {
    // 332 を差し替えても 171 と無関係な準重複ペア (601, 602) が残る → 全体を不採用
    const stray1: Sentence = { no: 601, category_no: 2, category: "過去形", domain: "it", en: "The build failed on the main branch again yesterday.", ja: "訳", note: "" };
    const stray2: Sentence = { no: 602, category_no: 2, category: "過去形", domain: "it", en: "The build failed on the main branch again.", ja: "訳", note: "" };
    const { dir, file, explanationsFile } = setupReplaceFixture([PAIR_KEEP, PAIR_REPLACE, BAND_FILLER, stray1, stray2]);
    const before = readFileSync(file, "utf8");
    await expect(genReplaceSentences({
      runner: makeRunner([REPLACEMENT_332]), sentencesFile: file, explanationsFile, nos: [332], stage: 3, dry: false,
    })).rejects.toThrow(/601.*602|準重複/);
    expect(readFileSync(file, "utf8")).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  test("band付き文を差し替えた帯は集計（checkSpokenRegister）もゲートする: 帯全体が教科書調になればthrow", async () => {
    // BAND_FILLER なし: 帯 development の文が差し替え後の1文だけになり、短縮形0でFAILする候補を返す
    const noContraction = JSON.stringify({
      sentences: [{ domain: "daily", en: "Could you please water my garden this weekend?", ja: "訳", note: "" }],
    });
    const { dir, file, explanationsFile } = setupReplaceFixture([PAIR_KEEP, PAIR_REPLACE]);
    const before = readFileSync(file, "utf8");
    await expect(genReplaceSentences({
      runner: makeRunner([noContraction]), sentencesFile: file, explanationsFile, nos: [332], stage: 3, dry: false,
    })).rejects.toThrow(/口語レジスター/);
    expect(readFileSync(file, "utf8")).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry=true は一切書かない", async () => {
    const { dir, file, explanationsFile } = setupReplaceFixture([PAIR_KEEP, PAIR_REPLACE, BAND_FILLER]);
    const before = readFileSync(file, "utf8");
    const beforeExp = readFileSync(explanationsFile, "utf8");
    await genReplaceSentences({
      runner: makeRunner([REPLACEMENT_332]), sentencesFile: file, explanationsFile, nos: [332], stage: 3, dry: true,
    });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readFileSync(explanationsFile, "utf8")).toBe(beforeExp);
    rmSync(dir, { recursive: true, force: true });
  });

  test("存在しない no は LLM を呼ばずに throw", async () => {
    const { dir, file, explanationsFile } = setupReplaceFixture([PAIR_KEEP]);
    let called = 0;
    const runner: ClaudeRunner = async () => { called++; return { text: "{}", sessionId: "fake" }; };
    await expect(genReplaceSentences({
      runner, sentencesFile: file, explanationsFile, nos: [999], stage: 3, dry: false,
    })).rejects.toThrow(/999/);
    expect(called).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// --- #182: 既存お題のアンカー付き再生成（id/domain/level固定・in-place上書き） ---

const LEGACY_TOPIC_MD = `---
id: desk-tools
kind: topic
title: "My Desk and Daily Tools"
title_ja: "私の机と毎日使う道具"
domain: business
level: [1, 3]
---
Talk about:
- What's on your desk — 机の上に何があるか
- Tools you use every day — 毎日使う道具について
- How you keep your desk neat — 机をきれいにしておく方法
- Something you want to add to your desk — 机に置きたいもの
`;

const REGEN_RESPONSE = JSON.stringify({
  title: "My Desk and Daily Tools",
  titleJa: "私の机と毎日使う道具",
  hints: [
    "What's on my desk right now — いま机の上にあるもの",
    "The tool I touch every day — 毎日必ず触る道具",
    "How I tidy up before I leave — 帰る前の片づけ方",
    "One thing I want to add — 置きたいものひとつ",
  ],
  experienceAnchor: "自分の机は毎日見て触れている場所なので、新しい知識なしで自分の経験から話せる。",
  memoryCue: "今朝仕事を始めるときに机の上を見た場面を思い出す。",
  commonObjectsOrActions: ["keyboard", "monitor", "notebook", "wiping the desk"],
});

function validRegenParsed(): Record<string, unknown> {
  return JSON.parse(REGEN_RESPONSE) as Record<string, unknown>;
}

const EXISTING_TOPIC = {
  id: "desk-tools", kind: "topic" as const, title: "My Desk and Daily Tools", titleJa: "私の机と毎日使う道具",
  domain: "business" as const, level: [1, 3] as [number, number],
  hints: ["a", "b", "c", "d"], starters: [],
};

describe("content-gen / validateRegenTopicCandidate（#182: 既存お題の再生成検証）", () => {
  test("正常系: id/domain/level を既存お題から固定し、アンカー付き候補を返す", () => {
    const out = validateRegenTopicCandidate(validRegenParsed(), EXISTING_TOPIC)!;
    expect(out.id).toBe("desk-tools");
    expect(out.kind).toBe("topic");
    expect(out.domain).toBe("business");
    expect(out.level).toEqual([1, 3]);
    expect(out.hints).toHaveLength(4);
    expect(out.experienceAnchor).toContain("新しい知識なし");
    expect(out.memoryCue).not.toBe("");
    expect(out.commonObjectsOrActions).toEqual(["keyboard", "monitor", "notebook", "wiping the desk"]);
  });

  test("アンカー欠落・カンマ入りcommonObjectsOrActions・hints数不一致は不採用", () => {
    expect(validateRegenTopicCandidate({ ...validRegenParsed(), experienceAnchor: " " }, EXISTING_TOPIC)).toBeNull();
    expect(validateRegenTopicCandidate({ ...validRegenParsed(), memoryCue: undefined }, EXISTING_TOPIC)).toBeNull();
    expect(validateRegenTopicCandidate(
      { ...validRegenParsed(), commonObjectsOrActions: ["keyboard, monitor"] }, EXISTING_TOPIC,
    )).toBeNull();
    expect(validateRegenTopicCandidate({ ...validRegenParsed(), hints: ["only — ひとつ"] }, EXISTING_TOPIC)).toBeNull();
  });

  test("禁止カテゴリを含む experienceAnchor は不採用（checkTopicAnchor 連動）", () => {
    expect(validateRegenTopicCandidate(
      { ...validRegenParsed(), experienceAnchor: "breaking news about the election を毎日追っている経験がある。" },
      EXISTING_TOPIC,
    )).toBeNull();
  });

  test("title の改行・二重引用符は不採用（frontmatter破壊防止）", () => {
    expect(validateRegenTopicCandidate({ ...validRegenParsed(), title: 'My "Desk"' }, EXISTING_TOPIC)).toBeNull();
  });
});

describe("content-gen / genRegenTopics（#182: 26お題のin-place再生成）", () => {
  function setupTopicsDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "regen-topics-"));
    writeFileSync(path.join(dir, "desk-tools.md"), LEGACY_TOPIC_MD);
    // アンカー整備済みのお題（再生成対象外・不変であること）
    writeFileSync(path.join(dir, "anchored.md"), contentToMarkdown({
      id: "anchored", kind: "topic", title: "Making Coffee at Home", titleJa: "家でコーヒーをいれる",
      domain: "daily", level: [1, 2],
      hints: ["a — あ", "b — い", "c — う", "d — え"],
      experienceAnchor: "毎朝コーヒーをいれる経験から話せる。",
      memoryCue: "今朝のキッチンを思い出す。",
      commonObjectsOrActions: ["kettle", "mug"],
    }));
    return dir;
  }

  test("正常系: 同じidのファイルをアンカー付きで上書きし、id/domain/levelは不変", async () => {
    const dir = setupTopicsDir();
    const result = await genRegenTopics({
      runner: makeRunner([REGEN_RESPONSE]), topicsDir: dir, ids: ["desk-tools"], dry: false,
    });
    expect(result.regenerated).toEqual(["desk-tools"]);
    expect(result.failed).toEqual([]);
    const parsed = parseContentFile(readFileSync(path.join(dir, "desk-tools.md"), "utf8"))!;
    expect(parsed.id).toBe("desk-tools");
    expect(parsed.domain).toBe("business");
    expect(parsed.level).toEqual([1, 3]);
    expect(parsed.experienceAnchor).toContain("新しい知識なし");
    expect(parsed.memoryCue).not.toBe("");
    expect(parsed.commonObjectsOrActions).toEqual(["keyboard", "monitor", "notebook", "wiping the desk"]);
    expect(parsed.hints).toHaveLength(4);
    // 対象外のお題は不変
    expect(loadContent(dir).find((t) => t.id === "anchored")!.title).toBe("Making Coffee at Home");
    rmSync(dir, { recursive: true, force: true });
  });

  test("3回とも検証NGのお題は書き込みゼロで failed に載り、他の成功分は書き込まれる（お題単位の粒度）", async () => {
    const dir = setupTopicsDir();
    writeFileSync(path.join(dir, "second.md"), LEGACY_TOPIC_MD.replace(/desk-tools/g, "second"));
    const invalid = JSON.stringify({ title: "x" }); // hints/アンカー欠落 → 検証NG
    // 1件目(desk-tools): 3回NG → failed。2件目(second): 4回目の応答で成功
    const result = await genRegenTopics({
      runner: makeRunner([invalid, invalid, invalid, REGEN_RESPONSE]),
      topicsDir: dir, ids: ["desk-tools", "second"], dry: false,
    });
    expect(result.failed).toEqual(["desk-tools"]);
    expect(result.regenerated).toEqual(["second"]);
    expect(readFileSync(path.join(dir, "desk-tools.md"), "utf8")).toBe(LEGACY_TOPIC_MD); // 不変
    expect(parseContentFile(readFileSync(path.join(dir, "second.md"), "utf8"))!.experienceAnchor).toContain("新しい知識なし");
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry=true は一切書かない", async () => {
    const dir = setupTopicsDir();
    const result = await genRegenTopics({
      runner: makeRunner([REGEN_RESPONSE]), topicsDir: dir, ids: ["desk-tools"], dry: true,
    });
    expect(result.regenerated).toEqual(["desk-tools"]);
    expect(readFileSync(path.join(dir, "desk-tools.md"), "utf8")).toBe(LEGACY_TOPIC_MD);
    rmSync(dir, { recursive: true, force: true });
  });

  test("存在しない id は LLM を呼ばずに throw", async () => {
    const dir = setupTopicsDir();
    let called = 0;
    const runner: ClaudeRunner = async () => { called++; return { text: "{}", sessionId: "fake" }; };
    await expect(genRegenTopics({ runner, topicsDir: dir, ids: ["no-such-topic"], dry: false })).rejects.toThrow(/no-such-topic/);
    expect(called).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("既存のtitle/hintsをテーマ維持のためプロンプトへ埋め込む", async () => {
    const dir = setupTopicsDir();
    const seen: string[] = [];
    const runner: ClaudeRunner = async (_p, _r, opts) => {
      seen.push(opts?.systemPrompt ?? "");
      return { text: REGEN_RESPONSE, sessionId: "fake" };
    };
    await genRegenTopics({ runner, topicsDir: dir, ids: ["desk-tools"], dry: true });
    expect(seen[0]).toContain("My Desk and Daily Tools");
    expect(seen[0]).toContain("What's on your desk");
    expect(seen[0]).toContain("desk-tools");
    rmSync(dir, { recursive: true, force: true });
  });
});
