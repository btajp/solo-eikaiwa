import { converseTurn, partnerSystemPrompt } from "../converse";
import { json, parseJsonBody, exact, type RouteEntry } from "./http";

export type ConverseRoutesDeps = {
  converse: typeof converseTurn;
  /** 未知の scenarioId は null（ルートは400を返す） */
  scenarioPrompt: (scenarioId: string) => string | null;
  /** 自由会話の語彙レベリング用: 現在の学習ステージ(1..6)を供給する */
  conversationStage: () => number;
};

async function handleConverse(req: Request, deps: ConverseRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{
    userText?: unknown; sessionId?: unknown; scenarioId?: unknown; activitySessionId?: unknown;
  }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (typeof body.userText !== "string" || !body.userText.trim()) {
    return json({ error: "userText is required" }, 400);
  }
  if (body.userText.length > 16_000) return json({ error: "userText must be at most 16000 characters" }, 400);
  if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || body.sessionId.length > 200)) {
    return json({ error: "sessionId must be a string of at most 200 characters" }, 400);
  }
  if (typeof body.activitySessionId !== "string"
    || body.activitySessionId.length < 1
    || body.activitySessionId.length > 200) {
    return json({ error: "activitySessionId must be a non-empty string of at most 200 characters" }, 400);
  }
  if (body.scenarioId !== undefined && (typeof body.scenarioId !== "string" || body.scenarioId.length > 200)) {
    return json({ error: "scenarioId must be a string of at most 200 characters" }, 400);
  }
  let systemPromptOverride: string;
  if (body.scenarioId) {
    const p = deps.scenarioPrompt(body.scenarioId);
    if (!p) return json({ error: "unknown scenarioId" }, 400);
    systemPromptOverride = p;
  } else {
    // 自由会話: stage 別の語彙レベリング付きパートナープロンプトを毎回組み立てる
    systemPromptOverride = partnerSystemPrompt(deps.conversationStage());
  }
  const r = await deps.converse({
    userText: body.userText,
    sessionId: body.sessionId,
    activitySessionId: body.activitySessionId,
    systemPromptOverride,
  });
  return json(r);
}

export function makeConverseRoutes(deps: ConverseRoutesDeps): RouteEntry[] {
  return [exact("POST", "/api/converse", (req) => handleConverse(req, deps))];
}
