import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import {
  parseSmartText,
  splitCitationGroups,
  type CheckQuestion,
  type SmartSegment,
} from "../../shared/smart-text";
import {
  QUIZ_MAX_QUESTIONS,
  questionFlagged,
  startAttempt,
  type StoredQuestion,
} from "./attempt";
import { citeExplanation, type Citation } from "./citations";
import type { Grade } from "./grade";
import { flaggedIds } from "./flags";
import { markdownOf } from "./smartText";

/** Where a missed question was asked: a redo is a question asked again from the notebook. */
export type MistakeOrigin =
  "redo" | "quiz" | "diagnostic" | "review" | "simulation" | "check";

/** One question whose latest answer was wrong, as the notebook shows it. */
export type Mistake = {
  /** The question's identity across attempts: its source exercise, else its wording (see keyOf). */
  key: string;
  planId: string;
  topicId: string | null;
  origin: MistakeOrigin;
  at: number;
  stem: string;
  kind: Grade["kind"];
  options?: string[];
  left?: string[];
  right?: string[];
  /** The answer as saved: an option index, "true"/"false", JSON for blanks and pairs, or text. */
  pick: string;
  score: number;
  expected: string;
  explanation: string;
  citations: Citation[];
  /** The passage the question came from, or the book chapter when the exercise names no passage. */
  passageId: string | null;
  chapter: { sourceId: string; chapter: number } | null;
};

type Outcome = Omit<Mistake, "citations" | "passageId" | "chapter"> & {
  answered: boolean;
  flagged: boolean;
  sourceIds: string[];
  exerciseId?: string;
  /** The question as it is asked again. */
  question: StoredQuestion;
};

export type AttemptQuestion = {
  id: string;
  sourceId?: string;
  sourceIds?: string[];
  passageIds?: string[];
  topicId?: string;
  generatedBy?: { provider: string; model: string };
  stem: string;
  explanation?: string;
  options?: string[];
  left?: string[];
  right?: string[];
  answer: Grade;
};

const KINDS = "('quiz', 'diagnostic', 'review', 'simulation')";

/**
 * The key that joins answers to the same question. A book exercise is one question wherever it is asked. Any other
 * question is its wording: its form, its stem and its options in any order, so a quiz that asks the same question again,
 * a redo, and a quick check asked as a quiz question all meet under one key.
 */
function keyOf(question: {
  sourceId?: string;
  stem: string;
  kind: string;
  options?: string[];
  left?: string[];
}): string {
  if (question.sourceId) return question.sourceId;
  const words = (text: string) => text.replace(/\s+/g, " ").trim();
  return JSON.stringify([
    question.kind,
    words(question.stem),
    [...(question.options ?? question.left ?? [])].map(words).sort(),
  ]);
}

/**
 * The question asked again as a quiz question. A simulation answer is free text graded against a reference, so it comes
 * back as an open answer; any other question keeps its form. Only these fields travel, so a drill's gap link does not.
 */
export function redoQuestion(
  question: AttemptQuestion,
  topicId: string | null,
  simulation: boolean,
): StoredQuestion {
  const sourceIds = question.sourceIds ?? question.passageIds;
  return {
    id: question.id,
    ...(question.sourceId ? { sourceId: question.sourceId } : {}),
    ...(sourceIds?.length ? { sourceIds } : {}),
    ...(topicId ? { topicId } : {}),
    ...(question.generatedBy ? { generatedBy: question.generatedBy } : {}),
    stem: question.stem,
    ...(question.explanation ? { explanation: question.explanation } : {}),
    ...(question.options ? { options: question.options } : {}),
    ...(question.left ? { left: question.left } : {}),
    ...(question.right ? { right: question.right } : {}),
    answer:
      simulation && question.answer.kind === "completion"
        ? {
            kind: "open",
            answer: "",
            reference: question.answer.accepted[0]?.[0] ?? "",
          }
        : question.answer,
  };
}

