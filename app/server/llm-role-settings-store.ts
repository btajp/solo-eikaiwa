import type { Database } from "bun:sqlite";
import { LLM_ROLES, type LlmRole, type LlmRoleProvider, type LlmRoleSetting } from "./llm-provider";
import { isOfficialOpenAiBaseUrl } from "./openai";

/**
 * ロール別 LLM 設定の永続化（role 主キーの複数行）。全体設定の llm_settings（単一行）とは別テーブル。
 * 既存 DB への影響なし（CREATE IF NOT EXISTS のみ・ALTER しない）。row 不在のロールは inherit とみなす。
 * APIキーは持たず、Keychain/env resolverから実行時に注入する。
 */
export function ensureLlmRoleSettingsSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS llm_role_settings (
    role TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    base_url TEXT,
    model TEXT,
    codex_model TEXT,
    updated_at TEXT NOT NULL
  )`);
  // 旧データの一度きり書き戻し（マイグレーション機構ではない・冪等）: OpenAI 公式プロバイダ導入前に
  // 保存された「公式URLを指す openai-compat 行」を openai 行へ移行する。route が同組合せの新規保存を
  // 400 で拒否するため、この書き戻しが新規行に適用されることはない。getAll は読み取り時の再解釈を
  // 行わない（保存値をそのまま返す＝往復一致）。
  const compatRows = db
    .query<{ role: string; base_url: string | null }, []>(
      "SELECT role, base_url FROM llm_role_settings WHERE provider = 'openai-compat'",
    )
    .all();
  for (const row of compatRows) {
    if (!isOfficialOpenAiBaseUrl(row.base_url)) continue;
    db.run(
      "UPDATE llm_role_settings SET provider = 'openai', base_url = NULL, updated_at = ? WHERE role = ?",
      [new Date().toISOString(), row.role],
    );
  }
}

export type LlmRoleSettingsStore = {
  /** 全ロール分（LLM_ROLES）を必ず返す。未設定ロールは { provider: "inherit", … null } を埋める。 */
  getAll(): Record<LlmRole, LlmRoleSetting>;
  /** 1ロールを upsert（provider="inherit" で inherit へ戻す。DELETE は使わない）。妥当性は route が保証する。 */
  save(role: LlmRole, s: LlmRoleSetting): void;
};

type Row = { role: string; provider: string; base_url: string | null; model: string | null; codex_model: string | null };

export function makeLlmRoleSettingsStore(db: Database): LlmRoleSettingsStore {
  return {
    getAll() {
      const rows = db
        .query<Row, []>("SELECT role, provider, base_url, model, codex_model FROM llm_role_settings")
        .all();
      const byRole = new Map(rows.map((r) => [r.role, r]));
      const out = {} as Record<LlmRole, LlmRoleSetting>;
      for (const role of LLM_ROLES) {
        const r = byRole.get(role);
        out[role] = r
          ? {
              provider: r.provider as LlmRoleProvider,
              baseUrl: r.base_url,
              model: r.model,
              codexModel: r.codex_model,
            }
          : { provider: "inherit", baseUrl: null, model: null, codexModel: null };
      }
      return out;
    },
    save(role, s) {
      db.run(
        `INSERT INTO llm_role_settings (role, provider, base_url, model, codex_model, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(role) DO UPDATE SET
           provider = excluded.provider,
           base_url = excluded.base_url,
           model = excluded.model,
           codex_model = excluded.codex_model,
           updated_at = excluded.updated_at`,
        [role, s.provider, s.baseUrl, s.model, s.codexModel, new Date().toISOString()],
      );
    },
  };
}
