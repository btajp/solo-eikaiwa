/** トップページ・サイドバーの表示言語（localStorageに保存） */
export type Lang = "en" | "ja";

import type { LlmRole } from "./api/llm-settings";
import type { CloudTarget } from "./lib/llm-assignments";

/** 保存済み設定を最優先し、初回だけブラウザの表示言語から日英を決める。 */
export function resolveLang(saved: string | null, locale: string | undefined): Lang {
  if (saved === "ja" || saved === "en") return saved;
  return locale?.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function loadLang(): Lang {
  return resolveLang(localStorage.getItem("lang"), navigator.language);
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
    preparingBlock: string; completeAfterAttempt: string; leaveBeforeComplete: string; doneSummary: string;
    blockEstimate: (time: string) => string;
    xpSaveFailed: string; xpRetry: string; xpRetrying: string;
    noTopic: string; noScenario: string; unknownBlock: (kind: string) => string;
    blockAria: (index: number, total: number) => string;
    /** v0.26 wave5: rotation の情報的注記。教材がラウンドロビン振替・帯域緩和のフォールバックで選ばれたときだけ表示する中立な一文（警告調ではない） */
    fallbackNote: string;
  };
};

type NavStrings = {
  nav: {
    home: string; placement: string; free: string; library: string; sentences: string; listening: string; progress: string; feedback: string; settings: string;
    sectionToday: string; sectionSelf: string; sectionRecords: string; selfStudyHint: string; navigationLabel: string;
  };
};
type AppShellStrings = { appShell: { backToHome: string; textSize: string; language: string } };
type RouteStrings = { routes: {
  unknown: string;
  sessionNotRestored: string;
  leaveSession: string;
  stay: string;
  leave: string;
} };
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
    retry: string;
    ttsKeyMissing: string;
  };
};
type ErrorStrings = { errors: {
  action: {
    load: string; save: string; apply: string; submit: string; record: string; play: string; request: string;
  };
  category: {
    VALIDATION: string; OFFLINE: string; TIMEOUT: string; AUTHORIZATION: string;
    NOT_FOUND: string; SERVER: string; UNKNOWN: string;
  };
  reference: (id: string) => string;
} };
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
    resumeBannerBody: string;
    resumeBannerAction: string;
  };
};
/** 録音・採点を始める前の環境確認。不足時も操作を無言で無効化せず、復旧操作を同じ場所に出す。 */
type PracticeReadinessStrings = {
  practiceReadiness: {
    sttNeeded: string;
    llmNeeded: string;
    sttAndLlmNeeded: string;
    openSetup: string;
    openSettings: string;
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
    baseUrlLabel: string; baseUrlPlaceholder: string;
    modelLabel: string; modelPlaceholder: string;
    codexModelLabel: string; codexModelPlaceholder: string;
    codexModelPlaceholderWith: (name: string) => string;
    save: string; saving: string;
    applied: string;
    notApplied: (msg: string) => string;
    help: string;
  };
};
type SettingsStrings = {
  settings: {
    title: string;
    loadLlmFailed: string;
    loadTtsFailed: string;
    loadSecretsFailed: string;
    retry: string;
    roleName: Record<LlmRole, string>;
    roleDesc: Record<LlmRole, string>;
    roleReason: Record<LlmRole, string>;
    roleQualityNote: string;
    presetSection: string;
    presetAllLocal: string;
    presetAllLocalDesc: string;
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
    endpointLabel: string;
    endpointLoopback: string;
    endpointLan: string;
    endpointRemote: string;
    endpointInvalid: string;
    endpointCloudManaged: string;
    endpointLoopbackDisclosure: string;
    endpointLanDisclosure: string;
    endpointRemoteDisclosure: string;
    endpointInvalidDisclosure: string;
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
    secretDeleteConfirm: string;
    secretSaving: string;
    secretDeleting: string;
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
    unsavedChanges: string;
    connectionSaveNote: string;
    rolesSaveNote: string;
    presetSaveNote: string;
    saveConnectionFirst: string;
    authModeSaveRequired: string;
    localRoleConnectionRequired: string;
    ttsSaveNote: string;
    ttsResetStaged: string;
    displayImmediateNote: string;
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
type QuickStrings = { quick: {
  label: string; note: string; oneEnough: string;
  suggestionLabel: string; suggestionReason: string;
} };
type IntensiveStrings = { intensive: { label: string; note: string } };
type DrillsStrings = { drills: Record<DrillKey, { title: string; minutes: string; desc: string; requires: string }> };
type SessionCardStrings = {
  fullSession: { title: string; minutes: string; desc: string; requires: string };
  shortSession: { title: string; minutes: string; desc: string; requires: string };
};
type CalendarStrings = {
  calendar: {
    title: string; legendLess: string; legendMore: string;
    loading: string; loadError: string; retry: string;
    dayLabel: (date: string, xp: number) => string; summary: (count: number) => string;
  };
};
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
    speakingTime: string; speakingMinUnit: string; speakingDay: (date: string, minutes: string) => string;
    articulation: string; articulationUnit: string; articulationDay: (date: string, wpm: number) => string;
    pauseCard: string; repetitionCard: string; weekOverWeek: string;
    levelHistory: string; currentLevel: (n: number) => string;
    empty: string;
    loading: string; retry: string;
    monthlyReview: string;
    mrGenerate: string; mrGenerating: string;
    mrEmpty: string; mrError: string;
    mrLoading: string; mrLoadError: string;
    mrHistoryLoading: string; mrHistoryLoadError: string;
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
    loading: string; loadRetry: string; exitNote: string;
    taskLabel: (i: number, total: number) => string;
    promptLabel: string;
    recordStart: string; recordReplace: string; recordStarting: string; recordStop: string; transcribing: string;
    yourAnswer: string; redo: string; next: string; submit: string;
    submitting: string; submitError: string; retry: string;
    resultTitle: string; resultStage: (stage: number) => string;
    stageLevelNote: (stage: number, level: number) => string;
    resultStartAt: (level: number) => string; chooseOwn: string; notNow: string; cancel: string;
    chooseLabel: string; chooseInputHelp: string;
    chooseInputError: (reason: "required" | "whole-number" | "range") => string;
    apply: string; applyTiming: string; levelApplied: (level: number) => string; confirmError: string;
    xpNote: string;
    showPromptJa: string; translating: string; translateError: string; retryTranslate: string;
    micError: (detail: string) => string; notHeard: string;
  };
};
type SentencesStrings = {
  sentences: {
    heroTitle: string; heroDesc: string;
    tabPractice: string; tabBrowse: string;
    hideNoteLabel: string;
    audioFirstLabel: string;
    newPerDayLabel: string;
    hideNoteTiming: string; audioFirstTiming: string; newPerDayTiming: string; newPerDayApply: string;
    loading: string; retry: string;
    remaining: (left: number, graded: number) => string;
    sayItFirst: string;
    listenPrompt: string;
    showCloze: string; showAnswer: string;
    clozeHint: string;
    playAgain: string; audioPlaybackError: string;
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
    searchLabel: string; searchPlaceholder: string;
    categoryLabel: string; categoryAll: string;
    studyLabel: string; studyAll: string; studyNew: string; studyScheduled: string;
    previousPage: string; nextPage: string; pageOf: (page: number, total: number, count: number) => string;
    noResults: string; noChunks: string;
    srsNew: string;
    srsScheduled: (stage: number, due: string) => string;
    playAria: (no: number) => string;
    chunkLabel: string;
    chunkSayIt: string;
    myChunks: string;
    hiddenChunks: string;
    showHiddenChunks: (n: number) => string;
    hideHiddenChunks: string;
    hideChunk: string;
    hideChunkAria: (id: number) => string;
    restoreChunk: string;
    restoreChunkAria: (id: number) => string;
    chunkLoadError: string;
    playChunkAria: (id: number) => string;
  };
};
type CollectedPhrasesStrings = { collectedPhrases: {
  savedTitle: (count: number) => string;
  savedBody: string;
  open: string;
  none: string;
  failed: string;
} };

