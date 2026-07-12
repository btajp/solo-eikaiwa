import { useEffect, useRef, useState } from "react";
import {
  fetchLlmSettings, saveLlmRoleSettings, LLM_ROLES,
  fetchTtsSettings, saveTtsSettings,
  fetchLlmModels,
  EFFORT_OPTIONS, SERVICE_TIER_OPTIONS,
  type LlmRole, type LlmSettingsView, type TtsSettingsView, type RoleTuning, type LlmModelsResponse, type CatalogModelEffort,
  type AuthMode, type LlmAuthProvider, type TtsProvider,
} from "../api";
import { fetchSecrets, saveSecret, deleteSecret, effectiveSecretsView, type SecretName, type SecretsView, type SecretMutationResult } from "../api";
import {
  isLocalDefined, presetTargets, matchPreset, hydrateConnection, hydrateTargets, hydrateTuning,
  hydrateGlobalTuning, hydrateAuthModes, hydrateAuthKeys, buildAuthPatch,
  buildGlobalConnectionPayload, buildRoleAssignmentPayload, buildSavedRoleConnectionPatch, hasSavedLocalRole, hasSavedOpenAiRole,
  defaultTuning, applyRecommendedTuning,
  claudeModelSelectOptions, effortOptionsForClaudeAlias, codexModelSelectOptions, effortOptionsForCodexModel,
  tierOptionsForCodexModel, codexDefaultEffortLabel, codexDefaultModelLabel, localModelSelectOptions, openAiModelSelectOptions, resolveEffective, clampClaudeEffort,
  classifyOpenAiEndpoint, endpointAllowsCredentials, roleTargetAvailability, CODEX_EFFORT_OPTIONS,
  type RoleTarget, type RoleTargets, type Connection, type PresetId, type CloudTarget,
} from "../lib/llm-assignments";
import { loadPreferredCloud, savePreferredCloud } from "../lib/preferred-cloud";
import {
  authDraftChanged, connectionDraftChanged, makeSaveGenerationTracker, mergeAuthSaveView, mergeConnectionSaveView, mergeRolesSaveView,
  rolesDraftChanged, ttsDraftChanged, type ConnectionDraft,
} from "../lib/settings-save-scopes";
import { STR, type Lang } from "../i18n";
import { formatClientError } from "../lib/user-error";
import { Button } from "../ui/Button";
import { useLoad } from "../useLoad";
import { ApiKeysTab } from "./settings/ApiKeysTab";
import { DisplaySettingsTab } from "./settings/DisplaySettingsTab";
import { RoleTargetToggle } from "./settings/RoleTargetToggle";
import { SettingsLoadErrors } from "./settings/SettingsLoadErrors";
import { TtsSettingsPanel } from "./settings/TtsSettingsPanel";
import { effectiveLine, endpointLine } from "./settings/effective-line";

export type UiScale = "small" | "medium" | "large" | "xlarge";
type Props = {
  lang: Lang;
  uiScale: UiScale;
  setUiScale: (s: UiScale) => void;
  switchLang: (l: Lang) => void;
  onHealthChanged: () => void;
};

