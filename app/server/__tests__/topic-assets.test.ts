import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../db";
import { contentToMarkdown } from "../content-gen";
import type { ContentItem } from "../content";
import type { PrepPack } from "../coach";
import type { ClaudeRunner } from "../converse";
import {
  TOPIC_ASSET_PROMPT_VERSION,
  computeSourceHash,
  parseTopicAssetFile,
  resolveBundledEntry,
  lookupBundledTopicAsset,
  ensureTopicAssetCacheSchema,
  makeTopicAssetCacheStore,
  resolvePrepPack,
  resolveModelTalk,
  genTopicAssetSlot,
  genTopicAssets,
} from "../topic-assets";

/** systemPrompt の内容で prepPack 用/model talk 用の呼び出しを判別する fake ClaudeRunner。
 *  coach.ts の prepSystem/modelTalkSystem の冒頭文言は生成物の一部ではなく固定文言なので判別キーとして安全。 */
function makeSlotRunner(prepResponses: Array<string | Error>, talkResponses: Array<string | Error>): { runner: ClaudeRunner; state: { prepCalls: number; talkCalls: number } } {
  const state = { prepCalls: 0, talkCalls: 0 };
  const runner: ClaudeRunner = async (_prompt, _resumeId, opts) => {
    const isPrep = opts?.systemPrompt?.startsWith("You prepare a Japanese IT professional") ?? false;
    if (isPrep) {
      const response = prepResponses[Math.min(state.prepCalls, prepResponses.length - 1)];
      state.prepCalls++;
      if (response instanceof Error) throw response;
      return { text: response, sessionId: "fake" };
    }
    const response = talkResponses[Math.min(state.talkCalls, talkResponses.length - 1)];
    state.talkCalls++;
    if (response instanceof Error) throw response;
    return { text: response, sessionId: "fake" };
  };
  return { runner, state };
}

const PASSING_PREP_JSON = JSON.stringify({
  chunks: [{ en: "The main problem was a slow database query.", ja: "主な問題は遅いDBクエリでした。" }],
  outline: ["opening"],
});
// 2語(<4語の下限)で checkPrepChunk の語数チェックに落ちる
const FAILING_PREP_JSON = JSON.stringify({ chunks: [{ en: "Hi.", ja: "やあ。" }], outline: ["opening"] });
const PASSING_TALK = "I'm glad to talk about this today. It's simple, so let's start now. I don't think it's too hard.";
// 短縮形0%の教科書調（全帯で checkModelTalk の短縮形率下限に落ちる）
const FAILING_TALK = "I do not like doing this every day. I do not think it is fun at all.";

const SAMPLE_TOPIC: ContentItem = {
  id: "t1", kind: "topic", title: "My daily routine", titleJa: "毎日の日課",
  hints: ["Wake up — 起きる"], starters: [], domain: "daily", level: [3, 4],
};

const SAMPLE_PREP_PACK: PrepPack = {
  chunks: [{ en: "Hi there.", ja: "やあ。" }], outline: ["opening"], hintDefault: "ja",
};

