import { endedEmpty, type JobView } from "../../../../shared/ipc";
import { checkRef } from "../../../../shared/quiz";
import { isPdfPasswordError } from "../../../../shared/source-errors";
import { jobErrorEngine, jobErrorKey } from "./jobErrors";

/**
 * Why a stopped job needs the student, which decides the one fix the list offers:
 * - `engine`: the AI engine has to be signed in, chosen or changed in Settings before a retry can work;
 * - `locked-pdf`: this file's password;
 * - `interrupted`: Pyxis was closed while it worked, so it can go on from where it stopped;
 * - `stopped`: the student stopped it, so it can go on from where it stopped too;
 * - `retry`: a plain retry, for a failure that can pass;
 * - `nothing-found`: not a failure: the request read everything and found nothing, so it waits for the student to
 *   change it (`endedEmpty`), on the page the row leads to.
 */
export type ProblemKind = "engine" | "locked-pdf" | "interrupted" | "stopped" | "retry" | "nothing-found";

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

/**
 * Jobs of one kind that one request made, such as the files of a linked folder, shown as one row from two jobs up.
 * `family` is the kind they share (a photo read by a vision model counts as an import); `waiting` counts the request's
 * files not queued yet.
 */
export type JobBatch = {
  key: string;
  family: string;
  folder?: string;
  /** Waiting and running, in the order they were made. */
  jobs: JobView[];
  /** Finished today. */
  done: JobView[];
  waiting: number;
};

/** One row of the list: a job on its own, or a request's jobs together. */
export type JobItem = { job: JobView; batch?: undefined } | { batch: JobBatch; job?: undefined };

export type JobGroups = {
  problems: Problem[];
  /** Every waiting and running job, one by one. */
  running: JobView[];
  /** The rows of "Running". */
  runningItems: JobItem[];
  /** The finished jobs the list shows, one by one: a running request's finished jobs are counted on its row instead. */
  finished: JobView[];
  /** The rows of "Finished today". */
  finishedItems: JobItem[];
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
  "library-sort": "jobs.done.librarySort",
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
  "linked-folder-read": "jobs.doing.folderRead",
  "library-sort": "jobs.doing.librarySort",
};

/** The message key for a finished job of this kind, or undefined for work the student never asked for by name. */
export function finishedLabelKey(kind: string): string | undefined {
  return FINISHED_LABELS[kind];
}

/**
 * Where a request that found nothing leads, when it has somewhere to go: a map request opens its map page, where the
 * request can be changed. The page is the scope's, shared by every request of it, so the navigation state names the job
 * whose row was pressed. `ref` is `map:<subjectId>` or `map:<planId>:<topicId>` (core's map build).
 */
export function requestPath(
  job: Pick<JobView, "id" | "kind" | "state" | "error" | "ref">,
): { to: string; state: { job: string } } | undefined {
  if (job.kind !== "map-build" || !endedEmpty(job) || !job.ref?.startsWith("map:")) return undefined;
  const [first, topicId] = job.ref.slice(4).split(":");
  if (!first) return undefined;
  const to = topicId
    ? `/plans/${encodeURIComponent(first)}/map/${encodeURIComponent(topicId)}`
    : `/maps/${encodeURIComponent(first)}`;
  return { to, state: { job: job.id } };
}

/** The message key for running study work of this kind, or undefined when its step says what it does. */
export function runningLabelKey(kind: string): string | undefined {
  return RUNNING_LABELS[kind];
}

/** The check of this answer that is still waiting or running, among every job; another answer's check is not it. */
export function checkJobFor(jobs: readonly JobView[], attemptId: string, questionId: string): JobView | undefined {
  const ref = checkRef(attemptId, questionId);
  return jobs.find(
    (job) => job.kind === "quiz-check" && job.ref === ref && (job.state === "queued" || job.state === "running"),
  );
}

/**
 * The i18next context a job's wording takes: a Review that names its topics, a diagnostic test or a Review without
 * them, else the job's topic when it has one.
 */
export function jobContext(
  job: Pick<JobView, "topic" | "topics" | "activity">,
): "reviewTopic" | "diagnostic" | "review" | "topic" | undefined {
  if (job.activity === "review" && job.topics?.length) return "reviewTopic";
  return job.activity ?? (job.topic ? "topic" : undefined);
}

/**
 * The topic a job's wording names: its own, or a Review's topics as a short list: one, two joined, or the first and a
 * count of the others (`more` words it).
 */
