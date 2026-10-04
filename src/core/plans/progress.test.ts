import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { listPlans, nextLesson } from "./create";
import { planMastery, planSeries } from "./progress";
import { flagTarget } from "../study/flags";
import { newCard, review, retrievability } from "../study/schedule";
import { listSimulations } from "../study/simulation";

describe("planMastery", () => {
  it("removes flagged quiz questions from mastery even when flagged after submission", () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('p', 'Physics', 'ready', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t', 'p', 'Motion', 0, 1)",
    ).run();
    db.prepare(
      "INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES ('e', 'answer_given', 'p', 't', ?, 1000)",
    ).run(
      JSON.stringify({
        score: 0.5,
        scores: [1, 0],
        questionScores: [
          { id: "correct", sourceIds: [], score: 1 },
          { id: "wrong", sourceIds: ["exercise"], score: 0 },
        ],
      }),
    );
    expect(planMastery(db, "p", 1000)[0]!.mastery).toBe(0.2);
    flagTarget(db, "exercise", "exercise");
    expect(planMastery(db, "p", 1000)[0]!.mastery).toBe(0.25);
    flagTarget(db, "exercise", "correct");
    expect(planMastery(db, "p", 1000)[0]!.mastery).toBe(0);
    db.close();
  });
  it("does not treat a finished lesson as mastery", () => {
    const db = openDatabase(":memory:");
    const now = 1_700_000_000_000;
    const planId = uuidv7(1);
    const topicId = uuidv7(2);
    db.prepare(
      `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES (?, 'Fisica', 'ready', 1, 1)`,
    ).run(planId);
    db.prepare(
      `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, 'Moti', 0, 1)`,
    ).run(topicId, planId);
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'lesson_completed', ?, ?, '{}', ?)`,
    ).run(uuidv7(3), planId, topicId, now);
    const rows = planMastery(db, planId, now);
    expect(rows).toEqual([{ id: topicId, title: "Moti", mastery: 0 }]);
  });

  it("lists a plan with its subject, days and mastery", () => {
    const db = openDatabase(":memory:");
    const subjectId = uuidv7(4);
    const planId = uuidv7(1);
    const now = Date.UTC(2026, 0, 10, 12);
    db.prepare(
      `INSERT INTO subjects (id, name, created_at) VALUES (?, 'Fisica', 1)`,
    ).run(subjectId);
    db.prepare(
      `INSERT INTO plans (id, title, status, subject_id, exam_at, created_at, updated_at)
       VALUES (?, 'Meccanica', 'ready', ?, ?, 1, 1)`,
    ).run(planId, subjectId, now + 2 * 86_400_000);
    const [row] = listPlans(db, now);
    expect(row?.subject).toBe("Fisica");
    expect(row?.daysToExam).toBe(2);
    expect(row?.mastery).toBe(0);
  });

  it("lists a finished simulation with its score and minutes", () => {
    const db = openDatabase(":memory:");
    const planId = uuidv7(1);
    const started = Date.UTC(2026, 0, 10, 12);
    db.prepare(
      `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES (?, 'Fisica', 'ready', 1, 1)`,
    ).run(planId);
    db.prepare(
      `INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES ('item', ?, 'simulation', '{}', 1)`,
    ).run(planId);
    db.prepare(
      `INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES ('run', ?, 'item', ?, ?)`,
    ).run(planId, started, started + 30 * 60_000);
    db.prepare(
      `INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at)
       VALUES ('ans', 'run', ?, ?)`,
    ).run(
      JSON.stringify({
        results: [
          { id: "q", score: 1 },
          { id: "q2", score: 0 },
        ],
      }),
      started,
    );
    expect(listSimulations(db, planId)).toEqual([
      { id: "run", at: started + 30 * 60_000, score: 0.5, minutes: 30 },
    ]);
  });

  it("points the recommended lesson at the open step", () => {
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('p', 'Fisica', 'ready', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO path_nodes (id, plan_id, kind, position, title, created_at)
       VALUES ('intro', 'p', 'intro', 0, 'Introduzione', 1)`,
    ).run();
    expect(nextLesson(db, "missing")).toBeNull();
    expect(nextLesson(db, "p")).toEqual({
      nodeId: "intro",
      reason: "next",
      count: 0,
    });
  });

  it("stores an open gap from two misses in one quiz", () => {
    const db = openDatabase(":memory:");
    const planId = uuidv7(1);
    const topicId = uuidv7(2);
    const now = Date.UTC(2026, 0, 14, 12);
    db.prepare(
      `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES (?, 'Fisica', 'ready', 1, 1)`,
    ).run(planId);
    db.prepare(
      `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, 'Moti', 0, 1)`,
    ).run(topicId, planId);
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'answer_given', ?, ?, ?, ?)`,
    ).run(
      uuidv7(3),
      planId,
      topicId,
      JSON.stringify({ score: 0, scores: [0, 0] }),
      now,
    );
    const series = planSeries(db, planId, now);
    expect(series.chart).toHaveLength(14);
    expect(series.chart[13]?.count).toBe(1);
    expect(series.gaps).toEqual([
      { topicId, openedAt: now, severity: "severe", wrongAnswers: 2, misses: [] },
    ]);
    expect(series.pace.week).toBe(1);
    const again = planSeries(db, planId, now);
    expect(again.gaps).toHaveLength(1);
  });

  it("keeps mastery when the only extra row is active time", () => {
    const db = openDatabase(":memory:");
    const planId = uuidv7(1);
    const topicId = uuidv7(2);
    const now = Date.UTC(2026, 0, 14, 12);
    db.prepare(
      `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES (?, 'Fisica', 'ready', 1, 1)`,
    ).run(planId);
    db.prepare(
      `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, 'Moti', 0, 1)`,
    ).run(topicId, planId);
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'lesson_completed', ?, ?, '{}', ?)`,
    ).run(uuidv7(3), planId, topicId, now);
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'active_time', ?, NULL, ?, ?)`,
    ).run(uuidv7(4), planId, JSON.stringify({ seconds: 120 }), now);
    const series = planSeries(db, planId, now);
    expect(series.topics[0]?.mastery).toBe(0);
    expect(series.minutes).toBe(2);
  });
});

describe("M12 preparation data", () => {
  function fixture(now: number) {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO plans (id,title,status,target,created_at,updated_at) VALUES('p','Physics','ready',.8,1,1)",
    ).run();
    db.prepare(
      "INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('a','p','Motion',0,1),('b','p','Force',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO passages(id,text,created_at) VALUES('pa','Motion',1),('pb','Force',1)",
    ).run();
    db.prepare(
      "INSERT INTO topic_passages(topic_id,passage_id) VALUES('a','pa'),('b','pb')",
    ).run();
    let n = 0;
    return {
      db,
      event: (kind: string, topic: string | null, payload: unknown, at = now) =>
        db
          .prepare(
            "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES(?,?,'p',?,?,?)",
          )
          .run(`e${n++}`, kind, topic, JSON.stringify(payload), at),
    };
  }
  it("includes untouched topics in the chart and summary, and counts completed lessons only", () => {
    const now = new Date(2026, 0, 14, 12).getTime();
    const { db, event } = fixture(now);
    event("lesson_opened", "a", {});
    event("lesson_completed", "a", {});
    event("lesson_completed", null, { nodeId: "intro" });
    event("answer_given", "a", { score: 0.5, scores: [1, 0, 0.5] });
    const series = planSeries(db, "p", now);
    const mastery = planMastery(db, "p", now);
    expect(series.preparation.mastery).toBe(
      (mastery[0]!.mastery + mastery[1]!.mastery) / 2,
    );
    expect(series.chart.at(-1)!.mastery).toBe(series.preparation.mastery);
    expect(series.chart[0]!.mastery).toBe(0);
    expect(series.lessons).toBe(1);
    expect(series.preparation.weeklyChange).toBe(series.preparation.mastery);
    expect(series.topics[0]).toMatchObject({
      exercisesSolved: 1,
      lessons: 1,
      lastStudied: now,
    });
    expect(series.topics[1]).toMatchObject({
      exercisesSolved: 0,
      lessons: 0,
      lastStudied: null,
    });
    db.close();
  });
  it("returns time bars and aggregates the most active weekday across both weeks", () => {
    const now = new Date(2026, 0, 14, 12).getTime();
    const { db, event } = fixture(now);
    const monday = new Date(2026, 0, 12, 12).getTime();
    event("active_time", null, { seconds: 60 }, monday - 7 * 86400000);
    event("active_time", null, { seconds: 120 }, monday);
    event("active_time", null, { seconds: 150 }, monday + 86400000);
    event("lesson_completed", "a", {}, monday);
    event("lesson_completed", "b", {}, monday - 7 * 86400000);
    const series = planSeries(db, "p", now);
    expect(series.pace.bars).toHaveLength(14);
    expect(series.pace.bars.reduce((n, b) => n + b.seconds, 0)).toBe(330);
    expect(series.pace.weekMinutes).toBe(5);
    expect(series.pace.weekLessons).toBe(1);
    expect(series.pace.mostActiveWeekday).toBe(1);
    db.close();
  });
  it("uses 21 days and below-target mastery for idle warnings, including untouched old topics", () => {
    const now = new Date(2026, 0, 30, 12).getTime();
    const { db, event } = fixture(now);
    event("lesson_completed", "a", {}, now - 22 * 86400000);
    expect(planSeries(db, "p", now).topics.map((t) => t.idle)).toEqual([
      true,
      true,
    ]);
    event("active_time", "a", { seconds: 15 });
    expect(planSeries(db, "p", now).topics.map((t) => t.idle)).toEqual([
      false,
      true,
    ]);
    db.close();
  });
  it("lists only this plan's flagged questions and excludes them from solved counts", () => {
    const now = new Date(2026, 0, 14, 12).getTime();
    const { db, event } = fixture(now);
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES('quiz','p','a','quiz',?,1)",
    ).run(
      JSON.stringify({
        questions: [
          {
            id: "q",
            stem: "How fast?",
            answer: { kind: "open", reference: "Ten" },
          },
        ],
      }),
    );
    event("answer_given", "a", {
      score: 1,
      scores: [1],
      questionScores: [{ id: "q", sourceIds: [], score: 1 }],
    });
    flagTarget(db, "exercise", "q", "Wrong premise", now);
    flagTarget(db, "exercise", "unrelated", "Other course", now);
    const series = planSeries(db, "p", now);
    expect(series.flagged).toHaveLength(1);
    expect(series.flagged[0]).toMatchObject({
      targetId: "q",
      label: "How fast?",
      reason: "Wrong premise",
      topicId: "a",
    });
    expect(series.topics[0]!.exercisesSolved).toBe(0);
    db.close();
  });
  it("resolves flags by kind and plan without replacing passage labels with question aliases", () => {
    const now = new Date(2026, 0, 14, 12).getTime();
    const { db } = fixture(now);
    db.prepare(
      "INSERT INTO plans(id,title,status,created_at,updated_at) VALUES('other','Other','ready',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('other-topic','other','Other',0,1)",
    ).run();
    db.prepare(
      "INSERT INTO passages(id,text,section_path,created_at) VALUES('passage','Velocity text','Velocity chapter',1),('other-passage','Other text','Other chapter',1)",
    ).run();
    db.prepare(
      "INSERT INTO topic_passages(topic_id,passage_id) VALUES('a','passage'),('other-topic','other-passage')",
    ).run();
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES('quiz','p','a','quiz',?,1)",
    ).run(
      JSON.stringify({
        questions: [
          {
            id: "generated",
            sourceId: "passage",
            sourceIds: ["passage", "other-passage"],
            stem: "Diagnostic 9",
          },
        ],
      }),
    );
    flagTarget(db, "passage", "passage", "Check this paragraph", now);
    flagTarget(db, "exercise", "passage", "Legacy exercise alias", now);
    flagTarget(db, "exercise", "generated", "Question", now);
    flagTarget(db, "passage", "generated", "Wrong kind", now);
    flagTarget(db, "passage", "other-passage", "Other plan", now);
    flagTarget(
      db,
      "exercise",
      "other-passage",
      "Grounding is not an exercise alias",
      now,
    );
    flagTarget(db, "item", "quiz", "Quiz item", now);
    const flagged = planSeries(db, "p", now).flagged;
    expect(flagged).toHaveLength(4);
    expect(flagged.find((f) => f.targetKind === "passage")).toMatchObject({
      targetId: "passage",
      label: "Velocity chapter",
      topicId: "a",
    });
    expect(
      flagged.find(
        (f) => f.targetKind === "exercise" && f.targetId === "passage",
      ),
    ).toMatchObject({ label: "Diagnostic 9", topicId: "a" });
    expect(flagged.some((f) => f.targetId === "other-passage")).toBe(false);
    expect(planSeries(db, "other", now).flagged).toHaveLength(1);
    db.close();
  });
  it("ranks severe gaps first without inventing a model misconception", () => {
    const now = new Date(2026, 0, 14, 12).getTime();
    const { db, event } = fixture(now);
    for (let i = 0; i < 20; i++)
      event("answer_given", "a", { score: 1, scores: [1] }, now - 1000 + i);
    event("answer_given", "a", { score: 0, scores: [0, 0] });
    event("answer_given", "b", { score: 0, scores: [0, 0, 0] });
    const series = planSeries(db, "p", now);
    expect(
      series.gaps.map((g) => [g.topicId, g.severity, g.wrongAnswers]),
    ).toEqual([
      ["b", "severe", 3],
      ["a", "minor", 2],
    ]);
    db.close();
  });
});

describe("specified mastery evidence", () => {
  function fixture() {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO plans(id,title,status,created_at,updated_at) VALUES('p','Physics','ready',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('a','p','Motion',0,1),('b','p','Force',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO passages(id,text,created_at) VALUES('pa','One',1),('pb','Two',1),('pc','Three',1),('pd','Four',1)",
    ).run();
    db.prepare(
      "INSERT INTO topic_passages(topic_id,passage_id) VALUES('a','pa'),('b','pb'),('b','pc'),('b','pd')",
    ).run();
    return db;
  }
  it("weights each answer and excludes reading, and includes untouched passage weights", () => {
    const db = fixture();
    const now = 1000;
    db.prepare(
      "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES('e','answer_given','p','a',?,?)",
    ).run(
      JSON.stringify({
        questionScores: [
          { id: "q", kind: "open", score: 1 },
          { id: "r", kind: "mcq", score: 0 },
        ],
      }),
      now,
    );
    db.prepare(
      "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES('l','lesson_completed','p','a','{}',?)",
    ).run(now);
    const mastery = 1.5 / (3 + 1.5 + 1);
    expect(planMastery(db, "p", now)[0]!.mastery).toBeCloseTo(mastery);
    const series = planSeries(db, "p", now);
    expect(series.preparation.mastery).toBeCloseTo(mastery / 4);
    expect(series.chart.at(-1)!.mastery).toBeCloseTo(mastery / 4);
    db.close();
  });
  it("recovers missing answer kinds and simulation weights from saved historical attempts", () => {
    const db = fixture();
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES('quiz','p','a','quiz',?,1),('sim','p',NULL,'simulation',?,1)",
    ).run(
      JSON.stringify({ questions: [{ id: "open", answer: { kind: "open" } }] }),
      JSON.stringify({
        questions: [
          { id: "sim-answer", topicId: "a", answer: { kind: "open" } },
        ],
      }),
    );
    db.prepare(
      "INSERT INTO attempts(id,plan_id,item_id,started_at,submitted_at) VALUES('attempt','p','sim',1,1000)",
    ).run();
    db.prepare(
      "INSERT INTO attempt_answers(id,attempt_id,payload_json,created_at) VALUES('answer','attempt',?,1000)",
    ).run(JSON.stringify({ results: [{ id: "sim-answer", score: 1 }] }));
    db.prepare(
      "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES('e','answer_given','p','a',?,1000),('q','answer_given','p','a',?,1000)",
    ).run(
      JSON.stringify({ score: 1, scores: [1] }),
      JSON.stringify({ questionScores: [{ id: "open", score: 1 }] }),
    );
    expect(planMastery(db, "p", 1000)[0]!.mastery).toBeCloseTo(3.5 / 6.5);
    db.close();
  });
  it("uses one current FSRS value per card and replays historical review states", () => {
    const db = fixture();
    const at = new Date(2026, 0, 1, 12).getTime();
    db.prepare(
      "INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES('card','p','a','Q','A',?)",
    ).run(at);
    let state = newCard(at);
    for (let i = 0; i < 20; i++) {
      state = review(state, "good", at + i * 600000);
      db.prepare(
        "INSERT INTO card_reviews(id,card_id,rating,state_json,reviewed_at) VALUES(?,'card','good',?,?)",
      ).run(`r${i}`, JSON.stringify(state), at + i * 600000);
      db.prepare(
        "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES(?,'card_rated','p','a',?,?)",
      ).run(`e${i}`, JSON.stringify({ score: 1 }), at + i * 600000);
    }
    const now = at + 20 * 600000;
    expect(planMastery(db, "p", now)[0]!.mastery).toBeCloseTo(
      (0.5 * retrievability(state, now)) / 3.5,
    );
    expect(planMastery(db, "p", at - 1)[0]!.mastery).toBe(0);
    const initial = review(newCard(at), "good", at);
    expect(planMastery(db, "p", at)[0]!.mastery).toBeCloseTo(
      (0.5 * retrievability(initial, at)) / 3.5,
    );
    expect(planMastery(db, "p", now + 30 * 86400000)[0]!.mastery).toBeLessThan(
      planMastery(db, "p", now)[0]!.mastery,
    );
    db.prepare("UPDATE cards SET removed=1 WHERE id='card'").run();
    expect(planMastery(db, "p", now)[0]!.mastery).toBe(0);
    db.close();
  });
});
