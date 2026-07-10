import { json, parseJsonBody, exact, type RouteEntry } from "./http";
import { DEFAULT_TTS_BASE_URL, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, type TtsProvider, type TtsSettings } from "../tts";
import { TTS_PROVIDERS } from "../tts-provider-store";
import { parseRemoteBaseUrl } from "../remote-endpoint";

export type TtsSettingsRoutesDeps = {
  getTtsSettings: () => TtsSettings | null;
  saveTtsSettings: (s: TtsSettings) => void;
  /** TTS プロバイダの明示選択（行不在は "auto"）。 */
  getTtsProvider: () => TtsProvider;
  saveTtsProvider: (p: TtsProvider) => void;
  /** Keychain/env resolver由来のAPIキー状態のみ。値は返さない。 */
  ttsEnv: () => { apiKeyConfigured: boolean; apiKeyApproved?: boolean };
};

/** undefined/null/空文字 → null（未指定=既定へ）、trim後1文字以上でmax以下の文字列 → trim値、それ以外 → undefined（不正） */
function asOptionalStr(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** GET/PUT 共通ビュー。APIキー値は決して含めない（有無の boolean のみ）。 */
function viewOf(deps: TtsSettingsRoutesDeps) {
  const s = deps.getTtsSettings();
  const keyState = deps.ttsEnv();
  return {
    provider: deps.getTtsProvider(),
    baseUrl: s?.baseUrl ?? null,
    model: s?.model ?? null,
    voice: s?.voice ?? null,
    apiKeyConfigured: keyState.apiKeyConfigured,
    apiKeyApproved: keyState.apiKeyApproved ?? false,
    defaults: { baseUrl: DEFAULT_TTS_BASE_URL, model: DEFAULT_TTS_MODEL, voice: DEFAULT_TTS_VOICE },
  };
}

type Body = { provider?: unknown; baseUrl?: unknown; model?: unknown; voice?: unknown };

async function handlePut(req: Request, deps: TtsSettingsRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<Body>(req);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  const baseUrl = asOptionalStr(b.baseUrl, 500);
  if (baseUrl === undefined) return json({ error: "baseUrl must be a string of at most 500 characters" }, 400);
  let normalizedBaseUrl = baseUrl;
  if (baseUrl !== null) {
    const parsedBase = parseRemoteBaseUrl(baseUrl);
    if (!parsedBase.ok) return json({ error: parsedBase.error }, 400);
    normalizedBaseUrl = parsedBase.baseUrl;
  }

  const model = asOptionalStr(b.model, 200);
  if (model === undefined) return json({ error: "model must be a string of at most 200 characters" }, 400);

  const voice = asOptionalStr(b.voice, 100);
  if (voice === undefined) return json({ error: "voice must be a string of at most 100 characters" }, 400);

  // provider は任意（未指定なら変更しない）。指定時はホワイトリスト検証してから保存する。
  let provider: TtsProvider | undefined;
  if (b.provider !== undefined) {
    if (typeof b.provider !== "string" || !(TTS_PROVIDERS as readonly string[]).includes(b.provider)) {
      return json({ error: `provider must be one of ${TTS_PROVIDERS.join(", ")}` }, 400);
    }
    provider = b.provider as TtsProvider;
  }

  deps.saveTtsSettings({ baseUrl: normalizedBaseUrl, model, voice });
  if (provider !== undefined) deps.saveTtsProvider(provider);
  return json(viewOf(deps));
}

export function makeTtsSettingsRoutes(deps: TtsSettingsRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/tts-settings", () => json(viewOf(deps))),
    exact("PUT", "/api/tts-settings", (req) => handlePut(req, deps)),
  ];
}
