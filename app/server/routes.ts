import path from "node:path";
import { mkdirSync } from "node:fs";
import { RECORDINGS_DIR } from "./paths";
import { appendEvent, isErrorLogged } from "./session-log";
import { transcribeAudio } from "./stt";
import { synthesize } from "./tts";
import { converseTurn } from "./converse";
import { checkHealth } from "./health";
import { BLOCK_KINDS, QUICK_KINDS, type Menu, type QuickKind } from "./menu";
import type { AeFeedback, Reflection, PrepPack } from "./coach";
import type { Settings } from "./settings";
import type { LibraryStore } from "./db";
import type { Grade, SentenceStore } from "./sentences";
import type { ProgressStore, XpKind } from "./progress-store";

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
  /** 未知の topicId は null（ルートは404を返す）。topicTitle はライブラリ記録用（レスポンスには含めない） */
  modelTalk: (topicId: string) => Promise<{ text: string; topicTitle?: string } | null>;
  /** モデルトークの記録と一覧（実体は db.ts、テストはフェイク/インメモリ） */
  libraryStore: LibraryStore;
  reflection: () => Promise<Reflection>;
  /** 未知の scenarioId は null（ルートは400を返す） */
  scenarioPrompt: (scenarioId: string) => string | null;
  /** 未知の topicId は null（ルートは404を返す） */
  prepPack: (topicId: string) => Promise<PrepPack | null>;
  buildQuick: (kind: QuickKind) => Menu;
  practiceDays: () => string[];
  getSettings: () => Settings;
  saveSettings: (s: Settings) => void;
  /** 暗記例文300の一覧・出題キュー・自己評価（実体は sentences.ts、テストはフェイク） */
  sentenceStore: SentenceStore;
  /** レベル/XPの進行状態（実体は progress-store.ts、テストはフェイク） */
  progressStore: ProgressStore;
  /** 明示的なレベル変更（accept/set）後に当日の通しメニューキャッシュを無効化する（decline では呼ばない） */
  invalidateMenuCache: () => void;
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

function handleMenuQuick(url: URL, deps: RouteDeps): Response {
  const kind = url.searchParams.get("kind") ?? "";
  if (!(QUICK_KINDS as readonly string[]).includes(kind)) {
    return json({ error: `kind must be one of: ${QUICK_KINDS.join(", ")}` }, 400);
  }
  return json(deps.buildQuick(kind as QuickKind));
}

async function handleSettingsPut(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ anchor?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const anchor = parsed.body.anchor;
  if (typeof anchor !== "string" || anchor.length > 200) {
    return json({ error: "anchor must be a string of at most 200 characters" }, 400);
  }
  deps.saveSettings({ anchor });
  return json({ ok: true });
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
  try {
    deps.libraryStore.saveModelTalk({
      topicId: parsed.body.topicId,
      topicTitle: talk.topicTitle ?? "",
      text: talk.text,
    });
  } catch (err) {
    console.warn("[library] saveModelTalk failed, continuing:", String(err));
  }
  return json({ text: talk.text });
}

async function handlePrep(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ topicId?: string }>(req);
  if (!parsed.ok) return parsed.response;
  if (!parsed.body.topicId?.trim()) return json({ error: "topicId is required" }, 400);
  const pack = await deps.prepPack(parsed.body.topicId);
  if (!pack) return json({ error: "unknown topicId" }, 404);
  return json(pack);
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

const GRADES = ["good", "soso", "bad"] as const;

async function handleProgressXp(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ kind?: unknown; amount?: unknown; attemptId?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { kind, amount, attemptId } = parsed.body;
  // HTTP経由で受けるのは block のみ（srs-grade はサーバ内部、placement は Phase C のサーバ内部付与）
  if (kind !== "block") return json({ error: "kind must be \"block\"" }, 400);
  if (typeof amount !== "number") return json({ error: "amount must be a number" }, 400);
  if (attemptId !== undefined && !Number.isInteger(attemptId)) {
    return json({ error: "attemptId must be an integer" }, 400);
  }
  const s = deps.progressStore.addXp(kind as XpKind, amount, attemptId !== undefined ? { attemptId } : {});
  if (!s) return json({ error: "invalid amount for kind" }, 400);
  return json(s);
}

async function handleProgressBlockStart(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ kind?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const kind = parsed.body.kind;
  if (typeof kind !== "string" || !(BLOCK_KINDS as readonly string[]).includes(kind)) {
    return json({ error: `kind must be one of: ${BLOCK_KINDS.join(", ")}` }, 400);
  }
  return json(deps.progressStore.blockStart(kind));
}

