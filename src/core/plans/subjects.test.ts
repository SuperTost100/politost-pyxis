import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { addSubject, reorderSubjects, removeSubject, renameSubject } from "./subjects";
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
    expect(listSubjects(db)).toEqual([{ ...first, inUse: false, wholeMaps: 0 }]);
    expect(() => addSubject(db, "  ")).toThrow();
    db.close();
  });
  it("renames a subject for its plans and chats and refuses a duplicate name", () => {
    const db = openDatabase(":memory:");
    const fisica = addSubject(db, "Fisica");
    const analisi = addSubject(db, "Analisi");
    db.prepare("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('plan', ?, 'Esame', 'ready', 1, 1)").run(fisica.id);
    db.prepare("INSERT INTO chats (id, subject, created_at, updated_at) VALUES ('chat', 'Fisica', 1, 1)").run();
    expect(renameSubject(db, fisica.id, " Fisica 1 ")).toEqual({ id: fisica.id, name: "Fisica 1" });
    expect(db.prepare("SELECT s.name FROM plans p JOIN subjects s ON s.id = p.subject_id WHERE p.id = 'plan'").get()).toEqual({ name: "Fisica 1" });
    expect(db.prepare("SELECT subject FROM chats WHERE id = 'chat'").get()).toEqual({ subject: "Fisica 1" });
    expect(() => renameSubject(db, fisica.id, "analisi")).toThrow();
    expect(() => renameSubject(db, "missing", "Chimica")).toThrow();
    expect(() => renameSubject(db, analisi.id, " ")).toThrow();
    expect(renameSubject(db, analisi.id, "ANALISI")).toEqual({ id: analisi.id, name: "ANALISI" });
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
  it("deletes a whole subject's maps with the subject, and counts them first, while an exam's maps stay", () => {
    const db = openDatabase(":memory:");
    const subject = addSubject(db, "Fisica");
    const collection = JSON.stringify({ version: 1, maps: [{ id: "a" }, { id: "b" }] });
    db.prepare("INSERT INTO maps (id, subject_id, graph_json, created_at) VALUES ('whole', ?, ?, 1)").run(subject.id, collection);
    // The map alone keeps the subject in use.
    expect(listSubjects(db)).toEqual([{ ...subject, inUse: true, wholeMaps: 2 }]);
    db.prepare("UPDATE maps SET graph_json = ? WHERE id = 'whole'").run(JSON.stringify({ layout: "tree", nodes: [], edges: [], undo: null }));
    expect(listSubjects(db)[0]!.wholeMaps).toBe(1);
    db.prepare("UPDATE maps SET graph_json = ? WHERE id = 'whole'").run(collection);
    db.prepare("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('plan', ?, 'Esame', 'ready', 1, 1)").run(subject.id);
    db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t', 'plan', 'Moto', 0, 1)").run();
    db.prepare("INSERT INTO maps (id, plan_id, topic_id, graph_json, created_at) VALUES ('topic', 'plan', 't', ?, 1)").run(collection);
    expect(listSubjects(db)).toEqual([{ ...subject, inUse: true, wholeMaps: 2 }]);
    removeSubject(db, subject.id);
    expect(db.prepare("SELECT id, subject_id, plan_id FROM maps").all()).toEqual([{ id: "topic", subject_id: null, plan_id: "plan" }]);
    db.close();
  });
  it("marks the subjects an exam, a source or a chat still uses", () => {
    const db = openDatabase(":memory:");
    const exam = addSubject(db, "Fisica");
    const source = addSubject(db, "Chimica");
    addSubject(db, "Storia");
    addSubject(db, "Analisi 1");
    db.prepare("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('plan', ?, 'Esame', 'ready', 1, 1)").run(exam.id);
    db.prepare("INSERT INTO sources (id, kind, title, status, subject_id, created_at, updated_at) VALUES ('src', 'notes', 'Appunti', 'ready', ?, 1, 1)").run(source.id);
    // Subjects match without case, as addSubject does.
    db.prepare("INSERT INTO chats (id, subject, created_at, updated_at) VALUES ('chat', 'storia', 1, 1)").run();
    expect(Object.fromEntries(listSubjects(db).map((row) => [row.name, row.inUse]))).toEqual({
      Fisica: true,
      Chimica: true,
      Storia: true,
      "Analisi 1": false,
    });
    db.close();
  });
});
