import { CLIENT_DIST_DIR, ensureDirs, LISTENING_DIR, POC_STT_LOG_FILE, RECORDINGS_DIR, sessionLogPath, TOPICS_DIR, TOPIC_ASSETS_DIR } from "./paths";
import { resolveHostname, resolvePort, serveOrExit } from "./serve";
import { transcribeAudio } from "./stt";
import { synthesize } from "./tts";
import { converseTurn, applyLlmRoleSettings, runnerFor, CLAUDE_EXECUTABLE_PATH } from "./converse";
import { checkHealth } from "./health";
import { buildQuickMenu, buildTodayMenu, invalidateTodayMenuCache } from "./menu";
import { findScenario, findTopic } from "./content";
import { generateAeFeedback, generateFixExplanation, generateModelTalk, generatePhraseHints, generatePrepPack, generateReflection, generateSentenceExplanation, generateTalkExplanation, generateUtteranceTranslation, roleplayPrompt } from "./coach";
import { fttOutputSignals, listPracticeDays, readEvents } from "./session-log";
import { readSettings, writeSettings } from "./settings";
import { makeFetchHandler, type RouteDeps } from "./routes";
import { makeLibraryStore, makeTalkExplainCache, makeTranslationCache, openDb } from "./db";
import { makeTopicAssetCacheStore, resolveModelTalk, resolvePrepPack } from "./topic-assets";
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
import { makeTtsProviderStore } from "./tts-provider-store";
import { makeLlmRoleSettingsStore } from "./llm-role-settings-store";
import { makeLlmRoleTuningStore } from "./llm-role-tuning-store";
import { makeLlmAuthStore, setActiveAuthModes } from "./llm-auth-store";
import { ensureCodexApiKeyHome, resetCodexApiKeyHome } from "./codex-auth";
import { conversationWarmup } from "./llm-warmup";
import { DEFAULT_LLM_SETTINGS, LLM_ROLES } from "./llm-provider";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getCodexAppServerClient, __resetCodexAppServerRegistry } from "./providers/codex-app-server";
import { makeClaudeCatalogFetcher, makeCodexCatalogFetcher, makeLocalCatalogFetcher, makeModelCatalogCache } from "./providers/model-catalog";
import { modelDownloadManager } from "./model-download";
import { makeSecretsManager } from "./secrets";

ensureDirs();
const PORT = resolvePort(Bun.env);
const HOSTNAME = resolveHostname(Bun.env);

