import type { JobView } from "../../../../shared/ipc";
import { isPdfPasswordError } from "../../../../shared/source-errors";
import { jobErrorEngine, jobErrorKey } from "./jobErrors";

/**
 * Why a stopped job needs the student, which decides the one fix the list offers:
 * - `engine`: the AI engine has to be signed in, chosen or changed in Settings before a retry can work;
 * - `locked-pdf`: this file's password;
 * - `interrupted`: Pyxis was closed while it worked, so it can go on from where it stopped;
 * - `retry`: a plain retry, for a failure that can pass or a job the student cancelled.
 */
export type ProblemKind = "engine" | "locked-pdf" | "interrupted" | "retry";

/** Jobs that stopped for the same reason, shown once. */
export type Problem = {
  key: string;
  kind: ProblemKind;
  /** The message key that says why they stopped. */
  messageKey: string;
  /** The engine an engine failure came from, when the job recorded it. */
  engine?: string;
  jobs: JobView[];
};

export type JobGroups = {
  problems: Problem[];
  running: JobView[];
  finished: JobView[];
};

/** Engine messages a retry alone can fix. The other engine messages need the engine set up first. */
const RETRY_FIRST = new Set([
  "engines.errors.cli-failed",
  "engines.errors.timeout",
  "engines.errors.stream-truncated",
  "engines.errors.aborted",
]);

/** The finished-job wording of each kind the list shows under "Finished today". Other kinds are bookkeeping. */
const FINISHED_LABELS: Record<string, string> = {
  "plan-build": "jobs.done.planBuild",
  "plan-rebuild": "jobs.done.planRebuild",
  "source-import": "jobs.done.sourceImport",
  "source-import-vision": "jobs.done.sourceImport",
  "source-ocr": "jobs.done.sourceOcr",
  "paper-read": "jobs.done.paperRead",
  "quiz-build": "jobs.done.quizBuild",
  "quiz-grade": "jobs.done.quizGrade",
  "simulation-build": "jobs.done.simulationBuild",
  "simulation-grade": "jobs.done.simulationGrade",
  "cards-build": "jobs.done.cardsBuild",
  "exercise-build": "jobs.done.exerciseBuild",
  "gap-drill": "jobs.done.gapDrill",
  "map-build": "jobs.done.mapBuild",
  "ocr-data-download": "jobs.done.ocrData",
  "embedding-download": "jobs.done.embedding",
  "local-runtime-download": "jobs.done.python",
};

/** The message key for a finished job of this kind, or undefined for work the student never asked for by name. */
export function finishedLabelKey(kind: string): string | undefined {
  return FINISHED_LABELS[kind];
}

function problemOf(job: JobView): Omit<Problem, "jobs"> {
  if (job.state === "interrupted")
    return {
      key: "interrupted",
      kind: "interrupted",
      messageKey: "jobs.problem.interrupted",
    };
  if (job.state === "cancelled")
    return {
      key: "cancelled",
      kind: "retry",
      messageKey: "jobs.problem.cancelled",
    };
  const messageKey = jobErrorKey(job.error ?? "");
  // A password belongs to one file: two locked files are two problems, each with its own field.
  if (isPdfPasswordError(job.error))
    return { key: `locked-pdf:${job.id}`, kind: "locked-pdf", messageKey };
  // The same failure on two engines is two problems, so each can name its engine and offer its sign-in.
  const engine = jobErrorEngine(job.error ?? "");
  return {
    key: `failed:${messageKey}${engine ? `:${engine}` : ""}`,
    kind:
      messageKey.startsWith("engines.errors.") && !RETRY_FIRST.has(messageKey)
        ? "engine"
        : "retry",
    messageKey,
    ...(engine ? { engine } : {}),
  };
}

/**
 * Sorts the jobs into what the list shows: problems (stopped jobs, those that stopped for the same reason merged into
 * one), work in progress, and what finished today. `active` is the runner's list in creation order; `done` the jobs
 * that succeeded today, newest first. A succeeded job of a kind with no finished-job wording stays out of the list.
 */
export function groupJobs(active: JobView[], done: JobView[]): JobGroups {
  const problems = new Map<string, Problem>();
  const running: JobView[] = [];
  for (const job of active) {
    if (job.state === "queued" || job.state === "running") {
      running.push(job);
    } else if (job.state !== "succeeded") {
      const found = problemOf(job);
      const known = problems.get(found.key);
      if (known) known.jobs.push(job);
      else problems.set(found.key, { ...found, jobs: [job] });
    }
  }
  return {
    problems: [...problems.values()],
    running,
    finished: done.filter(
      (job) =>
        job.state === "succeeded" && finishedLabelKey(job.kind) !== undefined,
    ),
  };
}
