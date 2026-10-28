import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { nextExamDate, SESSION_DATE_MAX } from "../../shared/exam-sessions";
import { requests } from "../../shared/ipc";
import { listPlans, planGuide, readPlan } from "./create";
import { readSessions, saveSessions, syncExamDates } from "./sessions";
import { savePlanSettings, setPlanArchived } from "./settings";
import { browseCards } from "../study/cardBrowser";
import { countDueCards, dueCards } from "../study/cards";
import { exportCalendar } from "../share/calendar";
import { exportPlan, importPlan } from "./file";

const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const NOW = new Date(2026, 9, 17, 10).getTime();

function fixture() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO plans(id,title,status,created_at,updated_at) VALUES('p','Fisica 1','ready',1,1)",
  ).run();
  return db;
}

describe("next exam date", () => {
  it("is the earliest session that is today or later, else the latest, else none", () => {
    const dates = [noon(2026, 10, 10), noon(2026, 11, 20), noon(2026, 12, 2)];
    expect(nextExamDate(dates, NOW)).toBe(noon(2026, 11, 20));
    expect(nextExamDate([noon(2026, 10, 17)], new Date(2026, 9, 17, 22).getTime())).toBe(noon(2026, 10, 17));
    expect(nextExamDate([noon(2026, 9, 1), noon(2026, 10, 1)], NOW)).toBe(noon(2026, 10, 1));
    expect(nextExamDate([], NOW)).toBeNull();
  });
});

describe("exam sessions", () => {
  it("saves a list, keeps exam_at on the next date and reads sessions in order", () => {
    const db = fixture();
    saveSessions(
      db,
      "p",
      [
        { date: noon(2026, 12, 2), time: "14:00", place: "Aula 3", label: "Oral" },
        { date: noon(2026, 11, 20), time: "09:30", place: " Aula 5 ", label: "Written" },
      ],
      NOW,
    );
    const sessions = readSessions(db, "p");
    expect(sessions.map((s) => [s.label, s.time, s.place])).toEqual([
      ["Written", "09:30", "Aula 5"],
      ["Oral", "14:00", "Aula 3"],
    ]);
    expect(db.prepare("SELECT exam_at FROM plans").pluck().get()).toBe(noon(2026, 11, 20));
    db.close();
  });

  it("keeps the ID of a session that is saved again, and drops one that is left out", () => {
    const db = fixture();
    saveSessions(db, "p", [{ date: noon(2026, 11, 20) }, { date: noon(2026, 12, 2) }], NOW);
    const [first, second] = readSessions(db, "p");
    saveSessions(db, "p", [{ id: first!.id, date: noon(2026, 11, 21), time: "10:00" }], NOW);
    const after = readSessions(db, "p");
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: first!.id, date: noon(2026, 11, 21), time: "10:00" });
    expect(after.some((s) => s.id === second!.id)).toBe(false);
    db.close();
  });

  it("does not reuse another plan's session ID", () => {
    const db = fixture();
    db.prepare("INSERT INTO plans(id,title,status,created_at,updated_at) VALUES('q','Chimica','ready',1,1)").run();
    saveSessions(db, "q", [{ date: noon(2026, 11, 20) }], NOW);
    const foreign = readSessions(db, "q")[0]!.id;
    saveSessions(db, "p", [{ id: foreign, date: noon(2026, 12, 1) }], NOW);
    expect(readSessions(db, "q")).toHaveLength(1);
    expect(readSessions(db, "p")[0]!.id).not.toBe(foreign);
    db.close();
  });

  it("clears the date when the last session goes (No date yet)", () => {
    const db = fixture();
    saveSessions(db, "p", [{ date: noon(2026, 11, 20) }], NOW);
    saveSessions(db, "p", [], NOW);
    expect(readSessions(db, "p")).toEqual([]);
    expect(db.prepare("SELECT exam_at FROM plans").pluck().get()).toBeNull();
    db.close();
  });

  it("moves exam_at to the oral part once the written part is over", () => {
    const db = fixture();
    saveSessions(db, "p", [{ date: noon(2026, 10, 20) }, { date: noon(2026, 11, 20) }], NOW);
    expect(db.prepare("SELECT exam_at FROM plans").pluck().get()).toBe(noon(2026, 10, 20));
    const later = new Date(2026, 9, 25, 9).getTime();
    expect(listPlans(db, later)[0]!.daysToExam).toBe(26);
    expect(db.prepare("SELECT exam_at FROM plans").pluck().get()).toBe(noon(2026, 11, 20));
    expect(readPlan(db, "p", later)!.examAt).toBe(noon(2026, 11, 20));
    // Every session over: the plan keeps the latest, so it still reads "Past exam".
    const much = new Date(2027, 0, 5, 9).getTime();
    expect(listPlans(db, much)[0]!.daysToExam).toBeLessThan(0);
    syncExamDates(db, much);
    expect(db.prepare("SELECT exam_at FROM plans").pluck().get()).toBe(noon(2026, 11, 20));
    db.close();
  });

  it("saves through the plan settings and rejects a malformed time", () => {
    const db = fixture();
    savePlanSettings(
      db,
      {
        planId: "p",
        title: "Fisica 1",
        target: 0.8,
        sessions: [{ date: noon(2026, 11, 20), time: "09:30", place: "Aula 5", label: "Written" }],
      },
      NOW,
    );
    expect(readPlan(db, "p", NOW)!.sessions).toHaveLength(1);
    const parse = (time: string) =>
      requests["plans.settings"].input.safeParse({
        planId: "p",
        title: "T",
        target: 0.8,
        sessions: [{ date: noon(2026, 11, 20), time }],
      }).success;
    expect(parse("09:30")).toBe(true);
    expect(parse("24:00")).toBe(false);
    expect(parse("9:30")).toBe(false);
    expect(
      requests["plans.settings"].input.safeParse({
        planId: "p",
        title: "T",
        target: 0.8,
        sessions: Array.from({ length: 11 }, () => ({ date: noon(2026, 11, 20) })),
      }).success,
    ).toBe(false);
    db.close();
  });
});

