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
    }),
  ),
  examAt: z.number().nullable().optional(),
  target: z.number().optional(),
  language: z.enum(["it", "en"]).nullable().optional(),
  style: z.enum(["read", "practice", "decide"]).optional(),
});

export type PlanFile = z.infer<typeof planFileSchema>;

export function examInstant(days: number, now = new Date()): number {
  const date = new Date(now.getTime());
  date.setDate(date.getDate() + days);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
}

export function httpPlanUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("plan-url");
  }
  return parsed.toString();
}
