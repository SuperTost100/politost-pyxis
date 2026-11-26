import type Database from "better-sqlite3";
import { z } from "zod";
import { foldText } from "../../shared/fold-text";
import { uuidv7 } from "../../shared/ids";
import type { QuizResultView } from "../../shared/ipc";
import { QUIZ_MAX_QUESTIONS, quizMinutes } from "../../shared/quiz";
import { SCHEMA_VERSION } from "../db/migrate";
import { activityOf } from "../jobs/activity";
import { enqueueQuiz } from "../study/quizJobs";
import { goOnWithJob, insertRows, jobRow, jobState, readRows, showJob, stopJob, toolRunner } from "./jobs";
import type { Tool, ToolTurn } from "./server";

/** Characters of the topic the model names. */
export const QUIZ_TOPIC_MAX = 120;

/** The question counts the quiz setup allows: core writes at most `QUIZ_MAX_QUESTIONS` in a quiz. */
export const quizInput = z
  .object({
    topic: z
      .string()
      .max(QUIZ_TOPIC_MAX * 2)
      .transform((text) => text.replace(/\s+/g, " ").trim().slice(0, QUIZ_TOPIC_MAX))
      .pipe(z.string().min(2))
      .describe('What the quiz asks about, in a few words in the student\'s language, such as "Dinamica" or "L\'attrito".'),
    questions: z
      .number()
      .int()
      .min(1)
      .max(QUIZ_MAX_QUESTIONS)
      .optional()
      .describe(`How many questions, only when the student asked for a number. Without it the quiz has ${QUIZ_MAX_QUESTIONS}.`),
  })
  .strict();

export const QUIZ_DESCRIPTION = [
  "Creates a quiz in Pyxis, in the exam of this chat, that the student takes on Pyxis's quiz page and hands in for a grade.",
  "Call it when the student asks for a quiz or a test on a topic (\"fammi un quiz su…\", \"interrogami con un quiz\"), or accepts your offer to make one. Never call it on your own initiative. To ask the student one or two questions in the conversation, just ask them in your answer.",
  "Give `topic` as a few words naming what the quiz covers, in the student's language, and `questions` only when the student asked for a number.",
  `A quiz has at most ${QUIZ_MAX_QUESTIONS} questions of every kind (multiple choice, true or false, fill in, matching and open), written from the exam's material.`,
  "Pyxis writes the quiz in the background: the call returns once the writing has started, and the student sees a card under your answer that shows the quiz at work and then opens it.",
  "At most one quiz per answer. After the call, write one short sentence that is true both while it is written and once it is ready, such as that they find it below: never that you are preparing it, and never how long it takes. Do not write the questions in your answer.",
].join(" ");

/** What a quiz result stores: where the quiz is, what it is about, and the attempt the student takes it in. */
export type QuizData = {
  planId: string;
  exam: string;
  topic: string;
  /** The exam's topic the quiz is on, or null for a quiz across the exam on the words of `topic`. */
  topicId: string | null;
  attemptId: string;
  itemId: string;
  count: number;
};

/** The quiz's rows as they were when «Annulla» took them away, and what it did to its jobs, so «Ripristina» undoes it. */
export type QuizUndone = {
  rows: Record<(typeof QUIZ_TABLES)[number], Array<Record<string, unknown>>>;
  /** Events that named the quiz, which lost the link when it went (`learning_events.item_id` is set to null). */
  events: string[];
  /** The quiz's jobs and the Attività mark each had; the build that was still writing it is `stopped`. */
  jobs: Array<{ id: string; dismissed: number }>;
  stopped: string | null;
  /** The schema version the rows were read at (`SCHEMA_VERSION`); absent in records written before it was kept. */
  schema?: number;
};

/** The tables an unfinished quiz lives in, in the order they are put back. */
const QUIZ_TABLES = ["items", "item_passages", "attempts", "attempt_answers", "gap_answers", "tool_sessions"] as const;

/** The jobs that work for one attempt: writing its questions, checking or grading its answers. */
const ATTEMPT_JOBS = `kind IN ('quiz-build', 'quiz-check', 'quiz-grade') AND json_extract(params_json, '$.attemptId') = ?`;

const TOOL_NAME = "create_quiz";

type Exam = { planId: string; title: string };

/**
 * The exam a quiz from this chat goes in. Pyxis has no quiz outside an exam (a quiz is an exam's item, and its grade
 * counts on the exam's path), so a chat on a subject uses the subject's exam when it has exactly one.
 */
