import { useEffect, useRef, useState } from "react";
import {
  fetchLlmSettings, saveLlmSettings, saveLlmRoleSettings, LLM_ROLES,
  fetchTtsSettings, saveTtsSettings,
  type LlmProvider, type LlmRole, type LlmRoleProvider, type LlmRoleView, type LlmSettingsView,
  type TtsSettingsView,
} from "../api";
import { STR, type Lang } from "../i18n";
import { Button } from "../ui/Button";

export type UiScale = "small" | "medium" | "large" | "xlarge";

type Props = {
  lang: Lang;
  uiScale: UiScale;
  setUiScale: (s: UiScale) => void;
  switchLang: (l: Lang) => void;
};

const GLOBAL_PROVIDERS: LlmProvider[] = ["env", "claude", "openai-compat", "codex"];
const ROLE_PROVIDERS: LlmRoleProvider[] = ["inherit", "claude", "openai-compat", "codex"];

/** provider トグル + openai-compat/codex の条件フィールドを描く共有エディタ（全体設定とロール行で再利用）。 */
function ProviderEditor<P extends string>(props: {
  lang: Lang;
  providers: P[];
  labelOf: (p: P) => string;
  value: { provider: P; baseUrl: string | null; model: string | null; codexModel: string | null };
  onChange: (next: { provider: P; baseUrl: string | null; model: string | null; codexModel: string | null }) => void;
  apiKeyConfigured: boolean;
  ariaLabel: string;
}) {
  const t = STR[props.lang].llm;
  const v = props.value;
  return (
    <div className="stack">
      <div className="lang-toggle llm-provider-toggle" role="group" aria-label={props.ariaLabel}>
        {props.providers.map((p) => (
          <button key={p} className={v.provider === p ? "is-active" : ""} onClick={() => props.onChange({ ...v, provider: p })}>
            {props.labelOf(p)}
          </button>
        ))}
      </div>
      {v.provider === "openai-compat" && (
        <div className="llm-fields stack">
          <label className="llm-field">
            <span className="text-sm text-muted">{t.baseUrlLabel}</span>
            <input className="llm-input" value={v.baseUrl ?? ""} placeholder={t.baseUrlPlaceholder} onChange={(e) => props.onChange({ ...v, baseUrl: e.target.value })} />
          </label>
          <label className="llm-field">
            <span className="text-sm text-muted">{t.modelLabel}</span>
            <input className="llm-input" value={v.model ?? ""} placeholder={t.modelPlaceholder} onChange={(e) => props.onChange({ ...v, model: e.target.value })} />
          </label>
          <div className="text-sm text-muted">{props.apiKeyConfigured ? t.apiKeyConfigured : t.apiKeyMissing}</div>
        </div>
      )}
      {v.provider === "codex" && (
        <label className="llm-field">
          <span className="text-sm text-muted">{t.codexModelLabel}</span>
          <input className="llm-input" value={v.codexModel ?? ""} placeholder={t.codexModelPlaceholder} onChange={(e) => props.onChange({ ...v, codexModel: e.target.value })} />
        </label>
      )}
    </div>
  );
}

