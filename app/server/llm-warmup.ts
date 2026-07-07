import { warmOpenAICompat, type OpenAICompatWarmConfig } from "./providers/openai-compat";

/**
 * conversation ロールが openai-compat のとき、API リクエスト受信を契機にローカルモデルを温めておく。
 * 目的: 利用中はモデルを常駐させ、初回会話応答のコールドスタートを避ける。
 * 240秒スロットルにより、Ollama の既定アンロード（5分）に対して「利用中は常駐・離脱後は自然に解放」になる
 * （明示アンロードはしない＝ユーザーの他用途を妨げない）。
 * warm 自体の HTTP はローカル LLM への OUTBOUND であり、当サーバの受信フックを再帰トリガーしない。
 */
export type Warmup = {
  /** conversation の解決先が openai-compat のとき config、それ以外（Claude/Codex）は null。 */
  setTarget(target: OpenAICompatWarmConfig | null): void;
  /** 直近 windowMs 以内に温めた or 温め中なら no-op。target が null なら no-op。fire-and-forget（await しない）。 */
  maybeWarm(now?: number): void;
};

export function makeWarmup(opts: { fetchFn?: typeof fetch; windowMs?: number } = {}): Warmup {
  const windowMs = opts.windowMs ?? 240_000;
  let target: OpenAICompatWarmConfig | null = null;
  let lastWarmAt = Number.NEGATIVE_INFINITY;
  let warming = false;
  return {
    setTarget(t) {
      target = t;
    },
    maybeWarm(now = Date.now()) {
      if (!target) return; // Claude/Codex は対象外
      if (warming) return; // 温め中
      if (now - lastWarmAt < windowMs) return; // 直近窓内
      lastWarmAt = now; // 楽観的に窓を開始し、同時多発リクエストを1回に畳む
      warming = true;
      // fire-and-forget: リクエスト処理をブロックしない。失敗は warn のみ。
      void warmOpenAICompat(target, opts.fetchFn)
        .catch((err) => console.warn(`[llm-warmup] warm failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { warming = false; });
    },
  };
}

/** 本番配線用の既定インスタンス（converse.ts が setTarget、index.ts が maybeWarm を配線する）。 */
export const conversationWarmup = makeWarmup();
