export type Grade =
  | { kind: "mcq"; picked: number; correct: number }
  | { kind: "tf"; picked: boolean; correct: boolean }
  | { kind: "matching"; pairs: Array<[string, string]>; correct: Array<[string, string]> }
  | { kind: "completion"; answers: string[]; accepted: string[][] };

function fold(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("it")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function numbersClose(left: string, right: string): boolean {
  if (left.trim() === "" || right.trim() === "") return false;
  const a = Number(left.replace(",", "."));
  const b = Number(right.replace(",", "."));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= scale * 0.01;
}

export function gradeAnswer(input: Grade): number {
  if (input.kind === "mcq") return input.picked === input.correct ? 1 : 0;
  if (input.kind === "tf") return input.picked === input.correct ? 1 : 0;
  if (input.kind === "matching") {
    if (input.correct.length === 0) return 0;
    const wanted = new Set(input.correct.map(([a, b]) => `${fold(a)}=${fold(b)}`));
    const hits = input.pairs.filter(([a, b]) => wanted.has(`${fold(a)}=${fold(b)}`)).length;
    return hits / input.correct.length;
  }
  if (input.answers.length !== input.accepted.length) return 0;
  const hits = input.answers.filter((answer, index) => {
    const options = input.accepted[index] ?? [];
    return options.some((option) => fold(answer) === fold(option) || numbersClose(answer, option));
  }).length;
  return input.accepted.length === 0 ? 0 : hits / input.accepted.length;
}
