import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../db";
import { loadContent, parseContentFile } from "../content";
import { loadSentences, type Sentence } from "../sentences";
import type { ClaudeRunner } from "../converse";
import {
  contentToMarkdown, genSentences, genTopics, genScenarios, genTopicsBand, SCENARIO_BAND_PLAN, TOPIC_BAND_PLAN,
  deprecatedContentCommandMessage, validateGeneratedHints, validateNewSentences, validateTopicCandidate,
  genTopicsForTarget, genScenariosForTarget,
} from "../content-gen";
import { loadListening, parseListeningFile } from "../listening";
import {
  genListening, genListeningForTarget, listeningToMarkdown, validateListeningCandidate,
} from "../content-gen";
import {
  SPOKEN_FUNCTIONS, SPOKEN_FUNCTION_CATEGORY_NO, SPOKEN_FUNCTION_CATEGORY_JA,
  validateSpokenFunctionSentences, genSpokenFunctionSentencesForTarget, genSpokenFunctionSentences,
  genMissingSentenceExplanations,
} from "../content-gen";
import { loadBundledExplanations } from "../sentences";
import { pickWorstCategories, type CategoryRate } from "../srs-analytics";
import { SPOKEN_STYLE_BLOCK, spokenStyleFor } from "../spoken-style";

/** 呼び出し順にレスポンスを返す fake ClaudeRunner（実Claude呼び出し・実content/への書き込みは一切しない） */
function makeRunner(responses: string[]): ClaudeRunner {
  let i = 0;
  return async () => {
    const text = responses[Math.min(i, responses.length - 1)];
    i++;
    return { text, sessionId: "fake" };
  };
}

/** systemPrompt を捕捉する fake ClaudeRunner（語彙制約の検証用） */
function makeCapturingRunner(responses: string[]): { runner: ClaudeRunner; seen: Array<{ systemPrompt?: string }> } {
  const seen: Array<{ systemPrompt?: string }> = [];
  let i = 0;
  const runner: ClaudeRunner = async (_prompt, _resumeId, opts) => {
    seen.push({ systemPrompt: opts?.systemPrompt });
    const text = responses[Math.min(i, responses.length - 1)];
    i++;
    return { text, sessionId: "fake" };
  };
  return { runner, seen };
}

function seedSrs(db: ReturnType<typeof openDb>, no: number, lastGrade: string): void {
  db.run(
    "INSERT INTO sentence_srs (no, stage, due, last_grade, reviews) VALUES (?, 0, '2026-08-01', ?, 1)",
    [no, lastGrade],
  );
}

/**
 * genListeningForTarget/genListening のテスト用フィクスチャ。checkSpokenRegister を beginner(11語/0.2)・
 * intermediate(14語/0.2)・advanced(16語/0.2) いずれの帯でもPASSするよう、短文+高短縮形率にしてある
 * （genListeningForTargetがcheckSpokenRegisterをhard-failゲートするようになったため、構造検証だけを
 * 通す旧フィクスチャ("First paragraph of X.")は0%短縮形でFAILし、テストが意図せずthrowするようになった）。
 */
function passingListeningParagraphs(id: string): string[] {
  return [`I'm glad to talk about ${id} today.`, `It's a simple topic, so let's get started.`];
}

const EXISTING: Sentence[] = [
  { no: 1, category_no: 1, category: "現在形", domain: "daily", en: "I usually walk to work.", ja: "歩く", note: "" },
  { no: 5, category_no: 2, category: "過去形", domain: "it", en: "The server went down.", ja: "落ちた", note: "" },
];

describe("content-gen / pickWorstCategories", () => {
  test("reviewed>=5 かつ badRate>0 のみを上位3件", () => {
    const rates: CategoryRate[] = [
      { categoryNo: 1, category: "A", reviewed: 6, badRate: 0.5 },
      { categoryNo: 2, category: "B", reviewed: 4, badRate: 0.9 },  // 5件未満 → 除外
      { categoryNo: 3, category: "C", reviewed: 10, badRate: 0 },   // bad無し → 除外
      { categoryNo: 4, category: "D", reviewed: 5, badRate: 0.2 },
      { categoryNo: 5, category: "E", reviewed: 7, badRate: 0.3 },
      { categoryNo: 6, category: "F", reviewed: 8, badRate: 0.1 },
    ];
    expect(pickWorstCategories(rates).map((r) => r.categoryNo)).toEqual([1, 5, 4]);
  });
});

describe("content-gen / validateNewSentences", () => {
  const cands = [
    { domain: "daily", en: "She usually reads before bed.", ja: "寝る前に読む", note: "習慣の現在形" },
    { domain: "business", en: "Our team usually meets on Mondays.", ja: "月曜に集まる", note: "三単現なし" },
  ];

  test("正常系: no を既存最大+1 から連番で振る", () => {
    const out = validateNewSentences(cands, EXISTING, 1, "現在形")!;
    expect(out.map((s) => s.no)).toEqual([6, 7]);
    expect(out[0].category_no).toBe(1);
    expect(out[0].category).toBe("現在形");
  });

  test("既存と正規化重複する en があれば全体を不採用（null）", () => {
    const dup = [...cands, { domain: "it", en: "I usually walk to work!", ja: "重複", note: "" }];
    expect(validateNewSentences(dup, EXISTING, 1, "現在形")).toBeNull();
  });

  test("不正 domain / 空 en は null", () => {
    expect(validateNewSentences([{ domain: "casual", en: "x", ja: "y", note: "" }], EXISTING, 1, "現在形")).toBeNull();
    expect(validateNewSentences([{ domain: "daily", en: "  ", ja: "y", note: "" }], EXISTING, 1, "現在形")).toBeNull();
  });

  test("空の ja は候補全体を不採用にする（en 空拒否と同じ扱い）", () => {
    const existing = [
      { no: 1, category_no: 1, category: "現在形", domain: "daily", en: "I work here.", ja: "ここで働いています", note: "" },
    ] as Sentence[];
    const cands = [{ domain: "daily", en: "I test this daily.", ja: "   ", note: "現在形" }];
    expect(validateNewSentences(cands, existing, 1, "現在形")).toBeNull();
  });

  test("厳密な空文字 ja: '' も候補全体を不採用にする", () => {
    const existing = [
      { no: 1, category_no: 1, category: "現在形", domain: "daily", en: "I work here.", ja: "ここで働いています", note: "" },
    ] as Sentence[];
    const cands = [{ domain: "daily", en: "I test this daily.", ja: "", note: "現在形" }];
    expect(validateNewSentences(cands, existing, 1, "現在形")).toBeNull();
  });
});

describe("content-gen / contentToMarkdown", () => {
  test("parseContentFile とラウンドトリップする", () => {
    const md = contentToMarkdown({
      id: "hobby-gardening", kind: "topic", title: "Gardening on weekends", titleJa: "週末の庭いじり",
      domain: "daily", level: [2, 4],
      hints: ["What you grow — 育てているもの", "A small failure — 小さな失敗談"],
    });
    const parsed = parseContentFile(md)!;
    expect(parsed.id).toBe("hobby-gardening");
    expect(parsed.kind).toBe("topic");
    expect(parsed.domain).toBe("daily");
    expect(parsed.level).toEqual([2, 4]);
    expect(parsed.hints).toHaveLength(2);
  });

  test("scenario は Roleplay setup: 見出しになる", () => {
    const md = contentToMarkdown({
      id: "hotel-checkin", kind: "scenario", title: "Hotel check-in trouble", titleJa: "ホテルのチェックイン",
      domain: "daily", level: [1, 3], hints: ["You are the guest — あなたは宿泊客"],
    });
    expect(md).toContain("Roleplay setup:");
    expect(parseContentFile(md)!.kind).toBe("scenario");
  });

  test("starters を指定するとhints行の後に > 行として出力され、parseContentFileでstartersに戻る", () => {
    const md = contentToMarkdown({
      id: "hotel-checkin-2", kind: "scenario", title: "Hotel check-in trouble", titleJa: "ホテルのチェックイン",
      domain: "daily", level: [1, 3],
      hints: ["You are the guest with a reservation problem.", "The AI plays the front desk clerk.", "Goal: get a room for tonight."],
      starters: ["Hi, I have a reservation.", "There seems to be a problem.", "Can you help me find a room?"],
    });
    const parsed = parseContentFile(md)!;
    expect(parsed.hints).toHaveLength(3);
    expect(parsed.starters).toEqual([
      "Hi, I have a reservation.", "There seems to be a problem.", "Can you help me find a room?",
    ]);
  });
});

