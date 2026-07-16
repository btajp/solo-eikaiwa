import { CLIENT_DIST_DIR, ensureDirs, LISTENING_DIR, POC_STT_LOG_FILE, RECORDINGS_DIR, sessionLogPath, TOPICS_DIR, TOPIC_ASSETS_DIR } from "./paths";
import { resolveHostname, resolvePort, serveOrExit } from "./serve";
import { transcribeAudio } from "./stt";
import { synthesize, DEFAULT_TTS_BASE_URL } from "./tts";
import { converseTurn, applyLlmRoleSettings, runnerFor, CLAUDE_EXECUTABLE_PATH } from "./converse";
import { checkHealth } from "./health";
import { buildQuickMenu, buildTodayMenu, invalidateTodayMenuCache } from "./menu";
import { findScenario, findTopic, loadContent } from "./content";
import { generateAeFeedback, generateFixExplanation, generateModelTalk, generatePhraseHints, generatePrepPack, generateReflection, generateSentenceExplanation, generateTalkExplanation, generateUtteranceTranslation, roleplayPrompt } from "./coach";
import { fttOutputSignals, listPracticeDays, readSessionEvents } from "./session-log";
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
import { makeLlmAuthStore, setActiveAuthModes, setActiveAuthSecrets } from "./llm-auth-store";
import { CODEX_HOME_DIR, ensureCodexApiKeyHome, realCodexLoginSpawn, resetCodexApiKeyHome } from "./codex-auth";
import { conversationWarmup } from "./llm-warmup";
import { DEFAULT_LLM_SETTINGS, LLM_ROLES } from "./llm-provider";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getCodexAppServerClient, __resetCodexAppServerRegistry } from "./providers/codex-app-server";
import { isOpenAiConversationModelCandidate, makeClaudeCatalogFetcher, makeCodexCatalogFetcher, makeLocalCatalogFetcher, makeModelCatalogCache } from "./providers/model-catalog";
import { modelDownloadManager } from "./model-download";
import { makeSecretsManager } from "./secrets";
import {
  makeApiKeyOriginStore,
  resolveOriginBoundSecret,
  type OriginBoundSecretName,
} from "./api-key-origin-store";
import { makeSrsReviewStore } from "./srs-review-store";
import { OPENAI_BASE_URL } from "./openai";

ensureDirs();
const PORT = resolvePort(Bun.env);
const HOSTNAME = resolveHostname(Bun.env);

// 起動時: Keychain値をmanager内へ読み込む（Keychain > env）。process.envへは展開せず、
// providerごとのresolverだけが必要な鍵を取得する。読込失敗時はenvのみで継続する。
const secretsManager = makeSecretsManager();
await secretsManager.load();

function syncActiveAuthSecrets(): void {
  setActiveAuthSecrets({
    anthropic: secretsManager.get("ANTHROPIC_API_KEY"),
    codex: secretsManager.get("CODEX_API_KEY"),
  });
}
syncActiveAuthSecrets();

const db = openDb();
const apiKeyOriginStore = makeApiKeyOriginStore(db);

function originBoundKey(name: OriginBoundSecretName, baseUrl: string): string | undefined {
  return resolveOriginBoundSecret(apiKeyOriginStore, name, baseUrl, (secretName) => secretsManager.get(secretName));
}

function openAiOfficialKey(): string | undefined {
  const direct = secretsManager.get("OPENAI_API_KEY");
  if (direct) return direct;
  // 旧版で公式URLへ束縛済みだった互換/TTSキーだけを移行用に読む。任意originの鍵は流用しない。
  return originBoundKey("OPENAI_COMPAT_API_KEY", OPENAI_BASE_URL)
    ?? originBoundKey("TTS_API_KEY", OPENAI_BASE_URL);
}

function ttsCompatKey(baseUrl: string): string | undefined {
  return originBoundKey("TTS_API_KEY", baseUrl);
}

