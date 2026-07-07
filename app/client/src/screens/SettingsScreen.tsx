import { useEffect, useRef, useState } from "react";
import {
  fetchLlmSettings, saveLlmRoleSettings, LLM_ROLES,
  fetchTtsSettings, saveTtsSettings,
  type LlmRole, type LlmSettingsView, type TtsSettingsView,
} from "../api";
import {
  PRESETS, isLocalDefined, presetEnabled, hydrateConnection, hydrateTargets, buildRolesPayload,
  type RoleTarget, type RoleTargets, type Connection, type PresetId,
} from "../lib/llm-assignments";
import { STR, type Lang } from "../i18n";
import { Button } from "../ui/Button";

export type UiScale = "small" | "medium" | "large" | "xlarge";

type Props = {
  lang: Lang;
  uiScale: UiScale;
  setUiScale: (s: UiScale) => void;
  switchLang: (l: Lang) => void;
};

type VoiceProviderKind = "kokoro" | "openai";
const VOICE_PRESETS: Record<VoiceProviderKind, { female: string; male: string }> = {
  kokoro: { female: "af_heart", male: "am_michael" },
  openai: { female: "nova", male: "onyx" },
};
const VOICE_PRESET_FEMALE_VALUES = Object.values(VOICE_PRESETS).map((p) => p.female);
const VOICE_PRESET_MALE_VALUES = Object.values(VOICE_PRESETS).map((p) => p.male);

/** baseUrl から音声プロバイダを推定する（8880 または kokoro を含めば Kokoro系、それ以外は OpenAI系）。 */
function detectVoiceProviderKind(baseUrl: string): VoiceProviderKind {
  const lower = baseUrl.toLowerCase();
  return lower.includes("8880") || lower.includes("kokoro") ? "kokoro" : "openai";
}

/** 1ロールの割当トグル（Claude / ローカル / Codex）。ローカル未定義時はローカルを非活性 + 中立案内。 */
function RoleTargetToggle(props: {
  value: RoleTarget;
  localEnabled: boolean;
  labels: Record<RoleTarget, string>;
  localDisabledNote: string;
  ariaLabel: string;
  onChange: (t: RoleTarget) => void;
}) {
  const order: RoleTarget[] = ["claude", "local", "codex"];
  return (
    <div className="stack">
      <div className="lang-toggle llm-provider-toggle" role="group" aria-label={props.ariaLabel}>
        {order.map((t) => (
          <button
            key={t}
            className={props.value === t ? "is-active" : ""}
            disabled={t === "local" && !props.localEnabled}
            onClick={() => props.onChange(t)}
          >
            {props.labels[t]}
          </button>
        ))}
      </div>
      {!props.localEnabled && <div className="text-sm text-muted">{props.localDisabledNote}</div>}
    </div>
  );
}

