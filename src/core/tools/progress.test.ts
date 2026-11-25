import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { saveProfile } from "../profile/profile";
import { progressInput, progressTool, readProgress } from "./progress";
import type { ToolTurn } from "./server";

/** Fisica 1 with one exam of three topics, and Chimica with its own exam, each with handed-in quizzes. */
function fixture() {
  const db = openDatabase(":memory:");
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  run("INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 1', 1), ('chem', 'Chimica', 1)");
  run(
    "INSERT INTO plans (id, subject_id, title, status, target, created_at, updated_at) VALUES ('mech', 'phys', 'Meccanica', 'ready', 0.7, 1, 1), ('gen', 'chem', 'Chimica generale', 'ready', 0.8, 1, 1)",
  );
  run(
    `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES
     ('kin', 'mech', 'Cinematica', 0, 1), ('dyn', 'mech', 'Dinamica', 1, 1), ('osc', 'mech', 'Oscillazioni', 2, 1),
     ('atoms', 'gen', 'Atomi', 0, 1)`,
  );
  let n = 0;
  const quiz = (planId: string, topicId: string | null, at: number, score: number | null, kind = "quiz") => {
    n += 1;
    run(`INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES (?, ?, ?, ?, '{}', ?)`, `i${n}`, planId, topicId, kind, at);
    run(`INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES (?, ?, ?, ?, ?)`, `a${n}`, planId, `i${n}`, at - 600_000, at);
    run(
      `INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES (?, ?, ?, ?)`,
      `aa${n}`,
      `a${n}`,
      JSON.stringify(score === null ? { picks: {} } : { picks: {}, score }),
      at,
    );
  };
  const nov = (day: number) => new Date(2026, 10, day, 12).getTime();
  quiz("mech", "kin", nov(2), 0.6);
  quiz("mech", "kin", nov(9), 26 / 30);
  quiz("mech", "dyn", nov(19), 0.7);
  quiz("mech", null, nov(20), 0.5, "simulation");
  quiz("mech", "osc", nov(21), null);
  // An attempt not handed in counts nowhere.
  run(`INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES ('open', 'mech', 'dyn', 'quiz', '{}', 1)`);
  run(`INSERT INTO attempts (id, plan_id, item_id, started_at) VALUES ('open-a', 'mech', 'open', 1)`);
  quiz("gen", "atoms", nov(10), 0.95);
  return db;
}

const turn = (place: { planId: string | null; subject: string | null }): ToolTurn => ({
  chatId: "chat",
  tally: {},
  kept: {},
  place: () => place,
  engine: () => ({ provider: "claude", model: "claude-sonnet-5-5" }),
  started: () => undefined,
  finished: () => undefined,
});

describe("read_progress", () => {
  it("reads the chat's exam only, newest quiz first, with grades out of 30 at university", () => {
    const db = fixture();
    const progress = readProgress(db, { planId: "mech", subject: "Fisica 1" })!;
    expect(progress.scale).toBe(30);
    expect(progress.passMark).toBe(18);
    expect(progress.exams).toHaveLength(1);
    const [exam] = progress.exams;
    expect(exam!.exam).toBe("Meccanica");
    expect(exam!.goal).toBe(21);
    expect(exam!.quizzesDone).toBe(5);
    expect(exam!.quizzes).toEqual([
      { date: "2026-11-21", kind: "quiz", topic: "Oscillazioni", grade: null },
      { date: "2026-11-20", kind: "exam simulation", topic: null, grade: 15 },
      { date: "2026-11-19", kind: "quiz", topic: "Dinamica", grade: 21 },
      { date: "2026-11-09", kind: "quiz", topic: "Cinematica", grade: 26 },
      { date: "2026-11-02", kind: "quiz", topic: "Cinematica", grade: 18 },
    ]);
    expect(exam!.topics.map((topic) => [topic.topic, topic.latestQuizGrade])).toEqual([
      ["Cinematica", 26],
      ["Dinamica", 21],
      // Still being graded: no grade yet.
      ["Oscillazioni", null],
    ]);
    // Nothing from the other subject.
    expect(JSON.stringify(progress)).not.toMatch(/Chimica|Atomi/);
  });

  it("uses the scale the student picked", () => {
    const db = fixture();
    saveProfile(db, { educationLevel: "university", gradeScale: 100 });
    const progress = readProgress(db, { planId: "mech", subject: null })!;
    expect(progress.scale).toBe(100);
    expect(progress.passMark).toBe(60);
    expect(progress.exams[0]!.goal).toBe(70);
    expect(progress.exams[0]!.quizzes.map((quiz) => quiz.grade)).toEqual([null, 50, 70, 86, 60]);
  });

  it("reads every exam of the chat's subject when the chat has no exam, and no other subject", () => {
    const db = fixture();
    const progress = readProgress(db, { planId: null, subject: "chimica" })!;
    expect(progress.subject).toBe("Chimica");
    expect(progress.exams.map((exam) => exam.exam)).toEqual(["Chimica generale"]);
    expect(progress.exams[0]!.quizzes).toEqual([{ date: "2026-11-10", kind: "quiz", topic: "Atomi", grade: 28.5 }]);
  });

  it("says an exam without quizzes has none, and never invents a topic state", () => {
    const db = fixture();
    db.prepare("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('empty', 'phys', 'Termodinamica', 'ready', 1, 1)").run();
    db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('heat', 'empty', 'Calore', 0, 1)").run();
    const [exam] = readProgress(db, { planId: "empty", subject: "Fisica 1" })!.exams;
    expect(exam).toMatchObject({ exam: "Termodinamica", quizzesDone: 0, quizzes: [] });
    expect(exam!.topics).toEqual([
      { topic: "Calore", lessonRead: false, latestQuizGrade: null, mastery: null, goalReached: false, openMistakes: 0 },
    ]);
  });

  it("tells the model when the chat has no place, and when its subject has no exam, without numbers", async () => {
    const db = fixture();
    const tool = progressTool(db);
    expect(progressInput.safeParse({}).success).toBe(true);
    // Where it looks comes from the chat: an argument naming another exam is refused.
    expect(progressInput.safeParse({ planId: "gen" }).success).toBe(false);
    expect((await tool.run(turn({ planId: null, subject: null }), {})).text).toMatch(/no subject or exam/);
    db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('bio', 'Biologia', 1)").run();
    expect((await tool.run(turn({ planId: null, subject: "Biologia" }), {})).text).toMatch(/has no exam in Pyxis yet/);
    const read = JSON.parse((await tool.run(turn({ planId: "mech", subject: "Fisica 1" }), {})).text) as { exams: unknown[] };
    expect(read.exams).toHaveLength(1);
  });

  it("only reads", async () => {
    const db = fixture();
    const count = () =>
      db
        .prepare(
          "SELECT (SELECT count(*) FROM attempts) + (SELECT count(*) FROM attempt_answers) + (SELECT count(*) FROM learning_events) + (SELECT count(*) FROM gaps) AS n",
        )
        .get() as { n: number };
    const before = count();
    await progressTool(db).run(turn({ planId: "mech", subject: "Fisica 1" }), {});
    expect(count()).toEqual(before);
  });
});

