import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import { makeChunkStore } from "../chunks";
import { makeProgressStore } from "../progress-store";
import { makeSentenceStore, type Sentence } from "../sentences";
import { makeSrsReviewStore } from "../srs-review-store";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { postJson } from "./helpers/http";

const SENTENCE: Sentence = {
  no: 1,
  category_no: 1,
  category: "test",
  domain: "daily",
  en: "I test this sentence.",
  ja: "テストします。",
  note: "",
};

function realSrsDeps() {
  const db = openDb(":memory:");
  const sentenceStore = makeSentenceStore(db, [SENTENCE], new Map());
  const chunkStore = makeChunkStore(db, [SENTENCE.en]);
  db.run(`INSERT INTO collected_chunks
    (id, created, source, prompt_text, en, norm_en, note, stage, due, reviews)
    VALUES (1, '2026-07-10', 'ae', 'prompt', 'A unique chunk.', 'a unique chunk', '', 0, '2026-07-10', 0)`);
  const progressStore = makeProgressStore(db);
  const { deps } = makeTestDeps({
    sentenceStore,
    chunkStore,
    progressStore,
    srsReviewStore: makeSrsReviewStore(db),
  });
  return { db, deps };
}

describe("SRS採点transaction", () => {
  test("同じsentence answerIdの逐次・並列再送でreviewとXPを1回だけ更新する", async () => {
    const { db, deps } = realSrsDeps();
    const h = makeFetchHandler(deps);
    const body = { no: 1, grade: "good", answerId: "answer-sentence-0001" };

    const first = await h(postJson("/api/sentences/grade", body));
    const [retryA, retryB] = await Promise.all([
      h(postJson("/api/sentences/grade", body)),
      h(postJson("/api/sentences/grade", body)),
    ]);
    expect([first.status, retryA.status, retryB.status]).toEqual([200, 200, 200]);
    expect(await retryB.json()).toEqual(await first.clone().json());
    expect(db.query<{ reviews: number }, []>("SELECT reviews FROM sentence_srs WHERE no = 1").get()!.reviews).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM xp_events WHERE kind = 'srs-grade'").get()!.n).toBe(1);
    expect(deps.progressStore.getSummary().xp).toBe(2);
  });

  test("chunk採点もanswerIdで冪等になり、使い回しは409にする", async () => {
    const { db, deps } = realSrsDeps();
    const h = makeFetchHandler(deps);
    const body = { id: 1, grade: "soso", answerId: "answer-chunk-000001" };
    expect((await h(postJson("/api/chunks/grade", body))).status).toBe(200);
    expect((await h(postJson("/api/chunks/grade", body))).status).toBe(200);
    expect((await h(postJson("/api/chunks/grade", { ...body, grade: "bad" }))).status).toBe(409);
    expect(db.query<{ reviews: number }, []>("SELECT reviews FROM collected_chunks WHERE id = 1").get()!.reviews).toBe(1);
    expect(deps.progressStore.getSummary().xp).toBe(1);
  });

  test("XP書込失敗時はsentence更新とreview ledgerもrollbackする", async () => {
    const { db, deps } = realSrsDeps();
    db.run(`CREATE TRIGGER fail_srs_xp BEFORE INSERT ON xp_events
      WHEN NEW.kind = 'srs-grade' BEGIN SELECT RAISE(ABORT, 'xp failed'); END`);
    const res = await makeFetchHandler(deps)(postJson("/api/sentences/grade", {
      no: 1, grade: "good", answerId: "answer-fault-xp-001",
    }));
    expect(res.status).toBe(500);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sentence_srs").get()!.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM srs_review_events").get()!.n).toBe(0);
    expect(deps.progressStore.getSummary().xp).toBe(0);
  });

  test("SRS更新失敗時はXPとreview ledgerを残さない", async () => {
    const { db, deps } = realSrsDeps();
    db.run(`CREATE TRIGGER fail_srs_grade BEFORE INSERT ON sentence_srs
      BEGIN SELECT RAISE(ABORT, 'grade failed'); END`);
    const res = await makeFetchHandler(deps)(postJson("/api/sentences/grade", {
      no: 1, grade: "good", answerId: "answer-fault-srs-01",
    }));
    expect(res.status).toBe(500);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM xp_events").get()!.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM srs_review_events").get()!.n).toBe(0);
  });
});
