import { z } from "zod";
import {
  anchoredChecks,
  anchoredCheckSchema,
  fencedChecks,
  type AnchoredCheck,
} from "../../shared/math-check";
import { generate, type GenerateInput } from "../engine/generate";
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

export async function solverChecks(
  body: string,
  input: Pick<GenerateInput, "selection" | "run" | "signal">,
): Promise<AnchoredCheck[]> {
  const existing = fencedChecks(body);
  if (existing.length || input.signal?.aborted || body.length > 24000)
    return existing;
  if (
    !/\$|\\[\[(]|\b(?:sin|cos|tan|exp|log)\s*\(|[A-Za-z]\s*\^|[=∫]/.test(body)
  )
    return [];
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
    const result = await generate({
      ...input,
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
