import { z } from "zod";
import { conceptGraphSchema } from "./concept-map";
const id = z.string().min(1).max(160);
const index = z.number().int().nonnegative();
const text = z.string().max(1000000);
function safeJson(value: unknown): boolean {
  let nodes = 0;
  function visit(v: unknown, depth: number): boolean {
    if (++nodes > 100000 || depth > 24) return false;
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v === "string") return v.length <= 1000000;
    if (Array.isArray(v))
      return v.length <= 10000 && v.every((x) => visit(x, depth + 1));
    if (typeof v !== "object") return false;
    const entries = Object.entries(v);
    return (
      entries.length <= 200 &&
      entries.every(
        ([k, x]) =>
          !["__proto__", "prototype", "constructor"].includes(k) &&
          visit(x, depth + 1),
      )
    );
  }
  return visit(value, 0);
}
const json = z.unknown().refine(safeJson, "Invalid or oversized JSON");

const strings = z.array(text).max(1000);
const answer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mcq"), correct: index }),
  z.object({ kind: z.literal("tf"), correct: z.boolean() }),
  z.object({
    kind: z.literal("matching"),
    correct: z.array(z.tuple([text, text])).max(1000),
  }),
  z.object({
    kind: z.literal("completion"),
    accepted: z.array(strings).max(1000),
  }),
  z.object({
    kind: z.literal("open"),
    reference: text,
    rubric: strings.optional(),
  }),
]);
const question = z
  .object({
    id: id.optional(),
    stem: text,
    answer,
    topicId: id.optional(),
    sourceId: id.optional(),
    sourceIds: z.array(id).max(10000).optional(),
    explanation: text.optional(),
    options: strings.optional(),
    left: strings.optional(),
    right: strings.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.answer.kind === "mcq" &&
      (!value.options?.length || value.answer.correct >= value.options.length)
    )
      ctx.addIssue({
        code: "custom",
        path: ["answer", "correct"],
        message: "Invalid option index",
      });
  });
const proseBody = z.object({ markdown: text, cacheKey: text.optional() });
const questionsBody = z.object({ questions: z.array(question).max(10000) });
const simulationBody = questionsBody.extend({
  minutes: z.number().finite().positive().max(1440),
});
const portableItem = z
  .object({
    id,
    topic: index.nullable(),
    kind: z.enum(["lesson", "intro", "diagnostic", "quiz", "simulation"]),
    body: json,
    passageIds: z.array(id).max(10000),
    grounding: z.enum(["sources", "mixed", "general"]).nullable(),
    provider: z.string().max(100).nullable(),
    model: z.string().max(200).nullable(),
  })
  .superRefine((item, ctx) => {
    const schema =
      item.kind === "lesson" || item.kind === "intro"
        ? proseBody
        : item.kind === "simulation"
          ? simulationBody
          : questionsBody;
    const parsed = schema.safeParse(item.body);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({
          code: "custom",
          path: ["body", ...issue.path],
          message: issue.message,
        });
  });

export const planFileSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  id: id.optional(),
  createdAt: z.number().finite().optional(),
  title: z.string().max(500),
  topics: z
    .array(
      z.object({
        id: id.optional(),
        title: z.string().max(500),
        position: index,
        tree: json.optional(),
        passageIds: z.array(id).max(10000).optional(),
      }),
    )
    .max(1000),
  nodes: z
    .array(
      z.object({
        id: id.optional(),
        title: z.string().max(500),
        kind: z.enum([
          "intro",
          "diagnostic",
          "learn",
          "practice",
          "gaps",
          "cards",
          "quiz",
          "map",
          "simulation",
          "final",
        ]),
        position: index,
        topic: index.nullable(),
      }),
    )
    .max(10000),
  cards: z
    .array(
      z.object({
        id: id.optional(),
        front: text,
        back: text,
        passageId: id.nullable().optional(),
        suspended: z.boolean().optional(),
        grounding: z.enum(["sources", "mixed", "general"]).optional(),
        topic: index.nullable(),
        schedule: z
          .object({
            rating: z.string().max(100),
            state: json,
            at: z.number(),
          })
          .optional(),
      }),
    )
    .max(100000),
  passages: z
    .array(
      z.object({
        id,
        sourceId: id.nullable(),
        documentId: id.nullable(),
        version: index,
        text,
        locator: json,
        section: z.string().max(2000).nullable(),
        charStart: index.nullable(),
        charEnd: index.nullable(),
        textSha: z.string().regex(/^[a-f0-9]{64}$/),
        sourceSha: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      }),
    )
    .max(100000)
    .optional(),
  documents: z
    .array(z.object({ id, sourceId: id, version: index, tree: json }))
    .max(10000)
    .optional(),
  exercises: z
    .array(
      z.object({
        id,
        sourceId: id.nullable(),
        passageId: id.nullable(),
        prompt: text,
        answer: text.nullable(),
        locator: json,
        grounding: z.enum(["sources", "mixed", "general"]).nullable(),
      }),
    )
    .max(100000)
    .optional(),
  items: z.array(portableItem).max(10000).optional(),
  maps: z
    .array(
      z.object({
        id,
        topic: index.nullable(),
        entries: z
          .array(
            z.object({
              id,
              title: z.string().max(500),
              passageIds: z.array(id).max(10000),
              graph: conceptGraphSchema,
              provider: z.string().max(100).optional(),
              model: z.string().max(200).optional(),
              grounding: z.enum(["sources", "general"]).optional(),
            }),
          )
          .max(1000),
      }),
    )
    .max(1000)
    .optional(),
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
        topic: index.nullable(),
        payload: json,
        at: z.number(),
      }),
    )
    .max(100000)
    .optional(),
  sources: z
    .array(
      z.object({
        id: id.optional(),
        kind: z.string().max(50).optional(),
        title: z.string().max(500),
        sha: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(200 * 1024 * 1024),
        mime: z.string().nullable().optional(),
        data: z.string().max(280000000).optional(),
      }),
    )
    .max(10000)
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
