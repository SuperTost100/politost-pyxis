import { z } from "zod";

export const planFileSchema = z.object({
  version: z.literal(1),
  title: z.string(),
  topics: z.array(z.object({ title: z.string(), position: z.number() })),
  nodes: z.array(
    z.object({
      title: z.string(),
      kind: z.string(),
      position: z.number(),
      topic: z.number().nullable(),
    }),
  ),
  cards: z.array(
    z.object({
      front: z.string(),
      back: z.string(),
      topic: z.number().nullable(),
      schedule: z
        .object({
          rating: z.string(),
          state: z.unknown(),
          at: z.number(),
        })
        .optional(),
    }),
  ),
  examAt: z.number().nullable().optional(),
  target: z.number().min(0.5).max(1).optional(),
  language: z.enum(["it", "en"]).nullable().optional(),
  style: z.enum(["read", "practice", "decide"]).optional(),
  progress: z
    .array(
      z.object({
        kind: z.enum([
          "answer_given",
          "card_rated",
          "lesson_opened",
          "lesson_completed",
          "simulation_submitted",
          "active_time",
          "gap_opened",
          "gap_closed",
        ]),
        topic: z.number().nullable(),
        payload: z.unknown(),
        at: z.number(),
      }),
    )
    .optional(),
  sources: z
    .array(
      z.object({
        title: z.string(),
        sha: z.string().nullable(),
        bytes: z.number().int().nonnegative(),
        mime: z.string().nullable().optional(),
        data: z.string().optional(),
      }),
    )
    .optional(),
});

export type PlanFile = z.infer<typeof planFileSchema>;

export function examInstant(days: number, now = new Date()): number {
  const date = new Date(now.getTime());
  date.setDate(date.getDate() + days);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
}

export function reachableTarget(target: number): number {
  // ponytail: a weighted average never returns to 1 after a miss. 100% means 0.99. Upgrade path is the mastery formula in the plan.
  return target >= 1 ? 0.99 : target;
}

export function httpPlanUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("plan-url");
  }
  return parsed.toString();
}
