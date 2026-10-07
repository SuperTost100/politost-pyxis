import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import type { Runner } from "../jobs/runner";
import { readSteps } from "../plans/steps";
import { planSeries } from "../plans/progress";
import { saveQuiz, startAttempt, type QuizQuestion } from "./attempt";
import { dueCards } from "./cards";
import { topicExercises } from "./exercises";
import { flaggedIds } from "./flags";
import type { Grade } from "./grade";
import { enqueueGapDrill, REVIEW_SESSION_TTL } from "./gapDrill";
import { mixQuestions } from "./mix";
import { quizDraft } from "./quizGrading";
import { acrossTopics } from "./topicQuiz";

/** A review left alone this long is not resumed; the next start builds a fresh one. */
const SESSION_TTL = REVIEW_SESSION_TTL;
const MAX_CARDS = 20;
const GAP_QUESTIONS = 5;
const NEW_QUESTIONS = 3;
// ponytail: each drill is a model job (an explanation and five questions), so one review asks for at most this many; a later review picks up the rest.
const MAX_DRILLS = 2;

/**
 * A gap with no questions asks for a gap-drill job. The review keeps the job and how many
 * questions it expects from it; once the job succeeds its first `want` questions join the
 * review's own question attempt, once (`adopted`).
 */
type Drill = {
  topicId: string;
  /** The gap it was queued for; a drill queued before gaps had ids has none and follows its topic. */
  gapId?: string;
  jobId: string;
  want: number;
  adopted?: true;
  /** The student chose to go on without it. Kept in the session, so it holds whatever the runner does to the job. */
  skipped?: true;
  /** The drill's short explanation, kept when its questions join the review. */
  explanation?: string;
};
/**
 * The stored queue of one mixed review (LES-13). Cards and the question attempt are fixed
 * when it starts, apart from adopted drill questions; progress is derived from `card_reviews`
 * and the attempt, never stored.
 */
type Session = { cardIds: string[]; attemptId: string; drills: Drill[]; discardedAt?: number };
type Row = { id: string; created_at: number; body_json: string };
/** Drill jobs in these states may still add questions, so the review cannot be submitted yet. */
const WAITING = new Set(["queued", "running", "interrupted", "failed"]);

function parse(row: Row): Session {
  const body = JSON.parse(row.body_json) as Session;
  return { ...body, drills: (body.drills ?? []).filter((drill) => typeof drill === "object") };
}

