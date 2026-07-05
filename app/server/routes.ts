import path from "node:path";
import { mkdirSync } from "node:fs";
import { RECORDINGS_DIR } from "./paths";
import { appendEvent, isErrorLogged } from "./session-log";
import { transcribeAudio } from "./stt";
import { synthesize } from "./tts";
import { converseTurn } from "./converse";
import { checkHealth } from "./health";
import type { Menu } from "./menu";
import type { AeFeedback, Reflection } from "./coach";

/**
 * HTTP ハンドラが依存する副作用を注入可能にする境界。
 * 実サーバ（index.ts）は実装を、テスト（__tests__/routes.test.ts）はフェイクを渡す。
 */
export type RouteDeps = {
  transcribe: typeof transcribeAudio;
  synthesize: typeof synthesize;
  converse: typeof converseTurn;
  health: () => ReturnType<typeof checkHealth>;
  logFile: () => string;
  /** 省略時は実データディレクトリ（RECORDINGS_DIR）を使う。テストでは temp dir を注入する。 */
  recordingsDir?: string;
  buildMenu: (minutes: 60 | 30) => Menu;
  aeFeedback: (args: { transcript: string; topicTitle: string }) => Promise<AeFeedback>;
  /** 未知の topicId は null（ルートは404を返す） */
  modelTalk: (topicId: string) => Promise<{ text: string } | null>;
  reflection: () => Promise<Reflection>;
  /** 未知の scenarioId は null（ルートは400を返す） */
  scenarioPrompt: (scenarioId: string) => string | null;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

type ParsedBody<T> = { ok: true; body: T } | { ok: false; response: Response };

/** req.json() の失敗（不正なJSON）を 500 ではなく 400 として扱うための共通ラッパー */
async function parseJsonBody<T>(req: Request): Promise<ParsedBody<T>> {
  try {
    return { ok: true, body: (await req.json()) as T };
  } catch {
    return { ok: false, response: json({ error: "invalid JSON body" }, 400) };
  }
}

async function handleStt(req: Request, deps: RouteDeps): Promise<Response> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0) return json({ error: "empty audio body" }, 400);
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(deps.recordingsDir ?? RECORDINGS_DIR, day);
  mkdirSync(dir, { recursive: true });
  const ext = (req.headers.get("content-type") ?? "").includes("wav") ? "wav" : "webm";
  const file = path.join(dir, `${Date.now()}.${ext}`);
  await Bun.write(file, bytes);
  const text = await deps.transcribe(file);
  return json({ text });
}

async function handleTts(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ text?: string; voice?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!body.text?.trim()) return json({ error: "text is required" }, 400);
  const { audio, mime, engine } = await deps.synthesize(body.text, { voice: body.voice });
  return new Response(audio as unknown as BodyInit, { headers: { "content-type": mime, "x-tts-engine": engine } });
}

async function handleConverse(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ userText?: string; sessionId?: string; scenarioId?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!body.userText?.trim()) return json({ error: "userText is required" }, 400);
  let systemPromptOverride: string | undefined;
  if (body.scenarioId) {
    const p = deps.scenarioPrompt(body.scenarioId);
    if (!p) return json({ error: "unknown scenarioId" }, 400);
    systemPromptOverride = p;
  }
  const r = await deps.converse({ userText: body.userText, sessionId: body.sessionId, systemPromptOverride });
  return json(r);
}

function handleMenuToday(url: URL, deps: RouteDeps): Response {
  const raw = url.searchParams.get("minutes") ?? "60";
  if (raw !== "60" && raw !== "30") return json({ error: "minutes must be 60 or 30" }, 400);
  const minutes = Number(raw) as 60 | 30;
  return json(deps.buildMenu(minutes));
}

async function handleAeFeedback(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ transcript?: string; topicTitle?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const { transcript, topicTitle } = parsed.body;
  if (!transcript?.trim()) return json({ error: "transcript is required" }, 400);
  return json(await deps.aeFeedback({ transcript, topicTitle: topicTitle ?? "" }));
}

