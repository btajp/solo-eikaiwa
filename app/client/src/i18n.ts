/** トップページ・サイドバーの表示言語（デフォルト英語、localStorageに保存） */
export type Lang = "en" | "ja";

import type { LlmRole } from "./api/llm-settings";
import type { CloudTarget } from "./lib/llm-assignments";

export function loadLang(): Lang {
  const v = localStorage.getItem("lang");
  return v === "ja" ? "ja" : "en";
}

export function saveLang(lang: Lang): void {
  localStorage.setItem("lang", lang);
}

export type DrillKey =
  | "warmup" | "ftt-mini" | "shadowing"
  | "roleplay-daily" | "roleplay-business" | "roleplay-it";

export type MenuTitleKey =
  | "warmup" | "ftt" | "ftt-mini"
  | "roleplay-daily" | "roleplay-business" | "roleplay-it"
  | "shadowing" | "reflection";
type MenuTitleStrings = { menuTitle: Record<MenuTitleKey, (topicTitle: string) => string> };
type SessionStrings = {
  session: {
    building: string; retry: string; timerNote: string;
    finish: string; next: string; doneExit: string;
    noTopic: string; noScenario: string; unknownBlock: (kind: string) => string;
    blockAria: (index: number, total: number) => string;
    /** v0.26 wave5: rotation の情報的注記。教材がラウンドロビン振替・帯域緩和のフォールバックで選ばれたときだけ表示する中立な一文（警告調ではない） */
    fallbackNote: string;
  };
};

type NavStrings = {
  nav: {
    home: string; placement: string; free: string; library: string; sentences: string; listening: string; progress: string; feedback: string; settings: string;
    sectionToday: string; sectionSelf: string; sectionRecords: string; selfStudyHint: string;
  };
};
type AppShellStrings = { appShell: { backToMenu: string; textSize: string; language: string } };
/**
 * Tauri Phase 2: Claude/Codex/ローカルLLMがいずれも未導入のときの一度きりの案内バナー文言（情報的トーン・研究制約）。
 * health.claude===false で表示し、ユーザーが閉じるまで再訪のたびに出る（サイドバー設定等と同じ「明示的に閉じるまで
 * 表示し続ける」既読パターン。lib/llm-notice.ts 参照）。
 */
type LlmNoticeStrings = {
  llmNotice: { body: string; linkLabel: string; dismissAriaLabel: string };
};
/**
 * Tauri Phase 2: 依存不足エラー・サーバ未接続・TTSキー未設定の各バナー文言。
 * 配布アプリ（desktop）とリポジトリ開発者向け（dev/browser）で案内内容が異なるため文脈別に分ける
 * （配布ユーザーには setup.sh も bun も存在せず案内として成立しない）。lib/dep-banner.ts 参照。
 */
type BannerStrings = {
  banners: {
    depsMissingDev: (list: string) => string;
    depsMissingDesktop: string;
    serverDownDev: string;
    serverDownDesktop: string;
    ttsKeyMissing: string;
  };
};
/**
 * Tauri Phase 2 Task 4: whisperモデル未導入時（health.modelFile===false）のセットアップバナー文言。
 * 情報的トーン（研究制約）: 「これが無いと文字起こしだけ動かない、他は使える」という事実を伝えるのみで、
 * 未導入への叱責調・催促調は避ける。small選択時の精度低下は誇張も隠蔽もせず正直に書く。
 */
type SetupStrings = {
  setup: {
    intro: string;
    modelChoiceLabel: string;
    modelLarge: string; modelLargeNote: string;
    modelSmall: string; modelSmallNote: string;
    startButton: string; resumeButton: string; cancelButton: string;
    verifying: string;
    progress: (received: string, total: string) => string;
    pollError: string;
    dismissAriaLabel: string;
  };
};
/** 難易度の実態を1語で開示するチップの文言。kind ("auto"/"band"/"all") は事実マップに厳密対応（嘘のチップは信頼を壊す） */
type LevelChipStrings = { levelChip: { auto: string; band: string; all: string } };
type UiScaleStrings = { uiScale: { small: string; medium: string; large: string; xlarge: string } };
type SupportStrings = {
  support: {
    title: string;
    jaHint: string; modelTalk: string; cloze: string;
    optAuto: string; optOn: string; optOff: string;
    helpJaHint: string; helpModelTalk: string; helpCloze: string;
    helpAriaSuffix: (label: string) => string;
  };
};
type LlmPanelStrings = {
  llm: {
    title: string;
    providerLabel: string;
    optClaude: string; optOpenai: string; optCodex: string;
    baseUrlLabel: string; baseUrlPlaceholder: string;
    modelLabel: string; modelPlaceholder: string;
    codexModelLabel: string; codexModelPlaceholder: string;
    codexModelPlaceholderWith: (name: string) => string;
    save: string; saving: string;
    applied: string;
    notApplied: (msg: string) => string;
    saveFailed: string;
    saveFailedWithReason: (reason: string) => string;
    help: string; helpAria: string;
  };
};
type SettingsStrings = {
  settings: {
    title: string;
    llmSection: string;
    roleName: Record<LlmRole, string>;
    roleDesc: Record<LlmRole, string>;
    roleReason: Record<LlmRole, string>;
    roleQualityNote: string;
    presetSection: string;
    presetAllLocal: string;
    presetAllLocalDesc: string;
    presetBalanced: string;
    presetBalancedBadge: string;
    presetBalancedDesc: (cloud: CloudTarget) => string;
    presetHighQuality: string;
    presetHighQualityDesc: (cloud: CloudTarget) => string;
    presetLocalRequired: string;
    presetCustom: string;
    presetBalancedOption: string;
    preferredCloudLabel: string;
    preferredCloudNote: string;
    applyRecommendedTuning: string;
    applyRecommendedTuningNote: string;
    connectionSection: string;
    claudeNoSetup: string;
    claudeGlobalModelLabel: string;
    claudeGlobalModelNote: string;
    localConnTitle: string;
    codexConnTitle: string;
    authModeLabel: string;
    authSubscription: string;
    authApiKey: string;
    secretKeyLabel: string;
    secretStatusKeychain: string;
    secretStatusEnv: string;
    secretStatusMissing: string;
    secretApprovalRequired: string;
    claudeAuthMissingKey: string;
    secretPlaceholderSet: string;
    secretPlaceholderNew: string;
    secretSave: string;
    secretDelete: string;
    secretSaved: string;
    secretDeleted: string;
    authApiKeyNote: string;
    roleAssignSection: string;
    roleAssignDesc: string;
    targetClaude: string;
    targetLocal: string;
    targetCodex: string;
    targetLocalDisabled: string;
    tuningDetails: string;
    tuningModel: string;
    tuningEffort: string;
    tuningTier: string;
    tuningDefault: string;
    tuningDefaultWith: (v: string) => string;
    tuningSdkStandard: string;
    tuningTierFast: string;
    tuningTierStandard: string;
    effectiveLabel: string;
    effectiveUnconfirmedWith: (label: string) => string;
    cliDefaultLabel: string;
    cliDefaultBadgeWith: (label: string) => string;
    refreshCatalog: string;
    refreshingCatalog: string;
    catalogNote: string;
    saveConnection: string;
    saveAssignments: string;
    displaySection: string;
    ttsSection: string;
    ttsDesc: string;
    ttsProviderLabel: string;
    ttsProviderAutoWith: (resolved: string) => string;
    ttsProviderShortSay: string; ttsProviderShortHttp: string;
    ttsProviderSay: string; ttsProviderHttp: string;
    ttsProviderNote: string;
    ttsApiKeyOptionalNote: string;
    ttsBaseUrlLabel: string; ttsBaseUrlPlaceholder: string;
    ttsModelLabel: string; ttsModelPlaceholder: string;
    ttsVoiceLabel: string; ttsVoicePlaceholder: string;
    ttsVoicePresetLabel: string;
    ttsVoiceFemale: string; ttsVoiceMale: string; ttsVoiceCustom: string;
    ttsVoicePresetNote: string;
    ttsReset: string;
    ttsResetDescWith: (model: string, voice: string) => string;
  };
};
type StatStrings = { stat: { title: string; thisWeekUnit: string; total: (n: number) => string } };
type HeroStrings = { hero: { title: string; date: (d: Date) => string; bedtime: string } };
type QuickStrings = { quick: { label: string; note: string } };
type IntensiveStrings = { intensive: { label: string; note: string } };
type DrillsStrings = { drills: Record<DrillKey, { title: string; minutes: string; desc: string }> };
type SessionCardStrings = {
  fullSession: { title: string; minutes: string; desc: string };
  shortSession: { title: string; minutes: string; desc: string };
};
type CalendarStrings = { calendar: { title: string; legendLess: string; legendMore: string } };
type FreeTalkHeaderStrings = { freeTalk: { title: string; desc: string } };
type ProgressStrings = {
  progress: {
    levelLabel: (n: number) => string;
    toNext: (xp: number) => string;
    maxed: string;
    editTitle: string; editSave: string; editCancel: string; editError: string;
    gaugeLabel: string;
    upTitle: string; upBody: (toLevel: number) => string;
    downTitle: string; downBody: (toLevel: number) => string;
    xpReached: string;
    practicedDays: (n: number) => string;
    completionRate: (pct: number) => string;
    fttAborts: (n: number) => string;
    lowOutput: (n: number) => string;
    acceptUp: string; acceptDown: string; decline: string;
    actionError: string;
    title: string;
    speakingTime: string; speakingMinUnit: string;
    articulation: string; articulationUnit: string;
    pauseCard: string; repetitionCard: string; weekOverWeek: string;
    levelHistory: string; currentLevel: (n: number) => string;
    empty: string;
    loading: string; retry: string;
    monthlyReview: string;
    mrGenerate: string; mrGenerating: string;
    mrEmpty: string; mrError: string;
    mrPast: string;
    mrDate: (ymd: string) => string;
    mrAlreadyThisMonth: string;
  };
};
type PlacementStrings = {
  placement: {
    cardTitleNew: string; cardBodyNew: string; startDefaultNote: (lv: number) => string;
    cardTitleMonthly: string; cardBodyMonthly: string;
    introTitle: string; introBody: string; introStart: string;
    taskLabel: (i: number, total: number) => string;
    promptLabel: string;
    recordStart: string; recordStop: string; transcribing: string;
    yourAnswer: string; redo: string; next: string; submit: string;
    submitting: string; submitError: string; retry: string;
    resultTitle: string; resultStage: (stage: number) => string;
    resultStartAt: (level: number) => string; chooseOwn: string; notNow: string;
    chooseLabel: string; apply: string; confirmError: string;
    xpNote: string;
    showPromptJa: string; translating: string; translateError: string; retryTranslate: string;
    micError: (detail: string) => string;
  };
};
type SentencesStrings = {
  sentences: {
    heroTitle: string; heroDesc: string;
    tabPractice: string; tabBrowse: string;
    hideNoteLabel: string;
    audioFirstLabel: string;
    newPerDayLabel: string;
    newPerDayNote: string;
    loading: string; retry: string;
    remaining: (left: number, graded: number) => string;
    sayItFirst: string;
    listenPrompt: string;
    showCloze: string; showAnswer: string;
    clozeHint: string;
    playAgain: string;
    explainMore: string; explainLoading: string; explainError: string;
    gradeGood: string; gradeSoso: string; gradeBad: string;
    doneTitle: (n: number) => string;
    dueTomorrow: (n: number) => string;
    doneBody: string;
    setDone: (remaining: number) => string;
    setContinue: string;
    setNote: string;
    filterAll: string;
    domain: { daily: string; business: string; it: string };
    srsNew: string;
    playAria: (no: number) => string;
    chunkLabel: string;
    chunkSayIt: string;
    myChunks: string;
    deleteConfirm: string;
    deleteAria: (id: number) => string;
    playChunkAria: (id: number) => string;
  };
};

