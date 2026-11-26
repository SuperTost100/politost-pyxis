import { describe, expect, it } from "vitest";
import { chatQuestion } from "../../shared/chat-blocks";
import { openDatabase } from "../db/connection";
import { planMastery, planSeries } from "../plans/progress";
import { readProgress } from "../tools/progress";
import { exportChat } from "./export";
import { answerQuestion, chatAnswers } from "./questions";
import { readChat } from "./turn";

const QUESTION = {
  question: "Un blocco è fermo su un piano inclinato con attrito. Quanto vale la forza di attrito statico?",
  options: ["$\\mu_s N$, sempre", "$mg \\sin\\theta$, quanto basta a tenerlo fermo", "$mg \\cos\\theta$, come la normale"],
  answer: 1,
  feedback: ["Solo un attimo prima che parta.", "Esatto: equilibra la componente del peso.", "Quella è la normale."],
};
const block = (question: object) => `\`\`\`pyxis-question\n${JSON.stringify(question)}\n\`\`\``;
const BODY = `Eccone una che trae in inganno spesso.\n\n${block(QUESTION)}\n\n<followups>\nUn'altra\n</followups>`;

/** A chat about an exam with handed-in work in every place that counts answers, and a reply that asks a question. */
function fixture() {
  const db = openDatabase(":memory:");
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  run("INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 1', 1)");
  run("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('mech', 'phys', 'Meccanica', 'ready', 1, 1)");
  run("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('dyn', 'mech', 'Dinamica', 0, 1)");
  run("INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES ('quiz', 'mech', 'dyn', 'quiz', '{}', 1)");
  run("INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES ('a', 'mech', 'quiz', 1, 2)");
  run(`INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES ('aa', 'a', '{"picks":{},"results":[],"score":0.6}', 2)`);
  run(
    `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES
     ('e1', 'answer_given', 'mech', 'dyn', '{"score":0.6,"attemptId":"a"}', 2),
     ('e2', 'active_time', 'mech', 'dyn', '{"seconds":600}', 3)`,
  );
  run("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('chat', 'Attrito', 1, 1), ('other', 'Altro', 1, 1)");
  run("INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('q', 'chat', 'user', 'Mi fai una domanda?', 1)");
  run("INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('r', 'chat', 'assistant', ?, 2)", BODY);
  return db;
}

/** The row count of every table but the answers' own, so a write anywhere else shows. */
function counts(db: ReturnType<typeof openDatabase>) {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .filter((name) => name !== "chat_question_answers" && !name.includes("fts"));
  return Object.fromEntries(
    tables.map((name) => [name, (db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n]),
  );
}

describe("practice questions in a chat reply", () => {
  const question = chatQuestion(JSON.stringify(QUESTION))!;
  const wrong = 0;

  it("keeps the student's pick with the reply, and the first answer stands", () => {
    const db = fixture();
    expect(answerQuestion(db, { chatId: "chat", messageId: "r", questionId: question.id, pick: wrong }, 10)).toBe(wrong);
    expect(answerQuestion(db, { chatId: "chat", messageId: "r", questionId: question.id, pick: 1 }, 11)).toBe(wrong);
    expect(chatAnswers(db, "chat").get("r")).toEqual({ [question.id]: wrong });
    // Reopening the chat, or opening the workspace again after a restart, reads it back with the reply.
    const reply = readChat(db, "chat").find((message) => message.id === "r")!;
    expect(reply.answers).toEqual({ [question.id]: wrong });
    expect(readChat(db, "chat").find((message) => message.id === "q")!.answers).toBeUndefined();
  });

  it("refuses an answer to a question the reply does not hold, from another chat or out of range", () => {
    const db = fixture();
    expect(() => answerQuestion(db, { chatId: "other", messageId: "r", questionId: question.id, pick: 0 })).toThrow("message-missing");
    expect(() => answerQuestion(db, { chatId: "chat", messageId: "q", questionId: question.id, pick: 0 })).toThrow("message-missing");
    expect(() => answerQuestion(db, { chatId: "chat", messageId: "r", questionId: "question-x", pick: 0 })).toThrow("question-missing");
    expect(() => answerQuestion(db, { chatId: "chat", messageId: "r", questionId: question.id, pick: 3 })).toThrow("pick-invalid");
    expect(chatAnswers(db, "chat").size).toBe(0);
  });

  it("counts nowhere: no grade, mistake, mastery, review history or study time changes", () => {
    const db = fixture();
    const before = {
      counts: counts(db),
      mastery: planMastery(db, "mech", 10_000),
      series: planSeries(db, "mech"),
      progress: readProgress(db, { planId: "mech", subject: "Fisica 1" }),
    };
    answerQuestion(db, { chatId: "chat", messageId: "r", questionId: question.id, pick: wrong }, 5);
    expect(counts(db)).toEqual(before.counts);
    expect(planMastery(db, "mech", 10_000)).toEqual(before.mastery);
    expect(planSeries(db, "mech")).toEqual(before.series);
    expect(readProgress(db, { planId: "mech", subject: "Fisica 1" })).toEqual(before.progress);
    expect(db.prepare("SELECT count(*) AS n FROM chat_question_answers").get()).toEqual({ n: 1 });
  });

  it("exports the question with its options, the right one and the student's answer, and goes with the reply", () => {
    const db = fixture();
    answerQuestion(db, { chatId: "chat", messageId: "r", questionId: question.id, pick: wrong });
    const { markdown } = exportChat(db, "chat", "it");
    const right = String.fromCharCode(65 + question.answer);
    const yours = String.fromCharCode(65 + question.order.indexOf(wrong));
    expect(markdown).toContain("**Domanda.** Un blocco è fermo su un piano inclinato con attrito.");
    expect(markdown).toContain(`${right}. $mg \\sin\\theta$, quanto basta a tenerlo fermo (quella giusta)`);
    expect(markdown).toContain(`${yours}. $\\mu_s N$, sempre (la tua risposta)`);
    expect(markdown).not.toContain("pyxis-question");
    expect(markdown).not.toContain('"options"');
    db.prepare("DELETE FROM messages WHERE id = 'r'").run();
    expect(db.prepare("SELECT count(*) AS n FROM chat_question_answers").get()).toEqual({ n: 0 });
  });

  it("exports a chart as its table, and keeps it as a block only for the printed chat", () => {
    const db = fixture();
    const chart = {
      title: "I tuoi voti nei quiz di Fisica 1",
      kind: "bar",
      x: "Argomento",
      unit: "/30",
      max: 30,
      series: [{ name: "Voto", points: [{ label: "Cinematica", value: 26 }, { label: "Termodinamica", value: null, note: "non ancora fatto" }] }],
      reference: { value: 18, label: "sufficienza, 18" },
    };
    db.prepare("UPDATE messages SET body = ? WHERE id = 'r'").run(`Ecco.\n\n\`\`\`pyxis-chart\n${JSON.stringify(chart)}\n\`\`\``);
    const file = exportChat(db, "chat", "it").markdown;
    expect(file).toContain("| Argomento | Voto |");
    expect(file).toContain("| Cinematica | 26/30 |");
    expect(file).toContain("| Termodinamica | non ancora fatto |");
    expect(file).toContain("Linea di riferimento: 18/30, sufficienza, 18");
    expect(file).not.toContain("pyxis-chart");
    expect(exportChat(db, "chat", "it", "drawn").markdown).toContain("```pyxis-chart");
  });
});
