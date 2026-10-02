import { z } from "zod";
const id = z.string().min(1).max(160);
const label = z.string().trim().min(1).max(500);
export const mapColors = [
  "surface-raised",
  "primary-soft",
  "mastery-soft",
  "star-soft",
  "danger-soft",
] as const;
const node = z.object({
  id,
  label,
  parent: id.nullable(),
  x: z.number().finite(),
  y: z.number().finite(),
  pinned: z.boolean(),
  color: z
    .string()
    .regex(
      /^(?:surface-raised|primary-soft|mastery-soft|star-soft|danger-soft|#[a-fA-F0-9]{6})$/,
    )
    .optional(),
  sources: z.array(id).max(500).optional(),
});
const edge = z.object({
  from: id,
  to: id,
  label: z.string().max(160).optional(),
});
export const conceptGraphSchema = z.object({
  layout: z.enum(["tree", "radial"]),
  nodes: z.array(node).max(25),
  edges: z.array(edge).max(150),
  undo: z
    .object({
      nodes: z.array(node).max(25),
      edges: z.array(edge).max(150),
      layout: z.enum(["tree", "radial"]).optional(),
    })
    .nullable(),
});
export const mapOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), id, label, parent: id }),
  z.object({ op: z.literal("rename"), id, label }),
  z.object({ op: z.literal("delete"), id }),
  z.object({
    op: z.literal("connect"),
    from: id,
    to: id,
    label: z.string().max(160).optional(),
  }),
  z.object({ op: z.literal("disconnect"), from: id, to: id }),
  z.object({ op: z.literal("recolor"), id, color: z.enum(mapColors) }),
]);
export const mapSummarySchema = z.object({
  id,
  title: label,
  passageCount: z.number().int().nonnegative(),
  grounding: z.enum(["sources", "general"]).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
});
export type ConceptGraph = z.infer<typeof conceptGraphSchema>;
export type MapOp = z.infer<typeof mapOpSchema>;
export type MapSummary = z.infer<typeof mapSummarySchema>;
