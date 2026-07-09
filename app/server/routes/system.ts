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
import { json, parseJsonBody, exact, bestEffort, type RouteEntry } from "./http";

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
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0) return json({ error: "empty audio body" }, 400);
  const contentType = req.headers.get("content-type");
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
  const parsed = await parseJsonBody<{ text?: string; voice?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!body.text?.trim()) return json({ error: "text is required" }, 400);
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
