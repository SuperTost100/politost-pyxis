import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { SUBJECT_MAP, spread, subjectPassages } from "./subject-sources";

/** A subject's material and, around it, the sources a whole-subject map must leave out. */
function seed() {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO subjects(id,name,position,created_at) VALUES('phys','Fisica I',0,1),('chem','Chimica',1,1);
    INSERT INTO sources(id,subject_id,kind,title,status,library,created_at,updated_at) VALUES
      ('book','phys','pdf','Mazzoldi','ready',1,1,1),
      ('slides','phys','pptx','Slide del corso','ready',1,1,1),
      ('gone','phys','pdf','Spostato','ready',1,1,1),
      ('attached','phys','pdf','Allegato chat','ready',0,1,1),
      ('paper','phys','pdf','Tema febbraio','ready',1,1,1),
      ('pending','phys','pdf','In lettura','added',1,1,1),
      ('other','chem','pdf','Atkins','ready',1,1,1);
    INSERT INTO plans(id,subject_id,title,status,created_at,updated_at) VALUES('p','phys','Fisica','ready',1,1);
    INSERT INTO plan_sources(plan_id,source_id,role) VALUES('p','book','material'),('p','paper','past_paper');
    INSERT INTO linked_folders(id,path,mode,created_at) VALUES('f','/study','root',1);
    INSERT INTO linked_files(folder_id,rel_path,subfolder,source_id,size,mtime_ms,missing_at) VALUES
      ('f','Fisica/slide.pptx','Fisica','slides',1,1,NULL),
      ('f','Fisica/spostato.pdf','Fisica','gone',1,1,5);
  `);
  const insert = db.prepare(
    "INSERT INTO passages(id,source_id,version,text,section_path,created_at) VALUES(?,?,?,?,?,1)",
  );
  // The book's first version, replaced by a second with 3 chapters of 12 passages each.
  insert.run("book-old", "book", 1, "vecchio", "Capitolo 0");
  for (let chapter = 1; chapter <= 3; chapter += 1)
    for (let n = 0; n < 12; n += 1)
      insert.run(`book-${chapter}-${n}`, "book", 2, `${"x".repeat(1000)} ${chapter}.${n}`, `Capitolo ${chapter}`);
  insert.run("slides-1", "slides", 1, "Slide uno", null);
  for (const source of ["gone", "attached", "paper", "pending", "other"])
    insert.run(`${source}-1`, source, 1, "fuori", "Sezione");
  return db;
}

describe("subjectPassages", () => {
  it("reads the subject's current material and leaves out hidden, missing, past-paper and unread sources", () => {
    const db = seed();
    const picked = subjectPassages(db, "phys");
    expect(picked).toHaveLength(SUBJECT_MAP.passages);
    const ids = picked.map((passage) => passage.id);
    expect(new Set(ids.map((id) => id.split("-")[0]))).toEqual(new Set(["book", "slides"]));
    expect(ids).not.toContain("book-old");
    // Every section's first passage is there, in the order of the sources and their passages.
    expect(ids).toEqual(expect.arrayContaining(["book-1-0", "book-2-0", "book-3-0", "slides-1"]));
    expect(ids.slice(0, 2)).toEqual(["book-1-0", "book-1-1"]);
    expect(ids.at(-1)).toBe("slides-1");
    expect(picked.every((passage) => passage.text.length <= SUBJECT_MAP.chars)).toBe(true);
    expect(picked[0]!.section).toBe("Mazzoldi › Capitolo 1");
    expect(picked.at(-1)!.section).toBe("Slide del corso");
    expect(subjectPassages(db, "chem").map((passage) => passage.id)).toEqual(["other-1"]);
  });

  it("takes sections evenly from the first to the last when a subject has more than fit", () => {
    const db = seed();
    db.exec("DELETE FROM passages WHERE source_id = 'book'");
    const insert = db.prepare(
      "INSERT INTO passages(id,source_id,version,text,section_path,created_at) VALUES(?,'book',1,'testo',?,1)",
    );
    for (let n = 0; n < 60; n += 1) insert.run(`s${n}`, `Sezione ${n}`);
    const ids = subjectPassages(db, "phys").map((passage) => passage.id);
    expect(ids).toHaveLength(24);
    expect(ids[0]).toBe("s0");
    expect(ids).toContain("s29");
    // The last section is the slides' only one, and it is still read.
    expect(ids.at(-1)).toBe("slides-1");
  });

  it("reads the study material of the subject's exams, even without a subject of its own or as a past paper elsewhere", () => {
    const db = seed();
    db.exec(`
      INSERT INTO sources(id,subject_id,kind,title,status,library,created_at,updated_at) VALUES
        ('notes',NULL,'pdf','Appunti','ready',1,1,1),
        ('elsewhere',NULL,'pdf','Altro corso','ready',1,1,1);
      INSERT INTO plans(id,subject_id,title,status,created_at,updated_at) VALUES('q','chem','Chimica','ready',1,1);
      INSERT INTO plan_sources(plan_id,source_id,role) VALUES('p','notes','material'),('q','paper','material'),('q','notes','past_paper');
    `);
    const insert = db.prepare(
      "INSERT INTO passages(id,source_id,version,text,section_path,created_at) VALUES(?,?,1,'testo',NULL,1)",
    );
    insert.run("notes-1", "notes");
    insert.run("elsewhere-1", "elsewhere");
    const ids = subjectPassages(db, "phys").map((passage) => passage.id);
    expect(ids).toContain("notes-1");
    expect(ids).not.toContain("elsewhere-1");
    // Chimica studies from the past paper of Fisica I's exam, and has Fisica I's notes as its own past paper.
    expect(subjectPassages(db, "chem").map((passage) => passage.id)).toEqual(["other-1", "paper-1"]);
  });

  it("spreads a list evenly from its first item to its last, or keeps it whole", () => {
    expect(spread([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(spread([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 3, 6, 9]);
    expect(spread([4, 5, 6], 1)).toEqual([4]);
    expect(spread([1, 2], 0)).toEqual([]);
  });
});
