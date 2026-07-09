import { afterAll, describe, expect, test } from "bun:test";
import { applyLlmSettings, applyLlmRoleSettings, getCurrentRunner, runnerFor } from "../converse";
import { LLM_ROLES } from "../llm-provider";
import type { LlmSettings, LlmRole, LlmRoleSetting } from "../llm-provider";
import type { RoleTuning } from "../llm-role-tuning-store";

// ambient な Bun.env.LLM_PROVIDER の影響を排除するため、空 env を明示注入して決定的にする
const emptyEnv: Record<string, string | undefined> = {};
const CLAUDE: LlmSettings = { provider: "claude", baseUrl: null, model: null, codexModel: null };

describe("applyLlmSettings ランタイム切替", () => {
  // グローバル currentRunner をこのファイル内で差し替えるため、後始末で claude 基準へ戻す
  afterAll(() => applyLlmSettings(CLAUDE, emptyEnv));

  test("openai-compat 適用で claude と別参照になり、env リセットで claude 同一参照へ戻る", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner();

    applyLlmSettings(
      { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null },
      emptyEnv,
    );
    const swapped = getCurrentRunner();
    expect(swapped).not.toBe(claudeRef);
    expect(typeof swapped).toBe("function");

    applyLlmSettings({ provider: "claude", baseUrl: null, model: null, codexModel: null }, emptyEnv);
    // claude へ戻すと resolveRoleRunner は同一の claudeRunner を返す（"env" センチネルは廃止済み）
    expect(getCurrentRunner()).toBe(claudeRef);
  });

  test("codex 適用も claude と別参照になる", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner();
    applyLlmSettings({ provider: "codex", baseUrl: null, model: null, codexModel: "o4-mini" }, emptyEnv);
    expect(getCurrentRunner()).not.toBe(claudeRef);
  });
});

const INHERIT: LlmRoleSetting = { provider: "inherit", baseUrl: null, model: null, codexModel: null };
const allInherit = (): Record<LlmRole, LlmRoleSetting> =>
  Object.fromEntries(LLM_ROLES.map((r) => [r, INHERIT])) as Record<LlmRole, LlmRoleSetting>;

describe("runnerFor / applyLlmRoleSettings ロール別ルーティング", () => {
  afterAll(() => applyLlmSettings(CLAUDE, emptyEnv));

  test("全ロール inherit + global=claude なら5ロールとも同一の claude runner に解決する（既定不変）", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner("conversation");
    applyLlmRoleSettings({ provider: "claude", baseUrl: null, model: null, codexModel: null }, allInherit(), emptyEnv);
    for (const role of LLM_ROLES) {
      // resolved runner は全ロール同一参照（= claudeRunner）
      expect(getCurrentRunner(role)).toBe(claudeRef);
    }
  });

  test("runnerFor は安定参照（再解決しても同じラッパを返す）", () => {
    const before = runnerFor("coaching");
    applyLlmRoleSettings(
      { provider: "claude", baseUrl: null, model: null, codexModel: null },
      { ...allInherit(), coaching: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null } },
      emptyEnv,
    );
    expect(runnerFor("coaching")).toBe(before);
  });

  test("1ロールだけ openai-compat 上書きすると、そのロールの解決先だけ別参照になり他ロールは inherit(claude) のまま", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner("conversation");
    applyLlmRoleSettings(
      CLAUDE,
      { ...allInherit(), generation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null } },
      emptyEnv,
    );
    expect(getCurrentRunner("generation")).not.toBe(claudeRef);
    expect(getCurrentRunner("conversation")).toBe(claudeRef);
    expect(getCurrentRunner("assist")).toBe(claudeRef);
    expect(getCurrentRunner("coaching")).toBe(claudeRef);
    expect(getCurrentRunner("assessment")).toBe(claudeRef);
  });

  test("後方互換: applyLlmSettings(global) は全ロールを inherit として global へ解決する", () => {
    applyLlmSettings({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null }, emptyEnv);
    const conv = getCurrentRunner("conversation");
    for (const role of LLM_ROLES) expect(getCurrentRunner(role)).toBe(conv);
  });
});

describe("assist ロールの連鎖規則（不在=coaching の解決結果を共有参照）", () => {
  afterAll(() => applyLlmSettings(CLAUDE, emptyEnv));

  test("assist 行が inherit のとき、coaching が openai-compat でも assist は coaching と同一 runner 参照になる", () => {
    applyLlmRoleSettings(
      CLAUDE,
      { ...allInherit(), coaching: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null } },
      emptyEnv,
    );
    expect(runnerFor("assist")).not.toBe(undefined);
    expect(getCurrentRunner("assist")).toBe(getCurrentRunner("coaching"));
  });

  test("assist 行が明示設定のときは coaching と独立に解決する", () => {
    applyLlmRoleSettings(
      CLAUDE,
      {
        ...allInherit(),
        coaching: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null },
        assist: { provider: "codex", baseUrl: null, model: null, codexModel: "o4-mini" },
      },
      emptyEnv,
    );
    expect(getCurrentRunner("assist")).not.toBe(getCurrentRunner("coaching"));
  });

  test("assist・coaching とも inherit なら両方 global と同一参照（従来どおり）", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner("conversation");
    applyLlmRoleSettings({ provider: "claude", baseUrl: null, model: null, codexModel: null }, allInherit(), emptyEnv);
    expect(getCurrentRunner("assist")).toBe(claudeRef);
    expect(getCurrentRunner("coaching")).toBe(claudeRef);
  });
});

