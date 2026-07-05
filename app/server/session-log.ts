import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type SessionEvent = {
  ts: string;
  type: "session_start" | "session_end" | "user_utterance" | "assistant_reply" | "error";
  sessionId: string;
  text?: string;
  meta?: Record<string, unknown>;
};

export function appendEvent(file: string, e: SessionEvent): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(e) + "\n", "utf8");
}

export function readEvents(file: string): SessionEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}
