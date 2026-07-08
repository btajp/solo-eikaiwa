import { LLM_ROLES, type LlmRole, type LlmRoleInput, type LlmSettingsInput, type LlmSettingsView } from "../api";

/** ロール割当の3値（UI が直接選ぶ）。inherit/env は UI に出さない。 */
export type RoleTarget = "claude" | "local" | "codex";
export type RoleTargets = Record<LlmRole, RoleTarget>;

/** 接続入力（接続セクションの3フィールド。空文字＝未指定）。 */
export type Connection = { baseUrl: string; model: string; codexModel: string };

/** プリセット識別子。 */
export type PresetId = "all-local" | "balanced" | "high-quality";

/**
 * プリセットのロール割当（固定）。バランスは会話のみローカル（速度優先）、
 * コーチング・教材生成・測定は品質優先で Claude（生成・測定は低頻度なため）。
 */
export const PRESETS: Record<PresetId, RoleTargets> = {
  "all-local": { conversation: "local", coaching: "local", generation: "local", assessment: "local" },
  balanced: { conversation: "local", coaching: "claude", generation: "claude", assessment: "claude" },
  "high-quality": { conversation: "claude", coaching: "claude", generation: "claude", assessment: "claude" },
};

/** baseUrl と model が両方非空ならローカル接続は定義済み。 */
export function isLocalDefined(conn: Connection): boolean {
  return conn.baseUrl.trim().length > 0 && conn.model.trim().length > 0;
}

/** ローカルを含むプリセットはローカル定義が必要。high-quality は常に可。 */
export function presetEnabled(id: PresetId, conn: Connection): boolean {
  if (id === "high-quality") return true;
  return isLocalDefined(conn);
}

/** llm_settings.provider（env は envProvider へ解決）を effective global provider として返す。 */
function effectiveGlobalProvider(view: LlmSettingsView): string {
  return view.provider === "env" ? view.envProvider : view.provider;
}

/** GET 応答から接続入力を復元する（llm_settings 優先・ロール行フォールバック）。 */
export function hydrateConnection(view: LlmSettingsView): Connection {
  const roleList = LLM_ROLES.map((r) => view.roles[r]);
  const localRole = roleList.find((r) => r.provider === "openai-compat" && r.baseUrl && r.model);
  const codexRole = roleList.find((r) => r.provider === "codex" && r.codexModel);
  return {
    baseUrl: view.baseUrl ?? localRole?.baseUrl ?? "",
    model: view.model ?? localRole?.model ?? "",
    codexModel: view.codexModel ?? codexRole?.codexModel ?? "",
  };
}

/** GET 応答からロール割当（3値）を復元する。inherit は effective global を辿る。 */
export function hydrateTargets(view: LlmSettingsView): RoleTargets {
  const global = effectiveGlobalProvider(view);
  const out = {} as RoleTargets;
  for (const role of LLM_ROLES) {
    const raw = view.roles[role].provider;
    const p = raw === "inherit" ? global : raw;
    out[role] = p === "openai-compat" ? "local" : p === "codex" ? "codex" : "claude";
  }
  return out;
}

/**
 * (targets, conn) を PUT /api/llm-settings/roles のペイロードへ直列化する。
 * - 接続は常に global（接続ストア）に保存する＝プリセット/割当保存でも接続は失われない。
 * - ローカル未定義のとき local ターゲットは claude にフォールバックする（空 baseUrl で 400 になるのを防ぐ）。
 */
export function buildRolesPayload(
  targets: RoleTargets,
  conn: Connection,
): { global: LlmSettingsInput; roles: Record<LlmRole, LlmRoleInput> } {
  const baseUrl = conn.baseUrl.trim();
  const model = conn.model.trim();
  const codexModel = conn.codexModel.trim() || null;
  const localDefined = baseUrl.length > 0 && model.length > 0;

  const global: LlmSettingsInput = localDefined
    ? { provider: "openai-compat", baseUrl, model, codexModel }
    : codexModel
    ? { provider: "codex", codexModel }
    : { provider: "env" };

  const roles = {} as Record<LlmRole, LlmRoleInput>;
  for (const role of LLM_ROLES) {
    const t = !localDefined && targets[role] === "local" ? "claude" : targets[role];
    roles[role] =
      t === "local" ? { provider: "openai-compat", baseUrl, model }
      : t === "codex" ? { provider: "codex", codexModel }
      : { provider: "claude" };
  }
  return { global, roles };
}

/** 現在の割当が一致するプリセット（値一致・適用履歴ではない）。どれとも一致しなければ "custom"。 */
export function matchPreset(targets: RoleTargets): PresetId | "custom" {
  return (Object.keys(PRESETS) as PresetId[])
    .find((id) => LLM_ROLES.every((r) => PRESETS[id][r] === targets[r])) ?? "custom";
}