function latestSession(db: Database.Database, planId: string) {
  return db
    .prepare(
      `SELECT id, created_at, body_json FROM items
       WHERE plan_id = ? AND kind = 'review_session'
         AND json_extract(body_json, '$.discardedAt') IS NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(planId) as Row | undefined;
}

/** A topic a rebuild archived no longer takes part in a review, however its drill was queued. */
function topicLive(db: Database.Database, topicId: string): boolean {
  return db.prepare("SELECT 1 FROM topics WHERE id = ? AND archived_at IS NULL").get(topicId) != null;
}

/** A drill is still wanted while its topic is active and its gap has not closed (or merged away). */
function drillLive(db: Database.Database, drill: Drill): boolean {
  if (!topicLive(db, drill.topicId)) return false;
  return !drill.gapId || db.prepare("SELECT 1 FROM gaps WHERE id = ? AND closed_at IS NULL").get(drill.gapId) != null;
}

/** A drill whose questions may still arrive: not adopted, not skipped, and still wanted. */
const pendingDrill = (db: Database.Database, drill: Drill) => !drill.adopted && !drill.skipped && drillLive(db, drill);

function jobOf(db: Database.Database, jobId: string) {
  const job = db.prepare("SELECT state, params_json FROM jobs WHERE id = ?").get(jobId) as
    | { state: string; params_json: string }
    | undefined;
  return job
    ? { state: job.state, itemId: (JSON.parse(job.params_json) as { itemId?: string }).itemId }
    : undefined;
}

/** A drill question as a review question: closed forms keep their grade, a blank becomes a model-graded answer. */
function drillQuestion(
  question: Record<string, unknown> & { id: string; answer: Grade; stem: string },
  topicId: string,
  gapId?: string,
) {
  const { answer } = question;
  // `gapId` keeps the question's wrong answers counting for the gap the drill was built for.
  return answer.kind === "completion"
    ? {
        ...question,
        topicId,
        gapId,
        stem: question.stem.replace(/\{\{\d+\}\}/g, "____"),
        answer: { kind: "open", answer: "", reference: answer.accepted[0]?.[0] ?? "" },
      }
    : { ...question, topicId, gapId };
}

/**
 * Adds each completed drill's questions to the review's open attempt, exactly once. Picks, the
 * draft and the ids of questions already there are untouched. Returns whether any were added.
 */
function adopt(db: Database.Database, planId: string, sessionId: string): boolean {
  return db.transaction(() => {
    const row = db.prepare("SELECT id, created_at, body_json FROM items WHERE id = ?").get(sessionId) as Row;
    const body = parse(row);
    const target = body.attemptId
      ? (db
          .prepare(
            `SELECT i.id, i.body_json FROM attempts a JOIN items i ON i.id = a.item_id
             WHERE a.id = ? AND a.plan_id = ? AND a.submitted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM jobs WHERE kind = 'quiz-grade'
                               AND json_extract(params_json, '$.attemptId') = a.id)`,
          )
          .get(body.attemptId, planId) as { id: string; body_json: string } | undefined)
      : undefined;
    if (!target) return false;
    const stored = JSON.parse(target.body_json) as { questions: Array<{ id: string } & Record<string, unknown>> };
    const have = new Set(stored.questions.map((question) => question.id));
    let added = 0;
    let changed = false;
    for (const drill of body.drills) {
      const job = pendingDrill(db, drill) ? jobOf(db, drill.jobId) : undefined;
      if (job?.state !== "succeeded") continue;
      const drillItem = job.itemId
        ? (db
            .prepare("SELECT body_json FROM items WHERE id = ? AND plan_id = ?")
            .get(job.itemId, planId) as { body_json: string } | undefined)
        : undefined;
      const drillBody = JSON.parse(drillItem?.body_json ?? '{"questions":[]}') as {
        explanation?: string;
        questions: Array<Record<string, unknown> & { id: string; answer: Grade; stem: string }>;
      };
      const pool = drillBody.questions.filter((question) => !have.has(question.id));
      if (drillBody.explanation) drill.explanation = drillBody.explanation;
      // Closed forms first: they are graded locally and need no model call.
      const picked = [
        ...pool.filter((question) => question.answer.kind !== "completion"),
        ...pool.filter((question) => question.answer.kind === "completion"),
      ].slice(0, drill.want);
      for (const question of picked) {
        stored.questions.push(drillQuestion(question, drill.topicId, drill.gapId));
        have.add(question.id);
      }
      if (job.itemId)
        db.prepare(
          `INSERT OR IGNORE INTO item_passages (item_id, passage_id)
           SELECT ?, passage_id FROM item_passages WHERE item_id = ?`,
        ).run(target.id, job.itemId);
      drill.adopted = true;
      changed = true;
      added += picked.length;
    }
    if (!changed) return false;
    db.prepare("UPDATE items SET body_json = ? WHERE id = ?").run(JSON.stringify(stored), target.id);
    db.prepare("UPDATE items SET body_json = ? WHERE id = ?").run(JSON.stringify(body), row.id);
    return added > 0;
  })();
}

function view(db: Database.Database, planId: string, found: Row) {
  adopt(db, planId, found.id);
  const row = db.prepare("SELECT id, created_at, body_json FROM items WHERE id = ?").get(found.id) as Row;
  const body = parse(row);
  const left = new Set(
    (
      db
        .prepare(
          `SELECT c.id FROM cards c
           WHERE c.id IN (SELECT value FROM json_each(?)) AND c.suspended = 0 AND c.removed = 0
             AND NOT EXISTS (SELECT 1 FROM card_reviews r WHERE r.card_id = c.id AND r.reviewed_at >= ?)`,
        )
        .all(JSON.stringify(body.cardIds), row.created_at) as Array<{ id: string }>
    ).map((card) => card.id),
  );
  const order = new Map(body.cardIds.map((id, index) => [id, index]));
  const cards = dueCards(db, planId, Date.now(), undefined, [...left]).sort(
    (a, b) => order.get(a.id)! - order.get(b.id)!,
  );
  // A card the review can no longer show (archived topic, suspended, removed) leaves the queue: it counts as neither done nor to do.
  const cardsDone = (
    db
      .prepare(
        `SELECT count(*) AS n FROM cards c
         WHERE c.id IN (SELECT value FROM json_each(?))
           AND EXISTS (SELECT 1 FROM card_reviews r WHERE r.card_id = c.id AND r.reviewed_at >= ?)`,
      )
      .get(JSON.stringify(body.cardIds), row.created_at) as { n: number }
  ).n;
  const cardsTotal = cardsDone + cards.length;
  const attempt = body.attemptId
    ? (db
        .prepare(
          `SELECT a.submitted_at, i.body_json FROM attempts a JOIN items i ON i.id = a.item_id
           WHERE a.id = ? AND a.plan_id = ?`,
        )
        .get(body.attemptId, planId) as
        { submitted_at: number | null; body_json: string } | undefined)
    : undefined;
  const stored = attempt
    ? (JSON.parse(attempt.body_json) as {
        questions: Array<{
          id: string;
          sourceId?: string;
          stem: string;
          options?: string[];
          left?: string[];
          right?: string[];
          answer: { kind: string };
        }>;
      }).questions
    : [];
  const submitted = attempt?.submitted_at != null;
  const answered = submitted
    ? stored.length
    : Object.values(quizDraft(db, body.attemptId)?.draft.picks ?? {}).filter(
        (pick) => pick.trim() !== "",
      ).length;
  // A drill that was skipped stays listed; one whose gap closed or topic was archived is dropped.
  const waiting = body.drills.flatMap((drill) => {
    if (drill.adopted || !drillLive(db, drill)) return [];
    const job = jobOf(db, drill.jobId);
    return job || drill.skipped ? [{ drill, state: drill.skipped ? "skipped" : job!.state }] : [];
  });
  // Questions a drill still owes, bounded by what the review asked it for. They are expected, not done.
  const pending = submitted
    ? 0
    : waiting.reduce((sum, row) => sum + (WAITING.has(row.state) ? row.drill.want : 0), 0);
  const total = cardsTotal + stored.length + pending;
  const done = cardsDone + Math.min(answered, stored.length);
  return {
    sessionId: row.id,
    cards,
    attemptId: attempt ? body.attemptId : "",
    questions: stored.map(({ answer, ...question }) => ({
      ...question,
      grade: { kind: answer.kind },
    })),
    progress: {
      done,
      total,
      cardsDone,
      cardsTotal,
      questionsDone: done - cardsDone,
      questionsTotal: stored.length,
      questionsPending: pending,
    },
    next:
      cards.length > 0
        ? ("cards" as const)
        : attempt && !submitted && stored.length > 0
          ? ("questions" as const)
          : pending > 0
            ? ("waiting" as const)
            : ("done" as const),
    // A drill that has not delivered yet, with the state its job is in, so Review can offer cancel, retry or resume.
    drills: submitted
      ? []
      : waiting.flatMap(({ drill, state }) => {
          const title = db.prepare("SELECT title FROM topics WHERE id = ?").get(drill.topicId) as
            { title: string } | undefined;
          return state === "succeeded"
            ? []
            : [
                {
                  topicId: drill.topicId,
                  gapId: drill.gapId,
                  title: title?.title ?? "",
                  jobId: drill.jobId,
                  state,
                  want: drill.want,
                },
              ];
        }),
    // Each adopted drill's short explanation (LES-03), for showing above its questions.
    explanations: submitted
      ? []
      : body.drills.flatMap((drill) => {
          if (!drill.adopted || !drill.explanation) return [];
          const title = db.prepare("SELECT title FROM topics WHERE id = ?").pluck().get(drill.topicId) as string | undefined;
          return [{ topicId: drill.topicId, gapId: drill.gapId, title: title ?? "", text: drill.explanation }];
        }),
  };
}

export type ReviewSession = ReturnType<typeof view>;

/** Nothing is due and nothing is weak: no session is stored. */
const emptyReview: ReviewSession = {
  sessionId: "",
  cards: [],
  attemptId: "",
  questions: [],
  progress: {
    done: 0,
    total: 0,
    cardsDone: 0,
    cardsTotal: 0,
    questionsDone: 0,
    questionsTotal: 0,
    questionsPending: 0,
  },
  next: "done",
  drills: [],
  explanations: [],
};

/** The review to resume: the plan's latest, unless it is finished or older than the TTL. */
export function readReview(
  db: Database.Database,
  planId: string,
  now = Date.now(),
): ReviewSession | null {
  const row = latestSession(db, planId);
  if (!row || now - row.created_at > SESSION_TTL) return null;
  const session = view(db, planId, row);
  return session.next === "done" ? null : session;
}

/**
 * Open gaps in Progress order, each with its topic's usable questions: unseen ones first. A topic with several gaps lists
 * its questions once, on its first gap; `available` still says the topic has some.
 */
function gapBuckets(db: Database.Database, planId: string, now: number, used: Set<string>) {
  const blocked = flaggedIds(db, "exercise");
  const seen = new Set<string>();
  return planSeries(db, planId, now).gaps.map((gap) => {
    const all = topicExercises(db, gap.topicId)
      .filter((item) => item.answer?.trim() && !blocked.has(item.id))
      .sort((a, b) => Number(used.has(a.id)) - Number(used.has(b.id)))
      .map((item) => ({ ...item, topicId: gap.topicId }));
    const first = !seen.has(gap.topicId);
    seen.add(gap.topicId);
    return { topicId: gap.topicId, gapId: gap.gapId, available: all.length, rows: first ? all : [] };
  });
}

function usedSources(db: Database.Database, planId: string): Set<string> {
  const used = new Set<string>();
  const past = db
    .prepare(`SELECT body_json FROM items WHERE plan_id = ? AND kind IN ('quiz', 'review')`)
    .all(planId) as Array<{ body_json: string }>;
  for (const row of past) {
    try {
      const stored = JSON.parse(row.body_json) as {
        questions?: Array<{ sourceId?: string; sourceIds?: string[] }>;
      };
      for (const question of stored.questions ?? []) {
        for (const id of question.sourceIds ?? []) used.add(id);
        if (question.sourceId) used.add(question.sourceId);
      }
    } catch {
      continue;
    }
  }
  return used;
}

/** The topic the student is learning now: the one whose lesson they read last; null before any lesson is read. */
function frontierTopic(db: Database.Database, planId: string): string | null {
  return readSteps(db, planId).findLast((step) => step.activity === "lesson")?.topicId ?? null;
}

function latestScore(db: Database.Database, planId: string, topicId: string): number | undefined {
  const row = db
    .prepare(
      `SELECT payload_json FROM learning_events
       WHERE plan_id = ? AND topic_id = ? AND kind = 'answer_given'
         AND json_extract(payload_json, '$.evidenceKind') IS NOT 'check'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(planId, topicId) as { payload_json: string } | undefined;
  try {
    return row ? (JSON.parse(row.payload_json) as { score?: number }).score : undefined;
  } catch {
    return undefined;
  }
}

