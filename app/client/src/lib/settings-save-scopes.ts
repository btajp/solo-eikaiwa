import type { AuthMode, LlmAuthProvider, LlmSettingsView, RoleTuning, TtsProvider, TtsSettingsView } from "../api";
import type { Connection, RoleTargets } from "./llm-assignments";

export { makeLatestGeneration } from "./latest-generation";

export type ConnectionDraft = {
  connection: Connection;
  globalClaudeModel: string;
  auth: Record<LlmAuthProvider, AuthMode>;
};

export type SaveScope = "connection" | "roles" | "tts";

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 接続タブだけの未保存状態。ロール割当・チューニングは意図的に含めない。 */
export function connectionDraftChanged(saved: ConnectionDraft | null, current: ConnectionDraft): boolean {
  return saved === null || !sameJson(saved, current);
}

/** 用途タブだけの未保存状態。接続入力は意図的に含めない。 */
export function rolesDraftChanged(
  savedTargets: RoleTargets | null,
  currentTargets: RoleTargets,
  savedTuning: Record<string, RoleTuning> | null,
  currentTuning: Record<string, RoleTuning>,
): boolean {
  return savedTargets === null || savedTuning === null
    || !sameJson(savedTargets, currentTargets)
    || !sameJson(savedTuning, currentTuning);
}

/** TTSセクションだけの未保存状態。空文字はサーバ保存時の null と同値として扱う。 */
export function ttsDraftChanged(
  saved: TtsSettingsView | null,
  provider: TtsProvider,
  baseUrl: string,
  model: string,
  voice: string,
): boolean {
  if (saved === null) return false;
  return saved.provider !== provider
    || (saved.baseUrl ?? "") !== baseUrl
    || (saved.model ?? "") !== model
    || (saved.voice ?? "") !== voice;
}

/** 接続保存の応答で更新してよい範囲だけを採用し、用途タブの編集中stateを守る。 */
export function mergeConnectionSaveView(current: LlmSettingsView | null, saved: LlmSettingsView): LlmSettingsView {
  if (current === null) return saved;
  return {
    ...current,
    provider: saved.provider,
    baseUrl: saved.baseUrl,
    model: saved.model,
    codexModel: saved.codexModel,
    apiKeyConfigured: saved.apiKeyConfigured,
    apiKeyApproved: saved.apiKeyApproved,
    globalTuning: saved.globalTuning,
    authModes: saved.authModes,
    authKeys: saved.authKeys,
    applied: saved.applied,
    error: saved.error,
  };
}

/** 用途保存の応答で更新してよい範囲だけを採用し、接続タブの編集中stateを守る。 */
export function mergeRolesSaveView(current: LlmSettingsView | null, saved: LlmSettingsView): LlmSettingsView {
  if (current === null) return saved;
  return {
    ...current,
    roles: saved.roles,
    tuning: saved.tuning,
    applied: saved.applied,
    error: saved.error,
  };
}

/** 同一保存スコープでは、あとから開始された要求だけが画面状態を更新できる。 */
export function makeSaveGenerationTracker(): {
  begin: (scope: SaveScope) => number;
  isCurrent: (scope: SaveScope, generation: number) => boolean;
} {
  const latest: Record<SaveScope, number> = { connection: 0, roles: 0, tts: 0 };
  return {
    begin(scope) {
      latest[scope] += 1;
      return latest[scope];
    },
    isCurrent(scope, generation) {
      return latest[scope] === generation;
    },
  };
}
