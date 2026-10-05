import { z } from "zod";
import { cardReviewSchema } from "./card-schedule";
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
    generatedBy: z.object({ provider: z.string().max(200), model: z.string().max(200) }).optional(),
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
const proseBody = z.object({
  markdown: text,
  cacheKey: text.optional(),
  passageIds: z.array(id).max(10000).optional(),
});
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
    if (parsed.success && (item.kind === "lesson" || item.kind === "intro")) {
      const ordered = (parsed.data as z.infer<typeof proseBody>).passageIds;
      const cited = new Set(item.passageIds);
      if (
        ordered &&
        (new Set(ordered).size !== ordered.length ||
          ordered.length !== item.passageIds.length ||
          ordered.some((id) => !cited.has(id)))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["body", "passageIds"],
          message: "Citation order must contain exactly the item's passages",
        });
      }
    }
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
  /** Exporter's profile display name, written only when they have one. Never inferred. */
  author: z.string().min(1).max(200).optional(),
  title: z.string().max(500),
  topics: z
    .array(
      z.object({
        id: id.optional(),
        title: z.string().max(500),
        position: index,
        tree: json.optional(),
        passageIds: z.array(id).max(10000).optional(),
        /** Where the topic's content comes from. Files from before it existed omit it. */
        grounding: z.enum(["sources", "mixed", "general"]).nullable().optional(),
        /** A rebuild set this topic aside. It stays for history and is hidden from the active plan. */
        archived: z.boolean().optional(),
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
        schedule: cardReviewSchema.optional(),
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
  /** Education level the plan's tutor answers at. Older files omit it and take the importer's profile level. */
  educationLevel: z
    .enum([
      "primary",
      "lower-secondary",
      "upper-secondary",
      "technical",
      "vocational",
      "university",
      "other",
    ])
    .optional(),
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
  /**
   * Progress-only gap state, written with `progress` and never otherwise. Optional and additive, so version 2 stays valid:
   * a file without `gaps` is replayed from its answers, as before. Gap IDs are remapped on import and every reference
   * (`mergedInto`, `gapAnswers`, `gapItems`, gap events and an adopted question's `gapId`) must name a row in the file.
   */
  gaps: z
    .array(
      z.object({
        id,
        topic: index.nullable(),
        openedAt: index,
        closedAt: index.nullable(),
        origin: z.enum(["answers", "flag", "misconception"]),
        misconception: z.string().max(1000).nullable(),
        severity: z.enum(["severe", "minor"]).nullable(),
        /** "unchecked" while the gap could not be compared with its siblings. */
        comparison: z.literal("unchecked").nullable(),
        /** The gap that absorbed this one; set only on a closed gap. */
        mergedInto: id.nullable(),
      }),
    )
    .max(100000)
    .optional(),
  /**
   * Submitted attempts that progress events or gap answers name. Answers themselves are not carried. `item` is null
   * only when the attempt's quiz is not in the file (deleted); otherwise it is a quiz, diagnostic or simulation.
   */
  attempts: z
    .array(
      z.object({
        id,
        item: id.nullable(),
        startedAt: index,
        submittedAt: index,
      }),
    )
    .max(100000)
    .optional(),
  /** Wrong answers (attempt and question) that count for a gap. */
  gapAnswers: z
    .array(z.object({ gap: id, attempt: id, question: id }))
    .max(100000)
    .optional(),
  /** The drill quiz built for a gap. */
  gapItems: z
    .array(z.object({ gap: id, item: id }))
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
  if (raw.length > 4096) throw new Error("plan-url");
  const parsed = new URL(raw);
  if (parsed.username || parsed.password) throw new Error("plan-url");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("plan-url");
  }
  return parsed.toString();
}