function quizExam(db: Database.Database, place: ReturnType<ToolTurn["place"]>): Exam | { refused: string } {
  const live = `archived_at IS NULL AND status != 'building' AND EXISTS (SELECT 1 FROM topics t WHERE t.plan_id = plans.id AND t.archived_at IS NULL)`;
  // A chat of an exam makes its quiz there or nowhere: never in another exam of its subject.
  if (place.planId) {
    const plan = db.prepare(`SELECT id AS planId, title, ${live} AS live FROM plans WHERE id = ?`).get(place.planId) as
      | (Exam & { live: number })
      | undefined;
    if (plan?.live) return { planId: plan.planId, title: plan.title };
    if (plan)
      return {
        refused: `This chat's exam, ${plan.title}, is archived, still being built or has no topics, so no quiz was created. Tell the student in one sentence, and offer to ask them a few questions here instead.`,
      };
  }
  const exams = place.subject
    ? (db
        .prepare(
          `SELECT id AS planId, title FROM plans WHERE ${live}
             AND subject_id = (SELECT id FROM subjects WHERE name = ? COLLATE NOCASE)`,
        )
        .all(place.subject.trim()) as Exam[])
    : [];
  if (exams.length === 1) return exams[0]!;
  return {
    refused:
      exams.length > 1
        ? `In Pyxis a quiz belongs to an exam, and this chat's subject has ${exams.length} exams (${exams.map((exam) => exam.title).join(", ")}), so no quiz was created. Tell the student to open a chat from the exam they want the quiz in, and offer to ask them a few questions here meanwhile.`
        : "In Pyxis a quiz belongs to an exam, and this chat has none, so no quiz was created. Tell the student that a quiz needs an exam (they can create one in Esami) and offer to ask them a few questions here instead.",
  };
}

/**
 * The exam's topic the words name: the one whose title is those words, else the only one whose title holds them or is
 * held in them. Null when none does, or when several do: the quiz then spans the exam and asks about the words.
 */
export function quizTopic(db: Database.Database, planId: string, asked: string): { id: string; title: string; exact: boolean } | null {
  const topics = db
    .prepare(`SELECT id, title FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position, id`)
    .all(planId) as Array<{ id: string; title: string }>;
  return matchTitle(topics, asked);
}

/**
 * The item whose title is the words, else the only one whose title holds them or is held in them, as whole words. Null
 * when none does, or when several do.
 */
export function matchTitle<T extends { title: string }>(items: readonly T[], asked: string): (T & { exact: boolean }) | null {
  const want = foldText(asked).replace(/\s+/g, " ").trim();
  const exact = items.find((item) => foldText(item.title).replace(/\s+/g, " ").trim() === want);
  if (exact) return { ...exact, exact: true };
  // Whole words only: "Attrito statico" holds the topic Attrito, but "Termodinamica" does not hold Dinamica.
  const askedWords = wordsOf(asked);
  const near = items.filter((item) => {
    const title = wordsOf(item.title);
    return title.join(" ").length >= 4 && askedWords.join(" ").length >= 4 && (holds(askedWords, title) || holds(title, askedWords));
  });
  // Words that name two topics ("Cinematica e dinamica") are no one topic: the quiz spans the exam on them.
  return near.length === 1 ? { ...near[0]!, exact: false } : null;
}

/** The words of a text, folded: "L’attrito statico" is ["l", "attrito", "statico"]. */
const wordsOf = (text: string) => foldText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Whether `outer` holds the words of `inner` one after another. */
function holds(outer: string[], inner: string[]): boolean {
  if (!inner.length || inner.length > outer.length) return false;
  return outer.some((_, start) => inner.every((word, index) => outer[start + index] === word));
}

const asTitle = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

