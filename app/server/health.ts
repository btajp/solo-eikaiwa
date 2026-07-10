import { anyWhisperModelInstalled } from "./stt";
// package.json を静的 import することで compile（bun build --compile）時もバンドラーが値を
// インライン化する — 実行時に fs でファイルを読みに行かないため、Resources レイアウトに依存しない。
import pkg from "../package.json";
import { isOpenAiCompatReady, type LlmSettings } from "./llm-provider";

export type WhichFn = (bin: string) => string | null;

export type Health = {
  ok: boolean;
  whisper: boolean;
  ffmpeg: boolean;
  claude: boolean;
  ttsKey: boolean;
  modelFile: boolean;
  /** Tauri Phase 2: attach-first が別アプリの health に誤って接続していないかの身元確認用固定値 */
  app: "solo-eikaiwa";
  version: string;
  /**
   * Tauri Phase 2 T3 fix: claude/codex/openai-compatのいずれかの会話系ルートが実際に使えるかの集約判定。
   * `claude` 単体だと local-only/codex-only構成（例: Ollama運用）で「LLM未導入」の偽陽性通知が出て
   * しまうため追加した（ok の算出式は変更していない — 既存のセットアップ完了判定はclaude前提のまま）。
   */
  llmReady: boolean;
};

export function checkHealth(opts: {
  whichFn?: WhichFn;
  env?: Record<string, string | undefined>;
  modelExists?: () => boolean;
  /** グローバルLLM設定（DB行）。省略時はDB未設定=env直接運用として扱う（isOpenAiCompatReadyの既定と同じ）。 */
  llmSettings?: LlmSettings | null;
} = {}): Health {
  const which = opts.whichFn ?? ((b: string) => Bun.which(b));
  const env = opts.env ?? Bun.env;
  const modelExists = opts.modelExists ?? (() => anyWhisperModelInstalled());

  const whisper = Boolean(which("whisper-cli") ?? which("whisper-cpp"));
  const ffmpeg = Boolean(which("ffmpeg"));
  const claude = Boolean(which("claude"));
  const codex = Boolean(which("codex"));
  const ttsKey = Boolean(env.TTS_API_KEY?.trim() || env.OPENAI_API_KEY?.trim());
  const modelFile = modelExists();
  const llmReady = claude || codex || isOpenAiCompatReady(opts.llmSettings ?? null, env);

  return {
    ok: whisper && ffmpeg && claude && modelFile,
    whisper, ffmpeg, claude, ttsKey, modelFile,
    app: "solo-eikaiwa",
    version: pkg.version,
    llmReady,
  };
}
