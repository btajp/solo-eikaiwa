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
  buildGlobalConnectionPayload, buildRoleAssignmentPayload, buildSavedRoleConnectionPatch, hasSavedLocalRole,
  defaultTuning, applyRecommendedTuning,
  claudeModelSelectOptions, effortOptionsForClaudeAlias, codexModelSelectOptions, effortOptionsForCodexModel,
  tierOptionsForCodexModel, codexDefaultEffortLabel, codexDefaultModelLabel, localModelSelectOptions, resolveEffective, clampClaudeEffort,
  classifyOpenAiEndpoint, CODEX_EFFORT_OPTIONS,
  type RoleTarget, type RoleTargets, type Connection, type PresetId, type CloudTarget, type EffectiveResolution,
  type EndpointClassification,
} from "../lib/llm-assignments";
import { loadPreferredCloud, savePreferredCloud } from "../lib/preferred-cloud";
import {
  connectionDraftChanged, makeLatestGeneration, makeSaveGenerationTracker, mergeConnectionSaveView, mergeRolesSaveView,
  rolesDraftChanged, ttsDraftChanged, type ConnectionDraft,
} from "../lib/settings-save-scopes";
import { ttsAutoResolution } from "../lib/tts-resolution";
import { STR, type Lang } from "../i18n";
import { Button } from "../ui/Button";
import { Banner } from "../ui/Banner";
import { useLoad } from "../useLoad";

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
    deleteConfirm: string; saving: string; deleting: string;
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
  const [busyAction, setBusyAction] = useState<"save" | "delete" | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const generationRef = useRef(makeLatestGeneration());
  const busy = busyAction !== null;
  const st = props.status;
  const statusText = st?.configured
    ? st.source === "keychain" ? props.str.statusKeychain : props.str.statusEnv
    : props.str.statusMissing;

  async function run(kind: "save" | "delete", action: () => Promise<SecretMutationResult>, doneMsg: string) {
    const generation = generationRef.current.begin();
    setResult(null);
    setBusyAction(kind);
    try {
      const r = await action();
      if (!generationRef.current.isCurrent(generation)) return;
      setValue("");
      // 保存自体は成功しても実行中プロセスへの適用に失敗した場合（applied:false）は、
      // 「保存し、適用しました」と嘘をつかずに理由つきで情報表示する（UI 真実性）。
      setResult(r.applied === false ? props.str.notApplied(r.error ?? "") : doneMsg);
    } catch (err) {
      if (!generationRef.current.isCurrent(generation)) return;
      const reason = err instanceof Error ? err.message : String(err);
      setResult(props.str.saveFailedWithReason(reason));
    } finally {
      if (generationRef.current.isCurrent(generation)) setBusyAction(null);
    }
  }

  return (
    <div className="llm-field" aria-busy={busy || undefined}>
      <span className="text-sm text-muted">{props.str.label} — {statusText}</span>
      <div className="secret-key-row">
        <input
          className="llm-input"
          type="password"
          autoComplete="off"
          value={value}
          placeholder={st?.configured ? props.str.placeholderSet : props.str.placeholderNew}
          disabled={props.disabled || busy}
          onChange={(e) => { setValue(e.target.value); setDeleteConfirm(false); }}
        />
        <Button variant="primary" loading={busyAction === "save"} disabled={props.disabled || busy || value.trim().length === 0}
          onClick={() => void run("save", () => props.onSave(props.name, value.trim()), props.str.saved)}>
          {busyAction === "save" ? props.str.saving : props.str.save}
        </Button>
        {st?.source === "keychain" && (
          <Button variant={deleteConfirm ? "danger" : "secondary"} loading={busyAction === "delete"} disabled={props.disabled || busy}
            onClick={() => {
              if (!deleteConfirm) { setDeleteConfirm(true); return; }
              setDeleteConfirm(false);
              void run("delete", () => props.onDelete(props.name), props.str.deleted);
            }}>
            {busyAction === "delete" ? props.str.deleting : deleteConfirm ? props.str.deleteConfirm : props.str.del}
          </Button>
        )}
      </div>
      {result && <div className="info-pop" role="status">{result}</div>}
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
            aria-pressed={props.value === t}
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

export function SettingsScreen({ lang, uiScale, setUiScale, switchLang, onHealthChanged }: Props) {
  const s = STR[lang];
  const llmSettingsLoad = useLoad(fetchLlmSettings);
  const ttsSettingsLoad = useLoad(fetchTtsSettings);
  const secretsLoad = useLoad(fetchSecrets);
  const [view, setView] = useState<LlmSettingsView | null>(null);
  const [connectionSave, setConnectionSave] = useState<SaveState>(IDLE_SAVE);
  const [rolesSave, setRolesSave] = useState<SaveState>(IDLE_SAVE);
  const [ttsSave, setTtsSave] = useState<SaveState>(IDLE_SAVE);
  const [tab, setTab] = useState<"conn" | "roles" | "display">("conn");
  const saveGenerationRef = useRef(makeSaveGenerationTracker());
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
  // 各保存タブの直近保存済みsnapshot。別タブの編集中値を別scopeの保存で確定しないために使う。
  const [savedConnection, setSavedConnection] = useState<ConnectionDraft | null>(null);
  const [savedTargets, setSavedTargets] = useState<RoleTargets | null>(null);
  const [savedTuning, setSavedTuning] = useState<Record<LlmRole, RoleTuning> | null>(null);
  const authKeys = view ? hydrateAuthKeys(view) : { anthropic: false, codex: false };
  // API キーの有無・ソース（値はサーバが返さない）
  const [secrets, setSecrets] = useState<SecretsView | null>(null);
  // 音声（TTS）の編集状態
  const [ttsView, setTtsView] = useState<TtsSettingsView | null>(null);
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("auto");
  const [ttsBaseUrl, setTtsBaseUrl] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsVoice, setTtsVoice] = useState("");
  const voiceInputRef = useRef<HTMLInputElement | null>(null);

  function hydrateInitial(v: LlmSettingsView) {
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
    setSavedConnection({
      connection: conn,
      globalClaudeModel: hydrateGlobalTuning(v).claudeModel ?? "",
      auth: authModes,
    });
    setSavedTargets(hydrateTargets(v));
    setSavedTuning(hydrateTuning(v));
  }

  function hydrateTts(v: TtsSettingsView) {
    setTtsView(v);
    setTtsProvider(v.provider ?? "auto");
    setTtsBaseUrl(v.baseUrl ?? "");
    setTtsModel(v.model ?? "");
    setTtsVoice(v.voice ?? "");
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
  const savedRoleConnection = savedConnection?.connection ?? conn;
  const localDefined = isLocalDefined(savedRoleConnection);
  const endpoint = classifyOpenAiEndpoint(connBaseUrl);

  const connectionDraft: ConnectionDraft = {
    connection: conn,
    globalClaudeModel,
    auth: { claude: authClaude, codex: authCodex },
  };
  const connectionDirty = connectionDraftChanged(savedConnection, connectionDraft);
  const authModeDirty = savedConnection !== null
    && (savedConnection.auth.claude !== authClaude || savedConnection.auth.codex !== authCodex);
  const rolesDirty = rolesDraftChanged(savedTargets, targets, savedTuning, tuning);
  const ttsDirty = ttsDraftChanged(ttsView, ttsProvider, ttsBaseUrl, ttsModel, ttsVoice);
  const connectionSaving = connectionSave.phase === "saving";
  const rolesSaving = rolesSave.phase === "saving";
  const ttsSaving = ttsSave.phase === "saving";
  // 接続保存は保存済みの接続依存ロールも更新するため、別scopeを同時に保存させない。
  // タブ移動で pending state を消すと古い応答が後から入力を戻し得るので、設定全体を一時ロックする。
  const settingsSaving = connectionSaving || rolesSaving || ttsSaving;

  function appliedMessage(v: LlmSettingsView): string {
    return v.applied === false ? s.llm.notApplied(v.error ?? "") : s.llm.applied;
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

  function switchSettingsTab(next: "conn" | "roles" | "display") {
    if (settingsSaving) return;
    setTab(next);
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
    const generation = saveGenerationRef.current.begin("connection");
    setConnectionSave({ phase: "saving", message: null });
    try {
      // 接続変更で既に保存済みのローカル/Codex割当が古い接続先を参照し続けないよう、
      // 接続依存の保存済みロールだけを同じ接続で更新する。編集中の割当/tuningは送らない。
      const roles = buildSavedRoleConnectionPatch(view.roles, conn);
      const authPatch = buildAuthPatch(savedConnection?.auth ?? hydrateAuthModes(view), connectionDraft.auth);
      const saved = await saveLlmRoleSettings({
        global: buildGlobalConnectionPayload(conn),
        roles,
        tuning: { global: { claudeModel: globalClaudeModel.trim() || null } },
        ...(authPatch ? { auth: authPatch } : {}),
      });
      if (!saveGenerationRef.current.isCurrent("connection", generation)) return;
      const nextConnection = hydrateConnection(saved);
      const nextAuth = hydrateAuthModes(saved);
      const nextGlobalModel = hydrateGlobalTuning(saved).claudeModel ?? "";
      setView((current) => mergeConnectionSaveView(current, saved));
      setConnBaseUrl(nextConnection.baseUrl);
      setConnModel(nextConnection.model);
      setConnCodex(nextConnection.codexModel);
      setGlobalClaudeModel(nextGlobalModel);
      setAuthClaude(nextAuth.claude);
      setAuthCodex(nextAuth.codex);
      setSavedConnection({ connection: nextConnection, globalClaudeModel: nextGlobalModel, auth: nextAuth });
      setConnectionSave({ phase: saved.applied === false ? "error" : "saved", message: appliedMessage(saved) });
      onHealthChanged();
    } catch (err) {
      if (!saveGenerationRef.current.isCurrent("connection", generation)) return;
      const reason = err instanceof Error ? err.message : String(err);
      setConnectionSave({ phase: "error", message: reason ? s.llm.saveFailedWithReason(reason) : s.llm.saveFailed });
    }
  }

  async function saveRoles() {
    if (!view || !savedConnection || connectionDirty) return;
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
      const reason = err instanceof Error ? err.message : String(err);
      setRolesSave({ phase: "error", message: reason ? s.llm.saveFailedWithReason(reason) : s.llm.saveFailed });
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
    onHealthChanged();
    fetchLlmSettings().then(setView).catch(() => {});
    fetchTtsSettings().then(setTtsView).catch(() => {});
    return r;
  }
  async function onDeleteSecret(name: SecretName): Promise<SecretMutationResult> {
    const r = await deleteSecret(name);
    setSecrets(r.secrets);
    onHealthChanged();
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
    deleteConfirm: s.settings.secretDeleteConfirm,
    saving: s.settings.secretSaving,
    deleting: s.settings.secretDeleting,
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
    markTtsEdited();
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
      });
      if (!saveGenerationRef.current.isCurrent("tts", generation)) return;
      hydrateTts(saved);
      setTtsSave({ phase: "saved", message: s.llm.applied });
      onHealthChanged();
    } catch {
      if (!saveGenerationRef.current.isCurrent("tts", generation)) return;
      setTtsSave({ phase: "error", message: s.llm.saveFailed });
    }
  }

  function stageResetTts() {
    const changed = ttsProvider !== "auto" || ttsBaseUrl !== "" || ttsModel !== "" || ttsVoice !== "";
    setTtsProvider("auto");
    setTtsBaseUrl("");
    setTtsModel("");
    setTtsVoice("");
    setTtsSave(changed ? { phase: "idle", message: s.settings.ttsResetStaged } : IDLE_SAVE);
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
        <button role="tab" aria-selected={tab === "conn"} className={tab === "conn" ? "is-active" : ""} disabled={settingsSaving} onClick={() => switchSettingsTab("conn")}>{s.settings.connectionSection}</button>
        <button role="tab" aria-selected={tab === "roles"} className={tab === "roles" ? "is-active" : ""} disabled={settingsSaving} onClick={() => switchSettingsTab("roles")}>{s.settings.roleAssignSection}</button>
        <button role="tab" aria-selected={tab === "display"} className={tab === "display" ? "is-active" : ""} disabled={settingsSaving} onClick={() => switchSettingsTab("display")}>{s.settings.displaySection}</button>
      </div>

      {llmSettingsLoad.state.status === "error" && (
        <Banner kind="error" action={<Button onClick={llmSettingsLoad.reload}>{s.settings.retry}</Button>}>
          {s.settings.loadLlmFailed}
        </Banner>
      )}
      {ttsSettingsLoad.state.status === "error" && (
        <Banner kind="error" action={<Button onClick={ttsSettingsLoad.reload}>{s.settings.retry}</Button>}>
          {s.settings.loadTtsFailed}
        </Banner>
      )}
      {secretsLoad.state.status === "error" && (
        <Banner kind="error" action={<Button onClick={secretsLoad.reload}>{s.settings.retry}</Button>}>
          {s.settings.loadSecretsFailed}
        </Banner>
      )}

      {tab === "conn" && (
        <section className="support-panel stack">
          <div className="llm-fields stack">
            <h3 className="settings-section-title">{s.settings.targetClaude}</h3>
            <div className="text-sm text-muted">{s.settings.claudeNoSetup}</div>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.settings.authModeLabel}</span>
              <select
                className="llm-input" value={authClaude} disabled={settingsSaving || !view}
                onChange={(e) => { setAuthClaude(e.target.value as AuthMode); markConnectionEdited(); }}
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
            <SecretKeyField name="ANTHROPIC_API_KEY" status={secrets?.ANTHROPIC_API_KEY} disabled={settingsSaving || !view || secretsLoad.state.status !== "ready"}
              str={secretStr} onSave={onSaveSecret} onDelete={onDeleteSecret} />
            <div className="text-sm text-muted">{s.settings.authApiKeyNote}</div>
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
            <h3 className="settings-section-title">{s.settings.localConnTitle}</h3>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.baseUrlLabel}</span>
              <input className="llm-input" value={connBaseUrl} placeholder={s.llm.baseUrlPlaceholder} disabled={settingsSaving || !view} onChange={(e) => { setConnBaseUrl(e.target.value); markConnectionEdited(); }} />
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
            <SecretKeyField name="OPENAI_COMPAT_API_KEY" status={secrets?.OPENAI_COMPAT_API_KEY} disabled={settingsSaving || !view || secretsLoad.state.status !== "ready"}
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
            <label className="llm-field">
              <span className="text-sm text-muted">{s.settings.authModeLabel}</span>
              <select
                className="llm-input" value={authCodex} disabled={settingsSaving || !view}
                onChange={(e) => { setAuthCodex(e.target.value as AuthMode); markConnectionEdited(); }}
              >
                {AUTH_MODE_OPTIONS.map((m) => (
                  <option key={m} value={m} disabled={m === "api-key" && !authKeys.codex}>
                    {m === "subscription" ? s.settings.authSubscription : s.settings.authApiKey}
                  </option>
                ))}
              </select>
            </label>
            <SecretKeyField name="CODEX_API_KEY" status={secrets?.CODEX_API_KEY} disabled={settingsSaving || !view || secretsLoad.state.status !== "ready"}
              str={secretStr} onSave={onSaveSecret} onDelete={onDeleteSecret} />
            <div className="text-sm text-muted">{s.settings.authApiKeyNote}</div>
          </div>
          <div className="text-sm text-muted">{s.llm.help}</div>
          <div className="text-sm text-muted">{s.settings.connectionSaveNote}</div>
          {authModeDirty && <div className="info-pop" role="status">{s.settings.authModeSaveRequired}</div>}
          <Button variant="primary" loading={connectionSaving} onClick={() => void saveConnection()} disabled={settingsSaving || !view || !connectionDirty}>
            {connectionSaving ? s.llm.saving : s.settings.saveConnection}
          </Button>
          {connectionDirty && <div className="info-pop" role="status">{s.settings.unsavedChanges}</div>}
          {connectionSave.message && <div className="info-pop" role="status">{connectionSave.message}</div>}

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
                  <select className="llm-input" value={ttsProvider} disabled={settingsSaving || !ttsView} onChange={(e) => { setTtsProvider(e.target.value as TtsProvider); markTtsEdited(); }}>
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
              <input className="llm-input" value={ttsBaseUrl} placeholder={s.settings.ttsBaseUrlPlaceholder} disabled={settingsSaving || !ttsView} onChange={(e) => { setTtsBaseUrl(e.target.value); markTtsEdited(); }} />
            </label>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.settings.ttsModelLabel}</span>
              <input className="llm-input" value={ttsModel} placeholder={s.settings.ttsModelPlaceholder} disabled={settingsSaving || !ttsView} onChange={(e) => { setTtsModel(e.target.value); markTtsEdited(); }} />
            </label>
            <div className="llm-field">
              <span className="text-sm text-muted">{s.settings.ttsVoicePresetLabel}</span>
              <div className="lang-toggle" role="group" aria-label={s.settings.ttsVoicePresetLabel}>
                <button className={voicePreset === "female" ? "is-active" : ""} aria-pressed={voicePreset === "female"} disabled={settingsSaving || !ttsView} onClick={() => applyVoicePreset("female")}>{s.settings.ttsVoiceFemale}</button>
                <button className={voicePreset === "male" ? "is-active" : ""} aria-pressed={voicePreset === "male"} disabled={settingsSaving || !ttsView} onClick={() => applyVoicePreset("male")}>{s.settings.ttsVoiceMale}</button>
                <button className={voicePreset === "custom" ? "is-active" : ""} aria-pressed={voicePreset === "custom"} disabled={settingsSaving || !ttsView} onClick={() => voiceInputRef.current?.focus()}>{s.settings.ttsVoiceCustom}</button>
              </div>
              <span className="text-sm text-muted">{s.settings.ttsVoicePresetNote}</span>
            </div>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.settings.ttsVoiceLabel}</span>
              <input ref={voiceInputRef} className="llm-input" value={ttsVoice} placeholder={s.settings.ttsVoicePlaceholder} disabled={settingsSaving || !ttsView} onChange={(e) => { setTtsVoice(e.target.value); markTtsEdited(); }} />
            </label>
            <SecretKeyField name="TTS_API_KEY" status={secrets?.TTS_API_KEY} disabled={settingsSaving || !ttsView || secretsLoad.state.status !== "ready"}
              approvalRequired={Boolean(secrets?.TTS_API_KEY.configured && ttsView?.apiKeyApproved !== true)}
              str={secretStr} onSave={onSaveSecret} onDelete={onDeleteSecret} />
            <div className="text-sm text-muted">{s.settings.ttsApiKeyOptionalNote}</div>
          </div>
          <div className="text-sm text-muted">{s.settings.ttsSaveNote}</div>
          <Button variant="primary" loading={ttsSaving} onClick={onSaveTts} disabled={settingsSaving || !ttsView || !ttsDirty}>{ttsSaving ? s.llm.saving : s.llm.save}</Button>
          <div className="text-sm text-muted">{s.settings.ttsResetDescWith(ttsView?.defaults.model ?? "gpt-4o-mini-tts", ttsView?.defaults.voice ?? "alloy")}</div>
          <Button variant="secondary" onClick={stageResetTts} disabled={settingsSaving || !ttsView}>{s.settings.ttsReset}</Button>
          {ttsDirty && <div className="info-pop" role="status">{s.settings.unsavedChanges}</div>}
          {ttsSave.message && <div className="info-pop" role="status">{ttsSave.message}</div>}
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
                <button className={preferredCloud === "claude" ? "is-active" : ""} aria-pressed={preferredCloud === "claude"} disabled={settingsSaving} onClick={() => setPreferredCloud("claude")}>{s.settings.targetClaude}</button>
                <button className={preferredCloud === "codex" ? "is-active" : ""} aria-pressed={preferredCloud === "codex"} disabled={settingsSaving} onClick={() => setPreferredCloud("codex")}>{s.settings.targetCodex}</button>
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
                    <option value="all-local" disabled={!presetEnabled("all-local", savedRoleConnection)}>{s.settings.presetAllLocal}</option>
                    <option value="balanced" disabled={!presetEnabled("balanced", savedRoleConnection)}>{s.settings.presetBalancedOption}</option>
                    <option value="high-quality">{s.settings.presetHighQuality}</option>
                  </select>
                  {current === "all-local" && <div className="text-sm text-muted">{s.settings.presetAllLocalDesc}</div>}
                  {m !== "custom" && current === "balanced" && <div className="text-sm text-muted">{s.settings.presetBalancedDesc(m.cloud)}</div>}
                  {m !== "custom" && current === "high-quality" && <div className="text-sm text-muted">{s.settings.presetHighQualityDesc(m.cloud)}</div>}
                  <div className="text-sm text-muted">{s.settings.presetSaveNote}</div>
                  {!localDefined && <div className="text-sm text-muted">{s.settings.presetLocalRequired}</div>}
                </>
              );
            })()}
          </div>

          {/* 推奨チューニングのワンタップ適用（クラウド割当ロールのみ書き換え・保存はしない） */}
          <div className="stack">
            <Button
              variant="secondary"
              onClick={() => { setTuning(applyRecommendedTuning(tuning, targets)); markRolesEdited(); }}
              disabled={settingsSaving || !view}
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
                    disabled={settingsSaving || !view}
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
                              disabled={settingsSaving || !view}
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
                            disabled={settingsSaving || !view}
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
                              disabled={settingsSaving || !view}
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
            <Button variant="primary" loading={rolesSaving} onClick={() => void saveRoles()} disabled={settingsSaving || !view || !rolesDirty || connectionDirty}>
              {rolesSaving ? s.llm.saving : s.settings.saveAssignments}
            </Button>
          </div>

          {rolesDirty && <div className="info-pop" role="status">{s.settings.unsavedChanges}</div>}
          {rolesSave.message && <div className="info-pop" role="status">{rolesSave.message}</div>}
        </section>
      )}

      {tab === "display" && (
        <section className="support-panel stack">
          <div className="stat-title">{s.settings.displaySection}</div>
          <div className="text-sm text-muted">{s.settings.displayImmediateNote}</div>
          <div className="lang-toggle" role="group" aria-label={s.appShell.textSize}>
            <button className={uiScale === "small" ? "is-active" : ""} aria-pressed={uiScale === "small"} onClick={() => setUiScale("small")}>{s.uiScale.small}</button>
            <button className={uiScale === "medium" ? "is-active" : ""} aria-pressed={uiScale === "medium"} onClick={() => setUiScale("medium")}>{s.uiScale.medium}</button>
            <button className={uiScale === "large" ? "is-active" : ""} aria-pressed={uiScale === "large"} onClick={() => setUiScale("large")}>{s.uiScale.large}</button>
            <button className={uiScale === "xlarge" ? "is-active" : ""} aria-pressed={uiScale === "xlarge"} onClick={() => setUiScale("xlarge")}>{s.uiScale.xlarge}</button>
          </div>
          <div className="lang-toggle" role="group" aria-label={s.appShell.language}>
            <button className={lang === "en" ? "is-active" : ""} aria-pressed={lang === "en"} onClick={() => switchLang("en")}>EN</button>
            <button className={lang === "ja" ? "is-active" : ""} aria-pressed={lang === "ja"} onClick={() => switchLang("ja")}>日本語</button>
          </div>
        </section>
      )}
    </div>
  );
}