export function SettingsScreen({ lang, uiScale, setUiScale, switchLang }: Props) {
  const s = STR[lang];
  const [view, setView] = useState<LlmSettingsView | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fetchedRef = useRef(false);

  // 接続の編集状態
  const [connBaseUrl, setConnBaseUrl] = useState("");
  const [connModel, setConnModel] = useState("");
  const [connCodex, setConnCodex] = useState("");
  // ロール割当の編集状態（3値）
  const [targets, setTargets] = useState<RoleTargets>({
    conversation: "claude", coaching: "claude", generation: "claude", assessment: "claude",
  });
  // 音声（TTS）の編集状態
  const [ttsView, setTtsView] = useState<TtsSettingsView | null>(null);
  const [ttsBaseUrl, setTtsBaseUrl] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsVoice, setTtsVoice] = useState("");

  function hydrate(v: LlmSettingsView) {
    setView(v);
    const conn = hydrateConnection(v);
    setConnBaseUrl(conn.baseUrl);
    setConnModel(conn.model);
    setConnCodex(conn.codexModel);
    setTargets(hydrateTargets(v));
  }

  function hydrateTts(v: TtsSettingsView) {
    setTtsView(v);
    setTtsBaseUrl(v.baseUrl ?? "");
    setTtsModel(v.model ?? "");
    setTtsVoice(v.voice ?? "");
  }

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchLlmSettings().then(hydrate).catch(() => {});
    fetchTtsSettings().then(hydrateTts).catch(() => {});
  }, []);

  const conn: Connection = { baseUrl: connBaseUrl, model: connModel, codexModel: connCodex };
  const localDefined = isLocalDefined(conn);

  function applyResult(v: LlmSettingsView) {
    hydrate(v);
    setResult(v.applied === false ? s.llm.notApplied(v.error ?? "") : s.llm.applied);
  }

  async function persist(nextTargets: RoleTargets, nextConn: Connection) {
    setSaving(true); setResult(null);
    try {
      applyResult(await saveLlmRoleSettings(buildRolesPayload(nextTargets, nextConn)));
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  function applyPreset(id: PresetId) {
    const next = PRESETS[id];
    setTargets(next);
    void persist(next, conn);
  }

  function setTarget(role: LlmRole, t: RoleTarget) {
    setTargets((prev) => ({ ...prev, [role]: t }));
  }

  const voicePreset: "female" | "male" | "custom" = VOICE_PRESET_FEMALE_VALUES.includes(ttsVoice.trim())
    ? "female"
    : VOICE_PRESET_MALE_VALUES.includes(ttsVoice.trim())
    ? "male"
    : "custom";

  function applyVoicePreset(kind: "female" | "male") {
    setTtsVoice(VOICE_PRESETS[detectVoiceProviderKind(ttsBaseUrl)][kind]);
  }

  async function onSaveTts() {
    setSaving(true); setResult(null);
    try {
      hydrateTts(await saveTtsSettings({
        baseUrl: ttsBaseUrl.trim() || null,
        model: ttsModel.trim() || null,
        voice: ttsVoice.trim() || null,
      }));
      setResult(s.llm.applied);
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  async function onResetTts() {
    setSaving(true); setResult(null);
    try {
      hydrateTts(await saveTtsSettings({ baseUrl: null, model: null, voice: null }));
      setResult(s.llm.applied);
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  const targetLabels: Record<RoleTarget, string> = {
    claude: s.settings.targetClaude, local: s.settings.targetLocal, codex: s.settings.targetCodex,
  };

  return (
    <div className="stack">
      <div className="hero">
        <h2 className="hero-title">{s.settings.title}</h2>
      </div>

      {/* 言語モデル */}
      <section className="support-panel stack">
        <div className="stat-title">{s.settings.llmSection}</div>

        {/* プリセット（最上部・ロール割当を書くだけ） */}
        <div className="stack">
          <div className="stat-title">{s.settings.presetSection}</div>
          <div className="text-sm text-muted">{s.settings.presetAllLocalDesc}</div>
          <Button variant="secondary" onClick={() => applyPreset("all-local")} disabled={saving || !view || !presetEnabled("all-local", conn)}>{s.settings.presetAllLocal}</Button>
          <div className="text-sm">{s.settings.presetBalancedBadge}</div>
          <div className="text-sm text-muted">{s.settings.presetBalancedDesc}</div>
          <Button variant="primary" onClick={() => applyPreset("balanced")} disabled={saving || !view || !presetEnabled("balanced", conn)}>{s.settings.presetBalanced}</Button>
          <div className="text-sm text-muted">{s.settings.presetHighQualityDesc}</div>
          <Button variant="secondary" onClick={() => applyPreset("high-quality")} disabled={saving || !view}>{s.settings.presetHighQuality}</Button>
          {!localDefined && <div className="text-sm text-muted">{s.settings.presetLocalRequired}</div>}
        </div>

        {/* 接続（ローカル LLM / Codex を定義する場所） */}
        <div className="stack">
          <div className="stat-title">{s.settings.connectionSection}</div>
          <div className="text-sm text-muted">{s.settings.claudeNoSetup}</div>
          <div className="llm-fields stack">
            <div className="text-sm">{s.settings.localConnTitle}</div>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.baseUrlLabel}</span>
              <input className="llm-input" value={connBaseUrl} placeholder={s.llm.baseUrlPlaceholder} onChange={(e) => setConnBaseUrl(e.target.value)} />
            </label>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.modelLabel}</span>
              <input className="llm-input" value={connModel} placeholder={s.llm.modelPlaceholder} onChange={(e) => setConnModel(e.target.value)} />
            </label>
            <div className="text-sm text-muted">{view?.apiKeyConfigured ? s.llm.apiKeyConfigured : s.llm.apiKeyMissing}</div>
          </div>
          <div className="llm-fields stack">
            <div className="text-sm">{s.settings.codexConnTitle}</div>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.codexModelLabel}</span>
              <input className="llm-input" value={connCodex} placeholder={s.llm.codexModelPlaceholder} onChange={(e) => setConnCodex(e.target.value)} />
            </label>
          </div>
          <div className="text-sm text-muted">{s.llm.help}</div>
          <Button variant="secondary" onClick={() => persist(targets, conn)} disabled={saving || !view}>{saving ? s.llm.saving : s.settings.saveConnection}</Button>
        </div>

        {/* 用途ごとのモデル（ロール割当） */}
        <div className="stack">
          <div className="stat-title">{s.settings.roleAssignSection}</div>
          <div className="text-sm text-muted">{s.settings.roleAssignDesc}</div>
          {LLM_ROLES.map((role) => (
            <div key={role} className="stack">
              <div className="text-sm">{s.settings.roleName[role]}</div>
              <div className="text-sm text-muted">{s.settings.roleDesc[role]}</div>
              <RoleTargetToggle
                value={targets[role]}
                localEnabled={localDefined}
                labels={targetLabels}
                localDisabledNote={s.settings.targetLocalDisabled}
                ariaLabel={s.settings.roleName[role]}
                onChange={(t) => setTarget(role, t)}
              />
            </div>
          ))}
          <Button variant="secondary" onClick={() => persist(targets, conn)} disabled={saving || !view}>{saving ? s.llm.saving : s.settings.saveAssignments}</Button>
        </div>

        {result && <div className="info-pop" role="status">{result}</div>}
      </section>

      {/* 音声（TTS） */}
      <section className="support-panel stack">
        <div className="stat-title">{s.settings.ttsSection}</div>
        <div className="text-sm text-muted">{s.settings.ttsDesc}</div>
        <div className="llm-fields stack">
          <label className="llm-field">
            <span className="text-sm text-muted">{s.settings.ttsBaseUrlLabel}</span>
            <input className="llm-input" value={ttsBaseUrl} placeholder={s.settings.ttsBaseUrlPlaceholder} onChange={(e) => setTtsBaseUrl(e.target.value)} />
          </label>
          <label className="llm-field">
            <span className="text-sm text-muted">{s.settings.ttsModelLabel}</span>
            <input className="llm-input" value={ttsModel} placeholder={s.settings.ttsModelPlaceholder} onChange={(e) => setTtsModel(e.target.value)} />
          </label>
          <div className="llm-field">
            <span className="text-sm text-muted">{s.settings.ttsVoicePresetLabel}</span>
            <div className="lang-toggle" role="group" aria-label={s.settings.ttsVoicePresetLabel}>
              <button className={voicePreset === "female" ? "is-active" : ""} disabled={!ttsView} onClick={() => applyVoicePreset("female")}>{s.settings.ttsVoiceFemale}</button>
              <button className={voicePreset === "male" ? "is-active" : ""} disabled={!ttsView} onClick={() => applyVoicePreset("male")}>{s.settings.ttsVoiceMale}</button>
              <button className={voicePreset === "custom" ? "is-active" : ""} disabled={!ttsView}>{s.settings.ttsVoiceCustom}</button>
            </div>
            <span className="text-sm text-muted">{s.settings.ttsVoicePresetNote}</span>
          </div>
          <label className="llm-field">
            <span className="text-sm text-muted">{s.settings.ttsVoiceLabel}</span>
            <input className="llm-input" value={ttsVoice} placeholder={s.settings.ttsVoicePlaceholder} onChange={(e) => setTtsVoice(e.target.value)} />
          </label>
          <div className="text-sm text-muted">{ttsView?.apiKeyConfigured ? s.settings.ttsApiKeyConfigured : s.settings.ttsApiKeyOptional}</div>
        </div>
        <Button variant="secondary" onClick={onSaveTts} disabled={saving || !ttsView}>{saving ? s.llm.saving : s.llm.save}</Button>
        <div className="text-sm text-muted">{s.settings.ttsResetDesc}</div>
        <Button variant="secondary" onClick={onResetTts} disabled={saving || !ttsView}>{s.settings.ttsReset}</Button>
      </section>

      {/* 表示 */}
      <section className="support-panel stack">
        <div className="stat-title">{s.settings.displaySection}</div>
        <div className="lang-toggle" role="group" aria-label={s.appShell.textSize}>
          <button className={uiScale === "small" ? "is-active" : ""} onClick={() => setUiScale("small")}>{s.uiScale.small}</button>
          <button className={uiScale === "medium" ? "is-active" : ""} onClick={() => setUiScale("medium")}>{s.uiScale.medium}</button>
          <button className={uiScale === "large" ? "is-active" : ""} onClick={() => setUiScale("large")}>{s.uiScale.large}</button>
          <button className={uiScale === "xlarge" ? "is-active" : ""} onClick={() => setUiScale("xlarge")}>{s.uiScale.xlarge}</button>
        </div>
        <div className="lang-toggle" role="group" aria-label={s.appShell.language}>
          <button className={lang === "en" ? "is-active" : ""} onClick={() => switchLang("en")}>EN</button>
          <button className={lang === "ja" ? "is-active" : ""} onClick={() => switchLang("ja")}>日本語</button>
        </div>
      </section>
    </div>
  );
}
