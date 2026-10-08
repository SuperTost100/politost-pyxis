import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import type { Runner } from "../jobs/runner";
import { createPlan } from "../plans/create";
import { recordStep } from "../plans/steps";
import { importSmartbook } from "../sources/smartbook";
import { saveQuiz, startAttempt } from "./attempt";
import { dueCards, rateCard, seedCards } from "./cards";
import { studyHandlers } from "./handlers";
import { saveQuizDraft } from "./quizJobs";
import { finalizeAttempt } from "./quizGrading";
import { readGapDrill } from "./gapDrill";
import { discardReview, readReview, reviewWaiting, skipDrill, startReview } from "./review";
import { insertGap } from "./gapRows";
import { startTopicQuiz } from "./topicQuiz";

/** Three chapters with three exercises each, and a fourth chapter with none. */
function setup() {
  const chapters = [1, 2, 3, 4];
  const files: Record<string, string> = {
    "smartbook.json": JSON.stringify({
      id: "rev",
      title: "Rev",
      access: "public",
      chapters: chapters.map((number) => ({
        id: `c${number}`,
        number,
        title: `Tema ${number}`,
        file: `0${number}.md`,
      })),
    }),
    "esercizi.md": [1, 2, 3]
      .flatMap((number) =>
        [1, 2, 3].map(
          (k) =>
            `:::exercise{id="q${number}${k}" chapter="${number}"}\nDomanda ${number}.${k}?\n:::solution\nrisposta ${number}.${k}\n:::\n:::\n`,
        ),
      )
      .join("\n"),
  };
  for (const number of chapters)
    files[`chapters/0${number}.md`] = `## p1 | Tema ${number}\nTesto ${number}.\n`;
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  const imported = importSmartbook(
    db,
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))),
  );
  const { planId } = createPlan(db, { title: "Rev", sourceIds: [imported.sourceId] });
  const topics = (
    db.prepare("SELECT id FROM topics WHERE plan_id = ? ORDER BY position").all(planId) as Array<{ id: string }>
  ).map((row) => row.id);
  // The path's frontier is the topic whose lesson the student read last.
  recordStep(db, planId, { activity: "lesson", topicId: topics[0]! });
  return { db, planId, topics };
}
type Fixture = ReturnType<typeof setup>;

/** A blank quiz on the topic: every answer wrong, which opens its gap. */
function openGap({ db, planId }: Fixture, topicId: string) {
  const { attemptId } = startTopicQuiz(db, planId, topicId);
  finalizeAttempt(db, attemptId, {});
}

function storedQuestions(db: Fixture["db"], attemptId: string) {
  const row = db
    .prepare("SELECT i.body_json FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ?")
    .get(attemptId) as { body_json: string };
  return (
    JSON.parse(row.body_json) as {
      questions: Array<{ id: string; topicId?: string; answer: { kind: string } }>;
    }
  ).questions;
}