// 起動時: Keychain に保存済みの API キーをプロセス env へ注入する（Keychain > env・spec 2026-07-10）。
// 以降の鍵消費点（settingsToEnv・codex-auth・tts・health・presence 判定）はすべてプロセス env を
// 見るため、この1回の注入で全経路に効く。失敗しても env のみで継続する（fail-open・load 内で warn）。
const secretsManager = makeSecretsManager();
await secretsManager.load();

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
const topicAssetCacheStore = makeTopicAssetCacheStore(db);
const feedbackStore = makeFeedbackStore(db);
const llmSettingsStore = makeLlmSettingsStore(db);
const ttsSettingsStore = makeTtsSettingsStore(db);
const ttsProviderStore = makeTtsProviderStore(db);
const llmRoleSettingsStore = makeLlmRoleSettingsStore(db);
const llmRoleTuningStore = makeLlmRoleTuningStore(db);
const llmAuthStore = makeLlmAuthStore(db);
// モデルカタログ（GET /api/llm-models）: 3ソースを TTL キャッシュ付きで束ねる。
// codex はカタログ取得も runner と同じ常駐プロセスを共有する（getCodexAppServerClient・exec フォールバックなし）。
// local の baseUrl は「保存済み openai-compat 設定 → 無ければ env」の順で解決する（グローバル設定に閉じる。
// ロール別 baseUrl は対象外＝カタログは接続単位ではなくプロバイダ単位の一覧のため）。
const modelCatalogCache = makeModelCatalogCache({
  // sidecarモード（SOLO_EIKAIWA_RESOURCES_DIR設定時）ではCLAUDE_EXECUTABLE_PATHがBun.which("claude")の絶対パスに
  // 解決される（converse.tsのclaudeRunnerと同じ解決値を共有）。非sidecarモードはundefinedのままでバイト等価。
  claude: makeClaudeCatalogFetcher(query, { claudeExecutablePath: CLAUDE_EXECUTABLE_PATH }),
  codex: makeCodexCatalogFetcher(() => getCodexAppServerClient()),
  // ローカルLLMのカタログ取得先は保存済み設定（DB）のみから解決する（env フォールバック廃止・v0.29）。
  local: makeLocalCatalogFetcher(() => llmSettingsStore.get()?.baseUrl?.trim() || null),
});
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
  // llmSettings: health.llmReady（claude/codex/openai-compatのいずれかが実際に使えるかの集約判定）が
  // openai-compat経路の判定に使う。DB未設定時はcheckHealth側でenv直接運用として扱う。
  health: () => checkHealth({ llmSettings: llmSettingsStore.get() }),
  logFile: () => sessionLogPath(new Date()),
  recordingsDir: RECORDINGS_DIR,
  staticDir: CLIENT_DIST_DIR,
  pocLogFile: POC_STT_LOG_FILE,
  buildMenu: (minutes) => buildTodayMenu(minutes, { level: progressStore.getLevel() }),
  aeFeedback: (args) => generateAeFeedback({ ...args, stage: stageOf(progressStore.getLevel()) }, runnerFor("coaching")),
  modelTalk: async (topicId) => {
    const topic = findTopic(topicId);
    if (!topic) return null;
    const stage = stageOf(progressStore.getLevel());
    const talk = await resolveModelTalk(
      topicId, stage,
      { assetsDir: TOPIC_ASSETS_DIR, topicsDir: TOPICS_DIR, cache: topicAssetCacheStore },
      () => generateModelTalk({ topicTitle: topic.title, hints: topic.hints, stage }, runnerFor("generation")),
    );
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
    return resolvePrepPack(
      topicId, stage,
      { assetsDir: TOPIC_ASSETS_DIR, topicsDir: TOPICS_DIR, cache: topicAssetCacheStore },
      () => generatePrepPack({ topicTitle: topic.title, hints: topic.hints, chunkCount: p.chunkCount, hintLang: p.hintLang, stage }, runnerFor("generation")),
    );
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
  translate: (text) => generateUtteranceTranslation({ text }, runnerFor("assist")),
  translationCache: makeTranslationCache(db),
  phraseHint: (args) => generatePhraseHints(args, runnerFor("assist")),
  fixExplain: (args) => generateFixExplanation(args, runnerFor("assist")),
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
  getLlmRoleTuning: () => llmRoleTuningStore.getAll(),
  getLlmGlobalTuning: () => llmRoleTuningStore.getGlobal(),
  saveLlmRoleTuning: (t) => llmRoleTuningStore.setAll(t),
  // 「現在の全体設定 + 保存済みロール + 保存済みチューニング（global 込み）」で一括再解決する
  // （PUT /api/llm-settings, /api/llm-settings/roles の共通経路）。
  applyLlmSettings: (s) =>
    applyLlmRoleSettings(s, llmRoleSettingsStore.getAll(), Bun.env, llmRoleTuningStore.getAll(), llmRoleTuningStore.getGlobal()),
  // env 由来情報。APIキーは有無のみ（値は絶対に返さない）。接続設定の env 読み取りは廃止済み（v0.29）。
  llmEnv: () => ({
    apiKeyConfigured: Boolean(Bun.env.OPENAI_COMPAT_API_KEY?.trim()),
  }),
  warmLlm: () => conversationWarmup.maybeWarm(),
  getLlmAuthModes: () => llmAuthStore.getAll(),
  saveLlmAuthMode: (provider, mode) => llmAuthStore.set(provider, mode),
  // env のキー検出のみ（値は絶対に返さない）。anthropic=ANTHROPIC_API_KEY・codex=CODEX_API_KEY。
  getAuthKeysConfigured: () => ({
    anthropic: Boolean(Bun.env.ANTHROPIC_API_KEY?.trim()),
    codex: Boolean(Bun.env.CODEX_API_KEY?.trim()),
  }),
  // 保存直後の最新モードを runner 側のランタイムキャッシュへ push する（PUT がサーバ再起動なしに反映されるため）。
  applyLlmAuthModes: (modes) => setActiveAuthModes(modes),
  ensureCodexApiKeyHome: () => ensureCodexApiKeyHome(),
  killCodexAppServerRegistry: () => __resetCodexAppServerRegistry(),
  getModelCatalog: (provider, refresh) => modelCatalogCache.get(provider, refresh),
  getTtsSettings: () => ttsSettingsStore.get(),
  saveTtsSettings: (s) => ttsSettingsStore.save(s),
  getTtsProvider: () => ttsProviderStore.get(),
  saveTtsProvider: (p) => ttsProviderStore.save(p),
  // env 由来。TTS の APIキーは有無のみ開示（TTS_API_KEY 優先・無ければ OPENAI_API_KEY）。値は絶対に返さない。
  ttsEnv: () => ({ apiKeyConfigured: Boolean((Bun.env.TTS_API_KEY ?? Bun.env.OPENAI_API_KEY)?.trim()) }),
  // API キーの Keychain 設定（routes/secrets.ts）。値はいかなる応答にも含めない。
  // CODEX_API_KEY の変更は隔離 CODEX_HOME の auth.json を破棄し、api-key モード運用中なら
  // 新しいキー（削除時は env 復元値）で再ログインする。キーが無くなった場合は情報的エラーを
  // throw し、route が applied:false + error として返す（モード自体は変更しない）。
  refreshCodexAuth: async () => {
    resetCodexApiKeyHome();
    if (llmAuthStore.getAll().codex !== "api-key") return;
    if (!Bun.env.CODEX_API_KEY?.trim()) {
      throw new Error("codex auth mode is api-key but no key is configured now; save a key or switch to subscription");
    }
    await ensureCodexApiKeyHome();
  },
  getSecretsStatus: () => secretsManager.status(),
  saveSecret: (name, value) => secretsManager.save(name, value),
  removeSecret: (name) => secretsManager.remove(name),
  // 鍵変更後の再解決: llm-settings の applyResolved と同じ「現在の全体設定 + 保存済みロール/チューニング」で
  // 5ロール runner を組み直す（openai-compat の apiKey は合成 env 経由なので新しい鍵が効く）。fail-open。
  applySecretsChange: () => {
    try {
      applyLlmRoleSettings(
        llmSettingsStore.get() ?? DEFAULT_LLM_SETTINGS,
        llmRoleSettingsStore.getAll(),
        Bun.env,
        llmRoleTuningStore.getAll(),
        llmRoleTuningStore.getGlobal(),
      );
      return { applied: true, error: null };
    } catch (err) {
      return { applied: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  modelDownload: modelDownloadManager,
};

// 起動時: 保存済み認証モードを runner 側のランタイムキャッシュへ反映する（行不在なら既定 subscription/subscription
// のまま＝挙動不変）。以後は routes/llm-settings.ts の PUT ハンドラが保存の都度ここを更新する。
setActiveAuthModes(llmAuthStore.getAll());

// 起動時: DB に LLM 設定（全体 or ロール別）があれば実行中プロセスへ適用する（fail-open）。
// どちらも無ければ何もせず、converse.ts のモジュールロード時既定（claude）のまま。
// UI 由来の不正値で LaunchAgent の crash-loop を起こさないため、失敗は warn して
// フォールバックする（プロセスは落とさない）。
const savedLlm = llmSettingsStore.get();
const savedRoles = llmRoleSettingsStore.getAll();
const savedTuning = llmRoleTuningStore.getAll();
const savedGlobalTuning = llmRoleTuningStore.getGlobal();
const hasRoleOverride = LLM_ROLES.some((r) => savedRoles[r].provider !== "inherit");
const hasTuningOverride = [...LLM_ROLES.map((r) => savedTuning[r]), savedGlobalTuning].some(
  (t) => t.claudeModel !== null || t.effort !== null || t.serviceTier !== null,
);
if (savedLlm || hasRoleOverride || hasTuningOverride) {
  try {
    applyLlmRoleSettings(
      savedLlm ?? DEFAULT_LLM_SETTINGS,
      savedRoles,
      Bun.env,
      savedTuning,
      savedGlobalTuning,
    );
  } catch (err) {
    console.warn(`[llm] failed to apply saved settings, falling back to environment/claude: ${String(err)}`);
  }
}

serveOrExit({
  port: PORT,
  hostname: HOSTNAME,
  idleTimeout: 120,
  // 2分程度の音声Blobに十分な余裕を持たせた上限（DoS的な巨大ボディを拒否する）
  maxRequestBodySize: 32 * 1024 * 1024,
  fetch: makeFetchHandler(realDeps),
});

console.log(`solo-eikaiwa server: http://${HOSTNAME}:${PORT} (health: /api/health)`);
