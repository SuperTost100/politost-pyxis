export type Grade =
  | { kind: "mcq"; picked: number; correct: number }
  | { kind: "tf"; picked: boolean; correct: boolean }
  | {
      kind: "matching";
      pairs: Array<[string, string]>;
      correct: Array<[string, string]>;
    }
  | { kind: "completion"; answers: string[]; accepted: string[][] }
  | { kind: "open"; answer: string; reference: string; rubric?: string[] };

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
  // Whole numbers such as years, counts or codes must match exactly; 1% would let 1860 pass for 1848.
  const whole = /^\s*[-+]?\d+\s*$/;
  if (whole.test(left) && whole.test(right)) return a === b;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= scale * 0.01;
}

export function gradeAnswer(input: Grade): number {
  if (input.kind === "mcq") return input.picked === input.correct ? 1 : 0;
  if (input.kind === "tf") return input.picked === input.correct ? 1 : 0;
  if (input.kind === "matching") {
    if (input.correct.length === 0) return 0;
    const wanted = new Map<string, number>();
    for (const [left, right] of input.correct) {
      const key = JSON.stringify([fold(left), fold(right)]);
      wanted.set(key, (wanted.get(key) ?? 0) + 1);
    }
    const used = new Map<string, number>();
    let hits = 0;
    for (const pair of input.pairs) {
      if (
        !Array.isArray(pair) ||
        typeof pair[0] !== "string" ||
        typeof pair[1] !== "string"
      )
        continue;
      const key = JSON.stringify([fold(pair[0]), fold(pair[1])]);
      const need = wanted.get(key) ?? 0;
      const have = used.get(key) ?? 0;
      if (have >= need) continue;
      used.set(key, have + 1);
      hits += 1;
    }
    return hits / input.correct.length;
  }
  if (input.kind === "open") {
    return fold(input.answer) === fold(input.reference) ||
      numbersClose(input.answer, input.reference)
      ? 1
      : 0;
  }
  if (input.answers.length !== input.accepted.length) return 0;
  const hits = input.answers.filter((answer, index) => {
    const options = input.accepted[index] ?? [];
    return options.some(
      (option) => fold(answer) === fold(option) || numbersClose(answer, option),
    );
  }).length;
  return input.accepted.length === 0 ? 0 : hits / input.accepted.length;
}
