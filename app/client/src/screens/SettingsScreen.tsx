import { useEffect, useRef, useState } from "react";
import {
  fetchLlmSettings, saveLlmRoleSettings, LLM_ROLES,
  fetchTtsSettings, saveTtsSettings,
  fetchLlmModels,
  EFFORT_OPTIONS, SERVICE_TIER_OPTIONS, AUTH_MODE_OPTIONS,
  type LlmRole, type LlmSettingsView, type TtsSettingsView, type RoleTuning, type LlmModelsResponse, type CatalogModelEffort,
  type AuthMode, type LlmAuthProvider,
} from "../api";
import {
  isLocalDefined, presetEnabled, presetTargets, matchPreset, hydrateConnection, hydrateTargets, hydrateTuning,
  hydrateAuthModes, hydrateAuthKeys, buildAuthPatch,
  buildRolesPayload, defaultTuning, applyRecommendedTuning,
  claudeModelSelectOptions, effortOptionsForClaudeAlias, codexModelSelectOptions, effortOptionsForCodexModel,
  tierOptionsForCodexModel, codexDefaultEffortLabel, localModelSelectOptions, resolveEffective, clampClaudeEffort,
  type RoleTarget, type RoleTargets, type Connection, type PresetId, type CloudTarget, type EffectiveResolution,
} from "../lib/llm-assignments";
import { loadPreferredCloud, savePreferredCloud } from "../lib/preferred-cloud";
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
  disabled: boolean;
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
            disabled={props.disabled || (t === "local" && !props.localEnabled)}
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
  const [llmResult, setLlmResult] = useState<string | null>(null);
  const [ttsResult, setTtsResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"conn" | "roles" | "display">("conn");
  const fetchedRef = useRef(false);
  // モデルカタログ（GET /api/llm-models）。用途タブを開いたときに遅延取得する（app起動時には叩かない）。
  const [catalog, setCatalog] = useState<LlmModelsResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const catalogFetchedRef = useRef(false);
  // プリセット適用時のクラウド枠（課金先）。localStorage永続・既存割当には影響しない。
  const [preferredCloud, setPreferredCloudState] = useState<CloudTarget>(() => loadPreferredCloud());
  function setPreferredCloud(c: CloudTarget) {
    setPreferredCloudState(c);
    savePreferredCloud(c);
  }

  // 接続の編集状態
  const [connBaseUrl, setConnBaseUrl] = useState("");
  const [connModel, setConnModel] = useState("");
  const [connCodex, setConnCodex] = useState("");
  // ロール割当の編集状態（3値）
  const [targets, setTargets] = useState<RoleTargets>({
    conversation: "claude", assist: "claude", coaching: "claude", generation: "claude", assessment: "claude",
  });
  // ロール別チューニングの編集状態（タブ切替で消えない・プリセット適用では変更しない）
  const [tuning, setTuning] = useState<Record<LlmRole, RoleTuning>>(() => defaultTuning());
  // 認証モードの編集状態（claude/codex）。キー検出状態は view から都度導出する（読み取り専用のため state 化しない）。
  const [authClaude, setAuthClaude] = useState<AuthMode>("subscription");
  const [authCodex, setAuthCodex] = useState<AuthMode>("subscription");
  // 直近 hydrate 済み（=サーバ保存済み）の認証モード。保存時はここからの差分だけを PUT に含める
  // （auth を変更していない保存で毎回両方を再送すると、api-key 保存後に env キーを削除した状態で
  // 無関係の保存まで 400 になりロックアウトする — buildAuthPatch 参照）。
  const [authBaseline, setAuthBaseline] = useState<Record<LlmAuthProvider, AuthMode>>({ claude: "subscription", codex: "subscription" });
  const authKeys = view ? hydrateAuthKeys(view) : { anthropic: false, codex: false };
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
    setTuning(hydrateTuning(v));
    const authModes = hydrateAuthModes(v);
    setAuthClaude(authModes.claude);
    setAuthCodex(authModes.codex);
    setAuthBaseline(authModes);
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

  /** refresh=true は「モデル一覧を更新」ボタン用（?refresh=1）。失敗は fail-quiet — カタログは
   * null のままとなり、選択肢・実効表示は静的フォールバック/「実体未確認」へ劣化する（嘘の表示をしない）。 */
  function refreshCatalog(refresh: boolean) {
    setCatalogLoading(true);
    fetchLlmModels(refresh)
      .then(setCatalog)
      .catch(() => {})
      .finally(() => setCatalogLoading(false));
  }

  useEffect(() => {
    // 接続タブ・用途タブのどちらもモデル一覧を使うため、先に開いた方が一度だけ取得する
    // （表示タブは使わないため対象外・app 起動時には叩かない＝Settings 画面を開いて初めて取得する）。
    if (tab === "display" || catalogFetchedRef.current) return;
    catalogFetchedRef.current = true;
    refreshCatalog(false);
  }, [tab]);

  const conn: Connection = { baseUrl: connBaseUrl, model: connModel, codexModel: connCodex };
  const localDefined = isLocalDefined(conn);

  function applyResult(v: LlmSettingsView) {
    hydrate(v);
    setLlmResult(v.applied === false ? s.llm.notApplied(v.error ?? "") : s.llm.applied);
  }

  async function persist(nextTargets: RoleTargets, nextConn: Connection): Promise<boolean> {
    setSaving(true); setLlmResult(null);
    try {
      // cloud はローカル未定義時のフォールバック先にのみ影響する（優先クラウドが唯一の妥当な出典）。
      // tuning は割当・プリセットとは独立に現在の編集状態をそのまま乗せる（プリセット適用は変更しない）。
      // auth はベースラインからの差分のみを乗せる（buildAuthPatch 参照）。未変更なら auth フィールド自体を省略する
      // ＝ auth を一切触っていない保存が、無関係な理由（例: 保存済みAPIキーの失効）で 400 になるのを防ぐ。
      const authPatch = buildAuthPatch(authBaseline, { claude: authClaude, codex: authCodex });
      applyResult(await saveLlmRoleSettings({
        ...buildRolesPayload(nextTargets, nextConn, preferredCloud, tuning),
        ...(authPatch ? { auth: authPatch } : {}),
      }));
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setLlmResult(reason ? s.llm.saveFailedWithReason(reason) : s.llm.saveFailed);
      return false;
    } finally { setSaving(false); }
  }

  async function applyPreset(id: PresetId) {
    const prev = targets;
    const next = presetTargets(id, preferredCloud);
    setTargets(next);
    if (!(await persist(next, conn))) setTargets(prev); // 失敗時は楽観更新を巻き戻す
  }

  function setTarget(role: LlmRole, t: RoleTarget) {
    setTargets((prev) => ({ ...prev, [role]: t }));
  }

  function setTuningField<K extends keyof RoleTuning>(role: LlmRole, field: K, value: RoleTuning[K]) {
    setTuning((prev) => ({ ...prev, [role]: { ...prev[role], [field]: value } }));
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
    setSaving(true); setTtsResult(null);
    try {
      hydrateTts(await saveTtsSettings({
        baseUrl: ttsBaseUrl.trim() || null,
        model: ttsModel.trim() || null,
        voice: ttsVoice.trim() || null,
      }));
      setTtsResult(s.llm.applied);
    } catch { setTtsResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  async function onResetTts() {
    setSaving(true); setTtsResult(null);
    try {
      hydrateTts(await saveTtsSettings({ baseUrl: null, model: null, voice: null }));
      setTtsResult(s.llm.applied);
    } catch { setTtsResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  const targetLabels: Record<RoleTarget, string> = {
    claude: s.settings.targetClaude, local: s.settings.targetLocal, codex: s.settings.targetCodex,
  };
  const tierLabels: Record<(typeof SERVICE_TIER_OPTIONS)[number], string> = {
    fast: s.settings.tuningTierFast, standard: s.settings.tuningTierStandard,
  };

  /** 用途タブの「実効」サマリ1行を組み立てる（表示専用。判定ロジックは resolveEffective が純関数で担う）。 */
  function effectiveLine(eff: EffectiveResolution): string {
    const providerLabel = targetLabels[eff.provider];
    const modelText = eff.model.confirmed
      ? eff.model.text
      : s.settings.effectiveUnconfirmedWith(eff.model.cliDefault ? s.settings.cliDefaultLabel : eff.model.text);
    const parts = [`${providerLabel} ${modelText}`];
    if (eff.effort) {
      parts.push(`${s.settings.tuningEffort} ${eff.effort.value === "sdk-standard" ? s.settings.tuningSdkStandard : eff.effort.value}`);
    }
    if (eff.tier) {
      parts.push(`${s.settings.tuningTier} ${tierLabels[eff.tier.value as (typeof SERVICE_TIER_OPTIONS)[number]] ?? eff.tier.value}`);
    }
    return `${s.settings.effectiveLabel} ${parts.join(" · ")}`;
  }

  return (
    <div className="stack">
      <div className="hero">
        <h2 className="hero-title">{s.settings.title}</h2>
      </div>

      <div className="lang-toggle settings-tabs" role="tablist" aria-label={s.settings.title}>
        <button role="tab" aria-selected={tab === "conn"} className={tab === "conn" ? "is-active" : ""} onClick={() => setTab("conn")}>{s.settings.connectionSection}</button>
        <button role="tab" aria-selected={tab === "roles"} className={tab === "roles" ? "is-active" : ""} onClick={() => setTab("roles")}>{s.settings.roleAssignSection}</button>
        <button role="tab" aria-selected={tab === "display"} className={tab === "display" ? "is-active" : ""} onClick={() => setTab("display")}>{s.settings.displaySection}</button>
      </div>

      {tab === "conn" && (
        <section className="support-panel stack">
          <div className="stat-title">{s.settings.connectionSection}</div>
          <div className="llm-fields stack">
            <div className="text-sm">{s.settings.targetClaude}</div>
            <div className="text-sm text-muted">{s.settings.claudeNoSetup}</div>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.settings.authModeLabel}</span>
              <select
                className="llm-input" value={authClaude} disabled={saving || !view}
                onChange={(e) => setAuthClaude(e.target.value as AuthMode)}
              >
                {AUTH_MODE_OPTIONS.map((m) => (
                  <option key={m} value={m} disabled={m === "api-key" && !authKeys.anthropic}>
                    {m === "subscription" ? s.settings.authSubscription : s.settings.authApiKey}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-sm text-muted">{authKeys.anthropic ? s.settings.authKeyDetected : s.settings.authKeyMissing}</div>
            <div className="text-sm text-muted">{s.settings.authApiKeyNote}</div>
          </div>
          <div className="llm-fields stack">
            <div className="text-sm">{s.settings.localConnTitle}</div>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.baseUrlLabel}</span>
              <input className="llm-input" value={connBaseUrl} placeholder={s.llm.baseUrlPlaceholder} onChange={(e) => setConnBaseUrl(e.target.value)} />
            </label>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.modelLabel}</span>
              {(() => {
                const opts = localModelSelectOptions(catalog?.local);
                if (opts.length === 0) {
                  return <input className="llm-input" value={connModel} placeholder={s.llm.modelPlaceholder} onChange={(e) => setConnModel(e.target.value)} />;
                }
                const known = opts.some((o) => o.value === connModel);
                return (
                  <select className="llm-input" value={connModel} onChange={(e) => setConnModel(e.target.value)}>
                    <option value="">{s.llm.modelPlaceholder}</option>
                    {!known && connModel && <option value={connModel}>{connModel}</option>}
                    {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                );
              })()}
            </label>
            <div className="text-sm text-muted">{view?.apiKeyConfigured ? s.llm.apiKeyConfigured : s.llm.apiKeyMissing}</div>
          </div>
          <div className="llm-fields stack">
            <div className="text-sm">{s.settings.codexConnTitle}</div>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.codexModelLabel}</span>
              {(() => {
                const opts = codexModelSelectOptions(catalog?.codex);
                if (opts.length === 0) {
                  return <input className="llm-input" value={connCodex} placeholder={s.llm.codexModelPlaceholder} onChange={(e) => setConnCodex(e.target.value)} />;
                }
                const known = opts.some((o) => o.value === connCodex);
                return (
                  <select className="llm-input" value={connCodex} onChange={(e) => setConnCodex(e.target.value)}>
                    <option value="">{s.llm.codexModelPlaceholder}</option>
                    {!known && connCodex && <option value={connCodex}>{connCodex}</option>}
                    {opts.map((o) => (
                      <option key={o.value} value={o.value}>{o.isDefault ? s.settings.cliDefaultBadgeWith(o.label) : o.label}</option>
                    ))}
                  </select>
                );
              })()}
            </label>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.settings.authModeLabel}</span>
              <select
                className="llm-input" value={authCodex} disabled={saving || !view}
                onChange={(e) => setAuthCodex(e.target.value as AuthMode)}
              >
                {AUTH_MODE_OPTIONS.map((m) => (
                  <option key={m} value={m} disabled={m === "api-key" && !authKeys.codex}>
                    {m === "subscription" ? s.settings.authSubscription : s.settings.authApiKey}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-sm text-muted">{authKeys.codex ? s.settings.authKeyDetected : s.settings.authKeyMissing}</div>
            <div className="text-sm text-muted">{s.settings.authApiKeyNote}</div>
          </div>
          <div className="text-sm text-muted">{s.llm.help}</div>
          <Button variant="secondary" onClick={() => void persist(targets, conn)} disabled={saving || !view}>{saving ? s.llm.saving : s.settings.saveConnection}</Button>
          {llmResult && <div className="info-pop" role="status">{llmResult}</div>}

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
          {ttsResult && <div className="info-pop" role="status">{ttsResult}</div>}
        </section>
      )}

      {tab === "roles" && (
        <section className="support-panel stack">
          <div className="info-pop">{s.settings.roleQualityNote}</div>

          {/* モデルカタログ（用途タブを開いた時点で遅延取得済み）の手動再取得 */}
          <div className="stack">
            <Button variant="secondary" onClick={() => refreshCatalog(true)} disabled={catalogLoading}>
              {catalogLoading ? s.settings.refreshingCatalog : s.settings.refreshCatalog}
            </Button>
            <div className="text-sm text-muted">{s.settings.catalogNote}</div>
          </div>

          {/* プリセット（現在の割当から逆引き表示。手動変更でカスタムに落ちる） */}
          <div className="stack">
            <div className="stat-title">{s.settings.presetSection}</div>
            <div className="llm-field">
              <span className="text-sm text-muted">{s.settings.preferredCloudLabel}</span>
              <div className="lang-toggle" role="group" aria-label={s.settings.preferredCloudLabel}>
                <button className={preferredCloud === "claude" ? "is-active" : ""} disabled={saving} onClick={() => setPreferredCloud("claude")}>Claude</button>
                <button className={preferredCloud === "codex" ? "is-active" : ""} disabled={saving} onClick={() => setPreferredCloud("codex")}>Codex</button>
              </div>
              <span className="text-sm text-muted">{s.settings.preferredCloudNote}</span>
            </div>
            {(() => {
              // matchPreset は { id, cloud } | "custom" を返す（優先クラウド対応）。表示は一致したクラウドを反映する（優先設定ではない）。
              const m = matchPreset(targets);
              const current = m === "custom" ? "custom" : m.id;
              return (
                <>
                  <select
                    className="llm-input" value={current} disabled={saving || !view}
                    aria-label={s.settings.presetSection}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "all-local" || v === "balanced" || v === "high-quality") void applyPreset(v);
                    }}
                  >
                    {current === "custom" && <option value="custom" disabled>{s.settings.presetCustom}</option>}
                    <option value="all-local" disabled={!presetEnabled("all-local", conn)}>{s.settings.presetAllLocal}</option>
                    <option value="balanced" disabled={!presetEnabled("balanced", conn)}>{s.settings.presetBalancedOption}</option>
                    <option value="high-quality">{s.settings.presetHighQuality}</option>
                  </select>
                  {current === "all-local" && <div className="text-sm text-muted">{s.settings.presetAllLocalDesc}</div>}
                  {m !== "custom" && current === "balanced" && <div className="text-sm text-muted">{s.settings.presetBalancedDesc(m.cloud)}</div>}
                  {m !== "custom" && current === "high-quality" && <div className="text-sm text-muted">{s.settings.presetHighQualityDesc(m.cloud)}</div>}
                  {!localDefined && <div className="text-sm text-muted">{s.settings.presetLocalRequired}</div>}
                </>
              );
            })()}
          </div>

          {/* 推奨チューニングのワンタップ適用（クラウド割当ロールのみ書き換え・保存はしない） */}
          <div className="stack">
            <Button
              variant="secondary"
              onClick={() => setTuning(applyRecommendedTuning(tuning, targets))}
              disabled={saving || !view}
            >
              {s.settings.applyRecommendedTuning}
            </Button>
            <div className="text-sm text-muted">{s.settings.applyRecommendedTuningNote}</div>
          </div>

          {/* 用途ごとのモデル（ロール割当） */}
          <div className="stack">
            <div className="stat-title">{s.settings.roleAssignSection}</div>
            <div className="text-sm text-muted">{s.settings.roleAssignDesc}</div>
            {LLM_ROLES.map((role) => {
              const catalogClaude = catalog?.claude;
              const catalogCodex = catalog?.codex;
              const selectedClaudeAlias = tuning[role].claudeModel ?? "sonnet";
              // カタログ不可時は現行の静的選択肢へ劣化する（推測の具体IDは出さない・「実効」行が別途「実体未確認」を明示する）
              const claudeEffortOptions = catalogClaude?.available
                ? effortOptionsForClaudeAlias(catalogClaude, selectedClaudeAlias)
                : [...EFFORT_OPTIONS];
              const codexEffortOptions: CatalogModelEffort[] = catalogCodex?.available
                ? effortOptionsForCodexModel(catalogCodex, connCodex)
                : EFFORT_OPTIONS.map((id) => ({ id }));
              const codexTierOptions = catalogCodex?.available
                ? tierOptionsForCodexModel(catalogCodex, connCodex)
                : SERVICE_TIER_OPTIONS;
              const codexEffortDefaultLabel = codexDefaultEffortLabel(catalogCodex, connCodex);
              const effective = view ? resolveEffective(role, view, catalog ?? undefined) : null;
              return (
                <div key={role} className="stack">
                  <div className="text-sm">{s.settings.roleName[role]}</div>
                  <div className="text-sm text-muted">{s.settings.roleDesc[role]}</div>
                  <div className="text-sm text-muted">{s.settings.roleReason[role]}</div>
                  <RoleTargetToggle
                    value={targets[role]}
                    localEnabled={localDefined}
                    labels={targetLabels}
                    localDisabledNote={s.settings.targetLocalDisabled}
                    ariaLabel={s.settings.roleName[role]}
                    disabled={saving || !view}
                    onChange={(t) => setTarget(role, t)}
                  />
                  {/* 実効サマリ（常時表示）: 現在この用途で実際に使われているプロバイダ・具体モデル・effort・配信 */}
                  {effective && <div className="text-sm text-muted">{effectiveLine(effective)}</div>}
                  {/* ローカル割当は openai-compat 経路が tuning（model/effort/serviceTier）を完全に無視するため
                      （llm-provider.ts の selectRunner・README にも明記）、詳細設定自体を出さない
                      （出しても中身が空になる＝意味のない disclosure を見せない） */}
                  {targets[role] !== "local" && (
                    <details className="stack">
                      <summary className="text-sm text-muted">{s.settings.tuningDetails}</summary>
                      <div className="stack">
                        {targets[role] === "claude" && (
                          <label className="llm-field">
                            <span className="text-sm text-muted">{s.settings.tuningModel}</span>
                            <select
                              className="llm-input"
                              value={tuning[role].claudeModel ?? ""}
                              disabled={saving || !view}
                              onChange={(e) => {
                                const newAlias = (e.target.value || null) as RoleTuning["claudeModel"];
                                // モデル切替で選択中の effort が新モデルで無効化される場合（実測: 非対応 effort は
                                // 黙って無視される）、UI 上に「効かない値」を残さないよう同じ更新で null にクランプする。
                                const clampedEffort = clampClaudeEffort(catalogClaude, newAlias ?? "sonnet", tuning[role].effort) as RoleTuning["effort"];
                                setTuning((prev) => ({ ...prev, [role]: { ...prev[role], claudeModel: newAlias, effort: clampedEffort } }));
                              }}
                            >
                              {/* 既定はコード定数（サーバは env チューニングを読まない）ため、静的表記が常に真 */}
                              <option value="">{s.settings.tuningDefaultWith("sonnet")}</option>
                              {claudeModelSelectOptions(catalogClaude).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          </label>
                        )}
                        <label className="llm-field">
                          <span className="text-sm text-muted">{s.settings.tuningEffort}</span>
                          <select
                            className="llm-input"
                            value={tuning[role].effort ?? ""}
                            disabled={saving || !view}
                            onChange={(e) => setTuningField(role, "effort", (e.target.value || null) as RoleTuning["effort"])}
                          >
                            {/* claude の既定effortはSDK標準（未指定）、codex はカタログのdefaultEffort優先（不可時コード既定medium）。
                                このセクション自体が local では出ないため、ここに来るのは claude/codex のみ */}
                            <option value="">
                              {targets[role] === "claude"
                                ? s.settings.tuningDefaultWith(s.settings.tuningSdkStandard)
                                : s.settings.tuningDefaultWith(codexEffortDefaultLabel)}
                            </option>
                            {/* claude: haiku 等 effort 非対応モデルではカタログ側が空配列を返し、既定のみ選択可になる */}
                            {targets[role] === "claude" && claudeEffortOptions.map((ef) => <option key={ef} value={ef}>{ef}</option>)}
                            {targets[role] === "codex" && codexEffortOptions.map((ef) => (
                              <option key={ef.id} value={ef.id}>{ef.description ? `${ef.id} — ${ef.description}` : ef.id}</option>
                            ))}
                          </select>
                        </label>
                        {targets[role] === "codex" && (
                          <label className="llm-field">
                            <span className="text-sm text-muted">{s.settings.tuningTier}</span>
                            <select
                              className="llm-input"
                              value={tuning[role].serviceTier ?? ""}
                              disabled={saving || !view}
                              onChange={(e) => setTuningField(role, "serviceTier", (e.target.value || null) as RoleTuning["serviceTier"])}
                            >
                              <option value="">{s.settings.tuningDefaultWith("fast")}</option>
                              {codexTierOptions.map((t) => <option key={t} value={t}>{tierLabels[t]}</option>)}
                            </select>
                          </label>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
            <Button variant="secondary" onClick={() => void persist(targets, conn)} disabled={saving || !view}>{saving ? s.llm.saving : s.settings.saveAssignments}</Button>
          </div>

          {llmResult && <div className="info-pop" role="status">{llmResult}</div>}
        </section>
      )}

      {tab === "display" && (
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
      )}
    </div>
  );
}
