import type { ClaudeRunner } from "../converse";

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

type ChatMsg = { role: "user" | "assistant"; content: string };

type ChatResponse = { choices?: Array<{ message?: { content?: string } }> };

/**
 * OpenAI 互換 API を叩く ClaudeRunner。chat completions はステートレスなので、
 * SDK の resume セマンティクスを sessionId → 会話履歴(system を除く) のインメモリ Map で再現する。
 * プロセス再起動で履歴が消えるのは既存 SDK セッションも同様（許容）。
 */
export function makeOpenAICompatRunner(cfg: OpenAICompatConfig): ClaudeRunner {
  const fetchFn = cfg.fetchFn ?? fetch;
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const store = new Map<string, ChatMsg[]>();

  return async (prompt, resumeId, opts) => {
    const sessionId = resumeId && store.has(resumeId) ? resumeId : crypto.randomUUID();
    const history = store.get(sessionId) ?? [];
    const system = opts?.systemPrompt ?? cfg.defaultSystemPrompt;

    const messages = [
      { role: "system" as const, content: system },
      ...history,
      { role: "user" as const, content: prompt },
    ];

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

    const res = await fetchFn(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, messages, stream: false }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI-compat chat failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as ChatResponse;
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("OpenAI-compat returned empty result");

    store.set(sessionId, [
      ...history,
      { role: "user", content: prompt },
      { role: "assistant", content: text },
    ]);
    return { text, sessionId };
  };
}