describe("mixed review (LES-13)", () => {
  it("stores one queue: a new card, a reload or an Again rating never changes it", () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    openGap(fx, topics[2]!);
    seedCards(db, {
      planId,
      topicId: topics[0]!,
      pairs: ["a", "b", "c"].map((front) => ({ front, back: front })),
    });
    const first = startReview(db, planId, { count: 2 });
    expect(first.cards).toHaveLength(2);
    expect(first.progress.cardsTotal).toBe(2);

    seedCards(db, { planId, topicId: topics[0]!, pairs: [{ front: "d", back: "d" }] });
    const resumed = startReview(db, planId, { count: 20 });
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.attemptId).toBe(first.attemptId);
    expect(resumed.cards.map((card) => card.id)).toEqual(first.cards.map((card) => card.id));
    expect(db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE plan_id = ?").get(planId)).toMatchObject({ n: 2 });

    rateCard(db, first.cards[0]!.id, "again", Date.now());
    const reopened = readReview(db, planId)!;
    expect(reopened.cards.map((card) => card.id)).toEqual([first.cards[1]!.id]);
    expect(reopened.progress.cardsDone).toBe(1);
    expect(reopened.attemptId).toBe(first.attemptId);
  });

  it("counts cards, then questions, as one progress and finishes the session", () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    openGap(fx, topics[2]!);
    seedCards(db, { planId, topicId: topics[0]!, pairs: [{ front: "a", back: "a" }] });
    const session = startReview(db, planId);
    const { cardsTotal, questionsTotal, total } = session.progress;
    expect([cardsTotal, questionsTotal > 0, total]).toEqual([1, true, 1 + questionsTotal]);
    expect(session.next).toBe("cards");

    rateCard(db, session.cards[0]!.id, "good", Date.now());
    const atQuestions = readReview(db, planId)!;
    expect(atQuestions.next).toBe("questions");
    expect(atQuestions.progress.done).toBe(1);

    const first = session.questions[0]!.id;
    saveQuizDraft(db, session.attemptId, { [first]: "x" }, 0, planId);
    expect(readReview(db, planId)!.progress.done).toBe(2);

    finalizeAttempt(db, session.attemptId, { [first]: "x" });
    expect(readReview(db, planId)).toBeNull();
    expect(startReview(db, planId).sessionId).not.toBe(session.sessionId);
  });

  it("asks about open gaps and the path's frontier, not the latest weak score", () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    // Topic 3 has an open gap; topic 2 only has a weak latest score and no gap.
    openGap(fx, topics[2]!);
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES ('weak-latest', 'answer_given', ?, ?, '{"score":0}', ?)`,
    ).run(planId, topics[1], Date.now() + 5000);
    const session = startReview(db, planId);
    const stored = storedQuestions(db, session.attemptId);
    const asked = new Set(stored.map((question) => question.topicId).filter(Boolean));
    expect(asked).toEqual(new Set([topics[0], topics[2]]));
    expect(stored.some((question) => question.topicId === topics[1])).toBe(false);
  });

  it("asks for the durable gap drill only when a gap has no questions", () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    openGap(fx, topics[2]!);
    // Topic 4 has no exercises; its gap comes from a saved attempt.
    const itemId = saveQuiz(db, planId, [
      { id: "m1", stem: "Quale?", grade: { kind: "open", answer: "", reference: "x" } },
      { id: "m2", stem: "E poi?", grade: { kind: "open", answer: "", reference: "y" } },
    ]);
    db.prepare("UPDATE items SET topic_id = ? WHERE id = ?").run(topics[3], itemId);
    finalizeAttempt(db, startAttempt(db, planId, itemId).attemptId, {});
    const started: Array<{ kind: string; topicId: string }> = [];
    const runner = {
      start: (kind: string, params: { topicId: string }) => {
        started.push({ kind, topicId: params.topicId });
        return "job";
      },
    } as unknown as Runner;
    startReview(db, planId, { runner });
    expect(started).toEqual([{ kind: "gap-drill", topicId: topics[3] }]);
  });

  it("records mastery per topic and grades free text with the model, not by exact match", async () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    openGap(fx, topics[2]!);
    const session = startReview(db, planId);
    const stored = storedQuestions(db, session.attemptId);
    // No completion question survives: its reference sentence would be matched literally.
    expect(stored.some((question) => question.answer.kind === "completion")).toBe(false);
    const open = stored.find((question) => question.answer.kind === "open")!;
    const calls: string[] = [];
    const run: GenerateInput["run"] = async (input) => {
      calls.push(input.prompt);
      const structured = { score: 0.8, explanation: "Mostly right." };
      return { structured, text: JSON.stringify(structured), provider: "claude", model: "grader", inputTokens: 1 };
    };
    const lastEvent = () =>
      (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM learning_events").get() as { n: number }).n;
    const completed = () =>
      db.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'lesson_completed'").get();
    const [seenEvents, seenCompleted] = [lastEvent(), completed()];
    const result = (await studyHandlers(db, undefined, run).quizSubmit({
      attemptId: session.attemptId,
      picks: { [open.id]: "una parafrasi corretta" },
    })) as { results: Array<{ id: string; score: number }> };
    expect(calls).toHaveLength(1);
    expect(result.results.find((row) => row.id === open.id)?.score).toBe(0.8);
    const events = db
      .prepare("SELECT topic_id, payload_json FROM learning_events WHERE kind = 'answer_given' AND rowid > ?")
      .all(seenEvents) as Array<{ topic_id: string; payload_json: string }>;
    // One event per topic, counting exactly that topic's questions; the unrelated topic gets none.
    const perTopic = new Map<string, number>();
    for (const question of stored)
      if (question.topicId) perTopic.set(question.topicId, (perTopic.get(question.topicId) ?? 0) + 1);
    expect(events.map((row) => row.topic_id).sort()).toEqual([...perTopic.keys()].sort());
    for (const row of events) {
      const payload = JSON.parse(row.payload_json) as { scores: number[]; evidenceKind: string };
      expect(payload.scores).toHaveLength(perTopic.get(row.topic_id)!);
      expect(payload.evidenceKind).toBe("quiz");
    }
    expect(events.some((row) => row.topic_id === topics[1])).toBe(false);
    expect(completed()).toEqual(seenCompleted);
  });
});

/** A runner that only records jobs: the drill's model work is simulated by `finishDrill`. */
function fakeRunner(db: Fixture["db"]) {
  const started: string[] = [];
  const runner = {
    start: (kind: string, params: object) => {
      const id = `drill-${started.length + 1}`;
      started.push(id);
      db.prepare(
        "INSERT INTO jobs (id, kind, state, params_json, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)",
      ).run(id, kind, JSON.stringify(params), Date.now(), Date.now());
      return id;
    },
  } as unknown as Runner;
  return { runner, started };
}

/** What a succeeded gap-drill job leaves behind: a quiz item on the topic, its attempt, and the job's params. */
function finishDrill(fx: Fixture, jobId: string, topicId: string, count = 6, explanation?: string) {
  const { db, planId } = fx;
  const itemId = saveQuiz(
    db,
    planId,
    Array.from({ length: count }, (_, index) => ({
      id: `drill-q${index}`,
      stem: index === 0 ? `Completa {{1}} ${index}` : `Vero ${index}?`,
      generatedBy: { provider: "claude", model: "drill-model" },
      grade:
        index === 0
          ? { kind: "completion" as const, answers: [], accepted: [["risposta"]] }
          : { kind: "tf" as const, picked: false, correct: true },
    })),
  );
  db.prepare("UPDATE items SET topic_id = ? WHERE id = ?").run(topicId, itemId);
  if (explanation) db.prepare("UPDATE items SET body_json = json_set(body_json, '$.explanation', ?) WHERE id = ?").run(explanation, itemId);
  const { attemptId } = startAttempt(db, planId, itemId);
  const job = db.prepare("SELECT params_json FROM jobs WHERE id = ?").get(jobId) as { params_json: string };
  db.prepare("UPDATE jobs SET state = 'succeeded', params_json = ? WHERE id = ?").run(
    JSON.stringify({ ...JSON.parse(job.params_json), itemId, attemptId }),
    jobId,
  );
  return { itemId, attemptId };
}

/** Topic 4 has no exercises; its gap comes from a saved attempt, so a review asks for a drill. */
function gapWithoutQuestions(fx: Fixture) {
  const { db, planId, topics } = fx;
  const itemId = saveQuiz(db, planId, [
    { id: "m1", stem: "Quale?", grade: { kind: "open", answer: "", reference: "x" } },
    { id: "m2", stem: "E poi?", grade: { kind: "open", answer: "", reference: "y" } },
  ]);
  db.prepare("UPDATE items SET topic_id = ? WHERE id = ?").run(topics[3], itemId);
  finalizeAttempt(db, startAttempt(db, planId, itemId).attemptId, {});
}

describe("gap drills join the review queue (LES-13)", () => {
  it("adopts a finished drill into the same attempt once, keeps picks and events, and never calls the model twice", async () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    openGap(fx, topics[2]!);
    gapWithoutQuestions(fx);
    const { runner, started } = fakeRunner(db);
    const first = startReview(db, planId, { runner });
    expect(started).toHaveLength(1);
    const before = first.questions.map((question) => question.id);
    // Three gap exercises from topic 3 are in; the drill owes the other two of the five gap questions.
    expect(first.progress.questionsPending).toBe(2);
    expect(first.progress.total).toBe(first.progress.questionsTotal + 2);
    expect(first.progress.done).toBe(0);
    expect(first.drills).toMatchObject([{ topicId: topics[3], jobId: "drill-1", state: "queued", want: 2 }]);

    saveQuizDraft(db, first.attemptId, { [before[0]!]: "x" }, 0, planId);
    const handlers = studyHandlers(db);
    expect(() => handlers.quizSubmit({ attemptId: first.attemptId, picks: {} })).toThrow("review-drills-pending");

    // Nothing is added, nor restarted, while the job is unfinished.
    expect(startReview(db, planId, { runner }).sessionId).toBe(first.sessionId);
    expect(started).toHaveLength(1);

    const drill = finishDrill(fx, "drill-1", topics[3]!);
    const adopted = readReview(db, planId)!;
    expect(adopted.attemptId).toBe(first.attemptId);
    expect(adopted.questions.map((question) => question.id)).toEqual([...before, "drill-q1", "drill-q2"]);
    expect(adopted.progress).toMatchObject({ questionsPending: 0, questionsDone: 1, total: before.length + 2 });
    expect(adopted.drills).toEqual([]);
    // Reading again, restarting and reloading add nothing and keep the draft pick.
    for (const again of [readReview(db, planId)!, startReview(db, planId, { runner })])
      expect(again.questions).toHaveLength(before.length + 2);
    expect(started).toHaveLength(1);
    const stored = storedQuestions(db, first.attemptId);
    expect(stored.filter((question) => question.topicId === topics[3]).map((question) => question.id)).toEqual([
      "drill-q1",
      "drill-q2",
    ]);
    expect(readReview(db, planId)!.progress.done).toBe(1);
    // Its separate quiz is no longer offered, and finishing no longer waits.
    expect(readGapDrill(db, planId, topics[3]!)).toBeNull();
    expect(reviewWaiting(db, first.attemptId)).toBe(false);
    expect(drill.attemptId).not.toBe(first.attemptId);

    // One answer event per topic, drill topic included, counted over exactly its adopted questions.
    const seen = (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM learning_events").get() as { n: number }).n;
    finalizeAttempt(db, first.attemptId, Object.fromEntries(stored.map((question) => [question.id, "x"])));
    const events = db
      .prepare("SELECT topic_id, payload_json FROM learning_events WHERE kind = 'answer_given' AND rowid > ?")
      .all(seen) as Array<{ topic_id: string; payload_json: string }>;
    const drillEvents = events.filter((row) => row.topic_id === topics[3]);
    expect(drillEvents).toHaveLength(1);
    expect((JSON.parse(drillEvents[0]!.payload_json) as { scores: number[] }).scores).toHaveLength(2);
    expect(new Set(events.map((row) => row.topic_id)).size).toBe(events.length);
  });

  it("keeps a review of only drills, shows recovery for a failed job, and finishes once the job is cancelled", () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    gapWithoutQuestions(fx);
    // The frontier topic is mastered, so no unseen item is added and the review is only the drill.
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES ('mastered', 'answer_given', ?, ?, '{"score":1}', ?)`,
    ).run(planId, topics[0], Date.now() + 5000);
    const { runner } = fakeRunner(db);
    const session = startReview(db, planId, { runner });
    expect(session).toMatchObject({ next: "waiting", cards: [], questions: [] });
    expect(session.attemptId).not.toBe("");
    expect(session.progress).toMatchObject({ total: 5, done: 0, questionsPending: 5 });

    db.prepare("UPDATE jobs SET state = 'failed' WHERE id = 'drill-1'").run();
    const failed = readReview(db, planId)!;
    expect(failed.drills).toMatchObject([{ jobId: "drill-1", state: "failed" }]);
    expect(failed.progress.questionsPending).toBe(5);

    db.prepare("UPDATE jobs SET state = 'queued' WHERE id = 'drill-1'").run();
    finishDrill(fx, "drill-1", topics[3]!);
    const adopted = readReview(db, planId)!;
    expect(adopted).toMatchObject({ next: "questions", attemptId: session.attemptId });
    expect(adopted.questions).toHaveLength(5);
    expect(adopted.questions.some((question) => question.stem.includes("{{"))).toBe(false);
  });

  it("lets a cancelled drill end the wait, and a discard start a new review without losing cards or events", () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    openGap(fx, topics[2]!);
    gapWithoutQuestions(fx);
    seedCards(db, { planId, topicId: topics[0]!, pairs: [{ front: "a", back: "a" }] });
    const { runner, started } = fakeRunner(db);
    const session = startReview(db, planId, { runner });
    rateCard(db, session.cards[0]!.id, "good", Date.now());
    db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = 'drill-1'").run();
    expect(readReview(db, planId)!.drills).toMatchObject([{ state: "cancelled" }]);
    expect(readReview(db, planId)!.progress.questionsPending).toBe(0);
    expect(reviewWaiting(db, session.attemptId)).toBe(false);

    db.prepare("UPDATE jobs SET state = 'running' WHERE id = 'drill-1'").run();
    const counts = () => [
      db.prepare("SELECT COUNT(*) AS n FROM cards").get(),
      db.prepare("SELECT COUNT(*) AS n FROM card_reviews").get(),
      db.prepare("SELECT COUNT(*) AS n FROM learning_events").get(),
    ];
    const kept = counts();
    discardReview(db, planId);
    expect(readReview(db, planId)).toBeNull();
    expect(counts()).toEqual(kept);
    // The new review reuses the running job instead of paying for another drill.
    const next = startReview(db, planId, { runner });
    expect(next.sessionId).not.toBe(session.sessionId);
    expect(started).toHaveLength(1);
    expect(next.drills).toMatchObject([{ jobId: "drill-1" }]);
  });
});

