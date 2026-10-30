import { randomInt } from "node:crypto";
import type { Grade } from "./grade";

export type MixedQuestion = {
  id: string;
  sourceId: string;
  sourceIds?: string[];
  stem: string;
  explanation: string;
  options?: string[];
  left?: string[];
  right?: string[];
  grade: Grade;
};

/** One exercise. `topicId` and `kind` (book exercise, worked example, generated) decide which answers may stand beside it. */
type Row = { id: string; prompt: string; answer: string; topicId?: string; kind?: string | null };

/** The longest answer that can stand as an option, a statement to judge, a blank or a matching entry. */
const SHORT_ANSWER = 120;

/**
 * Whether an exercise's answer is a short final answer rather than a worked solution: one line, no display math, no
 * environment. A worked solution is never an option of another exercise, and its own exercise is asked open.
 */
export function shortAnswer(answer: string): boolean {
  const text = answer.trim();
  return (
    text.length > 0 &&
    text.length <= SHORT_ANSWER &&
    !text.includes("\n") &&
    !/\$\$|\\\[|\\begin\{/.test(text)
  );
}

const same = (text: string) => text.trim().toLowerCase();

/** Another exercise whose answer could pass for this one's: same topic, same kind, short, and a different answer. */
function alike(row: Row, other: Row): boolean {
  return (
    other.id !== row.id &&
    (other.topicId ?? null) === (row.topicId ?? null) &&
    (other.kind ?? null) === (row.kind ?? null) &&
    shortAnswer(other.answer) &&
    same(other.answer) !== same(row.answer)
  );
}

function mix(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swap] as T;
    copy[swap] = current as T;
  }
  return copy;
}

/**
 * Build a mixed quiz from book exercises. No model call. The seed decides the option order and the matching
 * column; each call draws a new one unless the caller passes its own, so the same exercises are not laid out the
 * same way every attempt. The questions are saved with the attempt, so one attempt keeps its order.
 *
 * A closed form needs plausible wrong answers: short answers of other exercises on the same topic and of the same
 * kind. An exercise whose answer is a worked solution, or that has too few such neighbours, is asked open instead,
 * once.
 */
export function mixQuestions(
  rows: Row[],
  limit = 20,
  seed = randomInt(1, 2 ** 31),
): MixedQuestion[] {
  const usable = rows.filter((row) => row.answer.trim());
  const random = mix(seed);
  const questions: MixedQuestion[] = [];
  const kinds = ["mcq", "tf", "completion", "matching", "open"] as const;
  // A blank becomes an open question in a Review, so an exercise is asked as free text (open or blank) once.
  const askedFree = new Set<string>();
  const open = (row: Row) => {
    if (askedFree.has(row.id)) return;
    askedFree.add(row.id);
    questions.push({
      id: `${row.id}-open-${questions.length}`,
      sourceId: row.id,
      stem: row.prompt,
      explanation: row.answer,
      grade: { kind: "open", answer: "", reference: row.answer },
    });
  };
  let cursor = 0;
  while (questions.length < limit && usable.length > 0) {
    if (cursor >= usable.length * kinds.length) break;
    const kind = kinds[cursor % kinds.length];
    const row = usable[cursor % usable.length];
    if (!row) break;
    cursor += 1;
    const neighbours = usable.filter((other) => alike(row, other));
    // Without a plausible wrong answer beside it, a true or false would always be true: such an exercise is asked open.
    if (kind === "open" || !shortAnswer(row.answer) || neighbours.length === 0) {
      open(row);
      continue;
    }
    if (kind === "mcq") {
      const distractors = [...new Map(neighbours.map((other) => [same(other.answer), other.answer])).values()];
      if (distractors.length < 3) {
        open(row);
        continue;
      }
      const options = shuffle([row.answer, ...distractors.slice(0, 3)], random);
      questions.push({
        id: `${row.id}-mcq-${questions.length}`,
        sourceId: row.id,
        stem: row.prompt,
        explanation: row.answer,
        options,
        grade: { kind: "mcq", picked: -1, correct: options.indexOf(row.answer) },
      });
      continue;
    }
    if (kind === "tf") {
      // Every other statement is false, with a plausible wrong answer.
      const truthful = questions.filter((item) => item.grade.kind === "tf").length % 2 === 0;
      const shown = truthful ? row.answer : neighbours[0]!.answer;
      questions.push({
        id: `${row.id}-tf-${questions.length}`,
        sourceId: row.id,
        stem: `${row.prompt} ${shown}`,
        explanation: row.answer,
        grade: { kind: "tf", picked: false, correct: truthful },
      });
      continue;
    }
    if (kind === "matching") {
      const pairs = [row, ...neighbours.filter((other, index, all) =>
        all.findIndex((item) => same(item.answer) === same(other.answer)) === index,
      )].slice(0, 3);
      if (pairs.length < 3) {
        open(row);
        continue;
      }
      const right = shuffle(
        pairs.map((item) => item.answer),
        random,
      );
      questions.push({
        id: `match-${questions.length}`,
        sourceId: pairs[0]?.id ?? "",
        sourceIds: pairs.map((item) => item.id),
        stem: pairs.map((item) => item.prompt).join("\n"),
        explanation: pairs.map((item) => item.answer).join(", "),
        left: pairs.map((item) => item.prompt),
        right,
        grade: {
          kind: "matching",
          pairs: [],
          correct: pairs.map((item) => [item.prompt, item.answer]),
        },
      });
      continue;
    }
    if (askedFree.has(row.id)) continue;
    askedFree.add(row.id);
    questions.push({
      id: `${row.id}-blank-${questions.length}`,
      sourceId: row.id,
      stem: row.prompt,
      explanation: row.answer,
      grade: { kind: "completion", answers: [], accepted: [[row.answer]] },
    });
  }
  return questions.slice(0, limit);
}
