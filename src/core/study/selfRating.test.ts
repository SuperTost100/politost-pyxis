import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { planMastery, planSeries, syncGaps } from "../plans/progress";
import { importSmartbook } from "../sources/smartbook";
import { topicExercises } from "./exercises";
import { flagTarget } from "./flags";
import { MASTERY_WEIGHTS, SELF_RATING_WINDOW_MS } from "./mastery";
import { currentSelfRatings, rateExercise } from "./selfRating";
import { studyHandlers } from "./handlers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t0 = 1_700_000_000_000;

function setup() {
  const db = openDatabase(":memory:");
  const source = importSmartbook(
    db,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "demo",
          title: "Fisica",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8("## p1 | Energia\nIl vettore.\n"),
      "esercizi.md": strToU8(
        [
          ':::exercise{id="e1" chapter="1"}\nQuanto vale il lavoro?\n:::solution\nW = F s.\n:::\n:::',
          ':::exercise{id="e2" chapter="1"}\nQuanto vale la potenza?\n:::solution\nP = W / t.\n:::\n:::',
        ].join("\n"),
      ),
    }),
  );
  const { planId } = createPlan(db, {
    title: "Fisica 1",
    sourceIds: [source.sourceId],
  });
  const { id: topicId } = db
    .prepare("SELECT id FROM topics WHERE plan_id=?")
    .get(planId) as { id: string };
  const [first, second] = topicExercises(db, topicId).map(
    (exercise) => exercise.id,
  ) as [string, string];
  const rate = (exerciseId: string, rating: "got" | "missed", at: number) =>
    rateExercise(db, { planId, topicId, exerciseId, rating }, at);
  const mastery = (at: number) =>
    planMastery(db, planId, at).find((topic) => topic.id === topicId)!.mastery;
  return { db, planId, topicId, first, second, rate, mastery };
}

