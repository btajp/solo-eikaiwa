import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RouteDeps } from "../../routes";
import type { SentenceStore } from "../../sentences";
import type { ChunkStore } from "../../chunks";
import type { ProgressStore } from "../../progress-store";
import type { PlacementStore } from "../../placement";
import type { LibraryStore, TalkExplainCache } from "../../db";
import type { AssessmentStore } from "../../assessment";
import type { Menu, QuickKind } from "../../menu";
import type { ListeningItem } from "../../listening";
import type { ListeningStore } from "../../listening-store";
import type { FeedbackStore } from "../../feedback-store";
import type { LlmRole, LlmRoleSetting } from "../../llm-provider";
import type { RoleTuning } from "../../llm-role-tuning-store";
import type { CatalogResult, LlmCatalogProvider } from "../../providers/model-catalog";
import type { LlmAuthModes } from "../../llm-auth-store";
import type { DownloadState, ModelDownloadManager, WhisperModelId } from "../../model-download";
import type { SrsReviewStore } from "../../srs-review-store";

export const FAKE_HEALTH = {
  ok: true, whisper: true, ffmpeg: true, claude: true, ttsKey: true, modelFile: true,
  app: "solo-eikaiwa" as const, version: "0.0.0-test", llmReady: true,
};
export const FAKE_MENU = {
  minutes: 60 as const,
  date: "2026-07-05",
  level: 13,
  blocks: [{ id: "b1", kind: "reflection", title: "振り返り", titleKey: "reflection", minutes: 5, params: {} }],
} satisfies Menu;
export const FAKE_QUICK_MENU = {
  minutes: 6,
  date: "2026-07-05",
  level: 13,
  blocks: [{ id: "q1", kind: "warmup-reading", title: "音読ウォームアップ", titleKey: "warmup", minutes: 6, params: {} }],
} satisfies Menu;
export const FAKE_AE = { items: [{ quote: "q", issue: "i", better: "b", why_ja: "w" }], praise: "p" };
export const FAKE_REFLECTION = { goodPhrases: ["g"], fixes: [], noteForTomorrow_ja: "n" };
export const FAKE_SENTENCE = {
  no: 1, category_no: 1, category: "現在形", domain: "daily" as const,
  en: "I usually start work at nine.", ja: "たいてい9時に仕事を始めます。", note: "習慣の現在形",
  srs: null,
};
export const FAKE_SUMMARY = {
  level: 13, xp: 0, xpIntoLevel: 0, xpToNext: 25, stage: 2, difficultyMaxed: false, proposal: null,
};

export function makeFakeSentenceStore(overrides: Partial<SentenceStore> = {}): SentenceStore {
  return {
    list: () => [FAKE_SENTENCE],
    queue: (_newCount: number) => [FAKE_SENTENCE],
    grade: (no: number, _grade: "good" | "soso" | "bad") =>
      no === 1 ? { no: 1, stage: 1, due: "2026-07-09" } : null,
    getExplanation: (_no: number) => null,
    saveExplanation: (_no: number, _text: string) => {},
    find: (no: number) => (no === 1 ? FAKE_SENTENCE : undefined),
    ...overrides,
  } satisfies SentenceStore;
}

export function makeFakeChunkStore(overrides: Partial<ChunkStore> = {}): ChunkStore {
  return {
    collect: (_c) => [],
    list: () => [],
    listHidden: () => [],
    dueChunks: () => [],
    grade: (id, _g) => (id === 1 ? { id: 1, stage: 1, due: "2026-07-09" } : null),
    setHidden: (id, _hidden) => id === 1,
    ...overrides,
  } satisfies ChunkStore;
}