export function quizTool(db: Database.Database): Tool {
  return {
    name: TOOL_NAME,
    description: QUIZ_DESCRIPTION,
    input: quizInput,
    run(turn, raw) {
      const args = raw as z.infer<typeof quizInput>;
      if ((turn.tally.quizzes ?? 0) >= 1)
        return {
          declined: true,
          text: "This answer already created a quiz, and one answer may create one. Nothing more was created: tell the student they can ask for another quiz in their next message.",
        };
      const exam = quizExam(db, turn.place());
      if ("refused" in exam) return { declined: true, text: exam.refused };
      turn.tally.quizzes = 1;
      const topic = quizTopic(db, exam.planId, args.topic);
      const count = args.questions ?? QUIZ_MAX_QUESTIONS;
      const title = topic?.exact ? topic.title : asTitle(args.topic);
      const resultId = db.transaction(() => {
        const started = enqueueQuiz(db, toolRunner(), {
          planId: exam.planId,
          scope: topic ? "topic" : "plan",
          ...(topic ? { topicId: topic.id } : {}),
          count,
          // An exam topic named exactly needs no words beside it; anything else tells the questions what to be about.
          ...(topic?.exact ? {} : { focus: args.topic }),
        });
        const itemId = db.prepare("SELECT item_id FROM attempts WHERE id = ?").pluck().get(started.attemptId) as string;
        const data: QuizData = {
          planId: exam.planId,
          exam: exam.title,
          topic: title,
          topicId: topic?.id ?? null,
          attemptId: started.attemptId,
          itemId,
          count,
        };
        const id = uuidv7();
        db.prepare(
          `INSERT INTO chat_tool_results (id, chat_id, message_id, tool, data_json, created_at)
           VALUES (?, ?, NULL, 'create_quiz', ?, ?)`,
        ).run(id, turn.chatId, JSON.stringify(data), Date.now());
        return id;
      })();
      return {
        text: `Pyxis started writing a quiz of ${count} question${count === 1 ? "" : "s"} on "${title}" in the exam ${exam.title}. The student sees it as a card under your answer, at work and then ready to open. Write one short sentence that is true both while it is written and once it is ready, such as that they find it below: never that you are preparing it, and never how long it takes. Do not write the questions.`,
        shown: { resultId },
      };
    },
  };
}

type QuizBody = {
  complete?: boolean;
  config?: { count?: number; types?: string[] };
  questions: Array<{ topicId?: string; answer?: { kind?: string } }>;
};