describe("topic-assets / computeSourceHash", () => {
  test("同じ内容は同じハッシュ、内容が変われば別ハッシュ（sha256 hex 64桁）", () => {
    const h1 = computeSourceHash("hello");
    const h2 = computeSourceHash("hello");
    const h3 = computeSourceHash("hello!");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("topic-assets / parseTopicAssetFile", () => {
  test("正常系: 必須フィールドが揃っていればパースできる", () => {
    const raw = JSON.stringify({
      topicId: "t1", sourceHash: "abc", promptVersion: TOPIC_ASSET_PROMPT_VERSION,
      byStage: { "3": { prepPack: SAMPLE_PREP_PACK, modelTalk: { text: "hello" } } },
    });
    const parsed = parseTopicAssetFile(raw);
    expect(parsed?.topicId).toBe("t1");
    expect(parsed?.byStage["3"].prepPack).toEqual(SAMPLE_PREP_PACK);
    expect(parsed?.byStage["3"].modelTalk).toEqual({ text: "hello" });
  });

  test("不正JSON文字列はnull", () => {
    expect(parseTopicAssetFile("{not json")).toBeNull();
  });

  test("必須フィールド欠如はnull", () => {
    expect(parseTopicAssetFile(JSON.stringify({ topicId: "t1" }))).toBeNull();
  });

  test("byStageの1エントリでもprepPackが不正なら全体を無効化する（部分救済しない）", () => {
    const raw = JSON.stringify({
      topicId: "t1", sourceHash: "abc", promptVersion: TOPIC_ASSET_PROMPT_VERSION,
      byStage: { "3": { prepPack: { chunks: "not-an-array" }, modelTalk: { text: "hello" } } },
    });
    expect(parseTopicAssetFile(raw)).toBeNull();
  });

  test("modelTalkのtextが空文字は不正", () => {
    const raw = JSON.stringify({
      topicId: "t1", sourceHash: "abc", promptVersion: TOPIC_ASSET_PROMPT_VERSION,
      byStage: { "3": { modelTalk: { text: "" } } },
    });
    expect(parseTopicAssetFile(raw)).toBeNull();
  });
});

describe("topic-assets / resolveBundledEntry（純ロジック・stale判定）", () => {
  const asset = {
    topicId: "t1", sourceHash: "HASH-A", promptVersion: TOPIC_ASSET_PROMPT_VERSION,
    byStage: { "3": { modelTalk: { text: "stage3 talk" } }, "4": { modelTalk: { text: "stage4 talk" } } },
  };

  test("hash/version一致・対象stageが存在: そのエントリを返しstale=false", () => {
    const { entry, stale } = resolveBundledEntry(asset, "HASH-A", 3);
    expect(stale).toBe(false);
    expect(entry?.modelTalk?.text).toBe("stage3 talk");
  });

  test("対象stageが存在しない: entry=null・stale=false（staleとは別物）", () => {
    const { entry, stale } = resolveBundledEntry(asset, "HASH-A", 5);
    expect(entry).toBeNull();
    expect(stale).toBe(false);
  });

  test("sourceHash不一致: stale=true・entry=null", () => {
    const { entry, stale } = resolveBundledEntry(asset, "HASH-B", 3);
    expect(stale).toBe(true);
    expect(entry).toBeNull();
  });

  test("promptVersion不一致: stale=true・entry=null", () => {
    const { entry, stale } = resolveBundledEntry({ ...asset, promptVersion: "old" }, "HASH-A", 3);
    expect(stale).toBe(true);
    expect(entry).toBeNull();
  });

  test("asset自体がnull: stale=false・entry=null", () => {
    expect(resolveBundledEntry(null, "HASH-A", 3)).toEqual({ entry: null, stale: false });
  });
});

describe("topic-assets / lookupBundledTopicAsset（fs統合・3層の第1層）", () => {
  test("topic/assetファイルが揃いhash一致: 該当stageのエントリを返す", () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-assets-"));
    const topicContent = "---\nid: t1\n---\nTalk about:\n- x\n";
    writeFileSync(path.join(topicsDir, "t1.md"), topicContent);
    writeFileSync(path.join(assetsDir, "t1.json"), JSON.stringify({
      topicId: "t1", sourceHash: computeSourceHash(topicContent), promptVersion: TOPIC_ASSET_PROMPT_VERSION,
      byStage: { "1": { modelTalk: { text: "hello" } } },
    }));
    expect(lookupBundledTopicAsset(assetsDir, topicsDir, "t1", 1)?.modelTalk?.text).toBe("hello");
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  test("topic内容が変わった(sourceHash不一致)場合はnull（staleフォールバック）", () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-assets-"));
    writeFileSync(path.join(topicsDir, "t1.md"), "original content");
    writeFileSync(path.join(assetsDir, "t1.json"), JSON.stringify({
      topicId: "t1", sourceHash: computeSourceHash("original content"), promptVersion: TOPIC_ASSET_PROMPT_VERSION,
      byStage: { "1": { modelTalk: { text: "hello" } } },
    }));
    writeFileSync(path.join(topicsDir, "t1.md"), "changed content"); // topicが再生成された想定
    expect(lookupBundledTopicAsset(assetsDir, topicsDir, "t1", 1)).toBeNull();
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  test("asset JSON自体が存在しない場合はnull", () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-assets-"));
    writeFileSync(path.join(topicsDir, "t1.md"), "x");
    expect(lookupBundledTopicAsset(assetsDir, topicsDir, "t1", 1)).toBeNull();
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  test("topicファイル自体が存在しない場合はnull", () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-assets-"));
    writeFileSync(path.join(assetsDir, "t1.json"), JSON.stringify({
      topicId: "t1", sourceHash: "x", promptVersion: TOPIC_ASSET_PROMPT_VERSION, byStage: {},
    }));
    expect(lookupBundledTopicAsset(assetsDir, topicsDir, "t1", 1)).toBeNull();
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });
});

describe("topic-assets / DBキャッシュ層（ensureTopicAssetCacheSchema + makeTopicAssetCacheStore・3層の第2層）", () => {
  function memStore() {
    return makeTopicAssetCacheStore(openDb(":memory:"));
  }

  test("prepPack: save→getで復元でき、stageが違えば別物として扱う", () => {
    const store = memStore();
    expect(store.getPrepPack("t1", 3)).toBeNull();
    store.savePrepPack("t1", 3, SAMPLE_PREP_PACK);
    expect(store.getPrepPack("t1", 3)).toEqual(SAMPLE_PREP_PACK);
    expect(store.getPrepPack("t1", 4)).toBeNull();
  });

  test("prepPack: 同一topic/stageへの再saveは上書き（upsert）", () => {
    const store = memStore();
    const packB: PrepPack = { chunks: [{ en: "B.", ja: "い" }], outline: [], hintDefault: "en" };
    store.savePrepPack("t1", 3, SAMPLE_PREP_PACK);
    store.savePrepPack("t1", 3, packB);
    expect(store.getPrepPack("t1", 3)).toEqual(packB);
  });

  test("modelTalk: save→getで復元でき、upsertで上書きされる", () => {
    const store = memStore();
    expect(store.getModelTalk("t1", 5)).toBeNull();
    store.saveModelTalk("t1", 5, "first");
    expect(store.getModelTalk("t1", 5)).toBe("first");
    store.saveModelTalk("t1", 5, "second");
    expect(store.getModelTalk("t1", 5)).toBe("second");
  });

  test("openDb: prep_pack_cache / model_talk_cache テーブルを作成する", () => {
    const db = openDb(":memory:");
    ensureTopicAssetCacheSchema(db); // 冪等（openDb 内で既に呼ばれている前提の重複呼び出しでも壊れない）
    for (const name of ["prep_pack_cache", "model_talk_cache"]) {
      const row = db.query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      ).get(name);
      expect(row?.name).toBe(name);
    }
  });
});

describe("topic-assets / resolvePrepPack・resolveModelTalk（3層フォールバック）", () => {
  test("同梱JSONがあれば最優先で返し、generateもDB書き込みも起きない", async () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-resolve-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-resolve-assets-"));
    const topicContent = "---\nid: t1\n---\n";
    writeFileSync(path.join(topicsDir, "t1.md"), topicContent);
    const bundledPack: PrepPack = { chunks: [{ en: "Bundled.", ja: "同梱" }], outline: [], hintDefault: "ja" };
    writeFileSync(path.join(assetsDir, "t1.json"), JSON.stringify({
      topicId: "t1", sourceHash: computeSourceHash(topicContent), promptVersion: TOPIC_ASSET_PROMPT_VERSION,
      byStage: { "3": { prepPack: bundledPack } },
    }));
    let generateCalls = 0;
    const cache = makeTopicAssetCacheStore(openDb(":memory:"));
    const result = await resolvePrepPack("t1", 3, { assetsDir, topicsDir, cache }, async () => {
      generateCalls++;
      return { chunks: [], outline: [], hintDefault: "ja" };
    });
    expect(result).toEqual(bundledPack);
    expect(generateCalls).toBe(0);
    expect(cache.getPrepPack("t1", 3)).toBeNull(); // 同梱ヒット時はDBへ書かない
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  test("同梱が無い場合: 1回目はgenerateしDBへ書き込み、2回目はDBから返しgenerateを呼ばない（reuse regression）", async () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-resolve-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-resolve-assets-"));
    let generateCalls = 0;
    const cache = makeTopicAssetCacheStore(openDb(":memory:"));
    const generate = async () => {
      generateCalls++;
      return { text: `talk-${generateCalls}` };
    };
    const first = await resolveModelTalk("t1", 3, { assetsDir, topicsDir, cache }, generate);
    const second = await resolveModelTalk("t1", 3, { assetsDir, topicsDir, cache }, generate);
    expect(generateCalls).toBe(1);
    expect(first.text).toBe("talk-1");
    expect(second.text).toBe("talk-1");
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  test("同梱がstale(topic内容変更)の場合はDB層→generateへフォールバックする", async () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-resolve-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-resolve-assets-"));
    writeFileSync(path.join(topicsDir, "t1.md"), "original");
    writeFileSync(path.join(assetsDir, "t1.json"), JSON.stringify({
      topicId: "t1", sourceHash: computeSourceHash("original"), promptVersion: TOPIC_ASSET_PROMPT_VERSION,
      byStage: { "3": { modelTalk: { text: "stale bundled talk" } } },
    }));
    writeFileSync(path.join(topicsDir, "t1.md"), "changed"); // stale化
    let generateCalls = 0;
    const cache = makeTopicAssetCacheStore(openDb(":memory:"));
    const result = await resolveModelTalk("t1", 3, { assetsDir, topicsDir, cache }, async () => {
      generateCalls++;
      return { text: "freshly generated" };
    });
    expect(result.text).toBe("freshly generated");
    expect(generateCalls).toBe(1);
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  test("stageが違えばDBキャッシュはヒットせず別途generateする", async () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-resolve-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-resolve-assets-"));
    let generateCalls = 0;
    const cache = makeTopicAssetCacheStore(openDb(":memory:"));
    const generate = async () => {
      generateCalls++;
      return { text: `talk-for-call-${generateCalls}` };
    };
    await resolveModelTalk("t1", 3, { assetsDir, topicsDir, cache }, generate);
    await resolveModelTalk("t1", 4, { assetsDir, topicsDir, cache }, generate);
    expect(generateCalls).toBe(2);
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });
});

describe("topic-assets / genTopicAssetSlot（1スロットのprepPack+model talk・hard-failゲート）", () => {
  test("両方1発でPASSすれば1回ずつの呼び出しで完了する", async () => {
    const { runner, state } = makeSlotRunner([PASSING_PREP_JSON], [PASSING_TALK]);
    const result = await genTopicAssetSlot({ runner, topic: SAMPLE_TOPIC, stage: 3 });
    expect(result.prepPack?.chunks).toHaveLength(1);
    expect(result.modelTalk?.text).toBe(PASSING_TALK);
    expect(state.prepCalls).toBe(1);
    expect(state.talkCalls).toBe(1);
  });

  test("checkPrepChunkでFAILする候補は再生成され、modelTalk側は先にPASS済みなら再生成しない", async () => {
    const { runner, state } = makeSlotRunner([FAILING_PREP_JSON, PASSING_PREP_JSON], [PASSING_TALK]);
    const logs: string[] = [];
    const result = await genTopicAssetSlot({ runner, topic: SAMPLE_TOPIC, stage: 3, log: (s) => logs.push(s) });
    expect(result.prepPack?.chunks[0].en).toContain("main problem");
    expect(state.prepCalls).toBe(2);
    expect(state.talkCalls).toBe(1);
    expect(logs.some((l) => l.includes("prepPack") && l.includes("検証NG"))).toBe(true);
  });

  test("checkModelTalkでFAILする候補(短縮形0%の教科書調)は再生成される", async () => {
    const { runner, state } = makeSlotRunner([PASSING_PREP_JSON], [FAILING_TALK, PASSING_TALK]);
    const result = await genTopicAssetSlot({ runner, topic: SAMPLE_TOPIC, stage: 3 });
    expect(result.modelTalk?.text).toBe(PASSING_TALK);
    expect(state.talkCalls).toBe(2);
  });

  test("3回とも検証NGならエラーをthrowする（3ラウンド規律）", async () => {
    const { runner } = makeSlotRunner([FAILING_PREP_JSON, FAILING_PREP_JSON, FAILING_PREP_JSON], [PASSING_TALK]);
    await expect(genTopicAssetSlot({ runner, topic: SAMPLE_TOPIC, stage: 3 })).rejects.toThrow();
  });

  test("runnerの一過性例外はwarnへ原因を残して同じslot内で再試行する", async () => {
    const { runner, state } = makeSlotRunner(
      [new Error("temporary prep failure"), PASSING_PREP_JSON],
      [new Error("temporary talk failure"), PASSING_TALK],
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await genTopicAssetSlot({ runner, topic: SAMPLE_TOPIC, stage: 3 });
      expect(result.prepPack?.chunks).toHaveLength(1);
      expect(result.modelTalk?.text).toBe(PASSING_TALK);
      expect(state.prepCalls).toBe(2);
      expect(state.talkCalls).toBe(2);
      expect(warn).toHaveBeenCalledWith("[topic-assets] prepPack runner error:", "temporary prep failure");
      expect(warn).toHaveBeenCalledWith("[topic-assets] modelTalk runner error:", "temporary talk failure");
    } finally {
      warn.mockRestore();
    }
  });

  test("runner例外が3回続いたslotだけthrowする", async () => {
    const { runner, state } = makeSlotRunner(
      [new Error("failure 1"), new Error("failure 2"), new Error("failure 3")],
      [PASSING_TALK],
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(genTopicAssetSlot({ runner, topic: SAMPLE_TOPIC, stage: 3 })).rejects.toThrow(/3回とも/);
      expect(state.prepCalls).toBe(3);
      expect(state.talkCalls).toBe(1);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("topic-assets / genTopicAssets（quota topics一括生成・べき等）", () => {
  function writeTopic(dir: string, id: string, level: [number, number], domain: ContentItem["domain"] = "daily"): string {
    const content = contentToMarkdown({
      id, kind: "topic", title: `Title ${id}`, titleJa: `タイトル${id}`, domain, level, hints: ["Hint one — ヒント1"],
    });
    writeFileSync(path.join(dir, `${id}.md`), content);
    return content;
  }

  test("bridge教材(level幅が帯をまたぐ)はquota対象から除外される", async () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-gen-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-gen-assets-"));
    writeTopic(topicsDir, "bridge-1", [1, 4]); // foundation~developmentをまたぐ = bridge
    writeTopic(topicsDir, "quota-1", [3, 4]); // developmentちょうど = quota対象
    const { runner } = makeSlotRunner([PASSING_PREP_JSON, PASSING_PREP_JSON], [PASSING_TALK, PASSING_TALK]);
    const result = await genTopicAssets({ runner, topicsDir, assetsDir, force: false });
    expect(existsSync(path.join(assetsDir, "quota-1.json"))).toBe(true);
    expect(existsSync(path.join(assetsDir, "bridge-1.json"))).toBe(false);
    expect(result.written).toBe(1);
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  test("1topicにつき帯内2stage分のprepPack/modelTalkが書き込まれる", async () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-gen-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-gen-assets-"));
    writeTopic(topicsDir, "quota-1", [3, 4]);
    const { runner } = makeSlotRunner(
      [PASSING_PREP_JSON, PASSING_PREP_JSON],
      [PASSING_TALK, PASSING_TALK],
    );
    await genTopicAssets({ runner, topicsDir, assetsDir, force: false });
    const file = parseTopicAssetFile(readFileSync(path.join(assetsDir, "quota-1.json"), "utf8"))!;
    expect(file.topicId).toBe("quota-1");
    expect(file.byStage["3"].prepPack).toBeDefined();
    expect(file.byStage["3"].modelTalk).toBeDefined();
    expect(file.byStage["4"].prepPack).toBeDefined();
    expect(file.byStage["4"].modelTalk).toBeDefined();
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  test("既存ファイルが新鮮(sourceHash/promptVersion一致・両stage揃い済み)ならスキップしrunnerを呼ばない", async () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-gen-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-gen-assets-"));
    writeTopic(topicsDir, "quota-1", [3, 4]);
    const first = makeSlotRunner([PASSING_PREP_JSON, PASSING_PREP_JSON], [PASSING_TALK, PASSING_TALK]);
    await genTopicAssets({ runner: first.runner, topicsDir, assetsDir, force: false });

    const second = makeSlotRunner([PASSING_PREP_JSON], [PASSING_TALK]);
    const result = await genTopicAssets({ runner: second.runner, topicsDir, assetsDir, force: false });
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(second.state.prepCalls).toBe(0);
    expect(second.state.talkCalls).toBe(0);
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  test("force:trueは新鮮でも再生成する", async () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-gen-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-gen-assets-"));
    writeTopic(topicsDir, "quota-1", [3, 4]);
    const first = makeSlotRunner([PASSING_PREP_JSON, PASSING_PREP_JSON], [PASSING_TALK, PASSING_TALK]);
    await genTopicAssets({ runner: first.runner, topicsDir, assetsDir, force: false });

    const second = makeSlotRunner([PASSING_PREP_JSON, PASSING_PREP_JSON], [PASSING_TALK, PASSING_TALK]);
    const result = await genTopicAssets({ runner: second.runner, topicsDir, assetsDir, force: true });
    expect(result.written).toBe(1);
    expect(second.state.prepCalls).toBe(2);
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  test("topic内容が変わった(sourceHash不一致)場合は既存があってもstaleとして再生成する", async () => {
    const topicsDir = mkdtempSync(path.join(tmpdir(), "ta-gen-topics-"));
    const assetsDir = mkdtempSync(path.join(tmpdir(), "ta-gen-assets-"));
    writeTopic(topicsDir, "quota-1", [3, 4]);
    const first = makeSlotRunner([PASSING_PREP_JSON, PASSING_PREP_JSON], [PASSING_TALK, PASSING_TALK]);
    await genTopicAssets({ runner: first.runner, topicsDir, assetsDir, force: false });

    writeTopic(topicsDir, "quota-1", [3, 4], "business"); // domain変更でファイル内容(=sourceHash)を変える
    const second = makeSlotRunner([PASSING_PREP_JSON, PASSING_PREP_JSON], [PASSING_TALK, PASSING_TALK]);
    const result = await genTopicAssets({ runner: second.runner, topicsDir, assetsDir, force: false });
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);
    rmSync(topicsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });
});
