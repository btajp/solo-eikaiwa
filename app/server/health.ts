import { existsSync } from "node:fs";
import { WHISPER_MODEL_PATH } from "./stt";

export type WhichFn = (bin: string) => string | null;

export function checkHealth(opts: {
  whichFn?: WhichFn;
  env?: Record<string, string | undefined>;
  modelExists?: () => boolean;
} = {}): { ok: boolean; whisper: boolean; ffmpeg: boolean; claude: boolean; ttsKey: boolean; modelFile: boolean } {
  const which = opts.whichFn ?? ((b: string) => Bun.which(b));
  const env = opts.env ?? Bun.env;
  const modelExists = opts.modelExists ?? (() => existsSync(WHISPER_MODEL_PATH));

  const whisper = Boolean(which("whisper-cli") ?? which("whisper-cpp"));
  const ffmpeg = Boolean(which("ffmpeg"));
  const claude = Boolean(which("claude"));
  const ttsKey = Boolean(env.OPENAI_API_KEY);
  const modelFile = modelExists();

  return { ok: whisper && ffmpeg && claude && modelFile, whisper, ffmpeg, claude, ttsKey, modelFile };
}
