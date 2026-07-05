import path from "node:path";
import { mkdirSync } from "node:fs";
import { ensureDirs, RECORDINGS_DIR, sessionLogPath } from "./paths";
import { appendEvent } from "./session-log";
import { transcribeAudio } from "./stt";
import { synthesize } from "./tts";
import { converseTurn } from "./converse";
import { checkHealth } from "./health";

ensureDirs();
const PORT = 3111;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function handleStt(req: Request): Promise<Response> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0) return json({ error: "empty audio body" }, 400);
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(RECORDINGS_DIR, day);
  mkdirSync(dir, { recursive: true });
  const ext = (req.headers.get("content-type") ?? "").includes("wav") ? "wav" : "webm";
  const file = path.join(dir, `${Date.now()}.${ext}`);
  await Bun.write(file, bytes);
  const text = await transcribeAudio(file);
  return json({ text });
}

async function handleTts(req: Request): Promise<Response> {
  const body = (await req.json()) as { text?: string; voice?: string };
  if (!body.text?.trim()) return json({ error: "text is required" }, 400);
  const { audio, mime, engine } = await synthesize(body.text, { voice: body.voice });
  return new Response(audio, { headers: { "content-type": mime, "x-tts-engine": engine } });
}

async function handleConverse(req: Request): Promise<Response> {
  const body = (await req.json()) as { userText?: string; sessionId?: string };
  if (!body.userText?.trim()) return json({ error: "userText is required" }, 400);
  const r = await converseTurn({ userText: body.userText, sessionId: body.sessionId });
  return json(r);
}

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/api/health") return json(checkHealth());
      if (req.method === "POST" && url.pathname === "/api/stt") return await handleStt(req);
      if (req.method === "POST" && url.pathname === "/api/tts") return await handleTts(req);
      if (req.method === "POST" && url.pathname === "/api/converse") return await handleConverse(req);
      if (req.method === "POST" && url.pathname === "/api/session/start") {
        appendEvent(sessionLogPath(new Date()), { ts: new Date().toISOString(), type: "session_start", sessionId: "pending" });
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/session/end") {
        const body = (await req.json()) as { sessionId?: string };
        appendEvent(sessionLogPath(new Date()), {
          ts: new Date().toISOString(), type: "session_end", sessionId: body.sessionId ?? "unknown",
        });
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendEvent(sessionLogPath(new Date()), {
        ts: new Date().toISOString(), type: "error", sessionId: "server", text: message,
      });
      return json({ error: message }, 500);
    }
  },
});

console.log(`learn-english server: http://localhost:${PORT} (health: /api/health)`);
