import { playBlob } from "./audio";

export type Health = {
  ok: boolean; whisper: boolean; ffmpeg: boolean; claude: boolean; ttsKey: boolean; modelFile: boolean;
};

/**
 * 非2xxレスポンスからエラーメッセージを取り出す。サーバ停止時にプロキシ/ブラウザが
 * 返すHTMLなど非JSONボディでも例外を投げず、`HTTP <status>` にフォールバックする。
 */
async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // 非JSONボディ（サーバ停止時のエラーページ等）はフォールバックメッセージを使う
  }
  return `HTTP ${res.status}`;
}

export async function getHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  return res.json();
}

export async function sttUpload(blob: Blob): Promise<string> {
  const res = await fetch("/api/stt", {
    method: "POST",
    headers: { "content-type": blob.type || "audio/webm" },
    body: blob,
  });
  if (!res.ok) throw new Error(`STT failed: ${await extractErrorMessage(res)}`);
  return (await res.json()).text as string;
}

export async function converse(
  userText: string,
  sessionId?: string,
  scenarioId?: string,
): Promise<{ replyText: string; sessionId: string }> {
  const res = await fetch("/api/converse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userText, sessionId, scenarioId }),
  });
  if (!res.ok) throw new Error(`converse failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function ttsFetch(text: string): Promise<Blob> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`TTS failed: ${await extractErrorMessage(res)}`);
  return res.blob();
}

/**
 * sessionId はアプリ起動時に mint するクライアント側セッションUUID（省略可・後方互換）。
 * converse() が返す会話用 sessionId とは別概念で、ライフサイクル/ブロック/ラウンドイベントの突合に使う。
 */
export async function sessionStart(sessionId?: string): Promise<void> {
  await fetch("/api/session/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

export async function sessionEnd(sessionId: string): Promise<void> {
  await fetch("/api/session/end", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

/**
 * タブを閉じる/リロード時にも session_end を届けるための keepalive 送信。
 * pagehide からの呼び出し想定なので await しない（fire-and-forget）。
 */
export function sessionEndKeepalive(sessionId: string): void {
  void fetch("/api/session/end", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
    keepalive: true,
  }).catch(() => {});
}

export type ContentItem = { id: string; kind: "topic" | "scenario"; title: string; titleJa: string; hints: string[]; starters?: string[] };
export type MenuBlock = { id: string; kind: string; title: string; minutes: number; params: { topic?: ContentItem; scenario?: ContentItem; roundsSec?: number[]; modelTalkMode?: "auto" | "button" } };
export type Menu = { minutes: number; date: string; blocks: MenuBlock[] };
export type AeItem = { quote: string; issue: string; better: string; why_ja: string };
export type AeFeedback = { items: AeItem[]; praise: string };
export type Reflection = { goodPhrases: string[]; fixes: Array<{ original: string; better: string }>; noteForTomorrow_ja: string };
export type PrepPack = { chunks: Array<{ en: string; ja: string }>; outline: string[]; hintDefault: "ja" | "en" };

export async function fetchMenu(minutes: 60 | 30): Promise<Menu> {
  const res = await fetch(`/api/menu/today?minutes=${minutes}`);
  if (!res.ok) throw new Error(`menu failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function fetchAeFeedback(transcript: string, topicTitle: string): Promise<AeFeedback> {
  const res = await fetch("/api/feedback/ae", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript, topicTitle }),
  });
  if (!res.ok) throw new Error(`AE feedback failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function fetchModelTalk(topicId: string): Promise<string> {
  const res = await fetch("/api/coach/model-talk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topicId }),
  });
  if (!res.ok) throw new Error(`model talk failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}

export async function fetchReflection(): Promise<Reflection> {
  const res = await fetch("/api/coach/reflection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`reflection failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

/**
 * トピックID→PrepPack のセッション内キャッシュ（進行中Promise共有）。音読ウォームアップと4/3/2準備フェーズが
 * 同じトピックのパックを要求するため、Claude呼び出しをセッションあたり1回に抑える。
 * 失敗時は削除して再試行可能。
 */
const prepPackCache = new Map<string, Promise<PrepPack>>();

export async function fetchPrepPack(topicId: string): Promise<PrepPack> {
  let p = prepPackCache.get(topicId);
  if (!p) {
    p = (async () => {
      const res = await fetch("/api/coach/prep", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topicId }),
      });
      if (!res.ok) throw new Error(`prep failed: ${await extractErrorMessage(res)}`);
      return (await res.json()) as PrepPack;
    })();
    p.catch(() => prepPackCache.delete(topicId));
    prepPackCache.set(topicId, p);
  }
  return p;
}

