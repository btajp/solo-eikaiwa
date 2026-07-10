import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeRunner } from "../converse";
import { appendTurn, resolveSessionId, type ChatTurn } from "./transcript";
import { getActiveAuthModes } from "../llm-auth-store";
import { codexSpawnEnv } from "../codex-auth";

/** 既存 export 互換のための型エイリアス（codex-app-server.ts 等が CodexMsg として import する）。 */
export type CodexMsg = ChatTurn;

/**
 * system 指示・これまでの会話・新しい user 発話を、codex exec が読む1つのプロンプト文字列に畳む。
 * codex exec には Claude の systemPrompt に相当する別チャンネルが無いため、先頭に指示ブロックとして埋め込む。
 * 純関数（副作用なし）。
 */
export function composeCodexPrompt(system: string, history: CodexMsg[], userPrompt: string): string {
  const parts: string[] = [
    "[SYSTEM INSTRUCTIONS]",
    system,
  ];
  if (history.length > 0) {
    parts.push("", "[CONVERSATION SO FAR]");
    for (const m of history) {
      parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
    }
  }
  parts.push(
    "",
    "[RESPOND TO THE FOLLOWING — output only the reply text, no preamble, no tool calls]",
    `User: ${userPrompt}`,
  );
  return parts.join("\n");
}

/** codex exec を1回実行し、エージェントの最終メッセージ本文を返す関数の型（テスト用 seam）。 */
export type CodexExec = (
  args: {
    prompt: string; model?: string; cwd: string; reasoningEffort?: string; serviceTier?: string;
    /** 認証モードごとの最小env上書き（codexSpawnEnv参照）。 */
    env?: Record<string, string | undefined>;
  },
) => Promise<string>;

export type CodexConfig = {
  /** 省略時は codex config の既定モデル（-m を渡さない） */
  model?: string;
  /** reasoning effort の上書き（会話用途では medium 程度が現実的。省略時は -c を渡さず codex config の既定に従う） */
  reasoningEffort?: string;
  /** service tier（例 "fast"）。無効な値はサーバ側で黙って無視される（実測）ため既定付与しても安全 */
  serviceTier?: string;
  /** codex を起動する作業ディレクトリ。既定は tmpdir()（read-only サンドボックスなので無害な中立ディレクトリ） */
  cwd?: string;
  /** opts.systemPrompt 未指定時の既定 system プロンプト */
  defaultSystemPrompt: string;
  /** テスト用の注入 seam。既定は realCodexExec */
  exec?: CodexExec;
};

/**
 * `codex exec` をワンショットで叩く ClaudeRunner。
 * resume セマンティクスは sessionId → 会話履歴 のインメモリ Map で再現し、毎ターン全文を composeCodexPrompt で
 * 畳んで渡す（codex 自身の session/resume は使わない）。プロセス再起動で履歴が消えるのは既存 SDK と同様（許容）。
 */
export function makeCodexRunner(cfg: CodexConfig): ClaudeRunner {
  const exec = cfg.exec ?? realCodexExec;
  const cwd = cfg.cwd ?? tmpdir();
  const store = new Map<string, CodexMsg[]>();

  return async (prompt, resumeId, opts) => {
    const sessionId = resolveSessionId(store, resumeId);
    const history = store.get(sessionId) ?? [];
    const system = opts?.systemPrompt ?? cfg.defaultSystemPrompt;

    const composed = composeCodexPrompt(system, history, prompt);
    const text = (await exec({
      prompt: composed, model: cfg.model, cwd,
      reasoningEffort: cfg.reasoningEffort, serviceTier: cfg.serviceTier,
      env: codexSpawnEnv(getActiveAuthModes().codex),
    })).trim();
    if (!text) throw new Error("Codex returned empty result");

    appendTurn(store, sessionId, prompt, text);
    return { text, sessionId };
  };
}

/**
 * 実際の `codex exec` 実行。安全のため CLI フラグでユーザー config を必ず上書きする:
 * - `-s read-only`   : サンドボックスを read-only に固定（config の danger-full-access を上書き。CLI が優先）
 * - `-c approval_policy="never"` : 非対話で昇格せず失敗させる（承認プロンプトで固まらない）
 * - `-c model_reasoning_effort="…"` : reasoningEffort 指定時のみ。ユーザー config（xhigh 等）を会話向けに上書きする
 * - `-c service_tier="…"` : serviceTier 指定時のみ（例 "fast"）。無効値はサーバが黙って無視する
 * - `--skip-git-repo-check` / `-C tmpdir` : 中立な作業ディレクトリで git チェックを回避
 * - `-o <file>`      : エージェントの最終メッセージだけをファイルに書かせ、そこから読む（JSONL パース不要）
 * プロンプトは argv ではなく stdin から渡す（長文と "-" 始まりの argv injection を避ける）。
 * この関数は codex CLI に依存するため単体テスト対象外。makeCodexRunner は注入した exec フェイクで検証し、
 * ここは Task 5 の手動スモークで確認する。
 */
export const realCodexExec: CodexExec = async ({ prompt, model, cwd, reasoningEffort, serviceTier, env }) => {
  const work = mkdtempSync(path.join(tmpdir(), "codex-run-"));
  try {
    const outFile = path.join(work, "last.txt");
    const args = [
      "exec",
      "--skip-git-repo-check",
      "-s", "read-only",
      "-c", 'approval_policy="never"',
      ...(reasoningEffort ? ["-c", `model_reasoning_effort="${reasoningEffort}"`] : []),
      ...(serviceTier ? ["-c", `service_tier="${serviceTier}"`] : []),
      "-C", cwd,
      "--color", "never",
      "-o", outFile,
      ...(model ? ["-m", model] : []),
      "-", // プロンプトは stdin から読む
    ];
    const proc = Bun.spawn(["codex", ...args], {
      cwd,
      stdin: new TextEncoder().encode(prompt),
      stdout: "ignore",
      stderr: "pipe",
      env: env ?? codexSpawnEnv(getActiveAuthModes().codex),
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`codex exec failed (exit ${exitCode}): ${stderr.slice(-500)}`);
    }
    return readFileSync(outFile, "utf8");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};
