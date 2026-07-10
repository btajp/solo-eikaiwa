import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import { makeProgressStore } from "../progress-store";

const T = "2026-07-06"; // 固定のテスト日付

function freshStore() {
  const db = openDb(":memory:");
  return { db, store: makeProgressStore(db) };
}

describe("progress-store: 初期化とsummary", () => {
  test("初回は DEFAULT_LEVEL=5・xp0 で初期化される", () => {
    const { store } = freshStore();
    const s = store.getSummary(T);
    expect(s.level).toBe(5);
    expect(s.xp).toBe(0);
    expect(s.xpIntoLevel).toBe(0);
    expect(s.xpToNext).toBe(20); // needXp(5)=15+5*stageOf(5)=20
    expect(s.stage).toBe(1);
    expect(s.difficultyMaxed).toBe(false);
    expect(s.proposal).toBeNull();
    expect(store.getLevel()).toBe(5);
  });
});

describe("progress-store: addXp とステージ内自動昇格", () => {
  test("XP到達でレベルが自動で上がる（余剰は持ち越し）", () => {
    const { store } = freshStore();
    const s = store.addXp("block", 30, {}, T)!; // need(5)=20 → Lv6, into=10
    expect(s.level).toBe(6);
    expect(s.xpIntoLevel).toBe(10);
    expect(s.xp).toBe(30); // 累積は減らない
  });
  test("複数レベルの一括昇格", () => {
    const { store } = freshStore();
    const s = store.addXp("block", 60, {}, T)!; // 20+20+20=60消費 → Lv8, into=0
    expect(s.level).toBe(8);
    expect(s.xpIntoLevel).toBe(0);
  });
  test("ステージ境界では自動昇格が止まる（Lv20で停止・xpToNextは0まで下がる）", () => {
    const { store } = freshStore();
    store.levelAction("set", 19, T);
    const s = store.addXp("block", 60, {}, T)!; // need(19)=25 → Lv20, into=35 ≥ need(20)=25 だが境界で停止
    expect(s.level).toBe(20);
    expect(s.xpIntoLevel).toBe(35);
    expect(s.xpToNext).toBe(0);
  });
  test("60→61 は境界ではなく自動昇格し difficultyMaxed になる", () => {
    const { store } = freshStore();
    store.levelAction("set", 60, T);
    const s = store.addXp("block", 45, {}, T)!;
    expect(s.level).toBe(61);
    expect(s.difficultyMaxed).toBe(true);
  });
  test("上限検証: block>60・srs-grade>2・placement≠10・非整数・0以下は null", () => {
    const { store } = freshStore();
    expect(store.addXp("block", 61, {}, T)).toBeNull();
    expect(store.addXp("srs-grade", 3, {}, T)).toBeNull();
    expect(store.addXp("placement", 9, {}, T)).toBeNull();
    expect(store.addXp("block", 0, {}, T)).toBeNull();
    expect(store.addXp("block", 1.5, {}, T)).toBeNull();
    expect(store.addXp("bogus" as never, 1, {}, T)).toBeNull();
  });
});