describe("migration 22", () => {
  const opened: Array<{ close: () => void }> = [];
  afterEach(() => {
    for (const db of opened) db.close();
    opened.length = 0;
  });

  it("turns an existing exam date into one session that carries the plan's id", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pyxis-sessions-")), "pyxis.db");
    const db = openDatabase(file);
    db.exec("DROP TABLE plan_sessions; ALTER TABLE plans DROP COLUMN archived_at; ALTER TABLE jobs DROP COLUMN fallback_json;");
    db.pragma("user_version = 21");
    db.prepare("INSERT INTO plans(id,title,status,exam_at,created_at,updated_at) VALUES('dated','A','ready',?,1,1)").run(noon(2026, 11, 20));
    db.prepare("INSERT INTO plans(id,title,status,created_at,updated_at) VALUES('undated','B','ready',1,1)").run();
    db.prepare("INSERT INTO plans(id,title,status,exam_at,created_at,updated_at) VALUES('far','C','ready',8640000000000000,1,1)").run();
    db.close();
    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(23);
    expect(readSessions(again, "dated")).toEqual([
      { id: "dated", date: noon(2026, 11, 20), time: null, place: null, label: null },
    ]);
    expect(readSessions(again, "undated")).toEqual([]);
    // A date past year 9999, which an older version accepted, is cut to the latest a session can hold.
    expect(readSessions(again, "far")[0]!.date).toBe(SESSION_DATE_MAX);
    expect(again.prepare("SELECT archived_at FROM plans WHERE id = 'dated'").pluck().get()).toBeNull();
  });
});