type WarmupStrings = { warmup: {
  intro: string; loading: string; retry: string; fallbackTitle: string;
  clozeStepButton: string; clozeStepTitle: string; clozeStepBody: string; outlineTitle: string;
  confirmReading: string; readingConfirmed: string;
  showJaHints: string; hideJaHints: string;
} };
type Ftt432Strings = { ftt432: {
  prepTitle: (topic: string) => string;
  prepIntro: (rounds: string, count: number, prep: string) => string;
  prepMicNote: string; roundTimeboxNote: string; roundChunksToggle: string;
  prepTimerLabel: string; prepTimerAria: (time: string) => string;
  prepTimerNote: string; loading: string; retry: string; outlineTitle: string;
  showJaHints: string; hideJaHints: string;
  modelIdle: string; modelScript: string; modelAudio: string; modelRetry: string;
  startRound1: (time: string) => string; modelTranscript: string;
  aeTitle: string; aeLoading: string; aeNoRecording: string; startRound2: (time: string) => string;
  doneBody: (count: number) => string;
  roundHeading: (n: number, time: string, topic: string) => string;
  roundTimerAria: (n: number, time: string) => string;
  transcriptYou: string;
  timeUp: string; recStop: string; recStarting: string; recTranscribing: string; recStart: string; roundFinish: string;
  micError: (detail: string) => string; notHeard: string;
  explainMore: string; explainLoading: string; explainError: string;
} };
type ReflectionStrings = { reflection: {
  loading: string; retry: string; goodPhrases: string; fixes: string; tomorrow: string;
  confirmReview: string; reviewed: string;
  explainMore: string; explainLoading: string; explainError: string;
} };
type ChunkListStrings = { chunkList: { playAria: (en: string) => string } };
type PlaybackStrings = { playback: { stop: string; playing: string } };
/** 生成教材の原文は script と呼び、録音由来の transcript / 文字起こしとは区別する。 */
type ShadowingStrings = { shadowing: {
  intro: string; writingScript: string; generatingAudio: string; retry: string;
  play: string; showScript: string; playbackError: string; playbackRetry: string;
  explainMore: string; explainLoading: string; explainError: string;
} };
type LibraryStrings = { library: {
  title: string; loading: string; retry: string; empty: string;
  playAria: (title: string) => string; transcript: string;
  explainMore: string; explainLoading: string; explainError: string;
} };
type RoleplayStrings = { roleplay: { starters: string } };
type FreeTalkScreenStrings = { freeTalkScreen: {
  idle: string; starting: string; recording: string; transcribing: string; thinking: string; speaking: string; errorLabel: string;
  discardRecording: string; stopAndSendHint: string;
  finishPractice: string; continuePractice: string;
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
  play: string;
  logSaving: string; logFailed: string; logRetry: string;
  showScript: string; scriptLoading: string;
  explainMore: string; explainLoading: string; explainError: string;
} };
type FeedbackRowStrings = { feedbackRow: {
  prompt: string; purpose: string; notePlaceholder: string;
  target: { session: string; "free-talk": string; listening: string; default: string };
  hard: string; justRight: string; easy: string;
  thanks: string; retryHint: string;
} };
type FeedbackScreenStrings = { feedbackScreen: {
  title: string; desc: string;
  loading: string; retry: string; empty: string;
  copy: string; copying: string; copied: string; copyFailed: string;
  rating: { hard: string; "just-right": string; easy: string };
  block: { session: string; "free-talk": string; listening: string };
  at: (ymd: string) => string;
  levelStage: (level: number | null, stage: number | null) => string;
} };

type AboutStrings = { about: { title: string; desc: string; lpButton: string; githubButton: string; license: string } };

type Strings =
  & NavStrings & UiScaleStrings & AppShellStrings & RouteStrings & SupportStrings & StatStrings & HeroStrings
  & QuickStrings & IntensiveStrings & DrillsStrings & SessionCardStrings
  & CalendarStrings & FreeTalkHeaderStrings & ProgressStrings & PlacementStrings & SentencesStrings & CollectedPhrasesStrings
  & MenuTitleStrings & SessionStrings
  & WarmupStrings & Ftt432Strings & ReflectionStrings & ChunkListStrings & PlaybackStrings
  & ShadowingStrings & LibraryStrings & RoleplayStrings & FreeTalkScreenStrings & ListeningScreenStrings
  & LevelChipStrings & FeedbackRowStrings & FeedbackScreenStrings & LlmPanelStrings & SettingsStrings
  & AboutStrings & LlmNoticeStrings & SetupStrings & PracticeReadinessStrings & BannerStrings & ErrorStrings;

const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