describe("progress-store: ブロック試行と完了率", () => {
  test("blockStart→addXp(attemptId) で completed になる", () => {
    const { db, store } = freshStore();
    const { attemptId } = store.blockStart("warmup-reading", T);
    store.addXp("block", 6, { attemptId }, T);
    const row = db.query<{ completed: number }, [number]>(
      "SELECT completed FROM block_attempts WHERE id = ?").get(attemptId)!;
    expect(row.completed).toBe(1);
  });
  test("同一attemptIdで2回addXpしてもXPは1回分・xp_eventsは1行（二重付与防止）", () => {
    const { db, store } = freshStore();
    const { attemptId } = store.blockStart("warmup-reading", T);
    const first = store.addXp("block", 6, { attemptId }, T)!;
    const second = store.addXp("block", 6, { attemptId }, T)!;
    expect(first.xp).toBe(6);
    expect(second.xp).toBe(6); // 2回目は加算されない
    const events = db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM xp_events WHERE kind = 'block' AND ymd = ?").get(T)!;
    expect(events.n).toBe(1);
  });

  test("completeBlockはattempt・kindを検証し、completionIdの再送を冪等化する", () => {
    const { db, store } = freshStore();
    const { attemptId } = store.blockStart("warmup-reading", T);
    const input = { completionId: "completion-0001", attemptId, blockKind: "warmup-reading" };
    const first = store.completeBlock(6, input, T);
    const second = store.completeBlock(6, input, T);
    expect(first.status).toBe("applied");
    expect(second.status).toBe("duplicate");
    expect(first.summary?.xp).toBe(6);
    expect(second.summary?.xp).toBe(6);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM xp_events WHERE kind = 'block'").get()!.n).toBe(1);

    expect(store.completeBlock(6, {
      completionId: "completion-0002", attemptId: 999, blockKind: "warmup-reading",
    }, T).status).toBe("unknown-attempt");
    expect(store.completeBlock(6, {
      completionId: "completion-0003", attemptId, blockKind: "reflection",
    }, T).status).toBe("attempt-mismatch");
  });

  test("attemptIdなしでもcompletionIdで再送を冪等化し、別payloadへの使い回しは拒否する", () => {
    const { db, store } = freshStore();
    const input = { completionId: "completion-no-attempt", attemptId: null, blockKind: "reflection" };
    expect(store.completeBlock(5, input, T).status).toBe("applied");
    expect(store.completeBlock(5, input, T).status).toBe("duplicate");
    expect(store.completeBlock(6, input, T).status).toBe("conflict");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM xp_events WHERE kind = 'block'").get()!.n).toBe(1);
  });

  test("XP記録失敗時はattempt完了・ledger・XPをすべてrollbackする", () => {
    const { db, store } = freshStore();
    const { attemptId } = store.blockStart("reflection", T);
    db.run(`CREATE TRIGGER fail_block_xp BEFORE INSERT ON xp_events
      WHEN NEW.kind = 'block' BEGIN SELECT RAISE(ABORT, 'xp write failed'); END`);

    expect(() => store.completeBlock(5, {
      completionId: "completion-fault", attemptId, blockKind: "reflection",
    }, T)).toThrow("xp write failed");
    expect(db.query<{ completed: number }, [number]>(
      "SELECT completed FROM block_attempts WHERE id = ?",
    ).get(attemptId)!.completed).toBe(0);
    expect(db.query<{ status: string }, [number]>(
      "SELECT status FROM block_attempt_outcomes WHERE attempt_id = ?",
    ).get(attemptId)!.status).toBe("pending");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM block_completion_events").get()!.n).toBe(0);
    expect(store.getSummary(T).xp).toBe(0);
  });

  test("進捗行更新が最後に失敗してもXP eventとattempt完了を残さない", () => {
    const { db, store } = freshStore();
    store.getSummary(T); // user_progressを先に作り、UPDATEだけをfault injection対象にする
    const { attemptId } = store.blockStart("reflection", T);
    db.run(`CREATE TRIGGER fail_progress_update BEFORE UPDATE ON user_progress
      BEGIN SELECT RAISE(ABORT, 'progress update failed'); END`);

    expect(() => store.completeBlock(5, {
      completionId: "completion-progress-fault", attemptId, blockKind: "reflection",
    }, T)).toThrow("progress update failed");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM xp_events").get()!.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM block_completion_events").get()!.n).toBe(0);
    expect(db.query<{ completed: number }, [number]>(
      "SELECT completed FROM block_attempts WHERE id = ?",
    ).get(attemptId)!.completed).toBe(0);
  });

  test("pendingな技術的孤児は降格集計から除外し、明示abortだけを中断として数える", () => {
    const { store } = freshStore();
    store.levelAction("set", 23, T);
    const attempts = Array.from({ length: 5 }, () => store.blockStart("four-three-two", T).attemptId);
    expect(store.getSummary(T).proposal).toBeNull();
    for (const attemptId of attempts) {
      expect(store.abortBlock(attemptId, "four-three-two").status).toBe("aborted");
    }
    const proposal = store.getSummary(T).proposal!;
    expect(proposal.kind).toBe("down");
    expect((proposal.rationale as { triggers: string[] }).triggers).toContain("fttAborts");
  });
});

/** シグナル素材を直接仕込むヘルパ */
function seedAttempt(db: ReturnType<typeof openDb>, ymd: string, kind: string, completed: 0 | 1) {
  db.run("INSERT INTO block_attempts (ts, ymd, kind, completed) VALUES (?, ?, ?, ?)",
    [`${ymd}T09:00:00`, ymd, kind, completed]);
}
function seedBlockXpDay(db: ReturnType<typeof openDb>, ymd: string) {
  db.run("INSERT INTO xp_events (ts, ymd, kind, amount, meta) VALUES (?, ?, 'block', 6, NULL)",
    [`${ymd}T09:00:00`, ymd]);
}