describe("self-rating a practice exercise", () => {
  it("records light evidence: weight 0.5, so a rated exercise moves mastery less than a quiz answer", () => {
    const { db, first, rate, mastery } = setup();
    rate(first, "got", t0);
    expect(MASTERY_WEIGHTS.self).toBe(0.5);
    expect(mastery(t0)).toBeCloseTo(0.5 / 3.5, 10);
    const event = db
      .prepare(
        "SELECT kind, payload_json FROM learning_events WHERE kind = 'answer_given'",
      )
      .get() as { kind: string; payload_json: string };
    expect(JSON.parse(event.payload_json)).toEqual({
      exerciseId: first,
      rating: "got",
      score: 1,
      evidenceKind: "self",
      questionScores: [{ id: first, score: 1 }],
    });
    db.close();
  });

  it("decays like other evidence", () => {
    const { db, first, rate, mastery } = setup();
    rate(first, "got", t0);
    expect(mastery(t0 + 14 * DAY)).toBeCloseTo(0.25 / 3.25, 10);
    db.close();
  });

  it("counts a changed rating once, the newest one, and replays earlier dates as they were", () => {
    const { db, first, rate, mastery } = setup();
    rate(first, "got", t0);
    rate(first, "missed", t0 + HOUR);
    rate(first, "got", t0 + 2 * HOUR);
    expect(
      db.prepare("SELECT count(*) AS n FROM learning_events").get(),
    ).toEqual({ n: 3 });
    expect(mastery(t0 + 2 * HOUR)).toBeCloseTo(0.5 / 3.5, 10);
    rate(first, "missed", t0 + 3 * HOUR);
    expect(mastery(t0 + 3 * HOUR)).toBe(0);
    // Before the change the earlier rating stood.
    expect(mastery(t0 + 2 * HOUR + 1)).toBeCloseTo(0.5 / 3.5, 6);
    db.close();
  });

  it("writes nothing when the same rating is chosen again", () => {
    const { db, first, rate } = setup();
    rate(first, "got", t0);
    rate(first, "got", t0 + HOUR);
    expect(
      db.prepare("SELECT count(*) AS n FROM learning_events").get(),
    ).toEqual({ n: 1 });
    db.close();
  });

  it("counts a rating from a new visit as new evidence, and the page starts unrated", () => {
    const { db, topicId, first, second, rate, mastery } = setup();
    rate(first, "got", t0);
    rate(second, "missed", t0 + 3 * HOUR);
    expect([...currentSelfRatings(db, topicId, t0 + 4 * HOUR)]).toEqual([
      [first, "got"],
      [second, "missed"],
    ]);
    const next = t0 + SELF_RATING_WINDOW_MS + HOUR;
    expect(currentSelfRatings(db, topicId, next).size).toBe(1);
    expect(
      currentSelfRatings(db, topicId, t0 + 2 * SELF_RATING_WINDOW_MS).size,
    ).toBe(0);
    rate(first, "got", t0 + DAY);
    // The first exercise's two ratings both count (the old one a day old), and the second exercise's miss adds weight.
    const decay = 0.5 ** (1 / 14);
    const decayed = 0.5 * 0.5 ** ((DAY - 3 * HOUR) / (14 * DAY));
    expect(mastery(t0 + DAY)).toBeCloseTo(
      (0.5 * decay + 0.5) / (3 + 0.5 * decay + 0.5 + decayed),
      8,
    );
    db.close();
  });

  it("is excluded for a flagged exercise, like its other evidence", () => {
    const { db, first, second, rate, mastery } = setup();
    rate(first, "got", t0);
    rate(second, "got", t0);
    expect(mastery(t0)).toBeCloseTo(1 / 4, 10);
    flagTarget(db, "exercise", first, "Wrong", t0);
    expect(mastery(t0)).toBeCloseTo(0.5 / 3.5, 10);
    flagTarget(db, "exercise", second, "Wrong", t0);
    expect(mastery(t0)).toBe(0);
    db.close();
  });

  it("never opens or closes a gap, and is no solved exercise or wrong answer", () => {
    const { db, planId, topicId, first, second, rate } = setup();
    // Many misses: a quiz would open a gap.
    for (let i = 0; i < 3; i++) {
      rate(first, "missed", t0 + i * DAY);
      rate(second, "missed", t0 + i * DAY + 1);
    }
    syncGaps(db, planId, t0 + 4 * DAY);
    expect(db.prepare("SELECT count(*) AS n FROM gaps").get()).toEqual({
      n: 0,
    });
    let series = planSeries(db, planId, t0 + 4 * DAY);
    expect(series.gaps).toEqual([]);
    expect(series.topics[0]!.exercisesSolved).toBe(0);

    // With a gap open, clean "Got it" ratings do not close it and "Missed it" ratings are not wrong answers on it.
    db.prepare(
      "INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES ('weak', 'answer_given', ?, ?, ?, ?)",
    ).run(
      planId,
      topicId,
      JSON.stringify({
        score: 0,
        scores: [0, 0],
        evidenceKind: "quiz",
        questionScores: [
          { id: "q1", score: 0 },
          { id: "q2", score: 0 },
        ],
      }),
      t0 + 5 * DAY,
    );
    syncGaps(db, planId, t0 + 5 * DAY);
    expect(
      db
        .prepare("SELECT count(*) AS n FROM gaps WHERE closed_at IS NULL")
        .get(),
    ).toEqual({ n: 1 });
    const wrong = planSeries(db, planId, t0 + 5 * DAY).gaps[0]!.wrongAnswers;
    for (let day = 6; day < 12; day++) {
      rate(first, day % 2 ? "got" : "missed", t0 + day * DAY);
      rate(second, "got", t0 + day * DAY + 1);
    }
    syncGaps(db, planId, t0 + 12 * DAY);
    expect(
      db
        .prepare("SELECT count(*) AS n FROM gaps WHERE closed_at IS NULL")
        .get(),
    ).toEqual({ n: 1 });
    series = planSeries(db, planId, t0 + 12 * DAY);
    expect(series.gaps).toHaveLength(1);
    expect(series.gaps[0]!.wrongAnswers).toBe(wrong);
    expect(series.topics[0]!.exercisesSolved).toBe(0);
    db.close();
  });

  it("shows the current rating on the exercise list and refuses unknown topics and exercises", () => {
    const { db, planId, topicId, first, rate } = setup();
    const handlers = studyHandlers(db);
    expect(
      handlers
        .exercises({ topicId, planId })
        .exercises.map((exercise) => exercise.rating),
    ).toEqual([null, null]);
    handlers.rateExercise({
      planId,
      topicId,
      exerciseId: first,
      rating: "missed",
    });
    expect(
      handlers
        .exercises({ topicId, planId })
        .exercises.map((exercise) => exercise.rating),
    ).toEqual(["missed", null]);
    expect(() => rate("nope", "got", t0)).toThrow("exercise-missing");
    expect(() =>
      rateExercise(db, {
        planId,
        topicId: "nope",
        exerciseId: first,
        rating: "got",
      }),
    ).toThrow("topic-missing");
    expect(() =>
      rateExercise(db, {
        planId: "other",
        topicId,
        exerciseId: first,
        rating: "got",
      }),
    ).toThrow("topic-missing");
    db.close();
  });
});