describe("a drill that cannot finish does not trap the review (LES-13)", () => {
  /** A review waiting on one drill: topic 4's gap has no exercises, the frontier is mastered, so the drill is all there is. */
  function drillOnly() {
    const fx = setup();
    const { db, planId, topics } = fx;
    gapWithoutQuestions(fx);
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES ('mastered', 'answer_given', ?, ?, '{"score":1}', ?)`,
    ).run(planId, topics[0], Date.now() + 5000);
    const { runner } = fakeRunner(db);
    const session = startReview(db, planId, { runner });
    return { ...fx, session };
  }

  it("goes on without a failed drill: the choice is stored in the review and holds whatever the job does", () => {
    const fx = drillOnly();
    const { db, planId, session } = fx;
    db.prepare("UPDATE jobs SET state = 'failed' WHERE id = 'drill-1'").run();
    expect(reviewWaiting(db, session.attemptId)).toBe(true);
    expect(() => studyHandlers(db).quizSubmit({ attemptId: session.attemptId, picks: {} })).toThrow("review-drills-pending");
    // Cancelling a failed job changes nothing, and dismissing leaves it failed: the skip is what ends the wait.
    expect(studyHandlers(db).reviewSkipDrill({ planId, jobId: "drill-1" })).toEqual({ ok: true });
    expect(reviewWaiting(db, session.attemptId)).toBe(false);
    // Nothing else is left in this review, so it is finished rather than waiting.
    expect(readReview(db, planId)).toBeNull();
    // Reload, a repeated skip and the job vanishing (dismissed) change nothing.
    skipDrill(db, planId, "drill-1");
    db.prepare("DELETE FROM jobs WHERE id = 'drill-1'").run();
    expect(reviewWaiting(db, session.attemptId)).toBe(false);
    expect(readReview(db, planId)).toBeNull();
  });

  it("stops only the drill it skipped: not an unknown job, another plan's job or an adopted drill", () => {
    const fx = drillOnly();
    const { db, planId, session } = fx;
    db.prepare("INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan-b', 'Altro', 'ready', 1, 1)").run();
    for (const id of ["foreign", "unlisted"])
      db.prepare(
        "INSERT INTO jobs (id, kind, state, params_json, created_at, updated_at) VALUES (?, 'gap-drill', 'queued', ?, 1, 1)",
      ).run(id, JSON.stringify({ planId: id === "foreign" ? "plan-b" : planId, topicId: "t" }));
    const cancelled: string[] = [];
    const runner = { register: () => undefined, cancel: (id: string) => void cancelled.push(id) } as unknown as Runner;
    const study = studyHandlers(db, runner);
    const sessionRow = () => (db.prepare("SELECT body_json FROM items WHERE kind = 'review_session'").get() as { body_json: string }).body_json;
    const before = sessionRow();
    // Same reply, no side effect, for a job this review never queued, a job of another plan and the right job on the wrong plan.
    expect(study.reviewSkipDrill({ planId, jobId: "unlisted" })).toEqual({ ok: true });
    expect(study.reviewSkipDrill({ planId, jobId: "foreign" })).toEqual({ ok: true });
    expect(study.reviewSkipDrill({ planId: "plan-b", jobId: "drill-1" })).toEqual({ ok: true });
    expect(cancelled).toEqual([]);
    expect(sessionRow()).toBe(before);
    // An adopted drill's questions are already in the review; it is not skipped or stopped.
    const adopted = JSON.parse(before) as { drills: Array<Record<string, unknown>> };
    adopted.drills[0]!.adopted = true;
    db.prepare("UPDATE items SET body_json = ? WHERE kind = 'review_session'").run(JSON.stringify(adopted));
    expect(study.reviewSkipDrill({ planId, jobId: "drill-1" })).toEqual({ ok: true });
    expect(cancelled).toEqual([]);
    delete adopted.drills[0]!.adopted;
    db.prepare("UPDATE items SET body_json = ? WHERE kind = 'review_session'").run(JSON.stringify(adopted));
    // The matching drill is skipped durably and its job stopped, live or failed.
    expect(study.reviewSkipDrill({ planId, jobId: "drill-1" })).toEqual({ ok: true });
    expect(cancelled).toEqual(["drill-1"]);
    expect(reviewWaiting(db, session.attemptId)).toBe(false);
    db.prepare("UPDATE jobs SET state = 'failed' WHERE id = 'drill-1'").run();
    expect(reviewWaiting(db, session.attemptId)).toBe(false);
  });

  it("lists a skipped drill beside the questions that remain, without counting it", () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    openGap(fx, topics[2]!);
    gapWithoutQuestions(fx);
    const { runner } = fakeRunner(db);
    const session = startReview(db, planId, { runner });
    expect(session.progress.questionsPending).toBe(2);
    db.prepare("UPDATE jobs SET state = 'interrupted' WHERE id = 'drill-1'").run();
    expect(readReview(db, planId)!.drills).toMatchObject([{ state: "interrupted" }]);
    skipDrill(db, planId, "drill-1");
    const skipped = readReview(db, planId)!;
    expect(skipped.drills).toMatchObject([{ jobId: "drill-1", topicId: topics[3], state: "skipped" }]);
    expect(skipped.progress.questionsPending).toBe(0);
    expect(skipped.progress.total).toBe(skipped.progress.questionsTotal);
    expect(skipped.next).toBe("questions");
    expect(reviewWaiting(db, session.attemptId)).toBe(false);
    // Late success of the skipped job adds nothing.
    finishDrill(fx, "drill-1", topics[3]!);
    expect(readReview(db, planId)!.questions).toHaveLength(skipped.questions.length);
  });

  it("stops waiting for a drill whose gap has closed, and drops it", () => {
    const fx = drillOnly();
    const { db, planId, topics, session } = fx;
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = 'drill-1'").run();
    expect(reviewWaiting(db, session.attemptId)).toBe(true);
    // The gap closes while the drill builds; the drill would throw gap-missing, and the review must not wait for it.
    db.prepare("UPDATE gaps SET closed_at = ? WHERE topic_id = ?").run(Date.now(), topics[3]);
    db.prepare("UPDATE jobs SET state = 'failed' WHERE id = 'drill-1'").run();
    expect(reviewWaiting(db, session.attemptId)).toBe(false);
    expect(readReview(db, planId)).toBeNull();
    finishDrill(fx, "drill-1", topics[3]!);
    expect(reviewWaiting(db, session.attemptId)).toBe(false);
    expect(storedQuestions(db, session.attemptId)).toHaveLength(0);
  });

  it("queues one drill per gap, so two misconceptions on one topic are both drilled", () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    gapWithoutQuestions(fx);
    const first = db.prepare("SELECT id FROM gaps WHERE topic_id = ?").pluck().get(topics[3]) as string;
    const second = insertGap(db, { planId, topicId: topics[3]!, openedAt: Date.now() + 1, origin: "misconception", misconception: "Another idea." });
    const { runner, started } = fakeRunner(db);
    const session = startReview(db, planId, { runner });
    expect(started).toHaveLength(2);
    expect(session.drills.map((drill) => drill.gapId).sort()).toEqual([first, second].sort());
    expect(session.drills.map((drill) => drill.want).sort()).toEqual([2, 3]);
    // Each job is for its own gap.
    const params = db.prepare("SELECT params_json FROM jobs WHERE kind = 'gap-drill' ORDER BY id").all() as Array<{ params_json: string }>;
    expect(params.map((row) => JSON.parse(row.params_json).gapId).sort()).toEqual([first, second].sort());
  });

  it("carries a drill's explanation and gap into the review once it is adopted", () => {
    const fx = drillOnly();
    const { db, planId, topics, session } = fx;
    const gapId = db.prepare("SELECT id FROM gaps WHERE topic_id = ?").pluck().get(topics[3]) as string;
    finishDrill(fx, "drill-1", topics[3]!, 6, "Velocity has a direction.");
    const adopted = readReview(db, planId)!;
    expect(adopted.explanations).toEqual([
      { topicId: topics[3], gapId, title: expect.any(String), text: "Velocity has a direction." },
    ]);
    expect(storedQuestions(db, session.attemptId).every((question) => (question as { gapId?: string }).gapId === gapId)).toBe(true);
  });
});

const archive = (fx: Fixture, topicId: string) =>
  fx.db.prepare("UPDATE topics SET archived_at = ? WHERE id = ?").run(Date.now(), topicId);

describe("archived topics in the review queue (PLAN-13)", () => {
  it("never selects an archived topic's cards for a new review, or lists them as due", () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    for (const topicId of [topics[0]!, topics[1]!])
      seedCards(db, { planId, topicId, pairs: [{ front: topicId, back: "b" }] });
    archive(fx, topics[1]!);
    const session = startReview(db, planId);
    expect(session.cards.map((card) => card.topicId)).toEqual([topics[0]]);
    expect(session.progress).toMatchObject({ cardsTotal: 1, cardsDone: 0 });
    expect(dueCards(db, planId, Date.now(), topics[1]!)).toEqual([]);
  });

  it("drops cards archived mid-review from the totals instead of counting them as done", () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    for (const topicId of [topics[0]!, topics[1]!])
      seedCards(db, { planId, topicId, pairs: [{ front: `${topicId}-a`, back: "b" }, { front: `${topicId}-b`, back: "b" }] });
    const started = startReview(db, planId);
    expect(started.progress).toMatchObject({ cardsTotal: 4, cardsDone: 0 });
    const rated = started.cards.find((card) => card.topicId === topics[0])!;
    rateCard(db, rated.id, "good", Date.now());
    archive(fx, topics[1]!);
    const after = readReview(db, planId)!;
    expect(after.cards.map((card) => card.topicId)).toEqual([topics[0]]);
    expect(after.progress).toMatchObject({ cardsTotal: 2, cardsDone: 1, total: 2 + after.progress.questionsTotal });
    rateCard(db, after.cards[0]!.id, "good", Date.now());
    // Everything shown was done: the queue moves on to its questions rather than waiting on hidden cards.
    const done = readReview(db, planId)!;
    expect(done.next).not.toBe("cards");
    expect(done.progress).toMatchObject({ cardsTotal: 2, cardsDone: 2 });
  });

  it("does not make a review wait for a drill whose topic was archived", () => {
    const fx = setup();
    const { db, planId, topics } = fx;
    gapWithoutQuestions(fx);
    seedCards(db, { planId, topicId: topics[0]!, pairs: [{ front: "a", back: "a" }] });
    const { runner } = fakeRunner(db);
    const session = startReview(db, planId, { runner });
    expect(session.progress.questionsPending).toBeGreaterThan(0);
    archive(fx, topics[3]!);
    db.prepare("UPDATE jobs SET state = 'failed' WHERE id = 'drill-1'").run();
    const after = readReview(db, planId)!;
    expect(after.progress.questionsPending).toBe(0);
    expect(after.drills).toEqual([]);
    expect(reviewWaiting(db, session.attemptId)).toBe(false);
    // A drill that finishes late adds nothing for the archived topic.
    finishDrill(fx, "drill-1", topics[3]!);
    expect(readReview(db, planId)!.questions).toHaveLength(after.questions.length);
  });
});
