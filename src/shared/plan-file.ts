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
});

export type PlanFile = z.infer<typeof planFileSchema>;
