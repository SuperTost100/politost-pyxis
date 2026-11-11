import type Database from "better-sqlite3";
import type { GenerateInput } from "../engine/generate";
import { selectionFor } from "../engine/selection";
import { sleep, type Runner } from "../jobs/runner";
import { addSubject } from "../plans/subjects";
import { MAX_LOOSE_SENT, sortLibraryFiles } from "./linked-subjects";

/**
 * Where Pyxis is with the subject of a file added from the Library (`sources.subject_sort`):
 * - `waiting`: to be sorted, by the `library-sort` job the Library starts after an add;
 * - `sorted`: Pyxis put it in a subject the student had;
 * - `created`: Pyxis made a new subject for it, which the Library says until the student renames that subject;
 * - `unsure`: the AI tool could not tell, so the student chooses;
 * - `no-ai`: no AI tool was set up, so the student chooses;
 * - `manual`: the student chose.
 * NULL is every source the Library never asked to sort: those from before, linked files, chat and plan copies.
 * Sorting runs once: only `waiting` files are ever sorted, so a file the student placed is never moved behind their back.
 */
export type SubjectSort = "waiting" | "sorted" | "created" | "unsure" | "no-ai" | "manual";

/** What a Library row shows about its subject. `working` while a sort job will place it, `stopped` once that job stopped. */
export type SortView = "working" | "stopped" | "created" | "unsure" | "no-ai";

type SortParams = { sourceIds: string[] };

/** How often, and at most how long, the sort waits for the files' first reading, so it can see what they are about. */
const READ_POLL_MS = 500;
const READ_WAIT_MS = 90_000;
/** How much of a read file's text tells the AI tool what it is about. */
const ABOUT_CHARS = 400;

/** Marks a source the Library just added to be sorted. A source with a subject, or outside the Library, is left alone. */
export function markForSorting(db: Database.Database, sourceId: string): void {
  db.prepare(
    `UPDATE sources SET subject_sort = 'waiting'
     WHERE id = ? AND subject_sort IS NULL AND subject_id IS NULL AND library = 1`,
  ).run(sourceId);
}

