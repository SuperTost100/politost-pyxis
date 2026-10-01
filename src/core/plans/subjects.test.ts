import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { addSubject, reorderSubjects, removeSubject } from "./subjects";
import { listSubjects } from "./create";

describe("ASK-01 shared subjects", () => {
  it("preserves order, deduplicates names and refuses incomplete reorder requests", () => {
    const db = openDatabase(":memory:");
    const first = addSubject(db, " Fisica ");
    const second = addSubject(db, "Analisi");
    expect(addSubject(db, "fisica")).toEqual(first);
    reorderSubjects(db, [second.id, first.id]);
    expect(listSubjects(db).map((row) => row.name)).toEqual(["Analisi", "Fisica"]);
    expect(() => reorderSubjects(db, [first.id])).toThrow();
    expect(() => reorderSubjects(db, [first.id, first.id])).toThrow();
    expect(listSubjects(db)[0]?.id).toBe(second.id);
    removeSubject(db, second.id);
    expect(listSubjects(db)).toEqual([first]);
    expect(() => addSubject(db, "  ")).toThrow();
    db.close();
  });
  it("removes a subject without removing its plan", () => {
    const db = openDatabase(":memory:");
    const subject = addSubject(db, "Fisica");
    db.prepare("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('plan', ?, 'Esame', 'ready', 1, 1)").run(subject.id);
    removeSubject(db, subject.id);
    expect(db.prepare("SELECT title, subject_id FROM plans WHERE id = 'plan'").get()).toEqual({ title: "Esame", subject_id: null });
    db.close();
  });
});
