import type Database from "better-sqlite3";
import type { Grade } from "../study/grade";
import { openLesson } from "../study/openLesson";

export function lessonMarkdown(title: string, body: string, sources: string[]): string {
  const unique = [...new Set(sources.map((source) => source.trim()).filter(Boolean))];
  const cites = unique.length === 0 ? "" : `\n\n## Sources\n\n${unique.map((source) => `- ${source}`).join("\n")}`;
  return `# ${title}\n\n${body}${cites}\n`;
}

export function cardsMarkdown(
  cards: Array<{ front: string; back: string; source?: string | null }>,
): string {
  if (cards.length === 0) return "";
  return (
    cards
      .map((card) => {
        const source = card.source?.trim() ? `\n\nSource: ${card.source.trim()}` : "";
        return `## ${card.front}\n\n${card.back}${source}`;
      })
      .join("\n\n") + "\n"
  );
}

export function quizMarkdown(
  questions: Array<{ stem: string; source?: string | null; answer?: string }>,
  withAnswers: boolean,
): string {
  if (questions.length === 0) return "";
  return (
    questions
      .map((question, index) => {
        const source = question.source?.trim() ? `\n\nSource: ${question.source.trim()}` : "";
        const answer = withAnswers && question.answer ? `\n\nAnswer: ${question.answer}` : "";
        return `## ${index + 1}. ${question.stem}${source}${answer}`;
      })
      .join("\n\n") + "\n"
  );
}

function fileName(title: string, ext = "md"): string {
  const safe = title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "export";
  return `${safe}.${ext}`;
}

function csvCell(value: string): string {
  if (value.startsWith("#") || /[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function htmlField(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "<br>")
    .replaceAll("[", "&#91;");
}

export function cardsCsv(
  cards: Array<{ front: string; back: string; source?: string | null }>,
): string {
  if (cards.length === 0) return "";
  const rows = cards.map((card) => {
    const back = card.source?.trim() ? `${card.back}\n\nSource: ${card.source.trim()}` : card.back;
    const note = /\{\{c\d+::/.test(card.front) ? "Cloze" : "Basic";
    return `${note},${csvCell(htmlField(card.front))},${csvCell(htmlField(back))}`;
  });
  return `#html:true\n#separator:comma\n#notetype column:1\n${rows.join("\n")}\n`;
}

function planCards(db: Database.Database, planId: string, topicId?: string) {
  return db
    .prepare(
      `SELECT c.front, c.back, p.section_path AS source
       FROM cards c
       LEFT JOIN passages p ON p.id = c.passage_id
       WHERE c.plan_id = ? AND c.removed = 0 AND (? IS NULL OR c.topic_id = ?)
       ORDER BY c.created_at`,
    )
    .all(planId, topicId ?? null, topicId ?? null) as Array<{
    front: string;
    back: string;
    source: string | null;
  }>;
}

function answerLine(answer: Grade | undefined, options?: string[]): string {
  if (!answer) return "";
  if (answer.kind === "mcq") return options?.[answer.correct] ?? "";
  if (answer.kind === "tf") return answer.correct ? "true" : "false";
  if (answer.kind === "matching") return answer.correct.map((pair) => pair.join(" = ")).join("; ");
  if (answer.kind === "open") return answer.reference;
  return answer.accepted[0]?.[0] ?? "";
}

function sectionPaths(db: Database.Database, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, section_path FROM passages WHERE id IN (${marks})`)
    .all(...ids) as Array<{ id: string; section_path: string | null }>;
  const byId = new Map(rows.map((row) => [row.id, row.section_path ?? ""]));
  return ids.map((id) => byId.get(id) ?? "");
}

export function exportMarkdown(
  db: Database.Database,
  input: {
    planId: string;
    kind: "lesson" | "cards" | "quiz" | "simulation";
    topicId?: string;
    answers?: boolean;
  },
): { filename: string; markdown: string } {
  const plan = db.prepare(`SELECT title FROM plans WHERE id = ?`).get(input.planId) as
    | { title: string }
    | undefined;
  if (!plan) throw new Error("plan-missing");
  const filename = fileName(plan.title);
  if (input.kind === "lesson") {
    if (!input.topicId) throw new Error("topic-missing");
    const topic = db
      .prepare(`SELECT title FROM topics WHERE id = ? AND plan_id = ?`)
      .get(input.topicId, input.planId) as { title: string } | undefined;
    if (!topic) throw new Error("topic-missing");
    const lesson = openLesson(db, input.planId, input.topicId);
    return {
      filename,
      markdown: lessonMarkdown(topic.title, lesson.markdown, sectionPaths(db, lesson.passageIds)),
    };
  }
  if (input.kind === "cards") {
    const cards = planCards(db, input.planId, input.topicId);
    return { filename, markdown: cardsMarkdown(cards) };
  }
  const item = db
    .prepare(
      `SELECT body_json FROM items
       WHERE plan_id = ? AND kind = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(input.planId, input.kind) as { body_json: string } | undefined;
  if (!item) throw new Error("quiz-missing");
  const stored = JSON.parse(item.body_json) as {
    questions?: Array<{
      id?: string;
      stem?: string;
      sourceId?: string;
      options?: string[];
      answer?: Grade;
    }>;
  };
  const questions = (stored.questions ?? []).map((question) => {
    const exerciseId = question.sourceId ?? question.id;
    const chapter = exerciseId
      ? (db
          .prepare(
            `SELECT json_extract(locator_json, '$.chapter') AS chapter FROM exercises WHERE id = ?`,
          )
          .get(exerciseId) as { chapter: string | number | null } | undefined)
      : undefined;
    return {
      stem: question.stem ?? "",
      source: chapter?.chapter == null ? "" : String(chapter.chapter),
      answer: answerLine(question.answer, question.options),
    };
  });
  return { filename, markdown: quizMarkdown(questions, input.answers === true) };
}

export function exportCardsCsv(
  db: Database.Database,
  input: { planId: string; topicId?: string },
): { filename: string; csv: string } {
  const plan = db.prepare(`SELECT title FROM plans WHERE id = ?`).get(input.planId) as
    | { title: string }
    | undefined;
  if (!plan) throw new Error("plan-missing");
  return {
    filename: fileName(plan.title, "csv"),
    csv: cardsCsv(planCards(db, input.planId, input.topicId)),
  };
}
