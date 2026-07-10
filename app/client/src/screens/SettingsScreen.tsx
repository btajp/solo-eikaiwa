import { useEffect, useRef, useState } from "react";
import {
  fetchLlmSettings, saveLlmRoleSettings, LLM_ROLES,
  fetchTtsSettings, saveTtsSettings,
  fetchLlmModels,
  EFFORT_OPTIONS, SERVICE_TIER_OPTIONS, AUTH_MODE_OPTIONS, TTS_PROVIDER_OPTIONS,
  type LlmRole, type LlmSettingsView, type TtsSettingsView, type RoleTuning, type LlmModelsResponse, type CatalogModelEffort,
  type AuthMode, type LlmAuthProvider, type TtsProvider,
} from "../api";
import { fetchSecrets, saveSecret, deleteSecret, type SecretName, type SecretsView, type SecretStatus, type SecretMutationResult } from "../api";
import {
  isLocalDefined, presetEnabled, presetTargets, matchPreset, hydrateConnection, hydrateTargets, hydrateTuning,
  hydrateGlobalTuning, hydrateAuthModes, hydrateAuthKeys, buildAuthPatch,
  buildRolesPayload, defaultTuning, applyRecommendedTuning,
  claudeModelSelectOptions, effortOptionsForClaudeAlias, codexModelSelectOptions, effortOptionsForCodexModel,
  tierOptionsForCodexModel, codexDefaultEffortLabel, codexDefaultModelLabel, localModelSelectOptions, resolveEffective, clampClaudeEffort,
  classifyOpenAiEndpoint, CODEX_EFFORT_OPTIONS,
  type RoleTarget, type RoleTargets, type Connection, type PresetId, type CloudTarget, type EffectiveResolution,
  type EndpointClassification,
} from "../lib/llm-assignments";
import { loadPreferredCloud, savePreferredCloud } from "../lib/preferred-cloud";
import { ttsAutoResolution } from "../lib/tts-resolution";
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

