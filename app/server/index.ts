import { ensureDirs, RECORDINGS_DIR, SCENARIOS_DIR, TOPICS_DIR, sessionLogPath } from "./paths";
import { transcribeAudio } from "./stt";
import { synthesize } from "./tts";
import { converseTurn } from "./converse";
import { checkHealth } from "./health";
import { buildQuickMenu, buildTodayMenu, invalidateTodayMenuCache, loadContent } from "./menu";
import { generateAeFeedback, generateModelTalk, generatePrepPack, generateReflection, roleplayPrompt } from "./coach";
import { listPracticeDays, readEvents } from "./session-log";
import { readSettings, writeSettings } from "./settings";
import { makeFetchHandler, type RouteDeps } from "./routes";
import { makeLibraryStore, openDb } from "./db";
import { loadSentences, makeSentenceStore } from "./sentences";
import { makeProgressStore } from "./progress-store";
import { prepParams, stageOf } from "./progression";

ensureDirs();
const PORT = 3111;
const HOSTNAME = "127.0.0.1";

const db = openDb();
const libraryStore = makeLibraryStore(db);
const sentenceStore = makeSentenceStore(db, loadSentences());
const progressStore = makeProgressStore(db);

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
    const topic = loadContent(TOPICS_DIR).find((t) => t.id === topicId);
    if (!topic) return null;
    const talk = await generateModelTalk({ topicTitle: topic.title, hints: topic.hints });
    return { text: talk.text, topicTitle: topic.title };
  },
  libraryStore,
  reflection: () => generateReflection({ events: readEvents(sessionLogPath(new Date())) }),
  scenarioPrompt: (scenarioId) => {
    const sc = loadContent(SCENARIOS_DIR).find((s) => s.id === scenarioId);
    return sc ? roleplayPrompt(sc) : null;
  },
  prepPack: async (topicId) => {
    const topic = loadContent(TOPICS_DIR).find((t) => t.id === topicId);
    if (!topic) return null;
    const p = prepParams(stageOf(progressStore.getLevel()));
    return generatePrepPack({ topicTitle: topic.title, hints: topic.hints, chunkCount: p.chunkCount, hintLang: p.hintLang });
  },
  buildQuick: (kind) => buildQuickMenu(kind, { level: progressStore.getLevel() }),
  practiceDays: () => listPracticeDays(),
  getSettings: () => readSettings(),
  saveSettings: (s) => writeSettings(s),
  sentenceStore,
  progressStore,
  invalidateMenuCache: () => invalidateTodayMenuCache(),
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
