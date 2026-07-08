import type { ClaudeRunner } from "../converse";
import { TransportError } from "./errors";
import { CLAUDE_PRINT_DIR } from "../paths";
import { getActiveAuthModes, claudeSpawnEnv } from "../llm-auth-store";

/** `claude -p` を1回実行し、stdout の生JSON文字列を返す関数の型（テスト用 seam）。 */
export type ClaudePrintExec = (args: {
  prompt: string;
  systemPrompt: string;
  model?: string;
  effort?: string;
  resumeId?: string;
  cwd: string;
  /** api-key 認証モードのときだけ true（OAuth/keychain を読まない厳格モード）。 */
  bare?: boolean;
  /** api-key 認証モードのときだけ渡す env 上書き（claudeSpawnEnv 参照。subscription では undefined）。 */
  env?: Record<string, string | undefined>;
}) => Promise<string>;

export type ClaudePrintConfig = {
  /** 省略時は claude -p の既定モデル（--model を渡さない） */
  model?: string;
  /** --effort の上書き（省略時は渡さない） */
  effort?: string;
  /** opts.systemPrompt 未指定時に使う既定 system プロンプト */
  defaultSystemPrompt: string;
  /**
   * claude -p を起動する作業ディレクトリ。既定は CLAUDE_PRINT_DIR（固定）。
   * --resume によるセッション永続化はディスク上でこの cwd にキーされるため、mkdtemp 等で
   * 毎回変えてはならない（変えると resume が別セッション扱いになり壊れる）。
   */
  cwd?: string;
  /** テスト用の注入 seam。既定は realClaudePrintExec */
  exec?: ClaudePrintExec;
};

/** `claude -p --output-format json` の成功/失敗レスポンス双方に現れうるフィールドの最小形。 */
type ClaudePrintJson = {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
};

/**
 * `claude -p` をワンショットで叩く ClaudeRunner。
 * resume はプロセス側のネイティブ resume（--resume <id>。ディスクに永続化され再起動をまたぐ）に任せ、
 * codex.ts のような sessionId → 会話履歴のインメモリ Map は持たない。
 */
export function makeClaudePrintRunner(cfg: ClaudePrintConfig): ClaudeRunner {
  const exec = cfg.exec ?? realClaudePrintExec;
  const cwd = cfg.cwd ?? CLAUDE_PRINT_DIR;

  return async (prompt, resumeId, opts) => {
    const systemPrompt = opts?.systemPrompt ?? cfg.defaultSystemPrompt;
    const authMode = getActiveAuthModes().claude;
    const raw = await exec({
      prompt,
      systemPrompt,
      model: cfg.model,
      effort: cfg.effort,
      resumeId,
      cwd,
      ...(authMode === "api-key" ? { bare: true, env: claudeSpawnEnv(authMode) } : {}),
    });

    let parsed: ClaudePrintJson;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new TransportError(
        `claude -p returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const { subtype, is_error, result, session_id } = parsed;
    if (is_error === true || subtype !== "success") {
      throw new Error(`claude -p error (${subtype}): ${result ?? ""}`);
    }
    // success なのに session_id が無い malformed payload を "" で握りつぶすと、次ターンで --resume が
    // 付かず無音で新セッション化する（incoming resumeId も破棄される）。JSON.parse 失敗と同じ
    // 「CLI が出力契約を守らなかった」分類として TransportError にし、withFallback の委譲シグナルにする。
    if (typeof session_id !== "string" || session_id === "") {
      throw new TransportError("claude -p success response missing session_id");
    }

    const text = (result ?? "").trim();
    if (!text) throw new Error("Claude returned empty result");

    return { text, sessionId: session_id };
  };
}

/**
 * 実際の `claude -p` 実行。安全のため:
 * - `--tools ""` + `--max-turns 1` : ツール呼び出しを無効化する安全レール
 * - `--system-prompt <systemPrompt>` : システムプロンプトは専用フラグで渡す
 * - `--resume <id>` : resumeId 指定時のみ。ネイティブ resume に任せる（`--no-session-persistence` は
 *   付けない — 付けると resume 自体が壊れる）
 * プロンプトは argv ではなく stdin から渡す（長文と "-" 始まりの argv injection を避ける。realCodexExec と同じ流儀）。
 * この関数は claude CLI に依存するため単体テスト対象外。makeClaudePrintRunner は注入した exec フェイクで検証する
 * （realCodexExec の先例と同じ扱い。手動スモークは Task 5 で確認する）。
 */
export const realClaudePrintExec: ClaudePrintExec = async ({ prompt, systemPrompt, model, effort, resumeId, cwd, bare, env }) => {
  const args = [
    "-p",
    "--output-format", "json",
    "--tools", "",
    "--max-turns", "1",
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
    "--system-prompt", systemPrompt,
    ...(resumeId ? ["--resume", resumeId] : []),
    ...(bare ? ["--bare"] : []),
  ];
  const proc = Bun.spawn(["claude", ...args], {
    cwd,
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new TransportError(`claude -p failed (exit ${exitCode}): ${stderr.slice(-500)}`);
  }
  return stdout;
};