type WarmupStrings = { warmup: {
  intro: string; loading: string; retry: string; fallbackTitle: string;
  clozeStepButton: string; clozeStepTitle: string; clozeStepBody: string; outlineTitle: string;
} };
type Ftt432Strings = { ftt432: {
  min: (v: string) => string;
  prepTitle: (topic: string) => string;
  prepIntro: (rounds: string, count: number, prep: string) => string;
  prepMicNote: string; roundTimeboxNote: string; roundChunksToggle: string;
  prepTimerNote: string; loading: string; retry: string; outlineTitle: string;
  modelIdle: string; modelScript: string; modelAudio: string; modelPlaying: string; modelRetry: string;
  startRound1: (min: string) => string; modelTranscript: string;
  aeTitle: string; aeLoading: string; aeNoRecording: string; startRound2: (min: string) => string;
  doneBody: (count: number) => string;
  roundHeading: (n: number, min: string, topic: string) => string;
  timeUp: string; recStop: string; recTranscribing: string; recStart: string; roundFinish: string;
  micError: (detail: string) => string;
  explainMore: string; explainLoading: string; explainError: string;
} };
type ReflectionStrings = { reflection: {
  loading: string; retry: string; goodPhrases: string; fixes: string; tomorrow: string;
  explainMore: string; explainLoading: string; explainError: string;
} };
type ChunkListStrings = { chunkList: { playAria: (en: string) => string } };
type ShadowingStrings = { shadowing: {
  intro: string; writingScript: string; generatingAudio: string; retry: string;
  playing: string; play: string; showScript: string;
  explainMore: string; explainLoading: string; explainError: string;
} };
type LibraryStrings = { library: {
  title: string; loading: string; retry: string; empty: string;
  playAria: (title: string) => string; playing: string; transcript: string;
  explainMore: string; explainLoading: string; explainError: string;
} };
type RoleplayStrings = { roleplay: { starters: string } };
type FreeTalkScreenStrings = { freeTalkScreen: {
  idle: string; recording: string; transcribing: string; thinking: string; speaking: string; errorLabel: string;
  micError: (detail: string) => string; notHeard: string;
  hintLabel: string; hintPlaceholder: string; hintButton: string; hintThinking: string; hintError: string; retry: string;
  you: string; ai: string; translate: string; translating: string; translateError: string;
} };
type ListeningScreenStrings = { listeningScreen: {
  title: string; desc: string;
  loading: string; retry: string; empty: string;
  weekCount: (n: number) => string;
  filterFit: string; filterAll: string;
  domain: { daily: string; business: string; it: string };
  open: string; back: string;
  play: string; playing: string; stop: string;
  showScript: string; scriptLoading: string;
  explainMore: string; explainLoading: string; explainError: string;
} };
type FeedbackRowStrings = { feedbackRow: {
  prompt: string; notePlaceholder: string;
  hard: string; justRight: string; easy: string;
  thanks: string; retryHint: string;
} };
type FeedbackScreenStrings = { feedbackScreen: {
  title: string; desc: string;
  loading: string; retry: string; empty: string;
  copy: string; copied: string;
  rating: { hard: string; "just-right": string; easy: string };
  block: { session: string; "free-talk": string; listening: string };
  at: (ymd: string) => string;
  levelStage: (level: number | null, stage: number | null) => string;
} };

type AboutStrings = { about: { title: string; desc: string; lpButton: string; githubButton: string; license: string } };

type Strings =
  & NavStrings & UiScaleStrings & AppShellStrings & SupportStrings & StatStrings & HeroStrings
  & QuickStrings & IntensiveStrings & DrillsStrings & SessionCardStrings
  & CalendarStrings & FreeTalkHeaderStrings & ProgressStrings & PlacementStrings & SentencesStrings
  & MenuTitleStrings & SessionStrings
  & WarmupStrings & Ftt432Strings & ReflectionStrings & ChunkListStrings
  & ShadowingStrings & LibraryStrings & RoleplayStrings & FreeTalkScreenStrings & ListeningScreenStrings
  & LevelChipStrings & FeedbackRowStrings & FeedbackScreenStrings & LlmPanelStrings & SettingsStrings
  & AboutStrings & LlmNoticeStrings & SetupStrings & BannerStrings;

const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