function runtimeSecretEnv(): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: secretsManager.get("ANTHROPIC_API_KEY"),
    CODEX_API_KEY: secretsManager.get("CODEX_API_KEY"),
    OPENAI_COMPAT_API_KEY: secretsManager.get("OPENAI_COMPAT_API_KEY"),
    TTS_API_KEY: secretsManager.get("TTS_API_KEY"),
    OPENAI_API_KEY: openAiOfficialKey(),
  };
}

function runtimeHealthEnv(): Record<string, string | undefined> {
  return {
    ...runtimeSecretEnv(),
    SOLO_EIKAIWA_SIDECAR_PROTOCOL: Bun.env.SOLO_EIKAIWA_SIDECAR_PROTOCOL,
    SOLO_EIKAIWA_SIDECAR_BUILD_ID: Bun.env.SOLO_EIKAIWA_SIDECAR_BUILD_ID,
    SOLO_EIKAIWA_DATA_ROOT_ID: Bun.env.SOLO_EIKAIWA_DATA_ROOT_ID,
    SOLO_EIKAIWA_SIDECAR_INSTANCE_ID: Bun.env.SOLO_EIKAIWA_SIDECAR_INSTANCE_ID,
  };
}
const libraryStore = makeLibraryStore(db);
const sentences = loadSentences();
const sentenceStore = makeSentenceStore(db, sentences);
const chunkStore = makeChunkStore(db, sentences.map((s) => s.en));
const progressStore = makeProgressStore(db, (today) => fttOutputSignals(today));
const srsReviewStore = makeSrsReviewStore(db);
const placementStore = makePlacementStore(db);
const metricsSummary = makeMetricsSummary({ db, currentLevel: () => progressStore.getLevel() });
const assessmentStore = makeAssessmentStore(db);
const listeningStore = makeListeningStore(db);
const topicAssetCacheStore = makeTopicAssetCacheStore(db);
let cachedLibraryTopics: Map<string, { title: string; titleJa: string }> | null = null;

function libraryTopics(): Map<string, { title: string; titleJa: string }> {
  if (cachedLibraryTopics) return cachedLibraryTopics;
  cachedLibraryTopics = new Map(loadContent(TOPICS_DIR).map((topic) => [
    topic.id, { title: topic.title, titleJa: topic.titleJa },
  ]));
  return cachedLibraryTopics;
}

const feedbackStore = makeFeedbackStore(db);
const llmSettingsStore = makeLlmSettingsStore(db);
const ttsSettingsStore = makeTtsSettingsStore(db);
const ttsProviderStore = makeTtsProviderStore(db, () => {
  if (ttsSettingsStore.get()?.baseUrl) return "openai-compat";
  return openAiOfficialKey() ? "openai" : "say";
});
function currentTtsProvider() {
  const provider = ttsProviderStore.get();
  // 旧 explicit openai-compat + 公式既定URLは、設定storeの仮想移行後はcustom baseUrlが空になる。
  return provider === "openai-compat" && !ttsSettingsStore.get()?.baseUrl ? "openai" as const : provider;
}
const llmRoleSettingsStore = makeLlmRoleSettingsStore(db);
const llmRoleTuningStore = makeLlmRoleTuningStore(db);
const llmAuthStore = makeLlmAuthStore(db);
// モデルカタログ（GET /api/llm-models）: 4ソースを TTL キャッシュ付きで束ねる。
// codex はカタログ取得も runner と同じ常駐プロセスを共有する（getCodexAppServerClient・exec フォールバックなし）。
// local の baseUrl は「保存済み openai-compat 設定 → 無ければ env」の順で解決する（グローバル設定に閉じる。
// ロール別 baseUrl は対象外＝カタログは接続単位ではなくプロバイダ単位の一覧のため）。
const modelCatalogCache = makeModelCatalogCache({
  // sidecarモード（SOLO_EIKAIWA_RESOURCES_DIR設定時）ではCLAUDE_EXECUTABLE_PATHがBun.which("claude")の絶対パスに
  // 解決される（converse.tsのclaudeRunnerと同じ解決値を共有）。非sidecarモードはundefinedのままでバイト等価。
  claude: makeClaudeCatalogFetcher(query, { claudeExecutablePath: CLAUDE_EXECUTABLE_PATH }),
  openai: makeLocalCatalogFetcher(
    () => OPENAI_BASE_URL,
    fetch,
    () => openAiOfficialKey(),
    {
      requireApiKey: true,
      missingApiKeyReason: "OpenAI API key is not configured",
      includeModel: isOpenAiConversationModelCandidate,
    },
  ),
  codex: makeCodexCatalogFetcher(() => getCodexAppServerClient()),
  // ローカルLLMのカタログ取得先は保存済み設定（DB）のみから解決する（env フォールバック廃止・v0.29）。
  local: makeLocalCatalogFetcher(
    () => llmSettingsStore.get()?.baseUrl?.trim() || null,
    fetch,
    (baseUrl) => originBoundKey("OPENAI_COMPAT_API_KEY", baseUrl),
  ),
});
const assembleMonthData = makeAssembleMonthData({
  db,
  sentences,
  metricsSummary,
  practiceDays: () => listPracticeDays(),
  currentLevel: () => progressStore.getLevel(),
  placementLatest: () => placementStore.latest(),
});