describe("archived exams", () => {
  function archivedFixture() {
    const db = openDatabase(":memory:");
    const plans = ["live", "done"].map((id) => {
      const topic = uuidv7();
      db.prepare("INSERT INTO plans(id,title,status,created_at,updated_at) VALUES(?,?,'ready',1,1)").run(id, `Plan ${id}`);
      db.prepare("INSERT INTO topics(id,plan_id,title,position,created_at) VALUES(?,?,'Moti',0,1)").run(topic, id);
      db.prepare("INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES(?,?,?,'f','b',1)").run(`card-${id}`, id, topic);
      return { id, topic };
    });
    return { db, plans };
  }

  it("lists the flag and restores", () => {
    const { db } = archivedFixture();
    expect(Object.fromEntries(listPlans(db, NOW).map((p) => [p.id, p.archived]))).toEqual({ live: false, done: false });
    setPlanArchived(db, "done", true, NOW);
    expect(Object.fromEntries(listPlans(db, NOW).map((p) => [p.id, p.archived]))).toEqual({ live: false, done: true });
    expect(readPlan(db, "done", NOW)!.archivedAt).toBe(NOW);
    setPlanArchived(db, "done", false, NOW);
    expect(readPlan(db, "done", NOW)!.archivedAt).toBeNull();
    db.close();
  });

  it("keeps an archived plan's cards out of the due queue and its count", () => {
    const { db } = archivedFixture();
    expect(countDueCards(db, "done", NOW)).toBe(1);
    setPlanArchived(db, "done", true, NOW);
    expect(countDueCards(db, "done", NOW)).toBe(0);
    expect(dueCards(db, "done", NOW)).toEqual([]);
    expect(countDueCards(db, "live", NOW)).toBe(1);
    setPlanArchived(db, "done", false, NOW);
    expect(countDueCards(db, "done", NOW)).toBe(1);
    db.close();
  });

  it("recommends nothing for an archived plan and again after a restore", () => {
    const { db } = archivedFixture();
    expect(planGuide(db, "done", NOW)!.next).not.toBeNull();
    setPlanArchived(db, "done", true, NOW);
    const guide = planGuide(db, "done", NOW)!;
    expect(guide.next).toBeNull();
    expect(guide.topics.every((topic) => topic.dueCards === 0)).toBe(true);
    setPlanArchived(db, "done", false, NOW);
    expect(planGuide(db, "done", NOW)!.next).not.toBeNull();
    db.close();
  });

  it("keeps an archived plan out of the card browser and its filters", () => {
    const { db } = archivedFixture();
    expect(browseCards(db, {}, NOW).plans.map((p) => p.id).sort()).toEqual(["done", "live"]);
    setPlanArchived(db, "done", true, NOW);
    const result = browseCards(db, {}, NOW);
    expect(result.cards.map((card) => card.planId)).toEqual(["live"]);
    expect(result.plans.map((p) => p.id)).toEqual(["live"]);
    expect(result.topics.map((topic) => topic.planId)).toEqual(["live"]);
    db.close();
  });

  it("refuses a plan that does not exist or is still building", () => {
    const { db } = archivedFixture();
    db.prepare("UPDATE plans SET status = 'building' WHERE id = 'live'").run();
    expect(() => setPlanArchived(db, "live", true)).toThrow("plan-missing-or-building");
    expect(() => setPlanArchived(db, "nope", true)).toThrow("plan-missing-or-building");
    db.close();
  });

  it("still exports one plan's calendar and plan file once it is archived", () => {
    const { db } = archivedFixture();
    saveSessions(db, "done", [{ date: noon(2026, 11, 20) }], NOW);
    setPlanArchived(db, "done", true, NOW);
    expect(exportCalendar(db, { planId: "done", language: "en" }, NOW).count).toBe(1);
    expect(exportPlan(db, "done").title).toBe("Plan done");
    db.close();
  });

  it("imports a file as an active plan", () => {
    const { db } = archivedFixture();
    setPlanArchived(db, "done", true, NOW);
    const copy = importPlan(db, exportPlan(db, "done"), NOW);
    expect(readPlan(db, copy, NOW)!.archivedAt).toBeNull();
    db.close();
  });
});
