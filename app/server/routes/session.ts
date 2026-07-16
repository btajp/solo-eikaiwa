import { appendEvent } from "../session-log";
import { json, parseJsonBody, exact, type RouteEntry } from "./http";

export type SessionRoutesDeps = {
  logFile: () => string;
};

// block_activity: ブロック内の実施実態（例: シャドーイングの「聞いた」「声に出した」自己申告）を meta で区別して残す（#181）
const BLOCK_EVENT_TYPES = ["block_start", "block_end", "round_start", "round_end", "block_activity"] as const;
type BlockEventType = (typeof BLOCK_EVENT_TYPES)[number];
const MAX_SESSION_ID_CHARS = 200;

function parseSessionId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= MAX_SESSION_ID_CHARS ? value : null;
}

async function handleSessionEvent(req: Request, deps: SessionRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ type?: string; sessionId?: string; meta?: Record<string, unknown> }>(req);
  if (!parsed.ok) return parsed.response;
  const t = parsed.body.type;
  if (!t || !(BLOCK_EVENT_TYPES as readonly string[]).includes(t)) {
    return json({ error: `type must be one of: ${BLOCK_EVENT_TYPES.join(", ")}` }, 400);
  }
  const sessionId = parseSessionId(parsed.body.sessionId);
  if (sessionId === null) return json({ error: "sessionId must be a string of at most 200 characters" }, 400);
  if (parsed.body.meta !== undefined && (
    parsed.body.meta === null || typeof parsed.body.meta !== "object" || Array.isArray(parsed.body.meta)
  )) {
    return json({ error: "meta must be an object" }, 400);
  }
  appendEvent(deps.logFile(), {
    ts: new Date().toISOString(),
    type: t as BlockEventType,
    sessionId: sessionId ?? "pending",
    meta: parsed.body.meta,
  });
  return json({ ok: true });
}

async function handleSessionStart(req: Request, deps: SessionRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ sessionId?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const sessionId = parseSessionId(parsed.body.sessionId);
  if (sessionId === null) return json({ error: "sessionId must be a string of at most 200 characters" }, 400);
  appendEvent(deps.logFile(), {
    ts: new Date().toISOString(), type: "session_start", sessionId: sessionId ?? "pending",
  });
  return json({ ok: true });
}

async function handleSessionEnd(req: Request, deps: SessionRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ sessionId?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const sessionId = parseSessionId(parsed.body.sessionId);
  if (sessionId === null) return json({ error: "sessionId must be a string of at most 200 characters" }, 400);
  appendEvent(deps.logFile(), {
    ts: new Date().toISOString(), type: "session_end", sessionId: sessionId ?? "unknown",
  });
  return json({ ok: true });
}

export function makeSessionRoutes(deps: SessionRoutesDeps): RouteEntry[] {
  return [
    exact("POST", "/api/session/start", (req) => handleSessionStart(req, deps)),
    exact("POST", "/api/session/end", (req) => handleSessionEnd(req, deps)),
    exact("POST", "/api/session/event", (req) => handleSessionEvent(req, deps)),
  ];
}