const NO_TUNING: RoleTuning = { claudeModel: null, effort: null, serviceTier: null };
const allNullTuning = (): Record<LlmRole, RoleTuning> =>
  Object.fromEntries(LLM_ROLES.map((r) => [r, NO_TUNING])) as Record<LlmRole, RoleTuning>;

describe("グローバルチューニング（llm_role_tuning の global 行・解決順: ロール別 > global > コード既定）", () => {
  afterAll(() => applyLlmSettings(CLAUDE, emptyEnv));

  test("globalTuning の claudeModel 指定で全 inherit ロールが既定参照から変わり、クリアで既定参照へ戻る", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner("conversation");
    applyLlmRoleSettings(CLAUDE, allInherit(), emptyEnv, allNullTuning(), {
      claudeModel: "claude-fable-5", effort: null, serviceTier: null,
    });
    const tuned = getCurrentRunner("conversation");
    expect(tuned).not.toBe(claudeRef);
    // inherit + ロール別 tuning 無しの全ロールは global 解決結果を共有参照する
    for (const role of LLM_ROLES) expect(getCurrentRunner(role)).toBe(tuned);
    applyLlmRoleSettings(CLAUDE, allInherit(), emptyEnv, allNullTuning(), {
      claudeModel: null, effort: null, serviceTier: null,
    });
    expect(getCurrentRunner("conversation")).toBe(claudeRef);
  });

  test("ロール別チューニングは global より優先される（設定ありロールだけ独立解決）", () => {
    applyLlmRoleSettings(CLAUDE, allInherit(), emptyEnv, {
      ...allNullTuning(),
      assessment: { claudeModel: "opus", effort: null, serviceTier: null },
    }, { claudeModel: "haiku", effort: null, serviceTier: null });
    // assessment はロール別（opus）で独立解決・他ロールは global（haiku）を共有
    expect(getCurrentRunner("assessment")).not.toBe(getCurrentRunner("conversation"));
    expect(getCurrentRunner("coaching")).toBe(getCurrentRunner("conversation"));
  });
});

describe("ロール別チューニング配線（Task 8）", () => {
  afterAll(() => applyLlmSettings(CLAUDE, emptyEnv));

  test("全ロール inherit + tuning全null なら5ロールとも同一参照（既定挙動不変）", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner("conversation");
    applyLlmRoleSettings(CLAUDE, allInherit(), emptyEnv, allNullTuning());
    for (const role of LLM_ROLES) expect(getCurrentRunner(role)).toBe(claudeRef);
  });

  test("1ロールだけチューニングを設定すると、そのロールだけ独立解決し他のinherit+tuning無しロールはglobalと共有のまま", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner("conversation");
    applyLlmRoleSettings(CLAUDE, allInherit(), emptyEnv, {
      ...allNullTuning(),
      assessment: { claudeModel: "opus", effort: "xhigh", serviceTier: null },
    });
    expect(getCurrentRunner("assessment")).not.toBe(claudeRef);
    expect(getCurrentRunner("conversation")).toBe(claudeRef);
    expect(getCurrentRunner("coaching")).toBe(claudeRef);
    expect(getCurrentRunner("generation")).toBe(claudeRef);
    // assist は inherit で coaching も global 共有のままなので claudeRef と同じになる
    expect(getCurrentRunner("assist")).toBe(claudeRef);
  });

  test("assist行がinherit・assist独自のtuningがあっても、coachingのtuning込みの解決結果をそのまま共有する（連鎖の一貫性）", () => {
    applyLlmRoleSettings(CLAUDE, allInherit(), emptyEnv, {
      ...allNullTuning(),
      assist: { claudeModel: "haiku", effort: "low", serviceTier: null },
      coaching: { claudeModel: "opus", effort: "xhigh", serviceTier: null },
    });
    // assist は自分の tuning(haiku/low) ではなく、coaching の解決結果(opus/xhigh) と同一参照になる
    expect(getCurrentRunner("assist")).toBe(getCurrentRunner("coaching"));
    // coaching は独立チューニングを持つため、tuning無しの他ロールとは異なる参照
    expect(getCurrentRunner("coaching")).not.toBe(getCurrentRunner("conversation"));
  });

  test("assist行が明示設定(非inherit)のときは、assist自身のtuningがあってもcoachingとは独立に解決する", () => {
    applyLlmRoleSettings(
      CLAUDE,
      { ...allInherit(), assist: { provider: "claude", baseUrl: null, model: null, codexModel: null } },
      emptyEnv,
      {
        ...allNullTuning(),
        assist: { claudeModel: "haiku", effort: "low", serviceTier: null },
        coaching: { claudeModel: "opus", effort: "xhigh", serviceTier: null },
      },
    );
    expect(getCurrentRunner("assist")).not.toBe(getCurrentRunner("coaching"));
  });
});
