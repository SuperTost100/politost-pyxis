import { z } from "zod";
import {
  anchoredChecks,
  anchoredCheckSchema,
  fencedChecks,
  type AnchoredCheck,
} from "../../shared/math-check";
import { generate, type GenerateInput } from "../engine/generate";
import { runTurn } from "../engine/funnel";
import { systemPrompt } from "../engine/prompts";

/** Store metadata separately from the visible answer, using the existing message body envelope. */
export function splitChecks(text: string): {
  body: string;
  checks: AnchoredCheck[];
} {
  const match = text.match(/\n<checks>([\s\S]*?)<\/checks>\s*$/);
  if (!match) return { body: text, checks: fencedChecks(text) };
  const body = text.slice(0, match.index).trimEnd();
  try {
    return { body, checks: anchoredChecks(body, JSON.parse(match[1]!)) };
  } catch {
    return { body, checks: fencedChecks(body) };
  }
}

/** What a reply states that can be checked: an equation or an integral. Maths that only names things (a variable, a power) states nothing to check. */
const MATH = /=|∫|\\int\b/;

/**
 * Tools a separate check never runs on. Cursor Agent takes 11 to 40 s before its first text, longer than the 20 s a check
 * may take, so its checks were cancelled every time and spent tokens no row recorded.
 * shortcut: no separate check on Cursor Agent; lift it when its first text comes within the check's time.
 */
export const NO_SEPARATE_CHECK = new Set(["agent"]);

/** Raised, with no call made, when a check's attempt would run on a tool in `NO_SEPARATE_CHECK`. */
class CheckSkipped extends Error {}

/** True when `solverChecks` would ask a model: an answer with math and no check blocks of its own, not too long. */
export function needsSolverChecks(body: string): boolean {
  return !fencedChecks(body).length && body.length <= 24000 && MATH.test(body);
}

export async function solverChecks(
  body: string,
  input: Pick<GenerateInput, "selection" | "run" | "signal">,
): Promise<AnchoredCheck[]> {
  const existing = fencedChecks(body);
  if (existing.length || input.signal?.aborted || body.length > 24000)
    return existing;
  if (!MATH.test(body)) return [];
  const schema = z
    .object({ checks: z.array(anchoredCheckSchema).max(12) })
    .superRefine((value, ctx) => {
      value.checks.forEach((claim, index) => {
        if (!body.includes(claim.step))
          ctx.addIssue({
            code: "custom",
            message: "Step must be an exact excerpt of the answer",
            path: ["checks", index, "step"],
          });
      });
    });
  try {
    // The rule holds for the tool that runs each attempt, so a fallback to such a tool skips the check too.
    const run: typeof runTurn = async (call) => {
      if (NO_SEPARATE_CHECK.has(call.selection.provider)) throw new CheckSkipped("no separate check on this tool");
      return (input.run ?? runTurn)(call);
    };
    const result = await generate({
      ...input,
      run,
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
      schema,
      // Structured math output has no prose, so this template takes no language placeholder.
      system: systemPrompt("chat.checks"),
      prompt: JSON.stringify({ answer: body }),
    });
    return anchoredChecks(body, (result.data as z.infer<typeof schema>).checks);
  } catch {
    return [];
  } // Verification must never discard a completed tutor answer.
}
