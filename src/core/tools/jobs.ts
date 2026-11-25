import type Database from "better-sqlite3";
import type { Runner } from "../jobs/runner";
import type { MapResultView } from "../../shared/ipc";

/**
 * What the chat's map and quiz tools share: the job runner, and how a result follows the background job that makes its
 * map or quiz. The tool call only starts the job and returns, since a map or a quiz takes from seconds to minutes and each
 * CLI ends a tool call at its own limit (Claude Code's default for an HTTP server is 5 minutes; Antigravity refuses the
 * per-tool timeout cli-funnel could raise).
 * The result row names the job, so the chat reads how it is going whenever the reply is shown, after a restart too.
 */

let runner: Runner | undefined;

/** The runner the tools start and stop jobs with. Core sets it once with the chat handlers; tests set their own. */
export function setToolRunner(value: Runner | undefined): void {
  runner = value;
}

export function toolRunner(): Runner {
  if (!runner) throw new Error("tool-runner-missing");
  return runner;
}

export type JobRow = { state: string; error: string | null; dismissed: number };

export function jobRow(db: Database.Database, jobId: string | null | undefined): JobRow | undefined {
  if (!jobId) return undefined;
  return db.prepare("SELECT state, error, dismissed FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
}

/** A job's state as the chat's card words it. A job that is gone counts as done: what it made is read on its own. */
export function jobState(job: JobRow | undefined): MapResultView["job"] {
  if (!job) return "done";
  if (job.state === "queued" || job.state === "running") return "working";
  if (job.state === "succeeded") return "done";
  if (job.state === "failed") return "failed";
  if (job.state === "interrupted") return "interrupted";
  return "cancelled";
}

/** Takes a job out of Attività, as its Chiudi does, and returns the mark it had, for `showJob` to put back. */
export function hideJob(db: Database.Database, jobId: string): number | null {
  const job = jobRow(db, jobId);
  if (!job) return null;
  db.prepare("UPDATE jobs SET dismissed = MAX(dismissed, 1) WHERE id = ?").run(jobId);
  return job.dismissed;
}

export function showJob(db: Database.Database, jobId: string, dismissed: number | null): void {
  if (dismissed !== null) db.prepare("UPDATE jobs SET dismissed = ? WHERE id = ? AND dismissed = 1").run(dismissed, jobId);
}

/**
 * Stops a job that is still making its map or quiz and takes it out of Attività, and says whether it was working. A job
 * cancelled here stays retryable: «Ripristina» queues it again from the step it reached.
 */
export function stopJob(db: Database.Database, jobId: string): boolean {
  const job = jobRow(db, jobId);
  if (!job || !["queued", "running", "interrupted"].includes(job.state)) return false;
  // Hidden first: the runner publishes the cancel, and the list it refreshes must already leave the job out.
  db.prepare("UPDATE jobs SET dismissed = MAX(dismissed, 1) WHERE id = ?").run(jobId);
  toolRunner().cancel(jobId);
  return true;
}

/**
 * Goes on with a job that stopped: one that failed or was cancelled is retried, one cut off by a restart is resumed.
 * Throws `tool-busy` when the job is still settling a stop (the student pressed «Ripristina» right after «Ferma»), so
 * the card says it did not work and the student tries again.
 */
export function goOnWithJob(db: Database.Database, jobId: string): void {
  const job = jobRow(db, jobId);
  if (!job) throw new Error("tool-result-missing");
  if (job.state === "queued" || job.state === "succeeded") {
    db.prepare("UPDATE jobs SET dismissed = 0 WHERE id = ? AND dismissed = 1").run(jobId);
    return;
  }
  if (job.state === "running") throw new Error("tool-busy");
  // The runner refuses a job given up for good (a map deleted while it was built), and so does this.
  if (job.state === "interrupted") toolRunner().resume(jobId);
  else toolRunner().retry(jobId);
  const after = jobRow(db, jobId);
  if (!after || after.state !== "queued") throw new Error("tool-busy");
}

/**
 * The jobs of the chat's maps and quizzes that a restart cut off, queued again: the card in the chat stays at work, as
 * it was when Pyxis closed. Other model work waits for the student in Attività, but this job was asked for in the chat
 * and the chat shows it working. Results the student undid are left alone.
 */
export function resumeToolJobs(db: Database.Database): void {
  if (!runner) return;
  const ids = db
    .prepare(
      `SELECT DISTINCT j.id FROM chat_tool_results r
       JOIN jobs j ON (
         (r.tool = 'create_map' AND j.id = json_extract(r.data_json, '$.jobId')) OR
         (r.tool = 'create_quiz' AND j.kind = 'quiz-build' AND json_extract(j.params_json, '$.attemptId') = json_extract(r.data_json, '$.attemptId'))
       )
       WHERE r.undone_json IS NULL AND r.tool IN ('create_map', 'create_quiz') AND j.state = 'interrupted'`,
    )
    .pluck()
    .all() as string[];
  for (const id of ids) runner.resume(id);
}

/** Rows of one table, whole, as objects, so `insertRows` can put them back exactly as they were. */
export function readRows(db: Database.Database, table: string, where: string, ...args: unknown[]): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...args) as Array<Record<string, unknown>>;
}

/** Puts rows `readRows` read back into their table, with the same ids and values. */
export function insertRows(db: Database.Database, table: string, rows: ReadonlyArray<Record<string, unknown>>): void {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...columns.map((column) => row[column]));
  }
}
