import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { pathState, planGuide } from "../plans/create";
import { planSeries } from "../plans/progress";
import { assignAnswers, closeGap, insertGap } from "./gapRows";
import { requests } from "../../shared/ipc";
import { gapLevel, openGaps, OPEN_GAPS_MAX } from "./openGaps";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 14, 12);

/**
 * One plan with target 0.8 and three live topics told apart by what the student has answered: Low has no evidence
 * (mastery 0, under half the target), Mid has two right quizzes (about 0.5) and High has twelve (about 0.89, at target).
 * `p` also has an archived topic; `q` is another exam. Every gap opens at its own moment, so no ranking tie is left to
 * the order rows were stored in.
 */
function fixture() {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO plans (id, title, status, target, created_at, updated_at) VALUES ('p', 'Fisica', 'ready', 0.8, 1, 1), ('q', 'Altro', 'ready', 0.8, 1, 1);
    INSERT INTO topics (id, plan_id, title, position, created_at, archived_at) VALUES
      ('low', 'p', 'Cinematica', 0, 1, NULL), ('mid', 'p', 'Dinamica', 1, 1, NULL), ('high', 'p', 'Energia', 2, 1, NULL),
      ('old', 'p', 'Ottica', 3, 1, 5), ('other', 'q', 'Termodinamica', 0, 1, NULL);
    INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES ('quiz', 'p', 'quiz', '{}', 1);
    INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES ('att', 'p', 'quiz', 1, 2);
  `);
  const answer = db.prepare(
    "INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES (?, 'answer_given', 'p', ?, ?, ?)",
  );
  const right = JSON.stringify({ score: 1, scores: [1, 1, 1, 1] });
  for (let i = 0; i < 12; i++) {
    if (i < 2) answer.run(`m${i}`, "mid", right, NOW - DAY * (20 - i));
    answer.run(`h${i}`, "high", right, NOW - DAY * (20 - i));
  }
  const open = (label: string, topicId: string, ago: number, sentence: string | null, severity?: "severe" | "minor", planId = "p") =>
    [
      label,
      insertGap(db, {
        planId,
        topicId,
        openedAt: NOW - ago * DAY,
        origin: sentence === null ? "answers" : "misconception",
        ...(sentence === null ? {} : { misconception: sentence }),
        ...(severity ? { severity } : {}),
      }),
    ] as const;
  const ids = Object.fromEntries([
    open("g1", "low", 5, "Confonde velocità e accelerazione.", "minor"),
    open("g2", "mid", 4, "Dimentica l'attrito.", "severe"),
    open("g3", "mid", 3, "Somma le forze come numeri.", "minor"),
    open("g4", "high", 2, "Scambia lavoro ed energia.", "minor"),
    open("g5", "high", 6, null, "minor"),
    open("g6", "mid", 1, "   ", "minor"),
    open("g7", "high", 7, "Ignora il segno del lavoro.", "severe"),
    open("g8", "mid", 9, "Un errore già risolto.", "minor"),
    open("g9", "old", 3, "Su un argomento tolto.", "severe"),
    open("g10", "mid", 8, "Somma le forze come numeri.", "minor"),
    open("g11", "other", 3, "Su un altro esame.", "severe", "q"),
  ]);
  closeGap(db, ids.g8!, NOW - DAY, "answers");
  assignAnswers(db, ids.g2!, "att", ["q1", "q2"]);
  assignAnswers(db, ids.g3!, "att", ["q3"]);
  assignAnswers(db, ids.g4!, "att", ["q4", "q5", "q6"]);
  return { db, ids };
}

describe("the ranking planSeries gave open gaps before it was shared", () => {
  it("puts severe first, then linked wrong answers, then the oldest, and leaves out closed gaps and archived topics", () => {
    const { db, ids } = fixture();
    const order = planSeries(db, "p", NOW).gaps.map((gap) => gap.gapId);
    expect(order).toEqual([ids.g2, ids.g7, ids.g1, ids.g4, ids.g3, ids.g10, ids.g5, ids.g6]);
    db.close();
  });

  it("keeps every field of a series gap", () => {
    const { db, ids } = fixture();
    const gaps = planSeries(db, "p", NOW).gaps;
    expect(gaps.find((gap) => gap.gapId === ids.g2)).toEqual({
      gapId: ids.g2,
      topicId: "mid",
      openedAt: NOW - 4 * DAY,
      misconception: "Dimentica l'attrito.",
      severity: "severe",
      unmerged: false,
      wrongAnswers: 2,
      misses: [],
    });
    expect(gaps.map((gap) => [gap.severity, gap.wrongAnswers])).toEqual([
      ["severe", 2],
      ["severe", 0],
      ["severe", 0],
      ["minor", 3],
      ["minor", 1],
      ["minor", 0],
      ["minor", 0],
      ["minor", 0],
    ]);
    db.close();
  });
});

/** What the exam page shows today: each topic's count from the guide, added up. */
const pageCount = (db: ReturnType<typeof fixture>["db"], planId = "p") =>
  planGuide(db, planId, NOW)!.topics.reduce((sum, topic) => sum + topic.gaps, 0);

describe("gapLevel", () => {
  it("is serious for severe, moderate under the target and minor once the topic reached it", () => {
    expect(gapLevel("severe", 0.1, 0.8)).toBe("serious");
    expect(gapLevel("severe", 0.95, 0.8)).toBe("serious");
    expect(gapLevel("minor", 0.5, 0.8)).toBe("moderate");
    expect(gapLevel("minor", 0.7999, 0.8)).toBe("moderate");
    expect(gapLevel("minor", 0.8, 0.8)).toBe("minor");
    expect(gapLevel("minor", 0.99, 0.8)).toBe("minor");
  });
});

describe("openGaps", () => {
  it("lists each open gap with its sentence as written, its topic and its level, most serious first", () => {
    const { db, ids } = fixture();
    const { total, gaps } = openGaps(db, "p", NOW);
    expect(total).toBe(8);
    expect(gaps.map((gap) => [gap.gapId, gap.level])).toEqual([
      [ids.g2, "serious"],
      [ids.g7, "serious"],
      [ids.g1, "serious"],
      [ids.g3, "moderate"],
      [ids.g10, "moderate"],
      [ids.g6, "moderate"],
      [ids.g4, "minor"],
      [ids.g5, "minor"],
    ]);
    expect(gaps[0]).toEqual({
      gapId: ids.g2,
      topicId: "mid",
      topicTitle: "Dinamica",
      level: "serious",
      sentence: "Dimentica l'attrito.",
      wrongAnswers: 2,
      openedAt: NOW - 4 * DAY,
    });
    db.close();
  });

  it("ranks by level, then wrong answers, then age, where planSeries ranks by severity", () => {
    const { db, ids } = fixture();
    // Same data, two rankings: planSeries puts the high-mastery gap with three wrong answers before the moderate ones.
    expect(planSeries(db, "p", NOW).gaps.map((gap) => gap.gapId).slice(3)).toEqual([ids.g4, ids.g3, ids.g10, ids.g5, ids.g6]);
    expect(openGaps(db, "p", NOW).gaps.map((gap) => gap.gapId).slice(3)).toEqual([ids.g3, ids.g10, ids.g6, ids.g4, ids.g5]);
    db.close();
  });

  it("gives the same order every time, and breaks a full tie by id", () => {
    const { db, ids } = fixture();
    const first = openGaps(db, "p", NOW).gaps.map((gap) => gap.gapId);
    expect(openGaps(db, "p", NOW + 5 * 60_000).gaps.map((gap) => gap.gapId)).toEqual(first);
    const a = insertGap(db, { planId: "p", topicId: "low", openedAt: NOW - 20 * DAY, origin: "misconception", misconception: "Uno.", severity: "minor" });
    const b = insertGap(db, { planId: "p", topicId: "low", openedAt: NOW - 20 * DAY, origin: "misconception", misconception: "Due.", severity: "minor" });
    const tied = openGaps(db, "p", NOW).gaps.filter((gap) => gap.gapId === a || gap.gapId === b);
    expect(tied.map((gap) => gap.gapId)).toEqual([a, b].sort());
    expect(ids.g1).toBeTruthy();
    db.close();
  });

  it("leaves out a closed gap, a gap on a removed topic and a gap of another exam, and reads a sentence of spaces as none", () => {
    const { db, ids } = fixture();
    const listed = openGaps(db, "p", NOW).gaps;
    for (const left of [ids.g8, ids.g9, ids.g11]) expect(listed.map((gap) => gap.gapId)).not.toContain(left);
    expect(listed.find((gap) => gap.gapId === ids.g6)?.sentence).toBeNull();
    expect(listed.find((gap) => gap.gapId === ids.g5)?.sentence).toBeNull();
    expect(openGaps(db, "q", NOW).gaps.map((gap) => [gap.gapId, gap.topicTitle])).toEqual([[ids.g11, "Termodinamica"]]);
    db.close();
  });

  it("lists two gaps with the same sentence, or the same meaning in other words, as the app counts them: separately", () => {
    const { db, ids } = fixture();
    const same = openGaps(db, "p", NOW).gaps.filter((gap) => gap.sentence === "Somma le forze come numeri.");
    expect(same.map((gap) => gap.gapId).sort()).toEqual([ids.g10, ids.g3].sort());
    const reworded = insertGap(db, {
      planId: "p",
      topicId: "mid",
      openedAt: NOW - 10 * DAY,
      origin: "misconception",
      misconception: "Addiziona i valori delle forze senza i versori.",
      severity: "minor",
      comparison: "unchecked",
    });
    const gaps = openGaps(db, "p", NOW).gaps;
    expect(gaps.filter((gap) => gap.topicId === "mid" && gap.level === "moderate").map((gap) => gap.gapId)).toContain(reworded);
    expect(gaps).toHaveLength(pageCount(db));
    db.close();
  });

  it("keeps the sentence in the language it was written in and does not trim or change it", () => {
    const { db } = fixture();
    const text = "  Confunde la «massa» con el peso — ¿sí?  ";
    const id = insertGap(db, { planId: "p", topicId: "low", openedAt: NOW - 30 * DAY, origin: "misconception", misconception: text, severity: "severe" });
    expect(openGaps(db, "p", NOW).gaps.find((gap) => gap.gapId === id)?.sentence).toBe(text);
    db.close();
  });

  it("opens a gap that the answers earned, with no sentence yet, before anyone read the gaps", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO plans (id, title, status, target, created_at, updated_at) VALUES ('p', 'Fisica', 'ready', 0.8, 1, 1);
      INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t', 'p', 'Cinematica', 0, 1);
    `);
    db.prepare(
      "INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES ('e', 'answer_given', 'p', 't', ?, ?)",
    ).run(JSON.stringify({ score: 0, scores: [0, 0] }), NOW);
    expect(openGaps(db, "p", NOW)).toEqual({
      total: 1,
      gaps: [{ gapId: expect.any(String), topicId: "t", topicTitle: "Cinematica", level: "serious", sentence: null, wrongAnswers: 2, openedAt: NOW }],
    });
    db.close();
  });

  it("answers in the shape the contract names, and the contract refuses an input without a plan", () => {
    const { db } = fixture();
    const call = requests["plans.openGaps"];
    expect(call.output.parse(openGaps(db, "p", NOW))).toEqual(openGaps(db, "p", NOW));
    expect(call.input.parse({ planId: "p" })).toEqual({ planId: "p" });
    expect(() => call.input.parse({})).toThrow();
    expect(() => call.output.parse({ total: 1, gaps: [{ ...openGaps(db, "p", NOW).gaps[0], level: "severe" }] })).toThrow();
    db.close();
  });

  it("is empty for a plan with no gaps and for one that does not exist", () => {
    const db = openDatabase(":memory:");
    db.exec("INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('p', 'Fisica', 'ready', 1, 1)");
    expect(openGaps(db, "p", NOW)).toEqual({ total: 0, gaps: [] });
    expect(openGaps(db, "nope", NOW)).toEqual({ total: 0, gaps: [] });
    db.close();
  });

  it("returns at most the first hundred and still says how many there are", () => {
    const { db } = fixture();
    const before = openGaps(db, "p", NOW).total;
    for (let i = 0; i < OPEN_GAPS_MAX + 5; i++)
      insertGap(db, { planId: "p", topicId: "high", openedAt: NOW - (i + 1) * 60_000, origin: "misconception", misconception: `Errore ${i}`, severity: "minor" });
    const read = openGaps(db, "p", NOW);
    expect(read.total).toBe(before + OPEN_GAPS_MAX + 5);
    expect(read.gaps).toHaveLength(OPEN_GAPS_MAX);
    expect(read.total).toBe(pageCount(db));
    expect(read.gaps.slice(0, 8).map((gap) => gap.level)).toEqual(["serious", "serious", "serious", "moderate", "moderate", "moderate", "minor", "minor"]);
    db.close();
  });
});

