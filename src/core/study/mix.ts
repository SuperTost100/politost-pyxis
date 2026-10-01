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

type Row = { id: string; prompt: string; answer: string };

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

/** Build a mixed quiz from book exercises. No model call. */
export function mixQuestions(rows: Row[], limit = 20): MixedQuestion[] {
  const usable = rows.filter((row) => row.answer.trim());
  const random = mix(usable.length * 17 + limit);
  const questions: MixedQuestion[] = [];
  const kinds = ["mcq", "tf", "completion", "matching", "open"] as const;
  let cursor = 0;
  while (questions.length < limit && usable.length > 0) {
    if (cursor >= usable.length * kinds.length) break;
    const kind = kinds[cursor % kinds.length];
    const row = usable[cursor % usable.length];
    if (!row) break;
    cursor += 1;
    if (kind === "mcq") {
      const distractors = usable
        .filter((other) => other.id !== row.id && other.answer !== row.answer)
        .map((other) => other.answer);
      if (distractors.length < 3) continue;
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
      const other = usable.find((item) => item.answer !== row.answer);
      const truthful = questions.filter((item) => item.grade.kind === "tf").length % 2 === 0;
      const shown = truthful ? row.answer : (other?.answer ?? row.answer);
      questions.push({
        id: `${row.id}-tf-${questions.length}`,
        sourceId: row.id,
        stem: `${row.prompt} ${shown}`,
        explanation: row.answer,
        grade: { kind: "tf", picked: false, correct: truthful || shown === row.answer },
      });
      continue;
    }
    if (kind === "matching") {
      const group = usable.slice(cursor % usable.length, (cursor % usable.length) + 3);
      const pairs = group.length >= 3 ? group : usable.slice(0, 3);
      if (pairs.length < 3) continue;
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
    if (kind === "open") {
      questions.push({
        id: `${row.id}-open-${questions.length}`,
        sourceId: row.id,
        stem: row.prompt,
        explanation: row.answer,
        grade: { kind: "open", answer: "", reference: row.answer },
      });
      continue;
    }
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
