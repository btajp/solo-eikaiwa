import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../db";
import { loadContent, parseContentFile } from "../content";
import { loadSentences, type Sentence } from "../sentences";
import type { ClaudeRunner } from "../converse";
import {
  contentToMarkdown, genSentences, genTopics,
  validateNewSentences, validateTopicCandidate,
} from "../content-gen";
import { pickWorstCategories, type CategoryRate } from "../srs-analytics";

/** 呼び出し順にレスポンスを返す fake ClaudeRunner（実Claude呼び出し・実content/への書き込みは一切しない） */
function makeRunner(responses: string[]): ClaudeRunner {
  let i = 0;
  return async () => {
    const text = responses[Math.min(i, responses.length - 1)];
    i++;
    return { text, sessionId: "fake" };
  };
}

function seedSrs(db: ReturnType<typeof openDb>, no: number, lastGrade: string): void {
  db.run(
    "INSERT INTO sentence_srs (no, stage, due, last_grade, reviews) VALUES (?, 0, '2026-08-01', ?, 1)",
    [no, lastGrade],
  );
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
    await genSentences({ runner: makeRunner([VALID_BATCH]), sentencesFile: file, db, dry: false, log: (s) => logs.push(s) });

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
      runner: makeRunner([dupBatch, VALID_BATCH]), sentencesFile: file, db, dry: false, log: (s) => logs.push(s),
    });
    expect(loadSentences(file)).toHaveLength(9);
    expect(logs.some((l) => l.includes("検証NG"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("不正出力が2回続くと書き込みゼロでthrow", async () => {
    const { dir, file, db } = setup();
    const invalidBatch = JSON.stringify({ sentences: [{ domain: "casual", en: "x", ja: "y", note: "z" }] });
    const before = readFileSync(file, "utf8");
    await expect(
      genSentences({ runner: makeRunner([invalidBatch, invalidBatch]), sentencesFile: file, db, dry: false }),
    ).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry=trueは一切書かない", async () => {
    const { dir, file, db } = setup();
    const before = readFileSync(file, "utf8");
    const logs: string[] = [];
    await genSentences({ runner: makeRunner([VALID_BATCH]), sentencesFile: file, db, dry: true, log: (s) => logs.push(s) });
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
    await genSentences({ runner: makeRunner([VALID_BATCH]), sentencesFile: file, db, dry: false, log: (s) => logs.push(s) });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(logs.some((l) => l.startsWith("データ不足"))).toBe(true);
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
  function contentJson(id: string, domain: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      id, title: `Title ${id}`, titleJa: `タイトル${id}`, domain,
      level: [2, 4], hints: ["a — あ", "b — い", "c — う", "d — え"],
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
});