const realDeps: RouteDeps = {
  transcribe: transcribeAudio,
  synthesize: (text, opts = {}) => {
    const provider = opts.provider ?? currentTtsProvider();
    const baseUrl = opts.baseUrl?.trim() || DEFAULT_TTS_BASE_URL;
    const apiKey = provider === "openai"
      ? openAiOfficialKey()
      : provider === "openai-compat"
      ? ttsCompatKey(baseUrl)
      : undefined;
    return synthesize(text, { ...opts, provider, apiKey, env: {} });
  },
  converse: (args) => converseTurn({ ...args, runner: runnerFor("conversation") }),
  // llmSettings: health.llmReadyがOpenAI公式/互換経路の実効設定を判定するために使う。
  health: () => checkHealth({ llmSettings: llmSettingsStore.get(), env: runtimeHealthEnv() }),
  logFile: () => sessionLogPath(new Date()),
  recordingsDir: RECORDINGS_DIR,
  staticDir: CLIENT_DIST_DIR,
  pocLogFile: POC_STT_LOG_FILE,
  buildMenu: (minutes) => buildTodayMenu(minutes, { level: progressStore.getLevel() }),
  aeFeedback: (args) => generateAeFeedback({ ...args, stage: stageOf(progressStore.getLevel()) }, runnerFor("coaching")),
  modelTalk: async (topicId, signal) => {
    const topic = findTopic(topicId);
    if (!topic) return null;
    const stage = stageOf(progressStore.getLevel());
    const talk = await resolveModelTalk(
      topicId, stage,
      { assetsDir: TOPIC_ASSETS_DIR, topicsDir: TOPICS_DIR, cache: topicAssetCacheStore },
      () => generateModelTalk({ topicTitle: topic.title, hints: topic.hints, stage, signal }, runnerFor("generation")),
    );
    return { text: talk.text, topicTitle: topic.title, topicTitleJa: topic.titleJa };
  },
  libraryStore,
  libraryTopics,
  reflection: (sessionId, signal) => generateReflection({ events: readSessionEvents(sessionId), signal }, runnerFor("coaching")),
  scenarioPrompt: (scenarioId) => {
    const sc = findScenario(scenarioId);
    return sc ? roleplayPrompt(sc, stageOf(progressStore.getLevel())) : null;
  },
  conversationStage: () => stageOf(progressStore.getLevel()),
  prepPack: async (topicId, signal) => {
    const topic = findTopic(topicId);
    if (!topic) return null;
    const stage = stageOf(progressStore.getLevel());
    const p = prepParams(stage);
    return resolvePrepPack(
      topicId, stage,
      { assetsDir: TOPIC_ASSETS_DIR, topicsDir: TOPICS_DIR, cache: topicAssetCacheStore },
      () => generatePrepPack({ topicTitle: topic.title, hints: topic.hints, chunkCount: p.chunkCount, hintLang: p.hintLang, stage, signal }, runnerFor("generation")),
    );
  },
  buildQuick: (kind, domain) => buildQuickMenu(kind, { level: progressStore.getLevel(), domain }),
  practiceDays: () => listPracticeDays(),
  getSettings: () => readSettings(),
  saveSettings: (s) => writeSettings(s),
  sentenceStore,
  chunkStore,
  progressStore,
  srsReviewStore,
  invalidateMenuCache: () => invalidateTodayMenuCache(),
  placementStore,
  evaluatePlacement: (subs, signal) => evaluatePlacement(subs, runnerFor("assessment"), signal),
  explainSentence: (s) => generateSentenceExplanation(s, runnerFor("coaching")),
  explainTalk: (text, signal) => generateTalkExplanation({ text, signal }, runnerFor("coaching")),
  talkExplainCache: makeTalkExplainCache(db),
  translate: (text, signal) => generateUtteranceTranslation({ text, signal }, runnerFor("assist")),
  translationCache: makeTranslationCache(db),
  phraseHint: (args) => generatePhraseHints(args, runnerFor("assist")),
  fixExplain: (args) => generateFixExplanation(args, runnerFor("assist")),
  metricsSummary,
  assessmentStore,
  assembleMonthData: () => assembleMonthData(),
  generateMonthlyReport: (data, signal) => generateMonthlyReport(data, runnerFor("assessment"), signal),
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
    applyLlmRoleSettings(
      s,
      llmRoleSettingsStore.getAll(),
      runtimeSecretEnv(),
      llmRoleTuningStore.getAll(),
      llmRoleTuningStore.getGlobal(),
      (baseUrl) => originBoundKey("OPENAI_COMPAT_API_KEY", baseUrl),
      openAiOfficialKey(),
    ),
  llmEnv: () => {
    const baseUrl = llmSettingsStore.get()?.baseUrl;
    return {
      apiKeyConfigured: Boolean(secretsManager.get("OPENAI_COMPAT_API_KEY")),
      apiKeyApproved: Boolean(baseUrl && originBoundKey("OPENAI_COMPAT_API_KEY", baseUrl)),
      openAiKeyConfigured: Boolean(openAiOfficialKey()),
    };
  },
  warmLlm: () => conversationWarmup.maybeWarm(),
  getLlmAuthModes: () => llmAuthStore.getAll(),
  saveLlmAuthMode: (provider, mode) => llmAuthStore.set(provider, mode),
  // Keychain/env resolverのキー検出のみ（値は絶対に返さない）。
  getAuthKeysConfigured: () => ({
    anthropic: Boolean(secretsManager.get("ANTHROPIC_API_KEY")),
    codex: Boolean(secretsManager.get("CODEX_API_KEY")),
  }),
  // 保存直後の最新モードを runner 側のランタイムキャッシュへ push する（PUT がサーバ再起動なしに反映されるため）。
  applyLlmAuthModes: (modes) => setActiveAuthModes(modes),
  ensureCodexApiKeyHome: () => ensureCodexApiKeyHome(
    realCodexLoginSpawn,
    CODEX_HOME_DIR,
    secretsManager.get("CODEX_API_KEY"),
  ),
  killCodexAppServerRegistry: () => __resetCodexAppServerRegistry(),
  getModelCatalog: (provider, refresh) => modelCatalogCache.get(provider, refresh),
  getTtsSettings: () => ttsSettingsStore.get(),
  saveTtsSettings: (s) => ttsSettingsStore.save(s),
  getTtsProvider: () => currentTtsProvider(),
  saveTtsProvider: (p) => ttsProviderStore.save(p),
  ttsEnv: () => {
    const baseUrl = ttsSettingsStore.get()?.baseUrl;
    return {
      apiKeyConfigured: Boolean(secretsManager.get("TTS_API_KEY")),
      apiKeyApproved: Boolean(baseUrl && ttsCompatKey(baseUrl)),
      openAiKeyConfigured: Boolean(openAiOfficialKey()),
    };
  },
  // API キーの Keychain 設定（routes/secrets.ts）。値はいかなる応答にも含めない。
  // CODEX_API_KEY の変更は隔離 CODEX_HOME の auth.json を破棄し、api-key モード運用中なら
  // 新しい実効キー（Keychain > env）で再ログインする。キーが無くなった場合は情報的エラーを
  // throw し、route が applied:false + error として返す（モード自体は変更しない）。
  refreshCodexAuth: async () => {
    resetCodexApiKeyHome();
    if (llmAuthStore.getAll().codex !== "api-key") return;
    const apiKey = secretsManager.get("CODEX_API_KEY");
    if (!apiKey) {
      throw new Error("codex auth mode is api-key but no key is configured now; save a key or switch to subscription");
    }
    await ensureCodexApiKeyHome(realCodexLoginSpawn, CODEX_HOME_DIR, apiKey);
  },
  refreshClaudeAuth: async () => {
    if (llmAuthStore.getAll().claude === "api-key" && !secretsManager.get("ANTHROPIC_API_KEY")) {
      throw new Error("claude auth mode is api-key but no key is configured; save a key or switch to subscription");
    }
  },
  getSecretsStatus: () => {
    const status = secretsManager.status();
    if (!status.OPENAI_API_KEY.configured && openAiOfficialKey()) {
      status.OPENAI_API_KEY = { configured: true, source: "legacy" };
    }
    return status;
  },
  saveSecret: (name, value) => secretsManager.save(name, value),
  removeSecret: (name) => secretsManager.remove(name),
  bindSecretOrigin: (name, origin) => apiKeyOriginStore.set(name, origin),
  removeSecretOrigin: (name) => apiKeyOriginStore.remove(name),
  // 鍵変更後の再解決: llm-settings の applyResolved と同じ「現在の全体設定 + 保存済みロール/チューニング」で
  // 5ロール runner を組み直す（openai-compat の apiKey は合成 env 経由なので新しい鍵が効く）。fail-open。
  applySecretsChange: () => {
    try {
      syncActiveAuthSecrets();
      applyLlmRoleSettings(
        llmSettingsStore.get() ?? DEFAULT_LLM_SETTINGS,
        llmRoleSettingsStore.getAll(),
        runtimeSecretEnv(),
        llmRoleTuningStore.getAll(),
        llmRoleTuningStore.getGlobal(),
        (baseUrl) => originBoundKey("OPENAI_COMPAT_API_KEY", baseUrl),
        openAiOfficialKey(),
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
      runtimeSecretEnv(),
      savedTuning,
      savedGlobalTuning,
      (baseUrl) => originBoundKey("OPENAI_COMPAT_API_KEY", baseUrl),
      openAiOfficialKey(),
    );
  } catch (err) {
    console.warn(`[llm] failed to apply saved settings, falling back to environment/claude: ${String(err)}`);
  }
}

await serveOrExit({
  port: PORT,
  hostname: HOSTNAME,
  idleTimeout: 120,
  // 2分程度の音声Blobに十分な余裕を持たせた上限（DoS的な巨大ボディを拒否する）
  maxRequestBodySize: 32 * 1024 * 1024,
  fetch: makeFetchHandler(realDeps),
});

console.log(`solo-eikaiwa server: http://${HOSTNAME}:${PORT} (health: /api/health)`);
