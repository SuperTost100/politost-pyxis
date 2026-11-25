import type Database from "better-sqlite3";
import { z } from "zod";
import { gradeScaleOf, gradeValue, gradeWhole, type GradeScale } from "../../shared/grade";
import { dayKey } from "../../shared/local-day";
import { reachableTarget } from "../../shared/plan-file";
import { OPEN_GAPS_WHERE, planMastery, planTarget } from "../plans/progress";
import { readSteps } from "../plans/steps";
import { readProfile } from "../profile/profile";
import type { Tool, ToolTurn } from "./server";

/**
 * `read_progress`: what Pyxis shows the student about their own results, for the exam or the subject of the chat, so a
 * model that talks about the student's grades or draws them has the real numbers. It only reads. Where it looks comes
 * from the chat (`ToolTurn.place`), never from the arguments, so it never returns another subject's results.
 */

/** Handed-in attempts listed per exam, newest first. Older ones are counted but not listed. */
const QUIZZES_LISTED = 60;
/** Exams of one subject read in one call. */
const EXAMS_LISTED = 6;

export const progressInput = z.object({}).strict();

export const PROGRESS_DESCRIPTION = [
  "Reads the student's own results in Pyxis for the exam or subject of this chat: the quizzes they handed in, each with its date, topic and grade, and every topic's state (lesson read, mastery, goal reached, open mistakes). It only reads.",
  "This tool is the only source of the student's grades, quiz results and progress: you cannot know them otherwise. Call it whenever the student asks how they are doing, about their grades, quizzes, weak or strong topics or progress, or asks for a chart of them, and use only the numbers it returns. Never estimate, complete or invent a number about the student.",
  "Every grade, the goal and the pass mark are already on the student's scale (`scale`: out of 30 or out of 100). Write them as they come.",
  "To chart grades, write a pyxis-chart block from these numbers only: for the latest grade of each topic, one bar per topic in the exam's order, `max` equal to `scale`, `unit` \"/30\" or \"/100\", the pass mark as `reference`, and every topic without a quiz as a point with value null and the note \"not done yet\" in the student's language. To chart change over time, a line with one point per quiz in date order, labelled by its short date, with the topic as its note.",
  "It sees only this chat's exam or subject. When it lists no quizzes, say so in one sentence and do not draw a chart.",
].join(" ");

type Attempt = {
  submitted_at: number;
  kind: string;
  topic_id: string | null;
  topic: string | null;
  payload: string | null;
};

/** The pass mark on each scale: 18 out of 30, as Italian universities mark exams, and 60 out of 100. */
const passMark = (scale: GradeScale) => (scale === 30 ? 18 : 60);

function score(payload: string | null): number | null {
  if (!payload) return null;
  try {
    const value = (JSON.parse(payload) as { score?: unknown }).score;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** One exam as the student sees it in Pyxis: its handed-in quizzes and each topic's state, on the student's scale. */
export function examProgress(db: Database.Database, planId: string, scale: GradeScale) {
  const plan = db.prepare(`SELECT title FROM plans WHERE id = ?`).get(planId) as { title: string };
  const goal = reachableTarget(planTarget(db, planId));
  const attempts = db
    .prepare(
      `SELECT a.submitted_at, i.kind, i.topic_id, t.title AS topic,
              (SELECT aa.payload_json FROM attempt_answers aa WHERE aa.attempt_id = a.id
               ORDER BY aa.created_at DESC, aa.rowid DESC LIMIT 1) AS payload
       FROM attempts a JOIN items i ON i.id = a.item_id LEFT JOIN topics t ON t.id = i.topic_id
       WHERE a.plan_id = ? AND a.submitted_at IS NOT NULL AND i.kind IN ('quiz', 'diagnostic', 'review', 'simulation')
       ORDER BY a.submitted_at DESC, a.rowid DESC`,
    )
    .all(planId) as Attempt[];
  const steps = readSteps(db, planId);
  const gaps = new Map(
    (
      db
        .prepare(`SELECT g.topic_id AS topicId, count(*) AS n FROM gaps g WHERE ${OPEN_GAPS_WHERE} GROUP BY g.topic_id`)
        .all({ plan: planId }) as Array<{ topicId: string; n: number }>
    ).map((row) => [row.topicId, row.n]),
  );
  const graded = attempts.map((attempt) => ({ ...attempt, score: score(attempt.payload) }));
  return {
    exam: plan.title,
    goal: gradeWhole(goal, scale),
    quizzesDone: attempts.length,
    quizzes: graded.slice(0, QUIZZES_LISTED).map((attempt) => ({
      date: dayKey(attempt.submitted_at),
      kind: attempt.kind === "review" ? "mistakes review" : attempt.kind === "simulation" ? "exam simulation" : attempt.kind,
      topic: attempt.topic,
      // Null while open answers are still being graded.
      grade: attempt.score === null ? null : gradeValue(attempt.score, scale),
    })),
    topics: planMastery(db, planId).map((topic) => {
      const own = steps.filter((step) => step.topicId === topic.id);
      const latest = graded.find((attempt) => attempt.topic_id === topic.id && attempt.kind === "quiz" && attempt.score !== null);
      const studied = own.length > 0 || topic.mastery > 0;
      return {
        topic: topic.title,
        lessonRead: own.some((step) => step.activity === "lesson"),
        latestQuizGrade: latest ? gradeValue(latest.score!, scale) : null,
        mastery: studied ? gradeWhole(topic.mastery, scale) : null,
        goalReached: studied && topic.mastery >= goal,
        openMistakes: gaps.get(topic.id) ?? 0,
      };
    }),
  };
}

/** The exams the chat's work belongs to: its exam, or else every exam of its subject that is not archived. */
function examsOf(db: Database.Database, place: ReturnType<ToolTurn["place"]>): { name: string; planIds: string[] } | null {
  if (place.planId) {
    const plan = db.prepare(`SELECT id, title FROM plans WHERE id = ? AND archived_at IS NULL`).get(place.planId) as
      | { id: string; title: string }
      | undefined;
    if (plan) return { name: plan.title, planIds: [plan.id] };
  }
  if (!place.subject) return null;
  const subject = db.prepare(`SELECT id, name FROM subjects WHERE name = ? COLLATE NOCASE`).get(place.subject.trim()) as
    | { id: string; name: string }
    | undefined;
  if (!subject) return null;
  const plans = db
    .prepare(`SELECT id FROM plans WHERE subject_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`)
    .all(subject.id, EXAMS_LISTED) as Array<{ id: string }>;
  return { name: subject.name, planIds: plans.map((plan) => plan.id) };
}

export function readProgress(db: Database.Database, place: ReturnType<ToolTurn["place"]>) {
  const where = examsOf(db, place);
  if (!where) return null;
  const scale = gradeScaleOf(readProfile(db));
  return {
    subject: where.name,
    scale,
    passMark: passMark(scale),
    exams: where.planIds.map((planId) => examProgress(db, planId, scale)),
  };
}

export function progressTool(db: Database.Database): Tool {
  return {
    name: "read_progress",
    description: PROGRESS_DESCRIPTION,
    input: progressInput,
    run(turn) {
      const progress = readProgress(db, turn.place());
      if (!progress)
        return {
          text: "This chat has no exam or subject, so there are no results to read. Tell the student to choose a subject for the chat (the subject button above the conversation) and ask again. Do not guess their results.",
        };
      if (progress.exams.length === 0)
        return {
          text: `The subject ${progress.subject} has no exam in Pyxis yet, so the student has no quizzes or topics there. Say so in one sentence and do not draw a chart.`,
        };
      return { text: JSON.stringify(progress) };
    },
  };
}