export function sendSessionEvent(
  type: "block_start" | "block_end" | "round_start" | "round_end",
  sessionId: string | undefined,
  meta?: Record<string, unknown>,
): void {
  // 進行イベントは fire-and-forget（記録失敗でセッションを止めない）
  void fetch("/api/session/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, sessionId, meta }),
  }).catch(() => {});
}

export type QuickDrillKind = "warmup" | "ftt-mini" | "roleplay" | "shadowing";
export type RoleplayDomain = "daily" | "business" | "it";

export async function fetchQuickMenu(kind: QuickDrillKind, domain?: RoleplayDomain): Promise<Menu> {
  const q = domain ? `&domain=${domain}` : "";
  const res = await fetch(`/api/menu/quick?kind=${kind}${q}`);
  if (!res.ok) throw new Error(`quick menu failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function fetchPracticeDays(): Promise<string[]> {
  const res = await fetch("/api/progress/days");
  if (!res.ok) throw new Error(`practice days failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { days: string[] }).days;
}

export type LevelProposal = {
  kind: "up" | "down";
  toLevel: number;
  rationale: { xpReached?: boolean; practicedDays14?: number; completionRate?: number | null; fttAborts?: number };
};
export type ProgressSummary = {
  level: number; xp: number; xpIntoLevel: number; xpToNext: number;
  stage: number; difficultyMaxed: boolean; proposal: LevelProposal | null;
};

export async function fetchProgressSummary(): Promise<ProgressSummary> {
  const res = await fetch("/api/progress/summary");
  if (!res.ok) throw new Error(`progress summary failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

/**
 * summary 更新の軽量Pub/Sub。サイドバーのゲージ等、複数箇所で summary を表示する画面が
 * XP付与・レベル操作の直後に最新値へ追従できるようにする（再取得のポーリングは行わない）。
 */
let progressListeners: Array<(s: ProgressSummary) => void> = [];

/** 購読する。戻り値を呼ぶと購読解除される */
export function onProgressUpdate(fn: (s: ProgressSummary) => void): () => void {
  progressListeners.push(fn);
  return () => {
    progressListeners = progressListeners.filter((f) => f !== fn);
  };
}

export function notifyProgress(s: ProgressSummary): void {
  for (const fn of progressListeners) fn(s);
}

export async function progressBlockStart(kind: string): Promise<number> {
  const res = await fetch("/api/progress/block-start", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }),
  });
  if (!res.ok) throw new Error(`block-start failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { attemptId: number }).attemptId;
}

export async function progressBlockXp(amount: number, attemptId: number | null): Promise<ProgressSummary> {
  const res = await fetch("/api/progress/xp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "block", amount, attemptId: attemptId ?? undefined }),
  });
  if (!res.ok) throw new Error(`xp failed: ${await extractErrorMessage(res)}`);
  const summary = (await res.json()) as ProgressSummary;
  notifyProgress(summary);
  return summary;
}

export async function progressLevelAction(
  action: "accept" | "decline" | "set", level?: number,
): Promise<ProgressSummary> {
  const res = await fetch("/api/progress/level", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, level }),
  });
  if (!res.ok) throw new Error(`level action failed: ${await extractErrorMessage(res)}`);
  const summary = (await res.json()) as ProgressSummary;
  notifyProgress(summary);
  return summary;
}

export type Settings = { anchor: string };

export async function fetchSettings(): Promise<Settings> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(`settings failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function saveSettings(s: Settings): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(s),
  });
  if (!res.ok) throw new Error(`settings save failed: ${await extractErrorMessage(res)}`);
}

export type ModelTalkEntry = { id: number; createdAt: string; topicId: string; topicTitle: string; text: string };

export async function fetchModelTalkLibrary(): Promise<ModelTalkEntry[]> {
  const res = await fetch("/api/library/model-talks");
  if (!res.ok) throw new Error(`library failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { entries: ModelTalkEntry[] }).entries;
}

