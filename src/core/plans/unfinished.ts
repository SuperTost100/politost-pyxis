import type Database from "better-sqlite3";
import type { Runner } from "../jobs/runner";
import { DRAFT_GRACE_MS } from "../study/attempt";
import { discardReview, readReview } from "../study/review";
import { readSimulationBuild } from "../study/simulation";

/**
 * "Da finire" on the exam page: what the student started on this exam and did not hand in. See "Unfinished activities"
 * in docs/mastery.md for the rule. Every entry is something its page already resumes: a quiz, gap drill, diagnostic,
 * redo or past-paper quiz by its open attempt, the review by its session, a simulation by its attempt or by the build
 * that prepares it.
 */
export type UnfinishedKind =
  "quiz" | "drill" | "diagnostic" | "redo" | "past" | "review" | "simulation";
/**
 * `open` is waiting for answers; `writing` is still being written by a job; `stopped` is a job that stopped before it
 * finished writing; `ready` is a prepared simulation not started yet; `expired` ran out of time and is handed in when
 * it is opened.
 */
export type UnfinishedState =
  "open" | "writing" | "stopped" | "ready" | "expired";
export type Unfinished = {
  /** `attempt:<id>`, `build:<jobId>` or `review:<sessionId>`: what `deleteUnfinished` takes. */
  id: string;
  kind: UnfinishedKind;
  /** The topic the activity is on, or null for one across the exam. */
  topicId: string | null;
  topicTitle: string | null;
  /** The topic its page opens under: a quiz's page lives under a topic even when the quiz spans the exam. */
  routeTopicId: string | null;
  attemptId: string | null;
  answered: number;
  total: number;
  state: UnfinishedState;
  startedAt: number;
};

const ACTIVE_JOB = new Set(["queued", "running"]);

type AttemptRow = {
  id: string;
  item_id: string;
  started_at: number;
  kind: string;
  topic_id: string | null;
  body_json: string;
  drill: number;
};

type QuizBody = {
  complete?: boolean;
  redo?: boolean;
  pastPaper?: number;
  config?: { count?: number; timerMinutes?: number };
  questions: Array<{ id: string; topicId?: string }>;
};

type SimulationBody = {
  minutes: number;
  picks?: Record<string, string>;
  gradingStartedAt?: number;
  questions: Array<{ id: string }>;
};

/** Answers given so far: draft picks with something in them, and answers checked one by one before 0.5. */
function quizAnswered(
  db: Database.Database,
  attemptId: string,
  ids: Set<string>,
) {
  const rows = db
    .prepare("SELECT payload_json FROM attempt_answers WHERE attempt_id = ?")
    .all(attemptId) as Array<{ payload_json: string }>;
  const given = new Set<string>();
  let deadlineAt: number | undefined;
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as {
      draft?: { picks?: Record<string, string> };
      deadlineAt?: number;
      check?: { id?: string };
    };
    for (const [id, pick] of Object.entries(payload.draft?.picks ?? {}))
      if (ids.has(id) && pick.trim() !== "") given.add(id);
    if (payload.check?.id && ids.has(payload.check.id))
      given.add(payload.check.id);
    if (payload.deadlineAt != null) deadlineAt = payload.deadlineAt;
  }
  return { answered: given.size, deadlineAt };
}

