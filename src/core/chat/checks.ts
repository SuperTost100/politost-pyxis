import { z } from "zod";
import {
  anchoredChecks,
  anchoredCheckSchema,
  fencedChecks,
  type AnchoredCheck,
} from "../../shared/math-check";
import { generate, type GenerateInput } from "../engine/generate";
import { systemPrompt } from "../engine/prompts";
import { LOCAL_PROVIDER } from "../engine/local";
import { selectionFor, selectionOn, type StoredSelection } from "../engine/selection";
import type Database from "better-sqlite3";

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

/** What a reply states that can be checked: an equation or an integral. Maths that only names things (a variable, a power) states nothing to check. `\\int` ends at the first character that is not a letter, so `\\int_0^1` counts and `\\intercal` does not. */
const MATH = /=|∫|\\int(?![A-Za-z])/;

/**
 * The subscription tools, cheapest first for a call that stands alone. Every call on a tool carries the tool's own prompt
 * and tool list, and that overhead differs more than the check does: a check of two stated equations measured 2,191 input
 * tokens on Claude Code (1,516 of them from its cache), 17,340 on Codex and 12,565 on Antigravity, with a short system
 * prompt of 960 characters on each. Antigravity comes last although it measured below Codex, because it cannot skip being
 * saved: every check there would be a chat in the student's Gemini history.
 * shortcut: a ranking measured on three tools on one day (2026-11-20); measure again when a tool or model changes.
 */
const CHEAPEST_FIRST = ["claude", "codex", "antigravity"];

/**
 * The engine of a separate check. The check is a call of its own with a short answer, so an automatic chat sends it to the
 * cheapest ready subscription tool, not necessarily the chat's. A pin is a pin: a chat the student pinned to a tool keeps
 * its check there. A chat on a local model or an API key stays where it is too: its text never goes to another provider for
 * this, and an API call is paid by the token. A local model's check also carries no fallback, so a failure of the local
 * model ends the check and the text never reaches a cloud tool that way either.
 */
export function checkSelection(db: Database.Database): StoredSelection {
  const own = selectionFor(db, "chat");
  if (own.provider === LOCAL_PROVIDER) {
    const { chosenFor: _local, ...pinned } = own;
    return pinned;
  }
  if (!own.chosenFor || !CHEAPEST_FIRST.includes(own.provider)) return own;
  for (const provider of CHEAPEST_FIRST) {
    if (provider === own.provider) break;
    const there = selectionOn(provider, "chat");
    if (there) return { ...there, chosenFor: "chat" };
  }
  return own;
}

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