/**
 * テキスト単位のTTS Blobキャッシュ再生。初回押下時のみ /api/tts を叩き（サーバ側にも
 * テキスト単位のキャッシュがある）、以降はタブ内キャッシュから即再生。
 * in-flight Promise を共有し、失敗時はエントリを消して再試行可能にする（prepPackCache と同じパターン）。
 */
const ttsBlobCache = new Map<string, Promise<Blob>>();

export async function playTtsCached(text: string): Promise<void> {
  let p = ttsBlobCache.get(text);
  if (!p) {
    p = ttsFetch(text);
    p.catch(() => ttsBlobCache.delete(text));
    ttsBlobCache.set(text, p);
  }
  await playBlob(await p);
}

/**
 * モデルトーク（原稿テキスト→TTS Blob）の先読みキャッシュ。準備フェーズ表示時に呼び、
 * 「モデルトークを聞く」押下時には出来上がっている状態を狙う。onStage は初回生成時のみ発火する。
 */
const modelTalkCache = new Map<string, Promise<{ text: string; blob: Blob }>>();

export function prefetchModelTalkAudio(
  topicId: string,
  onStage?: (stage: "script" | "audio") => void,
): Promise<{ text: string; blob: Blob }> {
  let p = modelTalkCache.get(topicId);
  if (!p) {
    p = (async () => {
      onStage?.("script");
      const text = await fetchModelTalk(topicId);
      onStage?.("audio");
      const blob = await ttsFetch(text);
      return { text, blob };
    })();
    p.catch(() => modelTalkCache.delete(topicId));
    modelTalkCache.set(topicId, p);
  }
  return p;
}

export type SentenceSrs = { stage: number; due: string; reviews: number };
export type SentenceItem = {
  no: number; category_no: number; category: string;
  domain: "daily" | "business" | "it";
  en: string; ja: string; note: string;
  srs: SentenceSrs | null;
};

export type ChunkSrs = SentenceSrs;
export type ChunkQueueItem = {
  kind: "chunk";
  id: number;
  promptText: string;
  en: string;
  note: string;
  srs: ChunkSrs;
};
export type SentenceQueueItem = SentenceItem & { kind: "sentence" };
export type QueueItem = SentenceQueueItem | ChunkQueueItem;

export type ChunkListItem = {
  id: number; created: string; source: "ae" | "reflection";
  promptText: string; en: string; note: string; srs: ChunkSrs;
};