/** The newest job writing the attempt's questions, as `readQuiz` reads it. */
function buildJob(db: Database.Database, attemptId: string): string | undefined {
  return db
    .prepare(
      "SELECT id FROM jobs WHERE kind = 'quiz-build' AND json_extract(params_json, '$.attemptId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .pluck()
    .get(attemptId) as string | undefined;
}

/** Handing in starts a grading job before the attempt is closed: from then on the quiz is handed in and has a grade. */
export function handedIn(db: Database.Database, itemId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM attempts a WHERE a.item_id = ? AND (a.submitted_at IS NOT NULL OR EXISTS (
         SELECT 1 FROM jobs j WHERE j.kind = 'quiz-grade' AND json_extract(j.params_json, '$.attemptId') = a.id))`,
    )
    .get(itemId);
}

export function quizView(db: Database.Database, id: string, stored: QuizData, undone: QuizUndone | null): QuizResultView {
  const item = undone
    ? (undone.rows.items[0] as { body_json: string; topic_id: string | null } | undefined)
    : (db.prepare("SELECT body_json, topic_id FROM items WHERE id = ? AND plan_id = ?").get(stored.itemId, stored.planId) as
        | { body_json: string; topic_id: string | null }
        | undefined);
  const attempt = undone
    ? undone.rows.attempts.some((row) => row.id === stored.attemptId)
    : !!db.prepare("SELECT 1 FROM attempts WHERE id = ?").get(stored.attemptId);
  const body = item ? (JSON.parse(item.body_json) as QuizBody) : null;
  const build = buildJob(db, stored.attemptId);
  const job = jobRow(db, build);
  const state = jobState(job);
  const kinds: QuizResultView["kinds"] = {};
  for (const question of body?.questions ?? []) {
    const kind = question.answer?.kind as keyof QuizResultView["kinds"] | undefined;
    if (kind) kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  const written = body?.questions.length ?? 0;
  const firstTopic = db
    .prepare("SELECT id FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position LIMIT 1")
    .pluck()
    .get(stored.planId) as string | undefined;
  return {
    id,
    tool: "create_quiz",
    // A quiz whose questions are all written is done whatever its job's row says.
    job: body?.complete ? "done" : state === "done" && !body ? "done" : state,
    error: state === "failed" ? (job?.error ?? null) : null,
    activity: state === "working" && !undone ? activityOf(build) : null,
    undone: undone !== null,
    stopped: !!undone && undone.stopped !== null && !body?.complete,
    restorable: !undone || restorableQuiz(db, stored, undone),
    gone: !undone && (!item || !attempt),
    topic: stored.topic,
    exam: stored.exam,
    planId: stored.planId,
    attemptId: stored.attemptId,
    routeTopicId: item?.topic_id ?? body?.questions.find((question) => question.topicId)?.topicId ?? firstTopic ?? null,
    count: body?.complete ? written : Math.max(stored.count, written),
    kinds,
    minutes: quizMinutes((body?.questions ?? []).map((question) => question.answer?.kind ?? "mcq")),
    handedIn: !undone && handedIn(db, stored.itemId),
  };
}

/**
 * «Annulla», and «Ferma» while the quiz is written. A quiz handed in has a grade, which only the student's own answers
 * make or change, so it cannot be undone (`tool-handed-in`). Otherwise the jobs still working for it stop and leave
 * Attività, and the quiz's rows (its questions, the attempt with the answers given so far, the passages it cites) move
 * into the result's own record. Nothing else in the app reads that record, so every list, count and job of quizzes
 * leaves the quiz out without knowing about it.
 */
export function undoQuiz(db: Database.Database, stored: QuizData): QuizUndone {
  if (handedIn(db, stored.itemId)) throw new Error("tool-handed-in");
  const attempts = (readRows(db, "attempts", "item_id = ?", stored.itemId) as Array<{ id: string }>).map((row) => row.id);
  const ids = JSON.stringify(attempts);
  const build = buildJob(db, stored.attemptId);
  const stopped = build && stopJob(db, build) ? build : null;
  const jobs = attempts.flatMap((attempt) =>
    readRows(db, "jobs", ATTEMPT_JOBS, attempt).map((row) => ({ id: row.id as string, dismissed: row.dismissed as number })),
  );
  for (const job of jobs) {
    if (job.id === stopped) continue;
    stopJob(db, job.id);
    db.prepare("UPDATE jobs SET dismissed = MAX(dismissed, 1) WHERE id = ?").run(job.id);
  }
  const inAttempts = "attempt_id IN (SELECT value FROM json_each(?))";
  const undone: QuizUndone = {
    rows: {
      items: readRows(db, "items", "id = ?", stored.itemId),
      item_passages: readRows(db, "item_passages", "item_id = ?", stored.itemId),
      attempts: readRows(db, "attempts", "item_id = ?", stored.itemId),
      attempt_answers: readRows(db, "attempt_answers", inAttempts, ids),
      gap_answers: readRows(db, "gap_answers", inAttempts, ids),
      tool_sessions: readRows(db, "tool_sessions", "owner IN (SELECT 'quiz:' || value FROM json_each(?))", ids),
    },
    events: db.prepare("SELECT id FROM learning_events WHERE item_id = ?").pluck().all(stored.itemId) as string[],
    jobs: jobs.filter((job) => job.id !== stopped),
    stopped,
    schema: SCHEMA_VERSION,
  };
  // Answers, checks and the attempt's helper chat go with the attempt; the passages it cites go with the item.
  db.prepare("DELETE FROM attempts WHERE item_id = ?").run(stored.itemId);
  db.prepare("DELETE FROM items WHERE id = ?").run(stored.itemId);
  return undone;
}

/**
 * Whether «Ripristina» can bring the quiz back: its exam is still there, and the rows are not from a newer Pyxis than
 * this one (after a downgrade). The card says so plainly otherwise, with no button.
 */
export function restorableQuiz(db: Database.Database, stored: QuizData, undone: QuizUndone): boolean {
  if (!db.prepare("SELECT 1 FROM plans WHERE id = ?").get(stored.planId) || (undone.schema ?? 0) > SCHEMA_VERSION) return false;
  // A quiz written from the student's material whose every passage was deleted since has nothing left to stand on.
  const cited = quizPassages(db, stored, undone);
  return cited.length === 0 || cited.some((id) => passageExists(db, id));
}

const passageExists = (db: Database.Database, id: string) => !!db.prepare("SELECT 1 FROM passages WHERE id = ?").get(id);

/** The passages the undone quiz stands on: the ones it cites and the ones its builds read. */
function quizPassages(db: Database.Database, stored: QuizData, undone: QuizUndone): string[] {
  const ids = new Set(undone.rows.item_passages.map((row) => row.passage_id as string));
  for (const params of buildParams(db, stored)) for (const passage of params.snapshot?.passages ?? []) ids.add(passage.id);
  return [...ids];
}

type BuildParams = {
  snapshot?: {
    passages?: Array<{ id: string }>;
    passageTopics?: Record<string, string>;
    questions?: Array<{ sourceIds?: string[] }>;
  };
};

/** The quiz's build jobs with their stored params. */
function buildParams(db: Database.Database, stored: QuizData): Array<BuildParams & { jobId: string }> {
  return (
    db
      .prepare("SELECT id, params_json FROM jobs WHERE kind = 'quiz-build' AND json_extract(params_json, '$.attemptId') = ?")
      .all(stored.attemptId) as Array<{ id: string; params_json: string }>
  ).map((row) => ({ ...(JSON.parse(row.params_json) as BuildParams), jobId: row.id }));
}

/**
 * Takes the passages deleted while the quiz was undone out of its questions and out of its builds' snapshots, so a
 * resumed build never saves a link to a passage that is gone. A question already written from one stays as it is,
 * without that link.
 */
function dropGonePassages(db: Database.Database, stored: QuizData, undone: QuizUndone): QuizUndone["rows"]["items"] {
  const alive = (ids: string[] | undefined) => ids?.filter((id) => passageExists(db, id));
  for (const { jobId, ...params } of buildParams(db, stored)) {
    const snapshot = params.snapshot;
    if (!snapshot) continue;
    snapshot.passages = snapshot.passages?.filter((passage) => passageExists(db, passage.id));
    if (snapshot.passageTopics)
      snapshot.passageTopics = Object.fromEntries(Object.entries(snapshot.passageTopics).filter(([id]) => passageExists(db, id)));
    for (const question of snapshot.questions ?? []) if (question.sourceIds) question.sourceIds = alive(question.sourceIds);
    db.prepare("UPDATE jobs SET params_json = ? WHERE id = ?").run(JSON.stringify(params), jobId);
  }
  return undone.rows.items.map((row) => {
    const body = JSON.parse(row.body_json as string) as { questions?: Array<{ sourceIds?: string[] }> };
    for (const question of body.questions ?? []) if (question.sourceIds) question.sourceIds = alive(question.sourceIds);
    return { ...row, body_json: JSON.stringify(body) };
  });
}

/**
 * «Ripristina»: the quiz's rows go back as they were, with the answers given so far, and the build that «Ferma» stopped
 * goes on writing. A passage deleted since is left out of the quiz's sources, its questions and its builds
 * (`dropGonePassages`), and a topic deleted since leaves the quiz on the whole exam. An exam deleted since, or every
 * passage the quiz stood on, leaves nothing to take it back to (`tool-restore-gone`). It runs in the caller's
 * transaction: a row that cannot go back takes the others with it, so a restore is whole or does nothing.
 */
export function restoreQuiz(db: Database.Database, stored: QuizData, undone: QuizUndone): void {
  if (!restorableQuiz(db, stored, undone)) throw new Error("tool-restore-gone");
  const exists = (table: string, id: unknown) => !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
  const items = dropGonePassages(db, stored, undone);
  insertRows(
    db,
    "items",
    items.map((row) => (row.topic_id && !exists("topics", row.topic_id) ? { ...row, topic_id: null } : row)),
  );
  insertRows(db, "item_passages", undone.rows.item_passages.filter((row) => exists("passages", row.passage_id)));
  insertRows(db, "attempts", undone.rows.attempts);
  insertRows(db, "attempt_answers", undone.rows.attempt_answers);
  insertRows(db, "gap_answers", undone.rows.gap_answers.filter((row) => exists("gaps", row.gap_id)));
  insertRows(db, "tool_sessions", undone.rows.tool_sessions);
  const relink = db.prepare("UPDATE learning_events SET item_id = ? WHERE id = ? AND item_id IS NULL");
  for (const event of undone.events) relink.run(stored.itemId, event);
  for (const job of undone.jobs) showJob(db, job.id, job.dismissed);
  if (undone.stopped) goOnWithJob(db, undone.stopped);
}

/** «Riprova» or «Riprendi» on a quiz whose writing failed or stopped. */
export function retryQuiz(db: Database.Database, stored: QuizData): void {
  const build = buildJob(db, stored.attemptId);
  if (!build) throw new Error("tool-result-missing");
  goOnWithJob(db, build);
}

/**
 * A result no reply shows any more takes its quiz with it, unless the student handed it in: its jobs stop for good and
 * the quiz leaves the exam. A quiz already undone is only in the result's record, which goes with the result.
 */
export function dropQuiz(db: Database.Database, stored: QuizData, undone: boolean): void {
  if (!undone && handedIn(db, stored.itemId)) return;
  for (const job of readRows(db, "jobs", ATTEMPT_JOBS, stored.attemptId)) toolRunner().discard(job.id as string);
  if (undone) return;
  db.prepare("DELETE FROM attempts WHERE item_id = ?").run(stored.itemId);
  db.prepare("DELETE FROM items WHERE id = ?").run(stored.itemId);
}