function attemptOutcomes(
  db: Database.Database,
  planId: string,
  blocked: Set<string>,
): Outcome[] {
  const rows = db
    .prepare(
      `SELECT a.submitted_at AS at, i.id AS item_id, i.kind, i.topic_id, i.body_json, aa.payload_json
       FROM attempts a JOIN items i ON i.id = a.item_id JOIN attempt_answers aa ON aa.attempt_id = a.id
       WHERE a.plan_id = ? AND a.submitted_at IS NOT NULL AND i.kind IN ${KINDS}
         AND json_type(aa.payload_json, '$.results') = 'array'
       ORDER BY a.submitted_at, a.id, aa.created_at, aa.id`,
    )
    .all(planId) as Array<{
    at: number;
    item_id: string;
    kind: "quiz" | "diagnostic" | "review" | "simulation";
    topic_id: string | null;
    body_json: string;
    payload_json: string;
  }>;
  const bodies = new Map<
    string,
    { redo?: boolean; questions?: AttemptQuestion[] }
  >();
  const outcomes: Outcome[] = [];
  for (const row of rows) {
    let body = bodies.get(row.item_id);
    if (!body) {
      body = JSON.parse(row.body_json) as {
        redo?: boolean;
        questions?: AttemptQuestion[];
      };
      bodies.set(row.item_id, body);
    }
    const questions = body.questions ?? [];
    const { picks = {}, results = [] } = JSON.parse(row.payload_json) as {
      picks?: Record<string, unknown>;
      results?: Array<{
        id: string;
        score: number;
        expected?: string;
        explanation?: string;
      }>;
    };
    const simulation = row.kind === "simulation";
    for (const result of results) {
      const question = questions.find((item) => item.id === result.id);
      if (!question?.stem || !question.answer) continue;
      const raw = picks[result.id];
      const pick =
        typeof raw === "string"
          ? raw
          : raw == null
            ? ""
            : typeof raw === "number" || typeof raw === "boolean"
              ? String(raw)
              : JSON.stringify(raw);
      const topicId = question.topicId ?? row.topic_id;
      const asked = redoQuestion(question, topicId, simulation);
      outcomes.push({
        key: keyOf({ ...question, kind: asked.answer.kind }),
        planId,
        topicId,
        origin: body.redo ? "redo" : row.kind,
        at: row.at,
        stem: question.stem,
        kind: asked.answer.kind,
        options: question.options,
        left: question.left,
        right: question.right,
        pick,
        score: result.score,
        expected: result.expected ?? "",
        explanation: result.explanation ?? question.explanation ?? "",
        // Blanks and pairs are saved as JSON, so an empty sheet is brackets and quotes only.
        answered: /[^\s[\]",]/.test(pick),
        flagged: questionFlagged(blocked, question),
        sourceIds: asked.sourceIds ?? [],
        exerciseId: question.sourceId,
        question: asked,
      });
    }
  }
  return outcomes;
}

/** The passage cited last before the question in the lesson's text: the part the question checks. */
function passageBefore(
  segments: SmartSegment[],
  blockId: string,
  passageIds: string[],
): string | undefined {
  let last: string | undefined;
  for (const segment of segments) {
    if (segment.type === "markdown")
      for (const match of splitCitationGroups(segment.text).matchAll(
        /\[P(\d+)\]/g,
      ))
        last = passageIds[Number(match[1]) - 1] ?? last;
    if (segment.type !== "block") continue;
    const { block } = segment;
    if (
      block.id === blockId ||
      (block.kind === "recap" &&
        block.questions.some((question) => question.id === blockId))
    )
      return last ?? passageIds[0];
  }
  return passageIds[0];
}

function checkOutcomes(
  db: Database.Database,
  planId: string,
  blocked: Set<string>,
): Outcome[] {
  const rows = db
    .prepare(
      `SELECT e.created_at AS at, e.topic_id, e.payload_json, i.id AS item_id, i.kind, i.topic_id AS item_topic, i.body_json
       FROM learning_events e JOIN items i ON i.id = e.item_id
       WHERE e.plan_id = ? AND e.kind = 'answer_given' AND i.kind IN ('lesson', 'intro')
         AND json_extract(e.payload_json, '$.evidenceKind') = 'check'
       ORDER BY e.created_at, e.id`,
    )
    .all(planId) as Array<{
    at: number;
    topic_id: string | null;
    payload_json: string;
    item_id: string;
    kind: "lesson" | "intro";
    item_topic: string | null;
    body_json: string;
  }>;
  const lessons = new Map<
    string,
    { segments: SmartSegment[]; passageIds: string[] }
  >();
  const cited = db.prepare(
    `SELECT ip.passage_id FROM item_passages ip JOIN passages p ON p.id = ip.passage_id
     WHERE ip.item_id = ? ORDER BY p.created_at, p.id`,
  );
  const outcomes: Outcome[] = [];
  for (const row of rows) {
    let lesson = lessons.get(row.item_id);
    if (!lesson) {
      const body = JSON.parse(row.body_json) as { passageIds?: string[] };
      lesson = {
        segments: parseSmartText(markdownOf(row.body_json, row.kind)),
        // Citation numbers follow the lesson's own passage list, as on the lesson page.
        passageIds:
          body.passageIds ??
          (cited.all(row.item_id) as Array<{ passage_id: string }>).map(
            (passage) => passage.passage_id,
          ),
      };
      lessons.set(row.item_id, lesson);
    }
    const payload = JSON.parse(row.payload_json) as {
      blockId?: string;
      pick?: number;
      shown?: boolean;
      score?: number;
    };
    if (!payload.blockId || typeof payload.pick !== "number") continue;
    // A question that a rewrite removed has nothing left to show or ask.
    let question: CheckQuestion | undefined;
    for (const segment of lesson.segments) {
      if (segment.type !== "block") continue;
      const { block } = segment;
      if (block.kind === "check" && block.id === payload.blockId)
        question = block;
      if (block.kind === "recap")
        question ??= block.questions.find(
          (item) => item.id === payload.blockId,
        );
    }
    if (!question) continue;
    // An answer saved before options were rearranged holds the model's own index (see smartAnswers).
    const moved = payload.shown
      ? payload.pick
      : question.order.indexOf(payload.pick);
    const pick = moved >= 0 ? moved : payload.pick;
    const topicId = row.topic_id ?? row.item_topic;
    const passageId = passageBefore(
      lesson.segments,
      payload.blockId,
      lesson.passageIds,
    );
    const asked: StoredQuestion = {
      id: payload.blockId,
      ...(passageId ? { sourceIds: [passageId] } : {}),
      ...(topicId ? { topicId } : {}),
      stem: question.question,
      ...(question.explanation ? { explanation: question.explanation } : {}),
      options: question.options,
      answer: { kind: "mcq", picked: -1, correct: question.answer },
    };
    outcomes.push({
      key: keyOf({
        stem: question.question,
        kind: "mcq",
        options: question.options,
      }),
      planId,
      topicId,
      origin: "check",
      at: row.at,
      stem: question.question,
      kind: "mcq",
      options: question.options,
      pick: String(pick),
      score:
        typeof payload.score === "number"
          ? payload.score
          : pick === question.answer
            ? 1
            : 0,
      expected: question.options[question.answer] ?? "",
      explanation: question.explanation ?? "",
      answered: true,
      flagged: blocked.has(payload.blockId),
      sourceIds: passageId ? [passageId] : [],
      question: asked,
    });
  }
  return outcomes;
}

/**
 * The plan's questions whose latest answer was wrong (score under 1), newest first. Every submitted quiz, gap drill,
 * review, diagnostic, simulation and redo counts, and so does every lesson or introduction quick check. A later right
 * answer takes a question out and a later miss brings it back; an unanswered question changes nothing. A question the
 * student marked wrong stays out, and so does one on a topic a rebuild archived.
 */
function planOutcomes(db: Database.Database, planId: string): Outcome[] {
  const blocked = flaggedIds(db, "exercise");
  const latest = new Map<string, Outcome>();
  const all = [
    ...attemptOutcomes(db, planId, blocked),
    ...checkOutcomes(db, planId, blocked),
  ].sort((a, b) => a.at - b.at);
  // A question marked wrong in any of its copies stays out.
  const flagged = new Set<string>();
  for (const outcome of all) {
    if (outcome.flagged) flagged.add(outcome.key);
    if (outcome.answered) latest.set(outcome.key, outcome);
  }
  const topics = new Map(
    (
      db
        .prepare("SELECT id, archived_at FROM topics WHERE plan_id = ?")
        .all(planId) as Array<{ id: string; archived_at: number | null }>
    ).map((row) => [row.id, row.archived_at == null]),
  );
  return [...latest.values()]
    .filter(
      (outcome) =>
        outcome.score < 1 &&
        !flagged.has(outcome.key) &&
        (outcome.topicId == null || topics.get(outcome.topicId) === true),
    )
    .sort((a, b) => b.at - a.at);
}

/** Where to read about the question: its first passage that still exists, else the book chapter of its exercise. */
function sourcePlace(db: Database.Database, outcome: Outcome) {
  const exists = db.prepare("SELECT 1 FROM passages WHERE id = ?");
  const passageId = outcome.sourceIds.find((id) => exists.get(id));
  if (passageId) return { passageId, chapter: null };
  if (!outcome.exerciseId) return { passageId: null, chapter: null };
  const exercise = db
    .prepare(
      `SELECT e.passage_id, sb.source_id, json_extract(e.locator_json, '$.chapter') AS chapter
       FROM exercises e LEFT JOIN smartbooks sb ON sb.id = e.smartbook_id WHERE e.id = ?`,
    )
    .get(outcome.exerciseId) as
    | {
        passage_id: string | null;
        source_id: string | null;
        chapter: number | null;
      }
    | undefined;
  if (exercise?.passage_id)
    return { passageId: exercise.passage_id, chapter: null };
  return {
    passageId: null,
    chapter:
      exercise?.source_id && typeof exercise.chapter === "number"
        ? { sourceId: exercise.source_id, chapter: exercise.chapter }
        : null,
  };
}

/** The notebook of one plan, or of every plan in the order the Flashcards tab uses: subject, exam, topic, newest first. */
export function mistakesNotebook(
  db: Database.Database,
  input: { planId?: string },
) {
  const plans = db
    .prepare(
      `SELECT p.id, p.title, s.name AS subject FROM plans p LEFT JOIN subjects s ON s.id = p.subject_id
       WHERE ? IS NULL OR p.id = ?
       ORDER BY s.id IS NULL, s.position, s.name COLLATE NOCASE, s.id, p.title COLLATE NOCASE, p.id`,
    )
    .all(input.planId ?? null, input.planId ?? null) as Array<{
    id: string;
    title: string;
    subject: string | null;
  }>;
  const topicRows = db.prepare(
    "SELECT id, title, position FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position, id",
  );
  const entries = [];
  const listed = [];
  for (const plan of plans) {
    const topics = topicRows.all(plan.id) as Array<{
      id: string;
      title: string;
      position: number;
    }>;
    const order = new Map(topics.map((topic, index) => [topic.id, index]));
    const found = planOutcomes(db, plan.id).sort(
      (a, b) =>
        (a.topicId == null ? topics.length : order.get(a.topicId)!) -
          (b.topicId == null ? topics.length : order.get(b.topicId)!) ||
        b.at - a.at,
    );
    listed.push({ ...plan, count: found.length });
    for (const outcome of found) {
      const {
        answered: _answered,
        flagged: _flagged,
        sourceIds,
        exerciseId: _exerciseId,
        question: _question,
        ...entry
      } = outcome;
      const cited = citeExplanation(db, entry.explanation, sourceIds);
      entries.push({
        ...entry,
        explanation: cited.explanation,
        citations: cited.citations,
        ...sourcePlace(db, outcome),
        planTitle: plan.title,
        subject: plan.subject,
        topicTitle:
          topics.find((topic) => topic.id === entry.topicId)?.title ?? null,
      });
    }
  }
  return { plans: listed, entries };
}

/**
 * Asks the chosen notebook questions again as one quiz on the whole plan, at most ten. It has no topic, so it adds no
 * path step; each answer counts toward its own topic's mastery as a quiz answer when the quiz is handed in, and the
 * question keeps its id, so a right answer takes it out of the notebook.
 */
export function startRedo(
  db: Database.Database,
  input: { planId: string; keys: string[] },
  now = Date.now(),
) {
  const outcomes = new Map(
    planOutcomes(db, input.planId).map((outcome) => [outcome.key, outcome]),
  );
  const questions = [...new Set(input.keys)]
    .flatMap((key) => {
      const outcome = outcomes.get(key);
      return outcome ? [outcome.question] : [];
    })
    .slice(0, QUIZ_MAX_QUESTIONS);
  if (!questions.length) throw new Error("question-missing");
  const itemId = uuidv7(now);
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO items (id, plan_id, kind, body_json, grounding, created_at)
       VALUES (?, ?, 'quiz', ?, 'sources', ?)`,
    ).run(
      itemId,
      input.planId,
      JSON.stringify({ redo: true, complete: true, questions }),
      now,
    );
    return { attemptId: startAttempt(db, input.planId, itemId, now).attemptId };
  })();
}
