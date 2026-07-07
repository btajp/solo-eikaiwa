import { ensureDirs, LISTENING_DIR, RECORDINGS_DIR, sessionLogPath } from "./paths";
import { transcribeAudio } from "./stt";
import { synthesize } from "./tts";
import { converseTurn } from "./converse";
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
  converse: converseTurn,
  health: () => checkHealth(),
  logFile: () => sessionLogPath(new Date()),
  recordingsDir: RECORDINGS_DIR,
  buildMenu: (minutes) => buildTodayMenu(minutes, { level: progressStore.getLevel() }),
  aeFeedback: (args) => generateAeFeedback(args),
  modelTalk: async (topicId) => {
    const topic = findTopic(topicId);
    if (!topic) return null;
    const talk = await generateModelTalk({ topicTitle: topic.title, hints: topic.hints, stage: stageOf(progressStore.getLevel()) });
    return { text: talk.text, topicTitle: topic.title };
  },
  libraryStore,
  reflection: () => generateReflection({ events: readEvents(sessionLogPath(new Date())) }),
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
    return generatePrepPack({ topicTitle: topic.title, hints: topic.hints, chunkCount: p.chunkCount, hintLang: p.hintLang, stage });
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
  evaluatePlacement: (subs) => evaluatePlacement(subs),
  explainSentence: (s) => generateSentenceExplanation(s),
  explainTalk: (text) => generateTalkExplanation({ text }),
  talkExplainCache: makeTalkExplainCache(db),
  translate: (text) => generateUtteranceTranslation({ text }),
  translationCache: makeTranslationCache(db),
  phraseHint: (args) => generatePhraseHints(args),
  fixExplain: (args) => generateFixExplanation(args),
  metricsSummary,
  assessmentStore,
  assembleMonthData: () => assembleMonthData(),
  generateMonthlyReport: (data) => generateMonthlyReport(data),
  listListening: () => loadListening(LISTENING_DIR),
  findListening: (id) => findListening(id),
  listeningStore,
};

Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  idleTimeout: 120,
  // 2分程度の音声Blobに十分な余裕を持たせた上限（DoS的な巨大ボディを拒否する）
  maxRequestBodySize: 32 * 1024 * 1024,
  fetch: makeFetchHandler(realDeps),
});

console.log(`learn-english server: http://${HOSTNAME}:${PORT} (health: /api/health)`);
