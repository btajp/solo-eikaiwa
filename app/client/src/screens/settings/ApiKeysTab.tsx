import { useRef, useState } from "react";
import {
  AUTH_MODE_OPTIONS,
  type AuthMode,
  type LlmAuthProvider,
  type SecretMutationResult,
  type SecretName,
  type SecretsView,
} from "../../api";
import { STR, type Lang } from "../../i18n";
import { makeLatestGeneration } from "../../lib/settings-save-scopes";
import { formatClientError } from "../../lib/user-error";
import { Button } from "../../ui/Button";

type SecretKeyFieldProps = {
  lang: Lang;
  name: SecretName;
  status: SecretsView[SecretName] | undefined;
  disabled: boolean;
  saveDisabled?: boolean;
  approvalRequired?: boolean;
  onSave: (name: SecretName, value: string) => Promise<SecretMutationResult>;
  onDelete: (name: SecretName) => Promise<SecretMutationResult>;
};

/** APIキー値を再表示しない、置換・削除専用の入力欄。 */
function SecretKeyField(props: SecretKeyFieldProps) {
  const s = STR[props.lang];
  const [value, setValue] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"save" | "delete" | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const generationRef = useRef(makeLatestGeneration());
  const busy = busyAction !== null;
  const statusText = props.status?.configured
    ? props.status.source === "keychain"
      ? s.settings.secretStatusKeychain
      : props.status.source === "legacy"
      ? s.settings.secretStatusLegacy
      : s.settings.secretStatusEnv
    : s.settings.secretStatusMissing;

  async function run(kind: "save" | "delete", action: () => Promise<SecretMutationResult>, doneMsg: string) {
    const generation = generationRef.current.begin();
    setResult(null);
    setBusyAction(kind);
    try {
      const response = await action();
      if (!generationRef.current.isCurrent(generation)) return;
      setValue("");
      setResult(response.applied === false
        ? s.llm.notApplied(formatClientError(props.lang, response.error ?? "settings apply failed", "apply"))
        : doneMsg);
    } catch (err) {
      if (!generationRef.current.isCurrent(generation)) return;
      setResult(formatClientError(props.lang, err, "save"));
    } finally {
      if (generationRef.current.isCurrent(generation)) setBusyAction(null);
    }
  }

  return (
    <div className="llm-field" aria-busy={busy || undefined}>
      <span className="text-sm text-muted">{s.settings.secretKeyLabel} — {statusText}</span>
      <div className="secret-key-row">
        <input
          className="llm-input"
          type="password"
          autoComplete="off"
          value={value}
          placeholder={props.status?.configured ? s.settings.secretPlaceholderSet : s.settings.secretPlaceholderNew}
          disabled={props.disabled || props.saveDisabled || busy}
          onChange={(event) => { setValue(event.target.value); setDeleteConfirm(false); }}
        />
        <Button
          variant="primary"
          loading={busyAction === "save"}
          disabled={props.disabled || props.saveDisabled || busy || value.trim().length === 0}
          onClick={() => void run("save", () => props.onSave(props.name, value.trim()), s.settings.secretSaved)}
        >
          {busyAction === "save" ? s.settings.secretSaving : s.settings.secretSave}
        </Button>
        {props.status?.source === "keychain" && (
          <Button
            variant={deleteConfirm ? "danger" : "secondary"}
            loading={busyAction === "delete"}
            disabled={props.disabled || busy}
            onClick={() => {
              if (!deleteConfirm) { setDeleteConfirm(true); return; }
              setDeleteConfirm(false);
              void run("delete", () => props.onDelete(props.name), s.settings.secretDeleted);
            }}
          >
            {busyAction === "delete" ? s.settings.secretDeleting : deleteConfirm ? s.settings.secretDeleteConfirm : s.settings.secretDelete}
          </Button>
        )}
      </div>
      {result && <div className="info-pop" role="status">{result}</div>}
      {props.approvalRequired && <div className="info-pop">{s.settings.secretApprovalRequired}</div>}
    </div>
  );
}

type Props = {
  lang: Lang;
  disabled: boolean;
  secretsReady: boolean;
  secrets: SecretsView | null;
  auth: Record<LlmAuthProvider, AuthMode>;
  authKeys: { anthropic: boolean; codex: boolean };
  authDirty: boolean;
  authSaving: boolean;
  authMessage: string | null;
  compatTarget: string | null;
  compatRemote: boolean;
  compatKeyAllowed: boolean;
  compatKeyApproved: boolean;
  ttsTarget: string;
  ttsKeyAllowed: boolean;
  ttsKeyApproved: boolean;
  onAuthChange: (provider: LlmAuthProvider, mode: AuthMode) => void;
  onSaveAuth: () => void;
  onSaveSecret: SecretKeyFieldProps["onSave"];
  onDeleteSecret: SecretKeyFieldProps["onDelete"];
};

