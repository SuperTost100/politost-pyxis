import { z } from "zod";
import { indentWidth, inListItem } from "./markdown-tree";

export const checkClaimSchema = z.object({
  kind: z.enum(["equal", "derivative", "integral", "solve", "simplify"]),
  expr: z.string().trim().min(1).max(2000),
  claimed: z.string().trim().min(1).max(2000),
  vars: z
    .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,30}$/))
    .max(8)
    .optional(),
});
/** A student's answer, typed or a whole worked solution, and the reference it is graded against. */
export const gradeCheckSchema = z.object({
  answer: z.string().trim().min(1).max(8000),
  reference: z.string().trim().min(1).max(4000),
});
export const anchoredCheckSchema = checkClaimSchema.extend({
  step: z.string().trim().min(1).max(1000),
});
export type MathCheck = z.infer<typeof checkClaimSchema>;
export type AnchoredCheck = z.infer<typeof anchoredCheckSchema>;
export type GradeCheck = z.infer<typeof gradeCheckSchema>;

export function anchoredChecks(
  body: string,
  candidates: unknown,
): AnchoredCheck[] {
  const parsed = z.array(anchoredCheckSchema).max(12).safeParse(candidates);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  return parsed.data.filter((claim) => {
    const key = JSON.stringify(claim);
    if (!body.includes(claim.step) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A ```check or ```json block: its indentation, its language, its content and its closing fence, which is empty for a
 * block still open at the end of the text. The fences may be indented by spaces or a tab.
 */
const checkFences = () => /^([ \t]*)(`{3,})(check|json)[ \t]*\n([\s\S]*?)(\n[ \t]*\2`*[ \t]*$|$(?![\s\S]))/gm;

/** Whether a fence indented by `indent` at `at` is a fence: indented four columns outside a list item, it is code. */
const isFence = (body: string, indent: string, at: number) => indentWidth(indent) < 4 || inListItem(body, at);

export function fencedChecks(body: string): AnchoredCheck[] {
  const checks: AnchoredCheck[] = [];
  for (const match of body.matchAll(checkFences())) {
    if (checks.length === 12) break;
    if (!match[5] || !isFence(body, match[1]!, match.index)) continue;
    try {
      const raw: unknown = JSON.parse(match[4]!);
      const claim = checkClaimSchema.safeParse(raw);
      if (!claim.success) continue;
      const before = body.slice(0, match.index).trimEnd();
      const previous =
        before
          .split(/\n\s*\n/)
          .at(-1)
          ?.trim()
          .slice(-1000) ?? "";
      const step =
        raw &&
        typeof raw === "object" &&
        "step" in raw &&
        typeof raw.step === "string"
          ? raw.step.trim()
          : previous;
      if (step && before.includes(step)) checks.push({ ...claim.data, step });
    } catch {
      /* An incomplete stream fence is not a claim. */
    }
  }
  return anchoredChecks(body, checks);
}

/**
 * Hide check transport data while keeping ordinary JSON examples visible. A `check` block that a stopped reply left
 * open is hidden to the end of the text; an open `json` block stays, since it may be an ordinary example.
 */
export function stripCheckFences(body: string): string {
  return body.replace(checkFences(), (fence, indent: string, _ticks: string, language: string, content: string, close: string, at: number) => {
    if (!isFence(body, indent, at)) return fence;
    if (language === "check") return "";
    if (!close) return fence;
    try {
      return checkClaimSchema.safeParse(JSON.parse(content)).success ? "" : fence;
    } catch {
      return fence;
    }
  });
}
