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
  redo: z
    .object({
      nodes: z.array(node).max(25),
      edges: z.array(edge).max(150),
      layout: z.enum(["tree", "radial"]).optional(),
    })
    .nullable()
    .optional(),
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
/** A map in the Maps section, with the exam, topic and subject it belongs to. */
/** The most branches, and concepts on a branch, that a map's tile draws. */
export const MAP_SHAPE = { branches: 6, leaves: 4 } as const;

export const mapEntrySchema = z.object({
  id,
  title: z.string(),
  planId: z.string(),
  planTitle: z.string(),
  topicId: z.string(),
  topicTitle: z.string(),
  subjectId: z.string().nullable(),
  subjectName: z.string().nullable(),
  nodeCount: z.number().int().nonnegative(),
  /** How many concepts hang off each branch of the root, for the tile's small drawing of the map. */
  shape: z.array(z.number().int().nonnegative().max(MAP_SHAPE.leaves)).max(MAP_SHAPE.branches),
  grounding: z.enum(["sources", "general"]),
});
export type MapEntry = z.infer<typeof mapEntrySchema>;