export function makeFakeProgressStore(overrides: Partial<ProgressStore> = {}): ProgressStore {
  return {
    getLevel: () => 13,
    getSummary: () => FAKE_SUMMARY,
    addXp: (kind, amount) =>
      kind === "block" && Number.isInteger(amount) && amount >= 1 && amount <= 60 ? FAKE_SUMMARY
      : kind === "srs-grade" ? FAKE_SUMMARY : null,
    blockStart: (_kind) => ({ attemptId: 7 }),
    completeBlock: (amount) => Number.isInteger(amount) && amount >= 1 && amount <= 60
      ? { status: "applied", summary: FAKE_SUMMARY }
      : { status: "invalid", summary: null },
    abortBlock: (_attemptId, _blockKind) => ({ status: "aborted" }),
    levelAction: (action, level) =>
      action === "set" && Number.isInteger(level) && (level as number) >= 1
        ? { status: "applied", summary: FAKE_SUMMARY, levelChanged: true } : null,
    placementSet: (_level) => ({ status: "applied", summary: FAKE_SUMMARY, levelChanged: true }),
    xpByDay: () => ({ "2026-07-01": 32 }),
    ...overrides,
  } satisfies ProgressStore;
}

export function makeFakeSrsReviewStore(overrides: Partial<SrsReviewStore> = {}): SrsReviewStore {
  return {
    apply: (_input, mutate) => {
      const result = mutate();
      return result === null ? { status: "missing" } : { status: "applied", ...result };
    },
    ...overrides,
  };
}

export function makeFakePlacementStore(overrides: Partial<PlacementStore> = {}): PlacementStore {
  return {
    save: (r) => ({ id: 1, ts: "2026-07-06T00:00:00.000Z", stage: r.stage, startLevel: r.startLevel, rationale: r.rationale }),
    latest: () => null,
    ...overrides,
  } satisfies PlacementStore;
}

export function makeFakeLibraryStore(overrides: Partial<LibraryStore> = {}): LibraryStore {
  return {
    saveModelTalk: (_e) => {},
    listModelTalks: () => [],
    ...overrides,
  } satisfies LibraryStore;
}

export function makeFakeAssessmentStore(overrides: Partial<AssessmentStore> = {}): AssessmentStore {
  return {
    save: (r) => ({ id: 1, ts: "2026-07-06T00:00:00.000Z", ymd: r.ymd, text: r.text }),
    latest: () => null,
    list: () => [],
    findByMonth: () => null,
    ...overrides,
  } satisfies AssessmentStore;
}

export const FAKE_LISTENING_ITEM: ListeningItem = {
  id: "morning-routine", title: "My morning routine", titleJa: "朝のルーティン",
  domain: "daily", level: [1, 3], paragraphs: ["I wake up at seven.", "Then I make coffee."],
};

export function makeFakeListeningStore(overrides: Partial<ListeningStore> = {}): ListeningStore {
  return {
    log: (itemId, ymd) => ({
      status: "recorded",
      row: { id: 1, ts: "2026-07-07T00:00:00.000Z", ymd, itemId },
    }),
    countSince: () => 0,
    ...overrides,
  } satisfies ListeningStore;
}

export function makeFakeFeedbackStore(overrides: Partial<FeedbackStore> = {}): FeedbackStore {
  return {
    save: (input) => ({ id: 1, ts: "2026-07-07T00:00:00.000Z", ...input }),
    list: () => [],
    ...overrides,
  } satisfies FeedbackStore;
}

const FAKE_IDLE_DOWNLOAD_STATE: DownloadState = {
  status: "idle", model: null, receivedBytes: 0, totalBytes: 0, error: null, resumable: false,
};

export function makeFakeModelDownloadManager(overrides: Partial<ModelDownloadManager> = {}): ModelDownloadManager {
  return {
    getState: () => FAKE_IDLE_DOWNLOAD_STATE,
    start: (_model: WhisperModelId) => ({ ok: true, done: Promise.resolve() }),
    cancel: () => {},
    diskFreeBytes: () => 100_000_000_000,
    installedModels: () => ({ "large-v3-turbo": true, small: false }),
    ...overrides,
  } satisfies ModelDownloadManager;
}

