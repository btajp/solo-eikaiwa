import { ensureDirs, LISTENING_DIR, RECORDINGS_DIR, sessionLogPath } from "./paths";
import { transcribeAudio } from "./stt";
import { synthesize } from "./tts";
import { converseTurn, applyLlmRoleSettings, runnerFor } from "./converse";
import { checkHealth } from "./health";
import { buildQuickMenu, buildTodayMenu, invalidateTodayMenuCache } from "./menu";
import { findScenario, findTopic } from "./content";
import { generateAeFeedback, generateFixExplanation, generateModelTalk, generatePhraseHints, generatePrepPack, generateReflection, generateSentenceExplanation, generateTalkExplanation, generateUtteranceTranslation, roleplayPrompt } from "./coach";
import { fttOutputSignals, listPracticeDays, readEvents } from "./session-log";
import { readSettings, writeSettings } from "./settings";
import { makeFetchHandler, type RouteDeps } from "./routes";
import { makeLibraryStore, makeTalkExplainCache, makeTranslationCache, openDb } from "./db";
import { loadSentences, makeSentenceStore } from "./sentences";
import { makeChunkStore } from "./chunks";
import { makeProgressStore } from "./progress-store";
import { prepParams, stageOf } from "./progression";
import { evaluatePlacement, makePlacementStore } from "./placement";
import { makeMetricsSummary } from "./metrics-aggregate";
import { generateMonthlyReport, makeAssembleMonthData, makeAssessmentStore } from "./assessment";
import { loadListening, findListening } from "./listening";
import { makeListeningStore } from "./listening-store";
import { makeFeedbackStore } from "./feedback-store";
import { makeLlmSettingsStore } from "./llm-settings-store";
import { makeTtsSettingsStore } from "./tts-settings-store";
import { makeLlmRoleSettingsStore } from "./llm-role-settings-store";
import { conversationWarmup } from "./llm-warmup";
import { LLM_ROLES } from "./llm-provider";

ensureDirs();
const PORT = 3111;
const HOSTNAME = "127.0.0.1";

const db = openDb();
const libraryStore = makeLibraryStore(db);
const sentences = loadSentences();
const sentenceStore = makeSentenceStore(db, sentences);
const chunkStore = makeChunkStore(db, sentences.map((s) => s.en));
const progressStore = makeProgressStore(db, (today) => fttOutputSignals(today));
const placementStore = makePlacementStore(db);
const metricsSummary = makeMetricsSummary({ db, currentLevel: () => progressStore.getLevel() });
const assessmentStore = makeAssessmentStore(db);
const listeningStore = makeListeningStore(db);
const feedbackStore = makeFeedbackStore(db);
const llmSettingsStore = makeLlmSettingsStore(db);
const ttsSettingsStore = makeTtsSettingsStore(db);
const llmRoleSettingsStore = makeLlmRoleSettingsStore(db);
const assembleMonthData = makeAssembleMonthData({
  db,
  sentences,
  metricsSummary,
  currentLevel: () => progressStore.getLevel(),
  placementLatest: () => placementStore.latest(),
});