export function ApiKeysTab(props: Props) {
  const s = STR[props.lang];
  const keyDisabled = props.disabled || !props.secretsReady;

  function authSelect(provider: LlmAuthProvider, keyConfigured: boolean) {
    return (
      <label className="llm-field">
        <span className="text-sm text-muted">{s.settings.authModeLabel}</span>
        <select
          className="llm-input"
          value={props.auth[provider]}
          disabled={props.disabled}
          onChange={(event) => props.onAuthChange(provider, event.target.value as AuthMode)}
        >
          {AUTH_MODE_OPTIONS.map((mode) => (
            <option key={mode} value={mode} disabled={mode === "api-key" && !keyConfigured}>
              {mode === "subscription" ? s.settings.authSubscription : s.settings.authApiKey}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <section className="support-panel stack">
      <div className="info-pop">{s.settings.apiKeysIntro}</div>

      <div className="llm-fields stack">
        <h3 className="settings-section-title">{s.settings.targetClaude}</h3>
        {authSelect("claude", props.authKeys.anthropic)}
        {props.auth.claude === "api-key" && !props.authKeys.anthropic && (
          <div className="info-pop">{s.settings.authMissingKeyWith(s.settings.targetClaude)}</div>
        )}
        <SecretKeyField lang={props.lang} name="ANTHROPIC_API_KEY" status={props.secrets?.ANTHROPIC_API_KEY}
          disabled={keyDisabled} onSave={props.onSaveSecret} onDelete={props.onDeleteSecret} />
      </div>

      <hr className="settings-divider" />
      <div className="llm-fields stack">
        <h3 className="settings-section-title">{s.settings.codexConnTitle}</h3>
        {authSelect("codex", props.authKeys.codex)}
        {props.auth.codex === "api-key" && !props.authKeys.codex && (
          <div className="info-pop">{s.settings.authMissingKeyWith(s.settings.targetCodex)}</div>
        )}
        <SecretKeyField lang={props.lang} name="CODEX_API_KEY" status={props.secrets?.CODEX_API_KEY}
          disabled={keyDisabled} onSave={props.onSaveSecret} onDelete={props.onDeleteSecret} />
      </div>
      <div className="text-sm text-muted">{s.settings.authApiKeyNote}</div>
      <div className="text-sm text-muted">{s.settings.authenticationSaveNote}</div>
      <Button variant="primary" loading={props.authSaving} disabled={props.disabled || !props.authDirty} onClick={props.onSaveAuth}>
        {props.authSaving ? s.llm.saving : s.settings.saveAuthentication}
      </Button>
      {props.authDirty && <div className="info-pop" role="status">{s.settings.authModeSaveRequired}</div>}
      {props.authMessage && <div className="info-pop" role="status">{props.authMessage}</div>}

      <hr className="settings-divider" />
      <div className="llm-fields stack">
        <h3 className="settings-section-title">{s.settings.targetOpenAi}</h3>
        <div className="text-sm text-muted">{s.settings.openAiOfficialKeyNote}</div>
        <SecretKeyField lang={props.lang} name="OPENAI_API_KEY" status={props.secrets?.OPENAI_API_KEY}
          disabled={keyDisabled} onSave={props.onSaveSecret} onDelete={props.onDeleteSecret} />
      </div>

      <hr className="settings-divider" />
      <div className="llm-fields stack">
        <h3 className="settings-section-title">{s.settings.localConnTitle}</h3>
        <div className="text-sm text-muted">
          {props.compatTarget ? s.settings.apiKeyTargetWith(props.compatTarget) : s.settings.apiKeyTargetRequired}
        </div>
        {props.compatTarget && (
          <div className="text-sm text-muted">{props.compatRemote ? s.settings.apiKeyRemoteRequired : s.settings.apiKeyLocalOptional}</div>
        )}
        {props.compatTarget && !props.compatKeyAllowed && <div className="info-pop">{s.settings.apiKeyTransportBlocked}</div>}
        <SecretKeyField lang={props.lang} name="OPENAI_COMPAT_API_KEY" status={props.secrets?.OPENAI_COMPAT_API_KEY}
          disabled={keyDisabled} saveDisabled={!props.compatTarget || !props.compatKeyAllowed}
          approvalRequired={Boolean(props.secrets?.OPENAI_COMPAT_API_KEY.configured && !props.compatKeyApproved)}
          onSave={props.onSaveSecret} onDelete={props.onDeleteSecret} />
      </div>

      <hr className="settings-divider" />
      <div className="llm-fields stack">
        <h3 className="settings-section-title">{s.settings.ttsSection} — {s.settings.targetLocal}</h3>
        <div className="text-sm text-muted">{props.ttsTarget ? s.settings.apiKeyTargetWith(props.ttsTarget) : s.settings.apiKeyTargetRequired}</div>
        {!props.ttsKeyAllowed && <div className="info-pop">{s.settings.apiKeyTransportBlocked}</div>}
        <SecretKeyField lang={props.lang} name="TTS_API_KEY" status={props.secrets?.TTS_API_KEY}
          disabled={keyDisabled} saveDisabled={!props.ttsTarget || !props.ttsKeyAllowed}
          approvalRequired={Boolean(props.secrets?.TTS_API_KEY.configured && !props.ttsKeyApproved)}
          onSave={props.onSaveSecret} onDelete={props.onDeleteSecret} />
        <div className="text-sm text-muted">{s.settings.ttsApiKeyOptionalNote}</div>
      </div>
    </section>
  );
}
