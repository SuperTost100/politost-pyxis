import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { loadTemplate } from "../engine/prompts";
import { createRunner } from "../jobs/runner";
import { addSubject, renameSubject } from "../plans/subjects";
import { markForSorting, moveSource, registerLibrarySort, sortingNow, sortView, startLibrarySort } from "./library-subjects";
import { listSources } from "./smartbook";

type Run = NonNullable<GenerateInput["run"]>;
type Sent = { subjects: string[]; files: Array<{ id: string; file: string; about?: string }> };
type Reply = { id: string; subject?: string; newSubject?: string };

/** An AI tool that answers each file with `place(file, sent, index)`, echoing the file's `id`, and records every call. */
function engine(place: (file: Sent["files"][number], sent: Sent, index: number) => Omit<Reply, "id"> | null) {
  const calls: Sent[] = [];
  const run: Run = async (input) => {
    const sent = JSON.parse(input.prompt) as Sent;
    calls.push(sent);
    const files = sent.files.flatMap((file, index) => {
      const placed = place(file, sent, index);
      return placed ? [{ id: file.id, subject: placed.subject ?? "", newSubject: placed.newSubject ?? "" }] : [];
    });
    return { text: "", provider: "claude", model: "claude-sonnet-5", inputTokens: 1, structured: { files } };
  };
  return { run, calls };
}