const LEVEL_ACTIONS = ["accept", "decline", "set"] as const;

async function handleProgressLevel(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ action?: unknown; level?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { action, level } = parsed.body;
  if (!(LEVEL_ACTIONS as readonly string[]).includes(action as string)) {
    return json({ error: `action must be one of: ${LEVEL_ACTIONS.join(", ")}` }, 400);
  }
  if (level !== undefined && typeof level !== "number") return json({ error: "level must be a number" }, 400);
  // set がレベルを実際に変えたかどうかを判定するため、変異前のレベルを捕捉しておく
  const previousLevel = action === "set" ? deps.progressStore.getLevel() : undefined;
  const s = deps.progressStore.levelAction(action as "accept" | "decline" | "set", level as number | undefined);
  if (!s) {
    return json({ error: action === "set" ? "level must be an integer between 1 and 999" : "no active proposal" }, 400);
  }
  // 明示的なレベル変更（accept/set）は当日中に反映させる。decline は据え置きなので無効化しない。
  // 同一レベルへの set は no-op なので無効化しない。
  const setWasNoop = action === "set" && previousLevel === level;
  if (action !== "decline" && !setWasNoop) deps.invalidateMenuCache();
  return json(s);
}

function handleSentenceQueue(url: URL, deps: RouteDeps): Response {
  const raw = url.searchParams.get("new") ?? "10";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 50) {
    return json({ error: "new must be an integer between 0 and 50" }, 400);
  }
  return json({ queue: deps.sentenceStore.queue(n) });
}

async function handleSentenceGrade(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ no?: unknown; grade?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { no, grade } = parsed.body;
  if (typeof no !== "number" || !Number.isInteger(no)) return json({ error: "no must be an integer" }, 400);
  if (!(GRADES as readonly string[]).includes(grade as string)) {
    return json({ error: `grade must be one of: ${GRADES.join(", ")}` }, 400);
  }
  const r = deps.sentenceStore.grade(no, grade as Grade);
  if (!r) return json({ error: `unknown sentence no: ${no}` }, 400);
  // 自己評価1枚ごとの努力XP（good=2 / soso=1 / bad=1）。付与失敗で採点自体は失敗させない
  try {
    deps.progressStore.addXp("srs-grade", grade === "good" ? 2 : 1, { no });
  } catch (err) {
    console.warn("[progress] srs-grade xp failed, continuing:", String(err));
  }
  return json(r);
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
      if (req.method === "GET" && url.pathname === "/api/menu/quick") return handleMenuQuick(url, deps);
      if (req.method === "GET" && url.pathname === "/api/progress/days") return json({ days: deps.practiceDays() });
      if (req.method === "GET" && url.pathname === "/api/progress/summary") return json(deps.progressStore.getSummary());
      if (req.method === "POST" && url.pathname === "/api/progress/xp") return await handleProgressXp(req, deps);
      if (req.method === "POST" && url.pathname === "/api/progress/block-start") return await handleProgressBlockStart(req, deps);
      if (req.method === "POST" && url.pathname === "/api/progress/level") return await handleProgressLevel(req, deps);
      if (req.method === "GET" && url.pathname === "/api/library/model-talks")
        return json({ entries: deps.libraryStore.listModelTalks() });
      if (req.method === "GET" && url.pathname === "/api/settings") return json(deps.getSettings());
      if (req.method === "PUT" && url.pathname === "/api/settings") return await handleSettingsPut(req, deps);
      if (req.method === "POST" && url.pathname === "/api/feedback/ae") return await handleAeFeedback(req, deps);
      if (req.method === "POST" && url.pathname === "/api/coach/model-talk") return await handleModelTalk(req, deps);
      if (req.method === "POST" && url.pathname === "/api/coach/prep") return await handlePrep(req, deps);
      if (req.method === "POST" && url.pathname === "/api/coach/reflection") return json(await deps.reflection());
      if (req.method === "POST" && url.pathname === "/api/session/event") return await handleSessionEvent(req, deps);
      if (req.method === "GET" && url.pathname === "/api/sentences") return json({ sentences: deps.sentenceStore.list() });
      if (req.method === "GET" && url.pathname === "/api/sentences/queue") return handleSentenceQueue(url, deps);
      if (req.method === "POST" && url.pathname === "/api/sentences/grade") return await handleSentenceGrade(req, deps);
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
