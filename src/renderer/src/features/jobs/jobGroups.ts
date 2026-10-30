import type { JobView } from "../../../../shared/ipc";
import { isPdfPasswordError } from "../../../../shared/source-errors";
import { jobErrorKey } from "./jobErrors";

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
  "cards-propose": "jobs.done.cardsPropose",
  "exercise-build": "jobs.done.exerciseBuild",
  "gap-drill": "jobs.done.gapDrill",
  "gap-insight": "jobs.done.gapInsight",
  "lesson-write": "jobs.done.lessonWrite",
  "lesson-section": "jobs.done.lessonSection",
  "map-build": "jobs.done.mapBuild",
  "ocr-data-download": "jobs.done.ocrData",
  "embedding-download": "jobs.done.embedding",
  "local-runtime-download": "jobs.done.python",
};

/**
 * The running wording of study work, which names its topic (or the diagnostic test or Review) when it has one. Other
 * kinds, such as an import or an exam build, show the step they are at.
 */
const RUNNING_LABELS: Record<string, string> = {
  "quiz-build": "jobs.doing.quizBuild",
  "quiz-grade": "jobs.doing.quizGrade",
  "quiz-check": "jobs.doing.quizCheck",
  "quiz-replace": "jobs.doing.quizReplace",
  "gap-drill": "jobs.doing.gapDrill",
  "gap-insight": "jobs.doing.gapInsight",
  "cards-build": "jobs.doing.cards",
  "cards-propose": "jobs.doing.cards",
  "exercise-build": "jobs.doing.exerciseBuild",
  "lesson-write": "jobs.doing.lessonWrite",
  "lesson-section": "jobs.doing.lessonSection",
  "map-build": "jobs.doing.mapBuild",
  "simulation-build": "jobs.doing.simulationBuild",
  "simulation-grade": "jobs.doing.simulationGrade",
};

/** The message key for a finished job of this kind, or undefined for work the student never asked for by name. */
export function finishedLabelKey(kind: string): string | undefined {
  return FINISHED_LABELS[kind];
}

/** The message key for running study work of this kind, or undefined when its step says what it does. */
export function runningLabelKey(kind: string): string | undefined {
  return RUNNING_LABELS[kind];
}

/** The i18next context a job's wording takes: a diagnostic test or a Review, else its topic when it has one. */
export function jobContext(job: Pick<JobView, "topic" | "activity">): "diagnostic" | "review" | "topic" | undefined {
  return job.activity ?? (job.topic ? "topic" : undefined);
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
  return {
    key: `failed:${messageKey}`,
    kind:
      messageKey.startsWith("engines.errors.") && !RETRY_FIRST.has(messageKey)
        ? "engine"
        : "retry",
    messageKey,
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
