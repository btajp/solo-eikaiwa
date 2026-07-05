import { query } from "@anthropic-ai/claude-agent-sdk";
import { appendEvent } from "./session-log";
import { sessionLogPath } from "./paths";

export const PARTNER_SYSTEM_PROMPT = `You are an English conversation partner for a Japanese IT professional (CEFR A2-B1).
- You are a friendly colleague. Talk about tech work, identity management, security, AI — or whatever the learner brings up.
- Keep every reply SHORT: 2-4 sentences, then ask ONE follow-up question.
- Use plain, high-frequency English (B1 level). No rare idioms.
- Do NOT correct errors explicitly in this mode; just respond naturally (recast briefly only when meaning is unclear).
- Never switch to Japanese.`;

export type ClaudeRunner = (prompt: string, resumeId?: string) => Promise<{ text: string; sessionId: string }>;

export function makeClaudeRunner(queryFn: typeof query): ClaudeRunner {
  return async (prompt, resumeId) => {
    let sessionId = resumeId ?? "";
    let text = "";
    for await (const msg of queryFn({
      prompt,
      options: {
        systemPrompt: PARTNER_SYSTEM_PROMPT,
        model: "sonnet",
        allowedTools: [],
        maxTurns: 1,
        ...(resumeId ? { resume: resumeId } : {}),
      },
    })) {
      if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          text = msg.result;
        } else {
          const details: string[] = [];
          if (msg.stop_reason) details.push(`stop_reason=${msg.stop_reason}`);
          if (msg.errors?.length) details.push(`errors=${msg.errors.join("; ")}`);
          const suffix = details.length ? `: ${details.join(", ")}` : "";
          throw new Error(`Claude result error (${msg.subtype})${suffix}`);
        }
      }
    }
    if (!text) throw new Error("Claude returned empty result");
    return { text, sessionId };
  };
}

export const runClaudeTurn: ClaudeRunner = makeClaudeRunner(query);

export async function converseTurn(args: {
  userText: string;
  sessionId?: string;
  runner?: ClaudeRunner;
  logFile?: string;
}): Promise<{ replyText: string; sessionId: string }> {
  const runner = args.runner ?? runClaudeTurn;
  const logFile = args.logFile ?? sessionLogPath(new Date());
  const now = () => new Date().toISOString();

  appendEvent(logFile, {
    ts: now(), type: "user_utterance", sessionId: args.sessionId ?? "pending", text: args.userText,
  });

  let text: string;
  let sessionId: string;
  try {
    ({ text, sessionId } = await runner(args.userText, args.sessionId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendEvent(logFile, {
      ts: now(), type: "error", sessionId: args.sessionId ?? "pending", text: message,
    });
    throw err;
  }

  appendEvent(logFile, { ts: now(), type: "assistant_reply", sessionId, text });
  return { replyText: text, sessionId };
}