/** Every unfinished activity of one exam, newest first. */
export function unfinishedActivities(
  db: Database.Database,
  planId: string,
  now = Date.now(),
): Unfinished[] {
  const titles = db.prepare(
    "SELECT title FROM topics WHERE id = ? AND plan_id = ?",
  );
  const titleOf = (topicId: string | null) =>
    topicId
      ? ((titles.get(topicId, planId) as { title: string } | undefined)
          ?.title ?? null)
      : null;
  const firstTopic =
    (
      db
        .prepare(
          "SELECT id FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position LIMIT 1",
        )
        .get(planId) as { id: string } | undefined
    )?.id ?? null;
  // Handing in starts a grading job before the attempt is closed: from then on it is handed in.
  const rows = db
    .prepare(
      `SELECT a.id, a.item_id, a.started_at, i.kind, i.topic_id, i.body_json,
         EXISTS (SELECT 1 FROM gap_items g WHERE g.item_id = i.id) AS drill
       FROM attempts a JOIN items i ON i.id = a.item_id
       WHERE a.plan_id = ? AND a.submitted_at IS NULL AND i.kind IN ('quiz', 'diagnostic', 'simulation')
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'quiz-grade' AND json_extract(j.params_json, '$.attemptId') = a.id)
       ORDER BY a.started_at DESC, a.id DESC`,
    )
    .all(planId) as AttemptRow[];
  const buildOf = db.prepare(
    "SELECT state FROM jobs WHERE kind = 'quiz-build' AND json_extract(params_json, '$.attemptId') = ? ORDER BY created_at DESC LIMIT 1",
  );
  const list: Unfinished[] = [];
  // One entry per quiz, as reopening a quiz from the path resumes its newest open attempt (`openPlanQuiz`). The
  // diagnostic, redo and past-paper quizzes are started afresh from their buttons, so only the newest of each counts.
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.kind === "simulation") {
      const body = JSON.parse(row.body_json) as SimulationBody;
      // Grading started: the answers are frozen and the simulation is handed in.
      if (body.gradingStartedAt != null) continue;
      const ids = new Set(body.questions.map((question) => question.id));
      list.push({
        id: `attempt:${row.id}`,
        kind: "simulation",
        topicId: null,
        topicTitle: null,
        routeTopicId: null,
        attemptId: row.id,
        answered: Object.entries(body.picks ?? {}).filter(
          ([id, pick]) => ids.has(id) && pick.trim() !== "",
        ).length,
        total: body.questions.length,
        state:
          now > row.started_at + body.minutes * 60_000 + DRAFT_GRACE_MS
            ? "expired"
            : "open",
        startedAt: row.started_at,
      });
      continue;
    }
    const body = JSON.parse(row.body_json) as QuizBody;
    const kind: UnfinishedKind =
      row.kind === "diagnostic"
        ? "diagnostic"
        : body.redo
          ? "redo"
          : body.pastPaper
            ? "past"
            : row.drill
              ? "drill"
              : "quiz";
    const key = kind === "quiz" || kind === "drill" ? row.item_id : kind;
    if (seen.has(key)) continue;
    seen.add(key);
    const ids = new Set(body.questions.map((question) => question.id));
    const { answered, deadlineAt } = quizAnswered(db, row.id, ids);
    const job =
      kind === "quiz" && !body.complete
        ? (buildOf.get(row.id) as { state: string } | undefined)
        : undefined;
    // A configured quiz is written by its job; once the job is over without finishing, it waits for a retry.
    const writing = kind === "quiz" && !body.complete;
    const topicId = row.topic_id ?? null;
    list.push({
      id: `attempt:${row.id}`,
      kind,
      topicId,
      topicTitle: titleOf(topicId),
      routeTopicId:
        topicId ??
        body.questions.find((question) => question.topicId)?.topicId ??
        firstTopic,
      attemptId: row.id,
      answered,
      total: writing
        ? Math.max(body.config?.count ?? 0, body.questions.length)
        : body.questions.length,
      state:
        writing && job && ACTIVE_JOB.has(job.state)
          ? "writing"
          : writing
            ? "stopped"
            : deadlineAt != null && now > deadlineAt + DRAFT_GRACE_MS
              ? "expired"
              : "open",
      startedAt: row.started_at,
    });
  }
  // The review: cards and questions in one session, resumed until it is done or a day old (`readReview`).
  const review = readReview(db, planId, now);
  if (review?.sessionId) {
    const created = db
      .prepare("SELECT created_at FROM items WHERE id = ?")
      .get(review.sessionId) as { created_at: number } | undefined;
    list.push({
      id: `review:${review.sessionId}`,
      kind: "review",
      topicId: null,
      topicTitle: null,
      routeTopicId: null,
      attemptId: null,
      answered: review.progress.done,
      total: review.progress.total,
      state: "open",
      startedAt: created?.created_at ?? now,
    });
  }
  // A simulation being prepared, or prepared and not started: the simulation page shows it and starts it.
  const build = readSimulationBuild(db, planId);
  if (build && build.state !== "cancelled") {
    const job = db
      .prepare("SELECT created_at, params_json FROM jobs WHERE id = ?")
      .get(build.jobId) as
      { created_at: number; params_json: string } | undefined;
    const params = job
      ? (JSON.parse(job.params_json) as {
          questions?: unknown[];
          batches?: unknown[];
        })
      : {};
    list.push({
      id: `build:${build.jobId}`,
      kind: "simulation",
      topicId: null,
      topicTitle: null,
      routeTopicId: null,
      attemptId: null,
      answered: 0,
      total: params.questions?.length ?? 0,
      state:
        build.state === "succeeded"
          ? "ready"
          : ACTIVE_JOB.has(build.state)
            ? "writing"
            : "stopped",
      startedAt: job?.created_at ?? now,
    });
  }
  return list.sort((a, b) => b.startedAt - a.startedAt);
}

