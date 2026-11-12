import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { renameSource, setChosenKind } from "./manage";
import { listSources } from "./smartbook";

/** A workspace with a few Library files, one of them read from a linked folder's `Analisi/Esercitazioni` folder. */
function setup() {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO subjects (id, name, created_at) VALUES ('ana', 'Analisi 1', 1);
    INSERT INTO sources (id, subject_id, kind, title, status, created_at, updated_at) VALUES
      ('temi', 'ana', 'pdf', 'Temi d''esame 2022-2025', 'ready', 1, 1),
      ('loose', 'ana', 'pdf', '03', 'ready', 2, 2),
      ('long', 'ana', 'pdf', 'Analisi matematica 1', 'ready', 3, 3),
      ('board', NULL, 'image', 'IMG_2041', 'ready', 4, 4);
    INSERT INTO linked_folders (id, path, mode, created_at) VALUES ('f', '${join("/studio", "Polito")}', 'root', 1);
    INSERT INTO linked_subfolders (folder_id, name, subject_id, kinds_json) VALUES ('f', 'Analisi', 'ana', '["exercises","exams"]');
    INSERT INTO linked_files (folder_id, rel_path, subfolder, source_id, size, mtime_ms) VALUES
      ('f', '${join("Analisi", "Esercitazioni", "03.pdf")}', 'Analisi', 'loose', 10, 1);
    INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('d', 'long', 1, '{}', 1);
  `);
  // A 300-page book with no word in its name that says so.
  const passage = db.prepare(
    `INSERT INTO passages (id, source_id, document_id, text, locator_json, created_at) VALUES (?, 'long', 'd', 'testo', ?, 1)`,
  );
  for (const page of [1, 2, 150, 300]) passage.run(`p${page}`, JSON.stringify({ page }));
  const kinds = () =>
    Object.fromEntries(listSources(db).map((source) => [source.id, [source.fileKind, source.kindChosen]]));
  return { db, kinds };
}

describe("the kind of each Library file", () => {
  it("comes from the file's name, its folder, its length and its type", () => {
    const { db, kinds } = setup();
    expect(kinds()).toEqual({
      temi: ["exam", false],
      loose: ["exercises", false],
      long: ["book", false],
      board: ["photo", false],
    });
    expect(listSources(db).find((source) => source.id === "long")?.pages).toBe(300);
    expect(listSources(db).find((source) => source.id === "temi")?.pages).toBeNull();
  });

  it("is the student's choice once they make one, and stays through a rename", () => {
    const { db, kinds } = setup();
    setChosenKind(db, "temi", "notes");
    expect(kinds().temi).toEqual(["notes", true]);
    renameSource(db, "temi", "Esercizi d'esame");
    expect(kinds().temi).toEqual(["notes", true]);
    expect(db.prepare(`SELECT chosen_kind FROM sources WHERE id = 'temi'`).pluck().get()).toBe("notes");
    // The others are still the rule's, and no computed kind is stored.
    expect(db.prepare(`SELECT COUNT(*) FROM sources WHERE chosen_kind IS NOT NULL`).pluck().get()).toBe(1);
  });

  it("refuses a file that is gone", () => {
    const { db } = setup();
    db.prepare(`UPDATE sources SET status = 'removed' WHERE id = 'board'`).run();
    expect(() => setChosenKind(db, "board", "exam")).toThrow("source-missing");
    expect(() => setChosenKind(db, "nothing", "exam")).toThrow("source-missing");
  });

  it("reads a value from a newer build as no choice", () => {
    const { db, kinds } = setup();
    db.prepare(`UPDATE sources SET chosen_kind = 'poster' WHERE id = 'temi'`).run();
    expect(kinds().temi).toEqual(["exam", false]);
  });
});