describe("progress-store: 昇格提案（3条件すべて）", () => {
  function boundaryReady() {
    const { db, store } = freshStore();
    store.levelAction("set", 20, T);
    // set は into=0 にするので、境界XP到達まで直接加算（need(20)=25）
    store.addXp("block", 25, {}, T);
    return { db, store };
  }
  test("XP到達だけでは提案しない（練習日・完了率不足）", () => {
    const { store } = boundaryReady();
    expect(store.getSummary(T).proposal).toBeNull();
  });
  test("3条件成立で up 提案（根拠に実値）", () => {
    const { db, store } = boundaryReady();
    for (const d of ["2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-05"]) seedBlockXpDay(db, d);
    for (let i = 0; i < 8; i++) seedAttempt(db, "2026-07-05", "warmup-reading", 1);
    seedAttempt(db, "2026-07-05", "warmup-reading", 0);
    const p = store.getSummary(T).proposal!;
    expect(p.kind).toBe("up");
    expect(p.toLevel).toBe(21);
    expect(p.rationale).toMatchObject({ xpReached: true, practicedDays14: 6 }); // seed5日+addXpの当日
    expect((p.rationale as { completionRate: number }).completionRate).toBeGreaterThanOrEqual(0.7);
  });
  test("却下から7日間は再提案しない・8日目に再提案", () => {
    const { db, store } = boundaryReady();
    for (const d of ["2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-05"]) seedBlockXpDay(db, d);
    for (let i = 0; i < 10; i++) seedAttempt(db, "2026-07-05", "warmup-reading", 1);
    expect(store.getSummary(T).proposal?.kind).toBe("up");
    expect(store.levelAction("decline", undefined, T)!.levelChanged).toBe(false); // 却下はレベル不変=無効化不要
    expect(store.getSummary(T).proposal).toBeNull();
    expect(store.getSummary("2026-07-12").proposal).toBeNull();  // 6日後
    // 8日目: 14日窓に入る練習日を追加で確保
    for (const d of ["2026-07-08", "2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"]) seedBlockXpDay(db, d);
    expect(store.getSummary("2026-07-14").proposal?.kind).toBe("up");
  });
  test("承認で境界を越え、余剰XPで自動昇格も走る", () => {
    const { db, store } = boundaryReady();
    for (const d of ["2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-05"]) seedBlockXpDay(db, d);
    for (let i = 0; i < 10; i++) seedAttempt(db, "2026-07-05", "warmup-reading", 1);
    store.addXp("block", 30, {}, T); // into=55（境界で停止中）
    const s = store.levelAction("accept", undefined, T)!;
    expect(s.summary.level).toBe(22); // 21へ昇格後、余剰30 ≥ need(21)=30 → 22
    expect(s.summary.xpIntoLevel).toBe(0);
    expect(s.levelChanged).toBe(true); // メニューキャッシュ無効化の根拠（退行するとルート側フェイクでは検出できない）
  });
  test("回帰: accept-up のカスケード時、level_events の from は受諾前レベル（「最終-1」にならない）", () => {
    const { db, store } = boundaryReady(); // level 20
    for (const d of ["2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-05"]) seedBlockXpDay(db, d);
    for (let i = 0; i < 10; i++) seedAttempt(db, "2026-07-05", "warmup-reading", 1);
    store.addXp("block", 30, {}, T); // into=55（境界で停止中）
    const s = store.levelAction("accept", undefined, T)!;
    expect(s.summary.level).toBe(22); // カスケードで 20 → 21 → 22
    const row = db.query<{ kind: string; from_level: number; to_level: number }, []>(
      "SELECT kind, from_level, to_level FROM level_events WHERE kind = 'accept-up' ORDER BY id DESC LIMIT 1").get()!;
    expect(row.from_level).toBe(20); // 受諾前レベル（誤実装では 22-1=21 になっていた）
    expect(row.to_level).toBe(22);
  });
});