export const STR: Record<Lang, Strings> = {
  en: {
    nav: {
      home: "Home", placement: "Level Check", free: "Free Talk", library: "Library", sentences: "390 Sentences", listening: "Listening", progress: "Progress", feedback: "Feedback", settings: "Settings",
      sectionToday: "Today's practice", sectionSelf: "Self-study", sectionRecords: "Records & level",
      selfStudyHint: "Your main path is Today's practice. Self-study fits spare moments — a good order: listen (Listening) → memorize (Sentences) → speak (Free talk).",
    },
    appShell: { backToMenu: "← Back to menu", textSize: "Text size", language: "Language" },
    llmNotice: {
      body: "Claude, Codex, or a local LLM isn't set up. Conversation, corrections, and explanations won't work, but example sentences, listening, shadowing, and recording transcripts still work as-is.",
      linkLabel: "Setup guide",
      dismissAriaLabel: "Dismiss",
    },
    banners: {
      depsMissingDev: (list) => `Missing dependencies: ${list} — run \`scripts/setup.sh\` to install them.`,
      depsMissingDesktop: "A bundled app file is missing (whisper). Please reinstall the app.",
      serverDownDev: "Can't connect to the API server — run `cd app && bun run dev` to start it.",
      serverDownDesktop: "Can't connect to the local server. Please restart the app.",
      ttsKeyMissing: "OPENAI_API_KEY isn't set, so text-to-speech falls back to macOS's say command.",
    },
    setup: {
      intro: "Speech-to-text needs a one-time model download. Recording transcripts won't work until it's installed — everything else (example sentences, listening, LLM features) works as-is.",
      modelChoiceLabel: "Model",
      modelLarge: "Recommended (1.6 GB)",
      modelLargeNote: "Best accuracy — matches the app's current transcription quality.",
      modelSmall: "Lightweight (0.5 GB)",
      modelSmallNote: "Faster to download, but noticeably less accurate. Good for a slow connection or a lower-spec Mac.",
      startButton: "Download",
      resumeButton: "Resume download",
      cancelButton: "Cancel",
      verifying: "Verifying download…",
      progress: (received, total) => `${received} / ${total}`,
      pollError: "Couldn't reach the server to check progress. The download may still be running — this will retry automatically.",
      dismissAriaLabel: "Dismiss",
    },
    levelChip: { auto: "Adjusts to your level", band: "Pick by level band", all: "Same for all levels" },
    uiScale: { small: "A−", medium: "A", large: "A＋", xlarge: "A＋＋" },
    support: {
      title: "Support",
      jaHint: "Japanese hints", modelTalk: "Model talk autoplay", cloze: "Fill-in-the-blank",
      optAuto: "Auto", optOn: "On", optOff: "Off",
      helpJaHint: "Whether practice chunks show a Japanese gloss. Auto: shown at lower levels, hidden as you level up. You can change it here anytime.",
      helpModelTalk: "Whether a model talk plays automatically during 4/3/2 preparation. Auto: follows your level. Even when off, you can always play it with the button.",
      helpCloze: "Whether sentence practice starts in fill-in-the-blank view. Auto: starts in normal view.",
      helpAriaSuffix: (label) => `About ${label}`,
    },
    llm: {
      title: "LLM provider",
      providerLabel: "Provider",
      optClaude: "Claude", optOpenai: "OpenAI-compatible", optCodex: "Codex",
      baseUrlLabel: "Base URL", baseUrlPlaceholder: "http://localhost:11434/v1",
      modelLabel: "Model", modelPlaceholder: "llama3.1",
      codexModelLabel: "Model (optional)", codexModelPlaceholder: "blank = Codex default",
      codexModelPlaceholderWith: (name) => `blank = default (${name})`,
      save: "Save", saving: "Saving…",
      applied: "Applied to the running app.",
      notApplied: (msg) => `Saved, but not applied: ${msg}`,
      saveFailed: "Could not save settings.",
      saveFailedWithReason: (reason) => `Could not save settings: ${reason}`,
      help: "API keys are stored in the macOS Keychain when saved here (app/.env also works; Keychain wins). The key value is never displayed or returned. Reply quality depends on the model you choose; Claude is the tested baseline.",
      helpAria: "About the LLM provider setting",
    },
    settings: {
      title: "Settings",
      llmSection: "Language model",
      roleName: {
        conversation: "Conversation",
        assist: "Quick assist",
        coaching: "Coaching",
        generation: "Content generation",
        assessment: "Assessment",
      },
      roleDesc: {
        conversation: "Free talk and role-play replies",
        assist: "One-line translation, phrasing hints, quick fix notes",
        coaching: "Feedback, reflection, explanations",
        generation: "Model talks, 4/3/2 prep, generated study material",
        assessment: "Level check and monthly review",
      },
      roleReason: {
        conversation: "Recommended: local — fastest responses. On cloud, sonnet / low is a good baseline.",
        assist: "Recommended: local — simple tasks that need an instant answer. On cloud, haiku is enough (it ignores the effort setting).",
        coaching: "Recommended: Claude / Codex — quality matters most here (corrections stay in your SRS, explanations are cached permanently). sonnet / high is a good baseline.",
        generation: "Recommended: local — templated output with modest demands. For higher quality, use sonnet / medium.",
        assessment: "Recommended: Claude / Codex — runs less than monthly and the verdict affects everything. opus / xhigh; standard delivery is fine since there's no rush.",
      },
      roleQualityNote: "Where model quality matters most: Assessment > Coaching > Content generation. Conversation benefits more from response speed.",
      presetSection: "Presets",
      presetAllLocal: "All local",
      presetAllLocalDesc: "Every role uses your local model.",
      presetBalanced: "Balanced",
      presetBalancedBadge: "Recommended",
      presetBalancedDesc: (cloud) => cloud === "claude"
        ? "Conversation and content generation run locally; coaching and assessment use Claude, where the quality gap is largest and the usage least frequent."
        : "Conversation and content generation run locally; coaching and assessment use Codex, where the quality gap is largest and the usage least frequent.",
      presetHighQuality: "Best quality",
      presetHighQualityDesc: (cloud) => cloud === "claude" ? "Every role uses Claude, the tested baseline." : "Every role uses Codex.",
      presetLocalRequired: "Set up a local LLM connection in the Model connections tab to enable the local presets.",
      presetCustom: "Custom",
      presetBalancedOption: "Balanced (Recommended)",
      preferredCloudLabel: "Preferred cloud",
      preferredCloudNote: "Used for the cloud slots when you apply a preset — pick the provider you subscribe to.",
      applyRecommendedTuning: "Apply recommended tuning",
      applyRecommendedTuningNote: "Sets the recommended model/effort/delivery for cloud-assigned roles. Local roles are left as-is. Save assignments to confirm.",
      connectionSection: "Model connections",
      claudeNoSetup: "Claude needs no setup — it works with your Claude subscription.",
      claudeGlobalModelLabel: "Default model (all roles)",
      claudeGlobalModelNote: "Applies to every role assigned to Claude unless a role overrides it in the Models-per-role tab.",
      localConnTitle: "Local LLM (OpenAI-compatible)",
      codexConnTitle: "Codex (optional)",
      authModeLabel: "Authentication",
      authSubscription: "Subscription (default)",
      authApiKey: "API key (pay-as-you-go)",
      secretKeyLabel: "API key",
      secretStatusKeychain: "Set (stored in Keychain)",
      secretStatusEnv: "Set (detected from app/.env)",
      secretStatusMissing: "Not set",
      secretApprovalRequired: "Stored, but not used for this connection. Save the key again to approve the current HTTPS or loopback address.",
      claudeAuthMissingKey: "API-key authentication is selected, but no Anthropic key is available. Save a key or switch to Subscription; requests will not fall back silently.",
      secretPlaceholderSet: "Enter a new key to replace the current one",
      secretPlaceholderNew: "Paste your API key",
      secretSave: "Save key",
      secretDelete: "Delete key",
      secretSaved: "Key saved to Keychain and applied.",
      secretDeleted: "Key removed from Keychain.",
      authApiKeyNote: "API keys are billed pay-as-you-go via api.openai.com / the Anthropic API (separate from your subscription allowance). The key itself is never stored in the UI.",
      roleAssignSection: "Model per role",
      roleAssignDesc: "Choose which model handles each role.",
      targetClaude: "Claude",
      targetLocal: "Local",
      targetCodex: "Codex",
      targetLocalDisabled: "Set up a local LLM connection in the Model connections tab to choose Local.",
      tuningDetails: "Advanced",
      tuningModel: "Model",
      tuningEffort: "Effort",
      tuningTier: "Delivery",
      tuningDefault: "Default",
      tuningDefaultWith: (v) => `Default (${v})`,
      tuningSdkStandard: "SDK standard",
      tuningTierFast: "Fast (priority)",
      tuningTierStandard: "Standard",
      effectiveLabel: "Effective:",
      effectiveUnconfirmedWith: (label) => `${label} (unconfirmed)`,
      cliDefaultLabel: "CLI default",
      cliDefaultBadgeWith: (label) => `${label} (CLI default)`,
      refreshCatalog: "Refresh model list",
      refreshingCatalog: "Refreshing…",
      catalogNote: "Fetches the real model list from Claude / Codex / your local endpoint to power the pickers below and the “Effective” line. If a source can't be reached, it degrades to “unconfirmed” rather than guessing.",
      saveConnection: "Save connections",
      saveAssignments: "Save assignments",
      displaySection: "Display",
      ttsSection: "Voice (TTS)",
      ttsDesc: "Point speech synthesis at an OpenAI-compatible endpoint. Leave blank to use the default (OpenAI when a key is set, otherwise macOS say). A local server such as kokoro-fastapi needs no API key.",
      ttsProviderLabel: "Engine",
      ttsProviderAutoWith: (resolved) => `Auto — currently: ${resolved}`,
      ttsProviderShortSay: "macOS say", ttsProviderShortHttp: "OpenAI-compatible (HTTP)",
      ttsProviderSay: "macOS say (offline)", ttsProviderHttp: "OpenAI-compatible (HTTP)",
      ttsProviderNote: "Auto uses HTTP when a key or custom Base URL is set, otherwise macOS say. Fixing to HTTP still falls back to say if the request fails.",
      ttsBaseUrlLabel: "Base URL",
      ttsBaseUrlPlaceholder: "https://api.openai.com/v1",
      ttsModelLabel: "Model",
      ttsModelPlaceholder: "gpt-4o-mini-tts",
      ttsVoiceLabel: "Voice",
      ttsVoicePlaceholder: "alloy",
      ttsVoicePresetLabel: "Voice type",
      ttsVoiceFemale: "Female",
      ttsVoiceMale: "Male",
      ttsVoiceCustom: "Custom",
      ttsVoicePresetNote: "Presets pick a matching voice for the current Base URL (OpenAI / Kokoro).",
      ttsReset: "Reset to default",
      ttsResetDescWith: (model, voice) => `Clear the overrides and return to the defaults (engine: Auto, OpenAI ${model} / ${voice} when a key is set, otherwise macOS say).`,
      ttsApiKeyOptionalNote: "A key is only needed for endpoints that require one (e.g. OpenAI); local servers work without it.",
    },
    stat: { title: "Practice log", thisWeekUnit: "days this week", total: (n) => `${n} days total` },
    hero: {
      title: "Ready to practice your English?",
      date: (d) => `${WEEKDAYS_EN[d.getDay()]}, ${MONTHS_EN[d.getMonth()]} ${d.getDate()}`,
      bedtime: "A little review before bed helps it stick.",
    },
    quick: { label: "Quick drills (5–10 min)", note: "short but daily wins" },
    intensive: { label: "Intensive sessions", note: "1–2 times a week" },
    drills: {
      warmup: { title: "Read-Aloud Warm-up", minutes: "6 min", desc: "Read today's phrases out loud" },
      "ftt-mini": { title: "Repeat Talk (4/3/2)", minutes: "8 min", desc: "Tell the same story twice, faster each time" },
      shadowing: { title: "Shadowing", minutes: "5 min", desc: "Listen and repeat in real time" },
      "roleplay-daily": { title: "Daily Role-play", minutes: "10 min", desc: "Restaurants, travel, small talk" },
      "roleplay-business": { title: "Business Role-play", minutes: "10 min", desc: "Meetings, scheduling, workplace talk" },
      "roleplay-it": { title: "IT Role-play", minutes: "10 min", desc: "Tech discussions, incidents, vendors" },
    },
    fullSession: { title: "Full Session", minutes: "60 min", desc: "Five blocks of solid practice" },
    shortSession: { title: "Short Session", minutes: "30 min", desc: "Focused training when you have time" },
    calendar: { title: "Practice days", legendLess: "Less", legendMore: "More" },
    freeTalk: { title: "Free Talk", desc: "Talk about anything in English — press the button to start and stop recording" },
    progress: {
      levelLabel: (n) => `Lv ${n}`,
      toNext: (xp) => `${xp} XP to next level`,
      maxed: "Difficulty is at max — levels are just for fun now",
      editTitle: "Set your level", editSave: "Save", editCancel: "Cancel",
      editError: "Couldn't update. Try 1–999.",
      gaugeLabel: "Level progress",
      upTitle: "Ready for the next stage?",
      upBody: (toLevel) => `Your recent practice looks solid. Move up to Lv ${toLevel}?`,
      downTitle: "An easier option",
      downBody: (toLevel) => `You could drop to Lv ${toLevel} to rebuild momentum — your XP stays.`,
      xpReached: "XP threshold reached",
      practicedDays: (n) => `${n} practice days in the last 14`,
      completionRate: (pct) => `${pct}% of recent blocks completed`,
      fttAborts: (n) => `${n} of the last five 4/3/2 blocks were cut short`,
      lowOutput: (n) => `${n} recent 4/3/2 rounds were very short on words`,
      acceptUp: "Level up", acceptDown: "Move down", decline: "Not now",
      actionError: "Couldn't apply. Refreshed the latest state.",
      title: "Progress",
      speakingTime: "Speaking time (last 14 days)", speakingMinUnit: "min",
      articulation: "Articulation rate", articulationUnit: "wpm",
      pauseCard: "Pause ratio", repetitionCard: "Self-repetition", weekOverWeek: "vs last week",
      levelHistory: "Level history", currentLevel: (n) => `Now Lv ${n}`,
      empty: "Start speaking and your metrics will show up here.",
      loading: "Loading…", retry: "Retry",
      monthlyReview: "Monthly review",
      mrGenerate: "Write this month's review",
      mrGenerating: "Writing your review…",
      mrEmpty: "Once a month, a short written review of your speaking practice appears here.",
      mrError: "Couldn't generate the review. Please try again.",
      mrPast: "Past reviews",
      mrDate: (ymd) => `Generated on ${ymd}`,
      mrAlreadyThisMonth: "This month's review is already written — showing the latest.",
    },
    placement: {
      cardTitleNew: "Find your level (10 min)",
      cardBodyNew: "Three short speaking tasks set your starting level",
      startDefaultNote: (lv) => `No test? You'll start at Lv ${lv} — you can change it anytime.`,
      cardTitleMonthly: "Monthly level check",
      cardBodyMonthly: "It's been a month — see how your speaking has moved",
      introTitle: "Level check",
      introBody: "You'll do three short speaking tasks: introduce yourself (1 min), explain a situation (1.5 min), and give an opinion (1 min). Record each one — the result only applies if you accept it.",
      introStart: "Start task 1",
      taskLabel: (i, total) => `Task ${i} of ${total}`,
      promptLabel: "Your prompt",
      recordStart: "🎙 Start speaking", recordStop: "⏹ Stop recording", transcribing: "📝 Transcribing…",
      yourAnswer: "Your answer", redo: "Record again", next: "Next task →", submit: "Get my result →",
      submitting: "Scoring your three tasks…",
      submitError: "Scoring didn't come back cleanly. Your recordings are kept — just submit again.",
      retry: "Submit again",
      resultTitle: "Your result",
      resultStage: (stage) => `Estimated stage: ${stage} of 6`,
      resultStartAt: (level) => `Start at Lv ${level}`,
      chooseOwn: "Choose my own level", notNow: "Not this time",
      chooseLabel: "Level (1–999)", apply: "Apply",
      confirmError: "Couldn't apply. Please try again.",
      xpNote: "+10 XP for completing the check",
      showPromptJa: "💡 Show Japanese", translating: "Translating…",
      translateError: "Couldn't load the translation.",
      retryTranslate: "Retry",
      micError: (detail) => `Can't access the microphone: ${detail}`,
    },
    sentences: {
      heroTitle: "390 Sentences",
      heroDesc: "Read the Japanese, say it out loud first — recalling is what builds memory",
      tabPractice: "Today's practice", tabBrowse: "Browse",
      hideNoteLabel: "Hide hints",
      audioFirstLabel: "Start from audio",
      newPerDayLabel: "New/day",
      newPerDayNote: "Applies the next time practice loads.",
      loading: "Loading…", retry: "Retry",
      remaining: (left, graded) => `${left} left (${graded} graded)`,
      sayItFirst: "↑ Say it in English out loud first",
      listenPrompt: "🔊 Listen only — say what it means or repeat it",
      showCloze: "Show gaps", showAnswer: "Show answer",
      clozeHint: "Fill the gaps out loud, then check the answer",
      playAgain: "🔊 Play again",
      explainMore: "💡 Explain more",
      explainLoading: "Writing a deeper explanation…",
      explainError: "Couldn't load the explanation. Try again on the next card.",
      gradeGood: "✅ Got it", gradeSoso: "😕 Shaky", gradeBad: "❌ Didn't come out",
      doneTitle: (n) => `Done for today (${n} sentences)`,
      dueTomorrow: (n) => `Due tomorrow: ${n}. `,
      doneBody: "Recalling out loud is the shortest path to retention. See you tomorrow.",
      setDone: (remaining) => `Set complete ✅ — ${remaining} more to go`,
      setContinue: "Continue",
      setNote: "Do the rest now or later — either is fine.",
      filterAll: "All",
      domain: { daily: "Daily", business: "Business", it: "IT" },
      srsNew: "New",
      playAria: (no) => `Play No.${no}`,
      chunkLabel: "Your phrase",
      chunkSayIt: "↑ Say a more natural version out loud",
      myChunks: "My chunks — collected from your sessions",
      deleteConfirm: "Delete?",
      deleteAria: (id) => `Delete chunk ${id}`,
      playChunkAria: (id) => `Play chunk ${id}`,
    },
    menuTitle: {
      warmup: () => "Read-Aloud Warm-up",
      ftt: (t) => `4/3/2: ${t}`,
      "ftt-mini": (t) => `Repeat Talk (4/3/2): ${t}`,
      "roleplay-daily": (t) => `Daily Role-play: ${t}`,
      "roleplay-business": (t) => `Business Role-play: ${t}`,
      "roleplay-it": (t) => `IT Role-play: ${t}`,
      shadowing: (t) => `Shadowing: ${t}`,
      reflection: () => "Reflection",
    },
    session: {
      building: "Building today's menu…", retry: "Retry", timerNote: "Move on at a natural stopping point",
      finish: "✅ Finish session", next: "Next block →", doneExit: "🏠 Back to home",
      noTopic: "No topic available", noScenario: "No scenario available",
      unknownBlock: (kind) => `Unknown block: ${kind}`,
      blockAria: (index, total) => `Block ${index + 1}/${total}`,
      fallbackNote: "We picked material from a nearby level.",
    },
    warmup: {
      intro: "Read these out loud (twice each). Tap 🔊 to hear a model. You'll use them in the 4/3/2 that follows.",
      loading: "Your coach is preparing phrases…", retry: "Retry",
      fallbackTitle: "Read these out loud instead",
      clozeStepButton: "🔡 Read with gaps (round 2 · optional)",
      clozeStepTitle: "Read with gaps (optional)",
      clozeStepBody: "This time fill the blanks yourself as you read aloud. The answers are in the list above.",
      outlineTitle: "Today's story outline",
    },
    ftt432: {
      min: (v) => `${v} min`,
      prepTitle: (topic) => `Prep — ${topic}`,
      prepIntro: (rounds, count, prep) => `You'll tell the same story ${count} times: ${rounds}. First, look over some phrases and an outline (about ${prep}).`,
      prepMicNote: "Press 🎙 to start speaking — the timer starts then. Your Round 1 recording gets coach feedback before Round 2.",
      roundTimeboxNote: "This time is a cap — if you finish sooner, that's great.",
      roundChunksToggle: "Prep phrases",
      prepTimerNote: "Time to get started", loading: "Your coach is preparing phrases…", retry: "Retry",
      outlineTitle: "Story outline",
      modelIdle: "🎧 Hear a model talk (optional)", modelScript: "✍ Writing the script…",
      modelAudio: "🎙 Generating audio…", modelPlaying: "🔊 Playing…", modelRetry: "🎧 Model talk (retry)",
      startRound1: (min) => `Start Round 1 (${min}) →`, modelTranscript: "Model talk transcript",
      aeTitle: "Feedback (read it, then Round 2)", aeLoading: "Your coach is writing feedback…",
      aeNoRecording: "No recording, so there's no feedback", startRound2: (min) => `Start Round 2 (${min})`,
      doneBody: (count) => `4/3/2 done! You told the same story ${count} times, a little faster each round.`,
      roundHeading: (n, min, topic) => `Round ${n} (${min}) — ${topic}`,
      timeUp: "— Time reached", recStop: "⏹ Stop recording", recTranscribing: "📝 Transcribing…",
      recStart: "🎙 Start speaking", roundFinish: "End this round →",
      micError: (detail) => `Can't access the microphone: ${detail}`,
      explainMore: "💡 Explain more", explainLoading: "Writing an explanation…", explainError: "Couldn't load the explanation.",
    },
    reflection: {
      loading: "Your coach is reviewing today's session…", retry: "Retry",
      goodPhrases: "👏 What went well", fixes: "✏️ Worth polishing", tomorrow: "📝 For tomorrow",
      explainMore: "💡 Explain more", explainLoading: "Writing an explanation…", explainError: "Couldn't load the explanation.",
    },
    chunkList: { playAria: (en) => `Play "${en}"` },
    shadowing: {
      intro: "First, without looking at the script, repeat the audio slightly behind it, layering your voice over it (shadowing). Even one listen is fine. Stuck? Tap 'Show script' to check.",
      writingScript: "✍ Your coach is writing the model talk…", generatingAudio: "🎙 Generating audio…", retry: "Retry",
      playing: "🔊 Playing…", play: "▶ Play (as many times as you like)", showScript: "📄 Show script",
      explainMore: "💡 Translation & notes", explainLoading: "Writing the translation and notes…",
      explainError: "Couldn't load the explanation. Please try again.",
    },
    library: {
      title: "📚 Model Talk Library", loading: "Loading…", retry: "Retry",
      empty: "Nothing yet. Model talks you generate in 4/3/2 prep or Shadowing will be saved here.",
      playAria: (title) => `Play "${title}"`, playing: "🔊 Playing…", transcript: "Transcript",
      explainMore: "💡 Translation & notes", explainLoading: "Writing the translation and notes…",
      explainError: "Couldn't load the explanation. Please try again.",
    },
    roleplay: { starters: "You could open with:" },
    freeTalkScreen: {
      idle: "🎙 Speak (click to start recording)", recording: "⏹ Recording… (click to send)",
      transcribing: "📝 Transcribing…", thinking: "🤔 Thinking…", speaking: "🔊 Playing…", errorLabel: "🎙 Speak again",
      micError: (detail) => `Can't access the microphone: ${detail}`, notHeard: "Couldn't catch that. Please try again.",
      hintLabel: "Stuck? Type what you want to say in Japanese and I'll suggest ways to say it in English",
      hintPlaceholder: "e.g. その機能はまだ試していません", hintButton: "💡 Phrasing hint",
      hintThinking: "Thinking of ways to say it…", hintError: "Couldn't get hints. Please try again.", retry: "Retry",
      you: "You", ai: "AI", translate: "Translate", translating: "Translating…", translateError: "Couldn't load the translation.",
    },
    listeningScreen: {
      title: "Listening Library",
      desc: "Short talks at your level. Listen first without the script — it trains your ear.",
      loading: "Loading…", retry: "Retry",
      empty: "No listening material for this filter yet.",
      weekCount: (n) => `${n} listens this week`,
      filterFit: "Your level", filterAll: "All",
      domain: { daily: "Daily", business: "Business", it: "IT" },
      open: "Listen", back: "← Back to list",
      play: "▶ Play", playing: "🔊 Playing…", stop: "⏹ Stop",
      showScript: "📄 Show script", scriptLoading: "Loading the script…",
      explainMore: "💡 Translation & notes", explainLoading: "Writing the translation and notes…",
      explainError: "Couldn't load the explanation. Please try again.",
    },
    feedbackRow: {
      prompt: "How was that? (optional)",
      notePlaceholder: "One-line note (optional)",
      hard: "Too hard", justRight: "Just right", easy: "Too easy",
      thanks: "Thanks — noted.",
      retryHint: "Couldn't save. Tap again to retry.",
    },
    feedbackScreen: {
      title: "Feedback",
      desc: "Your quick reactions after practice. Copy them as Markdown to feed into the next round of development.",
      loading: "Loading…", retry: "Retry",
      empty: "No feedback yet. It shows up here after you react at the end of a practice.",
      copy: "📋 Copy as Markdown", copied: "Copied!",
      rating: { hard: "Too hard", "just-right": "Just right", easy: "Too easy" },
      block: { session: "Session", "free-talk": "Free talk", listening: "Listening" },
      at: (ymd) => ymd,
      levelStage: (level, stage) =>
        [level !== null ? `Lv${level}` : null, stage !== null ? `Stage${stage}` : null].filter(Boolean).join(" · ") || "—",
    },
    about: {
      title: "About",
      desc: "solo-eikaiwa is a local-first English speaking gym for daily self-study — recording, transcription, AI conversation, and speech all run on your Mac.",
      lpButton: "Visit the website",
      githubButton: "View on GitHub",
      license: "Open source under the MIT License.",
    },
  },
  ja: {
    nav: {
      home: "ホーム", placement: "レベル測定", free: "自由会話", library: "ライブラリ", sentences: "暗記例文390", listening: "リスニング（多聴）", progress: "進捗", feedback: "フィードバック", settings: "設定",
      sectionToday: "今日の練習", sectionSelf: "自主練", sectionRecords: "記録・測定",
      selfStudyHint: "メインは「今日の練習」。自主練はすきま時間に。目安の順番: 聞く(多聴) → 覚える(暗記例文) → 話す(自由会話)。",
    },
    appShell: { backToMenu: "← メニューに戻る", textSize: "文字サイズ", language: "言語" },
    llmNotice: {
      body: "Claude/Codex/ローカルLLMが未導入の場合、会話・添削・解説は使えません。例文・多聴・シャドーイング・録音の文字起こしはそのまま使えます。",
      linkLabel: "セットアップ手順",
      dismissAriaLabel: "閉じる",
    },
    banners: {
      depsMissingDev: (list) => `不足している依存: ${list} — \`scripts/setup.sh\` を実行してください`,
      depsMissingDesktop: "アプリの同梱ファイルが見つかりません（whisper）。アプリを再インストールしてください。",
      serverDownDev: "APIサーバに接続できません — `cd app && bun run dev` で起動してください",
      serverDownDesktop: "ローカルサーバに接続できません。アプリを再起動してください。",
      ttsKeyMissing: "OPENAI_API_KEY 未設定のため TTS は say フォールバックです",
    },
    setup: {
      intro: "音声のテキスト化にはモデルの初回ダウンロードが必要です。録音の文字起こし以外（例文・多聴・LLM機能など）はこのまま使えます。",
      modelChoiceLabel: "モデル",
      modelLarge: "推奨（1.6GB）",
      modelLargeNote: "精度優先。現在のアプリの文字起こし品質と同等です。",
      modelSmall: "軽量（約0.5GB）",
      modelSmallNote: "ダウンロードは速いですが、精度ははっきり下がります。回線が遅い場合やスペックが低いMacに向いています。",
      startButton: "ダウンロード",
      resumeButton: "続きからダウンロード",
      cancelButton: "キャンセル",
      verifying: "検証中…",
      progress: (received, total) => `${received} / ${total}`,
      pollError: "進捗確認でサーバに接続できませんでした。ダウンロードは継続している可能性があります（自動的に再試行します）。",
      dismissAriaLabel: "閉じる",
    },
    levelChip: { auto: "Lvに自動調整", band: "Lv帯で選ぶ", all: "全レベル共通" },
    uiScale: { small: "小", medium: "中", large: "大", xlarge: "特大" },
    support: {
      title: "サポート",
      jaHint: "日本語ヒント", modelTalk: "モデルトーク自動再生", cloze: "歯抜け既定",
      optAuto: "自動", optOn: "オン", optOff: "オフ",
      helpJaHint: "練習チャンクに日本語訳を添えるかどうか。自動=低いレベルでは表示し、上がると非表示になります。いつでもここで変更できます。",
      helpModelTalk: "4/3/2 の準備でお手本トークを自動再生するかどうか。自動=レベルに応じた既定です。オフでもボタンでいつでも再生できます。",
      helpCloze: "例文練習を歯抜け（穴埋め）表示から始めるかどうか。自動=通常表示から始まります。",
      helpAriaSuffix: (label) => `${label}の説明`,
    },
    llm: {
      title: "LLM プロバイダ",
      providerLabel: "プロバイダ",
      optClaude: "Claude", optOpenai: "OpenAI 互換", optCodex: "Codex",
      baseUrlLabel: "ベース URL", baseUrlPlaceholder: "http://localhost:11434/v1",
      modelLabel: "モデル", modelPlaceholder: "llama3.1",
      codexModelLabel: "モデル（任意）", codexModelPlaceholder: "空欄で Codex 既定",
      codexModelPlaceholderWith: (name) => `空欄で既定（${name}）`,
      save: "保存", saving: "保存中…",
      applied: "実行中のアプリに適用しました。",
      notApplied: (msg) => `保存しましたが適用できませんでした: ${msg}`,
      saveFailed: "設定を保存できませんでした。",
      saveFailedWithReason: (reason) => `設定を保存できませんでした: ${reason}`,
      help: "ここで保存した API キーは macOS Keychain に保管されます（app/.env も併用可・Keychain が優先）。キーの値は表示・再取得されません。応答品質は選んだモデルに依存します。Claude は動作確認済みの基準です。",
      helpAria: "LLM プロバイダ設定の説明",
    },
    settings: {
      title: "設定",
      llmSection: "言語モデル",
      roleName: {
        conversation: "会話",
        assist: "クイック支援",
        coaching: "コーチング",
        generation: "教材生成",
        assessment: "測定",
      },
      roleDesc: {
        conversation: "自由会話・ロールプレイの相手応答",
        assist: "訳・言い方ヒント・ちょっとした解説",
        coaching: "添削・振り返り・解説",
        generation: "モデルトーク・4/3/2 準備・生成教材",
        assessment: "レベル測定・月次レビュー",
      },
      roleReason: {
        conversation: "推奨: ローカル — 応答が最も速いため。クラウドなら sonnet / low が目安。",
        assist: "推奨: ローカル — 単純で即答が欲しいタスク。クラウドなら haiku で十分（effort指定は無視されます）。",
        coaching: "推奨: Claude / Codex — 品質勝負（SRSに残る添削・恒久キャッシュされる解説）。sonnet / high が目安。",
        generation: "推奨: ローカル — 定型的で要求低め。品質を上げるなら sonnet / medium。",
        assessment: "推奨: Claude / Codex — 月1未満で判断が全体に波及。opus / xhigh・急がないので standard 配信で十分。",
      },
      roleQualityNote: "モデル性能が効く順: 測定 > コーチング > 教材生成。会話は性能より応答の速さが効きます。",
      presetSection: "プリセット",
      presetAllLocal: "オールローカル",
      presetAllLocalDesc: "すべての用途をローカルモデルで動かします。",
      presetBalanced: "バランス",
      presetBalancedBadge: "推奨",
      presetBalancedDesc: (cloud) => cloud === "claude"
        ? "会話・教材生成はローカル、コーチング・測定は品質差が最も大きく実行頻度も低いため Claude を使います。"
        : "会話・教材生成はローカル、コーチング・測定は品質差が最も大きく実行頻度も低いため Codex を使います。",
      presetHighQuality: "最高品質",
      presetHighQualityDesc: (cloud) => cloud === "claude" ? "すべての用途を Claude（動作確認済みの基準）で動かします。" : "すべての用途を Codex で動かします。",
      presetLocalRequired: "「モデル接続設定」タブでローカル LLM の接続先を設定すると、ローカルを使うプリセットが選べます。",
      presetCustom: "カスタム",
      presetBalancedOption: "バランス（推奨）",
      preferredCloudLabel: "優先クラウド",
      preferredCloudNote: "プリセット適用時のクラウド枠に使われます。課金しているサービスに合わせてください。",
      applyRecommendedTuning: "推奨チューニングを適用",
      applyRecommendedTuningNote: "クラウド割当の用途に推奨のモデル/effort/配信を設定します（ローカル割当は変更しません）。「割当を保存」で確定します。",
      connectionSection: "モデル接続設定",
      claudeNoSetup: "Claude は設定不要です（Claude のサブスクリプションで動作します）。",
      claudeGlobalModelLabel: "既定モデル（全用途共通）",
      claudeGlobalModelNote: "Claude に割り当てた全ての用途に適用されます（用途ごとのモデルタブで用途別に上書き可能）。",
      localConnTitle: "ローカル LLM（OpenAI 互換）",
      codexConnTitle: "Codex（任意）",
      authModeLabel: "認証",
      authSubscription: "サブスクリプション（既定）",
      authApiKey: "APIキー（従量課金）",
      secretKeyLabel: "API キー",
      secretStatusKeychain: "設定済み（Keychain に保存）",
      secretStatusEnv: "設定済み（app/.env から検出）",
      secretStatusMissing: "未設定",
      secretApprovalRequired: "キーは保存済みですが、この接続先には使用しません。現在の HTTPS または loopback 接続先を承認するには、キーを再保存してください。",
      claudeAuthMissingKey: "APIキー認証が選択されていますが、Anthropic のキーがありません。キーを保存するかサブスクリプションへ切り替えてください。会話時に無言で認証方式を切り替えることはありません。",
      secretPlaceholderSet: "置き換える場合は新しいキーを入力",
      secretPlaceholderNew: "API キーを貼り付け",
      secretSave: "キーを保存",
      secretDelete: "キーを削除",
      secretSaved: "キーを Keychain に保存し、適用しました。",
      secretDeleted: "キーを Keychain から削除しました。",
      authApiKeyNote: "APIキーは api.openai.com / Anthropic API の従量課金です（サブスクの利用枠とは別）。キーは UI には保存されません。",
      roleAssignSection: "用途ごとのモデル",
      roleAssignDesc: "各用途をどのモデルに任せるか選びます。",
      targetClaude: "Claude",
      targetLocal: "ローカル",
      targetCodex: "Codex",
      targetLocalDisabled: "「モデル接続設定」タブでローカル LLM の接続先を設定すると「ローカル」を選べます。",
      tuningDetails: "詳細設定",
      tuningModel: "モデル",
      tuningEffort: "effort（思考の深さ）",
      tuningTier: "配信",
      tuningDefault: "既定",
      tuningDefaultWith: (v) => `既定（${v}）`,
      tuningSdkStandard: "SDK標準",
      tuningTierFast: "fast（優先配信）",
      tuningTierStandard: "standard（標準・安価）",
      effectiveLabel: "実効:",
      effectiveUnconfirmedWith: (label) => `${label}（実体未確認）`,
      cliDefaultLabel: "CLI既定",
      cliDefaultBadgeWith: (label) => `${label}（CLI既定）`,
      refreshCatalog: "モデル一覧を更新",
      refreshingCatalog: "更新中…",
      catalogNote: "Claude/Codex/ローカル接続先から実際のモデル一覧を取得し、下の選択肢と「実効」表示に反映します。取得できないソースは推測せず「実体未確認」に留めます。",
      saveConnection: "接続を保存",
      saveAssignments: "割当を保存",
      displaySection: "表示",
      ttsSection: "音声（TTS）",
      ttsDesc: "音声合成の向き先を OpenAI 互換エンドポイントに変更できます。空欄なら既定（キー設定時は OpenAI・無ければ macOS say）。kokoro-fastapi 等のローカルサーバは API キー不要です。",
      ttsProviderLabel: "エンジン",
      ttsProviderAutoWith: (resolved) => `自動 — 現在: ${resolved}`,
      ttsProviderShortSay: "macOS say", ttsProviderShortHttp: "OpenAI 互換（HTTP）",
      ttsProviderSay: "macOS say（オフライン）", ttsProviderHttp: "OpenAI 互換（HTTP）",
      ttsProviderNote: "自動は、キーまたはカスタム Base URL があれば HTTP、無ければ macOS say を使います。HTTP 固定でも通信に失敗したときは say で再生します。",
      ttsBaseUrlLabel: "ベース URL",
      ttsBaseUrlPlaceholder: "https://api.openai.com/v1",
      ttsModelLabel: "モデル",
      ttsModelPlaceholder: "gpt-4o-mini-tts",
      ttsVoiceLabel: "voice",
      ttsVoicePlaceholder: "alloy",
      ttsVoicePresetLabel: "声のタイプ",
      ttsVoiceFemale: "女性",
      ttsVoiceMale: "男性",
      ttsVoiceCustom: "カスタム",
      ttsVoicePresetNote: "現在の Base URL（OpenAI / Kokoro）に合った声を入力欄にセットします。",
      ttsReset: "既定に戻す",
      ttsResetDescWith: (model, voice) => `上書きを消して、既定（エンジン: 自動・キー設定時は OpenAI ${model} / ${voice}・無ければ macOS say）に戻します。`,
      ttsApiKeyOptionalNote: "キーが必要なのは OpenAI 等の鍵必須エンドポイントのみです（ローカルサーバは不要）。",
    },
    stat: { title: "練習記録", thisWeekUnit: "日（今週）", total: (n) => `累計 ${n}日` },
    hero: {
      title: "今日も英語を話しましょう",
      date: (d) => `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS_JA[d.getDay()]}）`,
      bedtime: "寝る前の復習は、記憶の定着に少し有利です。",
    },
    quick: { label: "クイックドリル（5〜10分）", note: "短くても毎日が正解" },
    intensive: { label: "強化セッション", note: "週1〜2回おすすめ" },
    drills: {
      warmup: { title: "音読ウォームアップ", minutes: "6分", desc: "今日の表現を声に出して準備" },
      "ftt-mini": { title: "くり返しトーク（4/3/2）", minutes: "8分", desc: "同じ話を2回、制限時間を短くしながら流暢に" },
      shadowing: { title: "シャドーイング", minutes: "5分", desc: "聞こえた英語に重ねて言う" },
      "roleplay-daily": { title: "日常ロールプレイ", minutes: "10分", desc: "レストラン・旅行・雑談の場面練習" },
      "roleplay-business": { title: "ビジネスロールプレイ", minutes: "10分", desc: "会議・日程調整・職場の会話" },
      "roleplay-it": { title: "ITロールプレイ", minutes: "10分", desc: "技術討議・障害対応・ベンダー対応" },
    },
    fullSession: { title: "通しセッション", minutes: "60分", desc: "5ブロックで総合的にしっかり練習" },
    shortSession: { title: "短縮セッション", minutes: "30分", desc: "時間がある日の集中トレーニング" },
    calendar: { title: "練習日", legendLess: "少", legendMore: "多" },
    freeTalk: { title: "自由会話", desc: "英語でなんでも話しかけてください — 録音ボタンで開始・停止" },
    progress: {
      levelLabel: (n) => `Lv ${n}`,
      toNext: (xp) => `次のレベルまで ${xp} XP`,
      maxed: "難易度は最大です — 以降のレベルはおまけ",
      editTitle: "レベルを変更", editSave: "保存", editCancel: "キャンセル",
      editError: "更新できませんでした。1〜999で指定してください",
      gaugeLabel: "レベル進捗",
      upTitle: "次のステージに進みませんか？",
      upBody: (toLevel) => `最近の練習は好調です。Lv ${toLevel} に上げますか？`,
      downTitle: "難易度の調整もできます",
      downBody: (toLevel) => `Lv ${toLevel} に戻して基礎を固め直すこともできます（XPは減りません）。`,
      xpReached: "必要XPに到達",
      practicedDays: (n) => `直近14日間の練習日 ${n}日`,
      completionRate: (pct) => `直近ブロックの完了率 ${pct}%`,
      fttAborts: (n) => `直近5回の4/3/2のうち${n}回が中断`,
      lowOutput: (n) => `直近の4/3/2で発話が極端に短いラウンドが${n}回`,
      acceptUp: "レベルアップ", acceptDown: "レベルを下げる", decline: "今はしない",
      actionError: "適用できませんでした。最新の状態に更新しました",
      title: "進捗",
      speakingTime: "話した時間（直近14日）", speakingMinUnit: "分",
      articulation: "調音速度", articulationUnit: "wpm",
      pauseCard: "ポーズ比率", repetitionCard: "言い直し率", weekOverWeek: "前週比",
      levelHistory: "レベル履歴", currentLevel: (n) => `現在 Lv ${n}`,
      empty: "話すと、ここに記録が貯まりはじめます。",
      loading: "読み込み中…", retry: "再試行",
      monthlyReview: "月次レビュー",
      mrGenerate: "今月のレビューを書いてもらう",
      mrGenerating: "レビューを書いています…",
      mrEmpty: "月に一度、スピーキング練習の振り返りレポートがここに表示されます。",
      mrError: "レビューを生成できませんでした。もう一度お試しください。",
      mrPast: "過去のレビュー",
      mrDate: (ymd) => `${ymd} 生成`,
      mrAlreadyThisMonth: "今月のレビューは生成済みです — 最新の内容を表示しています。",
    },
    placement: {
      cardTitleNew: "レベル測定（10分）",
      cardBodyNew: "3つの短いスピーキングで開始レベルを決めます",
      startDefaultNote: (lv) => `測定しない場合は Lv${lv} から始まります（いつでも変更できます）。`,
      cardTitleMonthly: "月次レベル測定",
      cardBodyMonthly: "前回から1ヶ月 — 話す力の変化を見てみましょう",
      introTitle: "レベル測定",
      introBody: "3つの短いスピーキングを行います: 自己紹介（1分）→ 状況説明（1.5分）→ 意見（1分）。それぞれ録音してください。結果はあなたが承認したときだけ反映されます。",
      introStart: "タスク1を始める",
      taskLabel: (i, total) => `タスク ${i} / ${total}`,
      promptLabel: "お題",
      recordStart: "🎙 話し始める", recordStop: "⏹ 録音を止める", transcribing: "📝 文字起こし中…",
      yourAnswer: "あなたの回答", redo: "録音し直す", next: "次のタスクへ →", submit: "結果を見る →",
      submitting: "3つのタスクを採点しています…",
      submitError: "採点結果をうまく受け取れませんでした。録音は保持されています — もう一度送信してください。",
      retry: "もう一度送信",
      resultTitle: "測定結果",
      resultStage: (stage) => `推定ステージ: ${stage} / 6`,
      resultStartAt: (level) => `Lv ${level} から始める`,
      chooseOwn: "自分でレベルを選ぶ", notNow: "今回は反映しない",
      chooseLabel: "レベル（1〜999）", apply: "適用",
      confirmError: "適用できませんでした。もう一度お試しください",
      xpNote: "測定完了で +10 XP",
      showPromptJa: "💡 日本語で見る", translating: "訳しています…",
      translateError: "訳を取得できませんでした。",
      retryTranslate: "再試行",
      micError: (detail) => `マイクにアクセスできません: ${detail}`,
    },
    sentences: {
      heroTitle: "暗記例文390",
      heroDesc: "日本語を見て、まず声に出す — 思い出す練習が記憶を作ります",
      tabPractice: "今日の練習", tabBrowse: "一覧",
      hideNoteLabel: "ヒントを隠す",
      audioFirstLabel: "音から始める",
      newPerDayLabel: "1日の新規",
      newPerDayNote: "次に練習タブを開いたときから反映されます。",
      loading: "読み込み中…", retry: "再試行",
      remaining: (left, graded) => `残り ${left} 文（うち評価済み ${graded}）`,
      sayItFirst: "↑ を英語で、まず声に出して言ってみる",
      listenPrompt: "🔊 音だけを聞いて、意味を言う・繰り返してみましょう",
      showCloze: "歯抜けを見る", showAnswer: "答えを見る",
      clozeHint: "空欄を埋めながらもう一度声に出して、答え合わせへ",
      playAgain: "🔊 もう一度聞く",
      explainMore: "💡 もっと詳しく",
      explainLoading: "詳しい解説を書いています…",
      explainError: "解説を取得できませんでした。次のカードで再度お試しください。",
      gradeGood: "✅ 言えた", gradeSoso: "😕 あいまい", gradeBad: "❌ 出てこない",
      doneTitle: (n) => `今日の分は完了です（${n}文）`,
      dueTomorrow: (n) => `明日の復習予定: ${n}文。`,
      doneBody: "思い出して声に出すことが定着の近道です。また明日。",
      setDone: (remaining) => `今日のセット完了 ✅ — 続きが ${remaining} 文あります`,
      setContinue: "続ける",
      setNote: "続きは今でも後でもOKです。",
      filterAll: "すべて",
      domain: { daily: "日常", business: "ビジネス", it: "IT" },
      srsNew: "未学習",
      playAria: (no) => `No.${no} を再生`,
      chunkLabel: "あなたの表現",
      chunkSayIt: "↑ より自然な言い方を声に出してみましょう",
      myChunks: "マイチャンク — セッションから自動収集",
      deleteConfirm: "削除する?",
      deleteAria: (id) => `チャンク${id}を削除`,
      playChunkAria: (id) => `チャンク${id}を再生`,
    },
    menuTitle: {
      warmup: () => "音読ウォームアップ",
      ftt: (t) => `4/3/2: ${t}`,
      "ftt-mini": (t) => `くり返しトーク（4/3/2）: ${t}`,
      "roleplay-daily": (t) => `日常ロールプレイ: ${t}`,
      "roleplay-business": (t) => `ビジネスロールプレイ: ${t}`,
      "roleplay-it": (t) => `ITロールプレイ: ${t}`,
      shadowing: (t) => `シャドーイング: ${t}`,
      reflection: () => "振り返り",
    },
    session: {
      building: "今日のメニューを組んでいます…", retry: "再試行", timerNote: "キリのいいところで次へ",
      finish: "✅ セッションを終える", next: "次のブロックへ →", doneExit: "🏠 ホームに戻る",
      noTopic: "トピックがありません", noScenario: "シナリオがありません",
      unknownBlock: (kind) => `未知のブロック: ${kind}`,
      blockAria: (index, total) => `ブロック ${index + 1}/${total}`,
      fallbackNote: "近いレベルの教材を選びました",
    },
    warmup: {
      intro: "声に出して読みましょう（各フレーズ2回ずつ）。🔊でお手本を聞けます。このあとの 4/3/2 で実際に使います。",
      loading: "コーチが表現チャンクを用意しています…", retry: "再試行",
      fallbackTitle: "代わりにこちらを声に出して読みましょう",
      clozeStepButton: "🔡 歯抜けで音読（2周目・任意）",
      clozeStepTitle: "歯抜けで音読（任意）",
      clozeStepBody: "今度は空欄を自分で埋めながら声に出しましょう。答えは上の一覧で確認できます。",
      outlineTitle: "今日の話の骨組み",
    },
    ftt432: {
      min: (v) => `${v}分`,
      prepTitle: (topic) => `準備 — ${topic}`,
      prepIntro: (rounds, count, prep) => `これから同じ話を ${rounds} で${count}回話します。まず使えそうな表現と骨組みを確認してください（目安 ${prep}）。`,
      prepMicNote: "🎙を押して話し始めるとタイマーが動きます。Round 1 の録音には Round 2 の前にコーチのフィードバックが付きます。",
      roundTimeboxNote: "時間は上限です。言えたところまでで早く終えてもOKです。",
      roundChunksToggle: "準備の表現チャンク",
      prepTimerNote: "そろそろ始めましょう", loading: "コーチが表現チャンクを用意しています…", retry: "再試行",
      outlineTitle: "話の骨組み",
      modelIdle: "🎧 モデルトークを聞く（任意）", modelScript: "✍ 原稿を作成中…",
      modelAudio: "🎙 音声を生成中…", modelPlaying: "🔊 再生中…", modelRetry: "🎧 モデルトーク（再試行）",
      startRound1: (min) => `Round 1 を始める（${min}）→`, modelTranscript: "モデルトーク本文",
      aeTitle: "フィードバック（読んだら Round 2 へ）", aeLoading: "コーチがフィードバックを書いています…",
      aeNoRecording: "録音がなかったのでフィードバックはありません", startRound2: (min) => `Round 2 を始める（${min}）`,
      doneBody: (count) => `4/3/2 完了！同じ話を${count}回、少しずつ速く話せました。`,
      roundHeading: (n, min, topic) => `Round ${n}（${min}） — ${topic}`,
      timeUp: "— 目安の時間になりました", recStop: "⏹ 録音を止める", recTranscribing: "📝 文字起こし中…",
      recStart: "🎙 話し始める", roundFinish: "このラウンドを終える →",
      micError: (detail) => `マイクにアクセスできません: ${detail}`,
      explainMore: "💡 もっと詳しく", explainLoading: "解説を書いています…", explainError: "解説を取得できませんでした。",
    },
    reflection: {
      loading: "コーチが今日のセッションを振り返っています…", retry: "再試行",
      goodPhrases: "👏 良かった表現", fixes: "✏️ 直したい表現", tomorrow: "📝 明日へ",
      explainMore: "💡 もっと詳しく", explainLoading: "解説を書いています…", explainError: "解説を取得できませんでした。",
    },
    chunkList: { playAria: (en) => `「${en}」を再生` },
    shadowing: {
      intro: "まずはスクリプトを見ずに、音声に少し遅れてかぶせるように声に出して繰り返します（シャドーイング）。1回聞くだけでもOK。行き詰まったら「スクリプトを表示」で確認できます。",
      writingScript: "✍ コーチがモデルトークを書いています…", generatingAudio: "🎙 音声を生成しています…", retry: "再試行",
      playing: "🔊 再生中…", play: "▶ 再生（何度でも）", showScript: "📄 スクリプトを表示",
      explainMore: "💡 日本語訳と解説", explainLoading: "日本語訳と解説を書いています…",
      explainError: "解説を取得できませんでした。もう一度お試しください。",
    },
    library: {
      title: "📚 モデルトークライブラリ", loading: "読み込み中…", retry: "再試行",
      empty: "まだありません。4/3/2 の準備やシャドーイングでモデルトークを生成すると、ここに残ります。",
      playAria: (title) => `「${title}」を再生`, playing: "🔊 再生中…", transcript: "本文",
      explainMore: "💡 日本語訳と解説", explainLoading: "日本語訳と解説を書いています…",
      explainError: "解説を取得できませんでした。もう一度お試しください。",
    },
    roleplay: { starters: "こう切り出せます:" },
    freeTalkScreen: {
      idle: "🎙 話す（クリックで録音開始）", recording: "⏹ 録音中…（クリックで送信）",
      transcribing: "📝 文字起こし中…", thinking: "🤔 考え中…", speaking: "🔊 再生中…", errorLabel: "🎙 もう一度話す",
      micError: (detail) => `マイクにアクセスできません: ${detail}`, notHeard: "音声を聞き取れませんでした。もう一度話してください。",
      hintLabel: "うまく言えないときは、言いたいことを日本語で入力すると英語の言い方を提案します",
      hintPlaceholder: "例: その機能はまだ試していません", hintButton: "💡 言い方のヒント",
      hintThinking: "言い方を考えています…", hintError: "ヒントを取得できませんでした。もう一度お試しください。", retry: "再試行",
      you: "あなた", ai: "AI", translate: "訳", translating: "訳しています…", translateError: "訳を取得できませんでした。",
    },
    listeningScreen: {
      title: "多聴ライブラリ",
      desc: "レベルに合った短い英語を聞きます。まずはスクリプトを見ずに聞くと、耳が育ちます。",
      loading: "読み込み中…", retry: "再試行",
      empty: "この絞り込みに合う多聴素材がまだありません。",
      weekCount: (n) => `今週 ${n} 本`,
      filterFit: "自分のレベル", filterAll: "すべて",
      domain: { daily: "日常", business: "ビジネス", it: "IT" },
      open: "聞く", back: "← 一覧に戻る",
      play: "▶ 再生", playing: "🔊 再生中…", stop: "⏹ 停止",
      showScript: "📄 スクリプトを表示", scriptLoading: "スクリプトを読み込み中…",
      explainMore: "💡 日本語訳と解説", explainLoading: "日本語訳と解説を書いています…",
      explainError: "解説を取得できませんでした。もう一度お試しください。",
    },
    feedbackRow: {
      prompt: "今のはどうでしたか？（任意）",
      notePlaceholder: "ひとことメモ（任意）",
      hard: "キツい", justRight: "ちょうどいい", easy: "簡単",
      thanks: "ありがとう、記録しました。",
      retryHint: "保存できませんでした。もう一度タップしてください。",
    },
    feedbackScreen: {
      title: "フィードバック",
      desc: "練習のあとに送った短い反応の記録です。Markdown でコピーして次の開発サイクルの入力にできます。",
      loading: "読み込み中…", retry: "再試行",
      empty: "まだフィードバックはありません。練習の最後に反応するとここに表示されます。",
      copy: "📋 Markdownでコピー", copied: "コピーしました",
      rating: { hard: "キツい", "just-right": "ちょうどいい", easy: "簡単" },
      block: { session: "セッション", "free-talk": "自由会話", listening: "多聴" },
      at: (ymd) => ymd,
      levelStage: (level, stage) =>
        [level !== null ? `Lv${level}` : null, stage !== null ? `Stage${stage}` : null].filter(Boolean).join(" · ") || "—",
    },
    about: {
      title: "このアプリについて",
      desc: "solo-eikaiwa は、録音・文字起こし・AI 会話・音声合成まで自分の Mac の上で完結する、毎日のひとり英会話ジムです。",
      lpButton: "紹介ページ（LP）を開く",
      githubButton: "GitHub リポジトリを開く",
      license: "MIT ライセンスのオープンソースです。",
    },
  },
};