/** The jobs that work for one attempt: writing its questions, checking or grading its answers. */
const ATTEMPT_JOBS = `kind IN ('quiz-build', 'quiz-check', 'quiz-grade') AND json_extract(params_json, '$.attemptId') = ?`;

/**
 * Deletes one unfinished activity of the exam: its answers and whatever job still writes it. A quiz that is complete
 * and belongs to a topic stays in that topic's list on the path, to be done again; anything else made only for this
 * attempt goes with it: a quiz still being written, a redo, a past-paper quiz, a simulation. The diagnostic keeps its
 * questions, which the next diagnostic reuses. The review is discarded as its own page discards it, and a simulation
 * being prepared stops and is forgotten. Throws `unfinished-missing` when the activity is not there or is finished.
 */
export function deleteUnfinished(
  db: Database.Database,
  runner: Pick<Runner, "cancel"> | undefined,
  planId: string,
  id: string,
  now = Date.now(),
): { ok: true } {
  const [what, key = ""] = id.split(/:(.*)/s, 2) as [string, string?];
  const current = unfinishedActivities(db, planId, now).find(
    (entry) => entry.id === id,
  );
  if (!current) throw new Error("unfinished-missing");
  if (what === "review") {
    discardReview(db, planId, now);
    return { ok: true };
  }
  if (what === "build") {
    runner?.cancel(key);
    db.prepare(
      "DELETE FROM jobs WHERE id = ? AND kind = 'simulation-build'",
    ).run(key);
    return { ok: true };
  }
  const row = db
    .prepare(
      `SELECT a.item_id, i.kind, i.topic_id, i.body_json FROM attempts a JOIN items i ON i.id = a.item_id
       WHERE a.id = ? AND a.plan_id = ?`,
    )
    .get(key, planId) as {
    item_id: string;
    kind: string;
    topic_id: string | null;
    body_json: string;
  };
  const jobs = db
    .prepare(`SELECT id FROM jobs WHERE ${ATTEMPT_JOBS}`)
    .all(key) as Array<{ id: string }>;
  for (const job of jobs) runner?.cancel(job.id);
  const body = JSON.parse(row.body_json) as QuizBody & { buildJobId?: string };
  db.transaction(() => {
    db.prepare(`DELETE FROM jobs WHERE ${ATTEMPT_JOBS}`).run(key);
    db.prepare("DELETE FROM attempts WHERE id = ?").run(key);
    const keep =
      row.kind === "diagnostic" ||
      (row.kind === "quiz" &&
        row.topic_id != null &&
        body.complete !== false &&
        !body.redo &&
        !body.pastPaper);
    const used = db
      .prepare("SELECT 1 FROM attempts WHERE item_id = ? LIMIT 1")
      .get(row.item_id);
    if (keep || used) return;
    // The build a simulation started from goes too, or it would count as prepared again.
    if (row.kind === "simulation" && body.buildJobId)
      db.prepare(
        "DELETE FROM jobs WHERE id = ? AND kind = 'simulation-build'",
      ).run(body.buildJobId);
    db.prepare("DELETE FROM items WHERE id = ?").run(row.item_id);
  })();
  return { ok: true };
}