describe("read_progress, the chat's own exam", () => {
  it("reads an archived exam's own history, and never widens a chat's exam to its subject's other exams", () => {
    const db = fixture();
    db.prepare("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('thermo', 'phys', 'Termodinamica', 'ready', 1, 1)").run();
    db.prepare("UPDATE plans SET archived_at = 5 WHERE id = 'mech'").run();
    const archived = readProgress(db, { planId: "mech", subject: "Fisica 1" })!;
    expect(archived.exams.map((exam) => exam.exam)).toEqual(["Meccanica"]);
    expect(archived.exams[0]!.quizzesDone).toBe(5);
    // An exam that is gone leaves nothing to read: not the subject's other exams.
    expect(readProgress(db, { planId: "deleted", subject: "Fisica 1" })).toBeNull();
  });

  it("sends the exam's saved goal, and counts a topic as at its goal by the threshold the path uses", () => {
    const db = fixture();
    db.prepare("UPDATE plans SET target = 1 WHERE id = 'mech'").run();
    expect(readProgress(db, { planId: "mech", subject: null })!.exams[0]!.goal).toBe(30);
    db.prepare("UPDATE plans SET target = 0.75 WHERE id = 'mech'").run();
    expect(readProgress(db, { planId: "mech", subject: null })!.exams[0]!.goal).toBe(22.5);
  });
});

describe("read_progress, windows it says it took", () => {
  it("lists at most the latest 40 quizzes of an exam and says how many there are", () => {
    const db = fixture();
    const item = db.prepare("INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES (?, 'mech', 'kin', 'quiz', '{}', ?)");
    const attempt = db.prepare("INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES (?, 'mech', ?, ?, ?)");
    const answers = db.prepare(`INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES (?, ?, '{"score":0.7}', ?)`);
    for (let i = 0; i < 36; i++) {
      const at = new Date(2026, 9, 1 + (i % 28), 12).getTime() - i;
      item.run(`x${i}`, at);
      attempt.run(`xa${i}`, `x${i}`, at - 1, at);
      answers.run(`xaa${i}`, `xa${i}`, at);
    }
    const [exam] = readProgress(db, { planId: "mech", subject: null })!.exams;
    expect(exam!.quizzesDone).toBe(41);
    expect(exam!.quizzes).toHaveLength(40);
    expect(exam!.quizzesListed).toBe("the latest 40 of 41, newest first");
    // The newest is kept, the oldest left out.
    expect(exam!.quizzes[0]!.date).toBe("2026-11-21");
  });

  it("reads every active exam of a subject, however many", () => {
    const db = fixture();
    for (let i = 0; i < 7; i++)
      db.prepare("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES (?, 'phys', ?, 'ready', 1, ?)").run(`p${i}`, `Esame ${i}`, i);
    expect(readProgress(db, { planId: null, subject: "Fisica 1" })!.exams).toHaveLength(8);
  });
});