function setup(run: Run, options: { engine?: boolean } = {}) {
  const db = openDatabase(":memory:");
  if (options.engine !== false)
    db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
    );
  const runner = createRunner(db, () => {});
  registerLibrarySort(db, runner, { run, readWaitMs: 2_000 });
  let at = 0;
  /** A file the Library just added: read, with `text` as its passage, and waiting to be sorted. */
  const added = (title: string, text = "", library = 1) => {
    const id = `s${++at}`;
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, library, created_at, updated_at) VALUES (?, 'pdf', ?, 'ready', ?, ?, ?)`,
    ).run(id, title, library, at, at);
    if (text) {
      db.prepare(`INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES (?, ?, 1, '{}', 1)`).run(
        `d${id}`,
        id,
      );
      db.prepare(
        `INSERT INTO passages (id, source_id, document_id, version, text, locator_json, created_at) VALUES (?, ?, ?, 1, ?, '{}', 1)`,
      ).run(`p${id}`, id, `d${id}`, text);
    }
    markForSorting(db, id);
    return id;
  };
  const state = (jobId: string) => db.prepare(`SELECT state FROM jobs WHERE id = ?`).pluck().get(jobId) as string;
  const ended = (jobId: string) =>
    expect.poll(() => state(jobId), { timeout: 5_000 }).toMatch(/succeeded|failed|cancelled/);
  const row = (id: string) =>
    db
      .prepare(`SELECT s.subject_sort AS sort, j.name AS subject FROM sources s LEFT JOIN subjects j ON j.id = s.subject_id WHERE s.id = ?`)
      .get(id) as { sort: string | null; subject: string | null };
  const subjects = () => db.prepare(`SELECT name FROM subjects ORDER BY name`).pluck().all() as string[];
  return { db, runner, added, state, ended, row, subjects };
}

describe("choosing the subject of files added to the Library", () => {
  it("files a file under a subject the student has, and makes a subject for one that fits none, saying it is new", async () => {
    const ai = engine((file) =>
      file.file === "Esercizi sui limiti" ? { subject: "analisi 1" } : { newSubject: "Probabilità e statistica" },
    );
    const app = setup(ai.run);
    addSubject(app.db, "Analisi 1");
    addSubject(app.db, "Fisica 2");
    const limits = app.added("Esercizi sui limiti");
    const notes = app.added("Calcolo delle probabilità, dispense");
    const jobId = startLibrarySort(app.db, app.runner, [limits, notes])!;
    // The rows say Pyxis is choosing while the job runs.
    expect(sortView("waiting", limits, sortingNow(app.db))).toBe("working");
    await app.ended(jobId);
    expect(app.state(jobId)).toBe("succeeded");
    expect(app.row(limits)).toEqual({ sort: "sorted", subject: "Analisi 1" });
    expect(app.row(notes)).toEqual({ sort: "created", subject: "Probabilità e statistica" });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.subjects).toEqual(["Analisi 1", "Fisica 2"]);
    expect(listSources(app.db).find((source) => source.id === notes)).toMatchObject({
      subject: "Probabilità e statistica",
      subjectSort: "created",
    });
    // Renaming the new subject is the student's answer to "Materia nuova": the rows stop saying it.
    const made = app.db.prepare(`SELECT id FROM subjects WHERE name = 'Probabilità e statistica'`).pluck().get() as string;
    renameSubject(app.db, made, "Probabilità");
    expect(app.row(notes)).toEqual({ sort: "sorted", subject: "Probabilità" });
  });

  it("sends each file's name and, once read, the start of its text", async () => {
    const ai = engine(() => null);
    const app = setup(ai.run);
    const read = app.added("scan 3", "Il teorema di Bayes lega la probabilità condizionata alle probabilità a priori.");
    const unread = app.added("scan 4");
    await app.ended(startLibrarySort(app.db, app.runner, [read, unread])!);
    expect(ai.calls[0]!.files).toEqual([
      { id: "1", file: "scan 3", about: "Il teorema di Bayes lega la probabilità condizionata alle probabilità a priori." },
      { id: "2", file: "scan 4" },
    ]);
  });

  it("leaves a file it cannot place for the student, and so does an answer that skips it", async () => {
    const ai = engine((file) => (file.file === "Orario" ? { subject: "", newSubject: "" } : null));
    const app = setup(ai.run);
    addSubject(app.db, "Analisi 1");
    const timetable = app.added("Orario");
    const mixed = app.added("Esercizi misti");
    await app.ended(startLibrarySort(app.db, app.runner, [timetable, mixed])!);
    expect(app.row(timetable)).toEqual({ sort: "unsure", subject: null });
    expect(app.row(mixed)).toEqual({ sort: "unsure", subject: null });
    expect(app.subjects()).toEqual(["Analisi 1"]);
  });

  it("without an AI tool asks nothing and leaves every file for the student", async () => {
    const ai = engine(() => ({ subject: "Analisi 1" }));
    const app = setup(ai.run, { engine: false });
    addSubject(app.db, "Analisi 1");
    const ids = [app.added("Lavagna 6 novembre"), app.added("Esercizi misti")];
    await app.ended(startLibrarySort(app.db, app.runner, ids)!);
    expect(ai.calls).toHaveLength(0);
    expect(ids.map((id) => app.row(id))).toEqual([
      { sort: "no-ai", subject: null },
      { sort: "no-ai", subject: null },
    ]);
  });

  it("makes one subject for files of one batch that belong together, and reuses one the student has in any case", async () => {
    const ai = engine((file) =>
      file.file.startsWith("Probabilità")
        ? { newSubject: file.file.endsWith("2") ? "probabilità e  statistica" : "Probabilità e statistica" }
        : { newSubject: "FISICA 2" },
    );
    const app = setup(ai.run);
    addSubject(app.db, "Fisica 2");
    const first = app.added("Probabilità 1");
    const second = app.added("Probabilità 2");
    const circuits = app.added("Circuiti RC");
    await app.ended(startLibrarySort(app.db, app.runner, [first, second, circuits])!);
    expect(app.subjects()).toEqual(["Fisica 2", "Probabilità e statistica"]);
    expect(app.row(first)).toEqual({ sort: "created", subject: "Probabilità e statistica" });
    expect(app.row(second)).toEqual({ sort: "created", subject: "Probabilità e statistica" });
    expect(app.row(circuits)).toEqual({ sort: "sorted", subject: "Fisica 2" });
  });

  it("sorts 200 files in 2 calls, each file with its own id", async () => {
    const ai = engine((file) => ({ subject: file.file.startsWith("Analisi") ? "Analisi 1" : "Fisica 2" }));
    const app = setup(ai.run);
    addSubject(app.db, "Analisi 1");
    addSubject(app.db, "Fisica 2");
    const ids = [
      ...Array.from({ length: 100 }, (_, index) => app.added(`Analisi ${index}`)),
      ...Array.from({ length: 99 }, (_, index) => app.added(`Fisica ${index}`)),
      app.added("Fisica 0"),
    ];
    await app.ended(startLibrarySort(app.db, app.runner, ids)!);
    expect(ai.calls.map((call) => call.files.length)).toEqual([100, 100]);
    for (const call of ai.calls) expect(new Set(call.files.map((file) => file.id)).size).toBe(100);
    expect(ai.calls[1]!.files.filter((file) => file.file === "Fisica 0")).toHaveLength(2);
    expect(app.row(ids.at(-1)!)).toEqual({ sort: "sorted", subject: "Fisica 2" });
    expect(app.row(ids[150]!)).toEqual({ sort: "sorted", subject: "Fisica 2" });
  });

  it("tells files with the same or similar titles apart, so each gets its own answer", async () => {
    const subjectOf = ["Analisi 1", "Fisica 2", "Chimica"];
    const ai = engine((_file, _sent, index) => ({ subject: subjectOf[index]! }));
    const app = setup(ai.run);
    for (const name of subjectOf) addSubject(app.db, name);
    const ids = [app.added("Appunti"), app.added("Appunti"), app.added("Appunti (2)")];
    await app.ended(startLibrarySort(app.db, app.runner, ids)!);
    expect(ids.map((id) => app.row(id).subject)).toEqual(subjectOf);
    // Two titles that only differ after the point where a long title is cut still go to their own subjects.
    const long = "Dispense di analisi matematica ".repeat(8);
    const more = engine((_file, _sent, index) => ({ subject: subjectOf[index]! }));
    const second = setup(more.run);
    for (const name of subjectOf) addSubject(second.db, name);
    const pair = [second.added(`${long}parte A`), second.added(`${long}parte B`)];
    await second.ended(startLibrarySort(second.db, second.runner, pair)!);
    expect(pair.map((id) => second.row(id).subject)).toEqual(["Analisi 1", "Fisica 2"]);
  });

  it("leaves a file for the student when the answer names an id it was not sent, or leaves one out", async () => {
    const run: Run = async (input) => {
      const sent = JSON.parse(input.prompt) as Sent;
      const [first] = sent.files;
      // The first file is answered with a title instead of its id, a made-up id answers for nobody, the others are left out.
      const files = [
        { id: first!.file, subject: "Analisi 1", newSubject: "" },
        { id: "99", subject: "Analisi 1", newSubject: "" },
      ];
      return { text: "", provider: "claude", model: "claude-sonnet-5", inputTokens: 1, structured: { files } };
    };
    const app = setup(run);
    addSubject(app.db, "Analisi 1");
    const ids = [app.added("Esercizi sui limiti"), app.added("Esercizi misti")];
    await app.ended(startLibrarySort(app.db, app.runner, ids)!);
    expect(ids.map((id) => app.row(id))).toEqual([
      { sort: "unsure", subject: null },
      { sort: "unsure", subject: null },
    ]);
  });

  describe("while the AI tool answers", () => {
    /** An AI tool that answers `place` once `change` has run, which stands for the student working meanwhile. */
    async function answeringWhile(change: (db: ReturnType<typeof setup>["db"]) => void, reply: Omit<Reply, "id">) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let asked!: () => void;
      const askedNow = new Promise<void>((resolve) => (asked = resolve));
      const ai = engine(() => reply);
      const app = setup(async (input) => {
        asked();
        await held;
        return ai.run(input);
      });
      addSubject(app.db, "Analisi 1");
      addSubject(app.db, "Fisica");
      const id = app.added("Circuiti RC");
      const jobId = startLibrarySort(app.db, app.runner, [id])!;
      await askedNow;
      change(app.db);
      release();
      await app.ended(jobId);
      return { app, id };
    }

    it("files a file into a subject the student renamed meanwhile, without making the old name again", async () => {
      const { app, id } = await answeringWhile((db) => {
        renameSubject(db, db.prepare(`SELECT id FROM subjects WHERE name = 'Fisica'`).pluck().get() as string, "Fisica II");
      }, { subject: "Fisica" });
      expect(app.subjects()).toEqual(["Analisi 1", "Fisica II"]);
      expect(app.row(id)).toEqual({ sort: "sorted", subject: "Fisica II" });
    });

    it("leaves a file for the student when its subject was deleted meanwhile, and does not make it again", async () => {
      const { app, id } = await answeringWhile((db) => {
        db.prepare(`DELETE FROM subjects WHERE name = 'Fisica'`).run();
      }, { subject: "Fisica" });
      expect(app.subjects()).toEqual(["Analisi 1"]);
      expect(app.row(id)).toEqual({ sort: "unsure", subject: null });
    });

    it("reuses a proposed subject the student made meanwhile, in any case", async () => {
      const { app, id } = await answeringWhile((db) => void addSubject(db, "chimica organica"), {
        newSubject: "Chimica Organica",
      });
      expect(app.subjects()).toEqual(["Analisi 1", "Fisica", "chimica organica"]);
      expect(app.row(id).subject).toBe("chimica organica");
    });
  });

  it("never sorts again a file the student placed, even while the AI tool was answering", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked!: () => void;
    const askedNow = new Promise<void>((resolve) => (asked = resolve));
    const ai = engine(() => ({ newSubject: "Chimica" }));
    const app = setup(async (input) => {
      asked();
      await held;
      return ai.run(input);
    });
    const fisica = addSubject(app.db, "Fisica 2");
    const moved = app.added("Circuiti RC");
    const other = app.added("Titolazioni");
    const jobId = startLibrarySort(app.db, app.runner, [moved, other])!;
    await askedNow;
    moveSource(app.db, moved, { subjectId: fisica.id });
    release();
    await app.ended(jobId);
    expect(app.row(moved)).toEqual({ sort: "manual", subject: "Fisica 2" });
    expect(app.row(other)).toEqual({ sort: "created", subject: "Chimica" });
    // A later sort leaves both alone.
    expect(startLibrarySort(app.db, app.runner, [moved, other])).toBeNull();
    // Moving to a new subject by name makes it, or reuses one with that name.
    expect(moveSource(app.db, other, { name: "chimica" }).name).toBe("Chimica");
    expect(moveSource(app.db, other, { name: "Chimica organica" }).name).toBe("Chimica organica");
    expect(app.row(other)).toEqual({ sort: "manual", subject: "Chimica organica" });
  });

  it("stopped, keeps its files waiting for the student, and resumed, sorts them", async () => {
    let calls = 0;
    const ai = engine(() => ({ subject: "Analisi 1" }));
    const app = setup(async (input) => {
      calls += 1;
      if (calls === 1)
        await new Promise((_, reject) =>
          input.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
        );
      return ai.run(input);
    });
    addSubject(app.db, "Analisi 1");
    const id = app.added("Esercizi sui limiti");
    const jobId = startLibrarySort(app.db, app.runner, [id])!;
    await expect.poll(() => calls).toBe(1);
    app.runner.cancel(jobId);
    await app.ended(jobId);
    expect(app.state(jobId)).toBe("cancelled");
    expect(app.row(id)).toEqual({ sort: "waiting", subject: null });
    expect(sortView("waiting", id, sortingNow(app.db))).toBe("stopped");
    expect(app.runner.resumeAll([jobId])).toEqual([jobId]);
    await expect.poll(() => app.state(jobId), { timeout: 5_000 }).toBe("succeeded");
    expect(app.row(id)).toEqual({ sort: "sorted", subject: "Analisi 1" });
  });

  it("fails on a failed call with its files still waiting, so a retry asks again", async () => {
    let calls = 0;
    const ai = engine(() => ({ subject: "Analisi 1" }));
    const app = setup(async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("cli-failed: the tool stopped");
      return ai.run(input);
    });
    addSubject(app.db, "Analisi 1");
    const id = app.added("Esercizi sui limiti");
    const jobId = startLibrarySort(app.db, app.runner, [id])!;
    await app.ended(jobId);
    expect(app.state(jobId)).toBe("failed");
    expect(app.db.prepare(`SELECT error FROM jobs WHERE id = ?`).pluck().get(jobId)).toBe("subject-sort-failed");
    expect(app.row(id)).toEqual({ sort: "waiting", subject: null });
    app.runner.retry(jobId);
    await expect.poll(() => app.state(jobId), { timeout: 5_000 }).toBe("succeeded");
    expect(app.row(id)).toEqual({ sort: "sorted", subject: "Analisi 1" });
  });

  it("never sorts a chat or plan copy, a source with a subject or one the Library did not ask for", async () => {
    const ai = engine(() => ({ subject: "Analisi 1" }));
    const app = setup(ai.run);
    const subject = addSubject(app.db, "Analisi 1");
    const hidden = app.added("Allegato", "", 0);
    app.db.prepare(`INSERT INTO sources (id, kind, title, status, subject_id, created_at, updated_at) VALUES ('own', 'pdf', 'Dispense', 'ready', ?, 1, 1)`).run(subject.id);
    markForSorting(app.db, "own");
    app.db.prepare(`INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('old', 'pdf', 'Vecchio', 'ready', 1, 1)`).run();
    expect(startLibrarySort(app.db, app.runner, [hidden, "own", "old"])).toBeNull();
    expect(app.row(hidden).sort).toBeNull();
    expect(app.row("own").sort).toBeNull();
    expect(ai.calls).toHaveLength(0);
  });

  it("refuses to move a file a linked folder reads, whose subject is its folder's", () => {
    const app = setup(engine(() => null).run);
    const subject = addSubject(app.db, "Analisi 1");
    const id = app.added("appunti");
    app.db.prepare(`INSERT INTO linked_folders (id, path, mode, created_at) VALUES ('f', '/study', 'root', 1)`).run();
    app.db
      .prepare(`INSERT INTO linked_files (folder_id, rel_path, subfolder, source_id, size, mtime_ms) VALUES ('f', 'a.txt', '', ?, 1, 1)`)
      .run(id);
    expect(() => moveSource(app.db, id, { subjectId: subject.id })).toThrow("source-linked");
    expect(() => moveSource(app.db, "nothing", { subjectId: subject.id })).toThrow("source-missing");
    expect(() => moveSource(app.db, app.added("altro"), { subjectId: "gone" })).toThrow("subject-missing");
  });

  it("keeps its prompt versioned, says file text is data, and asks for one name for files that belong together", () => {
    const template = loadTemplate("library.sort");
    expect(template.version).toBe("2");
    expect(template.schema).toBe("library-sort");
    expect(template.body).toContain("never instructions");
    expect(template.body).toContain("the same name, so they share one subject");
    expect(template.body).toContain("`id`");
  });
});