describe("progress-store: 降格提案", () => {
  test("直近7日の完了率<40%（試行5件以上）で down 提案", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 23, T);
    for (let i = 0; i < 5; i++) seedAttempt(db, "2026-07-04", "roleplay", i === 0 ? 1 : 0); // 1/5=20%
    const p = store.getSummary(T).proposal!;
    expect(p.kind).toBe("down");
    expect(p.toLevel).toBe(15);
    expect((p.rationale as { triggers: string[] }).triggers).toEqual(["lowCompletion"]);
  });
  test("試行4件以下なら完了率条件では提案しない", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 23, T);
    for (let i = 0; i < 4; i++) seedAttempt(db, "2026-07-04", "roleplay", 0);
    expect(store.getSummary(T).proposal).toBeNull();
  });
  test("直近5回の4/3/2中断が3回以上で down 提案", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 23, T);
    // 完了率条件を踏まないよう7日窓の外に置く
    for (const c of [0, 0, 0, 1, 1] as const) seedAttempt(db, "2026-06-20", "four-three-two", c);
    const p = store.getSummary(T).proposal!;
    expect(p.kind).toBe("down");
    expect((p.rationale as { fttAborts: number }).fttAborts).toBe(3);
    expect((p.rationale as { triggers: string[] }).triggers).toEqual(["fttAborts"]);
  });
  test("回帰: 生涯3回の試行（全中断）だけでは提案しない（仕様は直近5回中3回以上）", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 23, T);
    // 完了率条件を踏まないよう7日窓の外に置く。試行が3件しかない（5件窓が埋まっていない）
    for (const c of [0, 0, 0] as const) seedAttempt(db, "2026-06-20", "four-three-two", c);
    expect(store.getSummary(T).proposal).toBeNull();
  });
  test("stage1 では降格提案しない", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 5, T);
    for (let i = 0; i < 6; i++) seedAttempt(db, "2026-07-04", "roleplay", 0);
    expect(store.getSummary(T).proposal).toBeNull();
  });
  test("承認で一つ下のstageアンカーへ・XPは減らない", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 23, T);
    store.addXp("block", 10, {}, T);
    for (let i = 0; i < 5; i++) seedAttempt(db, "2026-07-04", "roleplay", 0);
    const s = store.levelAction("accept", undefined, T)!;
    expect(s.summary.level).toBe(15);
    expect(s.summary.xp).toBe(10); // 累積XPは不変
    expect(s.summary.xpIntoLevel).toBe(0);
    expect(s.levelChanged).toBe(true);
  });
  test("回帰: accept-down の level_events は from=受諾前レベル・to=降格先（from==toにならない）", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 23, T);
    for (let i = 0; i < 5; i++) seedAttempt(db, "2026-07-04", "roleplay", 0);
    const s = store.levelAction("accept", undefined, T)!;
    expect(s.summary.level).toBe(15);
    const row = db.query<{ kind: string; from_level: number; to_level: number }, []>(
      "SELECT kind, from_level, to_level FROM level_events WHERE kind = 'accept-down' ORDER BY id DESC LIMIT 1").get()!;
    expect(row.from_level).toBe(23);
    expect(row.to_level).toBe(15);
  });
  test("降格条件と昇格条件が同時成立したら降格を優先", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 20, T);
    store.addXp("block", 25, {}, T);
    for (const d of ["2026-06-25", "2026-06-26", "2026-06-27", "2026-06-28", "2026-06-29"]) seedBlockXpDay(db, d);
    // 20ブロック窓は高完了率、7日窓は低完了率
    for (let i = 0; i < 15; i++) seedAttempt(db, "2026-06-25", "warmup-reading", 1);
    for (let i = 0; i < 5; i++) seedAttempt(db, "2026-07-04", "roleplay", 0);
    expect(store.getSummary(T).proposal?.kind).toBe("down");
  });
});

describe("progress-store: 低産出シグナルによる降格", () => {
  test("直近の4/3/2低産出ラウンドが閾値超で down 提案（rationaleにlowOutputRounds）", () => {
    const db = openDb(":memory:");
    const store = makeProgressStore(db, () => ({ lowRounds: 4, totalRounds: 6 }));
    store.levelAction("set", 23, T);
    const p = store.getSummary(T).proposal!;
    expect(p.kind).toBe("down");
    expect(p.toLevel).toBe(15);
    expect((p.rationale as { lowOutputRounds: number }).lowOutputRounds).toBe(4);
    expect((p.rationale as { triggers: string[] }).triggers).toEqual(["lowOutput"]);
  });
  test("観測ラウンドが窓未満（totalRounds<6）なら発火しない", () => {
    const db = openDb(":memory:");
    const store = makeProgressStore(db, () => ({ lowRounds: 4, totalRounds: 5 }));
    store.levelAction("set", 23, T);
    expect(store.getSummary(T).proposal).toBeNull();
  });
  test("stage1 では低産出でも降格提案しない", () => {
    const db = openDb(":memory:");
    const store = makeProgressStore(db, () => ({ lowRounds: 6, totalRounds: 6 }));
    store.levelAction("set", 5, T);
    expect(store.getSummary(T).proposal).toBeNull();
  });
});

