import type Database from "better-sqlite3";
import { chatQuestions } from "../../shared/chat-blocks";

/**
 * The student's answers to the practice questions of chat replies (```pyxis-question blocks). An answer belongs to the
 * reply and is kept only so the reply shows it again; it is not an attempt, a mistake, a review or study time, and no
 * grade or mastery reads this table.
 */

/** Keeps the student's pick, given as the option's place in the block. The first answer stands; returns the kept one. */
export function answerQuestion(
  db: Database.Database,
  input: { chatId: string; messageId: string; questionId: string; pick: number },
  now = Date.now(),
): number {
  const message = db
    .prepare(`SELECT body FROM messages WHERE id = ? AND chat_id = ? AND role = 'assistant'`)
    .get(input.messageId, input.chatId) as { body: string } | undefined;
  if (!message) throw new Error("message-missing");
  const question = chatQuestions(message.body).get(input.questionId);
  if (!question) throw new Error("question-missing");
  if (!Number.isInteger(input.pick) || input.pick < 0 || input.pick >= question.options.length)
    throw new Error("pick-invalid");
  db.prepare(
    `INSERT INTO chat_question_answers (message_id, question_id, pick, answered_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (message_id, question_id) DO NOTHING`,
  ).run(input.messageId, input.questionId, input.pick, now);
  return (
    db
      .prepare(`SELECT pick FROM chat_question_answers WHERE message_id = ? AND question_id = ?`)
      .get(input.messageId, input.questionId) as { pick: number }
  ).pick;
}

/** The answers of a chat's replies: by message id, then by question id, the pick as the option's place in the block. */
export function chatAnswers(db: Database.Database, chatId: string): Map<string, Record<string, number>> {
  const rows = db
    .prepare(
      `SELECT a.message_id, a.question_id, a.pick FROM chat_question_answers a
       JOIN messages m ON m.id = a.message_id WHERE m.chat_id = ?`,
    )
    .all(chatId) as Array<{ message_id: string; question_id: string; pick: number }>;
  const answers = new Map<string, Record<string, number>>();
  for (const row of rows) answers.set(row.message_id, { ...answers.get(row.message_id), [row.question_id]: row.pick });
  return answers;
}

/**
 * A reply that takes another's place with the same questions, as a Continue does (it saves the longer reply as a new
 * message and deletes the cut one), takes the student's answers to those questions along. Call it before the old reply
 * is deleted, which would delete its answers with it.
 */
export function carryAnswers(db: Database.Database, from: string, to: string, body: string): void {
  const ids = [...chatQuestions(body).keys()];
  if (ids.length === 0) return;
  db.prepare(
    `UPDATE chat_question_answers SET message_id = ? WHERE message_id = ? AND question_id IN (SELECT value FROM json_each(?))`,
  ).run(to, from, JSON.stringify(ids));
}
