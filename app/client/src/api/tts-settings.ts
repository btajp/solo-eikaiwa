import { extractErrorMessage } from "./http";

/** TTS プロバイダの明示選択（サーバの tts_provider_settings と一致）。auto=従来の暗黙決定。 */
export type TtsProvider = "auto" | "say" | "openai-compat";
export const TTS_PROVIDER_OPTIONS: readonly TtsProvider[] = ["auto", "say", "openai-compat"];

/** GET/PUT 応答。APIキー値は含まれない（有無のみ apiKeyConfigured）。 */
export type TtsSettingsView = {
  provider: TtsProvider;
  baseUrl: string | null;
  model: string | null;
  voice: string | null;
  apiKeyConfigured: boolean;
  defaults: { baseUrl: string; model: string; voice: string };
};

export type TtsSettingsInput = {
  /** 未指定なら変更しない。 */
  provider?: TtsProvider;
  baseUrl?: string | null;
  model?: string | null;
  voice?: string | null;
};

export async function fetchTtsSettings(): Promise<TtsSettingsView> {
  const res = await fetch("/api/tts-settings");
  if (!res.ok) throw new Error(`tts-settings failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function saveTtsSettings(input: TtsSettingsInput): Promise<TtsSettingsView> {
  const res = await fetch("/api/tts-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`tts-settings save failed: ${await extractErrorMessage(res)}`);
  return res.json();
}