describe("progress-store: levelAction", () => {
  test("set はレベルを変更し xpIntoLevel を0にする（1未満・非整数は null）", () => {
    const { store } = freshStore();
    const s = store.levelAction("set", 40, T)!;
    expect(s.summary.level).toBe(40);
    expect(s.summary.xpIntoLevel).toBe(0);
    expect(store.levelAction("set", 0, T)).toBeNull();
    expect(store.levelAction("set", 2.5, T)).toBeNull();
    expect(store.levelAction("set", undefined, T)).toBeNull();
  });
  test("提案がないときの accept / decline は null", () => {
    const { store } = freshStore();
    expect(store.levelAction("accept", undefined, T)).toBeNull();
    expect(store.levelAction("decline", undefined, T)).toBeNull();
  });
  test("同一レベルへの set は no-op（xpIntoLevel維持・level_events未記録）", () => {
    const { db, store } = freshStore();
    store.addXp("block", 10, {}, T); // xpIntoLevel を 0 以外にしておく
    const before = store.getSummary(T);
    expect(before.level).toBe(5);
    expect(before.xpIntoLevel).toBe(10);
    const countBefore = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM level_events").get()!.n;

    const s = store.levelAction("set", 5, T)!;
    expect(s.levelChanged).toBe(false);

    expect(s.summary.level).toBe(5);
    expect(s.summary.xpIntoLevel).toBe(10); // リセットされない
    const countAfter = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM level_events").get()!.n;
    expect(countAfter).toBe(countBefore); // level_events 行が増えない
  });
});

describe("progress-store: placementSet", () => {
  test("レベルを変更し placement-set が level_events に記録される", () => {
    const db = openDb(":memory:");
    const store = makeProgressStore(db);
    store.getSummary("2026-07-06"); // ensureRow（Lv5）
    const s = store.placementSet(23, "2026-07-06");
    expect(s!.levelChanged).toBe(true);
    expect(s!.summary.level).toBe(23);
    expect(s!.summary.xpIntoLevel).toBe(0);
    const ev = db.query<{ kind: string; from_level: number; to_level: number }, []>(
      "SELECT kind, from_level, to_level FROM level_events ORDER BY id DESC LIMIT 1").get()!;
    expect(ev).toEqual({ kind: "placement-set", from_level: 5, to_level: 23 });
  });

  test("同一レベルは no-op（xp_into_level 維持・イベント無し）/ 不正値は null", () => {
    const db = openDb(":memory:");
    const store = makeProgressStore(db);
    store.addXp("block", 6, {}, "2026-07-06"); // xpIntoLevel=6
    const s = store.placementSet(5, "2026-07-06");
    expect(s!.levelChanged).toBe(false);
    expect(s!.summary.xpIntoLevel).toBe(6);
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM level_events").get()!;
    expect(count.n).toBe(0);
    expect(store.placementSet(0, "2026-07-06")).toBeNull();
    expect(store.placementSet(2.5, "2026-07-06")).toBeNull();
  });
});

describe("progress-store: xpByDay", () => {
  test("xpByDay は日別・全kind合計を返す", () => {
    const { db, store } = freshStore();
    db.run("INSERT INTO xp_events (ts, ymd, kind, amount, meta) VALUES (?, ?, ?, ?, NULL)",
      ["2026-07-01T00:00:00.000Z", "2026-07-01", "block", 30]);
    db.run("INSERT INTO xp_events (ts, ymd, kind, amount, meta) VALUES (?, ?, ?, ?, NULL)",
      ["2026-07-01T01:00:00.000Z", "2026-07-01", "srs-grade", 2]);
    db.run("INSERT INTO xp_events (ts, ymd, kind, amount, meta) VALUES (?, ?, ?, ?, NULL)",
      ["2026-07-03T00:00:00.000Z", "2026-07-03", "placement", 10]);
    expect(store.xpByDay()).toEqual({ "2026-07-01": 32, "2026-07-03": 10 });
  });
  test("xpByDay はイベントが無ければ空オブジェクト", () => {
    const { store } = freshStore();
    expect(store.xpByDay()).toEqual({});
  });
});
