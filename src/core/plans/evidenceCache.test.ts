import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { rateCard } from "../study/cards";
import { onEvidenceChanged } from "./evidenceCache";
import { planMastery, planSeries } from "./progress";

const now = 1_800_000_000_000;

function seeded() {
  const file = join(mkdtempSync(join(tmpdir(), "pyxis-cache-")), "pyxis.db");
  const db = openDatabase(file);
  db.exec(`
    INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('p', 'Physics', 'ready', 1, 1);
    INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t', 'p', 'Motion', 0, 1);
    INSERT INTO cards (id, plan_id, topic_id, front, back, created_at) VALUES ('c', 'p', 't', 'Velocity', 'Distance over time', 1);
  `);
  db.prepare(
    "INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES ('e', 'answer_given', 'p', 't', ?, ?)",
  ).run(JSON.stringify({ score: 0.5, scores: [1, 0] }), now - 86_400_000);
  return { file, db };
}

describe("cached plan mastery", () => {
  it("matches a fresh read after a card review", () => {
    const { file, db } = seeded();
    const before = planMastery(db, "p", now);
    rateCard(db, "c", "good", now);
    const cached = planMastery(db, "p", now);
    // Another connection has no cache, so it reads everything again.
    const fresh = openDatabase(file);
    expect(cached).toEqual(planMastery(fresh, "p", now));
    expect(cached[0]!.mastery).not.toBe(before[0]!.mastery);
    expect(planSeries(db, "p", now).chart).toEqual(
      planSeries(fresh, "p", now).chart,
    );
    fresh.close();
    db.close();
  });

  it("reads the events once until a write changes them", () => {
    const { db } = seeded();
    const reads = () => {
      let count = 0;
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        if (sql.includes("FROM learning_events")) count += 1;
        return prepare(sql);
      }) as typeof db.prepare;
      planMastery(db, "p", now);
      db.prepare = prepare;
      return count;
    };
    expect(reads()).toBe(1);
    expect(reads()).toBe(0);
    rateCard(db, "c", "good", now);
    expect(reads()).toBe(1);
    db.close();
  });

  it("follows a card suspended with plain SQL", () => {
    const { file, db } = seeded();
    rateCard(db, "c", "easy", now);
    const rated = planMastery(db, "p", now);
    db.exec("UPDATE cards SET suspended = 1 WHERE id = 'c'");
    const fresh = openDatabase(file);
    expect(planMastery(db, "p", now)).toEqual(planMastery(fresh, "p", now));
    expect(planMastery(db, "p", now)[0]!.mastery).toBeLessThan(
      rated[0]!.mastery,
    );
    fresh.close();
    db.close();
  });

  it("does not keep what a rolled-back transaction wrote", () => {
    const { db } = seeded();
    const before = planMastery(db, "p", now);
    expect(() =>
      db.transaction(() => {
        db.prepare(
          "INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES ('x', 'answer_given', 'p', 't', ?, ?)",
        ).run(JSON.stringify({ score: 1, scores: [1, 1, 1] }), now);
        expect(planMastery(db, "p", now)[0]!.mastery).toBeGreaterThan(
          before[0]!.mastery,
        );
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");
    expect(planMastery(db, "p", now)).toEqual(before);
    db.close();
  });

  it("tells listeners about each write to the evidence", () => {
    const { db } = seeded();
    let calls = 0;
    onEvidenceChanged(db, () => {
      calls += 1;
    });
    db.exec("UPDATE plans SET title = 'Mechanics' WHERE id = 'p'");
    expect(calls).toBe(0);
    rateCard(db, "c", "good", now);
    // One card review and one learning event.
    expect(calls).toBe(2);
    db.close();
  });
});