/** API キー1件の write-only 入力欄。値の表示・再取得はできない（置換 or 削除のみ・ソースを必ず明示）。 */
function SecretKeyField(props: {
  name: SecretName;
  status: SecretStatus | undefined;
  disabled: boolean;
  approvalRequired?: boolean;
  str: {
    label: string; statusKeychain: string; statusEnv: string; statusMissing: string;
    placeholderSet: string; placeholderNew: string; save: string; del: string;
    saved: string; deleted: string;
    approvalRequired: string;
    saveFailedWithReason: (reason: string) => string;
    notApplied: (reason: string) => string;
  };
  onSave: (name: SecretName, value: string) => Promise<SecretMutationResult>;
  onDelete: (name: SecretName) => Promise<SecretMutationResult>;
}) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const st = props.status;
  const statusText = st?.configured
    ? st.source === "keychain" ? props.str.statusKeychain : props.str.statusEnv
    : props.str.statusMissing;

  async function run(action: () => Promise<SecretMutationResult>, doneMsg: string) {
    setResult(null);
    try {
      const r = await action();
      setValue("");
      // 保存自体は成功しても実行中プロセスへの適用に失敗した場合（applied:false）は、
      // 「保存し、適用しました」と嘘をつかずに理由つきで情報表示する（UI 真実性）。
      setResult(r.applied === false ? props.str.notApplied(r.error ?? "") : doneMsg);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setResult(props.str.saveFailedWithReason(reason));
    }
  }

  return (
    <div className="llm-field">
      <span className="text-sm text-muted">{props.str.label} — {statusText}</span>
      <div className="secret-key-row">
        <input
          className="llm-input"
          type="password"
          autoComplete="off"
          value={value}
          placeholder={st?.configured ? props.str.placeholderSet : props.str.placeholderNew}
          disabled={props.disabled}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button variant="secondary" disabled={props.disabled || value.trim().length === 0}
          onClick={() => void run(() => props.onSave(props.name, value.trim()), props.str.saved)}>
          {props.str.save}
        </Button>
        {st?.source === "keychain" && (
          <Button variant="secondary" disabled={props.disabled}
            onClick={() => void run(() => props.onDelete(props.name), props.str.deleted)}>
            {props.str.del}
          </Button>
        )}
      </div>
      {result && <div className="text-sm text-muted" role="status">{result}</div>}
      {props.approvalRequired && <div className="info-pop">{props.str.approvalRequired}</div>}
    </div>
  );
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
  // Claude の既定モデル（全用途共通・llm_role_tuning の "global" 行）。空文字＝コード既定（sonnet）。
  const [globalClaudeModel, setGlobalClaudeModel] = useState("");
  // 認証モードの編集状態（claude/codex）。キー検出状態は view から都度導出する（読み取り専用のため state 化しない）。
  const [authClaude, setAuthClaude] = useState<AuthMode>("subscription");
  const [authCodex, setAuthCodex] = useState<AuthMode>("subscription");
  // 直近 hydrate 済み（=サーバ保存済み）の認証モード。保存時はここからの差分だけを PUT に含める
  // （auth を変更していない保存で毎回両方を再送すると、api-key 保存後に env キーを削除した状態で
  // 無関係の保存まで 400 になりロックアウトする — buildAuthPatch 参照）。
  const [authBaseline, setAuthBaseline] = useState<Record<LlmAuthProvider, AuthMode>>({ claude: "subscription", codex: "subscription" });
  const authKeys = view ? hydrateAuthKeys(view) : { anthropic: false, codex: false };
  // API キーの有無・ソース（値はサーバが返さない）
  const [secrets, setSecrets] = useState<SecretsView | null>(null);
  // 音声（TTS）の編集状態
  const [ttsView, setTtsView] = useState<TtsSettingsView | null>(null);
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("auto");
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
    setGlobalClaudeModel(hydrateGlobalTuning(v).claudeModel ?? "");
    const authModes = hydrateAuthModes(v);
    setAuthClaude(authModes.claude);
    setAuthCodex(authModes.codex);
    setAuthBaseline(authModes);
  }

  function hydrateTts(v: TtsSettingsView) {
    setTtsView(v);
    setTtsProvider(v.provider ?? "auto");
    setTtsBaseUrl(v.baseUrl ?? "");
    setTtsModel(v.model ?? "");
    setTtsVoice(v.voice ?? "");
  }

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchLlmSettings().then(hydrate).catch(() => {});
    fetchTtsSettings().then(hydrateTts).catch(() => {});
    fetchSecrets().then(setSecrets).catch(() => {});
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
  const endpoint = classifyOpenAiEndpoint(connBaseUrl);

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
        ...buildRolesPayload(nextTargets, nextConn, preferredCloud, tuning, { claudeModel: globalClaudeModel.trim() || null }),
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

  /**
   * 鍵の保存/削除。鍵の有無で認証モードの選択可否（authKeys は view から導出）・TTS「自動」の
   * 解決表示（ttsView.apiKeyConfigured）が変わるため view/ttsView だけを再取得する。
   * hydrate/hydrateTts は呼ばない — 編集中の接続・TTS 入力（未保存）をサーバ値で上書きして
   * 破棄してしまうため（レビュー指摘 2026-07-10）。
   */
  async function onSaveSecret(name: SecretName, value: string): Promise<SecretMutationResult> {
    const baseUrl = name === "OPENAI_COMPAT_API_KEY"
      ? connBaseUrl.trim()
      : name === "TTS_API_KEY"
      ? ttsBaseUrl.trim() || ttsView?.defaults.baseUrl
      : undefined;
    const r = await saveSecret(name, value, baseUrl);
    setSecrets(r.secrets);
    fetchLlmSettings().then(setView).catch(() => {});
    fetchTtsSettings().then(setTtsView).catch(() => {});
    return r;
  }
  async function onDeleteSecret(name: SecretName): Promise<SecretMutationResult> {
    const r = await deleteSecret(name);
    setSecrets(r.secrets);
    fetchLlmSettings().then(setView).catch(() => {});
    fetchTtsSettings().then(setTtsView).catch(() => {});
    return r;
  }
  const secretStr = {
    label: s.settings.secretKeyLabel,
    statusKeychain: s.settings.secretStatusKeychain,
    statusEnv: s.settings.secretStatusEnv,
    statusMissing: s.settings.secretStatusMissing,
    placeholderSet: s.settings.secretPlaceholderSet,
    placeholderNew: s.settings.secretPlaceholderNew,
    save: s.settings.secretSave,
    del: s.settings.secretDelete,
    saved: s.settings.secretSaved,
    deleted: s.settings.secretDeleted,
    approvalRequired: s.settings.secretApprovalRequired,
    saveFailedWithReason: s.llm.saveFailedWithReason,
    notApplied: s.llm.notApplied,
  };

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
        provider: ttsProvider,
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
      hydrateTts(await saveTtsSettings({ provider: "auto", baseUrl: null, model: null, voice: null }));
      setTtsResult(s.llm.applied);
    } catch { setTtsResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  const targetLabels: Record<RoleTarget, string> = {
    claude: s.settings.targetClaude, local: s.settings.targetLocal, codex: s.settings.targetCodex,
  };
  const tierLabels: Record<(typeof SERVICE_TIER_OPTIONS)[number], string> = {
    fast: s.settings.tuningTierFast, standard: s.settings.tuningTierStandard,
  };

  function endpointLine(value: EndpointClassification): string {
    const label = {
      loopback: s.settings.endpointLoopback,
      lan: s.settings.endpointLan,
      remote: s.settings.endpointRemote,
      invalid: s.settings.endpointInvalid,
    }[value.location];
    return value.origin ? `${label} · ${value.origin}` : label;
  }

  /** 用途タブの「実効」サマリ1行を組み立てる（表示専用。判定ロジックは resolveEffective が純関数で担う）。 */
  function effectiveLine(eff: EffectiveResolution): string {
    const providerLabel = targetLabels[eff.provider];
    const modelText = eff.model.confirmed
      ? eff.model.text
      : s.settings.effectiveUnconfirmedWith(eff.model.cliDefault ? s.settings.cliDefaultLabel : eff.model.text);
    const destination = eff.endpoint ? endpointLine(eff.endpoint) : s.settings.endpointCloudManaged;
    const parts = [`${providerLabel} · ${destination} · ${modelText}`];
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
          <div className="llm-fields stack">
            <h3 className="settings-section-title">{s.settings.targetClaude}</h3>
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
            {view?.authModes?.claude === "api-key" && !authKeys.anthropic && (
              <div className="info-pop">{s.settings.claudeAuthMissingKey}</div>
            )}
            <SecretKeyField name="ANTHROPIC_API_KEY" status={secrets?.ANTHROPIC_API_KEY} disabled={saving || !view}
              str={secretStr} onSave={onSaveSecret} onDelete={onDeleteSecret} />
            <div className="text-sm text-muted">{s.settings.authApiKeyNote}</div>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.settings.claudeGlobalModelLabel}</span>
              {(() => {
                const opts = claudeModelSelectOptions(catalog?.claude);
                const known = opts.some((o) => o.value === globalClaudeModel);
                return (
                  <select className="llm-input" value={globalClaudeModel} disabled={saving || !view} onChange={(e) => setGlobalClaudeModel(e.target.value)}>
                    <option value="">{s.settings.tuningDefaultWith("sonnet")}</option>
                    {!known && globalClaudeModel && <option value={globalClaudeModel}>{globalClaudeModel}</option>}
                    {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                );
              })()}
            </label>
            <div className="text-sm text-muted">{s.settings.claudeGlobalModelNote}</div>
          </div>
          <hr className="settings-divider" />
          <div className="llm-fields stack">
            <h3 className="settings-section-title">{s.settings.localConnTitle}</h3>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.baseUrlLabel}</span>
              <input className="llm-input" value={connBaseUrl} placeholder={s.llm.baseUrlPlaceholder} onChange={(e) => setConnBaseUrl(e.target.value)} />
            </label>
            <div className="text-sm text-muted">{s.settings.endpointLabel}: {endpointLine(endpoint)}</div>
            {endpoint.location === "remote" && <div className="info-pop">{s.settings.endpointRemoteDisclosure}</div>}
            {endpoint.location === "lan" && <div className="text-sm text-muted">{s.settings.endpointLanDisclosure}</div>}
            {endpoint.location === "loopback" && <div className="text-sm text-muted">{s.settings.endpointLoopbackDisclosure}</div>}
            {endpoint.location === "invalid" && <div className="text-sm text-muted">{s.settings.endpointInvalidDisclosure}</div>}
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
            <SecretKeyField name="OPENAI_COMPAT_API_KEY" status={secrets?.OPENAI_COMPAT_API_KEY} disabled={saving || !view}
              approvalRequired={Boolean(secrets?.OPENAI_COMPAT_API_KEY.configured && view?.apiKeyApproved !== true)}
              str={secretStr} onSave={onSaveSecret} onDelete={onDeleteSecret} />
          </div>
          <hr className="settings-divider" />
          <div className="llm-fields stack">
            <h3 className="settings-section-title">{s.settings.codexConnTitle}</h3>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.codexModelLabel}</span>
              {(() => {
                const opts = codexModelSelectOptions(catalog?.codex);
                // 「空欄で既定」に実際の既定モデル名（カタログの CLI 既定行）を併記する。カタログ不可時は静的文言へ劣化
                const defaultName = codexDefaultModelLabel(catalog?.codex);
                const emptyLabel = defaultName ? s.llm.codexModelPlaceholderWith(defaultName) : s.llm.codexModelPlaceholder;
                if (opts.length === 0) {
                  return <input className="llm-input" value={connCodex} placeholder={emptyLabel} onChange={(e) => setConnCodex(e.target.value)} />;
                }
                const known = opts.some((o) => o.value === connCodex);
                return (
                  <select className="llm-input" value={connCodex} onChange={(e) => setConnCodex(e.target.value)}>
                    <option value="">{emptyLabel}</option>
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
            <SecretKeyField name="CODEX_API_KEY" status={secrets?.CODEX_API_KEY} disabled={saving || !view}
              str={secretStr} onSave={onSaveSecret} onDelete={onDeleteSecret} />
            <div className="text-sm text-muted">{s.settings.authApiKeyNote}</div>
          </div>
          <div className="text-sm text-muted">{s.llm.help}</div>
          <Button variant="secondary" onClick={() => void persist(targets, conn)} disabled={saving || !view}>{saving ? s.llm.saving : s.settings.saveConnection}</Button>
          {llmResult && <div className="info-pop" role="status">{llmResult}</div>}

          <hr className="settings-divider" />
          <h3 className="settings-section-title">{s.settings.ttsSection}</h3>
          <div className="text-sm text-muted">{s.settings.ttsDesc}</div>
          <div className="llm-fields stack">
            <label className="llm-field">
              <span className="text-sm text-muted">{s.settings.ttsProviderLabel}</span>
              {(() => {
                // 「自動」が今どちらに解決されるかをラベルに併記する（編集中の Base URL でライブに変わる）
                const resolved = ttsAutoResolution(
                  ttsView?.apiKeyApproved ?? false,
                  ttsBaseUrl,
                  ttsView?.defaults.baseUrl ?? "",
                );
                const resolvedLabel = resolved === "say" ? s.settings.ttsProviderShortSay : s.settings.ttsProviderShortHttp;
                return (
                  <select className="llm-input" value={ttsProvider} disabled={saving || !ttsView} onChange={(e) => setTtsProvider(e.target.value as TtsProvider)}>
                    {TTS_PROVIDER_OPTIONS.map((p) => (
                      <option key={p} value={p}>
                        {p === "auto" ? s.settings.ttsProviderAutoWith(resolvedLabel) : p === "say" ? s.settings.ttsProviderSay : s.settings.ttsProviderHttp}
                      </option>
                    ))}
                  </select>
                );
              })()}
            </label>
            <div className="text-sm text-muted">{s.settings.ttsProviderNote}</div>
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
            <SecretKeyField name="TTS_API_KEY" status={secrets?.TTS_API_KEY} disabled={saving || !ttsView}
              approvalRequired={Boolean(secrets?.TTS_API_KEY.configured && ttsView?.apiKeyApproved !== true)}
              str={secretStr} onSave={onSaveSecret} onDelete={onDeleteSecret} />
            <div className="text-sm text-muted">{s.settings.ttsApiKeyOptionalNote}</div>
          </div>
          <Button variant="secondary" onClick={onSaveTts} disabled={saving || !ttsView}>{saving ? s.llm.saving : s.llm.save}</Button>
          <div className="text-sm text-muted">{s.settings.ttsResetDescWith(ttsView?.defaults.model ?? "gpt-4o-mini-tts", ttsView?.defaults.voice ?? "alloy")}</div>
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
                <button className={preferredCloud === "claude" ? "is-active" : ""} disabled={saving} onClick={() => setPreferredCloud("claude")}>{s.settings.targetClaude}</button>
                <button className={preferredCloud === "codex" ? "is-active" : ""} disabled={saving} onClick={() => setPreferredCloud("codex")}>{s.settings.targetCodex}</button>
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
                : CODEX_EFFORT_OPTIONS.map((id) => ({ id }));
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
                              {/* 既定 = global 行（未設定ならコード定数 sonnet）。解決順: ロール別 > global > コード既定 */}
                              <option value="">{s.settings.tuningDefaultWith(globalClaudeModel.trim() || "sonnet")}</option>
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