/** The sources a `library-sort` job waiting or running will place. */
export function sortingNow(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT params_json FROM jobs WHERE state IN ('queued', 'running') AND kind = 'library-sort'`)
    .pluck()
    .all() as string[];
  return new Set(rows.flatMap((json) => (JSON.parse(json) as SortParams).sourceIds));
}

/** The row state of a source, from its column and the sort jobs that are live (`sortingNow`). */
export function sortView(state: string | null, sourceId: string, live: ReadonlySet<string>): SortView | null {
  if (state === "waiting") return live.has(sourceId) ? "working" : "stopped";
  return state === "created" || state === "unsure" || state === "no-ai" ? state : null;
}

/**
 * Starts one sort for the files one add brought in, as one job, so Attività shows one row for the batch. Only files
 * still waiting and not in another live sort are taken. Returns the job, or null when there was nothing to sort.
 */
export function startLibrarySort(db: Database.Database, runner: Runner, sourceIds: string[]): string | null {
  const live = sortingNow(db);
  const ids = (
    db
      .prepare(
        `SELECT id FROM sources WHERE id IN (SELECT value FROM json_each(?)) AND subject_sort = 'waiting'
         AND status != 'removed' ORDER BY created_at, rowid`,
      )
      .pluck()
      .all(JSON.stringify([...new Set(sourceIds)])) as string[]
  ).filter((id) => !live.has(id));
  return ids.length ? runner.start("library-sort", { sourceIds: ids } satisfies SortParams) : null;
}

/**
 * Puts a source in a subject the student chose, from the row's "Sposta in" or from "Da sistemare": an existing one by
 * id, or a new one by name (reusing a subject with that name in any case). It is `manual` from then on, so no sort moves
 * it. A file read from a linked folder takes its subject from the folder and is refused (`source-linked`).
 */
export function moveSource(
  db: Database.Database,
  sourceId: string,
  to: { subjectId: string } | { name: string },
): { id: string; name: string } {
  return db.transaction(() => {
    const source = db
      .prepare(
        `SELECT s.id, EXISTS (SELECT 1 FROM linked_files l WHERE l.source_id = s.id) AS linked
         FROM sources s WHERE s.id = ? AND s.status != 'removed'`,
      )
      .get(sourceId) as { id: string; linked: number } | undefined;
    if (!source) throw new Error("source-missing");
    if (source.linked) throw new Error("source-linked");
    const subject =
      "name" in to
        ? addSubject(db, to.name)
        : (db.prepare(`SELECT id, name FROM subjects WHERE id = ?`).get(to.subjectId) as
            | { id: string; name: string }
            | undefined);
    if (!subject) throw new Error("subject-missing");
    db.prepare(`UPDATE sources SET subject_id = ?, subject_sort = 'manual', updated_at = ? WHERE id = ?`).run(
      subject.id,
      Date.now(),
      sourceId,
    );
    return subject;
  })();
}

/** The start of a read source's newest text, or nothing while it has none. */
function aboutOf(db: Database.Database, sourceId: string): string | undefined {
  const parts = db
    .prepare(
      `SELECT text FROM passages WHERE source_id = ?
       AND version = (SELECT MAX(version) FROM passages WHERE source_id = ?) ORDER BY rowid LIMIT 4`,
    )
    .pluck()
    .all(sourceId, sourceId) as string[];
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, ABOUT_CHARS) : undefined;
}

/**
 * The `library-sort` job. It first waits, holding no slot, until the files' first reading is over (at most
 * `READ_WAIT_MS`), so the AI tool can see what each is about; reading never waits on it. Then it asks the AI tool
 * about `MAX_LOOSE_SENT` files a call (`sortLibraryFiles`): 200 files are 2 calls. A file goes into the subject the
 * answer names, or into a new subject the answer proposes, made once and shared by every file of the job that the
 * answer gives the same name; a file the answer leaves without one waits for the student (`unsure`). Without an AI
 * tool every file waits for the student (`no-ai`). Each file is written only while it is still `waiting`, so a choice
 * the student made meanwhile stands. A failed call fails the job with its files still waiting, so Riprova in Attività
 * asks again; stopping it does the same, and Riprendi carries on.
 */
export function registerLibrarySort(
  db: Database.Database,
  runner: Runner,
  deps: { run?: GenerateInput["run"]; readWaitMs?: number } = {},
): void {
  const waitingOf = (ids: string[]) =>
    db
      .prepare(
        `SELECT id, title, subject_id AS subjectId FROM sources WHERE id IN (SELECT value FROM json_each(?))
         AND subject_sort = 'waiting' AND status != 'removed' ORDER BY created_at, rowid`,
      )
      .all(JSON.stringify(ids)) as Array<{ id: string; title: string; subjectId: string | null }>;
  runner.register("library-sort", {
    jobClass: "model-cli",
    title: (params) => {
      const { sourceIds } = params as SortParams;
      if (sourceIds.length !== 1) return null;
      return (db.prepare(`SELECT title FROM sources WHERE id = ?`).pluck().get(sourceIds[0]) as string | undefined) ?? null;
    },
    count: (params) => (params as SortParams).sourceIds.length,
    steps: [
      {
        name: "read",
        label: "sources.jobs.sortRead",
        jobClass: null,
        async run(ctx) {
          const { sourceIds } = ctx.params as SortParams;
          const reading = db.prepare(
            `SELECT 1 FROM jobs WHERE state IN ('queued', 'running') AND kind IN ('source-import', 'source-import-vision')
             AND json_extract(params_json, '$.sourceId') IN (SELECT value FROM json_each(?)) LIMIT 1`,
          );
          const until = Date.now() + (deps.readWaitMs ?? READ_WAIT_MS);
          while (reading.get(JSON.stringify(sourceIds)) && Date.now() < until) await sleep(ctx.signal, READ_POLL_MS);
          return {};
        },
      },
      {
        name: "sort",
        label: "sources.jobs.sortSubjects",
        async run(ctx) {
          const { sourceIds } = ctx.params as SortParams;
          const set = db.prepare(
            `UPDATE sources SET subject_id = COALESCE(?, subject_id), subject_sort = ?
             WHERE id = ? AND subject_sort = 'waiting'`,
          );
          const rows = waitingOf(sourceIds);
          // A file that has a subject by now (a linked folder took it over) keeps it.
          for (const row of rows.filter((row) => row.subjectId)) set.run(null, "sorted", row.id);
          const files = rows.filter((row) => !row.subjectId);
          if (!files.length) return {};
          try {
            selectionFor(db, "default");
          } catch {
            db.transaction(() => files.forEach((row) => set.run(null, "no-ai", row.id)))();
            return {};
          }
          // Subjects this job made: a later file proposed into one of them shares it, and says it is new too.
          const made = new Set<string>();
          for (let at = 0; at < files.length; at += MAX_LOOSE_SENT) {
            const chunk = files.slice(at, at + MAX_LOOSE_SENT);
            // The subjects as the AI tool sees them. The student may rename or delete one while it answers, so an
            // answer is resolved through the id it had here, never by its name afterwards.
            const known = db.prepare(`SELECT id, name FROM subjects ORDER BY position, name`).all() as Array<{
              id: string;
              name: string;
            }>;
            const answer = await sortLibraryFiles(
              db,
              known,
              chunk.map((row) => ({ title: row.title, about: aboutOf(db, row.id) })),
              { signal: ctx.signal, run: deps.run },
            );
            if (answer === "no-engine") {
              db.transaction(() => files.slice(at).forEach((row) => set.run(null, "no-ai", row.id)))();
              return {};
            }
            if (answer === "failed") throw new Error("subject-sort-failed");
            db.transaction(() => {
              chunk.forEach((row, index) => {
                // The student may have chosen while the AI tool answered: then nothing is made for this file.
                const still = db.prepare(`SELECT 1 FROM sources WHERE id = ? AND subject_sort = 'waiting'`).get(row.id);
                if (!still) return;
                const placement = answer.get(index) ?? null;
                if (!placement) return void set.run(null, "unsure", row.id);
                let subject: string | undefined;
                if ("subjectId" in placement) {
                  // A subject deleted meanwhile is not made again: the student chooses.
                  subject = db.prepare(`SELECT id FROM subjects WHERE id = ?`).pluck().get(placement.subjectId) as string | undefined;
                } else {
                  // A new subject, or one that has the proposed name by now (in any case), which is not ours to call new.
                  subject = db.prepare(`SELECT id FROM subjects WHERE name = ? COLLATE NOCASE`).pluck().get(placement.proposed) as
                    | string
                    | undefined;
                  if (!subject) {
                    subject = addSubject(db, placement.proposed).id;
                    made.add(subject);
                  }
                }
                if (!subject) return void set.run(null, "unsure", row.id);
                set.run(subject, made.has(subject) ? "created" : "sorted", row.id);
              });
            })();
            ctx.progress(Math.min(1, (at + chunk.length) / files.length));
          }
          return {};
        },
      },
    ],
  });
}