type SaveState = { phase: "idle" | "saving" | "saved" | "error"; message: string | null };
const IDLE_SAVE: SaveState = { phase: "idle", message: null };
type SettingsTab = "keys" | "conn" | "roles" | "display";
export function SettingsScreen({ lang, uiScale, setUiScale, switchLang, onHealthChanged }: Props) {
  const s = STR[lang];
  const llmSettingsLoad = useLoad(fetchLlmSettings);
  const ttsSettingsLoad = useLoad(fetchTtsSettings);
  const secretsLoad = useLoad(fetchSecrets);
  const [view, setView] = useState<LlmSettingsView | null>(null);
  const [authSave, setAuthSave] = useState<SaveState>(IDLE_SAVE);
  const [connectionSave, setConnectionSave] = useState<SaveState>(IDLE_SAVE);
  const [rolesSave, setRolesSave] = useState<SaveState>(IDLE_SAVE);
  const [ttsSave, setTtsSave] = useState<SaveState>(IDLE_SAVE);
  const [tab, setTab] = useState<SettingsTab>("keys");
  const saveGenerationRef = useRef(makeSaveGenerationTracker());
  // モデルカタログ（GET /api/llm-models）。用途タブを開いたときに遅延取得する（app起動時には叩かない）。
  const [catalog, setCatalog] = useState<LlmModelsResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const catalogFetchedRef = useRef(false);
  const catalogRefreshRequiredRef = useRef(false);
  // プリセット適用時のクラウド枠（課金先）。localStorage永続・既存割当には影響しない。
  const [preferredCloud, setPreferredCloudState] = useState<CloudTarget>(() => loadPreferredCloud());
  function setPreferredCloud(c: CloudTarget) {
    setPreferredCloudState(c);
    savePreferredCloud(c);
  }

  // 接続の編集状態
  const [connBaseUrl, setConnBaseUrl] = useState("");
  const [connModel, setConnModel] = useState("");
  const [connOpenAi, setConnOpenAi] = useState("");
  const [connCodex, setConnCodex] = useState("");
  // ロール割当の編集状態（4値）
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
  // 各保存タブの直近保存済みsnapshot。別タブの編集中値を別scopeの保存で確定しないために使う。
  const [savedConnection, setSavedConnection] = useState<ConnectionDraft | null>(null);
  const [savedAuth, setSavedAuth] = useState<Record<LlmAuthProvider, AuthMode> | null>(null);
  const [savedTargets, setSavedTargets] = useState<RoleTargets | null>(null);
  const [savedTuning, setSavedTuning] = useState<Record<LlmRole, RoleTuning> | null>(null);
  const authKeys = view ? hydrateAuthKeys(view) : { anthropic: false, codex: false };
  // API キーの有無・ソース（値はサーバが返さない）
  const [secrets, setSecrets] = useState<SecretsView | null>(null);
  // 音声（TTS）の編集状態
  const [ttsView, setTtsView] = useState<TtsSettingsView | null>(null);
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("say");
  const [ttsBaseUrl, setTtsBaseUrl] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsVoice, setTtsVoice] = useState("");
  const [ttsOpenAiModel, setTtsOpenAiModel] = useState("");
  const [ttsOpenAiVoice, setTtsOpenAiVoice] = useState("");

  function hydrateInitial(v: LlmSettingsView) {
    setView(v);
    const conn = hydrateConnection(v);
    setConnBaseUrl(conn.baseUrl);
    setConnModel(conn.model);
    setConnOpenAi(conn.openaiModel ?? "");
    setConnCodex(conn.codexModel);
    setTargets(hydrateTargets(v));
    setTuning(hydrateTuning(v));
    setGlobalClaudeModel(hydrateGlobalTuning(v).claudeModel ?? "");
    const authModes = hydrateAuthModes(v);
    setAuthClaude(authModes.claude);
    setAuthCodex(authModes.codex);
    setSavedConnection({
      connection: conn,
      globalClaudeModel: hydrateGlobalTuning(v).claudeModel ?? "",
    });
    setSavedAuth(authModes);
    setSavedTargets(hydrateTargets(v));
    setSavedTuning(hydrateTuning(v));
  }

  function hydrateTts(v: TtsSettingsView) {
    setTtsView(v);
    setTtsProvider(v.provider ?? "say");
    setTtsBaseUrl(v.baseUrl ?? "");
    setTtsModel(v.model ?? "");
    setTtsVoice(v.voice ?? "");
    setTtsOpenAiModel(v.openaiModel ?? "");
    setTtsOpenAiVoice(v.openaiVoice ?? "");
  }

  useEffect(() => {
    if (llmSettingsLoad.state.status === "ready") hydrateInitial(llmSettingsLoad.state.data);
  }, [llmSettingsLoad.state]);

  useEffect(() => {
    if (ttsSettingsLoad.state.status === "ready") hydrateTts(ttsSettingsLoad.state.data);
  }, [ttsSettingsLoad.state]);

  useEffect(() => {
    if (secretsLoad.state.status === "ready") setSecrets(secretsLoad.state.data);
  }, [secretsLoad.state]);

  /** refresh=true は「モデル一覧を更新」ボタン用（?refresh=1）。失敗は fail-quiet — カタログは
   * null のままとなり、選択肢・実効表示は静的フォールバック/「実体未確認」へ劣化する（嘘の表示をしない）。 */
  function refreshCatalog(refresh: boolean) {
    const forceRefresh = refresh || catalogRefreshRequiredRef.current;
    catalogRefreshRequiredRef.current = false;
    setCatalogLoading(true);
    fetchLlmModels(forceRefresh)
      .then(setCatalog)
      .catch(() => {})
      .finally(() => setCatalogLoading(false));
  }

  useEffect(() => {
    // 接続タブ・用途タブのどちらもモデル一覧を使うため、先に開いた方が一度だけ取得する。
    // APIキー・表示タブでは不要なので取得しない。
    if (tab === "display" || tab === "keys" || catalogFetchedRef.current) return;
    catalogFetchedRef.current = true;
    refreshCatalog(false);
  }, [tab]);

  const conn: Connection = { baseUrl: connBaseUrl, model: connModel, openaiModel: connOpenAi, codexModel: connCodex };
  const savedRoleConnection = savedConnection?.connection ?? conn;
  const endpoint = classifyOpenAiEndpoint(connBaseUrl);
  const availability = view
    ? roleTargetAvailability(view, savedRoleConnection)
    : {
        claude: { available: false, reason: "authentication" as const },
        openai: { available: false, reason: "authentication" as const },
        local: { available: false, reason: "connection" as const },
        codex: { available: false, reason: "authentication" as const },
      };
  const selectedTargetsAvailable = LLM_ROLES.every((role) => availability[targets[role]].available);
  const compatKeyTarget = savedConnection?.connection.baseUrl.trim() || null;
  const ttsKeyTarget = ttsView?.baseUrl?.trim() || "";

  const connectionDraft: ConnectionDraft = {
    connection: conn,
    globalClaudeModel,
  };
  const authDraft: Record<LlmAuthProvider, AuthMode> = { claude: authClaude, codex: authCodex };
  const connectionDirty = savedConnection !== null && connectionDraftChanged(savedConnection, connectionDraft);
  const authDirty = savedAuth !== null && authDraftChanged(savedAuth, authDraft);
  const rolesDirty = savedTargets !== null && savedTuning !== null
    && rolesDraftChanged(savedTargets, targets, savedTuning, tuning);
  const ttsDirty = ttsDraftChanged(
    ttsView, ttsProvider, ttsBaseUrl, ttsModel, ttsVoice, ttsOpenAiModel, ttsOpenAiVoice,
  );
  const connectionSaving = connectionSave.phase === "saving";
  const authSaving = authSave.phase === "saving";
  const rolesSaving = rolesSave.phase === "saving";
  const ttsSaving = ttsSave.phase === "saving";
  // 接続保存は保存済みの接続依存ロールも更新するため、別scopeを同時に保存させない。
  // タブ移動で pending state を消すと古い応答が後から入力を戻し得るので、設定全体を一時ロックする。
  const settingsSaving = connectionSaving || authSaving || rolesSaving || ttsSaving;

  function appliedMessage(v: LlmSettingsView): string {
    return v.applied === false
      ? s.llm.notApplied(formatClientError(lang, v.error ?? "settings apply failed", "apply"))
      : s.llm.applied;
  }

  function markConnectionEdited() {
    if (!connectionSaving) setConnectionSave(IDLE_SAVE);
  }

  function markRolesEdited() {
    if (!rolesSaving) setRolesSave(IDLE_SAVE);
  }

  function markTtsEdited() {
    if (!ttsSaving) setTtsSave(IDLE_SAVE);
  }

  function switchSettingsTab(next: SettingsTab) {
    if (settingsSaving) return;
    setTab(next);
    setAuthSave(IDLE_SAVE);
    setConnectionSave(IDLE_SAVE);
    setRolesSave(IDLE_SAVE);
    setTtsSave(IDLE_SAVE);
  }

  async function saveConnection() {
    if (!view) return;
    if (!isLocalDefined(conn) && hasSavedLocalRole(view.roles)) {
      setConnectionSave({ phase: "error", message: s.settings.localRoleConnectionRequired });
      return;
    }
    if (!(conn.openaiModel ?? "").trim() && hasSavedOpenAiRole(view.roles)) {
      setConnectionSave({ phase: "error", message: s.settings.openAiRoleConnectionRequired });
      return;
    }
    const generation = saveGenerationRef.current.begin("connection");
    setConnectionSave({ phase: "saving", message: null });
    try {
      // 接続変更で既に保存済みのローカル/Codex割当が古い接続先を参照し続けないよう、
      // 接続依存の保存済みロールだけを同じ接続で更新する。編集中の割当/tuningは送らない。
      const roles = buildSavedRoleConnectionPatch(view.roles, conn);
      const saved = await saveLlmRoleSettings({
        global: buildGlobalConnectionPayload(conn, view.provider),
        roles,
        tuning: { global: { claudeModel: globalClaudeModel.trim() || null } },
      });
      if (!saveGenerationRef.current.isCurrent("connection", generation)) return;
      const nextConnection = hydrateConnection(saved);
      const nextGlobalModel = hydrateGlobalTuning(saved).claudeModel ?? "";
      setView((current) => mergeConnectionSaveView(current, saved));
      setConnBaseUrl(nextConnection.baseUrl);
      setConnModel(nextConnection.model);
      setConnOpenAi(nextConnection.openaiModel ?? "");
      setConnCodex(nextConnection.codexModel);
      setGlobalClaudeModel(nextGlobalModel);
      setSavedConnection({ connection: nextConnection, globalClaudeModel: nextGlobalModel });
      setConnectionSave({ phase: saved.applied === false ? "error" : "saved", message: appliedMessage(saved) });
      catalogFetchedRef.current = true;
      refreshCatalog(true);
      onHealthChanged();
    } catch (err) {
      if (!saveGenerationRef.current.isCurrent("connection", generation)) return;
      setConnectionSave({ phase: "error", message: formatClientError(lang, err, "save") });
    }
  }

  async function saveAuthentication() {
    if (!view || !savedAuth) return;
    const patch = buildAuthPatch(savedAuth, authDraft);
    if (!patch) return;
    const generation = saveGenerationRef.current.begin("auth");
    setAuthSave({ phase: "saving", message: null });
    try {
      const saved = await saveLlmRoleSettings({ auth: patch });
      if (!saveGenerationRef.current.isCurrent("auth", generation)) return;
      const nextAuth = hydrateAuthModes(saved);
      setView((current) => mergeAuthSaveView(current, saved));
      setAuthClaude(nextAuth.claude);
      setAuthCodex(nextAuth.codex);
      setSavedAuth(nextAuth);
      catalogFetchedRef.current = false;
      catalogRefreshRequiredRef.current = true;
      setCatalog(null);
      setAuthSave({ phase: saved.applied === false ? "error" : "saved", message: appliedMessage(saved) });
      onHealthChanged();
    } catch (err) {
      if (!saveGenerationRef.current.isCurrent("auth", generation)) return;
      setAuthSave({ phase: "error", message: formatClientError(lang, err, "save") });
    }
  }

  async function saveRoles() {
    if (!view || !savedConnection || connectionDirty || authDirty || !selectedTargetsAvailable) return;
    const generation = saveGenerationRef.current.begin("roles");
    setRolesSave({ phase: "saving", message: null });
    try {
      // 用途タブは、直近保存済みの接続だけでロールを直列化する。
      // 接続タブで書きかけた値はここからDBへ送らない。
      const saved = await saveLlmRoleSettings(buildRoleAssignmentPayload(targets, savedConnection.connection, preferredCloud, tuning));
      if (!saveGenerationRef.current.isCurrent("roles", generation)) return;
      const nextTargets = hydrateTargets(saved);
      const nextTuning = hydrateTuning(saved);
      setView((current) => mergeRolesSaveView(current, saved));
      setTargets(nextTargets);
      setTuning(nextTuning);
      setSavedTargets(nextTargets);
      setSavedTuning(nextTuning);
      setRolesSave({ phase: saved.applied === false ? "error" : "saved", message: appliedMessage(saved) });
      onHealthChanged();
    } catch (err) {
      if (!saveGenerationRef.current.isCurrent("roles", generation)) return;
      setRolesSave({ phase: "error", message: formatClientError(lang, err, "save") });
    }
  }

  function applyPreset(id: PresetId) {
    setTargets(presetTargets(id, preferredCloud));
    markRolesEdited();
  }

  function setTarget(role: LlmRole, t: RoleTarget) {
    setTargets((prev) => ({ ...prev, [role]: t }));
    markRolesEdited();
  }

  function setTuningField<K extends keyof RoleTuning>(role: LlmRole, field: K, value: RoleTuning[K]) {
    setTuning((prev) => ({ ...prev, [role]: { ...prev[role], [field]: value } }));
    markRolesEdited();
  }

  /**
   * 鍵の保存/削除。鍵の有無で認証モード・OpenAI公式・remote互換接続の選択可否が変わるため、
   * view/ttsViewだけを再取得する。
   * hydrate/hydrateTts は呼ばない — 編集中の接続・TTS 入力（未保存）をサーバ値で上書きして
   * 破棄してしまうため（レビュー指摘 2026-07-10）。
   */
  async function onSaveSecret(name: SecretName, value: string): Promise<SecretMutationResult> {
    const baseUrl = name === "OPENAI_COMPAT_API_KEY"
      ? savedConnection?.connection.baseUrl.trim()
      : name === "TTS_API_KEY"
      ? ttsView?.baseUrl?.trim()
      : undefined;
    const r = await saveSecret(name, value, baseUrl);
    setSecrets(r.secrets);
    if (name !== "TTS_API_KEY") {
      catalogFetchedRef.current = false;
      catalogRefreshRequiredRef.current = true;
      setCatalog(null);
    }
    onHealthChanged();
    fetchLlmSettings().then(setView).catch(() => {});
    fetchTtsSettings().then(setTtsView).catch(() => {});
    return r;
  }
  async function onDeleteSecret(name: SecretName): Promise<SecretMutationResult> {
    const r = await deleteSecret(name);
    setSecrets(r.secrets);
    if (name !== "TTS_API_KEY") {
      catalogFetchedRef.current = false;
      catalogRefreshRequiredRef.current = true;
      setCatalog(null);
    }
    onHealthChanged();
    fetchLlmSettings().then(setView).catch(() => {});
    fetchTtsSettings().then(setTtsView).catch(() => {});
    return r;
  }
  async function onSaveTts() {
    if (!ttsView) return;
    const generation = saveGenerationRef.current.begin("tts");
    setTtsSave({ phase: "saving", message: null });
    try {
      const saved = await saveTtsSettings({
        provider: ttsProvider,
        baseUrl: ttsBaseUrl.trim() || null,
        model: ttsModel.trim() || null,
        voice: ttsVoice.trim() || null,
        openaiModel: ttsOpenAiModel.trim() || null,
        openaiVoice: ttsOpenAiVoice.trim() || null,
      });
      if (!saveGenerationRef.current.isCurrent("tts", generation)) return;
      hydrateTts(saved);
      setTtsSave({ phase: "saved", message: s.llm.applied });
      onHealthChanged();
    } catch (err) {
      if (!saveGenerationRef.current.isCurrent("tts", generation)) return;
      setTtsSave({ phase: "error", message: formatClientError(lang, err, "save") });
    }
  }

  function stageResetTts() {
    const changed = ttsProvider !== "say" || ttsBaseUrl !== "" || ttsModel !== "" || ttsVoice !== ""
      || ttsOpenAiModel !== "" || ttsOpenAiVoice !== "";
    setTtsProvider("say");
    setTtsBaseUrl("");
    setTtsModel("");
    setTtsVoice("");
    setTtsOpenAiModel("");
    setTtsOpenAiVoice("");
    setTtsSave(changed ? { phase: "idle", message: s.settings.ttsResetStaged } : IDLE_SAVE);
  }

  const targetLabels: Record<RoleTarget, string> = {
    claude: s.settings.targetClaude, openai: s.settings.targetOpenAi,
    local: s.settings.targetLocal, codex: s.settings.targetCodex,
  };
  const tierLabels: Record<(typeof SERVICE_TIER_OPTIONS)[number], string> = {
    fast: s.settings.tuningTierFast, standard: s.settings.tuningTierStandard,
  };
  const apiKeysLoading = llmSettingsLoad.state.status === "loading" || ttsSettingsLoad.state.status === "loading" || secretsLoad.state.status === "loading";

  return (
    <div className="stack">
      <div className="hero">
        <h2 className="hero-title">{s.settings.title}</h2>
      </div>

      <div className="lang-toggle settings-tabs" role="tablist" aria-label={s.settings.title}>
        <button role="tab" aria-selected={tab === "keys"} className={tab === "keys" ? "is-active" : ""} disabled={settingsSaving} onClick={() => switchSettingsTab("keys")}>{s.settings.apiKeysSection}</button>
        <button role="tab" aria-selected={tab === "conn"} className={tab === "conn" ? "is-active" : ""} disabled={settingsSaving} onClick={() => switchSettingsTab("conn")}>{s.settings.connectionSection}</button>
        <button role="tab" aria-selected={tab === "roles"} className={tab === "roles" ? "is-active" : ""} disabled={settingsSaving} onClick={() => switchSettingsTab("roles")}>{s.settings.roleAssignSection}</button>
        <button role="tab" aria-selected={tab === "display"} className={tab === "display" ? "is-active" : ""} disabled={settingsSaving} onClick={() => switchSettingsTab("display")}>{s.settings.displaySection}</button>
      </div>

      <SettingsLoadErrors
        lang={lang}
        llmError={llmSettingsLoad.state.status === "error" ? llmSettingsLoad.state.error : null}
        ttsError={ttsSettingsLoad.state.status === "error" ? ttsSettingsLoad.state.error : null}
        secretsError={secretsLoad.state.status === "error" ? secretsLoad.state.error : null}
        reloadLlm={llmSettingsLoad.reload}
        reloadTts={ttsSettingsLoad.reload}
        reloadSecrets={secretsLoad.reload}
      />

      {tab === "keys" && apiKeysLoading && (
        <section className="support-panel stack"><div className="text-sm text-muted">{s.settings.loading}</div></section>
      )}

      {tab === "keys" && view && ttsView && secretsLoad.state.status === "ready" && secrets && (
        <ApiKeysTab
          lang={lang}
          disabled={settingsSaving || !view}
          secretsReady={secretsLoad.state.status === "ready"}
          secrets={effectiveSecretsView(secrets, Boolean(view.openAiKeyConfigured || ttsView.openAiKeyConfigured))}
          auth={authDraft}
          authKeys={authKeys}
          authDirty={authDirty}
          authSaving={authSaving}
          authMessage={authSave.message}
          compatTarget={compatKeyTarget}
          compatRemote={Boolean(compatKeyTarget && classifyOpenAiEndpoint(compatKeyTarget).location === "remote")}
          compatKeyAllowed={Boolean(compatKeyTarget && endpointAllowsCredentials(compatKeyTarget))}
          compatKeyApproved={view?.apiKeyApproved === true}
          ttsTarget={ttsKeyTarget}
          ttsKeyAllowed={endpointAllowsCredentials(ttsKeyTarget)}
          ttsKeyApproved={ttsView?.apiKeyApproved === true}
          onAuthChange={(provider, mode) => {
            if (provider === "claude") setAuthClaude(mode);
            else setAuthCodex(mode);
            setAuthSave(IDLE_SAVE);
          }}
          onSaveAuth={() => void saveAuthentication()}
          onSaveSecret={onSaveSecret}
          onDeleteSecret={onDeleteSecret}
        />
      )}

      {tab === "conn" && (
        <section className="support-panel stack">
          <div className="llm-fields stack">
            <h3 className="settings-section-title">{s.settings.targetClaude}</h3>
            <div className="text-sm text-muted">{s.settings.claudeNoSetup}</div>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.settings.claudeGlobalModelLabel}</span>
              {(() => {
                const opts = claudeModelSelectOptions(catalog?.claude);
                const known = opts.some((o) => o.value === globalClaudeModel);
                return (
                  <select className="llm-input" value={globalClaudeModel} disabled={settingsSaving || !view} onChange={(e) => { setGlobalClaudeModel(e.target.value); markConnectionEdited(); }}>
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
            <h3 className="settings-section-title">{s.settings.targetOpenAi}</h3>
            <div className="text-sm text-muted">{s.settings.openAiConnNote}</div>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.modelLabel}</span>
              {(() => {
                const opts = openAiModelSelectOptions(catalog?.openai);
                return (
                  <>
                    <input className="llm-input" list="openai-conversation-models" value={connOpenAi} placeholder="gpt-4.1-mini" disabled={settingsSaving || !view} onChange={(e) => { setConnOpenAi(e.target.value); markConnectionEdited(); }} />
                    <datalist id="openai-conversation-models">{opts.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</datalist>
                  </>
                );
              })()}
            </label>
          </div>
          <hr className="settings-divider" />
          <div className="llm-fields stack">
            <h3 className="settings-section-title">{s.settings.localConnTitle}</h3>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.baseUrlLabel}</span>
              <input className="llm-input" value={connBaseUrl} placeholder={s.llm.baseUrlPlaceholder} disabled={settingsSaving || !view} onChange={(e) => { setConnBaseUrl(e.target.value); markConnectionEdited(); }} />
            </label>
            <div className="text-sm text-muted">{s.settings.endpointLabel}: {endpointLine(lang, endpoint)}</div>
            {endpoint.location === "remote" && <div className="info-pop">{s.settings.endpointRemoteDisclosure}</div>}
            {endpoint.location === "lan" && <div className="text-sm text-muted">{s.settings.endpointLanDisclosure}</div>}
            {endpoint.location === "loopback" && <div className="text-sm text-muted">{s.settings.endpointLoopbackDisclosure}</div>}
            {endpoint.location === "invalid" && <div className="text-sm text-muted">{s.settings.endpointInvalidDisclosure}</div>}
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.modelLabel}</span>
              {(() => {
                const opts = localModelSelectOptions(catalog?.local);
                if (opts.length === 0) {
                  return <input className="llm-input" value={connModel} placeholder={s.llm.modelPlaceholder} disabled={settingsSaving || !view} onChange={(e) => { setConnModel(e.target.value); markConnectionEdited(); }} />;
                }
                const known = opts.some((o) => o.value === connModel);
                return (
                  <select className="llm-input" value={connModel} disabled={settingsSaving || !view} onChange={(e) => { setConnModel(e.target.value); markConnectionEdited(); }}>
                    <option value="">{s.llm.modelPlaceholder}</option>
                    {!known && connModel && <option value={connModel}>{connModel}</option>}
                    {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                );
              })()}
            </label>
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
                  return <input className="llm-input" value={connCodex} placeholder={emptyLabel} disabled={settingsSaving || !view} onChange={(e) => { setConnCodex(e.target.value); markConnectionEdited(); }} />;
                }
                const known = opts.some((o) => o.value === connCodex);
                return (
                  <select className="llm-input" value={connCodex} disabled={settingsSaving || !view} onChange={(e) => { setConnCodex(e.target.value); markConnectionEdited(); }}>
                    <option value="">{emptyLabel}</option>
                    {!known && connCodex && <option value={connCodex}>{connCodex}</option>}
                    {opts.map((o) => (
                      <option key={o.value} value={o.value}>{o.isDefault ? s.settings.cliDefaultBadgeWith(o.label) : o.label}</option>
                    ))}
                  </select>
                );
              })()}
            </label>
          </div>
          <div className="text-sm text-muted">{s.llm.help}</div>
          <div className="text-sm text-muted">{s.settings.connectionSaveNote}</div>
          <Button variant="primary" loading={connectionSaving} onClick={() => void saveConnection()} disabled={settingsSaving || !view || !connectionDirty}>
            {connectionSaving ? s.llm.saving : s.settings.saveConnection}
          </Button>
          {connectionDirty && <div className="info-pop" role="status">{s.settings.unsavedChanges}</div>}
          {connectionSave.message && <div className="info-pop" role="status">{connectionSave.message}</div>}

          <TtsSettingsPanel
            lang={lang}
            view={ttsView}
            provider={ttsProvider}
            baseUrl={ttsBaseUrl}
            model={ttsModel}
            voice={ttsVoice}
            openaiModel={ttsOpenAiModel}
            openaiVoice={ttsOpenAiVoice}
            disabled={settingsSaving}
            saving={ttsSaving}
            dirty={ttsDirty}
            message={ttsSave.message}
            onProviderChange={(value) => { setTtsProvider(value); markTtsEdited(); }}
            onBaseUrlChange={(value) => { setTtsBaseUrl(value); markTtsEdited(); }}
            onModelChange={(value) => { setTtsModel(value); markTtsEdited(); }}
            onVoiceChange={(value) => { setTtsVoice(value); markTtsEdited(); }}
            onOpenAiModelChange={(value) => { setTtsOpenAiModel(value); markTtsEdited(); }}
            onOpenAiVoiceChange={(value) => { setTtsOpenAiVoice(value); markTtsEdited(); }}
            onSave={() => void onSaveTts()}
            onReset={stageResetTts}
          />
        </section>
      )}

      {tab === "roles" && (
        <section className="support-panel stack">
          <div className="info-pop">{s.settings.roleQualityNote}</div>

          {/* モデルカタログ（用途タブを開いた時点で遅延取得済み）の手動再取得 */}
          <div className="stack">
            <Button variant="secondary" onClick={() => refreshCatalog(true)} disabled={settingsSaving || catalogLoading}>
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
                <button className={preferredCloud === "claude" ? "is-active" : ""} aria-pressed={preferredCloud === "claude"} disabled={settingsSaving || !availability.claude.available} onClick={() => setPreferredCloud("claude")}>{s.settings.targetClaude}</button>
                <button className={preferredCloud === "openai" ? "is-active" : ""} aria-pressed={preferredCloud === "openai"} disabled={settingsSaving || !availability.openai.available} onClick={() => setPreferredCloud("openai")}>{s.settings.targetOpenAi}</button>
                <button className={preferredCloud === "codex" ? "is-active" : ""} aria-pressed={preferredCloud === "codex"} disabled={settingsSaving || !availability.codex.available} onClick={() => setPreferredCloud("codex")}>{s.settings.targetCodex}</button>
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
                    className="llm-input" value={current} disabled={settingsSaving || !view}
                    aria-label={s.settings.presetSection}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "all-local" || v === "balanced" || v === "high-quality") applyPreset(v);
                    }}
                  >
                    {current === "custom" && <option value="custom" disabled>{s.settings.presetCustom}</option>}
                    <option value="all-local" disabled={!availability.local.available}>{s.settings.presetAllLocal}</option>
                    <option value="balanced" disabled={!availability.local.available || !availability[preferredCloud].available}>{s.settings.presetBalancedOption}</option>
                    <option value="high-quality" disabled={!availability[preferredCloud].available}>{s.settings.presetHighQuality}</option>
                  </select>
                  {current === "all-local" && <div className="text-sm text-muted">{s.settings.presetAllLocalDesc}</div>}
                  {m !== "custom" && current === "balanced" && <div className="text-sm text-muted">{s.settings.presetBalancedDesc(m.cloud)}</div>}
                  {m !== "custom" && current === "high-quality" && <div className="text-sm text-muted">{s.settings.presetHighQualityDesc(m.cloud)}</div>}
                  <div className="text-sm text-muted">{s.settings.presetSaveNote}</div>
                  {!availability.local.available && <div className="text-sm text-muted">{s.settings.presetLocalRequired}</div>}
                </>
              );
            })()}
          </div>

          {/* 推奨チューニングのワンタップ適用（クラウド割当ロールのみ書き換え・保存はしない） */}
          <div className="stack">
            <Button
              variant="secondary"
              onClick={() => { setTuning(applyRecommendedTuning(tuning, targets)); markRolesEdited(); }}
              disabled={settingsSaving || !view || !selectedTargetsAvailable}
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
              const targetAvailable = availability[targets[role]].available;
              return (
                <div key={role} className="stack">
                  <div className="text-sm">{s.settings.roleName[role]}</div>
                  <div className="text-sm text-muted">{s.settings.roleDesc[role]}</div>
                  <div className="text-sm text-muted">{s.settings.roleReason[role]}</div>
                  <RoleTargetToggle
                    value={targets[role]}
                    availability={availability}
                    labels={targetLabels}
                    unavailableNote={s.settings.targetUnavailableNote}
                    ariaLabel={s.settings.roleName[role]}
                    disabled={settingsSaving || !view}
                    onChange={(t) => setTarget(role, t)}
                  />
                  {/* 実効サマリ（常時表示）: 現在この用途で実際に使われているプロバイダ・具体モデル・effort・配信 */}
                  {effective && <div className="text-sm text-muted">{effectiveLine(lang, effective)}</div>}
                  {/* ローカル割当は openai-compat 経路が tuning（model/effort/serviceTier）を完全に無視するため
                      （llm-provider.ts の selectRunner・README にも明記）、詳細設定自体を出さない
                      （出しても中身が空になる＝意味のない disclosure を見せない） */}
                  {(targets[role] === "claude" || targets[role] === "codex") && (
                    <details className="stack">
                      <summary className="text-sm text-muted">{s.settings.tuningDetails}</summary>
                      <div className="stack">
                        {targets[role] === "claude" && (
                          <label className="llm-field">
                            <span className="text-sm text-muted">{s.settings.tuningModel}</span>
                            <select
                              className="llm-input"
                              value={tuning[role].claudeModel ?? ""}
                              disabled={settingsSaving || !view || !targetAvailable}
                              onChange={(e) => {
                                const newAlias = (e.target.value || null) as RoleTuning["claudeModel"];
                                // モデル切替で選択中の effort が新モデルで無効化される場合（実測: 非対応 effort は
                                // 黙って無視される）、UI 上に「効かない値」を残さないよう同じ更新で null にクランプする。
                                const clampedEffort = clampClaudeEffort(catalogClaude, newAlias ?? "sonnet", tuning[role].effort) as RoleTuning["effort"];
                                setTuning((prev) => ({ ...prev, [role]: { ...prev[role], claudeModel: newAlias, effort: clampedEffort } }));
                                markRolesEdited();
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
                            disabled={settingsSaving || !view || !targetAvailable}
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
                              disabled={settingsSaving || !view || !targetAvailable}
                              onChange={(e) => setTuningField(role, "serviceTier", (e.target.value || null) as RoleTuning["serviceTier"])}
                            >
                              <option value="">{s.settings.tuningDefaultWith(tierLabels.fast)}</option>
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
            <div className="text-sm text-muted">{s.settings.rolesSaveNote}</div>
            {connectionDirty && <div className="info-pop">{s.settings.saveConnectionFirst}</div>}
            {authDirty && <div className="info-pop">{s.settings.saveAuthFirst}</div>}
            {!selectedTargetsAvailable && <div className="info-pop">{s.settings.selectedTargetUnavailable}</div>}
            <Button variant="primary" loading={rolesSaving} onClick={() => void saveRoles()} disabled={settingsSaving || !view || !rolesDirty || connectionDirty || authDirty || !selectedTargetsAvailable}>
              {rolesSaving ? s.llm.saving : s.settings.saveAssignments}
            </Button>
          </div>

          {rolesDirty && <div className="info-pop" role="status">{s.settings.unsavedChanges}</div>}
          {rolesSave.message && <div className="info-pop" role="status">{rolesSave.message}</div>}
        </section>
      )}

      {tab === "display" && (
        <DisplaySettingsTab lang={lang} uiScale={uiScale} setUiScale={setUiScale} switchLang={switchLang} />
      )}
    </div>
  );
}