export function jobTopicName(
  job: Pick<JobView, "topic" | "topics">,
  locale: string,
  more: (first: string, others: number) => string,
): string | undefined {
  const topics = job.topics ?? [];
  if (topics.length === 0) return job.topic;
  if (topics.length <= 2) return new Intl.ListFormat(locale, { type: "conjunction" }).format(topics);
  return more(topics[0]!, topics.length - 1);
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
      kind: "stopped",
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

/** The kind a job counts as in a request's row: a photo read by a vision model is an import like the others. */
export function jobFamily(kind: string): string {
  return kind === "source-import-vision" ? "source-import" : kind;
}

function batchKey(job: JobView): string | undefined {
  return job.group ? `${jobFamily(job.kind)}|${job.group.id}` : undefined;
}

/** Rows for `jobs` in their order: a request's jobs (`size` says how many it has in all) at its first one's place. */
function rows(jobs: JobView[], batches: Map<string, JobBatch>, size: (batch: JobBatch) => number): JobItem[] {
  const items: JobItem[] = [];
  const placed = new Set<string>();
  for (const job of jobs) {
    const key = batchKey(job);
    const batch = key ? batches.get(key) : undefined;
    if (!batch || size(batch) < 2) items.push({ job });
    else if (!placed.has(batch.key)) {
      placed.add(batch.key);
      items.push({ batch });
    }
  }
  return items;
}

/** The request `job` belongs to, made on first sight. */
function batchOf(batches: Map<string, JobBatch>, job: JobView): JobBatch | undefined {
  const key = batchKey(job);
  if (!key || !job.group) return undefined;
  let batch = batches.get(key);
  if (!batch) {
    batch = { key, family: jobFamily(job.kind), jobs: [], done: [], waiting: 0 };
    batches.set(key, batch);
  }
  if (job.group.folder && !batch.folder) batch.folder = job.group.folder;
  batch.waiting = Math.max(batch.waiting, job.group.waiting ?? 0);
  return batch;
}

/**
 * Sorts the jobs into what the list shows: what needs the student (stopped jobs, those that stopped for the same reason
 * merged into one, and each request that found nothing, on its own), work in progress, and what finished today.
 * `active` is the runner's list in creation order; `done` the jobs that ended today, newest first: those that succeeded
 * and those that found nothing for their request (`endedEmpty`), which wait under the first group until the student
 * changes or dismisses them. A succeeded job of a kind with no finished-job wording stays out of the list.
 * Jobs of one kind from one request form one row from two jobs up; while some of them run, those that finished are
 * counted on that row rather than listed under finished.
 */
export function groupJobs(active: JobView[], done: JobView[]): JobGroups {
  const problems = new Map<string, Problem>();
  const running: JobView[] = [];
  // A request that found nothing is in `done`; a list read before core moved it has it in `active`.
  const unmatched = new Map<string, JobView>();
  for (const job of [...active, ...done]) if (endedEmpty(job)) unmatched.set(job.id, job);
  for (const job of active) {
    if (job.state === "queued" || job.state === "running") {
      running.push(job);
    } else if (job.state !== "succeeded" && !endedEmpty(job)) {
      const found = problemOf(job);
      const known = problems.get(found.key);
      if (known) known.jobs.push(job);
      else problems.set(found.key, { ...found, jobs: [job] });
    }
  }
  const shown = done.filter((job) => job.state === "succeeded" && finishedLabelKey(job.kind) !== undefined);
  const live = new Map<string, JobBatch>();
  for (const job of running) batchOf(live, job)?.jobs.push(job);
  // A running request counts every member that finished, also of a kind the finished list leaves out (indexing).
  for (const job of done) {
    const key = job.state === "succeeded" ? batchKey(job) : undefined;
    if (key && live.has(key)) live.get(key)!.done.push(job);
  }
  const runningSize = (batch: JobBatch) => batch.jobs.length + batch.done.length + batch.waiting;
  const runningItems = rows(running, live, runningSize);
  const folded = new Set(
    runningItems.flatMap((item) => (item.batch ? item.batch.done.map((job) => job.id) : [])),
  );
  const finished = shown.filter((job) => !folded.has(job.id));
  const ended = new Map<string, JobBatch>();
  for (const job of finished) batchOf(ended, job)?.done.push(job);
  // Newest first, each its own row: every request leads to its own words.
  const requests = [...unmatched.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map<Problem>((job) => ({
      key: `nothing-found:${job.id}`,
      kind: "nothing-found",
      messageKey: jobErrorKey(job.error ?? ""),
      jobs: [job],
    }));
  return {
    problems: [...problems.values(), ...requests],
    running,
    runningItems,
    finished,
    finishedItems: rows(finished, ended, (batch) => batch.done.length),
  };
}
