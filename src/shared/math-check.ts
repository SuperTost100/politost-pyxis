import { z } from "zod";

export const checkClaimSchema = z.object({
  kind: z.enum(["equal", "derivative", "integral", "solve", "simplify"]),
  expr: z.string().trim().min(1).max(2000),
  claimed: z.string().trim().min(1).max(2000),
  vars: z
    .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,30}$/))
    .max(8)
    .optional(),
});
export const anchoredCheckSchema = checkClaimSchema.extend({
  step: z.string().trim().min(1).max(1000),
});
export type MathCheck = z.infer<typeof checkClaimSchema>;
export type AnchoredCheck = z.infer<typeof anchoredCheckSchema>;

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

export function fencedChecks(body: string): AnchoredCheck[] {
  const checks: AnchoredCheck[] = [];
  for (const match of body.matchAll(/```check\s*\n([\s\S]*?)\n```/g)) {
    if (checks.length === 12) break;
    try {
      const raw: unknown = JSON.parse(match[1]!);
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