/**
 * LES-13. Due cards (at most `count`), up to five questions from open gaps, and three unseen
 * items from the frontier topic. A gap with no questions asks for the durable gap drill.
 * Starting again while a review is unfinished returns that review instead of a new one.
 */
export function startReview(
  db: Database.Database,
  planId: string,
  options: { count?: number; runner?: Runner } = {},
  now = Date.now(),
): ReviewSession {
  const active = readReview(db, planId, now);
  if (active) return active;
  const count = Math.max(1, Math.min(MAX_CARDS, Math.floor(options.count ?? MAX_CARDS)));
  const cardIds = dueCards(db, planId, now).slice(0, count).map((card) => card.id);
  const used = usedSources(db, planId);
  const buckets = gapBuckets(db, planId, now, used);
  const gapRows = acrossTopics(
    buckets.map((bucket) => bucket.rows),
    GAP_QUESTIONS,
  );
  const wanted = options.runner
    ? buckets.filter((bucket) => bucket.available === 0).slice(0, MAX_DRILLS)
    : [];
  // Each drill owes a share of the five gap questions the open gaps could not supply, at least one.
  const missing = Math.max(GAP_QUESTIONS - gapRows.length, wanted.length);
  const drills: Drill[] = wanted.flatMap((bucket, index) => {
    try {
      const { jobId } = enqueueGapDrill(db, options.runner!, { planId, topicId: bucket.topicId, gapId: bucket.gapId });
      const want = Math.floor(missing / wanted.length) + (index < missing % wanted.length ? 1 : 0);
      return [{ topicId: bucket.topicId, gapId: bucket.gapId, jobId, want }];
    } catch {
      // The gap closed in between; its drill is simply not needed.
      return [];
    }
  });
  const frontier = frontierTopic(db, planId);
  const blocked = flaggedIds(db, "exercise");
  const unseen =
    frontier && latestScore(db, planId, frontier) !== 1
      ? topicExercises(db, frontier)
          .filter((item) => item.answer?.trim() && !blocked.has(item.id) && !used.has(item.id))
          .filter((item) => !gapRows.some((row) => row.id === item.id))
          .slice(0, NEW_QUESTIONS)
          .map((item) => ({ ...item, topicId: frontier }))
      : [];
  const topicOf = new Map([...gapRows, ...unseen].map((row) => [row.id, row.topicId]));
  const questions: QuizQuestion[] = mixQuestions(
    [...gapRows, ...unseen].map((row) => ({ id: row.id, prompt: row.prompt, answer: row.answer ?? "" })),
    8,
  ).map((question) => {
    // A matching question can mix exercises of two topics; it then counts toward neither.
    const topics = new Set((question.sourceIds ?? [question.sourceId]).map((id) => topicOf.get(id)));
    const topicId = topics.size === 1 ? [...topics][0] : undefined;
    // Free text is model-graded when the review is submitted; exact text must not decide credit.
    const grade =
      question.grade.kind === "completion"
        ? { kind: "open" as const, answer: "", reference: question.grade.accepted[0]?.[0] ?? "" }
        : question.grade;
    return { ...question, topicId, grade };
  });
  if (cardIds.length === 0 && questions.length === 0 && drills.length === 0)
    return emptyReview;
  const id = db.transaction(() => {
    let attemptId = "";
    // Drill questions join this attempt later, so it exists even while it is empty.
    if (questions.length > 0 || drills.length > 0) {
      const itemId = saveQuiz(db, planId, questions, now);
      db.prepare(`UPDATE items SET kind = 'review' WHERE id = ?`).run(itemId);
      attemptId = startAttempt(db, planId, itemId, now + 1).attemptId;
    }
    const sessionId = uuidv7(now + 2);
    db.prepare(
      `INSERT INTO items (id, plan_id, kind, body_json, grounding, created_at)
       VALUES (?, ?, 'review_session', ?, 'sources', ?)`,
    ).run(sessionId, planId, JSON.stringify({ cardIds, attemptId, drills } satisfies Session), now);
    return sessionId;
  })();
  return view(db, planId, latestSession(db, planId)!);
}

