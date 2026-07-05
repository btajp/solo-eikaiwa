import { ensureDirs, RECORDINGS_DIR, sessionLogPath } from "./paths";
import { transcribeAudio } from "./stt";
import { synthesize } from "./tts";
import { converseTurn } from "./converse";
import { checkHealth } from "./health";
import { makeFetchHandler, type RouteDeps } from "./routes";

ensureDirs();
const PORT = 3111;
const HOSTNAME = "127.0.0.1";

const realDeps: RouteDeps = {
  transcribe: transcribeAudio,
  synthesize,
  converse: converseTurn,
  health: () => checkHealth(),
  logFile: () => sessionLogPath(new Date()),
  recordingsDir: RECORDINGS_DIR,
};

Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  idleTimeout: 120,
  // 2分程度の音声Blobに十分な余裕を持たせた上限（DoS的な巨大ボディを拒否する）
  maxRequestBodySize: 32 * 1024 * 1024,
  fetch: makeFetchHandler(realDeps),
});

console.log(`learn-english server: http://${HOSTNAME}:${PORT} (health: /api/health)`);
