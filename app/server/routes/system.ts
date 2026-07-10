import path from "node:path";
import { mkdirSync } from "node:fs";
import { localYmd } from "../dates";
import { RECORDINGS_DIR } from "../paths";
import { appendEvent } from "../session-log";
import { detectAudioContainer, transcribeAudio, UnsupportedAudioContainerError, type Transcription } from "../stt";
import { synthesize } from "../tts";
import type { TtsProvider } from "../tts";
import type { TtsSettings } from "../tts";
import { checkHealth } from "../health";
import { computeUtteranceMetrics, type UtteranceMetrics } from "../metrics";
import { json, parseJsonBody, readRequestBody, exact, bestEffort, type RouteEntry } from "./http";

export const MAX_STT_BODY_BYTES = 24 * 1024 * 1024;
export const MAX_TTS_TEXT_CHARS = 8_000;
const MAX_TTS_VOICE_CHARS = 100;

function isSupportedAudioMediaType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/octet-stream" || [
    "audio/webm", "audio/wav", "audio/x-wav", "audio/wave",
    "audio/mp4", "audio/m4a", "audio/mpeg", "audio/mp3",
  ].includes(mediaType);
}

export type SystemRoutesDeps = {
  health: () => ReturnType<typeof checkHealth>;
  transcribe: typeof transcribeAudio;
  synthesize: typeof synthesize;
  /** TTS の実効設定（DB 由来）。合成のたびに読む。省略時は現行既定（env/OpenAI/say）。 */
  getTtsSettings: () => TtsSettings | null;
  /** TTS プロバイダの明示選択（DB 由来。行不在は "auto"）。 */
  getTtsProvider: () => TtsProvider;
  logFile: () => string;
  /** 省略時は実データディレクトリ（RECORDINGS_DIR）を使う。テストでは temp dir を注入する。 */
  recordingsDir?: string;
};

async function handleStt(req: Request, deps: SystemRoutesDeps): Promise<Response> {
  const contentType = req.headers.get("content-type");
  if (!isSupportedAudioMediaType(contentType)) {
    return json({ error: "Content-Type must be a supported audio type" }, 415);
  }
  const parsed = await readRequestBody(req, { maxBytes: MAX_STT_BODY_BYTES });
  if (!parsed.ok) return parsed.response;
  const bytes = parsed.body;
  if (bytes.length === 0) return json({ error: "empty audio body" }, 400);
  const container = detectAudioContainer(contentType, bytes);
  // 実値ログ（情報提供のみ）: ffmpeg 不在環境での afconvert 経路切り分けや、クライアントの
  // mimeType 交渉が意図どおり動いているかの確認に使う。
  console.log(`[stt] received content-type=${contentType ?? "(none)"} container=${container}`);
  const day = localYmd();
  const dir = path.join(deps.recordingsDir ?? RECORDINGS_DIR, day);
  mkdirSync(dir, { recursive: true });
  const ext = container === "unknown" ? "webm" : container;
  const file = path.join(dir, `${Date.now()}.${ext}`);
  await Bun.write(file, bytes);
  let result: Transcription;
  try {
    result = await deps.transcribe(file, { container });
  } catch (err) {
    if (err instanceof UnsupportedAudioContainerError) return json({ error: err.message }, 400);
    throw err;
  }
  const { text, segments } = result;
  // メトリクスは補助情報 — 計算・記録の失敗で文字起こし自体を失敗させない
  let metrics: UtteranceMetrics | undefined;
  bestEffort("[metrics] compute/record failed, continuing:", () => {
    const m = computeUtteranceMetrics(segments);
    appendEvent(deps.logFile(), {
      ts: new Date().toISOString(), type: "stt_result", sessionId: "stt", text, meta: { metrics: m },
    });
    metrics = m;
  });
  return json(metrics ? { text, metrics } : { text });
}

async function handleTts(req: Request, deps: SystemRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ text?: unknown; voice?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (typeof body.text !== "string" || !body.text.trim()) return json({ error: "text is required" }, 400);
  if (body.text.length > MAX_TTS_TEXT_CHARS) {
    return json({ error: `text must be at most ${MAX_TTS_TEXT_CHARS} characters` }, 400);
  }
  if (body.voice !== undefined && (typeof body.voice !== "string" || body.voice.length > MAX_TTS_VOICE_CHARS)) {
    return json({ error: `voice must be a string of at most ${MAX_TTS_VOICE_CHARS} characters` }, 400);
  }
  const tts = deps.getTtsSettings();
  const { audio, mime, engine } = await deps.synthesize(body.text, {
    // 優先順位（仕様・binding）: リクエスト voice > DB 設定 > 既定（同梱音声のテキスト単位一致に必要）
    voice: body.voice ?? tts?.voice ?? undefined,
    model: tts?.model ?? undefined,
    baseUrl: tts?.baseUrl ?? undefined,
    provider: deps.getTtsProvider(),
  });
  return new Response(audio as unknown as BodyInit, { headers: { "content-type": mime, "x-tts-engine": engine } });
}

export function makeSystemRoutes(deps: SystemRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/health", () => json(deps.health())),
    exact("POST", "/api/stt", (req) => handleStt(req, deps)),
    exact("POST", "/api/tts", (req) => handleTts(req, deps)),
  ];
}