describe("the list and the count the exam page shows", () => {
  it("agree for none, one, many, a removed topic, a gap that closed and a topic that was deleted", () => {
    const { db, ids } = fixture();
    const agree = () => {
      const read = openGaps(db, "p", NOW);
      expect(read.gaps).toHaveLength(read.total);
      expect(read.total).toBe(pageCount(db));
      return read.total;
    };
    // Many, with a closed gap, a removed topic and another exam's gap among the rows.
    expect(agree()).toBe(8);
    // A gap that has just closed.
    closeGap(db, ids.g2!, NOW, "answers");
    expect(agree()).toBe(7);
    // A topic removed from the exam takes its gaps out of both.
    db.prepare("UPDATE topics SET archived_at = 9 WHERE id = 'high'").run();
    expect(agree()).toBe(4);
    // A topic deleted outright leaves its gap without a topic: in neither.
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE gaps SET topic_id = NULL WHERE id = ?").run(ids.g1);
    db.pragma("foreign_keys = ON");
    expect(agree()).toBe(3);
    db.prepare("UPDATE topics SET archived_at = 9 WHERE plan_id = 'p'").run();
    expect(agree()).toBe(0);
    db.close();
  });

  it("agree after answers close a gap on their own", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO plans (id, title, status, target, created_at, updated_at) VALUES ('p', 'Fisica', 'ready', 0.8, 1, 1);
      INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t', 'p', 'Cinematica', 0, 1);
    `);
    const answer = (at: number, scores: number[]) =>
      db
        .prepare("INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES (?, 'answer_given', 'p', 't', ?, ?)")
        .run(`e${at}`, JSON.stringify({ score: 0, scores }), at);
    answer(NOW, [0, 0]);
    const now = NOW + 4 * DAY;
    const count = () => planGuide(db, "p", now)!.topics[0]!.gaps;
    expect([openGaps(db, "p", now).total, count()]).toEqual([1, 1]);
    answer(NOW + DAY, [1, 1]);
    answer(NOW + 2 * DAY, [1, 1]);
    expect([openGaps(db, "p", now).total, count()]).toEqual([0, 0]);
    db.close();
  });

  it("still gives planGuide and pathState the counts they gave", () => {
    const { db } = fixture();
    expect(planGuide(db, "p", NOW)!.topics.map((topic) => [topic.topicId, topic.gaps])).toEqual([
      ["low", 1],
      ["mid", 4],
      ["high", 3],
    ]);
    // Only the open gaps of live topics are read now; the one on the removed topic was never counted.
    expect(pathState(db, "p", NOW)!.topics.map((topic) => [topic.id, topic.severeGaps])).toEqual([
      ["low", 1],
      ["mid", 1],
      ["high", 1],
    ]);
    db.close();
  });
});