export const STR: Record<Lang, Strings> = {
  en: {
    nav: {
      home: "Home", placement: "Level Check", free: "Free Talk", library: "Model Talks", sentences: "390 Sentences", listening: "Listening", progress: "Progress", feedback: "Practice reactions", settings: "Settings",
      sectionToday: "Today's practice", sectionSelf: "Self-study", sectionRecords: "Records, level & settings", navigationLabel: "Main navigation",
      selfStudyHint: "Your main path is Today's practice. Self-study fits spare moments — a good order: listen (Listening) → memorize (Sentences) → speak (Free talk).",
    },
    appShell: { backToHome: "← Back to home", textSize: "Text size", language: "Language" },
    routes: {
      unknown: "That address isn't available, so you're back on Home.",
      sessionNotRestored: "An in-progress practice can't be restored after a reload. You're back on Home.",
      leaveSession: "Leave the current practice and open the selected screen?",
      stay: "Keep practicing",
      leave: "Leave practice",
    },
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
      retry: "Try again",
      ttsKeyMissing: "OPENAI_API_KEY isn't set, so text-to-speech falls back to macOS's say command.",
    },
    errors: {
      action: {
        load: "Couldn't load this information.",
        save: "Couldn't save your changes.",
        apply: "Couldn't apply the changes to the running app.",
        submit: "Couldn't send this.",
        record: "Couldn't complete recording.",
        play: "Couldn't play the audio.",
        request: "Couldn't complete that request.",
      },
      category: {
        VALIDATION: "Check the information and try again.",
        OFFLINE: "Check the connection, then try again.",
        TIMEOUT: "The request took too long. Try again.",
        AUTHORIZATION: "Check the connection settings, then try again.",
        NOT_FOUND: "This item is no longer available. Go back and try another item.",
        SERVER: "The local service had a problem. Try again shortly.",
        UNKNOWN: "Try again. If it continues, use the reference below when asking for help.",
      },
      reference: (id) => `Reference: ${id}`,
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
      resumeBannerBody: "Speech-to-text is not set up yet. You can return here at any time to download or resume the model.",
      resumeBannerAction: "Set up speech-to-text",
    },
    practiceReadiness: {
      sttNeeded: "This practice needs speech-to-text before recording can start.",
      llmNeeded: "This practice needs an LLM before recording can start, so the conversation or level check can finish.",
      sttAndLlmNeeded: "This practice needs speech-to-text and an LLM before recording can start.",
      openSetup: "Set up speech-to-text",
      openSettings: "Open LLM settings",
    },
    levelChip: { auto: "Adjusts to your level", band: "Pick by level band", all: "Same for all levels" },
    uiScale: { small: "A−", medium: "A", large: "A＋", xlarge: "A＋＋" },
    support: {
      title: "Support",
      jaHint: "Japanese hints", modelTalk: "Model talk preloading", cloze: "Start with gaps",
      optAuto: "Auto", optOn: "On", optOff: "Off",
      helpJaHint: "Whether a Show Japanese hints control is available for practice phrases. Auto: available at lower levels and hidden as you level up. The hints stay hidden until you press the control.",
      helpModelTalk: "Whether a model talk is prepared in advance during 4/3/2 preparation. Auto: follows your level. Its audio and script stay hidden until you press the model talk button.",
      helpCloze: "Whether sentence practice starts with gaps. Auto: starts in normal view.",
      helpAriaSuffix: (label) => `About ${label}`,
    },
    llm: {
      baseUrlLabel: "Base URL", baseUrlPlaceholder: "http://localhost:11434/v1",
      modelLabel: "Model", modelPlaceholder: "llama3.1",
      codexModelLabel: "Model (optional)", codexModelPlaceholder: "blank = Codex default",
      codexModelPlaceholderWith: (name) => `blank = default (${name})`,
      save: "Save", saving: "Saving…",
      applied: "Applied to the running app.",
      notApplied: (msg) => `Saved, but not applied: ${msg}`,
      help: "Prompts and transcribed speech are sent to the provider assigned to each role (Claude is the default). API keys saved here stay in macOS Keychain; their values are never displayed or returned.",
    },
    settings: {
      title: "Settings",
      loadLlmFailed: "Couldn't load the model connection settings. Nothing has been changed.",
      loadTtsFailed: "Couldn't load the voice settings. Nothing has been changed.",
      loadSecretsFailed: "Couldn't load API-key status. Key changes are unavailable until it is loaded.",
      retry: "Try again",
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
        conversation: "Recommended: an OpenAI-compatible endpoint on this Mac or your LAN — fastest responses. On cloud, sonnet / low is a good baseline.",
        assist: "Recommended: an OpenAI-compatible endpoint on this Mac or your LAN — simple tasks that need an instant answer. On cloud, haiku is enough (it ignores the effort setting).",
        coaching: "Recommended: Claude / Codex — quality matters most here (corrections stay in your SRS, explanations are cached permanently). sonnet / high is a good baseline.",
        generation: "Recommended: an OpenAI-compatible endpoint on this Mac or your LAN — templated output with modest demands. For higher quality, use sonnet / medium.",
        assessment: "Recommended: Claude / Codex — runs less than monthly and the verdict affects everything. opus / xhigh; Standard delivery is fine since there's no rush.",
      },
      roleQualityNote: "Where model quality matters most: Assessment > Coaching > Content generation. Conversation benefits more from response speed.",
      presetSection: "Presets",
      presetAllLocal: "All via OpenAI-compatible endpoint",
      presetAllLocalDesc: "Every role uses the configured OpenAI-compatible endpoint. Check its location and origin before applying; a remote endpoint sends text off this Mac.",
      presetBalancedDesc: (cloud) => cloud === "claude"
        ? "Conversation and content generation use the configured OpenAI-compatible endpoint; coaching and assessment use Claude, where the quality gap is largest and the usage least frequent."
        : "Conversation and content generation use the configured OpenAI-compatible endpoint; coaching and assessment use Codex, where the quality gap is largest and the usage least frequent.",
      presetHighQuality: "Best quality",
      presetHighQualityDesc: (cloud) => cloud === "claude" ? "Every role uses Claude, the tested baseline." : "Every role uses Codex.",
      presetLocalRequired: "Set up an OpenAI-compatible endpoint in the Model connections tab to enable endpoint-based presets.",
      presetCustom: "Custom",
      presetBalancedOption: "Balanced (Recommended)",
      preferredCloudLabel: "Preferred cloud",
      preferredCloudNote: "Saved on this device as soon as you choose it. It is used for cloud slots only when you choose a preset, then Save assignments.",
      applyRecommendedTuning: "Apply recommended tuning",
      applyRecommendedTuningNote: "Sets the recommended model/effort/delivery for Claude/Codex roles. OpenAI-compatible roles are left as-is. Save assignments to confirm.",
      connectionSection: "Model connections",
      claudeNoSetup: "Claude is a cloud service and the default provider. Assigned prompts and transcribed speech are sent through your Claude subscription.",
      claudeGlobalModelLabel: "Default model (all roles)",
      claudeGlobalModelNote: "Applies to every role assigned to Claude unless a role overrides it in the Model per role tab.",
      localConnTitle: "OpenAI-compatible endpoint",
      endpointLabel: "Processing location",
      endpointLoopback: "This Mac (loopback)",
      endpointLan: "Local network (LAN)",
      endpointRemote: "Remote endpoint",
      endpointInvalid: "Not set or invalid URL",
      endpointCloudManaged: "Cloud destination managed by CLI",
      endpointLoopbackDisclosure: "Requests to this endpoint stay on this Mac.",
      endpointLanDisclosure: "Requests are sent to another device on your local network. API-key credentials are not sent over non-loopback HTTP.",
      endpointRemoteDisclosure: "Prompts and transcribed speech assigned here leave your Mac. Authentication, data handling, and billing depend on the endpoint operator.",
      endpointInvalidDisclosure: "Enter an absolute HTTP(S) URL without user info, a query, or a fragment.",
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
      secretDeleteConfirm: "Delete key?",
      secretSaving: "Saving key…",
      secretDeleting: "Deleting key…",
      secretSaved: "Key saved to Keychain and applied.",
      secretDeleted: "Key removed from Keychain.",
      authApiKeyNote: "API keys are billed pay-as-you-go via api.openai.com / the Anthropic API (separate from your subscription allowance). The key itself is never stored in the UI.",
      roleAssignSection: "Model per role",
      roleAssignDesc: "Choose which model handles each role. The Effective line always shows the processing location and origin.",
      targetClaude: "Claude",
      targetLocal: "OpenAI-compatible",
      targetCodex: "Codex",
      targetLocalDisabled: "Set up an OpenAI-compatible endpoint in the Model connections tab to choose it.",
      tuningDetails: "Advanced",
      tuningModel: "Model",
      tuningEffort: "Effort (thinking depth)",
      tuningTier: "Delivery",
      tuningDefaultWith: (v) => `Default (${v})`,
      tuningSdkStandard: "SDK standard",
      tuningTierFast: "Fast (priority delivery)",
      tuningTierStandard: "Standard (cheaper)",
      effectiveLabel: "Effective:",
      effectiveUnconfirmedWith: (label) => `${label} (unconfirmed)`,
      cliDefaultLabel: "CLI default",
      cliDefaultBadgeWith: (label) => `${label} (CLI default)`,
      refreshCatalog: "Refresh model list",
      refreshingCatalog: "Refreshing…",
      catalogNote: "Fetches the real model list from Claude / Codex / the configured OpenAI-compatible endpoint to power the pickers below and the “Effective” line. If a source can't be reached, it degrades to “unconfirmed” rather than guessing.",
      saveConnection: "Save connections",
      saveAssignments: "Save assignments",
      unsavedChanges: "Unsaved changes",
      connectionSaveNote: "Saves connections, the default Claude model, authentication modes, and connection values used by already saved local or Codex roles. It does not save unsaved role choices or tuning.",
      rolesSaveNote: "Saves role choices and tuning. Connection edits in the other tab are not saved here.",
      presetSaveNote: "Choosing a preset stages its role assignments. Save assignments to apply them.",
      saveConnectionFirst: "Save the connection changes first so role assignments use the saved endpoint and model.",
      authModeSaveRequired: "Authentication mode changes take effect only after Save connections.",
      localRoleConnectionRequired: "Some saved roles use the OpenAI-compatible endpoint. Assign those roles to a cloud provider before clearing the endpoint and model.",
      ttsSaveNote: "Voice changes are staged here and take effect after Save.",
      ttsResetStaged: "Defaults are staged in the fields. Choose Save to apply them.",
      displayImmediateNote: "Text size and language apply immediately on this device.",
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
      ttsVoicePresetNote: "Presets fill a matching voice for the current Base URL (OpenAI / Kokoro). For a custom voice, select Custom to focus the field below and type its name.",
      ttsReset: "Reset to default",
      ttsResetDescWith: (model, voice) => `Clear the overrides and return to the defaults (engine: Auto, OpenAI ${model} / ${voice} when a key is set, otherwise macOS say).`,
      ttsApiKeyOptionalNote: "A key is only needed for endpoints that require one (e.g. OpenAI); local servers work without it.",
    },
    stat: { title: "Days with practice", thisWeekUnit: "days practiced this week", total: (n) => `${n} practiced days total` },
    hero: {
      title: "Ready to practice your English?",
      date: (d) => `${WEEKDAYS_EN[d.getDay()]}, ${MONTHS_EN[d.getMonth()]} ${d.getDate()}`,
      bedtime: "A little review before bed helps it stick.",
    },
    quick: {
      label: "Quick drills (5–10 min)", note: "Choose any one that fits today",
      oneEnough: "One practice is enough for today. You can stop whenever it feels right.",
      suggestionLabel: "Not sure where to start? Try this (optional)",
      suggestionReason: "A short way to get your voice moving with today's phrases.",
    },
    intensive: { label: "Intensive sessions", note: "Choose one when you have more time" },
    drills: {
      warmup: { title: "Read-Aloud Warm-up", minutes: "6 min", desc: "Read today's phrases out loud", requires: "No microphone" },
      "ftt-mini": { title: "Repeat Talk (4/3/2)", minutes: "8 min", desc: "Tell the same story twice, faster each time", requires: "Microphone + AI" },
      shadowing: { title: "Shadowing", minutes: "5 min", desc: "Listen and repeat in real time", requires: "No microphone" },
      "roleplay-daily": { title: "Daily Role-play", minutes: "10 min", desc: "Restaurants, travel, small talk", requires: "Microphone + AI" },
      "roleplay-business": { title: "Business Role-play", minutes: "10 min", desc: "Meetings, scheduling, workplace talk", requires: "Microphone + AI" },
      "roleplay-it": { title: "IT Role-play", minutes: "10 min", desc: "Tech discussions, incidents, vendors", requires: "Microphone + AI" },
    },
    fullSession: { title: "Full Session", minutes: "60 min", desc: "Five blocks of solid practice", requires: "Microphone + AI" },
    shortSession: { title: "Short Session", minutes: "30 min", desc: "Focused training when you have time", requires: "Microphone + AI" },
    calendar: {
      title: "Days with practice", legendLess: "Less", legendMore: "More",
      loading: "Loading practice days…", loadError: "Couldn't load practice days.", retry: "Retry",
      dayLabel: (date, xp) => xp > 0 ? `${date} · ${xp} XP` : date,
      summary: (count) => count === 1 ? "Practice recorded on 1 day." : `Practice recorded on ${count} days.`,
    },
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
      speakingTime: "Speaking time (last 14 days)", speakingMinUnit: "min", speakingDay: (date, minutes) => `${date}: ${minutes} minutes of speaking`,
      articulation: "Articulation rate", articulationUnit: "wpm", articulationDay: (date, wpm) => `${date}: ${wpm} words per minute`,
      pauseCard: "Pause ratio", repetitionCard: "Self-repetition", weekOverWeek: "vs last week",
      levelHistory: "Level history", currentLevel: (n) => `Now Lv ${n}`,
      empty: "Start speaking and your metrics will show up here.",
      loading: "Loading…", retry: "Retry",
      monthlyReview: "Monthly review",
      mrGenerate: "Write this month's review",
      mrGenerating: "Writing your review…",
      mrEmpty: "Once a month, a short written review of your speaking practice appears here.",
      mrError: "Couldn't generate the review. Please try again.",
      mrLoading: "Loading the latest review…",
      mrLoadError: "Couldn't load the latest review.",
      mrHistoryLoading: "Loading review history…",
      mrHistoryLoadError: "Couldn't load review history.",
      mrPast: "Review history",
      mrDate: (date) => `Generated on ${date}`,
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
      loading: "Loading level check…", loadRetry: "Retry",
      exitNote: "Leaving this check discards the recordings and transcripts from this attempt.",
      taskLabel: (i, total) => `Task ${i} of ${total}`,
      promptLabel: "Your prompt",
      recordStart: "🎙 Start speaking", recordReplace: "Record again (replaces your previous answer)", recordStarting: "Requesting microphone…",
      recordStop: "⏹ Stop recording", transcribing: "📝 Transcribing…",
      yourAnswer: "Your answer", redo: "Record again", next: "Next task →", submit: "Get my result →",
      submitting: "Scoring your three tasks…",
      submitError: "Scoring didn't come back cleanly. Your recordings are kept — just submit again.",
      retry: "Submit again",
      resultTitle: "Your result",
      resultStage: (stage) => `Estimated stage: ${stage} of 6`,
      stageLevelNote: (stage, level) => `Stage ${stage} is a difficulty band (1–6). Lv ${level} is the recommended starting point within that band.`,
      resultStartAt: (level) => `Start at Lv ${level}`,
      chooseOwn: "Choose my own level", notNow: "Not this time", cancel: "Cancel",
      chooseLabel: "Level (1–999)",
      chooseInputHelp: "Enter a whole number from 1 to 999. This changes the starting Lv, not the Stage estimate.",
      chooseInputError: (reason) => {
        if (reason === "required") return "Enter a starting level.";
        if (reason === "whole-number") return "Use a whole number, without decimals or text.";
        return "Choose a level from 1 to 999.";
      },
      apply: "Apply",
      applyTiming: "The selected Lv takes effect right away for your next practice.",
      levelApplied: (level) => `Lv ${level} is set. Your next practice will use it.`,
      confirmError: "Couldn't apply. Please try again.",
      xpNote: "+10 XP for completing the check",
      showPromptJa: "💡 Show Japanese", translating: "Translating…",
      translateError: "Couldn't load the translation.",
      retryTranslate: "Retry",
      micError: (detail) => `Can't access the microphone: ${detail}`,
      notHeard: "Couldn't catch that. Please record again.",
    },
    sentences: {
      heroTitle: "390 Sentences",
      heroDesc: "Read the Japanese, say it out loud first — recalling is what builds memory",
      tabPractice: "Today's practice", tabBrowse: "Browse",
      hideNoteLabel: "Hide hints",
      audioFirstLabel: "Start from audio",
      newPerDayLabel: "New/day",
      hideNoteTiming: "Applies to this card immediately.",
      audioFirstTiming: "Applies from the next card.",
      newPerDayTiming: "Rebuilds the practice queue. Finish this card before applying it.",
      newPerDayApply: "Reload practice with this number",
      loading: "Loading…", retry: "Retry",
      remaining: (left, graded) => `${left} left (${graded} graded)`,
      sayItFirst: "↑ Say it in English out loud first",
      listenPrompt: "🔊 Listen only — say what it means or repeat it",
      showCloze: "Show gaps", showAnswer: "Show answer",
      clozeHint: "Fill the gaps out loud, then check the answer",
      playAgain: "▶ Play again",
      audioPlaybackError: "Couldn't play the audio. You can still show the answer and continue.",
      explainMore: "💡 Explain more",
      explainLoading: "Writing a deeper explanation…",
      explainError: "Couldn't load the explanation. Try again on the next card.",
      gradeGood: "✅ Got it", gradeSoso: "😕 Shaky", gradeBad: "❌ Didn't come out",
      doneTitle: (n) => `Done for today (${n} sentences)`,
      dueTomorrow: (n) => `Due tomorrow: ${n} items. `,
      doneBody: "Recalling out loud is the shortest path to retention. See you tomorrow.",
      setDone: (remaining) => `Set complete ✅ — ${remaining} more to go`,
      setContinue: "Continue",
      setNote: "Do the rest now or later — either is fine.",
      filterAll: "All",
      domain: { daily: "Daily", business: "Business", it: "IT" },
      searchLabel: "Find a phrase",
      searchPlaceholder: "English, Japanese, number, or category",
      categoryLabel: "Category", categoryAll: "All categories",
      studyLabel: "Learning status", studyAll: "All statuses", studyNew: "Not studied yet", studyScheduled: "Has review history",
      previousPage: "Previous", nextPage: "Next", pageOf: (page, total, count) => `${count} results · page ${page} of ${total}`,
      noResults: "No phrases match these filters.",
      noChunks: "Phrases corrected in 4/3/2 and its reflection will appear here automatically.",
      srsNew: "New",
      srsScheduled: (stage, due) => `Review step ${stage} · next review ${due}`,
      playAria: (no) => `Play No.${no}`,
      chunkLabel: "Your phrase",
      chunkSayIt: "↑ Say a more natural version out loud",
      myChunks: "My phrases — collected from your sessions",
      hiddenChunks: "Hidden phrases",
      showHiddenChunks: (n) => `Show hidden phrases (${n})`,
      hideHiddenChunks: "Hide hidden phrases",
      hideChunk: "Hide",
      hideChunkAria: (id) => `Hide phrase ${id}`,
      restoreChunk: "Restore",
      restoreChunkAria: (id) => `Restore phrase ${id}`,
      chunkLoadError: "Some phrases couldn't be loaded.",
      playChunkAria: (id) => `Play phrase ${id}`,
    },
    collectedPhrases: {
      savedTitle: (count) => count === 1 ? "Saved 1 new phrase" : `Saved ${count} new phrases`,
      savedBody: "These phrases are ready in My phrases for you to revisit whenever you want.",
      open: "Open My phrases",
      none: "No new phrases were added this time.",
      failed: "The feedback is ready, but its phrases couldn't be saved. You can continue practicing.",
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
      preparingBlock: "Preparing this block. Its timer starts when the practice material is ready.",
      completeAfterAttempt: "Finish this block after a completed practice attempt.",
      leaveBeforeComplete: "Leaving before completing this block marks it as interrupted and adds no XP.",
      doneSummary: "Completed blocks are recorded. Interrupted blocks do not add XP.",
      blockEstimate: (time) => `Block estimate: ${time}. It starts when the practice material is ready.`,
      xpSaveFailed: "This block's XP hasn't been recorded yet. You can retry while continuing.",
      xpRetry: "Retry XP", xpRetrying: "Retrying…",
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
      confirmReading: "I've read these aloud", readingConfirmed: "Read aloud",
      outlineTitle: "Today's story outline",
      showJaHints: "Show Japanese hints",
      hideJaHints: "Hide Japanese hints",
    },
    ftt432: {
      prepTitle: (topic) => `Prep — ${topic}`,
      prepIntro: (rounds, count, prep) => `You'll tell the same story ${count} times: ${rounds}. First, look over some phrases and an outline (about ${prep}).`,
      prepMicNote: "Press 🎙 to start speaking — the timer starts then. Your Round 1 recording gets coach notes before Round 2.",
      roundTimeboxNote: "Speaking time limit — it starts when you begin recording. If you finish sooner, that's great.",
      roundChunksToggle: "Prep phrases",
      prepTimerLabel: "Preparation time (starts when phrases are ready)",
      prepTimerAria: (time) => `Preparation time: ${time}. It starts when the practice material is ready.`,
      prepTimerNote: "Time to get started", loading: "Your coach is preparing phrases…", retry: "Retry",
      outlineTitle: "Story outline",
      showJaHints: "Show Japanese hints", hideJaHints: "Hide Japanese hints",
      modelIdle: "🎧 Hear a model talk (optional)", modelScript: "✍ Preparing the model talk script…",
      modelAudio: "🎙 Generating audio…", modelRetry: "🎧 Model talk (retry)",
      startRound1: (time) => `Start Round 1 (${time}) →`, modelTranscript: "Model talk script",
      aeTitle: "Coach notes (read them, then Round 2)", aeLoading: "Your coach is writing notes…",
      aeNoRecording: "No recording, so there are no coach notes", startRound2: (time) => `Start Round 2 (${time})`,
      doneBody: (count) => `4/3/2 done! You told the same story ${count} times, a little faster each round.`,
      roundHeading: (n, time, topic) => `Round ${n} (${time}) — ${topic}`,
      roundTimerAria: (n, time) => `Round ${n} speaking time remaining: ${time}.`,
      transcriptYou: "You:",
      timeUp: "— Time reached", recStop: "⏹ Stop recording", recStarting: "Requesting microphone…", recTranscribing: "📝 Transcribing…",
      recStart: "🎙 Start speaking", roundFinish: "End this round →",
      micError: (detail) => `Can't access the microphone: ${detail}`,
      notHeard: "Couldn't catch that. Please record again.",
      explainMore: "💡 Explain more", explainLoading: "Writing an explanation…", explainError: "Couldn't load the explanation.",
    },
    reflection: {
      loading: "Your coach is reviewing this practice session…", retry: "Retry",
      goodPhrases: "👏 What went well", fixes: "✏️ Worth polishing", tomorrow: "📝 For tomorrow",
      confirmReview: "I've reviewed this", reviewed: "Reviewed",
      explainMore: "💡 Explain more", explainLoading: "Writing an explanation…", explainError: "Couldn't load the explanation.",
    },
    chunkList: { playAria: (en) => `Play "${en}"` },
    playback: { stop: "⏹ Stop", playing: "Playing…" },
    shadowing: {
      intro: "First, without looking at the script, repeat the audio slightly behind it, layering your voice over it (shadowing). Even one listen is fine. Stuck? Tap 'Show script' to check.",
      writingScript: "✍ Preparing the model talk script…", generatingAudio: "🎙 Generating audio…", retry: "Retry",
      play: "▶ Play (as many times as you like)", showScript: "📄 Show script",
      playbackError: "Couldn't play the audio. Try playback again.", playbackRetry: "Try playback again",
      explainMore: "💡 Translation & notes", explainLoading: "Writing the translation and notes…",
      explainError: "Couldn't load the explanation. Please try again.",
    },
    library: {
      title: "Model Talks", loading: "Loading…", retry: "Retry",
      empty: "Nothing yet. Model talks you generate in 4/3/2 prep or Shadowing will be saved here.",
      playAria: (title) => `Play "${title}"`, transcript: "Model talk script",
      explainMore: "💡 Translation & notes", explainLoading: "Writing the translation and notes…",
      explainError: "Couldn't load the explanation. Please try again.",
    },
    roleplay: { starters: "You could open with:" },
    freeTalkScreen: {
      idle: "🎙 Start recording", starting: "Requesting microphone…", recording: "⏹ Stop and send",
      transcribing: "📝 Transcribing…", thinking: "🤔 Thinking…", speaking: "🔊 Playing…", errorLabel: "🎙 Speak again",
      discardRecording: "Discard this recording", stopAndSendHint: "Stopping sends this recording to the conversation.",
      finishPractice: "Finish this practice", continuePractice: "Continue talking",
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
      play: "▶ Play",
      logSaving: "Listening complete. Saving your listen…",
      logFailed: "Listening is complete, but we couldn't save the listen. Your practice is unaffected.",
      logRetry: "Retry saving",
      showScript: "📄 Show script", scriptLoading: "Loading the script…",
      explainMore: "💡 Translation & notes", explainLoading: "Writing the translation and notes…",
      explainError: "Couldn't load the explanation. Please try again.",
    },
    feedbackRow: {
      prompt: "How did it feel? (optional)",
      purpose: "Optional. It is saved in Practice reactions so you can look back on what to try next.",
      notePlaceholder: "One-line note (optional)",
      target: { session: "This practice session", "free-talk": "This free-talk practice", listening: "This listening practice", default: "This practice" },
      hard: "Too hard", justRight: "Just right", easy: "Too easy",
      thanks: "Thanks — noted.",
      retryHint: "Couldn't save. Tap again to retry.",
    },
    feedbackScreen: {
      title: "Practice reactions",
      desc: "Optional reactions shared after a completed practice. Use them to look back on what you want to try next.",
      loading: "Loading…", retry: "Retry",
      empty: "No practice reactions yet. They appear here after you finish a practice and choose to save one.",
      copy: "Copy as Markdown", copying: "Copying…", copied: "Copied.", copyFailed: "Couldn't copy. Check clipboard permission and try again.",
      rating: { hard: "Too hard", "just-right": "Just right", easy: "Too easy" },
      block: { session: "Session", "free-talk": "Free talk", listening: "Listening" },
      at: (ymd) => ymd,
      levelStage: (level, stage) =>
        [level !== null ? `Lv${level}` : null, stage !== null ? `Stage${stage}` : null].filter(Boolean).join(" · ") || "—",
    },
    about: {
      title: "About",
      desc: "Recordings, transcripts, and practice history stay on your Mac. Text is sent to the LLM and speech providers you select; a fully local setup is optional.",
      lpButton: "Website & privacy details",
      githubButton: "View on GitHub",
      license: "Open source under the MIT License.",
    },
  },
  ja: {
    nav: {
      home: "ホーム", placement: "レベル測定", free: "自由会話", library: "モデルトーク", sentences: "暗記例文390", listening: "リスニング（多聴）", progress: "進捗", feedback: "練習の感想", settings: "設定",
      sectionToday: "今日の練習", sectionSelf: "自主練", sectionRecords: "記録・測定・設定", navigationLabel: "メインナビゲーション",
      selfStudyHint: "メインは「今日の練習」。自主練はすきま時間に。目安の順番: リスニング → 暗記例文 → 自由会話。",
    },
    appShell: { backToHome: "← ホームに戻る", textSize: "文字サイズ", language: "言語" },
    routes: {
      unknown: "このURLの画面は開けないため、ホームに戻りました。",
      sessionNotRestored: "進行中の練習は再読込後に復元できないため、ホームに戻りました。",
      leaveSession: "現在の練習を離れて、選んだ画面を開きますか？",
      stay: "練習を続ける",
      leave: "練習を離れる",
    },
    llmNotice: {
      body: "Claude/Codex/ローカルLLMが未導入の場合、会話・添削・解説は使えません。例文・リスニング・シャドーイング・録音の文字起こしはそのまま使えます。",
      linkLabel: "セットアップ手順",
      dismissAriaLabel: "閉じる",
    },
    banners: {
      depsMissingDev: (list) => `不足している依存: ${list} — \`scripts/setup.sh\` を実行してください`,
      depsMissingDesktop: "アプリの同梱ファイルが見つかりません（whisper）。アプリを再インストールしてください。",
      serverDownDev: "APIサーバに接続できません — `cd app && bun run dev` で起動してください",
      serverDownDesktop: "ローカルサーバに接続できません。アプリを再起動してください。",
      retry: "再試行",
      ttsKeyMissing: "OPENAI_API_KEY 未設定のため TTS は say フォールバックです",
    },
    errors: {
      action: {
        load: "情報を読み込めませんでした。",
        save: "変更を保存できませんでした。",
        apply: "実行中のアプリへ変更を適用できませんでした。",
        submit: "送信を完了できませんでした。",
        record: "録音を完了できませんでした。",
        play: "音声を再生できませんでした。",
        request: "処理を完了できませんでした。",
      },
      category: {
        VALIDATION: "入力内容を確認して、もう一度お試しください。",
        OFFLINE: "接続を確認して、もう一度お試しください。",
        TIMEOUT: "処理に時間がかかりすぎました。もう一度お試しください。",
        AUTHORIZATION: "接続設定を確認して、もう一度お試しください。",
        NOT_FOUND: "この項目は利用できなくなりました。戻って別の項目をお試しください。",
        SERVER: "ローカルサービスで問題が発生しました。少し待ってからお試しください。",
        UNKNOWN: "もう一度お試しください。続く場合は、問い合わせ時に下の参照番号をお知らせください。",
      },
      reference: (id) => `参照番号: ${id}`,
    },
    setup: {
      intro: "音声のテキスト化にはモデルの初回ダウンロードが必要です。録音の文字起こし以外（例文・リスニング・LLM機能など）はこのまま使えます。",
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
      resumeBannerBody: "音声のテキスト化はまだ準備されていません。ここからいつでもモデルのダウンロード・再開に戻れます。",
      resumeBannerAction: "音声のテキスト化を準備する",
    },
    practiceReadiness: {
      sttNeeded: "この練習は、録音を始める前に音声のテキスト化を準備する必要があります。",
      llmNeeded: "この練習は、会話またはレベル測定を最後まで行うために、録音を始める前にLLMの準備が必要です。",
      sttAndLlmNeeded: "この練習は、録音を始める前に音声のテキスト化とLLMの準備が必要です。",
      openSetup: "音声のテキスト化を準備する",
      openSettings: "LLM設定を開く",
    },
    levelChip: { auto: "Lvに自動調整", band: "Lv帯で選ぶ", all: "全レベル共通" },
    uiScale: { small: "小", medium: "中", large: "大", xlarge: "特大" },
    support: {
      title: "サポート",
      jaHint: "日本語ヒント", modelTalk: "モデルトークの事前準備", cloze: "歯抜けで開始",
      optAuto: "自動", optOn: "オン", optOff: "オフ",
      helpJaHint: "練習フレーズの「日本語ヒントを表示」ボタンを利用できるかどうか。自動=低いレベルでは利用でき、上がると隠れます。ヒント本文はボタンを押すまで表示しません。",
      helpModelTalk: "4/3/2 の準備中にモデルトークを事前準備するかどうか。自動=レベルに応じた既定です。音声とスクリプトは、設定にかかわらずモデルトークのボタンを押すまで表示・再生しません。",
      helpCloze: "例文練習を歯抜け表示から始めるかどうか。自動=通常表示から始まります。",
      helpAriaSuffix: (label) => `${label}の説明`,
    },
    llm: {
      baseUrlLabel: "ベース URL", baseUrlPlaceholder: "http://localhost:11434/v1",
      modelLabel: "モデル", modelPlaceholder: "llama3.1",
      codexModelLabel: "モデル（任意）", codexModelPlaceholder: "空欄で Codex 既定",
      codexModelPlaceholderWith: (name) => `空欄で既定（${name}）`,
      save: "保存", saving: "保存中…",
      applied: "実行中のアプリに適用しました。",
      notApplied: (msg) => `保存しましたが適用できませんでした: ${msg}`,
      help: "プロンプトと文字起こしは用途ごとに割り当てたproviderへ送信されます（既定はClaude）。ここで保存したAPIキーはmacOS Keychainに保管し、値は表示・再取得しません。",
    },
    settings: {
      title: "設定",
      loadLlmFailed: "モデル接続設定を取得できませんでした。設定は変更していません。",
      loadTtsFailed: "音声設定を取得できませんでした。設定は変更していません。",
      loadSecretsFailed: "APIキーの設定状態を取得できませんでした。取得できるまでキーの変更はできません。",
      retry: "再試行",
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
        conversation: "推奨: このMacまたはLAN上のOpenAI互換接続先 — 応答が最も速いため。クラウドなら sonnet / low が目安。",
        assist: "推奨: このMacまたはLAN上のOpenAI互換接続先 — 単純で即答が欲しいタスク。クラウドなら haiku で十分（effort指定は無視されます）。",
        coaching: "推奨: Claude / Codex — 品質勝負（SRSに残る添削・恒久キャッシュされる解説）。sonnet / high が目安。",
        generation: "推奨: このMacまたはLAN上のOpenAI互換接続先 — 定型的で要求低め。品質を上げるなら sonnet / medium。",
        assessment: "推奨: Claude / Codex — 月1未満で判断が全体に波及。opus / xhigh・急がないので Standard 配信で十分。",
      },
      roleQualityNote: "モデル性能が効く順: 測定 > コーチング > 教材生成。会話は性能より応答の速さが効きます。",
      presetSection: "プリセット",
      presetAllLocal: "すべてOpenAI互換接続先",
      presetAllLocalDesc: "すべての用途を設定済みのOpenAI互換接続先で動かします。適用前に場所とoriginを確認してください。remote接続先ではテキストがMacの外へ送信されます。",
      presetBalancedDesc: (cloud) => cloud === "claude"
        ? "会話・教材生成は設定済みのOpenAI互換接続先、コーチング・測定は品質差が最も大きく実行頻度も低いため Claude を使います。"
        : "会話・教材生成は設定済みのOpenAI互換接続先、コーチング・測定は品質差が最も大きく実行頻度も低いため Codex を使います。",
      presetHighQuality: "最高品質",
      presetHighQualityDesc: (cloud) => cloud === "claude" ? "すべての用途を Claude（動作確認済みの基準）で動かします。" : "すべての用途を Codex で動かします。",
      presetLocalRequired: "「モデル接続設定」タブでOpenAI互換接続先を設定すると、接続先を使うプリセットが選べます。",
      presetCustom: "カスタム",
      presetBalancedOption: "バランス（推奨）",
      preferredCloudLabel: "優先クラウド",
      preferredCloudNote: "選ぶとこの端末にすぐ保存されます。プリセットを選んでから「割当を保存」したときに、クラウド枠へ使われます。",
      applyRecommendedTuning: "推奨チューニングを適用",
      applyRecommendedTuningNote: "Claude/Codex割当の用途に推奨のモデル/effort/配信を設定します（OpenAI互換割当は変更しません）。「割当を保存」で確定します。",
      connectionSection: "モデル接続設定",
      claudeNoSetup: "Claudeはクラウドサービスで、既定providerです。割り当てた用途のプロンプトと文字起こしをClaudeサブスクリプション経由で送信します。",
      claudeGlobalModelLabel: "既定モデル（全用途共通）",
      claudeGlobalModelNote: "Claude に割り当てた全ての用途に適用されます（用途ごとのモデルタブで用途別に上書き可能）。",
      localConnTitle: "OpenAI互換接続先",
      endpointLabel: "処理場所",
      endpointLoopback: "このMac（loopback）",
      endpointLan: "ローカルネットワーク（LAN）",
      endpointRemote: "remote接続先",
      endpointInvalid: "未設定または無効なURL",
      endpointCloudManaged: "CLIが管理するクラウド送信先",
      endpointLoopbackDisclosure: "この接続先へのリクエストは、このMac内で完結します。",
      endpointLanDisclosure: "リクエストはLAN上の別端末へ送信されます。loopback以外のHTTP接続にはAPIキーを送信しません。",
      endpointRemoteDisclosure: "ここへ割り当てた用途のプロンプトと文字起こしはMacの外へ送信されます。認証・データ取扱い・課金は接続先の運営者に従います。",
      endpointInvalidDisclosure: "userinfo・query・fragmentを含まない絶対HTTP(S) URLを入力してください。",
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
      secretDeleteConfirm: "キーを削除する?",
      secretSaving: "キーを保存中…",
      secretDeleting: "キーを削除中…",
      secretSaved: "キーを Keychain に保存し、適用しました。",
      secretDeleted: "キーを Keychain から削除しました。",
      authApiKeyNote: "APIキーは api.openai.com / Anthropic API の従量課金です（サブスクの利用枠とは別）。キーは UI には保存されません。",
      roleAssignSection: "用途ごとのモデル",
      roleAssignDesc: "各用途をどのモデルに任せるか選びます。「実効」行には処理場所とoriginを常時表示します。",
      targetClaude: "Claude",
      targetLocal: "OpenAI互換",
      targetCodex: "Codex",
      targetLocalDisabled: "「モデル接続設定」タブでOpenAI互換接続先を設定すると選べます。",
      tuningDetails: "詳細設定",
      tuningModel: "モデル",
      tuningEffort: "Effort（思考の深さ）",
      tuningTier: "配信",
      tuningDefaultWith: (v) => `既定（${v}）`,
      tuningSdkStandard: "SDK標準",
      tuningTierFast: "Fast（優先配信）",
      tuningTierStandard: "Standard（標準・安価）",
      effectiveLabel: "実効:",
      effectiveUnconfirmedWith: (label) => `${label}（実体未確認）`,
      cliDefaultLabel: "CLI既定",
      cliDefaultBadgeWith: (label) => `${label}（CLI既定）`,
      refreshCatalog: "モデル一覧を更新",
      refreshingCatalog: "更新中…",
      catalogNote: "Claude/Codex/設定済みのOpenAI互換接続先から実際のモデル一覧を取得し、下の選択肢と「実効」表示に反映します。取得できないソースは推測せず「実体未確認」に留めます。",
      saveConnection: "接続を保存",
      saveAssignments: "割当を保存",
      unsavedChanges: "未保存の変更があります",
      connectionSaveNote: "接続・Claudeの既定モデル・認証モードと、保存済みのローカル/Codex用途が使う接続値を保存します。用途の未保存の割当やチューニングは保存しません。",
      rolesSaveNote: "用途ごとの割当とチューニングを保存します。別タブの接続変更はここでは保存しません。",
      presetSaveNote: "プリセットを選ぶと用途の割当を入力欄に準備します。「割当を保存」で反映します。",
      saveConnectionFirst: "用途の割当で保存済みの接続先・モデルを使うため、先に接続変更を保存してください。",
      authModeSaveRequired: "認証モードの変更は「接続を保存」で反映されます。",
      localRoleConnectionRequired: "保存済みの一部の用途がOpenAI互換接続先を使っています。接続先とモデルを空にする前に、それらの用途をクラウドへ割り当ててください。",
      ttsSaveNote: "音声の変更はこの画面で準備し、「保存」で反映します。",
      ttsResetStaged: "既定値を入力欄に準備しました。「保存」で反映します。",
      displayImmediateNote: "文字サイズと言語は、この端末ですぐに反映されます。",
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
      ttsVoicePresetNote: "現在の Base URL（OpenAI / Kokoro）に合った声を入力欄にセットします。独自の声は「カスタム」を押して下の入力欄に名前を直接入力してください。",
      ttsReset: "既定に戻す",
      ttsResetDescWith: (model, voice) => `上書きを消して、既定（エンジン: 自動・キー設定時は OpenAI ${model} / ${voice}・無ければ macOS say）に戻します。`,
      ttsApiKeyOptionalNote: "キーが必要なのは OpenAI 等の鍵必須エンドポイントのみです（ローカルサーバは不要）。",
    },
    stat: { title: "練習した日", thisWeekUnit: "日（今週の練習）", total: (n) => `練習日 累計${n}日` },
    hero: {
      title: "今日も英語を話しましょう",
      date: (d) => `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS_JA[d.getDay()]}）`,
      bedtime: "寝る前の復習は、記憶の定着に少し有利です。",
    },
    quick: {
      label: "クイックドリル（5〜10分）", note: "今日は気になるものを1つ",
      oneEnough: "今日は1つで十分です。やりたいところで終えてかまいません。",
      suggestionLabel: "迷ったら、これから（任意）",
      suggestionReason: "今日の準備フレーズを声に出す、短いスタートです。",
    },
    intensive: { label: "強化セッション", note: "時間がある日に" },
    drills: {
      warmup: { title: "音読ウォームアップ", minutes: "6分", desc: "今日の準備フレーズを声に出して読む", requires: "録音なし" },
      "ftt-mini": { title: "くり返しトーク（4/3/2）", minutes: "8分", desc: "同じ話を2回、制限時間を短くしながら流暢に", requires: "マイク・AI" },
      shadowing: { title: "シャドーイング", minutes: "5分", desc: "聞こえた英語に重ねて言う", requires: "録音なし" },
      "roleplay-daily": { title: "日常ロールプレイ", minutes: "10分", desc: "レストラン・旅行・雑談の場面練習", requires: "マイク・AI" },
      "roleplay-business": { title: "ビジネスロールプレイ", minutes: "10分", desc: "会議・日程調整・職場の会話", requires: "マイク・AI" },
      "roleplay-it": { title: "ITロールプレイ", minutes: "10分", desc: "技術討議・障害対応・ベンダー対応", requires: "マイク・AI" },
    },
    fullSession: { title: "通しセッション", minutes: "60分", desc: "5ブロックで総合的にしっかり練習", requires: "マイク・AI" },
    shortSession: { title: "短縮セッション", minutes: "30分", desc: "時間がある日の集中トレーニング", requires: "マイク・AI" },
    calendar: {
      title: "練習した日", legendLess: "少", legendMore: "多",
      loading: "練習記録を読み込んでいます…", loadError: "練習記録を読み込めませんでした。", retry: "再試行",
      dayLabel: (date, xp) => xp > 0 ? `${date} ・ ${xp} XP` : date,
      summary: (count) => `練習を記録した日: ${count}日。`,
    },
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
      speakingTime: "話した時間（直近14日）", speakingMinUnit: "分", speakingDay: (date, minutes) => `${date}: ${minutes}分話しました`,
      articulation: "調音速度", articulationUnit: "wpm", articulationDay: (date, wpm) => `${date}: ${wpm} wpm`,
      pauseCard: "ポーズ比率", repetitionCard: "言い直し率", weekOverWeek: "前週比",
      levelHistory: "レベル履歴", currentLevel: (n) => `現在 Lv ${n}`,
      empty: "話すと、ここに記録が貯まりはじめます。",
      loading: "読み込み中…", retry: "再試行",
      monthlyReview: "月次レビュー",
      mrGenerate: "今月のレビューを書いてもらう",
      mrGenerating: "レビューを書いています…",
      mrEmpty: "月に一度、スピーキング練習の振り返りレポートがここに表示されます。",
      mrError: "レビューを生成できませんでした。もう一度お試しください。",
      mrLoading: "最新のレビューを読み込んでいます…",
      mrLoadError: "最新のレビューを読み込めませんでした。",
      mrHistoryLoading: "レビュー履歴を読み込んでいます…",
      mrHistoryLoadError: "レビュー履歴を読み込めませんでした。",
      mrPast: "レビュー履歴",
      mrDate: (date) => `${date}に生成`,
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
      loading: "レベル測定を読み込んでいます…", loadRetry: "再試行",
      exitNote: "ここでホームに戻ると、この測定で録音・文字起こしした内容は保存されません。",
      taskLabel: (i, total) => `タスク ${i} / ${total}`,
      promptLabel: "お題",
      recordStart: "🎙 話し始める", recordReplace: "録り直す（前の回答を置き換え）", recordStarting: "マイクを準備中…",
      recordStop: "⏹ 録音を止める", transcribing: "📝 文字起こし中…",
      yourAnswer: "あなたの回答", redo: "録音し直す", next: "次のタスクへ →", submit: "結果を見る →",
      submitting: "3つのタスクを採点しています…",
      submitError: "採点結果をうまく受け取れませんでした。録音は保持されています — もう一度送信してください。",
      retry: "もう一度送信",
      resultTitle: "測定結果",
      resultStage: (stage) => `推定ステージ: ${stage} / 6`,
      stageLevelNote: (stage, level) => `ステージ${stage}は難易度帯（1〜6）です。Lv${level}は、その帯で始めるおすすめのレベルです。`,
      resultStartAt: (level) => `Lv ${level} から始める`,
      chooseOwn: "自分でレベルを選ぶ", notNow: "今回は反映しない", cancel: "キャンセル",
      chooseLabel: "レベル（1〜999）",
      chooseInputHelp: "1〜999の整数を入力してください。変更するのは開始Lvで、ステージの推定は変わりません。",
      chooseInputError: (reason) => {
        if (reason === "required") return "開始レベルを入力してください。";
        if (reason === "whole-number") return "小数や文字を含めず、整数で入力してください。";
        return "1〜999の範囲で入力してください。";
      },
      apply: "適用",
      applyTiming: "選んだLvは、次の練習からすぐに反映されます。",
      levelApplied: (level) => `Lv${level}を反映しました。次の練習からこのLvを使います。`,
      confirmError: "適用できませんでした。もう一度お試しください",
      xpNote: "測定完了で +10 XP",
      showPromptJa: "💡 日本語で見る", translating: "訳しています…",
      translateError: "訳を取得できませんでした。",
      retryTranslate: "再試行",
      micError: (detail) => `マイクにアクセスできません: ${detail}`,
      notHeard: "音声を聞き取れませんでした。もう一度録音してください。",
    },
    sentences: {
      heroTitle: "暗記例文390",
      heroDesc: "日本語を見て、まず声に出す — 思い出す練習が記憶を作ります",
      tabPractice: "今日の練習", tabBrowse: "一覧",
      hideNoteLabel: "ヒントを隠す",
      audioFirstLabel: "音から始める",
      newPerDayLabel: "1日の新規",
      hideNoteTiming: "このカードにすぐ反映されます。",
      audioFirstTiming: "次のカードから反映されます。",
      newPerDayTiming: "練習キューを作り直します。今のカードを終えてから適用してください。",
      newPerDayApply: "この件数で練習を読み直す",
      loading: "読み込み中…", retry: "再試行",
      remaining: (left, graded) => `残り ${left} 文（うち評価済み ${graded}）`,
      sayItFirst: "↑ を英語で、まず声に出して言ってみる",
      listenPrompt: "🔊 音だけを聞いて、意味を言う・繰り返してみましょう",
      showCloze: "歯抜けを表示", showAnswer: "答えを見る",
      clozeHint: "歯抜け部分を埋めながらもう一度声に出して、答え合わせへ",
      playAgain: "▶ もう一度聞く",
      audioPlaybackError: "音声を再生できませんでした。「答えを見る」で練習を続けられます。",
      explainMore: "💡 もっと詳しく",
      explainLoading: "詳しい解説を書いています…",
      explainError: "解説を取得できませんでした。次のカードで再度お試しください。",
      gradeGood: "✅ 言えた", gradeSoso: "😕 あいまい", gradeBad: "❌ 出てこない",
      doneTitle: (n) => `今日の分は完了です（${n}文）`,
      dueTomorrow: (n) => `明日の復習予定: ${n}件。`,
      doneBody: "思い出して声に出すことが定着の近道です。また明日。",
      setDone: (remaining) => `今日のセット完了 ✅ — 続きが ${remaining} 文あります`,
      setContinue: "続ける",
      setNote: "続きは今でも後でもOKです。",
      filterAll: "すべて",
      domain: { daily: "日常", business: "ビジネス", it: "IT" },
      searchLabel: "表現を探す",
      searchPlaceholder: "英文・日本語・番号・カテゴリで検索",
      categoryLabel: "カテゴリ", categoryAll: "すべてのカテゴリ",
      studyLabel: "学習状態", studyAll: "すべての状態", studyNew: "未学習", studyScheduled: "復習履歴あり",
      previousPage: "前へ", nextPage: "次へ", pageOf: (page, total, count) => `${count}件中 ${page} / ${total} ページ`,
      noResults: "この条件に合う表現はありません。",
      noChunks: "4/3/2 と振り返りで直した表現が、ここへ自動で追加されます。",
      srsNew: "未学習",
      srsScheduled: (stage, due) => `復習の段階${stage} ・ 次回 ${due}`,
      playAria: (no) => `No.${no} を再生`,
      chunkLabel: "あなたのフレーズ",
      chunkSayIt: "↑ より自然な言い方を声に出してみましょう",
      myChunks: "マイフレーズ — セッションから自動収集",
      hiddenChunks: "非表示のマイフレーズ",
      showHiddenChunks: (n) => `非表示のマイフレーズを表示（${n}件）`,
      hideHiddenChunks: "非表示のマイフレーズを閉じる",
      hideChunk: "非表示",
      hideChunkAria: (id) => `フレーズ${id}を非表示にする`,
      restoreChunk: "復元",
      restoreChunkAria: (id) => `フレーズ${id}を復元する`,
      chunkLoadError: "一部のマイフレーズを読み込めませんでした。",
      playChunkAria: (id) => `フレーズ${id}を再生`,
    },
    collectedPhrases: {
      savedTitle: (count) => `新しいマイフレーズを${count}件保存しました`,
      savedBody: "あとで見返せるよう、「マイフレーズ」に追加しました。",
      open: "マイフレーズを見る",
      none: "今回は新しいマイフレーズを追加しませんでした。",
      failed: "フィードバックは表示できますが、マイフレーズを保存できませんでした。練習はそのまま続けられます。",
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
      preparingBlock: "このブロックを準備しています。教材の準備ができるとタイマーが始まります。",
      completeAfterAttempt: "練習を一度実施すると、このブロックを完了できます。",
      leaveBeforeComplete: "完了前に離れると、このブロックは中断として扱われ、XPは増えません。",
      doneSummary: "完了したブロックだけが記録されます。中断したブロックのXPは増えません。",
      blockEstimate: (time) => `ブロックの目安時間: ${time}。教材の準備ができると始まります。`,
      xpSaveFailed: "このブロックのXPはまだ記録されていません。練習を続けたまま再試行できます。",
      xpRetry: "XPを再試行", xpRetrying: "再試行中…",
      noTopic: "トピックがありません", noScenario: "シナリオがありません",
      unknownBlock: (kind) => `未知のブロック: ${kind}`,
      blockAria: (index, total) => `ブロック ${index + 1}/${total}`,
      fallbackNote: "近いレベルの教材を選びました",
    },
    warmup: {
      intro: "声に出して読みましょう（各フレーズ2回ずつ）。🔊でお手本を聞けます。このあとの 4/3/2 で実際に使います。",
      loading: "コーチが準備フレーズを用意しています…", retry: "再試行",
      fallbackTitle: "代わりにこちらを声に出して読みましょう",
      clozeStepButton: "🔡 歯抜けで音読（2周目・任意）",
      clozeStepTitle: "歯抜けで音読（任意）",
      clozeStepBody: "今度は空欄を自分で埋めながら声に出しましょう。答えは上の一覧で確認できます。",
      confirmReading: "声に出して読んだ", readingConfirmed: "音読しました",
      outlineTitle: "今日の話の骨組み",
      showJaHints: "日本語ヒントを表示",
      hideJaHints: "日本語ヒントを隠す",
    },
    ftt432: {
      prepTitle: (topic) => `準備 — ${topic}`,
      prepIntro: (rounds, count, prep) => `これから同じ話を ${rounds} で${count}回話します。まず準備フレーズと話の骨組みを確認してください（目安 ${prep}）。`,
      prepMicNote: "🎙を押して話し始めるとタイマーが動きます。Round 1 の録音には Round 2 の前にコーチからのヒントが付きます。",
      roundTimeboxNote: "発話時間の上限です。録音を始めると動き、早く話し終えてもOKです。",
      roundChunksToggle: "準備フレーズ",
      prepTimerLabel: "準備時間（教材の準備後に開始）",
      prepTimerAria: (time) => `準備時間: ${time}。教材の準備ができると始まります。`,
      prepTimerNote: "そろそろ始めましょう", loading: "コーチが準備フレーズを用意しています…", retry: "再試行",
      outlineTitle: "話の骨組み",
      showJaHints: "日本語ヒントを表示", hideJaHints: "日本語ヒントを隠す",
      modelIdle: "🎧 モデルトークを聞く（任意）", modelScript: "✍ モデルトークのスクリプトを作成中…",
      modelAudio: "🎙 音声を生成中…", modelRetry: "🎧 モデルトーク（再試行）",
      startRound1: (time) => `Round 1 を始める（${time}）→`, modelTranscript: "モデルトークのスクリプト",
      aeTitle: "コーチからのヒント（読んでから Round 2 へ）", aeLoading: "コーチがヒントを書いています…",
      aeNoRecording: "録音がなかったのでコーチからのヒントはありません", startRound2: (time) => `Round 2 を始める（${time}）`,
      doneBody: (count) => `4/3/2 完了！同じ話を${count}回、少しずつ速く話せました。`,
      roundHeading: (n, time, topic) => `Round ${n}（${time}） — ${topic}`,
      roundTimerAria: (n, time) => `Round ${n} の発話残り時間: ${time}。`,
      transcriptYou: "あなた:",
      timeUp: "— 目安の時間になりました", recStop: "⏹ 録音を止める", recStarting: "マイクを準備中…", recTranscribing: "📝 文字起こし中…",
      recStart: "🎙 話し始める", roundFinish: "このラウンドを終える →",
      micError: (detail) => `マイクにアクセスできません: ${detail}`,
      notHeard: "音声を聞き取れませんでした。もう一度録音してください。",
      explainMore: "💡 もっと詳しく", explainLoading: "解説を書いています…", explainError: "解説を取得できませんでした。",
    },
    reflection: {
      loading: "コーチがこの練習を振り返っています…", retry: "再試行",
      goodPhrases: "👏 良かった表現", fixes: "✏️ 直したい表現", tomorrow: "📝 明日へ",
      confirmReview: "振り返りを確認した", reviewed: "確認しました",
      explainMore: "💡 もっと詳しく", explainLoading: "解説を書いています…", explainError: "解説を取得できませんでした。",
    },
    chunkList: { playAria: (en) => `「${en}」を再生` },
    playback: { stop: "⏹ 停止", playing: "再生中…" },
    shadowing: {
      intro: "まずはスクリプトを見ずに、音声に少し遅れてかぶせるように声に出して繰り返します（シャドーイング）。1回聞くだけでもOK。行き詰まったら「スクリプトを表示」で確認できます。",
      writingScript: "✍ コーチがモデルトークのスクリプトを作成中…", generatingAudio: "🎙 音声を生成しています…", retry: "再試行",
      play: "▶ 再生（何度でも）", showScript: "📄 スクリプトを表示",
      playbackError: "音声を再生できませんでした。もう一度再生できます。", playbackRetry: "もう一度再生する",
      explainMore: "💡 日本語訳と解説", explainLoading: "日本語訳と解説を書いています…",
      explainError: "解説を取得できませんでした。もう一度お試しください。",
    },
    library: {
      title: "モデルトーク", loading: "読み込み中…", retry: "再試行",
      empty: "まだありません。4/3/2 の準備やシャドーイングでモデルトークを生成すると、ここに残ります。",
      playAria: (title) => `「${title}」を再生`, transcript: "モデルトークのスクリプト",
      explainMore: "💡 日本語訳と解説", explainLoading: "日本語訳と解説を書いています…",
      explainError: "解説を取得できませんでした。もう一度お試しください。",
    },
    roleplay: { starters: "こう切り出せます:" },
    freeTalkScreen: {
      idle: "🎙 録音を始める", starting: "マイクを準備中…", recording: "⏹ 止めて送信",
      transcribing: "📝 文字起こし中…", thinking: "🤔 考え中…", speaking: "🔊 再生中…", errorLabel: "🎙 もう一度話す",
      discardRecording: "この録音を破棄", stopAndSendHint: "「止めて送信」を押すと、この録音を会話に送信します。",
      finishPractice: "この練習を終える", continuePractice: "会話を続ける",
      micError: (detail) => `マイクにアクセスできません: ${detail}`, notHeard: "音声を聞き取れませんでした。もう一度話してください。",
      hintLabel: "うまく言えないときは、言いたいことを日本語で入力すると英語の言い方を提案します",
      hintPlaceholder: "例: その機能はまだ試していません", hintButton: "💡 言い方のヒント",
      hintThinking: "言い方を考えています…", hintError: "ヒントを取得できませんでした。もう一度お試しください。", retry: "再試行",
      you: "あなた", ai: "AI", translate: "訳", translating: "訳しています…", translateError: "訳を取得できませんでした。",
    },
    listeningScreen: {
      title: "リスニング",
      desc: "レベルに合った短い英語を聞きます。まずはスクリプトを見ずに聞くと、耳が育ちます。",
      loading: "読み込み中…", retry: "再試行",
      empty: "この絞り込みに合うリスニング素材がまだありません。",
      weekCount: (n) => `今週 ${n} 本`,
      filterFit: "自分のレベル", filterAll: "すべて",
      domain: { daily: "日常", business: "ビジネス", it: "IT" },
      open: "聞く", back: "← 一覧に戻る",
      play: "▶ 再生",
      logSaving: "聴取は完了しました。記録を保存しています…",
      logFailed: "聴取は完了しましたが、記録を保存できませんでした。練習内容には影響しません。",
      logRetry: "保存を再試行",
      showScript: "📄 スクリプトを表示", scriptLoading: "スクリプトを読み込み中…",
      explainMore: "💡 日本語訳と解説", explainLoading: "日本語訳と解説を書いています…",
      explainError: "解説を取得できませんでした。もう一度お試しください。",
    },
    feedbackRow: {
      prompt: "この練習はどうでしたか？（任意）",
      purpose: "任意の感想は「練習の感想」に保存され、次に試したいことを振り返れます。",
      notePlaceholder: "ひとことメモ（任意）",
      target: { session: "このセッション", "free-talk": "この自由会話", listening: "このリスニング", default: "この練習" },
      hard: "難しすぎた", justRight: "ちょうどよかった", easy: "簡単すぎた",
      thanks: "ありがとう、記録しました。",
      retryHint: "保存できませんでした。もう一度タップしてください。",
    },
    feedbackScreen: {
      title: "練習の感想",
      desc: "練習を終えたあとに任意で残した感想です。次に試したいことを振り返るために使えます。",
      loading: "読み込み中…", retry: "再試行",
      empty: "まだ練習の感想はありません。練習を終え、任意で感想を残すとここに表示されます。",
      copy: "Markdownでコピー", copying: "コピー中…", copied: "コピーしました。", copyFailed: "コピーできませんでした。クリップボードの許可を確認して、もう一度お試しください。",
      rating: { hard: "難しすぎた", "just-right": "ちょうどよかった", easy: "簡単すぎた" },
      block: { session: "セッション", "free-talk": "自由会話", listening: "リスニング" },
      at: (ymd) => ymd,
      levelStage: (level, stage) =>
        [level !== null ? `Lv${level}` : null, stage !== null ? `Stage${stage}` : null].filter(Boolean).join(" · ") || "—",
    },
    about: {
      title: "このアプリについて",
      desc: "録音・文字起こし・練習履歴はこのMacに保存されます。テキストは選択したLLM・音声プロバイダへ送信され、完全ローカル構成は任意で選べます。",
      lpButton: "紹介・プライバシー説明を開く",
      githubButton: "GitHub リポジトリを開く",
      license: "MIT ライセンスのオープンソースです。",
    },
  },
};