export function makeFakeTalkExplainCache(overrides: Partial<TalkExplainCache> = {}): TalkExplainCache {
  return {
    get: (_hash) => null,
    save: (_hash, _text, _created) => {},
    ...overrides,
  } satisfies TalkExplainCache;
}

/** テストごとに独立した temp dir/log を持つフェイク RouteDeps を組み立てる */
export function makeTestDeps(overrides: Partial<RouteDeps> = {}): {
  deps: RouteDeps;
  logFile: string;
  recordingsDir: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "routes-"));
  const logFile = path.join(dir, "log.jsonl");
  const recordingsDir = path.join(dir, "recordings");
  const deps: RouteDeps = {
    transcribe: async (_inputPath: string) => ({ text: "fake transcript", segments: [] }),
    synthesize: async (_text: string) => ({ audio: new Uint8Array([1, 2, 3]), mime: "audio/mpeg", engine: "say" as const }),
    converse: async (args: { userText: string; sessionId?: string; activitySessionId?: string }) => ({
      replyText: `echo: ${args.userText}`, sessionId: args.sessionId ?? "sess-fake",
    }),
    health: () => FAKE_HEALTH,
    logFile: () => logFile,
    recordingsDir,
    buildMenu: (_minutes) => FAKE_MENU,
    aeFeedback: async () => FAKE_AE,
    modelTalk: async (topicId: string) => (topicId === "known-topic" ? { text: "model talk" } : null),
    reflection: async () => FAKE_REFLECTION,
    scenarioPrompt: (id: string) => (id === "known-scenario" ? "ROLEPLAY PROMPT" : null),
    conversationStage: () => 2,
    prepPack: async () => ({ chunks: [{ en: "The main problem was ...", ja: "一番の問題は…" }], outline: ["Opening"], hintDefault: "ja" }),
    buildQuick: (_kind: QuickKind) => FAKE_QUICK_MENU,
    practiceDays: () => ["2026-07-01", "2026-07-03"],
    getSettings: () => ({ anchor: "" }),
    saveSettings: (_s) => {},
    libraryStore: makeFakeLibraryStore(),
    libraryTopics: () => new Map(),
    sentenceStore: makeFakeSentenceStore(),
    chunkStore: makeFakeChunkStore(),
    progressStore: makeFakeProgressStore(),
    srsReviewStore: makeFakeSrsReviewStore(),
    invalidateMenuCache: () => {},
    placementStore: makeFakePlacementStore(),
    evaluatePlacement: async () => ({ stage: 2, startLevel: 13, rationaleJa: "簡単な文は安定しています。" }),
    explainSentence: async () => ({ text: "be getting + 比較級は進行中の変化を表します。" }),
    metricsSummary: (days: number) => ({
      days: Array.from({ length: days }, (_, i) => ({
        ymd: `2026-07-${String(i + 1).padStart(2, "0")}`,
        utterances: 0, words: 0, speechMs: 0, totalMs: 0, pauseMs: 0,
        repetitionWords: 0, repetitionWeightedWords: 0, speakingSec: 0,
        avgArticulationWpm: 0, avgPauseRatio: 0, repetitionRatio: 0,
      })),
      weekly: {
        current: {
          utterances: 0, words: 0, speechMs: 0, totalMs: 0, pauseMs: 0,
          repetitionWords: 0, repetitionWeightedWords: 0, speakingSec: 0,
          avgArticulationWpm: 0, avgPauseRatio: 0, repetitionRatio: 0,
        },
        previous: {
          utterances: 0, words: 0, speechMs: 0, totalMs: 0, pauseMs: 0,
          repetitionWords: 0, repetitionWeightedWords: 0, speakingSec: 0,
          avgArticulationWpm: 0, avgPauseRatio: 0, repetitionRatio: 0,
        },
      },
      level: { current: 13, history: [] },
    }),
    explainTalk: async () => ({ text: "日本語訳: テスト訳\n\n表現ポイント:\n- test — テスト" }),
    talkExplainCache: makeFakeTalkExplainCache(),
    translate: async () => ({ text: "テスト訳" }),
    translationCache: makeFakeTalkExplainCache(),
    phraseHint: async () => ({ suggestions: [{ en: "Could you give me a moment?", ja: "少し時間をもらう言い方" }] }),
    fixExplain: async () => ({ text: "なぜ better の言い方が自然かの日本語解説。" }),
    assessmentStore: makeFakeAssessmentStore(),
    assembleMonthData: () => ({ windowDays: 30 }) as ReturnType<RouteDeps["assembleMonthData"]>,
    generateMonthlyReport: async () => "今月の振り返りテキスト",
    listListening: () => [FAKE_LISTENING_ITEM],
    findListening: (id: string) => (id === "morning-routine" ? FAKE_LISTENING_ITEM : undefined),
    listeningStore: makeFakeListeningStore(),
    feedbackStore: makeFakeFeedbackStore(),
    getLlmSettings: () => null,
    saveLlmSettings: (_s) => {},
    getLlmRoleSettings: (): Record<LlmRole, LlmRoleSetting> => ({
      conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      assist: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
    }),
    saveLlmRoleSettings: (_role, _s) => {},
    getLlmRoleTuning: (): Record<LlmRole, RoleTuning> => ({
      conversation: { claudeModel: null, effort: null, serviceTier: null },
      assist: { claudeModel: null, effort: null, serviceTier: null },
      coaching: { claudeModel: null, effort: null, serviceTier: null },
      generation: { claudeModel: null, effort: null, serviceTier: null },
      assessment: { claudeModel: null, effort: null, serviceTier: null },
    }),
    getLlmGlobalTuning: (): RoleTuning => ({ claudeModel: null, effort: null, serviceTier: null }),
    saveLlmRoleTuning: (_t) => {},
    applyLlmSettings: (_s) => {},
    llmEnv: () => ({ apiKeyConfigured: false, apiKeyApproved: false }),
    warmLlm: () => {},
    getLlmAuthModes: (): LlmAuthModes => ({ claude: "subscription", codex: "subscription" }),
    saveLlmAuthMode: (_provider, _mode) => {},
    getAuthKeysConfigured: () => ({ anthropic: false, codex: false }),
    applyLlmAuthModes: (_modes) => {},
    ensureCodexApiKeyHome: async () => "/fake/codex-home",
    killCodexAppServerRegistry: () => {},
    getModelCatalog: async (_provider: LlmCatalogProvider, _refresh: boolean): Promise<CatalogResult> => ({
      available: true, models: [], fetchedAt: "2026-07-08T00:00:00.000Z",
    }),
    getTtsSettings: () => null,
    getTtsProvider: () => "auto" as const,
    saveTtsProvider: (_p) => {},
    getSecretsStatus: () => ({
      ANTHROPIC_API_KEY: { configured: false, source: null },
      CODEX_API_KEY: { configured: false, source: null },
      OPENAI_COMPAT_API_KEY: { configured: false, source: null },
      TTS_API_KEY: { configured: false, source: null },
    }),
    saveSecret: async (_n, _v) => {},
    removeSecret: async (_n) => {},
    applySecretsChange: (_n) => ({ applied: true, error: null }),
    refreshCodexAuth: async () => {},
    refreshClaudeAuth: async () => {},
    bindSecretOrigin: (_name, _origin) => {},
    removeSecretOrigin: (_name) => {},
    saveTtsSettings: (_s) => {},
    ttsEnv: () => ({ apiKeyConfigured: false, apiKeyApproved: false }),
    modelDownload: makeFakeModelDownloadManager(),
    ...overrides,
  };
  return { deps, logFile, recordingsDir };
}
