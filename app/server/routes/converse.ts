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
  const parsed = await parseJsonBody<{ userText?: string; sessionId?: string; scenarioId?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!body.userText?.trim()) return json({ error: "userText is required" }, 400);
  let systemPromptOverride: string;
  if (body.scenarioId) {
    const p = deps.scenarioPrompt(body.scenarioId);
    if (!p) return json({ error: "unknown scenarioId" }, 400);
    systemPromptOverride = p;
  } else {
    // 自由会話: stage 別の語彙レベリング付きパートナープロンプトを毎回組み立てる
    systemPromptOverride = partnerSystemPrompt(deps.conversationStage());
  }
  const r = await deps.converse({ userText: body.userText, sessionId: body.sessionId, systemPromptOverride });
  return json(r);
}

export function makeConverseRoutes(deps: ConverseRoutesDeps): RouteEntry[] {
  return [exact("POST", "/api/converse", (req) => handleConverse(req, deps))];
}