const realDeps: RouteDeps = {
  transcribe: transcribeAudio,
  synthesize,
  converse: (args) => converseTurn({ ...args, runner: runnerFor("conversation") }),
  health: () => checkHealth(),
  logFile: () => sessionLogPath(new Date()),
  recordingsDir: RECORDINGS_DIR,
  buildMenu: (minutes) => buildTodayMenu(minutes, { level: progressStore.getLevel() }),
  aeFeedback: (args) => generateAeFeedback({ ...args, stage: stageOf(progressStore.getLevel()) }, runnerFor("coaching")),
  modelTalk: async (topicId) => {
    const topic = findTopic(topicId);
    if (!topic) return null;
    const talk = await generateModelTalk({ topicTitle: topic.title, hints: topic.hints, stage: stageOf(progressStore.getLevel()) }, runnerFor("generation"));
    return { text: talk.text, topicTitle: topic.title };
  },
  libraryStore,
  reflection: () => generateReflection({ events: readEvents(sessionLogPath(new Date())) }, runnerFor("coaching")),
  scenarioPrompt: (scenarioId) => {
    const sc = findScenario(scenarioId);
    return sc ? roleplayPrompt(sc, stageOf(progressStore.getLevel())) : null;
  },
  conversationStage: () => stageOf(progressStore.getLevel()),
  prepPack: async (topicId) => {
    const topic = findTopic(topicId);
    if (!topic) return null;
    const stage = stageOf(progressStore.getLevel());
    const p = prepParams(stage);
    return generatePrepPack({ topicTitle: topic.title, hints: topic.hints, chunkCount: p.chunkCount, hintLang: p.hintLang, stage }, runnerFor("generation"));
  },
  buildQuick: (kind, domain) => buildQuickMenu(kind, { level: progressStore.getLevel(), domain }),
  practiceDays: () => listPracticeDays(),
  getSettings: () => readSettings(),
  saveSettings: (s) => writeSettings(s),
  sentenceStore,
  chunkStore,
  progressStore,
  invalidateMenuCache: () => invalidateTodayMenuCache(),
  placementStore,
  evaluatePlacement: (subs) => evaluatePlacement(subs, runnerFor("assessment")),
  explainSentence: (s) => generateSentenceExplanation(s, runnerFor("coaching")),
  explainTalk: (text) => generateTalkExplanation({ text }, runnerFor("coaching")),
  talkExplainCache: makeTalkExplainCache(db),
  translate: (text) => generateUtteranceTranslation({ text }, runnerFor("coaching")),
  translationCache: makeTranslationCache(db),
  phraseHint: (args) => generatePhraseHints(args, runnerFor("coaching")),
  fixExplain: (args) => generateFixExplanation(args, runnerFor("coaching")),
  metricsSummary,
  assessmentStore,
  assembleMonthData: () => assembleMonthData(),
  generateMonthlyReport: (data) => generateMonthlyReport(data, runnerFor("assessment")),
  listListening: () => loadListening(LISTENING_DIR),
  findListening: (id) => findListening(id),
  listeningStore,
  feedbackStore,
  getLlmSettings: () => llmSettingsStore.get(),
  saveLlmSettings: (s) => llmSettingsStore.save(s),
  getLlmRoleSettings: () => llmRoleSettingsStore.getAll(),
  saveLlmRoleSettings: (role, s) => llmRoleSettingsStore.save(role, s),
  // 「現在の全体設定 + 保存済みロール」で一括再解決する（PUT /api/llm-settings, /api/llm-settings/roles の共通経路）。
  applyLlmSettings: (s) => applyLlmRoleSettings(s, llmRoleSettingsStore.getAll()),
  // env 由来情報。APIキーは有無のみ（値は絶対に返さない）。
  llmEnv: () => ({
    provider: (Bun.env.LLM_PROVIDER ?? "claude").trim().toLowerCase() || "claude",
    apiKeyConfigured: Boolean(Bun.env.OPENAI_COMPAT_API_KEY?.trim()),
  }),
  warmLlm: () => conversationWarmup.maybeWarm(),
  getTtsSettings: () => ttsSettingsStore.get(),
  saveTtsSettings: (s) => ttsSettingsStore.save(s),
  // env 由来。TTS の APIキーは有無のみ開示（TTS_API_KEY 優先・無ければ OPENAI_API_KEY）。値は絶対に返さない。
  ttsEnv: () => ({ apiKeyConfigured: Boolean((Bun.env.TTS_API_KEY ?? Bun.env.OPENAI_API_KEY)?.trim()) }),
};

// 起動時: DB に LLM 設定（全体 or ロール別）があれば実行中プロセスへ適用する（fail-open）。
// どちらも無ければ何もせず、converse.ts のモジュールロード時 env 既定のまま（現行と完全同一）。
// provider="env" は settingsToEnv 経由で pure-env を再現する。UI 由来の不正値で LaunchAgent の
// crash-loop を起こさないため、失敗は warn してフォールバックする（プロセスは落とさない）。
const savedLlm = llmSettingsStore.get();
const savedRoles = llmRoleSettingsStore.getAll();
const hasRoleOverride = LLM_ROLES.some((r) => savedRoles[r].provider !== "inherit");
if (savedLlm || hasRoleOverride) {
  try {
    applyLlmRoleSettings(savedLlm ?? { provider: "env", baseUrl: null, model: null, codexModel: null }, savedRoles);
  } catch (err) {
    console.warn(`[llm] failed to apply saved settings, falling back to environment/claude: ${String(err)}`);
  }
}

Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  idleTimeout: 120,
  // 2分程度の音声Blobに十分な余裕を持たせた上限（DoS的な巨大ボディを拒否する）
  maxRequestBodySize: 32 * 1024 * 1024,
  fetch: makeFetchHandler(realDeps),
});

console.log(`learn-english server: http://${HOSTNAME}:${PORT} (health: /api/health)`);
