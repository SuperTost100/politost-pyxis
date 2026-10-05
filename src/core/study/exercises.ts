import type Database from "better-sqlite3";
import type { MathCheck } from "../../shared/math-check";

export type ExerciseStep = {
  text: string;
  latex?: string;
  check?: MathCheck & { step?: string };
};

type ExerciseRow = {
  id: string;
  prompt: string;
  answer: string | null;
  kind: string | null;
  passageId: string | null;
  /** Only model-generated exercises carry these. */
  generated?: boolean;
  steps?: ExerciseStep[];
  hints?: string[];
};

function generatedExercises(
  db: Database.Database,
  topicId: string,
): ExerciseRow[] {
  const rows = db
    .prepare(
      `SELECT id, prompt, answer, passage_id, locator_json FROM exercises
       WHERE smartbook_id IS NULL
         AND json_extract(locator_json, '$.kind') = 'generated'
         AND json_extract(locator_json, '$.topicId') = ?
       ORDER BY created_at, id`,
    )
    .all(topicId) as Array<{
    id: string;
    prompt: string;
    answer: string | null;
    passage_id: string | null;
    locator_json: string;
  }>;
  return rows.map((row) => {
    const locator = JSON.parse(row.locator_json) as {
      steps?: ExerciseStep[];
      hints?: string[];
    };
    return {
      id: row.id,
      prompt: row.prompt,
      answer: row.answer,
      kind: "generated",
      passageId: row.passage_id,
      generated: true,
      steps: locator.steps ?? [],
      hints: locator.hints ?? [],
    };
  });
}

function bookExercises(db: Database.Database, topicId: string): ExerciseRow[] {
  const chapters = db
    .prepare(
      `SELECT DISTINCT json_extract(p.locator_json, '$.chapter') AS chapter
       FROM topic_passages tp
       JOIN passages p ON p.id = tp.passage_id
       WHERE tp.topic_id = ? AND json_extract(p.locator_json, '$.chapter') IS NOT NULL`,
    )
    .all(topicId) as Array<{ chapter: number }>;
  if (chapters.length === 0) return [];
  const marks = chapters.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT e.id, e.prompt, e.answer, json_extract(e.locator_json, '$.kind') AS kind,
        COALESCE(e.passage_id, (
          SELECT p.id FROM passages p
          JOIN topic_passages tp ON tp.passage_id = p.id
          WHERE tp.topic_id = t.id
            AND p.source_id = sb.source_id
            AND json_extract(p.locator_json, '$.chapter') = json_extract(e.locator_json, '$.chapter')
          ORDER BY p.created_at
          LIMIT 1
        )) AS passage_id
       FROM exercises e
       JOIN smartbooks sb ON sb.id = e.smartbook_id
       JOIN plan_sources ps ON ps.source_id = sb.source_id
       JOIN topics t ON t.plan_id = ps.plan_id
       WHERE t.id = ?
         AND sb.source_id IN (
           SELECT p.source_id FROM passages p
           JOIN topic_passages src ON src.passage_id = p.id
           WHERE src.topic_id = t.id
         )
         AND json_extract(e.locator_json, '$.chapter') IN (${marks})
       ORDER BY e.created_at`,
    )
    .all(topicId, ...chapters.map((row) => row.chapter)) as Array<{
    id: string;
    prompt: string;
    answer: string | null;
    kind: string | null;
    passage_id: string | null;
  }>;
  // Plan import stamps planId on book exercises whose source was skipped; their quoted passages stay with no source.
  const detached = db
    .prepare(
      `SELECT e.id, e.prompt, e.answer, json_extract(e.locator_json, '$.kind') AS kind,
        COALESCE(e.passage_id, (
          SELECT p.id FROM passages p
          JOIN topic_passages tp ON tp.passage_id = p.id
          WHERE tp.topic_id = t.id
            AND p.source_id IS NULL
            AND json_extract(p.locator_json, '$.chapter') = json_extract(e.locator_json, '$.chapter')
          ORDER BY p.created_at
          LIMIT 1
        )) AS passage_id
       FROM exercises e
       JOIN topics t ON t.id = ?
       WHERE e.smartbook_id IS NULL
         AND json_extract(e.locator_json, '$.planId') = t.plan_id
         AND json_extract(e.locator_json, '$.chapter') IN (
           SELECT json_extract(p.locator_json, '$.chapter') FROM passages p
           JOIN topic_passages tp ON tp.passage_id = p.id
           WHERE tp.topic_id = t.id AND p.source_id IS NULL
         )
       ORDER BY e.created_at, e.rowid`,
    )
    .all(topicId) as typeof rows;
  return [...rows, ...detached].map((row) => ({
    id: row.id,
    prompt: row.prompt,
    answer: row.answer,
    kind: row.kind,
    passageId: row.passage_id,
  }));
}

/** Smartbook originals first, then exercises the model generated from the topic's sources. */
export function topicExercises(
  db: Database.Database,
  topicId: string,
): ExerciseRow[] {
  return [...bookExercises(db, topicId), ...generatedExercises(db, topicId)];
}

const MAX_STEPS = 12;

/** Splits a written solution at blank lines, never inside a code fence or a $$ block. */
export function solutionSteps(answer: string | null): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let fence = false;
  let math = false;
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) parts.push(text);
    current = [];
  };
  for (const line of (answer ?? "").split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    else if (!fence && ((line.match(/\$\$/g) ?? []).length & 1) === 1)
      math = !math;
    if (!fence && !math && !line.trim()) flush();
    else current.push(line);
  }
  flush();
  return parts.length > MAX_STEPS
    ? [
        ...parts.slice(0, MAX_STEPS - 1),
        parts.slice(MAX_STEPS - 1).join("\n\n"),
      ]
    : parts;
}

/** Renderer-facing shape: stepwise solution, hints and anchored math checks. */
export function exerciseView(row: ExerciseRow) {
  const generated = row.generated === true;
  const steps: ExerciseStep[] = generated
    ? (row.steps ?? []).map((step) => {
        const text = step.latex
          ? `${step.text}\n\n$$\n${step.latex}\n$$`
          : step.text;
        return {
          text,
          ...(step.check ? { check: { ...step.check, step: step.text } } : {}),
        };
      })
    : solutionSteps(row.answer).map((text) => ({ text }));
  return {
    id: row.id,
    prompt: row.prompt,
    answer: generated ? row.answer : null,
    generated,
    steps,
    hints: row.hints ?? [],
  };
}