/**
 * True while the review's submit must wait: a drill is still building or needs recovery, or it
 * has just delivered questions the student has not seen. Cancelling a drill ends the wait.
 */
export function reviewWaiting(db: Database.Database, attemptId: string): boolean {
  const row = db
    .prepare(
      `SELECT id, plan_id, created_at, body_json FROM items
       WHERE kind = 'review_session' AND json_extract(body_json, '$.attemptId') = ?`,
    )
    .get(attemptId) as (Row & { plan_id: string }) | undefined;
  if (!row) return false;
  if (adopt(db, row.plan_id, row.id)) return true;
  const body = parse(db.prepare("SELECT id, created_at, body_json FROM items WHERE id = ?").get(row.id) as Row);
  return body.drills.some((drill) => pendingDrill(db, drill) && WAITING.has(jobOf(db, drill.jobId)?.state ?? ""));
}

/**
 * The student goes on without a drill (LES-13). The choice lives in the review session, so it holds however the job ends:
 * a failed job cannot be cancelled and dismissing it leaves it failed. Returns whether the job is an unadopted drill of this
 * plan's current review; only then may the caller stop the job. A running job is left to the runner.
 */
export function skipDrill(db: Database.Database, planId: string, jobId: string): boolean {
  const row = latestSession(db, planId);
  if (!row) return false;
  const body = parse(row);
  const drill = body.drills.find((item) => item.jobId === jobId && !item.adopted);
  if (!drill) return false;
  if (!drill.skipped) {
    drill.skipped = true;
    db.prepare("UPDATE items SET body_json = ? WHERE id = ?").run(JSON.stringify(body), row.id);
  }
  return true;
}

/** Drops the plan's unfinished review so a new one can start now. Cards, answers and learning events are kept. */
export function discardReview(db: Database.Database, planId: string, now = Date.now()) {
  const row = latestSession(db, planId);
  if (row)
    db.prepare("UPDATE items SET body_json = json_set(body_json, '$.discardedAt', ?) WHERE id = ?").run(
      now,
      row.id,
    );
  return { ok: true as const };
}