async function handleModelTalk(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ topicId?: string }>(req);
  if (!parsed.ok) return parsed.response;
  if (!parsed.body.topicId?.trim()) return json({ error: "topicId is required" }, 400);
  const talk = await deps.modelTalk(parsed.body.topicId);
  if (!talk) return json({ error: "unknown topicId" }, 404);
  return json(talk);
}

const BLOCK_EVENT_TYPES = ["block_start", "block_end", "round_start", "round_end"] as const;
type BlockEventType = (typeof BLOCK_EVENT_TYPES)[number];

async function handleSessionEvent(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ type?: string; sessionId?: string; meta?: Record<string, unknown> }>(req);
  if (!parsed.ok) return parsed.response;
  const t = parsed.body.type;
  if (!t || !(BLOCK_EVENT_TYPES as readonly string[]).includes(t)) {
    return json({ error: `type must be one of: ${BLOCK_EVENT_TYPES.join(", ")}` }, 400);
  }
  appendEvent(deps.logFile(), {
    ts: new Date().toISOString(),
    type: t as BlockEventType,
    sessionId: parsed.body.sessionId ?? "pending",
    meta: parsed.body.meta,
  });
  return json({ ok: true });
}

/**
 * ボディは任意（後方互換: 空ボディ・不正JSONでも従来どおり sessionId 無しとして扱い 200 を返す）。
 * クライアント側で mint したアプリレベルの session UUID を受け取り、以後のライフサイクル/
 * ブロック/ラウンドイベントと突き合わせられるようにする。
 */
async function handleSessionStart(req: Request, deps: RouteDeps): Promise<Response> {
  let sessionId: string | undefined;
  try {
    const body = (await req.json()) as { sessionId?: string };
    if (typeof body?.sessionId === "string" && body.sessionId) sessionId = body.sessionId;
  } catch {
    // ボディなし・不正JSONは従来どおり（sessionId無し）として扱う
  }
  appendEvent(deps.logFile(), {
    ts: new Date().toISOString(), type: "session_start", sessionId: sessionId ?? "pending",
  });
  return json({ ok: true });
}

async function handleSessionEnd(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ sessionId?: string }>(req);
  if (!parsed.ok) return parsed.response;
  appendEvent(deps.logFile(), {
    ts: new Date().toISOString(), type: "session_end", sessionId: parsed.body.sessionId ?? "unknown",
  });
  return json({ ok: true });
}

/** 現在の index.ts の全ルーティング・ハンドラをソケットを開かずにテストできる形に切り出したもの */
export function makeFetchHandler(deps: RouteDeps): (req: Request) => Promise<Response> {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/api/health") return json(deps.health());
      if (req.method === "POST" && url.pathname === "/api/stt") return await handleStt(req, deps);
      if (req.method === "POST" && url.pathname === "/api/tts") return await handleTts(req, deps);
      if (req.method === "POST" && url.pathname === "/api/converse") return await handleConverse(req, deps);
      if (req.method === "POST" && url.pathname === "/api/session/start") return await handleSessionStart(req, deps);
      if (req.method === "POST" && url.pathname === "/api/session/end") return await handleSessionEnd(req, deps);
      if (req.method === "GET" && url.pathname === "/api/menu/today") return handleMenuToday(url, deps);
      if (req.method === "POST" && url.pathname === "/api/feedback/ae") return await handleAeFeedback(req, deps);
      if (req.method === "POST" && url.pathname === "/api/coach/model-talk") return await handleModelTalk(req, deps);
      if (req.method === "POST" && url.pathname === "/api/coach/reflection") return json(await deps.reflection());
      if (req.method === "POST" && url.pathname === "/api/session/event") return await handleSessionEvent(req, deps);
      return json({ error: "not found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isErrorLogged(err)) {
        try {
          appendEvent(deps.logFile(), {
            ts: new Date().toISOString(), type: "error", sessionId: "server", text: message,
          });
        } catch (logErr) {
          // ロギング自体の失敗で「常に{error}JSONを返す」保証を崩さないためのガード
          console.error(`routes: failed to append error event: ${String(logErr)}`);
        }
      }
      return json({ error: message }, 500);
    }
  };
}
