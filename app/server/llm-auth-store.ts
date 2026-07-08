import type { Database } from "bun:sqlite";

/**
 * provider（claude/codex）ごとの認証モードの永続化（llm_role_tuning 等と同じ CREATE IF NOT EXISTS 規約）。
 * 行不在 = 既定 "subscription"（＝現行どおりユーザーの CLI ログインに相乗り。挙動不変の核）。
 * APIキーの値そのものはここに持たない（app/.env のみ。DBに秘密は置かない衛生を維持する）。
 */
export function ensureLlmAuthSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS llm_auth (
    provider TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

export type AuthMode = "subscription" | "api-key";
export type LlmAuthProvider = "claude" | "codex";
export type LlmAuthModes = Record<LlmAuthProvider, AuthMode>;

/** ホワイトリスト（route 検証と共有する単一定義。CLAUDE_MODELS 等と同じ置き場所の規約）。 */
export const AUTH_MODES = ["subscription", "api-key"] as const;

export type LlmAuthStore = {
  /** claude/codex を必ず両方返す。行不在の provider は "subscription" を埋める。 */
  getAll(): LlmAuthModes;
  /** 単一 provider の mode を upsert する。 */
  set(provider: LlmAuthProvider, mode: AuthMode): void;
};

type Row = { provider: string; mode: string };

export function makeLlmAuthStore(db: Database): LlmAuthStore {
  return {
    getAll() {
      const rows = db.query<Row, []>("SELECT provider, mode FROM llm_auth").all();
      const byProvider = new Map(rows.map((r) => [r.provider, r.mode as AuthMode]));
      return {
        claude: byProvider.get("claude") ?? "subscription",
        codex: byProvider.get("codex") ?? "subscription",
      };
    },
    set(provider, mode) {
      db.run(
        `INSERT INTO llm_auth (provider, mode, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
        [provider, mode, new Date().toISOString()],
      );
    },
  };
}

/**
 * claude 経路（SDK query() の spawn env / claude-print exec env）向けの env 上書きを組み立てる純関数。
 * subscription（既定）では undefined を返す＝呼び出し側は env キー自体を渡さず、現行どおり process.env を
 * そのまま継承する（挙動不変の核）。api-key のときだけ baseEnv を土台に ANTHROPIC_API_KEY を含む env を返す
 * （SDK の env オプションは指定すると継承ではなく丸ごと置き換わるため、baseEnv を明示的にスプレッドする）。
 * codex-auth.ts の codexSpawnEnv と対になる（provider ごとに別ファイルに置くのは、claude 側がこの
 * 小さな純関数だけで完結し codex-auth.ts の CODEX_HOME 概念に依存しないため）。
 */
export function claudeSpawnEnv(
  mode: AuthMode,
  baseEnv: Record<string, string | undefined> = Bun.env,
): Record<string, string | undefined> | undefined {
  return mode === "api-key" ? { ...baseEnv, ANTHROPIC_API_KEY: baseEnv.ANTHROPIC_API_KEY } : undefined;
}

/**
 * ランタイムの「現在アクティブな認証モード」キャッシュ（module-level 単一インスタンス）。
 *
 * なぜ DB(llm_auth) を直接読まず、このキャッシュを挟むか: converse.ts の claudeRunner や
 * providers/codex.ts・providers/codex-app-server.ts の real 実装は module-level の単一インスタンスとして
 * サーバ起動時に構築され、DB は index.ts でしか開かれない（circular import 回避のため runner 実装から
 * DB へは到達できない設計）。auth モードは「設定を変えなければ挙動完全同一」の回帰基準があるため、
 * モード未指定時に同一 runner 参照を返し続ける既存の resolveClaudeRunner 等の仕組みとも両立させる必要があり、
 * cfg 経由で一度だけ焼き込む方式では PUT のたびに再構築されない限り反映されない。
 *
 * そこで conversationWarmup.setTarget と同じ「安定参照 + push 更新」の形を取る: routes/llm-settings.ts の
 * PUT ハンドラが保存直後に必ず（index.ts 経由で）setActiveAuthModes を呼び、以後の呼び出しは
 * getActiveAuthModes を都度参照することで、サーバ再起動なしにモード切替が反映される
 * （「起動時スナップショットにしない」という Plan B の要件）。
 */
let activeAuthModes: LlmAuthModes = { claude: "subscription", codex: "subscription" };

export function setActiveAuthModes(modes: LlmAuthModes): void {
  activeAuthModes = modes;
}

export function getActiveAuthModes(): LlmAuthModes {
  return activeAuthModes;
}