export function SettingsScreen({ lang, uiScale, setUiScale, switchLang }: Props) {
  const s = STR[lang];
  const [view, setView] = useState<LlmSettingsView | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fetchedRef = useRef(false);

  // 全体設定の編集状態
  const [gProvider, setGProvider] = useState<LlmProvider>("env");
  const [gBaseUrl, setGBaseUrl] = useState("");
  const [gModel, setGModel] = useState("");
  const [gCodex, setGCodex] = useState("");
  // ロール別の編集状態
  const [roles, setRoles] = useState<Record<LlmRole, LlmRoleView>>({
    conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
    coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
    generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
    assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
  });
  // 音声（TTS）の編集状態
  const [ttsView, setTtsView] = useState<TtsSettingsView | null>(null);
  const [ttsBaseUrl, setTtsBaseUrl] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsVoice, setTtsVoice] = useState("");

  function hydrate(v: LlmSettingsView) {
    setView(v);
    setGProvider(v.provider === "env" || v.provider === "claude" || v.provider === "openai-compat" || v.provider === "codex" ? v.provider : "env");
    setGBaseUrl(v.baseUrl ?? "");
    setGModel(v.model ?? "");
    setGCodex(v.codexModel ?? "");
    setRoles(v.roles);
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

  function applyResult(v: LlmSettingsView) {
    hydrate(v);
    setResult(v.applied === false ? s.llm.notApplied(v.error ?? "") : s.llm.applied);
  }

  async function onSaveGlobal() {
    setSaving(true); setResult(null);
    try {
      applyResult(await saveLlmSettings({
        provider: gProvider,
        baseUrl: gProvider === "openai-compat" ? gBaseUrl : null,
        model: gProvider === "openai-compat" ? gModel : null,
        codexModel: gProvider === "codex" ? (gCodex || null) : null,
      }));
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  async function onSaveRoles() {
    setSaving(true); setResult(null);
    try {
      applyResult(await saveLlmRoleSettings({ roles }));
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  async function onRecommended() {
    if (!view || view.provider !== "openai-compat") return;
    setSaving(true); setResult(null);
    try {
      // 会話のみローカルLLMに固定し、他ロールが継承する全体設定はClaude既定(env)に戻す。
      // これにより保存後は view.provider === "env" となり、推奨ボタンは正しくdisabledへ戻る。
      applyResult(await saveLlmRoleSettings({
        global: { provider: "env" },
        roles: {
          conversation: { provider: "openai-compat", baseUrl: view.baseUrl, model: view.model },
          coaching: { provider: "inherit" },
          generation: { provider: "inherit" },
          assessment: { provider: "inherit" },
        },
      }));
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  async function onResetAll() {
    setSaving(true); setResult(null);
    try {
      applyResult(await saveLlmRoleSettings({
        global: { provider: "env" },
        roles: {
          conversation: { provider: "inherit" }, coaching: { provider: "inherit" },
          generation: { provider: "inherit" }, assessment: { provider: "inherit" },
        },
      }));
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
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

  const recommendEnabled = view?.provider === "openai-compat";

  return (
    <div className="stack">
      <div className="hero">
        <h2 className="hero-title">{s.settings.title}</h2>
      </div>

      {/* 言語モデル */}
      <section className="support-panel stack">
        <div className="stat-title">{s.settings.llmSection}</div>

        {/* 全体の接続先（現 LlmPanel 相当） */}
        <div className="stack">
          <div className="support-label-row">
            <div className="text-sm text-muted">{s.settings.connectionTitle}</div>
          </div>
          <ProviderEditor
            lang={lang}
            providers={GLOBAL_PROVIDERS}
            labelOf={(p) => ({ env: s.llm.optEnv, claude: s.llm.optClaude, "openai-compat": s.llm.optOpenai, codex: s.llm.optCodex }[p])}
            value={{ provider: gProvider, baseUrl: gBaseUrl, model: gModel, codexModel: gCodex }}
            onChange={(n) => { setGProvider(n.provider); setGBaseUrl(n.baseUrl ?? ""); setGModel(n.model ?? ""); setGCodex(n.codexModel ?? ""); }}
            apiKeyConfigured={Boolean(view?.apiKeyConfigured)}
            ariaLabel={s.llm.providerLabel}
          />
          {gProvider === "env" && view && <div className="text-sm text-muted">{s.llm.envNote(view.envProvider)}</div>}
          <div className="text-sm text-muted">{s.llm.help}</div>
          <Button variant="secondary" onClick={onSaveGlobal} disabled={saving || !view}>{saving ? s.llm.saving : s.llm.save}</Button>
        </div>

        {/* かんたん設定（プリセット主役） */}
        <div className="stack">
          <div className="stat-title">{s.settings.presetTitle}</div>
          <div className="text-sm text-muted">{s.settings.recommendDesc}</div>
          <Button variant="primary" onClick={onRecommended} disabled={saving || !view || !recommendEnabled}>{s.settings.recommendApply}</Button>
          {!recommendEnabled && <div className="text-sm text-muted">{s.settings.recommendDisabled}</div>}
          <div className="text-sm text-muted">{s.settings.resetDesc}</div>
          <Button variant="secondary" onClick={onResetAll} disabled={saving || !view}>{s.settings.resetApply}</Button>
        </div>

        {/* 用途別モデル（折りたたみ詳細） */}
        <details className="stack">
          <summary className="text-sm text-muted">{s.settings.rolesSummary}</summary>
          <div className="stat-title">{s.settings.rolesTitle}</div>
          {LLM_ROLES.map((role) => (
            <div key={role} className="stack">
              <div className="text-sm">{s.settings.roleName[role]}</div>
              <div className="text-sm text-muted">{s.settings.roleDesc[role]}</div>
              <ProviderEditor
                lang={lang}
                providers={ROLE_PROVIDERS}
                labelOf={(p) => ({ inherit: s.settings.optInherit, claude: s.llm.optClaude, "openai-compat": s.llm.optOpenai, codex: s.llm.optCodex }[p])}
                value={roles[role]}
                onChange={(n) => setRoles((prev) => ({ ...prev, [role]: n }))}
                apiKeyConfigured={Boolean(view?.apiKeyConfigured)}
                ariaLabel={s.settings.roleName[role]}
              />
            </div>
          ))}
          <Button variant="secondary" onClick={onSaveRoles} disabled={saving || !view}>{saving ? s.llm.saving : s.settings.saveRoles}</Button>
        </details>

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
