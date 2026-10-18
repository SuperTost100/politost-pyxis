import { z } from "zod";
import { runtimeRequest } from "../math/runtime-client";
import { gradeAnswer, type Grade } from "./grade";

/**
 * How long grading waits for the local SymPy check. The sandbox interrupts a check after 10 s; past this, or
 * without the downloaded runtime, grading goes on as it would without the check.
 */
const CHECK_MS = 12_000;

const reportSchema = z.object({
  final: z.object({
    state: z.enum(["verified", "failed", "none"]),
    reason: z.string().max(80).optional(),
    numbers: z.tuple([z.number(), z.number()]).optional(),
  }),
  steps: z.number().int().min(0).optional(),
  firstWrong: z
    .object({
      index: z.number().int().min(1),
      previous: z.string().max(600),
      step: z.string().max(600),
    })
    .optional(),
});

/** What SymPy found, as the grading prompt receives it. Absent fields are unknown, never "fine". */
export type MathCheck = {
  finalAnswer?: "equivalent" | "different";
  firstWrongStep?: { number: number; previous?: string; text: string };
};

// A reference with no digit, operator or LaTeX command is prose, so it is not sent to the sandbox at all.
const MATHLIKE = /[0-9=<>^*/+√π∞≤≥±]|\\[a-z]/;

/**
 * Checks a student's answer, typed or a whole worked solution, against the reference with SymPy in the Python
 * sandbox. Undefined when there is nothing to report: prose, no runtime, a timeout or an unreadable reply.
 */
export async function checkMath(
  answer: string,
  reference: string,
  signal?: AbortSignal,
): Promise<MathCheck | undefined> {
  if (
    !answer.trim() ||
    !reference.trim() ||
    answer.length > 8000 ||
    reference.length > 4000 ||
    !MATHLIKE.test(reference) ||
    signal?.aborted
  )
    return undefined;
  let raw: unknown;
  let onAbort: (() => void) | undefined;
  try {
    raw = await Promise.race([
      runtimeRequest("grade", { answer, reference }, CHECK_MS),
      new Promise((_, reject) => {
        onAbort = () => reject(new Error("aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch {
    return undefined; // Grading never depends on the check; the caller handles its own abort.
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
  const report = reportSchema.safeParse(raw);
  if (!report.success) return undefined;
  const { final, firstWrong } = report.data;
  const check: MathCheck = {};
  if (final.state === "verified") check.finalAnswer = "equivalent";
  else if (final.state === "failed")
    check.finalAnswer =
      final.numbers && numbersMatch(final.numbers[0], final.numbers[1])
        ? "equivalent"
        : "different";
  if (firstWrong)
    check.firstWrongStep = {
      number: firstWrong.index,
      ...(firstWrong.previous !== firstWrong.step
        ? { previous: firstWrong.previous }
        : {}),
      text: firstWrong.step,
    };
  return check.finalAnswer || check.firstWrongStep ? check : undefined;
}

/** Two plain values, judged by the same tolerance as typed numbers: whole numbers exactly, others within 1%. */
function numbersMatch(answer: number, reference: number): boolean {
  return (
    gradeAnswer({
      kind: "completion",
      answers: [String(answer)],
      accepted: [[String(reference)]],
    }) === 1
  );
}

/**
 * Credit for completion blanks that text and number matching missed but that are the same mathematics: "1/2" for
 * "0.5", "2x+2" for "2(x+1)", "x ≥ 2" for "[2, +∞)". Without the runtime the local score stands.
 */
export async function completionScore(
  grade: Grade,
  local: number,
  signal?: AbortSignal,
): Promise<number> {
  if (
    grade.kind !== "completion" ||
    local >= 1 ||
    grade.accepted.length === 0 ||
    grade.answers.length !== grade.accepted.length
  )
    return local;
  let hits = 0;
  for (const [index, answer] of grade.answers.entries()) {
    const options = grade.accepted[index] ?? [];
    if (
      gradeAnswer({
        kind: "completion",
        answers: [answer],
        accepted: [options],
      }) === 1
    ) {
      hits += 1;
      continue;
    }
    for (const option of options) {
      if (
        (await checkMath(answer, option, signal))?.finalAnswer === "equivalent"
      ) {
        hits += 1;
        break;
      }
    }
  }
  return Math.max(local, hits / grade.accepted.length);
}
