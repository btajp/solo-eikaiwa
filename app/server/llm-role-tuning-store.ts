import type { Database } from "bun:sqlite";
import { LLM_ROLES, type LlmRole } from "./llm-provider";

/**
 * ロール別チューニング（Claude モデルエイリアス・思考量・配信ティア）の永続化（role 主キーの複数行）。
 * llm_role_settings（プロバイダ割当）・llm_settings（全体設定）とは別テーブル。
 * 既存 DB への影響なし（CREATE IF NOT EXISTS のみ・ALTER しない）。行不在のロールは「既定継承」を意味する。
 */
export function ensureLlmRoleTuningSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS llm_role_tuning (
    role TEXT PRIMARY KEY,
    claude_model TEXT,
    effort TEXT,
    service_tier TEXT,
    updated_at TEXT NOT NULL
  )`);
}

/** ロール別チューニングの値。null は「既定へ従う（未指定）」を表す。妥当性（形式/ホワイトリスト）は route が保証する。 */
export type RoleTuning = { claudeModel: string | null; effort: string | null; serviceTier: string | null };

/**
 * チューニングの保存先スコープ。5ロール + "global"（全ロール共通の既定。解決順: ロール別 > global > コード既定）。
 * "global" 行は既存スキーマ（role TEXT PRIMARY KEY・CHECK 制約なし）にそのまま同居する（スキーマ変更なし）。
 */
export type TuningScope = LlmRole | "global";

/**
 * Claude モデルエイリアスの既知リスト。**CLI（scripts/generate-*.ts）の env 検証専用**。
 * route の保存検証は v0.29 でホワイトリストから形式チェック（自由文字列）へ移行済み —
 * モデルの選択肢はカタログ API（SDK supportedModels()）が動的に提示し、任意のモデルID
 * （例: claude-fable-5）も保存できる（「UI 真実性」方式・codexModel と同基準）。
 */
export const CLAUDE_MODELS = ["haiku", "sonnet", "opus"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/**
 * codex 用の effort ホワイトリスト。codex は "max" をリクエストレベルで受け付けない
 * （モデルの supportedReasoningEfforts に無く、そのまま送ると request 時に失敗する。実機の
 * model/list 応答で確認済み）ため EFFORTS から除外する。route（llm-settings.ts）が
 * ロールの実効プロバイダに応じてこちらか EFFORTS を選んで検証する。
 */
export const CODEX_EFFORTS = EFFORTS.filter((e): e is Exclude<(typeof EFFORTS)[number], "max"> => e !== "max");
export const SERVICE_TIERS = ["fast", "standard"] as const;

export type LlmRoleTuningStore = {
  /** 全ロール分（LLM_ROLES）を必ず返す。行不在のロールは全項目 null を埋める（"global" 行は含めない）。 */
  getAll(): Record<LlmRole, RoleTuning>;
  /** グローバル既定（role="global" 行）。行不在なら全項目 null。 */
  getGlobal(): RoleTuning;
  /**
   * 渡されたスコープ（ロール or "global"）だけを upsert する（DELETE は使わない）。各値は Partial のため、
   * 指定されなかったフィールドは既存値を保持し、明示的に null が指定されたフィールドだけクリアする。
   */
  setAll(t: Partial<Record<TuningScope, Partial<RoleTuning>>>): void;
};

type Row = { role: string; claude_model: string | null; effort: string | null; service_tier: string | null };

const EMPTY_TUNING: RoleTuning = { claudeModel: null, effort: null, serviceTier: null };

export function makeLlmRoleTuningStore(db: Database): LlmRoleTuningStore {
  const findOne = db.query<Row, [string]>(
    "SELECT role, claude_model, effort, service_tier FROM llm_role_tuning WHERE role = ?",
  );
  return {
    getAll() {
      const rows = db
        .query<Row, []>("SELECT role, claude_model, effort, service_tier FROM llm_role_tuning")
        .all();
      const byRole = new Map(rows.map((r) => [r.role, r]));
      const out = {} as Record<LlmRole, RoleTuning>;
      for (const role of LLM_ROLES) {
        const r = byRole.get(role);
        out[role] = r
          ? { claudeModel: r.claude_model, effort: r.effort, serviceTier: r.service_tier }
          : { ...EMPTY_TUNING };
      }
      return out;
    },
    getGlobal() {
      const r = findOne.get("global");
      return r
        ? { claudeModel: r.claude_model, effort: r.effort, serviceTier: r.service_tier }
        : { ...EMPTY_TUNING };
    },
    setAll(t) {
      const now = new Date().toISOString();
      for (const role of Object.keys(t) as TuningScope[]) {
        const patch = t[role];
        if (!patch) continue;
        const existingRow = findOne.get(role);
        const current: RoleTuning = existingRow
          ? { claudeModel: existingRow.claude_model, effort: existingRow.effort, serviceTier: existingRow.service_tier }
          : { ...EMPTY_TUNING };
        const merged: RoleTuning = { ...current, ...patch };
        db.run(
          `INSERT INTO llm_role_tuning (role, claude_model, effort, service_tier, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(role) DO UPDATE SET
             claude_model = excluded.claude_model,
             effort = excluded.effort,
             service_tier = excluded.service_tier,
             updated_at = excluded.updated_at`,
          [role, merged.claudeModel, merged.effort, merged.serviceTier, now],
        );
      }
    },
  };
}
