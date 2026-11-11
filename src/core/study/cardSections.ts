import type Database from "better-sqlite3";
import { countDeckDue, countDueCards, NO_TOPIC } from "./cards";

export type CardSectionTopic = { topicId: string; title: string; total: number; due: number };
export type CardSectionExam = {
  planId: string;
  title: string;
  total: number;
  due: number;
  topics: CardSectionTopic[];
  /** The exam's cards with no topic (never given one, or their topic was deleted), as one row after its topics. */
  noTopic: { total: number; due: number } | null;
};
export type CardSectionSubject = {
  /** Null for the cards that have no subject: their exam has none, or their subject was removed. */
  subjectId: string | null;
  name: string | null;
  total: number;
  due: number;
  exams: CardSectionExam[];
  /** The subject's cards with no exam, as one deck. */
  examless: { total: number; due: number } | null;
};

type Row = {
  subject_id: string | null;
  subject_name: string | null;
  plan_id: string | null;
  plan_title: string | null;
  topic_id: string | null;
  topic_title: string | null;
  n: number;
};

/**
 * The Flashcard section in one read: every card by subject, then by exam and topic, with the cards with no exam last
 * in each subject, and how many of them are due today.
 *
 * Cards are counted as the card browser counts them under "all": every card not removed, suspended ones included, and
 * none from an archived exam or topic. An exam still being built is left out too, because the daily review leaves it out.
 * Due counts come from the review queues themselves, so they match what each review shows: an exam's from
 * `countDueCards`, a topic's from the same with its topic, and a subject's cards with no exam from `countDeckDue`. A
 * subject's due cards are its exams' plus its own; the total is every subject's, which is what the daily review
 * (`dueEverywhere`) goes through. A topic counts its own new cards within the exam's daily limit, so the topics of an
 * exam can add up to more than the exam's due count, the same as when each topic is opened from the exam's page.
 *
 * An exam's cards with no topic, such as a card whose topic was deleted, are the exam's `noTopic` row, so an exam's rows
 * always add up to its count.
 */
export function cardSections(
  db: Database.Database,
  now: number,
): { due: number; total: number; subjects: CardSectionSubject[] } {
  const rows = db
    .prepare(
      `SELECT c.subject_id, s.name AS subject_name, c.plan_id, p.title AS plan_title,
         c.topic_id, t.title AS topic_title, COUNT(*) AS n
       FROM cards c
       LEFT JOIN plans p ON p.id = c.plan_id
       LEFT JOIN topics t ON t.id = c.topic_id
       LEFT JOIN subjects s ON s.id = c.subject_id
       WHERE c.removed = 0
         AND p.archived_at IS NULL
         AND t.archived_at IS NULL
         AND (c.plan_id IS NULL OR p.status <> 'building')
       GROUP BY c.subject_id, c.plan_id, c.topic_id
       ORDER BY s.id IS NULL, s.position, s.name COLLATE NOCASE, s.id,
         p.id IS NULL, p.title COLLATE NOCASE, p.id,
         t.id IS NULL, t.position, t.id`,
    )
    .all() as Row[];

  const subjects: CardSectionSubject[] = [];
  for (const row of rows) {
    let subject = subjects.at(-1);
    if (!subject || subject.subjectId !== row.subject_id) {
      subject = { subjectId: row.subject_id, name: row.subject_name, total: 0, due: 0, exams: [], examless: null };
      subjects.push(subject);
    }
    subject.total += row.n;
    if (row.plan_id == null) {
      subject.examless = { total: row.n, due: countDeckDue(db, { subjectId: row.subject_id }, now) };
      subject.due += subject.examless.due;
      continue;
    }
    let exam = subject.exams.at(-1);
    if (!exam || exam.planId !== row.plan_id) {
      const due = countDueCards(db, row.plan_id, now);
      exam = { planId: row.plan_id, title: row.plan_title ?? "", total: 0, due, topics: [], noTopic: null };
      subject.exams.push(exam);
      subject.due += due;
    }
    exam.total += row.n;
    if (row.topic_id == null)
      exam.noTopic = { total: row.n, due: countDueCards(db, row.plan_id, now, NO_TOPIC) };
    else
      exam.topics.push({
        topicId: row.topic_id,
        title: row.topic_title ?? "",
        total: row.n,
        due: countDueCards(db, row.plan_id, now, row.topic_id),
      });
  }
  return {
    due: subjects.reduce((sum, subject) => sum + subject.due, 0),
    total: subjects.reduce((sum, subject) => sum + subject.total, 0),
    subjects,
  };
}
