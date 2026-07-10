import type { ClaudeRunner } from "../converse";
import { appendTurn, resolveSessionId, type ChatTurn } from "./transcript";
import { parseRemoteBaseUrl } from "../remote-endpoint";

/** OpenAI 互換 chat completions で ClaudeRunner を実現する設定。 */
export type OpenAICompatConfig = {
  /** 例: http://localhost:11434/v1 （末尾の /chat/completions は付けない） */
  baseUrl: string;
  /** Ollama/LM Studio では不要。設定時のみ Authorization: Bearer を付与する */
  apiKey?: string;
  model: string;
  /** opts.systemPrompt 未指定時に使う既定 system プロンプト（Claude の PARTNER_SYSTEM_PROMPT 相当） */
  defaultSystemPrompt: string;
  /** テスト用の注入 seam。既定はグローバル fetch */
  fetchFn?: typeof fetch;
};

/** transcript.ts の ChatTurn の型エイリアス（このモジュール内での呼び名を維持）。 */
type ChatMsg = ChatTurn;

type ChatResponse = { choices?: Array<{ message?: { content?: string } }> };

/**
 * OpenAI 互換 API を叩く ClaudeRunner。chat completions はステートレスなので、
 * SDK の resume セマンティクスを sessionId → 会話履歴(system を除く) のインメモリ Map で再現する。
 * プロセス再起動で履歴が消えるのは既存 SDK セッションも同様（許容）。
 */
export function makeOpenAICompatRunner(cfg: OpenAICompatConfig): ClaudeRunner {
  const fetchFn = cfg.fetchFn ?? fetch;
  const parsedBase = parseRemoteBaseUrl(cfg.baseUrl);
  if (!parsedBase.ok) throw new Error(parsedBase.error);
  const endpoint = `${parsedBase.baseUrl}/chat/completions`;
  const store = new Map<string, ChatMsg[]>();

  return async (prompt, resumeId, opts) => {
    const sessionId = resolveSessionId(store, resumeId);
    const history = store.get(sessionId) ?? [];
    const system = opts?.systemPrompt ?? cfg.defaultSystemPrompt;

    const messages = [
      { role: "system" as const, content: system },
      ...history,
      { role: "user" as const, content: prompt },
    ];

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey && parsedBase.credentialsAllowed) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

    const res = await fetchFn(endpoint, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify({ model: cfg.model, messages, stream: false }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI-compat chat failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as ChatResponse;
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("OpenAI-compat returned empty result");

    appendTurn(store, sessionId, prompt, text);
    return { text, sessionId };
  };
}

/** warm 用の最小接続情報（defaultSystemPrompt/fetchFn を持たない・runner とは独立）。 */
export type OpenAICompatWarmConfig = { baseUrl: string; apiKey?: string; model: string };

/**
 * ローカルモデルを常駐させておくための極小 chat completion（max_tokens=1）。
 * 会話履歴（makeOpenAICompatRunner の store）には一切触れない。best-effort で、応答本文は使わない。
 * 非2xx は throw し、呼び出し側（llm-warmup）の warn に回す。
 */
export async function warmOpenAICompat(cfg: OpenAICompatWarmConfig, fetchFn: typeof fetch = fetch): Promise<void> {
  const parsedBase = parseRemoteBaseUrl(cfg.baseUrl);
  if (!parsedBase.ok) throw new Error(parsedBase.error);
  const endpoint = `${parsedBase.baseUrl}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey && parsedBase.credentialsAllowed) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  const res = await fetchFn(endpoint, {
    method: "POST",
    redirect: "error",
    headers,
    body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
  });
  if (!res.ok) throw new Error(`OpenAI-compat warm failed: ${res.status}`);
}

/**
 * env が openai-compat を指し必要値が揃っていれば warm 用 config を返す。それ以外（claude/codex/env・値欠落）は null。
 * selectRunner の requireEnv（throw する）とは別に、warm は best-effort なので欠落時は null を返す（throw しない）。
 */
export function openAICompatWarmTargetFromEnv(env: Record<string, string | undefined>): OpenAICompatWarmConfig | null {
  if ((env.LLM_PROVIDER ?? "").trim().toLowerCase() !== "openai-compat") return null;
  const baseUrl = env.OPENAI_COMPAT_BASE_URL?.trim();
  const model = env.OPENAI_COMPAT_MODEL?.trim();
  if (!baseUrl || !model) return null;
  const parsedBase = parseRemoteBaseUrl(baseUrl);
  if (!parsedBase.ok) return null;
  return {
    baseUrl: parsedBase.baseUrl,
    apiKey: parsedBase.credentialsAllowed ? env.OPENAI_COMPAT_API_KEY?.trim() || undefined : undefined,
    model,
  };
}