describe("content-gen / validateTopicCandidate", () => {
  const BASE = {
    id: "hobby-cooking", title: "Cooking at home", titleJa: "家での料理",
    domain: "daily", level: [2, 4] as [number, number],
    hints: ["What you cook — 作るもの", "A recent mistake — 最近の失敗", "A favorite tool — お気に入りの道具", "Who you cook for — 誰のために"],
  };

  test("正常系はNewContentCandidateを返す", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-topic-valid-"));
    const cand = validateTopicCandidate(BASE, "topic", new Set(), dir, 3);
    expect(cand?.id).toBe("hobby-cooking");
    expect(cand?.level).toEqual([2, 4]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("domain不正はnull", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-topic-domain-"));
    expect(validateTopicCandidate({ ...BASE, domain: "casual" }, "topic", new Set(), dir, 3)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("levelが現stageを含まないとnull", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-topic-level-"));
    expect(validateTopicCandidate({ ...BASE, level: [4, 6] }, "topic", new Set(), dir, 1)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("hints欠落はnull", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-topic-hints-"));
    expect(validateTopicCandidate({ ...BASE, hints: [] }, "topic", new Set(), dir, 3)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("既存id集合との衝突・ファイル衝突はnull", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-topic-dup-"));
    expect(validateTopicCandidate(BASE, "topic", new Set(["hobby-cooking"]), dir, 3)).toBeNull();
    writeFileSync(path.join(dir, "hobby-cooking.md"), "x");
    expect(validateTopicCandidate(BASE, "topic", new Set(), dir, 3)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("id が kebab-case でないと null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-topic-id-"));
    expect(validateTopicCandidate({ ...BASE, id: "Not_Kebab" }, "topic", new Set(), dir, 3)).toBeNull();
    expect(validateTopicCandidate({ ...BASE, id: "has space" }, "topic", new Set(), dir, 3)).toBeNull();
    expect(validateTopicCandidate({ ...BASE, id: "UPPER" }, "topic", new Set(), dir, 3)).toBeNull();
    expect(validateTopicCandidate({ ...BASE, id: "" }, "topic", new Set(), dir, 3)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("空 title / titleJa は null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-topic-title-"));
    expect(validateTopicCandidate({ ...BASE, title: "  " }, "topic", new Set(), dir, 3)).toBeNull();
    expect(validateTopicCandidate({ ...BASE, titleJa: "" }, "topic", new Set(), dir, 3)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("title/titleJaの改行・二重引用符とhintの改行はnull", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-topic-inline-"));
    expect(validateTopicCandidate({ ...BASE, title: "Line 1\nLine 2" }, "topic", new Set(), dir, 3)).toBeNull();
    expect(validateTopicCandidate({ ...BASE, titleJa: '不正な"題名' }, "topic", new Set(), dir, 3)).toBeNull();
    expect(validateTopicCandidate({ ...BASE, hints: ["First part\n> injected starter"] }, "topic", new Set(), dir, 3)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("content-gen / generated markdown safety", () => {
  test("全topic/scenario validatorが共有するhint検証は改行を拒否する", () => {
    expect(validateGeneratedHints(["safe hint"], 1)).toEqual(["safe hint"]);
    expect(validateGeneratedHints(["first\nsecond"])).toBeNull();
    expect(validateGeneratedHints(["first\rsecond"])).toBeNull();
    expect(validateGeneratedHints(["one", "two"], 1)).toBeNull();
  });

  test("品質ゲートを持たない旧サブコマンドは書き込み不可の移行案内を返す", () => {
    for (const sub of ["topics", "scenarios", "topics-band"]) {
      expect(deprecatedContentCommandMessage(sub)).toMatch(/廃止|非推奨/);
      expect(deprecatedContentCommandMessage(sub)).toContain("--fill-coverage");
    }
    expect(deprecatedContentCommandMessage("topics-target")).toBeNull();
    expect(deprecatedContentCommandMessage("sentences")).toBeNull();
  });
});

describe("content-gen / genSentences", () => {
  const EXISTING5: Sentence[] = [1, 2, 3, 4, 5].map((no) => ({
    no, category_no: 1, category: "現在形", domain: "daily",
    en: `Existing sentence number ${no}.`, ja: "既存文", note: "",
  }));

  function setup() {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-sent-test-"));
    const file = path.join(dir, "sentences.json");
    writeFileSync(file, JSON.stringify(EXISTING5, null, 2) + "\n");
    const db = openDb(":memory:");
    for (const s of EXISTING5) seedSrs(db, s.no, s.no === 1 ? "bad" : "good"); // reviewed=5・badRate=0.2 で閾値超え
    return { dir, file, db };
  }

  const VALID_BATCH = JSON.stringify({
    sentences: [
      { domain: "daily", en: "He walks the dog every morning.", ja: "毎朝犬の散歩", note: "現在形" },
      { domain: "business", en: "Our team reviews the report weekly.", ja: "週次レビュー", note: "現在形" },
      { domain: "it", en: "The service restarts automatically at midnight.", ja: "深夜に自動再起動", note: "現在形" },
      { domain: "daily", en: "She always arrives early to class.", ja: "早めに到着", note: "現在形" },
    ],
  });

  test("正常系: 4文が追記されnoが連番・loadSentencesで読める・pretty+末尾改行", async () => {
    const { dir, file, db } = setup();
    const logs: string[] = [];
    await genSentences({ runner: makeRunner([VALID_BATCH]), sentencesFile: file, db, stage: 2, dry: false, log: (s) => logs.push(s) });

    const after = loadSentences(file);
    expect(after).toHaveLength(9);
    expect(after.slice(5).map((s) => s.no)).toEqual([6, 7, 8, 9]);

    const raw = readFileSync(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n    "no"'); // JSON.stringify(..., null, 2) の4スペースインデント（配列要素の中）
    expect(logs.some((l) => l.startsWith("完了:"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("既存と正規化重複するenは弾かれ再生成 → 2回目で成功", async () => {
    const { dir, file, db } = setup();
    const dupBatch = JSON.stringify({
      sentences: [
        { domain: "daily", en: "Existing sentence number 1!", ja: "重複", note: "" }, // no.1と正規化後に一致
        { domain: "business", en: "Our team reviews the report weekly.", ja: "週次レビュー", note: "現在形" },
        { domain: "it", en: "The service restarts automatically at midnight.", ja: "深夜に自動再起動", note: "現在形" },
        { domain: "daily", en: "She always arrives early to class.", ja: "早めに到着", note: "現在形" },
      ],
    });
    const logs: string[] = [];
    await genSentences({
      runner: makeRunner([dupBatch, VALID_BATCH]), sentencesFile: file, db, stage: 2, dry: false, log: (s) => logs.push(s),
    });
    expect(loadSentences(file)).toHaveLength(9);
    expect(logs.some((l) => l.includes("検証NG"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("runner が1回だけ例外を投げても再試行で回復し4文生成される（SDK一過性エラー耐性）", async () => {
    const { dir, file, db } = setup();
    let callIndex = 0;
    const runner: ClaudeRunner = async () => {
      if (callIndex++ === 0) throw new Error("Claude result error (error_max_turns): stop_reason=tool_use");
      return { text: VALID_BATCH, sessionId: "fake" };
    };
    const logs: string[] = [];
    await genSentences({ runner, sentencesFile: file, db, stage: 2, dry: false, log: (s) => logs.push(s) });
    expect(loadSentences(file)).toHaveLength(9);
    expect(logs.some((l) => l.includes("検証NG"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("不正出力が2回続くと書き込みゼロでthrow", async () => {
    const { dir, file, db } = setup();
    const invalidBatch = JSON.stringify({ sentences: [{ domain: "casual", en: "x", ja: "y", note: "z" }] });
    const before = readFileSync(file, "utf8");
    await expect(
      genSentences({ runner: makeRunner([invalidBatch, invalidBatch]), sentencesFile: file, db, stage: 2, dry: false }),
    ).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry=trueは一切書かない", async () => {
    const { dir, file, db } = setup();
    const before = readFileSync(file, "utf8");
    const logs: string[] = [];
    await genSentences({ runner: makeRunner([VALID_BATCH]), sentencesFile: file, db, stage: 2, dry: true, log: (s) => logs.push(s) });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(logs.some((l) => l.includes("--dry"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("データ不足時は何も書かず正常終了", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-sent-empty-"));
    const file = path.join(dir, "sentences.json");
    writeFileSync(file, JSON.stringify(EXISTING5, null, 2) + "\n");
    const db = openDb(":memory:"); // srs未評価 → worst=[]
    const before = readFileSync(file, "utf8");
    const logs: string[] = [];
    await genSentences({ runner: makeRunner([VALID_BATCH]), sentencesFile: file, db, stage: 2, dry: false, log: (s) => logs.push(s) });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(logs.some((l) => l.startsWith("データ不足"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("低ステージは systemPrompt に高頻度語彙制約(word families)が入る", async () => {
    const { dir, file, db } = setup();
    const { runner, seen } = makeCapturingRunner([VALID_BATCH]);
    // dry=true でもプロンプト構築と runner 呼び出しは走る（書き込みだけをスキップ）
    await genSentences({ runner, sentencesFile: file, db, stage: 2, dry: true });
    expect(seen[0].systemPrompt).toContain("word families");
    rmSync(dir, { recursive: true, force: true });
  });

  test("stage 4+ は systemPrompt に word families 制約行を挿入しない（上級者の挙動不変・null埋め込みも禁止）", async () => {
    const { dir, file, db } = setup();
    const { runner, seen } = makeCapturingRunner([VALID_BATCH]);
    await genSentences({ runner, sentencesFile: file, db, stage: 5, dry: true });
    expect(seen[0].systemPrompt).not.toContain("word families");
    expect(seen[0].systemPrompt).not.toMatch(/\bnull\b/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("content-gen / genTopics", () => {
  function tempDirs() {
    return {
      topicsDir: mkdtempSync(path.join(tmpdir(), "gen-topics-")),
      scenariosDir: mkdtempSync(path.join(tmpdir(), "gen-scenarios-")),
    };
  }
  function cleanup(dirs: { topicsDir: string; scenariosDir: string }) {
    rmSync(dirs.topicsDir, { recursive: true, force: true });
    rmSync(dirs.scenariosDir, { recursive: true, force: true });
  }
  // starters はここでは topic/scenario 共通のダミー値（topic 側は検証されないので無視される）。
  // scenario 分岐のstarters検証（ちょうど3件）を満たすため既定で含める。
  function contentJson(id: string, domain: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      id, title: `Title ${id}`, titleJa: `タイトル${id}`, domain,
      level: [2, 4], hints: ["a — あ", "b — い", "c — う", "d — え"],
      starters: ["S1.", "S2.", "S3."],
      ...overrides,
    });
  }

  test("正常系: お題2+シナリオ1がtempDirsに書かれloadContentで読める", async () => {
    const dirs = tempDirs();
    const logs: string[] = [];
    await genTopics({
      runner: makeRunner([
        contentJson("topic-one", "daily"),
        contentJson("topic-two", "it"),
        contentJson("scenario-one", "business"),
      ]),
      topicsDir: dirs.topicsDir, scenariosDir: dirs.scenariosDir, stage: 3, dry: false, log: (s) => logs.push(s),
    });
    expect(loadContent(dirs.topicsDir).map((c) => c.id).sort()).toEqual(["topic-one", "topic-two"]);
    expect(loadContent(dirs.scenariosDir).map((c) => c.id)).toEqual(["scenario-one"]);
    expect(logs.some((l) => l.startsWith("完了:"))).toBe(true);
    cleanup(dirs);
  });

  test("runner が1回だけ例外を投げても再試行で回復し3件生成される（SDK一過性エラー耐性）", async () => {
    const dirs = tempDirs();
    const responses = [contentJson("topic-one", "daily"), contentJson("topic-two", "it"), contentJson("scenario-one", "business")];
    let callIndex = 0;
    let responseIndex = 0;
    const runner: ClaudeRunner = async () => {
      if (callIndex++ === 0) throw new Error("Claude result error (error_max_turns): stop_reason=tool_use");
      const text = responses[Math.min(responseIndex, responses.length - 1)];
      responseIndex++;
      return { text, sessionId: "fake" };
    };
    const logs: string[] = [];
    await genTopics({
      runner, topicsDir: dirs.topicsDir, scenariosDir: dirs.scenariosDir, stage: 3, dry: false, log: (s) => logs.push(s),
    });
    expect(loadContent(dirs.topicsDir).map((c) => c.id).sort()).toEqual(["topic-one", "topic-two"]);
    expect(loadContent(dirs.scenariosDir).map((c) => c.id)).toEqual(["scenario-one"]);
    expect(logs.some((l) => l.includes("検証NG"))).toBe(true);
    cleanup(dirs);
  });

  test("id衝突時は書かない", async () => {
    const dirs = tempDirs();
    writeFileSync(path.join(dirs.topicsDir, "topic-one.md"), contentToMarkdown({
      id: "topic-one", kind: "topic", title: "Existing", titleJa: "既存",
      domain: "daily", level: [1, 6], hints: ["x — え"],
    }));
    await expect(
      genTopics({
        runner: makeRunner([contentJson("topic-one", "daily"), contentJson("topic-one", "daily")]),
        topicsDir: dirs.topicsDir, scenariosDir: dirs.scenariosDir, stage: 3, dry: false,
      }),
    ).rejects.toThrow();
    expect(readdirSync(dirs.topicsDir)).toEqual(["topic-one.md"]); // 既存ファイルのみ・新規追加なし
    expect(readdirSync(dirs.scenariosDir)).toEqual([]);
    cleanup(dirs);
  });

  test("不正候補が2回続くと先に検証済みの候補も含めて書き込みゼロ（オーファン無し）", async () => {
    const dirs = tempDirs();
    const invalidScenario = contentJson("bad-scenario", "casual"); // domain不正 → 厳格検証で拒否
    await expect(
      genTopics({
        runner: makeRunner([
          contentJson("topic-one", "daily"), contentJson("topic-two", "it"), invalidScenario, invalidScenario,
        ]),
        topicsDir: dirs.topicsDir, scenariosDir: dirs.scenariosDir, stage: 3, dry: false,
      }),
    ).rejects.toThrow();
    expect(readdirSync(dirs.topicsDir)).toEqual([]);
    expect(readdirSync(dirs.scenariosDir)).toEqual([]);
    cleanup(dirs);
  });

  test("dry=trueは一切書かない", async () => {
    const dirs = tempDirs();
    const logs: string[] = [];
    await genTopics({
      runner: makeRunner([
        contentJson("topic-one", "daily"), contentJson("topic-two", "it"), contentJson("scenario-one", "business"),
      ]),
      topicsDir: dirs.topicsDir, scenariosDir: dirs.scenariosDir, stage: 3, dry: true, log: (s) => logs.push(s),
    });
    expect(readdirSync(dirs.topicsDir)).toEqual([]);
    expect(readdirSync(dirs.scenariosDir)).toEqual([]);
    expect(logs.some((l) => l.includes("--dry"))).toBe(true);
    cleanup(dirs);
  });

  test("実書き込み後にscenario書き込みが失敗すると既に書いたtopicもロールバックする", async () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "gen-topics-"));
    const scenariosDir = path.join(tmpdir(), `gen-scenarios-missing-${Date.now()}`); // 存在しない → scenario の writeFileSync が投げる
    await expect(
      genTopics({
        runner: makeRunner([
          contentJson("topic-one", "daily"),
          contentJson("topic-two", "it"),
          contentJson("scenario-one", "business"),
        ]),
        topicsDir, scenariosDir, stage: 3, dry: false,
      }),
    ).rejects.toThrow();
    expect(readdirSync(topicsDir)).toEqual([]); // 書いた2件は catch の rmSync で消える（オーファン無し）
    rmSync(topicsDir, { recursive: true, force: true });
  });

  test("低ステージは topic 生成 systemPrompt に高頻度語彙制約が入る", async () => {
    const dirs = tempDirs();
    const { runner, seen } = makeCapturingRunner([
      contentJson("topic-one", "daily"), contentJson("topic-two", "it"), contentJson("scenario-one", "business"),
    ]);
    await genTopics({ runner, topicsDir: dirs.topicsDir, scenariosDir: dirs.scenariosDir, stage: 2, dry: true });
    expect(seen[0].systemPrompt).toContain("word families");
    cleanup(dirs);
  });

  test("stage 4+ は topic 生成 systemPrompt に word families 制約行を挿入しない（上級者の挙動不変）", async () => {
    const dirs = tempDirs();
    // contentJson の level は [2,4] 固定なので、検証を通すため stage は4（範囲内かつ4+の境界）を使う
    const { runner, seen } = makeCapturingRunner([
      contentJson("topic-one", "daily"), contentJson("topic-two", "it"), contentJson("scenario-one", "business"),
    ]);
    await genTopics({ runner, topicsDir: dirs.topicsDir, scenariosDir: dirs.scenariosDir, stage: 4, dry: true });
    expect(seen[0].systemPrompt).not.toContain("word families");
    expect(seen[0].systemPrompt).not.toMatch(/\bnull\b/);
    cleanup(dirs);
  });

  test("scenarioスロットはgenScenariosと同じナラティブ+スターター形式で生成され、topicスロットは従来どおりstartersなし", async () => {
    const dirs = tempDirs();
    const scenarioJson = JSON.stringify({
      id: "scenario-narrative", title: "Asking for help", titleJa: "助けを求める",
      domain: "business", level: [2, 4],
      hints: [
        "You ask a coworker for help with a simple task.",
        "The AI plays a helpful coworker.",
        "Goal: get the help you need and say thanks.",
      ],
      starters: ["Can you help me for a second?", "I have a quick question.", "Do you have a minute?"],
    });
    await genTopics({
      runner: makeRunner([contentJson("topic-one", "daily"), contentJson("topic-two", "it"), scenarioJson]),
      topicsDir: dirs.topicsDir, scenariosDir: dirs.scenariosDir, stage: 3, dry: false,
    });
    const topicItems = loadContent(dirs.topicsDir);
    expect(topicItems).toHaveLength(2);
    expect(topicItems.every((c) => c.starters.length === 0)).toBe(true); // topic側は従来どおりstartersなし

    const scenarioItems = loadContent(dirs.scenariosDir);
    expect(scenarioItems).toHaveLength(1);
    expect(scenarioItems[0].hints).toHaveLength(3);
    expect(scenarioItems[0].hints.every((h) => !/[぀-ヿ一-鿿]/.test(h))).toBe(true); // 英語のみのナラティブ
    expect(scenarioItems[0].starters).toEqual([
      "Can you help me for a second?", "I have a quick question.", "Do you have a minute?",
    ]);
    cleanup(dirs);
  });

  test("scenarioスロットのstartersが3件でない候補は検証NGとして再生成される", async () => {
    const dirs = tempDirs();
    const badScenario = JSON.stringify({
      id: "scenario-bad-starters", title: "Bad starters", titleJa: "不正なスターター",
      domain: "business", level: [2, 4],
      hints: ["You ask for help.", "The AI plays a coworker.", "Goal: finish the task."],
      starters: ["Only one starter."],
    });
    const goodScenario = JSON.stringify({
      id: "scenario-good-starters", title: "Good starters", titleJa: "正しいスターター",
      domain: "business", level: [2, 4],
      hints: ["You ask for help.", "The AI plays a coworker.", "Goal: finish the task."],
      starters: ["One.", "Two.", "Three."],
    });
    const logs: string[] = [];
    await genTopics({
      runner: makeRunner([contentJson("topic-one", "daily"), contentJson("topic-two", "it"), badScenario, goodScenario]),
      topicsDir: dirs.topicsDir, scenariosDir: dirs.scenariosDir, stage: 3, dry: false, log: (s) => logs.push(s),
    });
    expect(loadContent(dirs.scenariosDir).map((c) => c.id)).toEqual(["scenario-good-starters"]);
    expect(logs.some((l) => l.includes("検証NG"))).toBe(true);
    cleanup(dirs);
  });
});

describe("genScenarios（固定プラン・stage1帯）", () => {
  test("プランは business/it の [1,3] を狙う", () => {
    expect(SCENARIO_BAND_PLAN.map((p) => [p.domain, p.level])).toEqual([
      ["business", [1, 3]], ["it", [1, 3]],
    ]);
  });

  test("生成候補のdomain/levelはプランで固定され、検証通過分を全件書き込む（hints=英語ナラティブ・starters=3件）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-sc-"));
    let n = 0;
    const runner = async () => {
      n++;
      return { text: JSON.stringify({
        id: `stage1-sc-${n}`, title: `T${n}`, titleJa: `t${n}`,
        domain: "daily", level: [4, 6], // モデルが誤った domain/level を返してもプランで上書きされる
        hints: [
          "You ask a coworker for help with a simple task.",
          "The AI plays a helpful coworker.",
          "Goal: get the help you need and say thanks.",
        ],
        starters: ["Can you help me for a second?", "I have a quick question.", "Do you have a minute?"],
      }) };
    };
    await genScenarios({ runner: runner as never, scenariosDir: dir, dry: false, log: () => {} });
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    expect(files).toHaveLength(2);
    const first = parseContentFile(readFileSync(path.join(dir, files[0]), "utf8"))!;
    expect([first.domain, first.level[0]]).toEqual(["business", 1]); // プラン固定・stage1帯
    expect(first.hints).toHaveLength(3);
    expect(first.hints.every((h) => !/[぀-ヿ一-鿿]/.test(h))).toBe(true); // 英語のみのナラティブ（日本語混入なし）
    expect(first.starters).toHaveLength(3);
    rmSync(dir, { recursive: true, force: true });
  });

  test("starters が3件でない候補は検証NGとして再生成される", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-sc-bad-"));
    let n = 0;
    const runner = async () => {
      n++;
      const starters = n === 1 ? ["Only one starter."] : ["One.", "Two.", "Three."];
      return { text: JSON.stringify({
        id: `stage1-sc-${n}`, title: `T${n}`, titleJa: `t${n}`,
        hints: ["You ask for help.", "The AI plays a coworker.", "Goal: finish the task."],
        starters,
      }) };
    };
    await genScenarios({ runner: runner as never, scenariosDir: dir, dry: false, log: () => {} });
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    expect(files).toHaveLength(2);
    for (const f of files) {
      const parsed = parseContentFile(readFileSync(path.join(dir, f), "utf8"))!;
      expect(parsed.starters).toHaveLength(3);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("genTopicsBand（固定プラン・stage1帯business/it補充）", () => {
  test("プランは business x2 / it x2 の [1,3] を狙う", () => {
    expect(TOPIC_BAND_PLAN.map((p) => [p.domain, p.level])).toEqual([
      ["business", [1, 3]], ["business", [1, 3]], ["it", [1, 3]], ["it", [1, 3]],
    ]);
  });

  test("生成候補のdomain/levelはプランで固定され、検証通過分を全件書き込む（hints=4件・English—日本語形式）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-tb-"));
    let n = 0;
    const runner = async () => {
      n++;
      return { text: JSON.stringify({
        id: `stage1-tb-${n}`, title: `T${n}`, titleJa: `t${n}`,
        domain: "daily", level: [4, 6], // モデルが誤った domain/level を返してもプランで上書きされる
        hints: ["a — あ", "b — い", "c — う", "d — え"],
      }) };
    };
    await genTopicsBand({ runner: runner as never, topicsDir: dir, dry: false, log: () => {} });
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    expect(files).toHaveLength(4);
    const first = parseContentFile(readFileSync(path.join(dir, files[0]), "utf8"))!;
    expect([first.domain, first.level[0]]).toEqual(["business", 1]); // プラン固定・stage1帯
    expect(first.hints).toHaveLength(4);
    rmSync(dir, { recursive: true, force: true });
  });

  test("hintsが4件でない候補は検証NGとして再生成される", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-tb-bad-"));
    let n = 0;
    const runner = async () => {
      n++;
      const hints = n === 1 ? ["a — あ", "b — い", "c — う"] : ["a — あ", "b — い", "c — う", "d — え"];
      return { text: JSON.stringify({ id: `stage1-tb-${n}`, title: `T${n}`, titleJa: `t${n}`, hints }) };
    };
    const logs: string[] = [];
    await genTopicsBand({ runner: runner as never, topicsDir: dir, dry: false, log: (s) => logs.push(s) });
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    expect(files).toHaveLength(4);
    for (const f of files) {
      const parsed = parseContentFile(readFileSync(path.join(dir, f), "utf8"))!;
      expect(parsed.hints).toHaveLength(4);
    }
    expect(logs.some((l) => l.includes("検証NG"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("不正候補が2回続くと先に検証済みの候補も含めて書き込みゼロ（オーファン無し）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-tb-fail-"));
    const bad = JSON.stringify({ id: "bad-topic", title: "T", titleJa: "t", hints: ["only one"] });
    await expect(
      genTopicsBand({ runner: (async () => ({ text: bad })) as never, topicsDir: dir, dry: false }),
    ).rejects.toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith(".md"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry=trueは一切書かない", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-tb-dry-"));
    let n = 0;
    const runner = async () => {
      n++;
      return { text: JSON.stringify({ id: `stage1-tb-${n}`, title: `T${n}`, titleJa: `t${n}`, hints: ["a — あ", "b — い", "c — う", "d — え"] }) };
    };
    const logs: string[] = [];
    await genTopicsBand({ runner: runner as never, topicsDir: dir, dry: true, log: (s) => logs.push(s) });
    expect(readdirSync(dir).filter((f) => f.endsWith(".md"))).toEqual([]);
    expect(logs.some((l) => l.includes("--dry"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("systemPromptはvocabConstraint(1)とbeginner difficulty文言を含む", async () => {
    const seen: Array<{ systemPrompt?: string }> = [];
    let n = 0;
    const runner: ClaudeRunner = async (_p, _r, opts) => {
      seen.push({ systemPrompt: opts?.systemPrompt });
      n++;
      return { text: JSON.stringify({ id: `stage1-tb-${n}`, title: `T${n}`, titleJa: `t${n}`, hints: ["a — あ", "b — い", "c — う", "d — え"] }), sessionId: "fake" };
    };
    const dir = mkdtempSync(path.join(tmpdir(), "gen-tb-prompt-"));
    await genTopicsBand({ runner, topicsDir: dir, dry: true });
    expect(seen[0].systemPrompt).toContain("word families");
    expect(seen[0].systemPrompt).toContain("beginner difficulty stage 1-3 of 6");
    expect(seen[0].systemPrompt).toContain("own daily work life");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("content-gen / listeningToMarkdown", () => {
  test("parseListeningFile とラウンドトリップする", () => {
    const md = listeningToMarkdown({
      id: "coffee-shop", title: "A morning at the coffee shop", titleJa: "朝のカフェ",
      domain: "daily", level: [1, 3],
      paragraphs: ["I go to the same coffee shop every morning.", "The staff already know my order."],
    });
    const parsed = parseListeningFile(md)!;
    expect(parsed.id).toBe("coffee-shop");
    expect(parsed.domain).toBe("daily");
    expect(parsed.level).toEqual([1, 3]);
    expect(parsed.paragraphs).toHaveLength(2);
  });
});

describe("content-gen / validateListeningCandidate", () => {
  const BASE = {
    id: "team-standup", title: "Our daily standup", titleJa: "朝会",
    paragraphs: ["We meet at nine every morning.", "Each person shares what they did yesterday."],
  };

  test("正常系は NewListeningCandidate を返す", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-valid-"));
    const cand = validateListeningCandidate(BASE, new Set(), dir);
    expect(cand?.id).toBe("team-standup");
    expect(cand?.paragraphs).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("id が kebab-case でない / 空 title / 段落2未満 / 空段落は null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-bad-"));
    expect(validateListeningCandidate({ ...BASE, id: "Not_Kebab" }, new Set(), dir)).toBeNull();
    expect(validateListeningCandidate({ ...BASE, title: "  " }, new Set(), dir)).toBeNull();
    expect(validateListeningCandidate({ ...BASE, paragraphs: ["only one"] }, new Set(), dir)).toBeNull();
    expect(validateListeningCandidate({ ...BASE, paragraphs: ["ok", "  "] }, new Set(), dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("既存 id 集合との衝突・ファイル衝突は null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-dup-"));
    expect(validateListeningCandidate(BASE, new Set(["team-standup"]), dir)).toBeNull();
    writeFileSync(path.join(dir, "team-standup.md"), "x");
    expect(validateListeningCandidate(BASE, new Set(), dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("id が予約語 'log' は null（GET /api/listening/:id と POST /api/listening/log の解釈衝突を避ける）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-reserved-"));
    expect(validateListeningCandidate({ ...BASE, id: "log" }, new Set(), dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("title に改行を含むと null（frontmatter破壊防止）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-title-nl-"));
    expect(validateListeningCandidate({ ...BASE, title: "Line one\nLine two" }, new Set(), dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("titleJa に二重引用符を含むと null（frontmatter破壊防止）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-titleja-quote-"));
    expect(validateListeningCandidate({ ...BASE, titleJa: '「朝の"習慣"」' }, new Set(), dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("paragraphs結合後の長さが2800字を超えると null（talk-explainの3000字上限対策）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-toolong-"));
    const long = "a".repeat(2801);
    expect(validateListeningCandidate({ ...BASE, paragraphs: [long, "second paragraph."] }, new Set(), dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

// v0.26 content-ladder wave2: listening を3帯(foundation[1,2]/development[3,4]/fluency[5,6])×3domain×4本へ
// 拡張。genListeningForTarget は genTopicsForTarget/genScenariosForTarget と対をなす帯×domain×count指定の
// 生成本体（--fill-coverageの生成本体でもある）。genListening はそれをcontent-coverageの不足セル計算で
// 駆動するラッパーへ変わった（旧: 固定6件プランを毎回丸ごと生成）。
describe("content-gen / genListeningForTarget（帯×domain×count・--fill-coverageの生成本体）", () => {
  function listeningTargetJson(id: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      id, title: `Title ${id}`, titleJa: `タイトル${id}`,
      paragraphs: passingListeningParagraphs(id),
      ...overrides,
    });
  }

  test("正常系: count本がlevel=帯範囲ちょうど・domain固定で書かれ loadListening で読める", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-lt-"));
    const logs: string[] = [];
    await genListeningForTarget({
      runner: makeRunner([listeningTargetJson("morning-a"), listeningTargetJson("morning-b")]),
      listeningDir: dir, domain: "daily", band: "fluency", count: 2, dry: false, log: (s) => logs.push(s),
    });
    const items = loadListening(dir);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.domain === "daily" && i.level[0] === 5 && i.level[1] === 6)).toBe(true);
    expect(logs.some((l) => l.startsWith("完了:"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry=trueは一切書かない", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-lt-dry-"));
    const logs: string[] = [];
    await genListeningForTarget({
      runner: makeRunner([listeningTargetJson("morning-a")]),
      listeningDir: dir, domain: "daily", band: "fluency", count: 1, dry: true, log: (s) => logs.push(s),
    });
    expect(loadListening(dir)).toHaveLength(0);
    expect(logs.some((l) => l.includes("--dry"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("3回とも検証NGなら書き込みゼロでthrow（3ラウンド規律）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-lt-3fail-"));
    const bad = listeningTargetJson("bad", { paragraphs: ["only one"] }); // 段落2未満で検証NG
    await expect(
      genListeningForTarget({
        runner: makeRunner([bad, bad, bad]),
        listeningDir: dir, domain: "daily", band: "fluency", count: 1, dry: false,
      }),
    ).rejects.toThrow();
    expect(loadListening(dir)).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  // 実生成(v0.26 wave2・36本)で3本が短縮形率不足のまま書き込まれてしまった実障害の再発防止テスト。
  // 構造検証(validateListeningCandidate)だけでは口語レジスターの質を見ないため、checkSpokenRegisterを
  // hard-failゲートとして追加した(genScenariosForTargetがcheckScenarioStarterをゲートするのと同構造)。
  test("checkSpokenRegisterでFAILする候補(短縮形率0%の教科書調)は再生成される", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-lt-register-"));
    const textbookStyle = listeningTargetJson("textbook", {
      paragraphs: [
        "I do not like doing the dishes after dinner every single night without fail.",
        "I do not think it is fun at all, and I do not know why that is.",
      ],
    });
    const good = listeningTargetJson("good-one");
    const logs: string[] = [];
    await genListeningForTarget({
      runner: makeRunner([textbookStyle, good]),
      listeningDir: dir, domain: "daily", band: "foundation", count: 1, dry: false, log: (s) => logs.push(s),
    });
    const items = loadListening(dir);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("good-one");
    expect(logs.some((l) => l.includes("検証NG"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("runner が1回だけ例外を投げても再試行で回復し生成される（SDK一過性エラー耐性）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-lt-transient-"));
    let callIndex = 0;
    const runner: ClaudeRunner = async () => {
      if (callIndex++ === 0) throw new Error("Claude result error (error_max_turns): stop_reason=tool_use");
      return { text: listeningTargetJson("morning-a"), sessionId: "fake" };
    };
    const logs: string[] = [];
    await genListeningForTarget({ runner, listeningDir: dir, domain: "daily", band: "fluency", count: 1, dry: false, log: (s) => logs.push(s) });
    expect(loadListening(dir)).toHaveLength(1);
    expect(logs.some((l) => l.includes("検証NG"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("foundation帯はsystemPromptにword families制約が入り、fluency帯には入らない", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-lt-vocab-"));
    const seen: Array<{ systemPrompt?: string }> = [];
    const runner: ClaudeRunner = async (_p, _r, opts) => {
      seen.push({ systemPrompt: opts?.systemPrompt });
      return { text: listeningTargetJson(`t-${seen.length}`), sessionId: "fake" };
    };
    await genListeningForTarget({ runner, listeningDir: dir, domain: "business", band: "foundation", count: 1, dry: true });
    await genListeningForTarget({ runner, listeningDir: dir, domain: "business", band: "fluency", count: 1, dry: true });
    expect(seen[0].systemPrompt).toContain("word families");
    expect(seen[1].systemPrompt).not.toContain("word families");
    expect(seen[1].systemPrompt).not.toMatch(/\bnull\b/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("帯別のspoken-styleガイドが注入される(foundation=beginner/development=intermediate/fluency=advanced)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-lt-spoken-"));
    const seen: Array<{ systemPrompt?: string }> = [];
    const runner: ClaudeRunner = async (_p, _r, opts) => {
      seen.push({ systemPrompt: opts?.systemPrompt });
      return { text: listeningTargetJson(`t-${seen.length}`), sessionId: "fake" };
    };
    await genListeningForTarget({ runner, listeningDir: dir, domain: "daily", band: "foundation", count: 1, dry: true });
    await genListeningForTarget({ runner, listeningDir: dir, domain: "daily", band: "development", count: 1, dry: true });
    await genListeningForTarget({ runner, listeningDir: dir, domain: "daily", band: "fluency", count: 1, dry: true });
    expect(seen[0].systemPrompt).toContain(SPOKEN_STYLE_BLOCK);
    expect(seen[0].systemPrompt).toContain(spokenStyleFor("beginner"));
    expect(seen[1].systemPrompt).toContain(spokenStyleFor("intermediate"));
    expect(seen[2].systemPrompt).toContain(spokenStyleFor("advanced"));
    expect(seen[0].systemPrompt).not.toContain(spokenStyleFor("advanced"));
    rmSync(dir, { recursive: true, force: true });
  });

  // T3差し戻し(2回目・v0.25): it×beginner が「手順書調」に収束したため追加したマニュアル調回避の指示。
  // v0.26で development(intermediate)帯が新設されたため、そちらにも適用されることを確認する。
  test("itドメインはfoundation/development/fluencyの全帯でマニュアル調回避の指示を含み、daily/businessは不変", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-lt-it-casual-"));
    const seen: Array<{ systemPrompt?: string }> = [];
    const runner: ClaudeRunner = async (_p, _r, opts) => {
      seen.push({ systemPrompt: opts?.systemPrompt });
      return { text: listeningTargetJson(`t-${seen.length}`), sessionId: "fake" };
    };
    await genListeningForTarget({ runner, listeningDir: dir, domain: "it", band: "development", count: 1, dry: true });
    await genListeningForTarget({ runner, listeningDir: dir, domain: "daily", band: "development", count: 1, dry: true });
    expect(seen[0].systemPrompt).toContain("NOT like a manual or tutorial");
    expect(seen[1].systemPrompt).not.toContain("NOT like a manual or tutorial");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("content-gen / genListening（カバレッジ駆動: 不足セルのみ生成しbridgeは対象外・べき等）", () => {
  function listeningJson(id: string) {
    return JSON.stringify({ id, title: `Title ${id}`, titleJa: `タイトル${id}`, paragraphs: passingListeningParagraphs(id) });
  }
  function seedFullCell(dir: string, domain: string, level: [number, number], prefix: string) {
    for (let i = 0; i < 4; i++) {
      writeFileSync(path.join(dir, `${prefix}-${i}.md`), listeningToMarkdown({
        id: `${prefix}-${i}`, title: `T${i}`, titleJa: `t${i}`, domain, level, paragraphs: ["First line here.", "Second line here."],
      }));
    }
  }

  test("空ディレクトリでは9セル(3band×3domain)×quota4本=36本を生成する", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-cov-"));
    let n = 0;
    const runner: ClaudeRunner = async () => ({ text: listeningJson(`item-${n++}`), sessionId: "fake" });
    const logs: string[] = [];
    await genListening({ runner, listeningDir: dir, dry: false, log: (s) => logs.push(s) });
    expect(loadListening(dir)).toHaveLength(36);
    rmSync(dir, { recursive: true, force: true });
  });

  test("既存bridge教材([1,3]/[4,6]相当)はquota外・温存され、対応する帯も不足扱いのまま4本生成される", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-bridge-"));
    writeFileSync(path.join(dir, "bridge-daily-lo.md"), listeningToMarkdown({
      id: "bridge-daily-lo", title: "Bridge", titleJa: "橋渡し", domain: "daily", level: [1, 3], paragraphs: ["First line here.", "Second line here."],
    }));
    let n = 0;
    const runner: ClaudeRunner = async () => ({ text: listeningJson(`item-${n++}`), sessionId: "fake" });
    await genListening({ runner, listeningDir: dir, dry: false, log: () => {} });
    const items = loadListening(dir);
    expect(items.some((i) => i.id === "bridge-daily-lo")).toBe(true); // bridgeは残る
    expect(items).toHaveLength(37); // bridge1本 + 9セル×4本(bridgeはquota集計から除外されるため全セル満額生成)
    rmSync(dir, { recursive: true, force: true });
  });

  test("既にquota充足済みのセルはスキップされ、不足セルのみ生成される（べき等な再実行）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-skip-"));
    seedFullCell(dir, "daily", [1, 2], "daily-f"); // daily/foundation を先に4本quota充足させておく
    let n = 0;
    const runner: ClaudeRunner = async () => ({ text: listeningJson(`item-${n++}`), sessionId: "fake" });
    await genListening({ runner, listeningDir: dir, dry: false, log: () => {} });
    const items = loadListening(dir);
    expect(items.filter((i) => i.domain === "daily" && i.level[0] === 1 && i.level[1] === 2)).toHaveLength(4); // 追加されない
    expect(items).toHaveLength(4 + 8 * 4); // 既存4本 + 残り8セル×4本
    rmSync(dir, { recursive: true, force: true });
  });

  test("全9セルquota充足済みなら何も生成せずログのみ返す", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-full-"));
    let idx = 0;
    for (const domain of ["daily", "business", "it"] as const) {
      for (const level of [[1, 2], [3, 4], [5, 6]] as Array<[number, number]>) {
        seedFullCell(dir, domain, level, `full-${idx++}`);
      }
    }
    const logs: string[] = [];
    const runner: ClaudeRunner = async () => { throw new Error("呼ばれてはいけない"); };
    await genListening({ runner, listeningDir: dir, dry: false, log: (s) => logs.push(s) });
    expect(logs.some((l) => l.includes("不足セルはありません"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry=trueは一切書かない", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-listen-dry2-"));
    let n = 0;
    const runner: ClaudeRunner = async () => ({ text: listeningJson(`item-${n++}`), sessionId: "fake" });
    const logs: string[] = [];
    await genListening({ runner, listeningDir: dir, dry: true, log: (s) => logs.push(s) });
    expect(loadListening(dir)).toHaveLength(0);
    expect(logs.some((l) => l.includes("--dry"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// v0.26 content-ladder wave1: 帯([1,2]|[3,4]|[5,6])×domain×count指定の生成（--fill-coverageの生成本体）。
// topicはexperienceAnchor/memoryCue/commonObjectsOrActions必須(topic-anchor-checkで検証)、
// scenarioはstarter3件すべてcheckScenarioStarter PASS必須。
describe("genTopicsForTarget（帯×domain×count・experienceAnchor必須）", () => {
  function topicTargetJson(id: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      id, title: `Morning routine ${id}`, titleJa: `朝の習慣${id}`,
      hints: ["a — あ", "b — い", "c — う", "d — え"],
      experienceAnchor: "誰もが経験する日常のルーティンに接地している",
      memoryCue: "自分の朝の様子を思い浮かべる",
      commonObjectsOrActions: ["coffee mug", "toothbrush", "alarm clock"],
      ...overrides,
    });
  }

  test("正常系: count本がlevel=帯範囲ちょうど・domain固定で書かれ、anchorフィールドがfrontmatterに残る", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-tt-"));
    const logs: string[] = [];
    await genTopicsForTarget({
      runner: makeRunner([topicTargetJson("morning-1"), topicTargetJson("morning-2")]),
      topicsDir: dir, domain: "daily", band: "fluency", count: 2, dry: false, log: (s) => logs.push(s),
    });
    const items = loadContent(dir);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.domain === "daily" && i.level[0] === 5 && i.level[1] === 6)).toBe(true);
    expect(items[0].experienceAnchor).toBe("誰もが経験する日常のルーティンに接地している");
    expect(items[0].commonObjectsOrActions).toEqual(["coffee mug", "toothbrush", "alarm clock"]);
    expect(logs.some((l) => l.startsWith("完了:"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("experienceAnchor欠落は検証NGとして再生成される", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-tt-noanchor-"));
    const logs: string[] = [];
    await genTopicsForTarget({
      runner: makeRunner([topicTargetJson("bad-1", { experienceAnchor: "" }), topicTargetJson("good-1")]),
      topicsDir: dir, domain: "it", band: "foundation", count: 1, dry: false, log: (s) => logs.push(s),
    });
    const items = loadContent(dir);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("good-1");
    expect(logs.some((l) => l.includes("検証NG"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("禁止カテゴリに該当するタイトルはtopic-anchor-checkでFAILし再生成される", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-tt-banned-"));
    const bannedCand = topicTargetJson("bad-quantum", { title: "Quantum mechanics for beginners" });
    await genTopicsForTarget({
      runner: makeRunner([bannedCand, topicTargetJson("good-2")]),
      topicsDir: dir, domain: "it", band: "foundation", count: 1, dry: false, log: () => {},
    });
    const items = loadContent(dir);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("good-2");
    rmSync(dir, { recursive: true, force: true });
  });

  test("3回とも検証NGなら書き込みゼロでthrow（3ラウンド規律）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-tt-3fail-"));
    const bad = topicTargetJson("bad", { experienceAnchor: "" });
    await expect(
      genTopicsForTarget({
        runner: makeRunner([bad, bad, bad]),
        topicsDir: dir, domain: "daily", band: "fluency", count: 1, dry: false,
      }),
    ).rejects.toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith(".md"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry=trueは一切書かない", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-tt-dry-"));
    await genTopicsForTarget({
      runner: makeRunner([topicTargetJson("morning-1")]),
      topicsDir: dir, domain: "daily", band: "fluency", count: 1, dry: true,
    });
    expect(readdirSync(dir).filter((f) => f.endsWith(".md"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("foundation帯はsystemPromptにword families制約が入り、fluency帯には入らない", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-tt-vocab-"));
    const seen: Array<{ systemPrompt?: string }> = [];
    const runner: ClaudeRunner = async (_p, _r, opts) => {
      seen.push({ systemPrompt: opts?.systemPrompt });
      return { text: topicTargetJson(`t-${seen.length}`), sessionId: "fake" };
    };
    await genTopicsForTarget({ runner, topicsDir: dir, domain: "business", band: "foundation", count: 1, dry: true });
    await genTopicsForTarget({ runner, topicsDir: dir, domain: "business", band: "fluency", count: 1, dry: true });
    expect(seen[0].systemPrompt).toContain("word families");
    expect(seen[1].systemPrompt).not.toContain("word families");
    rmSync(dir, { recursive: true, force: true });
  });

  test("systemPromptに「完全に既知」接地ルールと禁止カテゴリの明示が含まれる", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-tt-prompt-"));
    const { runner, seen } = ((): { runner: ClaudeRunner; seen: Array<{ systemPrompt?: string }> } => {
      const seen: Array<{ systemPrompt?: string }> = [];
      const runner: ClaudeRunner = async (_p, _r, opts) => {
        seen.push({ systemPrompt: opts?.systemPrompt });
        return { text: topicTargetJson("t-1"), sessionId: "fake" };
      };
      return { runner, seen };
    })();
    await genTopicsForTarget({ runner, topicsDir: dir, domain: "daily", band: "fluency", count: 1, dry: true });
    expect(seen[0].systemPrompt).toMatch(/known information|already talk about|lived experience/i);
    expect(seen[0].systemPrompt).toMatch(/abstract/i);
    expect(seen[0].systemPrompt).toMatch(/specialist|academic/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("genScenariosForTarget（帯×domain×count・starter口語検証必須）", () => {
  function scenarioTargetJson(id: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      id, title: `Scenario ${id}`, titleJa: `シナリオ${id}`,
      hints: [
        "You ask a coworker for help with a simple task.",
        "The AI plays a helpful coworker.",
        "Goal: get the help you need and say thanks.",
      ],
      starters: ["Can you help me for a second?", "I have a quick question.", "Do you have a minute?"],
      ...overrides,
    });
  }

  test("正常系: count本がlevel=帯範囲ちょうど・domain固定で書かれる", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-st-"));
    const logs: string[] = [];
    await genScenariosForTarget({
      runner: makeRunner([scenarioTargetJson("sc-1"), scenarioTargetJson("sc-2")]),
      scenariosDir: dir, domain: "daily", band: "fluency", count: 2, dry: false, log: (s) => logs.push(s),
    });
    const items = loadContent(dir);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.domain === "daily" && i.level[0] === 5 && i.level[1] === 6)).toBe(true);
    expect(items[0].starters).toHaveLength(3);
    expect(logs.some((l) => l.startsWith("完了:"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("書き言葉調のstarterはcheckScenarioStarterでFAILし再生成される", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-st-formal-"));
    const formalCand = scenarioTargetJson("sc-formal", {
      starters: ["I am writing to inquire about the room.", "One.", "Two."],
    });
    await genScenariosForTarget({
      runner: makeRunner([formalCand, scenarioTargetJson("sc-ok")]),
      scenariosDir: dir, domain: "business", band: "development", count: 1, dry: false, log: () => {},
    });
    const items = loadContent(dir);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("sc-ok");
    rmSync(dir, { recursive: true, force: true });
  });

  test("3回とも検証NGなら書き込みゼロでthrow（3ラウンド規律）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-st-3fail-"));
    const bad = scenarioTargetJson("bad", { starters: ["Only one starter."] });
    await expect(
      genScenariosForTarget({
        runner: makeRunner([bad, bad, bad]),
        scenariosDir: dir, domain: "daily", band: "fluency", count: 1, dry: false,
      }),
    ).rejects.toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith(".md"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry=trueは一切書かない", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-st-dry-"));
    await genScenariosForTarget({
      runner: makeRunner([scenarioTargetJson("sc-1")]),
      scenariosDir: dir, domain: "daily", band: "fluency", count: 1, dry: true,
    });
    expect(readdirSync(dir).filter((f) => f.endsWith(".md"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// v0.26 content-ladder wave4: spoken function 例文(依頼/断り/聞き返し/言い換え/相槌) +90（帯別30・解説つき）。
// 設計doc §3「spoken function 例文 = 依頼・断り・聞き返し・言い換え・相槌等（domain非依存・帯別30）」。
// category_no は固定26-30（既存グラマーカテゴリ1-25・機能カテゴリ22-25とは別枠）。band は additive（sentences.tsで検証済み）。
describe("content-gen / spoken function 例文", () => {
  test("SPOKEN_FUNCTIONS は5件・category_noは26-30を固定で割り当てる", () => {
    expect(SPOKEN_FUNCTIONS).toEqual(["request", "refusal", "clarification", "paraphrase", "backchannel"]);
    expect(SPOKEN_FUNCTIONS.map((f) => SPOKEN_FUNCTION_CATEGORY_NO[f])).toEqual([26, 27, 28, 29, 30]);
    expect(new Set(SPOKEN_FUNCTIONS.map((f) => SPOKEN_FUNCTION_CATEGORY_NO[f])).size).toBe(5);
    for (const f of SPOKEN_FUNCTIONS) expect(SPOKEN_FUNCTION_CATEGORY_JA[f].length).toBeGreaterThan(0);
  });

  describe("validateSpokenFunctionSentences", () => {
    const VALID_CANDS = [
      { domain: "daily", en: "Can you help me carry this?", ja: "これ運ぶの手伝ってくれる？", note: "依頼のcan you" },
      { domain: "business", en: "Could you send me the file?", ja: "ファイルを送ってもらえますか？", note: "丁寧な依頼" },
    ];

    test("正常系: band付きSentence[]を返しnoを既存最大+1から連番で振る", () => {
      const out = validateSpokenFunctionSentences(VALID_CANDS, EXISTING, 26, "会話機能: 依頼する", "foundation")!;
      expect(out).not.toBeNull();
      expect(out.map((s) => s.no)).toEqual([6, 7]);
      expect(out.every((s) => s.category_no === 26 && s.band === "foundation")).toBe(true);
    });

    test("書き言葉語彙(moreover等)を含む文があれば候補全体を不採用にする", () => {
      const withBanned = [
        ...VALID_CANDS,
        { domain: "it", en: "Moreover, could you clarify this point?", ja: "さらに、この点を明確にしてもらえますか？", note: "" },
      ];
      expect(validateSpokenFunctionSentences(withBanned, EXISTING, 26, "会話機能: 依頼する", "foundation")).toBeNull();
    });

    test("帯別語数上限を超える文があれば候補全体を不採用にする（foundationは短文のみ許容）", () => {
      const tooLong = [
        ...VALID_CANDS,
        { domain: "daily", en: "Would it be possible for you to help me carry this heavy box up the stairs please", ja: "長い依頼文", note: "" },
      ];
      expect(validateSpokenFunctionSentences(tooLong, EXISTING, 26, "会話機能: 依頼する", "foundation")).toBeNull();
    });

    test("不正domainは既存のvalidateNewSentencesと同様に不採用（検証の再利用を確認）", () => {
      const badDomain = [{ domain: "casual", en: "Can you help me?", ja: "手伝って", note: "" }];
      expect(validateSpokenFunctionSentences(badDomain, EXISTING, 26, "会話機能: 依頼する", "foundation")).toBeNull();
    });
  });

  describe("genSpokenFunctionSentencesForTarget（帯単位・カテゴリ×6件quota・べき等）", () => {
    const EXISTING5: Sentence[] = [1, 2, 3, 4, 5].map((no) => ({
      no, category_no: 1, category: "現在形", domain: "daily",
      en: `Existing sentence number ${no}.`, ja: "既存文", note: "",
    }));

    function setupFile(extra: Sentence[] = []) {
      const dir = mkdtempSync(path.join(tmpdir(), "gen-sf-"));
      const file = path.join(dir, "sentences.json");
      writeFileSync(file, JSON.stringify([...EXISTING5, ...extra], null, 2) + "\n");
      return { dir, file };
    }

    /** 短くて短縮形を含む自然な会話文6件を1カテゴリ分返す（foundation/development/fluencyいずれの閾値も通る） */
    function goodBatch(prefix: string, n = 6): string {
      // 全文に prefix(カテゴリ名) を含める: カテゴリ間で文面が重複するとnormalizeEnの既存重複チェックに
      // 弾かれてしまうため（validateNewSentencesは既存全文=all累積分と正規化重複しないことを要求する）。
      // 各文をほぼ同じ長さ(7-9語)・短縮形ちょうど1個にそろえてあるため、n=4/6どちらにスライスしても
      // 平均文長・短縮形率の閾値(foundation: 11語/0.2)を安定して満たす。
      const templates = [
        `I can't quite catch that about the ${prefix}.`,
        `So you're saying the ${prefix} is done, right?`,
        `Sorry, I can't make it to the ${prefix} today.`,
        `Oh, that's great news about the ${prefix}!`,
        `We're glad to hear about the ${prefix} today.`,
        `It's nice of you to explain the ${prefix}.`,
      ];
      return JSON.stringify({ sentences: templates.slice(0, n).map((en, i) => ({
        domain: (["daily", "business", "it"] as const)[i % 3], en, ja: `日本語訳${i}`, note: "会話機能の例文",
      })) });
    }

    test("正常系: 空の帯セルは5カテゴリ×6件=30文をband付きで追加する", async () => {
      const { dir, file } = setupFile();
      const logs: string[] = [];
      await genSpokenFunctionSentencesForTarget({
        runner: makeRunner(SPOKEN_FUNCTIONS.map((f) => goodBatch(f))),
        sentencesFile: file, band: "foundation", dry: false, log: (s) => logs.push(s),
      });
      const after = loadSentences(file);
      expect(after).toHaveLength(5 + 30);
      const added = after.slice(5);
      expect(added.every((s) => s.band === "foundation")).toBe(true);
      expect(new Set(added.map((s) => s.category_no)).size).toBe(5);
      expect(new Set(added.map((s) => s.no)).size).toBe(30); // no重複なし
      expect(logs.some((l) => l.includes("集計チェックPASS"))).toBe(true);
      expect(logs.some((l) => l.startsWith("完了:"))).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });

    test("既にquota(6件)充足済みのカテゴリはスキップされ、不足カテゴリのみ生成される（べき等な再実行）", async () => {
      const preExisting: Sentence[] = Array.from({ length: 6 }, (_, i) => ({
        no: 100 + i, category_no: SPOKEN_FUNCTION_CATEGORY_NO.request, category: SPOKEN_FUNCTION_CATEGORY_JA.request,
        domain: "daily", en: `Can you help me with task ${i}, please?`, ja: "既存の依頼文", note: "", band: "foundation",
      }));
      const { dir, file } = setupFile(preExisting);
      const remaining = SPOKEN_FUNCTIONS.filter((f) => f !== "request");
      const logs: string[] = [];
      await genSpokenFunctionSentencesForTarget({
        runner: makeRunner(remaining.map((f) => goodBatch(f))),
        sentencesFile: file, band: "foundation", dry: false, log: (s) => logs.push(s),
      });
      const after = loadSentences(file);
      expect(after).toHaveLength(5 + 6 + 24); // 既存5 + request6(据え置き) + 残り4カテゴリ×6
      expect(logs.some((l) => l.includes("request") && l.includes("充足済み"))).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });

    test("一部だけ既存(2件)のカテゴリは不足分(4件)だけ生成し、カテゴリ合計は6件になる", async () => {
      const partial: Sentence[] = Array.from({ length: 2 }, (_, i) => ({
        no: 100 + i, category_no: SPOKEN_FUNCTION_CATEGORY_NO.backchannel, category: SPOKEN_FUNCTION_CATEGORY_JA.backchannel,
        domain: "daily", en: `Oh really, number ${i}?`, ja: "既存の相槌文", note: "", band: "foundation",
      }));
      const { dir, file } = setupFile(partial);
      const others = SPOKEN_FUNCTIONS.filter((f) => f !== "backchannel");
      const responses = [...others.map((f) => goodBatch(f)), goodBatch("backchannel", 4)];
      await genSpokenFunctionSentencesForTarget({
        runner: makeRunner(responses), sentencesFile: file, band: "foundation", dry: false, log: () => {},
      });
      const after = loadSentences(file);
      const backchannelCount = after.filter((s) => s.category_no === SPOKEN_FUNCTION_CATEGORY_NO.backchannel).length;
      expect(backchannelCount).toBe(6);
      rmSync(dir, { recursive: true, force: true });
    });

    // 注意: カテゴリ単体には短縮形率(checkSpokenRegister)を要求しない — request(依頼)の定番表現
    // "Can/Could you ...?" は短縮不能で自然に短縮形0%になりうるため（validateSpokenFunctionSentencesの
    // コメント参照）。カテゴリ単体の再生成トリガーは書き言葉語彙・帯別語数上限のみ。
    test("書き言葉語彙(written vocab)を含む候補は再生成される", async () => {
      const { dir, file } = setupFile();
      const bannedBatch = JSON.stringify({ sentences: [
        { domain: "daily", en: "Moreover, could you help me with this request?", ja: "さらに、これを手伝ってもらえますか", note: "" },
        { domain: "daily", en: "Furthermore, I need this done by noon.", ja: "さらに、正午までに終わらせてほしい", note: "" },
        { domain: "business", en: "Therefore, please send me the request file.", ja: "したがって、依頼ファイルを送ってください", note: "" },
        { domain: "business", en: "In addition, could you check this request?", ja: "加えて、この依頼を確認してもらえますか", note: "" },
        { domain: "it", en: "Please utilize this tool for the request.", ja: "この依頼にはこのツールを使ってください", note: "" },
        { domain: "it", en: "Numerous individuals asked for this request.", ja: "多くの人がこの依頼をした", note: "" },
      ] });
      const logs: string[] = [];
      await genSpokenFunctionSentencesForTarget({
        runner: makeRunner([bannedBatch, goodBatch("request"), ...SPOKEN_FUNCTIONS.slice(1).map((f) => goodBatch(f))]),
        sentencesFile: file, band: "foundation", dry: false, log: (s) => logs.push(s),
      });
      expect(loadSentences(file)).toHaveLength(5 + 30);
      expect(logs.some((l) => l.includes("検証NG"))).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });

    test("帯別語数上限を超える候補は再生成される", async () => {
      const { dir, file } = setupFile();
      const tooLongBatch = JSON.stringify({ sentences: Array.from({ length: 6 }, (_, i) => ({
        domain: (["daily", "business", "it"] as const)[i % 3],
        en: "Would it be possible for you to help me carry this heavy box up the stairs please",
        ja: `長い依頼文${i}`, note: "",
      })) });
      const logs: string[] = [];
      await genSpokenFunctionSentencesForTarget({
        runner: makeRunner([tooLongBatch, goodBatch("request"), ...SPOKEN_FUNCTIONS.slice(1).map((f) => goodBatch(f))]),
        sentencesFile: file, band: "foundation", dry: false, log: (s) => logs.push(s),
      });
      expect(loadSentences(file)).toHaveLength(5 + 30);
      expect(logs.some((l) => l.includes("検証NG"))).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });

    // request(依頼)の自然な定番表現("Can/Could you ...?")は短縮不能で短縮形0%になりうるが、
    // カテゴリ単体としては正当な話し言葉のため検証を通ることの回帰防止テスト（実LLM生成での実障害の再現）。
    test("短縮形0%でもrequestの定番表現(Can/Could you...?)は単体では正当として通る", async () => {
      const { dir, file } = setupFile();
      const requestNoContraction = JSON.stringify({ sentences: [
        { domain: "daily", en: "Can you pass me the salt, please?", ja: "塩を取ってもらえますか。", note: "" },
        { domain: "daily", en: "Could you help me carry these bags?", ja: "この袋を運ぶのを手伝ってもらえますか。", note: "" },
        { domain: "business", en: "Can you send me the file by noon?", ja: "お昼までにファイルを送ってもらえますか。", note: "" },
        { domain: "business", en: "Could you check this report for me?", ja: "この報告書を確認してもらえますか。", note: "" },
        { domain: "it", en: "Can you restart the server, please?", ja: "サーバーを再起動してもらえますか。", note: "" },
        { domain: "it", en: "Could you reset my password for me?", ja: "パスワードをリセットしてもらえますか。", note: "" },
      ] });
      await genSpokenFunctionSentencesForTarget({
        runner: makeRunner([requestNoContraction, ...SPOKEN_FUNCTIONS.slice(1).map((f) => goodBatch(f))]),
        sentencesFile: file, band: "foundation", dry: false, log: () => {},
      });
      const requestSentences = loadSentences(file).filter((s) => s.category_no === SPOKEN_FUNCTION_CATEGORY_NO.request);
      expect(requestSentences).toHaveLength(6);
      rmSync(dir, { recursive: true, force: true });
    });

    test("3回とも検証NGなら書き込みゼロでthrow（3ラウンド規律）", async () => {
      const { dir, file } = setupFile();
      const bad = JSON.stringify({ sentences: [{ domain: "casual", en: "x", ja: "y", note: "z" }] });
      const before = readFileSync(file, "utf8");
      await expect(
        genSpokenFunctionSentencesForTarget({
          runner: makeRunner([bad, bad, bad]), sentencesFile: file, band: "foundation", dry: false,
        }),
      ).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toBe(before);
      rmSync(dir, { recursive: true, force: true });
    });

    test("dry=trueは一切書かない", async () => {
      const { dir, file } = setupFile();
      const before = readFileSync(file, "utf8");
      await genSpokenFunctionSentencesForTarget({
        runner: makeRunner(SPOKEN_FUNCTIONS.map((f) => goodBatch(f))),
        sentencesFile: file, band: "foundation", dry: true,
      });
      expect(readFileSync(file, "utf8")).toBe(before);
      rmSync(dir, { recursive: true, force: true });
    });

    // 集計(コーパス粒度)ゲートの実効性: 4カテゴリが既に教科書調(短縮形0%)で充足済み(べき等スキップ対象)、
    // 残り1カテゴリだけ今回新規生成する。新規バッチ自体は単体でcheckSpokenRegisterをPASSするが、
    // 既存4カテゴリ(24文・短縮形0%)と合算した帯全体(30文)では短縮形率が閾値未満になりFAILする。
    // 「After generation: corpus-level spoken-register check must PASS for all bands」ゲートの再発防止テスト。
    test("個々のカテゴリは検証を通っても、帯全体(30文)の集計で短縮形率が閾値未満ならthrowし何も追加しない", () => {
      return (async () => {
        const textbookCategories = SPOKEN_FUNCTIONS.filter((f) => f !== "backchannel");
        const preExisting: Sentence[] = textbookCategories.flatMap((f) => Array.from({ length: 6 }, (_, i) => ({
          no: 200 + SPOKEN_FUNCTION_CATEGORY_NO[f] * 10 + i, category_no: SPOKEN_FUNCTION_CATEGORY_NO[f],
          category: SPOKEN_FUNCTION_CATEGORY_JA[f], domain: "daily" as const,
          en: `I need to talk about ${f} number ${i}.`, ja: "教科書調の既存文", note: "", band: "foundation" as const,
        })));
        const { dir, file } = setupFile(preExisting);
        const before = readFileSync(file, "utf8");
        // このバッチ単体は短縮形2/6文=0.333で単体のcheckSpokenRegisterはPASSするが、
        // 既存24文(短縮形0)と合算した帯全体30文では 2/30=0.067 < 0.2 となり集計チェックのみFAILする
        // （単体チェックとの違いを明確にするため、あえて標準のgoodBatchより短縮形を絞った専用バッチを使う）。
        const sparseContractionBatch = JSON.stringify({ sentences: [
          { domain: "daily", en: "Oh really, that's interesting news.", ja: "そうなんだ", note: "" },
          { domain: "business", en: "Got it, thank you very much.", ja: "了解、ありがとう", note: "" },
          { domain: "it", en: "I see what you mean now.", ja: "言いたいことが分かった", note: "" },
          { domain: "daily", en: "Sure, that sounds good to me.", ja: "それでいいと思う", note: "" },
          { domain: "business", en: "Wow, I did not expect that.", ja: "それは予想外だった", note: "" },
          { domain: "it", en: "No way, that's really surprising!", ja: "まさか、本当に驚いた", note: "" },
        ] });
        await expect(
          genSpokenFunctionSentencesForTarget({
            runner: makeRunner([sparseContractionBatch]), sentencesFile: file, band: "foundation", dry: false,
          }),
        ).rejects.toThrow(/集計/);
        expect(readFileSync(file, "utf8")).toBe(before); // backchannelの新規6文も書き込まれない(all-or-nothing)
        rmSync(dir, { recursive: true, force: true });
      })();
    });
  });

  describe("genSpokenFunctionSentences（3帯ラッパー・foundation→development→fluencyの順）", () => {
    test("3帯すべてを生成し計90文(帯別30)が追加される", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "gen-sfw-"));
      const file = path.join(dir, "sentences.json");
      const EXISTING5: Sentence[] = [1, 2, 3, 4, 5].map((no) => ({
        no, category_no: 1, category: "現在形", domain: "daily", en: `Existing ${no}.`, ja: "既存", note: "",
      }));
      writeFileSync(file, JSON.stringify(EXISTING5, null, 2) + "\n");

      function goodBatchFor(band: string, fn: string): string {
        return JSON.stringify({ sentences: Array.from({ length: 6 }, (_, i) => ({
          domain: (["daily", "business", "it"] as const)[i % 3],
          en: `I can't ${fn} ${band} thing ${i}, sorry about that!`,
          ja: `日本語${band}${fn}${i}`, note: "",
        })) });
      }
      const bandsOrder = ["foundation", "development", "fluency"];
      const responses = bandsOrder.flatMap((band) => SPOKEN_FUNCTIONS.map((fn) => goodBatchFor(band, fn)));
      const logs: string[] = [];
      await genSpokenFunctionSentences({ runner: makeRunner(responses), sentencesFile: file, dry: false, log: (s) => logs.push(s) });

      const after = loadSentences(file);
      const added = after.slice(5);
      expect(added).toHaveLength(90);
      for (const band of bandsOrder) {
        expect(added.filter((s) => s.band === band)).toHaveLength(30);
      }
      expect(new Set(added.map((s) => s.no)).size).toBe(90);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("genMissingSentenceExplanations（解説の欠損補充・部分失敗を許容）", () => {
    const SENTS: Sentence[] = [1, 2, 3].map((no) => ({
      no, category_no: 26, category: "会話機能: 依頼する", domain: "daily", en: `Sentence ${no}.`, ja: `文${no}`, note: "note",
    }));

    function setup(explanationsSeed: Array<{ no: number; text: string }> = []) {
      const dir = mkdtempSync(path.join(tmpdir(), "gen-explain-"));
      const sentencesFile = path.join(dir, "sentences.json");
      const explanationsFile = path.join(dir, "explanations.json");
      writeFileSync(sentencesFile, JSON.stringify(SENTS, null, 2) + "\n");
      if (explanationsSeed.length > 0) writeFileSync(explanationsFile, JSON.stringify(explanationsSeed, null, 2) + "\n");
      return { dir, sentencesFile, explanationsFile };
    }

    test("解説が無い全noに生成し新規explanations.jsonへ書く", async () => {
      const { dir, sentencesFile, explanationsFile } = setup();
      const logs: string[] = [];
      await genMissingSentenceExplanations({
        runner: makeRunner(["解説1", "解説2", "解説3"]), sentencesFile, explanationsFile, dry: false, log: (s) => logs.push(s),
      });
      const map = loadBundledExplanations(explanationsFile);
      expect(map.size).toBe(3);
      expect(map.get(1)).toBe("解説1");
      expect(logs.some((l) => l.startsWith("完了:"))).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });

    test("既存解説がある分はスキップし、欠損分だけ追記する（既存は保持）", async () => {
      const { dir, sentencesFile, explanationsFile } = setup([{ no: 1, text: "既存の解説1" }]);
      await genMissingSentenceExplanations({
        runner: makeRunner(["解説2", "解説3"]), sentencesFile, explanationsFile, dry: false, log: () => {},
      });
      const map = loadBundledExplanations(explanationsFile);
      expect(map.size).toBe(3);
      expect(map.get(1)).toBe("既存の解説1"); // 既存は変更されない
      expect(map.get(2)).toBe("解説2");
      rmSync(dir, { recursive: true, force: true });
    });

    test("全て欠損なしなら何もせず正常終了", async () => {
      const { dir, sentencesFile, explanationsFile } = setup([
        { no: 1, text: "a" }, { no: 2, text: "b" }, { no: 3, text: "c" },
      ]);
      const logs: string[] = [];
      await genMissingSentenceExplanations({
        runner: makeRunner(["呼ばれないはず"]), sentencesFile, explanationsFile, dry: false, log: (s) => logs.push(s),
      });
      expect(logs.some((l) => l.includes("欠損はありません"))).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });

    test("1件の生成失敗はスキップして継続し、他は正常に書き込まれる", async () => {
      const { dir, sentencesFile, explanationsFile } = setup();
      let n = 0;
      const runner: ClaudeRunner = async () => {
        n++;
        if (n === 2) throw new Error("一時的な失敗");
        return { text: `解説${n}`, sessionId: "fake" };
      };
      const logs: string[] = [];
      await genMissingSentenceExplanations({ runner, sentencesFile, explanationsFile, dry: false, log: (s) => logs.push(s) });
      const map = loadBundledExplanations(explanationsFile);
      expect(map.size).toBe(2); // no.2は失敗してスキップ
      expect(logs.some((l) => l.includes("失敗"))).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });

    test("dry=trueは一切書かない", async () => {
      const { dir, sentencesFile, explanationsFile } = setup();
      await genMissingSentenceExplanations({
        runner: makeRunner(["解説1", "解説2", "解説3"]), sentencesFile, explanationsFile, dry: true, log: () => {},
      });
      expect(existsSync(explanationsFile)).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