export async function fetchChunks(): Promise<ChunkListItem[]> {
  const res = await fetch("/api/chunks");
  if (!res.ok) throw new Error(`chunks failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { chunks: ChunkListItem[] }).chunks;
}

export async function gradeChunk(id: number, grade: "good" | "soso" | "bad"): Promise<{ id: number; stage: number; due: string }> {
  const res = await fetch("/api/chunks/grade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, grade }),
  });
  if (!res.ok) throw new Error(`grade failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function deleteChunk(id: number): Promise<void> {
  const res = await fetch(`/api/chunks/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${await extractErrorMessage(res)}`);
}

export async function fetchSentences(): Promise<SentenceItem[]> {
  const res = await fetch("/api/sentences");
  if (!res.ok) throw new Error(`sentences failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { sentences: SentenceItem[] }).sentences;
}

export async function fetchSentenceQueue(newCount = 10): Promise<QueueItem[]> {
  const res = await fetch(`/api/sentences/queue?new=${newCount}`);
  if (!res.ok) throw new Error(`queue failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { queue: QueueItem[] }).queue;
}

export async function gradeSentence(no: number, grade: "good" | "soso" | "bad"): Promise<{ no: number; stage: number; due: string }> {
  const res = await fetch("/api/sentences/grade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ no, grade }),
  });
  if (!res.ok) throw new Error(`grade failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

/** 例文の詳しい解説（サーバ側でキャッシュされ、2回目以降は即返る） */
export async function fetchSentenceExplanation(no: number): Promise<string> {
  const res = await fetch("/api/sentences/explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ no }),
  });
  if (!res.ok) throw new Error(`explain failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}

/** モデルトークの日本語訳＋表現解説（サーバ側で本文ハッシュキャッシュ・2回目以降は即返る） */
export async function fetchTalkExplanation(text: string): Promise<string> {
  const res = await fetch("/api/coach/talk-explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`talk explain failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}

/** AI発話の日本語訳のみ（サーバ側で本文ハッシュキャッシュ・2回目以降は即返る） */
export async function fetchUtteranceTranslation(text: string): Promise<string> {
  const res = await fetch("/api/coach/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`translate failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}

export type PhraseHint = { en: string; ja: string };

/** 言い方ヒント: 言いたい日本語＋直近履歴 → 使える英語表現2〜3個 */
export async function fetchPhraseHints(
  jaText: string,
  history?: Array<{ role: "you" | "ai"; text: string }>,
): Promise<PhraseHint[]> {
  const res = await fetch("/api/coach/phrase-hint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jaText, history }),
  });
  if (!res.ok) throw new Error(`phrase hint failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { suggestions: PhraseHint[] }).suggestions;
}

/** 訂正（original→better）の詳しい日本語解説（キャッシュなし・ボタン起点のオンデマンド生成） */
export async function fetchFixExplanation(original: string, better: string, note?: string): Promise<string> {
  const res = await fetch("/api/coach/fix-explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ original, better, note }),
  });
  if (!res.ok) throw new Error(`fix explain failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { text: string }).text;
}

export type PlacementTaskDef = {
  id: string; durationSec: number; instructionEn: string; instructionJa: string; promptText: string;
};
export type PlacementResult = { stage: number; startLevel: number; rationale: string };
export type PlacementLatest = { id: number; ts: string; stage: number; startLevel: number; rationale: string } | null;

export async function fetchPlacementTasks(): Promise<PlacementTaskDef[]> {
  const res = await fetch("/api/placement/tasks");
  if (!res.ok) throw new Error(`placement tasks failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { tasks: PlacementTaskDef[] }).tasks;
}

export async function submitPlacement(
  tasks: Array<{ taskId: string; transcript: string; durationSec: number; wordCount: number }>,
): Promise<PlacementResult> {
  const res = await fetch("/api/placement/submit", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tasks }),
  });
  if (!res.ok) throw new Error(`placement submit failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function confirmPlacement(accept: boolean, level?: number): Promise<ProgressSummary> {
  const res = await fetch("/api/placement/confirm", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept, level }),
  });
  if (!res.ok) throw new Error(`placement confirm failed: ${await extractErrorMessage(res)}`);
  const summary = (await res.json()) as ProgressSummary;
  notifyProgress(summary);
  return summary;
}

export async function fetchPlacementLatest(): Promise<PlacementLatest> {
  const res = await fetch("/api/placement/latest");
  if (!res.ok) throw new Error(`placement latest failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { result: PlacementLatest }).result;
}

export type DayMetrics = {
  ymd: string; utterances: number; speakingSec: number;
  avgArticulationWpm: number; avgPauseRatio: number; repetitionRatio: number;
};
export type MetricsSummary = {
  days: DayMetrics[];
  level: { current: number; history: Array<{ ymd: string; level: number }> };
};

/** 進捗ダッシュボード用の日別メトリクス集計 */
export async function fetchMetricsSummary(days = 14): Promise<MetricsSummary> {
  const res = await fetch(`/api/metrics/summary?days=${days}`);
  if (!res.ok) throw new Error(`metrics failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export type MonthlyReport = { id: number; ts: string; ymd: string; text: string };
export type MonthlyReportPreview = MonthlyReport & { preview: string };

export async function fetchLatestMonthlyReport(): Promise<MonthlyReport | null> {
  const res = await fetch("/api/assessment/latest");
  if (!res.ok) throw new Error(`assessment latest failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { report: MonthlyReport | null }).report;
}

export async function fetchMonthlyReportList(): Promise<MonthlyReportPreview[]> {
  const res = await fetch("/api/assessment/list");
  if (!res.ok) throw new Error(`assessment list failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { reports: MonthlyReportPreview[] }).reports;
}

export async function requestMonthlyReport(force = false): Promise<{ report: MonthlyReport; cached: boolean }> {
  const res = await fetch("/api/assessment/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(force ? { force: true } : {}),
  });
  if (!res.ok) throw new Error(`assessment generate failed: ${await extractErrorMessage(res)}`);
  return res.json();
}
